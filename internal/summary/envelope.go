// Package summary implements the host side of session summaries: the ss1.
// summary envelope, the sr1. request sealed to an attested summarizer enclave,
// verification of that enclave's identity, and the text hygiene applied before
// anything leaves this machine. The wire contract is PROTOCOL.md in the
// summarizer repository; every limit here mirrors it.
package summary

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"
)

const (
	summaryContext = "shell.online session summary v1"
	summaryPrefix  = "ss1."
	requestContext = "shell.online summary request v1"
	requestPrefix  = "sr1."

	// MaxTailBytes bounds the terminal text sent for one summary.
	MaxTailBytes = 12288
	// MaxTitleRunes and MaxSummaryRunes bound what the browser shows.
	MaxTitleRunes   = 80
	MaxSummaryRunes = 480
	// MaxLabelRunes bounds the command label sent with a request.
	MaxLabelRunes = 120
	// MaxSealedSummary bounds an ss1. envelope as stored and served.
	MaxSealedSummary = 8192
	// MaxRequestBody bounds one POST /v1/summarize body.
	MaxRequestBody = 32 << 10

	publicKeyChars = 87
	publicKeyBytes = 65
	maxBinding     = 256
	maxSafeInteger = 1<<53 - 1
)

// Summary states and sources, exactly as PROTOCOL.md §6 lists them.
const (
	StateWorking         = "working"
	StateWaitingForInput = "waiting_for_input"
	StateIdle            = "idle"
	StateError           = "error"
	StateFinished        = "finished"
	StateUnknown         = "unknown"

	SourceEnclave    = "enclave"
	SourceClaudeCode = "claude-code"
	SourceCodex      = "codex"
	SourceOpenCode   = "opencode"
)

var validStates = map[string]bool{
	StateWorking: true, StateWaitingForInput: true, StateIdle: true,
	StateError: true, StateFinished: true, StateUnknown: true,
}

var validSources = map[string]bool{
	SourceEnclave: true, SourceClaudeCode: true, SourceCodex: true, SourceOpenCode: true,
}

// Summary is the plaintext of an ss1. envelope. Plain text only: never
// Markdown or HTML, and no links, which the browser would not render anyway.
type Summary struct {
	Version    int    `json:"version"`
	Title      string `json:"title"`
	Summary    string `json:"summary"`
	State      string `json:"state"`
	Source     string `json:"source"`
	ObservedAt int64  `json:"observedAt"`
}

// Request is the plaintext of an sr1. envelope (PROTOCOL.md §4).
type Request struct {
	V                  int    `json:"v"`
	Ticket             string `json:"ticket"`
	SessionID          string `json:"session_id"`
	RecipientUID       string `json:"recipient_uid"`
	Generation         string `json:"generation"`
	ObservedAt         int64  `json:"observed_at"`
	RecipientPublicKey string `json:"recipient_public_key"`
	Label              string `json:"label"`
	Tail               string `json:"tail"`
}

func validBinding(value string) bool {
	return value != "" && len(value) <= maxBinding*4 && utf8.RuneCountInString(value) <= maxBinding && !hasUnsafeRune(value, false)
}

// ValidateSummary applies every PROTOCOL.md §6 rule, including the output
// guard: a summary that would carry a link, an address or markup is refused
// rather than sealed.
func ValidateSummary(sessionID, recipientUID, generation string, value Summary) error {
	for _, binding := range []string{sessionID, recipientUID, generation} {
		if !validBinding(binding) {
			return errors.New("invalid summary binding")
		}
	}
	if value.Version != 1 || value.ObservedAt <= 0 || value.ObservedAt > maxSafeInteger {
		return errors.New("invalid summary header")
	}
	if !validStates[value.State] || !validSources[value.Source] {
		return errors.New("invalid summary state or source")
	}
	if err := CheckText(value.Title, MaxTitleRunes, false); err != nil {
		return fmt.Errorf("invalid summary title: %w", err)
	}
	if err := CheckText(value.Summary, MaxSummaryRunes, true); err != nil {
		return fmt.Errorf("invalid summary text: %w", err)
	}
	return nil
}

func validateRequest(value Request) error {
	if value.V != 1 || value.Ticket == "" || len(value.Ticket) > 4096 || hasUnsafeRune(value.Ticket, false) {
		return errors.New("invalid summary request header")
	}
	for _, binding := range []string{value.SessionID, value.RecipientUID, value.Generation} {
		if !validBinding(binding) {
			return errors.New("invalid summary request binding")
		}
	}
	if value.ObservedAt <= 0 || value.ObservedAt > maxSafeInteger {
		return errors.New("invalid summary request time")
	}
	if _, err := decodePublicKey(value.RecipientPublicKey); err != nil {
		return fmt.Errorf("invalid summary recipient: %w", err)
	}
	if !utf8.ValidString(value.Label) || utf8.RuneCountInString(value.Label) > MaxLabelRunes || hasUnsafeRune(value.Label, false) {
		return errors.New("invalid summary request label")
	}
	if value.Tail == "" || len(value.Tail) > MaxTailBytes || !utf8.ValidString(value.Tail) || hasUnsafeRune(value.Tail, true) {
		return errors.New("invalid summary request tail")
	}
	return nil
}

