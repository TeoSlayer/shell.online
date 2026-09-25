package summary

import (
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var testNow = time.UnixMilli(1800000000000)

const testDigest = "sha256:" + "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12"

type allowlistSigner struct {
	public  ed25519.PublicKey
	private ed25519.PrivateKey
}

func newAllowlistSigner(t *testing.T) allowlistSigner {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return allowlistSigner{public, private}
}

func (signer allowlistSigner) sign(payload map[string]any) string {
	raw, _ := json.Marshal(payload)
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	return encoded + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(signer.private, []byte(encoded)))
}

func allowlistPayloadFor(serial int) map[string]any {
	return map[string]any{"v": 1, "audience": DefaultAudience, "serial": serial,
		"issued_at": testNow.Add(-time.Hour).UnixMilli(), "not_after": testNow.Add(24 * time.Hour).UnixMilli(),
		"digests": []string{testDigest}}
}

func TestAllowlist(t *testing.T) {
	signer := newAllowlistSigner(t)
	verifier := &AllowlistVerifier{Keys: []ed25519.PublicKey{signer.public}, Audience: DefaultAudience, Now: func() time.Time { return testNow }}
	digests, err := verifier.Verify(signer.sign(allowlistPayloadFor(5)))
	if err != nil || !digests[testDigest] {
		t.Fatalf("valid allowlist refused: %v", err)
	}
	if _, err := verifier.Verify(signer.sign(allowlistPayloadFor(4))); err == nil {
		t.Error("rollback to an older serial accepted")
	}
	if _, err := verifier.Verify(signer.sign(allowlistPayloadFor(5))); err != nil {
		t.Errorf("same serial refused: %v", err)
	}
	mutate := func(change func(map[string]any)) string {
		payload := allowlistPayloadFor(9)
		change(payload)
		return signer.sign(payload)
	}
	other := newAllowlistSigner(t)
	bad := map[string]string{
		"wrong key":  other.sign(allowlistPayloadFor(9)),
		"expired":    mutate(func(p map[string]any) { p["not_after"] = testNow.UnixMilli() }),
		"future":     mutate(func(p map[string]any) { p["issued_at"] = testNow.Add(time.Hour).UnixMilli() }),
		"audience":   mutate(func(p map[string]any) { p["audience"] = "https://elsewhere" }),
		"version":    mutate(func(p map[string]any) { p["v"] = 2 }),
		"no serial":  mutate(func(p map[string]any) { p["serial"] = 0 }),
		"digest":     mutate(func(p map[string]any) { p["digests"] = []string{"sha256:XYZ"} }),
		"no digests": mutate(func(p map[string]any) { p["digests"] = []string{} }),
		"unknown":    mutate(func(p map[string]any) { p["extra"] = true }),
		"malformed":  "not-an-allowlist",
		"tampered":   strings.Replace(signer.sign(allowlistPayloadFor(9)), "e", "f", 1),
	}
	for name, signed := range bad {
		if _, err := verifier.Verify(signed); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	empty := &AllowlistVerifier{Audience: DefaultAudience}
	if _, err := empty.Verify(signer.sign(allowlistPayloadFor(1))); !errors.Is(err, ErrNoReleaseKey) {
		t.Errorf("no release key must fail closed, got %v", err)
	}
	if len(ReleaseAllowlistKeys) != 0 {
		t.Log("release allowlist keys are configured in this build")
	}
}

// issuer is a local stand-in for Google's attestation issuer: discovery
// document, JWKS and token minting.
type issuer struct {
	server   *httptest.Server
	key      *rsa.PrivateKey
	kid      string
	fetches  atomic.Int32
	signer   allowlistSigner
	verifier *Verifier
}

func newIssuer(t *testing.T) *issuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	fake := &issuer{key: key, kid: "test-kid", signer: newAllowlistSigner(t)}
	mux := http.NewServeMux()
	fake.server = httptest.NewTLSServer(mux)
	t.Cleanup(fake.server.Close)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"issuer": GoogleIssuer, "jwks_uri": fake.server.URL + "/jwks"})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		fake.fetches.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "kid": fake.kid, "alg": "RS256", "use": "sig",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	})
	fake.verifier = &Verifier{
		Audience:     DefaultAudience,
		Issuer:       GoogleIssuer,
		DiscoveryURL: fake.server.URL + "/.well-known/openid-configuration",
		HTTP:         fake.server.Client(),
		Now:          func() time.Time { return testNow },
		Allowlist:    &AllowlistVerifier{Keys: []ed25519.PublicKey{fake.signer.public}, Audience: DefaultAudience, Now: func() time.Time { return testNow }},
	}
	return fake
}

