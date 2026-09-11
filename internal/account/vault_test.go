package account

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const (
	testSessionID = "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t"
	testUID       = "uid-1"
)

func newAccountKey(t *testing.T) (*ecdh.PrivateKey, string) {
	t.Helper()
	private, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	return private, base64.RawURLEncoding.EncodeToString(private.PublicKey().Bytes())
}

func TestVaultShareRoundTrips(t *testing.T) {
	private, public := newAccountKey(t)
	sender, sealed, err := SealToAccount(public, testSessionID, testUID, "Kw9eHbru")
	if err != nil {
		t.Fatalf("SealToAccount: %v", err)
	}
	if !strings.HasPrefix(sealed, "v2.") {
		t.Fatalf("sealed = %q, want the v2. prefix", sealed)
	}
	got, err := openFromAccount(private, testSessionID, testUID, sender, sealed)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if got != "Kw9eHbru" {
		t.Fatalf("open = %q", got)
	}
}

func TestVaultShareHidesThePassword(t *testing.T) {
	_, public := newAccountKey(t)
	_, sealed, err := SealToAccount(public, testSessionID, testUID, "Kw9eHbru")
	if err != nil {
		t.Fatalf("SealToAccount: %v", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(sealed, "v2."))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if bytes.Contains(raw, []byte("Kw9eHbru")) {
		t.Fatal("the password appears in the envelope in the clear")
	}
}

// The service chooses which envelope goes with which session. Each of these is
// a way it could try to misuse one, and each must fail to open.
func TestVaultShareRefusesToOpenOutOfPlace(t *testing.T) {
	private, public := newAccountKey(t)
	sender, sealed, err := SealToAccount(public, testSessionID, testUID, "Kw9eHbru")
	if err != nil {
		t.Fatalf("SealToAccount: %v", err)
	}
	other, _ := newAccountKey(t)

	raw, _ := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(sealed, "v2."))
	raw[len(raw)-1] ^= 0x01
	tampered := "v2." + base64.RawURLEncoding.EncodeToString(raw)

	tests := []struct {
		name      string
		private   *ecdh.PrivateKey
		sessionID string
		uid       string
		sender    string
		sealed    string
	}{
		{"another session", private, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", testUID, sender, sealed},
		{"another person", private, testSessionID, "uid-2", sender, sealed},
		{"another account key", other, testSessionID, testUID, sender, sealed},
		{"a flipped ciphertext bit", private, testSessionID, testUID, sender, tampered},
		{"no version prefix", private, testSessionID, testUID, sender, strings.TrimPrefix(sealed, "v2.")},
		{"an agent-style envelope", private, testSessionID, testUID, sender, "v1." + strings.TrimPrefix(sealed, "v2.")},
		{"a sender that is not a key", private, testSessionID, testUID, "junk", sealed},
		{"an envelope that is only a nonce", private, testSessionID, testUID, sender,
			"v2." + base64.RawURLEncoding.EncodeToString(make([]byte, 12))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := openFromAccount(test.private, test.sessionID, test.uid, test.sender, test.sealed); err == nil {
				t.Fatal("opened an envelope that should have been refused")
			}
		})
	}
}

func TestSealToAccountRejectsBadInput(t *testing.T) {
	_, public := newAccountKey(t)
	tests := []struct {
		name, key, sessionID, uid string
	}{
		{"key is not base64url", "not base64!", testSessionID, testUID},
		{"key is not a point", base64.RawURLEncoding.EncodeToString(make([]byte, 65)), testSessionID, testUID},
		{"no session id", public, "", testUID},
		{"no recipient", public, testSessionID, ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := SealToAccount(test.key, test.sessionID, test.uid, "pw"); err == nil {
				t.Fatal("SealToAccount accepted bad input")
			}
		})
	}
}

func TestParseAccountKey(t *testing.T) {
	_, public := newAccountKey(t)
	private, _ := newAccountKey(t)
	compressed := base64.RawURLEncoding.EncodeToString(private.PublicKey().Bytes()[:33])

	if err := ParseAccountKey(public); err != nil {
		t.Fatalf("a real key was refused: %v", err)
	}
	for name, value := range map[string]string{
		"empty":             "",
		"not base64url":     "abc$def",
		"padded base64":     public + "=",
		"too short":         compressed,
		"all zero point":    base64.RawURLEncoding.EncodeToString(make([]byte, 65)),
		"random 65 bytes":   base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x04, 0x11}, 33)[:65]),
		"standard alphabet": strings.NewReplacer("-", "+", "_", "/").Replace(public) + "+/",
	} {
		t.Run(name, func(t *testing.T) {
			if err := ParseAccountKey(value); err == nil {
				t.Fatalf("ParseAccountKey accepted %q", value)
			}
		})
	}
}