// decodePublicKey accepts only the canonical 87-character base64url encoding
// of an uncompressed P-256 point, the same form as account vault keys.
func decodePublicKey(value string) (*ecdh.PublicKey, error) {
	if len(value) != publicKeyChars {
		return nil, errors.New("public key has the wrong length")
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || len(raw) != publicKeyBytes {
		return nil, errors.New("public key is not canonical base64url")
	}
	return ecdh.P256().NewPublicKey(raw)
}

func encode(value []byte) string { return base64.RawURLEncoding.EncodeToString(value) }

// canonicalJSON encodes like Go's json.Marshal with HTML escaping off, which
// is what every party computes associated data with.
func canonicalJSON(value any) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
}

func summaryAAD(sessionID, recipientUID, generation string, observedAt int64) []byte {
	return canonicalJSON([]any{summaryContext, sessionID, recipientUID, generation, observedAt})
}

func requestAAD(enclaveKey, senderPublicKey string) []byte {
	return canonicalJSON([]any{requestContext, enclaveKey, senderPublicKey})
}

func aeadFor(private *ecdh.PrivateKey, public *ecdh.PublicKey, info string) (cipher.AEAD, error) {
	shared, err := private.ECDH(public)
	if err != nil {
		return nil, err
	}
	defer clear(shared)
	key, err := hkdf.Key(sha256.New, shared, nil, info, 32)
	if err != nil {
		return nil, err
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func freshRandomness() (*ecdh.PrivateKey, []byte, error) {
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return ephemeral, nonce, nil
}

// SealSummary seals a summary to the owner's vault key. Only the owner's
// browser, after unlocking the vault, can open it.
func SealSummary(recipientPublicKey, sessionID, recipientUID, generation string, value Summary) (senderPublicKey, sealed string, err error) {
	ephemeral, nonce, err := freshRandomness()
	if err != nil {
		return "", "", err
	}
	return sealSummaryWith(ephemeral, nonce, recipientPublicKey, sessionID, recipientUID, generation, value)
}

func sealSummaryWith(ephemeral *ecdh.PrivateKey, nonce []byte, recipientPublicKey, sessionID, recipientUID, generation string, value Summary) (string, string, error) {
	if err := ValidateSummary(sessionID, recipientUID, generation, value); err != nil {
		return "", "", err
	}
	if ephemeral == nil || len(nonce) != 12 {
		return "", "", errors.New("invalid summary randomness")
	}
	recipient, err := decodePublicKey(recipientPublicKey)
	if err != nil {
		return "", "", fmt.Errorf("invalid summary recipient: %w", err)
	}
	aead, err := aeadFor(ephemeral, recipient, summaryContext)
	if err != nil {
		return "", "", err
	}
	plaintext, err := json.Marshal(value)
	if err != nil {
		return "", "", err
	}
	defer clear(plaintext)
	envelope := aead.Seal(append([]byte{}, nonce...), nonce, plaintext, summaryAAD(sessionID, recipientUID, generation, value.ObservedAt))
	sealed := summaryPrefix + encode(envelope)
	if len(sealed) > MaxSealedSummary {
		return "", "", errors.New("sealed summary is too large")
	}
	return encode(ephemeral.PublicKey().Bytes()), sealed, nil
}

// ValidSealedSummary checks the outer shape of an ss1. envelope received from
// the enclave before it is uploaded unchanged: the host cannot open it.
func ValidSealedSummary(senderPublicKey, sealed string) bool {
	if _, err := decodePublicKey(senderPublicKey); err != nil {
		return false
	}
	if len(sealed) > MaxSealedSummary || len(sealed) < len(summaryPrefix)+40 || sealed[:len(summaryPrefix)] != summaryPrefix {
		return false
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(sealed[len(summaryPrefix):])
	return err == nil && len(raw) >= 12+16+1
}

// SealRequest seals a summarize request to the attested enclave key with a
// fresh ephemeral key, so nothing between here and the enclave can read it.
func SealRequest(enclaveKey string, value Request) (senderPublicKey, sealed string, err error) {
	ephemeral, nonce, err := freshRandomness()
	if err != nil {
		return "", "", err
	}
	return sealRequestWith(ephemeral, nonce, enclaveKey, value)
}

func sealRequestWith(ephemeral *ecdh.PrivateKey, nonce []byte, enclaveKey string, value Request) (string, string, error) {
	if err := validateRequest(value); err != nil {
		return "", "", err
	}
	if ephemeral == nil || len(nonce) != 12 {
		return "", "", errors.New("invalid request randomness")
	}
	enclave, err := decodePublicKey(enclaveKey)
	if err != nil {
		return "", "", fmt.Errorf("invalid enclave key: %w", err)
	}
	aead, err := aeadFor(ephemeral, enclave, requestContext)
	if err != nil {
		return "", "", err
	}
	plaintext, err := json.Marshal(value)
	if err != nil {
		return "", "", err
	}
	defer clear(plaintext)
	sender := encode(ephemeral.PublicKey().Bytes())
	envelope := aead.Seal(append([]byte{}, nonce...), nonce, plaintext, requestAAD(enclaveKey, sender))
	return sender, requestPrefix + encode(envelope), nil
}
