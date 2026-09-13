package e2ee

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	KeyBytes                     = 32
	NonceBytes                   = 12
	SaltBytes                    = 16
	BrowserPasswordBytes         = 10
	BrowserPasswordLength        = 10
	EnvelopeVersion         byte = 1
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

type Cipher struct{ aead cipher.AEAD }

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
	return &Cipher{aead: aead}, nil
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
	nonce := make([]byte, NonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return c.sealFrameWithNonce(frame, nonce)
}

func (c *Cipher) sealFrameWithNonce(frame, nonce []byte) ([]byte, error) {
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
	result := make([]byte, headerBytes+1+NonceBytes, headerBytes+1+NonceBytes+len(frame)-headerBytes+c.aead.Overhead())
	copy(result, frame[:headerBytes])
	result[headerBytes] = EnvelopeVersion
	copy(result[headerBytes+1:], nonce)
	result = c.aead.Seal(result, nonce, frame[headerBytes:], frame[:1])
	return result, nil
}

func (c *Cipher) OpenFrame(frame []byte) ([]byte, error) {
	headerBytes := 1
	// The relay inserts a clear viewer id into file requests. It is routing
	// metadata only; the request and its path remain encrypted.
	if len(frame) >= 5 && frame[0] == 0x0a {
		headerBytes = 5
	}
	if len(frame) < headerBytes+1+NonceBytes+c.aead.Overhead() {
		return nil, fmt.Errorf("truncated E2EE frame")
	}
	if frame[headerBytes] != EnvelopeVersion {
		return nil, fmt.Errorf("unsupported E2EE envelope version")
	}
	nonce := frame[headerBytes+1 : headerBytes+1+NonceBytes]
	plaintext, err := c.aead.Open(nil, nonce, frame[headerBytes+1+NonceBytes:], frame[:1])
	if err != nil {
		return nil, fmt.Errorf("authenticate E2EE frame: %w", err)
	}
	result := make([]byte, headerBytes+len(plaintext))
	copy(result, frame[:headerBytes])
	copy(result[headerBytes:], plaintext)
	return result, nil
}