func (fake *issuer) claims(enclaveKey string) map[string]any {
	return map[string]any{
		"iss": GoogleIssuer, "aud": DefaultAudience,
		"iat": testNow.Add(-time.Minute).Unix(), "nbf": testNow.Add(-time.Minute).Unix(), "exp": testNow.Add(time.Hour).Unix(),
		"swname": "CONFIDENTIAL_SPACE", "hwmodel": "INTEL_TDX", "dbgstat": "disabled-since-boot",
		"eat_nonce": []string{KeyNonce(enclaveKey)},
		"submods": map[string]any{
			"container":          map[string]any{"image_digest": testDigest},
			"confidential_space": map[string]any{"support_attributes": []string{"LATEST", "STABLE", "USABLE"}},
		},
	}
}

func (fake *issuer) mint(header, claims map[string]any) string {
	encodedHeader, _ := json.Marshal(header)
	encodedClaims, _ := json.Marshal(claims)
	signingInput := base64.RawURLEncoding.EncodeToString(encodedHeader) + "." + base64.RawURLEncoding.EncodeToString(encodedClaims)
	digest := sha256.Sum256([]byte(signingInput))
	signature, _ := rsa.SignPKCS1v15(rand.Reader, fake.key, crypto.SHA256, digest[:])
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func (fake *issuer) identity(enclaveKey string, change func(header, claims map[string]any)) Identity {
	header := map[string]any{"alg": "RS256", "kid": fake.kid, "typ": "JWT"}
	claims := fake.claims(enclaveKey)
	if change != nil {
		change(header, claims)
	}
	return Identity{V: 1, PublicKey: enclaveKey, Token: fake.mint(header, claims), Allowlist: fake.signer.sign(allowlistPayloadFor(1))}
}

func TestVerifierAcceptsAValidEnclave(t *testing.T) {
	fake := newIssuer(t)
	enclaveKey := encode(scalarKey(t, 11).PublicKey().Bytes())
	verified, err := fake.verifier.Verify(context.Background(), fake.identity(enclaveKey, nil))
	if err != nil {
		t.Fatal(err)
	}
	if verified.PublicKey != enclaveKey || verified.ImageDigest != testDigest || !verified.ExpiresAt.Equal(time.Unix(testNow.Add(time.Hour).Unix(), 0)) {
		t.Fatalf("unexpected result %+v", verified)
	}
	// A string nonce and a single-element audience array are also valid encodings.
	if _, err := fake.verifier.Verify(context.Background(), fake.identity(enclaveKey, func(_, c map[string]any) {
		c["eat_nonce"] = KeyNonce(enclaveKey)
		c["aud"] = []string{DefaultAudience}
	})); err != nil {
		t.Fatalf("alternate encodings: %v", err)
	}
	if fake.fetches.Load() != 1 {
		t.Errorf("JWKS fetched %d times, want 1 (cached)", fake.fetches.Load())
	}
}

func TestVerifierRejections(t *testing.T) {
	fake := newIssuer(t)
	enclaveKey := encode(scalarKey(t, 12).PublicKey().Bytes())
	otherKey := encode(scalarKey(t, 13).PublicKey().Bytes())
	cases := map[string]func(h, c map[string]any){
		"issuer":         func(_, c map[string]any) { c["iss"] = "https://accounts.google.com" },
		"audience":       func(_, c map[string]any) { c["aud"] = "https://elsewhere" },
		"multi audience": func(_, c map[string]any) { c["aud"] = []string{DefaultAudience, "x"} },
		"expired":        func(_, c map[string]any) { c["exp"] = testNow.Add(-time.Second).Unix() },
		"no exp":         func(_, c map[string]any) { delete(c, "exp") },
		"future iat":     func(_, c map[string]any) { c["iat"] = testNow.Add(10 * time.Minute).Unix() },
		"future nbf":     func(_, c map[string]any) { c["nbf"] = testNow.Add(10 * time.Minute).Unix() },
		"debug image":    func(_, c map[string]any) { c["dbgstat"] = "enabled" },
		"not stable": func(_, c map[string]any) {
			c["submods"].(map[string]any)["confidential_space"] = map[string]any{"support_attributes": []string{"LATEST"}}
		},
		"sev hardware":   func(_, c map[string]any) { c["hwmodel"] = "GCP_AMD_SEV" },
		"not cs":         func(_, c map[string]any) { c["swname"] = "GCE" },
		"digest":         func(_, c map[string]any) { c["submods"].(map[string]any)["container"] = map[string]any{"image_digest": "sha256:" + strings.Repeat("0", 64)} },
		"nonce mismatch": func(_, c map[string]any) { c["eat_nonce"] = []string{KeyNonce(otherKey)} },
		"no nonce":       func(_, c map[string]any) { delete(c, "eat_nonce") },
		"alg none":       func(h, _ map[string]any) { h["alg"] = "none" },
		"alg hs256":      func(h, _ map[string]any) { h["alg"] = "HS256" },
		"unknown kid":    func(h, _ map[string]any) { h["kid"] = "rotated-away" },
		"no kid":         func(h, _ map[string]any) { delete(h, "kid") },
	}
	for name, change := range cases {
		if _, err := fake.verifier.Verify(context.Background(), fake.identity(enclaveKey, change)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}

	valid := fake.identity(enclaveKey, nil)
	structural := map[string]Identity{
		"version":        {V: 2, PublicKey: valid.PublicKey, Token: valid.Token, Allowlist: valid.Allowlist},
		"swapped key":    {V: 1, PublicKey: otherKey, Token: valid.Token, Allowlist: valid.Allowlist},
		"bad key":        {V: 1, PublicKey: "x", Token: valid.Token, Allowlist: valid.Allowlist},
		"no allowlist":   {V: 1, PublicKey: valid.PublicKey, Token: valid.Token},
		"tampered token": {V: 1, PublicKey: valid.PublicKey, Token: tamperClaims(valid.Token), Allowlist: valid.Allowlist},
		"unsigned token": {V: 1, PublicKey: valid.PublicKey, Token: strings.Join(strings.Split(valid.Token, ".")[:2], ".") + ".", Allowlist: valid.Allowlist},
		"garbage token":  {V: 1, PublicKey: valid.PublicKey, Token: "a.b", Allowlist: valid.Allowlist},
	}
	for name, identity := range structural {
		if _, err := fake.verifier.Verify(context.Background(), identity); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}

	insecure := &Verifier{
		Audience: DefaultAudience, Issuer: GoogleIssuer, HTTP: fake.server.Client(), Now: fake.verifier.Now, Allowlist: fake.verifier.Allowlist,
		DiscoveryURL: strings.Replace(fake.server.URL, "https://", "http://", 1) + "/.well-known/openid-configuration",
	}
	if _, err := insecure.Verify(context.Background(), valid); err == nil {
		t.Error("plain HTTP discovery accepted")
	}
}

// tamperClaims flips the debug status in an otherwise validly signed token.
func tamperClaims(token string) string {
	parts := strings.Split(token, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	raw = []byte(strings.Replace(string(raw), "disabled-since-boot", "enabled", 1))
	parts[1] = base64.RawURLEncoding.EncodeToString(raw)
	return strings.Join(parts, ".")
}

func TestVerifierRefetchesKeysOnRotationAtMostOnceAMinute(t *testing.T) {
	fake := newIssuer(t)
	enclaveKey := encode(scalarKey(t, 14).PublicKey().Bytes())
	if _, err := fake.verifier.Verify(context.Background(), fake.identity(enclaveKey, nil)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		_, _ = fake.verifier.Verify(context.Background(), fake.identity(enclaveKey, func(h, _ map[string]any) { h["kid"] = "new" }))
	}
	if got := fake.fetches.Load(); got != 1 {
		t.Errorf("unknown kid refetched %d times within a minute", got)
	}
}
