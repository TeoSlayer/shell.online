package account

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
	"unicode"
	"unicode/utf8"
)

const sessionContentContext = "shell.online session content v1"
const sessionContentPrefix = "sc1."

// SessionContent is existing locally observed content, never a generated briefing.
type SessionContent struct {
	Version        int    `json:"version"`
	SuggestedTitle string `json:"suggestedTitle"`
	Description    string `json:"description"`
	Source         string `json:"source"`
	ObservedAt     int64  `json:"observedAt"`
}

// SealSessionContent seals only to the owner's account key, with an independent
// purpose and an authenticated session, recipient, generation and observation time.
func SealSessionContent(accountPublicKey, sessionID, recipientUID, generation string, content SessionContent) (senderPublicKey, sealed string, err error) {
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	nonce := make([]byte, 12)
	if _, err = rand.Read(nonce); err != nil {
		return "", "", err
	}
	return sealSessionContentWith(ephemeral, nonce, accountPublicKey, sessionID, recipientUID, generation, content)
}

func validContentText(text string, max int) bool {
	if !utf8.ValidString(text) || utf8.RuneCountInString(text) > max {
		return false
	}
	for _, r := range text {
		if unicode.IsControl(r) || r == 0x061c || r == 0x200e || r == 0x200f || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) {
			return false
		}
	}
	return true
}

func validateSessionContent(sessionID, recipientUID, generation string, content SessionContent) error {
	for _, binding := range []string{sessionID, recipientUID, generation} {
		if binding == "" || !validContentText(binding, 256) {
			return errors.New("invalid session content binding")
		}
	}
	if content.Version != 1 || content.ObservedAt <= 0 || content.ObservedAt > 9007199254740991 ||
		!validContentText(content.SuggestedTitle, 120) || !validContentText(content.Description, 600) ||
		(content.Source != "opencode-launch" && content.Source != "generic") {
		return errors.New("invalid session content")
	}
	return nil
}

func sessionContentAAD(sessionID, recipientUID, generation string, observedAt int64) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode([]any{sessionContentContext, sessionID, recipientUID, generation, observedAt})
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
}

func sessionContentCipher(private *ecdh.PrivateKey, public *ecdh.PublicKey) (cipher.AEAD, error) {
	shared, err := private.ECDH(public)
	if err != nil {
		return nil, err
	}
	defer clear(shared)
	key, err := hkdf.Key(sha256.New, shared, nil, sessionContentContext, 32)
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

func sealSessionContentWith(ephemeral *ecdh.PrivateKey, nonce []byte, accountPublicKey, sessionID, recipientUID, generation string, content SessionContent) (string, string, error) {
	if err := validateSessionContent(sessionID, recipientUID, generation, content); err != nil {
		return "", "", err
	}
	if len(nonce) != 12 || ephemeral == nil {
		return "", "", errors.New("invalid session content randomness")
	}
	if len(accountPublicKey) != 87 {
		return "", "", errors.New("invalid session content recipient key")
	}
	recipient, err := decodeAccountKey(accountPublicKey)
	if err != nil {
		return "", "", err
	}
	aead, err := sessionContentCipher(ephemeral, recipient)
	if err != nil {
		return "", "", err
	}
	plaintext, err := json.Marshal(content)
	if err != nil {
		return "", "", err
	}
	defer clear(plaintext)
	envelope := aead.Seal(append([]byte{}, nonce...), nonce, plaintext, sessionContentAAD(sessionID, recipientUID, generation, content.ObservedAt))
	return base64.RawURLEncoding.EncodeToString(ephemeral.PublicKey().Bytes()), sessionContentPrefix + base64.RawURLEncoding.EncodeToString(envelope), nil
}
