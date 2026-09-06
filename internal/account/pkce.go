// Package account links a local shell.online CLI to a signed-in account.
//
// Login uses the OAuth 2.0 authorization code flow with PKCE and a loopback
// redirect (RFC 8252), the same shape browsers and CLIs use for a desktop
// login. The CLI never sees the account password, and the authorization code
// is useless without the verifier that never leaves this machine.
package account

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
)

// verifierBytes yields 43 base64url characters, the RFC 7636 minimum.
const verifierBytes = 32

func randomString(byteCount int) (string, error) {
	buffer := make([]byte, byteCount)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

// NewVerifier returns a fresh PKCE code verifier.
func NewVerifier() (string, error) {
	return randomString(verifierBytes)
}

// NewState returns an opaque value that ties a callback to this login attempt.
func NewState() (string, error) {
	return randomString(verifierBytes)
}

// Challenge derives the S256 challenge the browser hands to the service.
func Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// SameState compares two state values without leaking timing information.
func SameState(expected, actual string) bool {
	if len(expected) == 0 || len(expected) != len(actual) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}
