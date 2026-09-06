package account

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

// The browser picks the browser password for a session it starts, and has to
// get it to the machine that will run the process. Sending it through the
// accounts service in the clear would let whoever runs that service decrypt
// the terminal, which is the one thing E2EE is for.
//
// So the agent publishes an ephemeral ECDH public key, the browser seals the
// password to it, and the service relays bytes it cannot open. The key lives
// only as long as the agent process: stopping the agent ends the ability to
// read anything sealed to it.

// sealInfo binds the derived key to this purpose, so the same ECDH shared
// secret cannot be reused meaningfully elsewhere.
const sealInfo = "shell.online cli password v1"

const sealNonceBytes = 12

// AgentKey is an agent's ephemeral key pair.
type AgentKey struct {
	private *ecdh.PrivateKey
}

// NewAgentKey generates a key pair for one run of the agent.
func NewAgentKey() (*AgentKey, error) {
	private, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate agent key: %w", err)
	}
	return &AgentKey{private: private}, nil
}

// PublicKey is the value published so a browser can seal to this agent.
func (key *AgentKey) PublicKey() string {
	return base64.RawURLEncoding.EncodeToString(key.private.PublicKey().Bytes())
}

// Open recovers a password sealed to this agent's public key.
//
// senderPublicKey and sealed are both base64url, as the browser sends them.
func (key *AgentKey) Open(senderPublicKey, sealed string) (string, error) {
	senderBytes, err := base64.RawURLEncoding.DecodeString(senderPublicKey)
	if err != nil {
		return "", fmt.Errorf("sender key is not base64url: %w", err)
	}
	sender, err := ecdh.P256().NewPublicKey(senderBytes)
	if err != nil {
		return "", fmt.Errorf("sender key is not a P-256 point: %w", err)
	}
	envelope, err := base64.RawURLEncoding.DecodeString(sealed)
	if err != nil {
		return "", fmt.Errorf("sealed password is not base64url: %w", err)
	}
	if len(envelope) <= sealNonceBytes {
		return "", fmt.Errorf("sealed password is too short")
	}

	shared, err := key.private.ECDH(sender)
	if err != nil {
		return "", fmt.Errorf("derive shared secret: %w", err)
	}
	derived, err := hkdf.Key(sha256.New, shared, nil, sealInfo, 32)
	if err != nil {
		return "", fmt.Errorf("derive key: %w", err)
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return "", fmt.Errorf("build cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("build AEAD: %w", err)
	}
	plaintext, err := aead.Open(nil, envelope[:sealNonceBytes], envelope[sealNonceBytes:], nil)
	if err != nil {
		return "", fmt.Errorf("the sealed password could not be opened")
	}
	return string(plaintext), nil
}

// sealForTest mirrors what the browser does. It exists so the Go tests cover
// the same envelope the web app produces.
func sealForTest(recipientPublicKey string, password string) (senderPublicKey, sealed string, err error) {
	recipientBytes, err := base64.RawURLEncoding.DecodeString(recipientPublicKey)
	if err != nil {
		return "", "", err
	}
	recipient, err := ecdh.P256().NewPublicKey(recipientBytes)
	if err != nil {
		return "", "", err
	}
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	shared, err := ephemeral.ECDH(recipient)
	if err != nil {
		return "", "", err
	}
	derived, err := hkdf.Key(sha256.New, shared, nil, sealInfo, 32)
	if err != nil {
		return "", "", err
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return "", "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", "", err
	}
	nonce := make([]byte, sealNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", "", err
	}
	ciphertext := aead.Seal(nil, nonce, []byte(password), nil)
	return base64.RawURLEncoding.EncodeToString(ephemeral.PublicKey().Bytes()),
		base64.RawURLEncoding.EncodeToString(append(nonce, ciphertext...)),
		nil
}
