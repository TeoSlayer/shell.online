package e2ee

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

const (
	KeyBytes                     = 32
	NonceBytes                   = 12
	SaltBytes                    = 16
	BrowserPasswordBytes         = 10
	BrowserPasswordLength        = 10
	EnvelopeVersion         byte = 2
	EnvelopeOverheadBytes        = 46
	PBKDF2Iterations             = 600_000
	MaxBrowserPasswordBytes      = 1_024
)

func GenerateBrowserPassword() (string, error) {
	value := make([]byte, BrowserPasswordBytes)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	/* Each character is one independent six-bit symbol. This keeps the human
	 * password at exactly ten URL-safe characters while carrying 60 random
	 * bits; ordinary base64 encoding cannot produce exactly ten characters. */
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	password := make([]byte, BrowserPasswordLength)
	for index := range password {
		password[index] = alphabet[value[index]&63]
	}
	return string(password), nil
}

func ValidateBrowserPassword(password string) error {
	if password == "" {
		return fmt.Errorf("browser password must not be empty")
	}
	if len(password) > MaxBrowserPasswordBytes {
		return fmt.Errorf("browser password must not exceed %d bytes", MaxBrowserPasswordBytes)
	}
	if !utf8.ValidString(password) || strings.IndexFunc(password, unicode.IsControl) >= 0 {
		return fmt.Errorf("browser password must be valid text without control characters")
	}
	return nil
}

const (
	directionHostToViewer byte = 1
	directionViewerToHost byte = 2
	streamBytes                = 8
	sequenceBytes              = 8
	envelopeMetadataBytes      = 1 + 1 + streamBytes + sequenceBytes + NonceBytes
)

type replayWindow struct {
	max    uint64
	bitmap uint64
}

type Cipher struct {
	aead cipher.AEAD
	key  []byte

	sealMu       sync.Mutex
	sendStream   [streamBytes]byte
	sendSequence uint64

	replayMu sync.Mutex
	replay   map[[streamBytes]byte]replayWindow
}

// Key returns a copy for explicitly authorized MCP issuance. It is never persisted.
func (c *Cipher) Key() []byte {
	if c == nil {
		return nil
	}
	return append([]byte(nil), c.key...)
}

