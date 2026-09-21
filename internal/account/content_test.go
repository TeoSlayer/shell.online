package account

import (
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type contentFixture struct {
	RecipientPrivateKey string         `json:"recipientPrivateKey"`
	SenderPrivateKey    string         `json:"senderPrivateKey"`
	Nonce               string         `json:"nonce"`
	AccountPublicKey    string         `json:"accountPublicKey"`
	SessionID           string         `json:"sessionId"`
	RecipientUID        string         `json:"recipientUid"`
	Generation          string         `json:"generation"`
	Content             SessionContent `json:"content"`
	SenderPublicKey     string         `json:"senderPublicKey"`
	Sealed              string         `json:"sealed"`
}

func readContentFixture(t *testing.T) contentFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/session-content-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture contentFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func contentBytes(t *testing.T, value string) []byte {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestSessionContentMatchesBrowserVector(t *testing.T) {
	f := readContentFixture(t)
	sender, err := ecdh.P256().NewPrivateKey(contentBytes(t, f.SenderPrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	public, sealed, err := sealSessionContentWith(sender, contentBytes(t, f.Nonce), f.AccountPublicKey, f.SessionID, f.RecipientUID, f.Generation, f.Content)
	if err != nil {
		t.Fatal(err)
	}
	if public != f.SenderPublicKey || sealed != f.Sealed {
		t.Fatal("session content vector mismatch")
	}
}

func TestSessionContentRoundTripAndBindings(t *testing.T) {
	f := readContentFixture(t)
	owner, _ := ecdh.P256().NewPrivateKey(contentBytes(t, f.RecipientPrivateKey))
	public, sealed, err := SealSessionContent(f.AccountPublicKey, f.SessionID, f.RecipientUID, f.Generation, f.Content)
	if err != nil {
		t.Fatal(err)
	}
	sender, err := decodeAccountKey(public)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := sessionContentCipher(owner, sender)
	if err != nil {
		t.Fatal(err)
	}
	envelope := contentBytes(t, strings.TrimPrefix(sealed, sessionContentPrefix))
	aad := sessionContentAAD(f.SessionID, f.RecipientUID, f.Generation, f.Content.ObservedAt)
	plaintext, err := aead.Open(nil, envelope[:12], envelope[12:], aad)
	if err != nil {
		t.Fatal(err)
	}
	var got SessionContent
	if err := json.Unmarshal(plaintext, &got); err != nil || got != f.Content {
		t.Fatal("round trip failed")
	}
	for _, binding := range []struct {
		session, recipient, generation string
		at                             int64
	}{
		{"other", f.RecipientUID, f.Generation, f.Content.ObservedAt},
		{f.SessionID, "other", f.Generation, f.Content.ObservedAt},
		{f.SessionID, f.RecipientUID, "other", f.Content.ObservedAt},
		{f.SessionID, f.RecipientUID, f.Generation, f.Content.ObservedAt + 1},
	} {
		if _, err := aead.Open(nil, envelope[:12], envelope[12:], sessionContentAAD(binding.session, binding.recipient, binding.generation, binding.at)); err == nil {
			t.Fatal("opened under wrong binding")
		}
	}
	envelope[len(envelope)-1] ^= 1
	if _, err := aead.Open(nil, envelope[:12], envelope[12:], aad); err == nil {
		t.Fatal("tamper accepted")
	}
	if _, err := openFromAccount(owner, f.SessionID, f.RecipientUID, public, "v2."+strings.TrimPrefix(sealed, sessionContentPrefix)); err == nil {
		t.Fatal("content opened as a password")
	}
}

func TestSessionContentValidation(t *testing.T) {
	f := readContentFixture(t)
	for name, mutate := range map[string]func(*SessionContent){
		"version":         func(c *SessionContent) { c.Version = 2 },
		"title cap":       func(c *SessionContent) { c.SuggestedTitle = strings.Repeat("🔒", 121) },
		"description cap": func(c *SessionContent) { c.Description = strings.Repeat("é", 601) },
		"control":         func(c *SessionContent) { c.Description = "a\x1bb" },
		"title newline":   func(c *SessionContent) { c.SuggestedTitle = "a\nb" },
		"bidi":            func(c *SessionContent) { c.SuggestedTitle = "a\u202eb" },
		"invalid utf8":    func(c *SessionContent) { c.Description = string([]byte{0xff}) },
		"source":          func(c *SessionContent) { c.Source = "reasoning" },
		"time zero":       func(c *SessionContent) { c.ObservedAt = 0 },
		"unsafe time":     func(c *SessionContent) { c.ObservedAt = 9007199254740992 },
	} {
		t.Run(name, func(t *testing.T) {
			c := f.Content
			mutate(&c)
			if _, _, err := SealSessionContent(f.AccountPublicKey, f.SessionID, f.RecipientUID, f.Generation, c); err == nil {
				t.Fatal("accepted invalid content")
			}
		})
	}
	for _, binding := range []string{"", "bad\x00binding", strings.Repeat("a", 257)} {
		if _, _, err := SealSessionContent(f.AccountPublicKey, binding, f.RecipientUID, f.Generation, f.Content); err == nil {
			t.Fatal("accepted invalid binding")
		}
	}
	if _, _, err := SealSessionContent("invalid", f.SessionID, f.RecipientUID, f.Generation, f.Content); err == nil {
		t.Fatal("accepted invalid recipient")
	}
	c := f.Content
	c.SuggestedTitle = strings.Repeat("🔒", 120)
	c.Description = strings.Repeat("é", 600)
	if _, _, err := SealSessionContent(f.AccountPublicKey, f.SessionID, f.RecipientUID, f.Generation, c); err != nil {
		t.Fatal(err)
	}
}