func TestFingerprintIsShortAndStable(t *testing.T) {
	_, public := newAccountKey(t)
	first, err := Fingerprint(public)
	if err != nil {
		t.Fatalf("Fingerprint: %v", err)
	}
	if !regexp.MustCompile(`^[0-9a-f]{4}(-[0-9a-f]{4}){3}$`).MatchString(first) {
		t.Fatalf("fingerprint = %q, want four groups of four hex digits", first)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(public)
	sum := sha256.Sum256(raw)
	if strings.ReplaceAll(first, "-", "") != hex.EncodeToString(sum[:8]) {
		t.Fatalf("fingerprint %q is not the first eight bytes of the key's SHA-256", first)
	}
	if _, err := Fingerprint("junk"); err == nil {
		t.Fatal("Fingerprint accepted something that is not a key")
	}
}

/*
 * The cross-language vectors.
 *
 * The browser opens what the CLI seals and seals what the web app stores, so
 * the two implementations must agree byte for byte on the derivation. Each side
 * writes a fixed vector the other opens in its own tests.
 */

type vaultVector struct {
	RecipientPrivateKeyHex string `json:"recipient_private_key_hex"`
	RecipientPublicKey     string `json:"recipient_public_key"`
	SessionID              string `json:"session_id"`
	UID                    string `json:"uid"`
	Password               string `json:"password"`
	SenderPublicKey        string `json:"sender_public_key"`
	Sealed                 string `json:"sealed"`
}

const goVectorPath = "testdata/vault-share-v2-go.json"
const browserVectorPath = "testdata/vault-share-v2-browser.json"

func fixedScalar(t *testing.T, label string) *ecdh.PrivateKey {
	t.Helper()
	sum := sha256.Sum256([]byte(label))
	key, err := ecdh.P256().NewPrivateKey(sum[:])
	if err != nil {
		t.Fatalf("fixed key %q: %v", label, err)
	}
	return key
}

func buildGoVector(t *testing.T) vaultVector {
	t.Helper()
	recipient := fixedScalar(t, "shell.online vault vector recipient")
	ephemeral := fixedScalar(t, "shell.online vault vector ephemeral")
	nonce := []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}
	public := base64.RawURLEncoding.EncodeToString(recipient.PublicKey().Bytes())
	vector := vaultVector{
		RecipientPrivateKeyHex: hex.EncodeToString(recipient.Bytes()),
		RecipientPublicKey:     public,
		SessionID:              testSessionID,
		UID:                    "uid-vector",
		Password:               "Kw9eHbru",
	}
	sender, sealed, err := sealToAccountWith(ephemeral, nonce, public, vector.SessionID, vector.UID, vector.Password)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	vector.SenderPublicKey = sender
	vector.Sealed = sealed
	return vector
}

func openVector(t *testing.T, vector vaultVector) string {
	t.Helper()
	scalar, err := hex.DecodeString(vector.RecipientPrivateKeyHex)
	if err != nil {
		t.Fatalf("private key hex: %v", err)
	}
	private, err := ecdh.P256().NewPrivateKey(scalar)
	if err != nil {
		t.Fatalf("private key: %v", err)
	}
	if got := base64.RawURLEncoding.EncodeToString(private.PublicKey().Bytes()); got != vector.RecipientPublicKey {
		t.Fatalf("the vector's public key does not belong to its private key")
	}
	password, err := openFromAccount(private, vector.SessionID, vector.UID, vector.SenderPublicKey, vector.Sealed)
	if err != nil {
		t.Fatalf("open vector: %v", err)
	}
	return password
}

// The file is what the browser test reads, so it must be exactly what this
// code produces. Regenerate with UPDATE_VAULT_VECTOR=1 after a deliberate
// change to the format, never by hand.
func TestGoVaultVectorMatchesTestdata(t *testing.T) {
	vector := buildGoVector(t)
	encoded, err := json.MarshalIndent(vector, "", "  ")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	encoded = append(encoded, '\n')

	if os.Getenv("UPDATE_VAULT_VECTOR") == "1" {
		if err := os.MkdirAll(filepath.Dir(goVectorPath), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(goVectorPath, encoded, 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	stored, err := os.ReadFile(goVectorPath)
	if err != nil {
		t.Fatalf("read %s: %v", goVectorPath, err)
	}
	if !bytes.Equal(stored, encoded) {
		t.Fatalf("%s no longer matches what this code seals; the browser test is checking a stale vector", goVectorPath)
	}
	if got := openVector(t, vector); got != vector.Password {
		t.Fatalf("vector opened to %q", got)
	}
}

func TestOpenBrowserVaultVector(t *testing.T) {
	contents, err := os.ReadFile(browserVectorPath)
	if errors.Is(err, os.ErrNotExist) {
		t.Skipf("%s has not been generated by the web app yet", browserVectorPath)
	}
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var vector vaultVector
	if err := json.Unmarshal(contents, &vector); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := openVector(t, vector); got != vector.Password {
		t.Fatalf("the browser's envelope opened to %q, want %q", got, vector.Password)
	}
}
