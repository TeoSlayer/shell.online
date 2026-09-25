package summary

import (
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"strings"
	"testing"
)

var updateFixtures = flag.Bool("update", false, "rewrite testdata fixtures")

func scalarKey(t *testing.T, last byte) *ecdh.PrivateKey {
	t.Helper()
	scalar := make([]byte, 32)
	scalar[31] = last
	key, err := ecdh.P256().NewPrivateKey(scalar)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func openEnvelope(private *ecdh.PrivateKey, senderPublicKey, sealed, prefix, info string, aad []byte) ([]byte, error) {
	if !strings.HasPrefix(sealed, prefix) {
		return nil, errors.New("prefix")
	}
	sender, err := decodePublicKey(senderPublicKey)
	if err != nil {
		return nil, err
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(sealed[len(prefix):])
	if err != nil || len(raw) < 29 {
		return nil, errors.New("envelope")
	}
	aead, err := aeadFor(private, sender, info)
	if err != nil {
		return nil, err
	}
	return aead.Open(nil, raw[:12], raw[12:], aad)
}

func openSummary(private *ecdh.PrivateKey, sessionID, recipientUID, generation string, observedAt int64, sender, sealed string) (Summary, error) {
	plaintext, err := openEnvelope(private, sender, sealed, summaryPrefix, summaryContext, summaryAAD(sessionID, recipientUID, generation, observedAt))
	if err != nil {
		return Summary{}, err
	}
	var value Summary
	err = json.Unmarshal(plaintext, &value)
	return value, err
}

func openRequest(private *ecdh.PrivateKey, enclaveKey, sender, sealed string) (Request, error) {
	plaintext, err := openEnvelope(private, sender, sealed, requestPrefix, requestContext, requestAAD(enclaveKey, sender))
	if err != nil {
		return Request{}, err
	}
	var value Request
	err = json.Unmarshal(plaintext, &value)
	return value, err
}

func sampleSummary() Summary {
	return Summary{Version: 1, Title: "Synthetic café build 🔒", Summary: "Tests ran.\nTwo failed in parser.cc and main.go.", State: StateError, Source: SourceClaudeCode, ObservedAt: 1800000000123}
}

type summaryFixture struct {
	RecipientPrivateKey string  `json:"recipientPrivateKey"`
	SenderPrivateKey    string  `json:"senderPrivateKey"`
	Nonce               string  `json:"nonce"`
	RecipientPublicKey  string  `json:"recipientPublicKey"`
	SessionID           string  `json:"sessionId"`
	RecipientUID        string  `json:"recipientUid"`
	Generation          string  `json:"generation"`
	Summary             Summary `json:"summary"`
	SenderPublicKey     string  `json:"senderPublicKey"`
	Sealed              string  `json:"sealed"`
}

// The fixture is shared with the browser opener and the enclave sealer: all
// three must produce and accept these exact bytes.
func TestSummaryMatchesCrossLanguageVector(t *testing.T) {
	recipient, sender := scalarKey(t, 1), scalarKey(t, 2)
	nonce := []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}
	fixture := summaryFixture{
		RecipientPrivateKey: encode(recipient.Bytes()),
		SenderPrivateKey:    encode(sender.Bytes()),
		Nonce:               encode(nonce),
		RecipientPublicKey:  encode(recipient.PublicKey().Bytes()),
		SessionID:           "synthetic<&> session ",
		RecipientUID:        "synthetic-owner",
		Generation:          "synthetic-generation-1",
		Summary:             sampleSummary(),
	}
	senderPublic, sealed, err := sealSummaryWith(sender, nonce, fixture.RecipientPublicKey, fixture.SessionID, fixture.RecipientUID, fixture.Generation, fixture.Summary)
	if err != nil {
		t.Fatal(err)
	}
	fixture.SenderPublicKey, fixture.Sealed = senderPublic, sealed
	path := "testdata/session-summary-v1.json"
	if *updateFixtures {
		encoded, _ := json.MarshalIndent(fixture, "", "  ")
		if err := os.WriteFile(path, append(encoded, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var stored summaryFixture
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	if stored != fixture {
		t.Fatalf("sealing no longer matches %s; rerun with -update only for a deliberate format change", path)
	}
	opened, err := openSummary(recipient, stored.SessionID, stored.RecipientUID, stored.Generation, stored.Summary.ObservedAt, stored.SenderPublicKey, stored.Sealed)
	if err != nil || opened != stored.Summary {
		t.Fatalf("fixture does not open: %v %+v", err, opened)
	}
}

func TestSummaryBindingsAndPurpose(t *testing.T) {
	recipient := scalarKey(t, 7)
	key := encode(recipient.PublicKey().Bytes())
	value := sampleSummary()
	sender, sealed, err := SealSummary(key, "session", "owner", "gen", value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := openSummary(recipient, "session", "owner", "gen", value.ObservedAt, sender, sealed); err != nil {
		t.Fatalf("round trip: %v", err)
	}
	for name, open := range map[string]func() error{
		"session": func() error {
			_, err := openSummary(recipient, "other", "owner", "gen", value.ObservedAt, sender, sealed)
			return err
		},
		"recipient": func() error {
			_, err := openSummary(recipient, "session", "other", "gen", value.ObservedAt, sender, sealed)
			return err
		},
		"generation": func() error {
			_, err := openSummary(recipient, "session", "owner", "gen2", value.ObservedAt, sender, sealed)
			return err
		},
		"time": func() error {
			_, err := openSummary(recipient, "session", "owner", "gen", value.ObservedAt+1, sender, sealed)
			return err
		},
		"purpose": func() error {
			_, err := openEnvelope(recipient, sender, "sr1."+sealed[4:], requestPrefix, "shell.online session content v1", summaryAAD("session", "owner", "gen", value.ObservedAt))
			return err
		},
	} {
		if open() == nil {
			t.Errorf("%s: a mismatched binding opened", name)
		}
	}
	if !ValidSealedSummary(sender, sealed) || ValidSealedSummary(sender, "sc1."+sealed[4:]) || ValidSealedSummary("x", sealed) {
		t.Error("ValidSealedSummary shape checks")
	}
}

func TestSummaryValidation(t *testing.T) {
	key := encode(scalarKey(t, 3).PublicKey().Bytes())
	mutate := func(change func(*Summary)) Summary { value := sampleSummary(); change(&value); return value }
	cases := map[string]Summary{
		"version":      mutate(func(v *Summary) { v.Version = 2 }),
		"time":         mutate(func(v *Summary) { v.ObservedAt = 0 }),
		"state":        mutate(func(v *Summary) { v.State = "done" }),
		"source":       mutate(func(v *Summary) { v.Source = "generic" }),
		"empty title":  mutate(func(v *Summary) { v.Title = " " }),
		"long title":   mutate(func(v *Summary) { v.Title = strings.Repeat("a", 81) }),
		"title line":   mutate(func(v *Summary) { v.Title = "a\nb" }),
		"long summary": mutate(func(v *Summary) { v.Summary = strings.Repeat("a", 481) }),
		"tab":          mutate(func(v *Summary) { v.Summary = "a\tb" }),
		"bidi":         mutate(func(v *Summary) { v.Summary = "safe \u202egnp.exe" }),
		"url":          mutate(func(v *Summary) { v.Summary = "Open https://evil.example/x now" }),
		"domain":       mutate(func(v *Summary) { v.Summary = "Visit evil-login.com to continue" }),
		"email":        mutate(func(v *Summary) { v.Summary = "Mail root@example.org" }),
		"markdown":     mutate(func(v *Summary) { v.Summary = "[click](x)" }),
		"code":         mutate(func(v *Summary) { v.Summary = "run `rm -rf ~`" }),
		"html":         mutate(func(v *Summary) { v.Summary = "<img src=x onerror=alert(1)>" }),
	}
	for name, value := range cases {
		if _, _, err := SealSummary(key, "s", "o", "g", value); err == nil {
			t.Errorf("%s: sealed an invalid summary", name)
		}
	}
	if _, _, err := SealSummary(key, "", "o", "g", sampleSummary()); err == nil {
		t.Error("empty binding accepted")
	}
	if _, _, err := SealSummary("short", "s", "o", "g", sampleSummary()); err == nil {
		t.Error("bad recipient accepted")
	}
}

func sampleRequest(t *testing.T) Request {
	return Request{V: 1, Ticket: "st1.payload.signature", SessionID: "session", RecipientUID: "owner", Generation: "gen",
		ObservedAt: 1800000000000, RecipientPublicKey: encode(scalarKey(t, 9).PublicKey().Bytes()), Label: "npm run dev", Tail: "ready on port 3000\n\tok"}
}

func TestRequestRoundTripAndBinding(t *testing.T) {
	enclave := scalarKey(t, 5)
	enclaveKey := encode(enclave.PublicKey().Bytes())
	request := sampleRequest(t)
	sender, sealed, err := SealRequest(enclaveKey, request)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := openRequest(enclave, enclaveKey, sender, sealed)
	if err != nil || opened != request {
		t.Fatalf("round trip: %v %+v", err, opened)
	}
	other := encode(scalarKey(t, 6).PublicKey().Bytes())
	if _, err := openRequest(enclave, other, sender, sealed); err == nil {
		t.Error("request opened under a different enclave key binding")
	}
	for name, change := range map[string]func(*Request){
		"version": func(r *Request) { r.V = 0 },
		"ticket":  func(r *Request) { r.Ticket = "" },
		"tail":    func(r *Request) { r.Tail = "" },
		"big":     func(r *Request) { r.Tail = strings.Repeat("a", MaxTailBytes+1) },
		"control": func(r *Request) { r.Tail = "a\x1b[31mb" },
		"label":   func(r *Request) { r.Label = strings.Repeat("a", 121) },
		"key":     func(r *Request) { r.RecipientPublicKey = "nope" },
		"time":    func(r *Request) { r.ObservedAt = -1 },
	} {
		value := sampleRequest(t)
		change(&value)
		if _, _, err := SealRequest(enclaveKey, value); err == nil {
			t.Errorf("%s: invalid request sealed", name)
		}
	}
}