func New(key []byte) (*Cipher, error) {
	if len(key) != KeyBytes {
		return nil, fmt.Errorf("E2EE key must be %d bytes", KeyBytes)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	result := &Cipher{aead: aead, key: append([]byte(nil), key...), replay: make(map[[streamBytes]byte]replayWindow)}
	if _, err := rand.Read(result.sendStream[:]); err != nil {
		return nil, err
	}
	return result, nil
}

func Generate(password string) (*Cipher, string, error) {
	result, fragment, _, err := GenerateMaterial(password)
	return result, fragment, err
}

func GenerateMaterial(password string) (*Cipher, string, []byte, error) {
	if password == "" {
		key := make([]byte, KeyBytes)
		if _, err := rand.Read(key); err != nil {
			return nil, "", nil, err
		}
		value := base64.RawURLEncoding.EncodeToString(key)
		result, err := New(key)
		return result, "#key=" + value, key, err
	}
	salt := make([]byte, SaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return nil, "", nil, err
	}
	key, err := DerivePasswordKey(password, salt)
	if err != nil {
		return nil, "", nil, err
	}
	result, err := New(key)
	return result, "#salt=" + base64.RawURLEncoding.EncodeToString(salt), key, err
}

func DerivePasswordKey(password string, salt []byte) ([]byte, error) {
	if len(salt) != SaltBytes {
		return nil, fmt.Errorf("E2EE salt must be %d bytes", SaltBytes)
	}
	return pbkdf2.Key(sha256.New, password, salt, PBKDF2Iterations, KeyBytes)
}

func (c *Cipher) SealFrame(frame []byte) ([]byte, error) {
	if len(frame) == 0 {
		return nil, fmt.Errorf("empty E2EE frame")
	}
	c.sealMu.Lock()
	defer c.sealMu.Unlock()
	if c.sendSequence == ^uint64(0) {
		return nil, fmt.Errorf("E2EE frame sequence exhausted")
	}
	c.sendSequence++
	nonce := make([]byte, NonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return c.sealFrameWithNonceAndSequence(frame, nonce, c.sendSequence)
}

func (c *Cipher) sealFrameWithNonce(frame, nonce []byte) ([]byte, error) {
	c.sealMu.Lock()
	defer c.sealMu.Unlock()
	if c.sendSequence == ^uint64(0) {
		return nil, fmt.Errorf("E2EE frame sequence exhausted")
	}
	c.sendSequence++
	return c.sealFrameWithNonceAndSequence(frame, nonce, c.sendSequence)
}

func (c *Cipher) sealFrameWithNonceAndSequence(frame, nonce []byte, sequence uint64) ([]byte, error) {
	if len(frame) == 0 {
		return nil, fmt.Errorf("empty E2EE frame")
	}
	if len(nonce) != NonceBytes {
		return nil, fmt.Errorf("invalid E2EE nonce")
	}
	headerBytes := 1
	// Targeted host snapshots and file responses keep the viewer id visible to
	// the relay. File requests gain the same prefix at the relay before the CLI
	// opens them, so OpenFrame mirrors this rule below.
	if (frame[0] == 0x03 || frame[0] == 0x0b) && len(frame) >= 5 {
		headerBytes = 5
	}
	direction, err := frameDirection(frame[0])
	if err != nil {
		return nil, err
	}
	result := make([]byte, headerBytes+envelopeMetadataBytes, headerBytes+envelopeMetadataBytes+len(frame)-headerBytes+c.aead.Overhead())
	copy(result, frame[:headerBytes])
	result[headerBytes] = EnvelopeVersion
	result[headerBytes+1] = direction
	copy(result[headerBytes+2:headerBytes+2+streamBytes], c.sendStream[:])
	binary.BigEndian.PutUint64(result[headerBytes+2+streamBytes:headerBytes+2+streamBytes+sequenceBytes], sequence)
	copy(result[headerBytes+2+streamBytes+sequenceBytes:], nonce)
	aad := frameAAD(frame[0], result[headerBytes:headerBytes+2+streamBytes+sequenceBytes])
	result = c.aead.Seal(result, nonce, frame[headerBytes:], aad)
	return result, nil
}

func (c *Cipher) OpenFrame(frame []byte) ([]byte, error) {
	headerBytes := 1
	// The relay inserts a clear viewer id into file requests. It is routing
	// metadata only; the request and its path remain encrypted.
	if len(frame) >= 5 && frame[0] == 0x0a {
		headerBytes = 5
	}
	if len(frame) < headerBytes+envelopeMetadataBytes+c.aead.Overhead() {
		return nil, fmt.Errorf("truncated E2EE frame")
	}
	if frame[headerBytes] != EnvelopeVersion {
		return nil, fmt.Errorf("unsupported E2EE envelope version")
	}
	expectedDirection, err := frameDirection(frame[0])
	if err != nil {
		return nil, err
	}
	if frame[headerBytes+1] != expectedDirection {
		return nil, fmt.Errorf("invalid E2EE frame direction")
	}
	var stream [streamBytes]byte
	copy(stream[:], frame[headerBytes+2:headerBytes+2+streamBytes])
	sequence := binary.BigEndian.Uint64(frame[headerBytes+2+streamBytes : headerBytes+2+streamBytes+sequenceBytes])
	if sequence == 0 {
		return nil, fmt.Errorf("invalid E2EE frame sequence")
	}
	nonceStart := headerBytes + 2 + streamBytes + sequenceBytes
	nonce := frame[nonceStart : nonceStart+NonceBytes]
	aad := frameAAD(frame[0], frame[headerBytes:headerBytes+2+streamBytes+sequenceBytes])
	plaintext, err := c.aead.Open(nil, nonce, frame[headerBytes+envelopeMetadataBytes:], aad)
	if err != nil {
		return nil, fmt.Errorf("authenticate E2EE frame: %w", err)
	}
	if !c.acceptSequence(stream, sequence) {
		return nil, fmt.Errorf("replayed or stale E2EE frame")
	}
	result := make([]byte, headerBytes+len(plaintext))
	copy(result, frame[:headerBytes])
	copy(result[headerBytes:], plaintext)
	return result, nil
}

func frameAAD(opcode byte, metadata []byte) []byte {
	result := make([]byte, 1+len(metadata))
	result[0] = opcode
	copy(result[1:], metadata)
	return result
}

func frameDirection(opcode byte) (byte, error) {
	switch opcode {
	case 0x01, 0x03, 0x05, 0x07, 0x08, 0x0b, 0x0d:
		return directionHostToViewer, nil
	case 0x02, 0x04, 0x06, 0x09, 0x0a, 0x0c:
		return directionViewerToHost, nil
	default:
		return 0, fmt.Errorf("unsupported E2EE frame opcode 0x%02x", opcode)
	}
}

// acceptSequence is a 64-frame replay window. It rejects duplicates while
// still allowing the small amount of legitimate reordering that concurrent
// output and snapshot writers can cause.
func (c *Cipher) acceptSequence(stream [streamBytes]byte, sequence uint64) bool {
	c.replayMu.Lock()
	defer c.replayMu.Unlock()
	window := c.replay[stream]
	if sequence > window.max {
		shift := sequence - window.max
		if shift >= 64 {
			window.bitmap = 1
		} else {
			window.bitmap = (window.bitmap << shift) | 1
		}
		window.max = sequence
		c.replay[stream] = window
		return true
	}
	delta := window.max - sequence
	if delta >= 64 || window.bitmap&(uint64(1)<<delta) != 0 {
		return false
	}
	window.bitmap |= uint64(1) << delta
	c.replay[stream] = window
	return true
}
