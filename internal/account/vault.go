package account

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// A session's password is chosen on the machine that runs it, and until now it
// lived only there and in whichever browser happened to be told it. Close the
// terminal window, clear the browser, and the session could never be opened
// again.
//
// So the CLI now seals every password to the account's own public key when it
// publishes the session. The private half never leaves the person's browsers
// unencrypted: the accounts service keeps it wrapped under a recovery key it
// has never seen. The service stores this envelope and cannot open it, which
// is the same promise the agent envelope in sealed.go makes, extended from one
// agent run to the account.
//
// The session id and the recipient's uid are bound in as associated data. The
// service decides which envelope goes with which session, and without the
// binding it could hand one session's password to another session's pane.

// vaultShareInfo separates this derivation from every other use of the curve.
// It differs from sealInfo on purpose: the two envelopes carry the same kind of
// secret to different keys, and must never be mistaken for each other.
const vaultShareInfo = "shell.online session vault v2"

// vaultSharePrefix versions the envelope in the value itself, so a later format
// can be told apart without a schema change on the service.
const vaultSharePrefix = "v2."

// accountKeyBytes is an uncompressed P-256 point.
const accountKeyBytes = 65

// ParseAccountKey reports whether value is an account public key: base64url
// without padding, decoding to an uncompressed P-256 point.
func ParseAccountKey(value string) error {
	_, err := decodeAccountKey(value)
	return err
}

func decodeAccountKey(value string) (*ecdh.PublicKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("account key is not base64url: %w", err)
	}
	if len(raw) != accountKeyBytes {
		return nil, fmt.Errorf("account key is %d bytes, want %d", len(raw), accountKeyBytes)
	}
	key, err := ecdh.P256().NewPublicKey(raw)
	if err != nil {
		return nil, fmt.Errorf("account key is not a P-256 point: %w", err)
	}
	return key, nil
}

// Fingerprint is the short form of an account key that a person compares by
// eye: the first eight bytes of its SHA-256, as four groups of four hex digits.
// The web app's account page shows the same value.
func Fingerprint(accountPublicKey string) (string, error) {
	key, err := decodeAccountKey(accountPublicKey)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(key.Bytes())
	digits := hex.EncodeToString(sum[:8])
	return digits[0:4] + "-" + digits[4:8] + "-" + digits[8:12] + "-" + digits[12:16], nil
}

// SealToAccount seals a session password so that only the holder of the
// account's private key can read it, and only as the password of this session
// for this person.
func SealToAccount(accountPublicKey, sessionID, recipientUID, password string) (senderPublicKey, sealed string, err error) {
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", "", fmt.Errorf("generate ephemeral key: %w", err)
	}
	nonce := make([]byte, sealNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", "", fmt.Errorf("generate nonce: %w", err)
	}
	return sealToAccountWith(ephemeral, nonce, accountPublicKey, sessionID, recipientUID, password)
}

// sealToAccountWith is SealToAccount with the randomness supplied, so a test
// can produce a fixed vector for the browser to check against.
func sealToAccountWith(
	ephemeral *ecdh.PrivateKey, nonce []byte, accountPublicKey, sessionID, recipientUID, password string,
) (string, string, error) {
	if sessionID == "" || recipientUID == "" {
		return "", "", errors.New("a vault share needs a session id and a recipient")
	}
	recipient, err := decodeAccountKey(accountPublicKey)
	if err != nil {
		return "", "", err
	}
	aead, err := vaultShareCipher(ephemeral, recipient)
	if err != nil {
		return "", "", err
	}
	ciphertext := aead.Seal(nil, nonce, []byte(password), vaultShareAAD(sessionID, recipientUID))
	envelope := append(append([]byte{}, nonce...), ciphertext...)
	return base64.RawURLEncoding.EncodeToString(ephemeral.PublicKey().Bytes()),
		vaultSharePrefix + base64.RawURLEncoding.EncodeToString(envelope),
		nil
}

// openFromAccount is the browser's half, kept here so the Go tests check the
// envelope end to end. The CLI itself never holds an account private key.
func openFromAccount(private *ecdh.PrivateKey, sessionID, recipientUID, senderPublicKey, sealed string) (string, error) {
	if !strings.HasPrefix(sealed, vaultSharePrefix) {
		return "", errors.New("not a v2 vault share")
	}
	sender, err := decodeAccountKey(senderPublicKey)
	if err != nil {
		return "", fmt.Errorf("sender key: %w", err)
	}
	envelope, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(sealed, vaultSharePrefix))
	if err != nil {
		return "", fmt.Errorf("vault share is not base64url: %w", err)
	}
	if len(envelope) <= sealNonceBytes {
		return "", errors.New("vault share is too short")
	}
	aead, err := vaultShareCipher(private, sender)
	if err != nil {
		return "", err
	}
	plaintext, err := aead.Open(nil, envelope[:sealNonceBytes], envelope[sealNonceBytes:], vaultShareAAD(sessionID, recipientUID))
	if err != nil {
		return "", errors.New("the vault share could not be opened")
	}
	return string(plaintext), nil
}

func vaultShareAAD(sessionID, recipientUID string) []byte {
	return []byte(sessionID + "\x00" + recipientUID)
}

func vaultShareCipher(private *ecdh.PrivateKey, public *ecdh.PublicKey) (cipher.AEAD, error) {
	shared, err := private.ECDH(public)
	if err != nil {
		return nil, fmt.Errorf("derive shared secret: %w", err)
	}
	derived, err := hkdf.Key(sha256.New, shared, nil, vaultShareInfo, 32)
	if err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return nil, fmt.Errorf("build cipher: %w", err)
	}
	return cipher.NewGCM(block)
}
