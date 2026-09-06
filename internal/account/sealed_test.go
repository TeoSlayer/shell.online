package account

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestSealedPasswordRoundTrips(t *testing.T) {
	key, err := NewAgentKey()
	if err != nil {
		t.Fatalf("NewAgentKey: %v", err)
	}
	sender, sealed, err := sealForTest(key.PublicKey(), "Kw9eHbru")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	got, err := key.Open(sender, sealed)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got != "Kw9eHbru" {
		t.Fatalf("Open = %q, want the sealed password", got)
	}
}

func TestSealedPasswordIsNotReadableWithoutTheAgentKey(t *testing.T) {
	// This is the whole point: the accounts service relays the envelope and
	// must not be able to open it.
	key, err := NewAgentKey()
	if err != nil {
		t.Fatalf("NewAgentKey: %v", err)
	}
	sender, sealed, err := sealForTest(key.PublicKey(), "Kw9eHbru")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	raw, err := base64.RawURLEncoding.DecodeString(sealed)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if strings.Contains(string(raw), "Kw9eHbru") {
		t.Fatal("the password appears in the envelope in the clear")
	}

	other, err := NewAgentKey()
	if err != nil {
		t.Fatalf("NewAgentKey: %v", err)
	}
	if _, err := other.Open(sender, sealed); err == nil {
		t.Fatal("a different agent key opened the envelope")
	}
}

func TestPublicKeyIsStableForOneAgentRun(t *testing.T) {
	key, err := NewAgentKey()
	if err != nil {
		t.Fatalf("NewAgentKey: %v", err)
	}
	if key.PublicKey() != key.PublicKey() {
		t.Fatal("PublicKey changed between calls")
	}
	if key.PublicKey() == "" {
		t.Fatal("PublicKey is empty")
	}
}

func TestEachAgentRunGetsItsOwnKey(t *testing.T) {
	// Stopping the agent should end the ability to read anything sealed to it.
	seen := make(map[string]struct{}, 20)
	for i := 0; i < 20; i++ {
		key, err := NewAgentKey()
		if err != nil {
			t.Fatalf("NewAgentKey: %v", err)
		}
		if _, exists := seen[key.PublicKey()]; exists {
			t.Fatal("two agent runs produced the same key")
		}
		seen[key.PublicKey()] = struct{}{}
	}
}

func TestOpenRejectsMalformedInput(t *testing.T) {
	key, err := NewAgentKey()
	if err != nil {
		t.Fatalf("NewAgentKey: %v", err)
	}
	sender, sealed, err := sealForTest(key.PublicKey(), "secret")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	tests := []struct {
		name            string
		senderKey, blob string
	}{
		{"sender key is not base64url", "not base64!", sealed},
		{"sender key is not a point", base64.RawURLEncoding.EncodeToString([]byte("short")), sealed},
		{"envelope is not base64url", sender, "not base64!"},
		{"envelope is empty", sender, ""},
		{"envelope is only a nonce", sender, base64.RawURLEncoding.EncodeToString(make([]byte, 12))},
		{"both empty", "", ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := key.Open(test.senderKey, test.blob); err == nil {
				t.Fatal("Open accepted malformed input")
			}
		})
	}
}

func TestOpenRejectsATamperedEnvelope(t *testing.T) {
	key, err := NewAgentKey()
	if err != nil {
		t.Fatalf("NewAgentKey: %v", err)
	}
	sender, sealed, err := sealForTest(key.PublicKey(), "secret")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(sealed)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Flip a ciphertext bit. AES-GCM must refuse rather than return garbage.
	raw[len(raw)-1] ^= 0x01
	if _, err := key.Open(sender, base64.RawURLEncoding.EncodeToString(raw)); err == nil {
		t.Fatal("Open accepted a tampered envelope")
	}
}

func TestOpenCarriesAnEmptyPasswordFaithfully(t *testing.T) {
	key, err := NewAgentKey()
	if err != nil {
		t.Fatalf("NewAgentKey: %v", err)
	}
	sender, sealed, err := sealForTest(key.PublicKey(), "")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	got, err := key.Open(sender, sealed)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got != "" {
		t.Fatalf("Open = %q, want an empty string", got)
	}
}
