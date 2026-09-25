package summary

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Attestation verification (PROTOCOL.md §1). The host sends terminal text to
// an enclave only after proving, from a Google-signed Confidential Space
// token, that the enclave is a production (non-debug) TDX workload running an
// allowlisted image, and that the public key it offered was generated inside
// that workload.

const (
	// GoogleIssuer is the Confidential Space attestation token issuer.
	GoogleIssuer = "https://confidentialcomputing.googleapis.com"
	// GoogleDiscoveryURL is where the issuer's signing keys are published.
	GoogleDiscoveryURL = GoogleIssuer + "/.well-known/openid-configuration"
	// DefaultAudience is the audience the summarizer requests tokens for.
	DefaultAudience = "https://summarizer.shell.online"

	keyNoncePrefix   = "sk1."
	maxTokenChars    = 16 << 10
	maxDiscoveryBody = 64 << 10
	maxJWKSBody      = 256 << 10
	clockSkew        = 60 * time.Second
	jwksRefetchFloor = time.Minute
	jwksMaxAge       = 6 * time.Hour
)

// Identity is the enclave's GET /v1/identity response.
type Identity struct {
	V         int    `json:"v"`
	PublicKey string `json:"public_key"`
	Token     string `json:"token"`
	Allowlist string `json:"allowlist"`
}

// VerifiedEnclave is an enclave key the host may seal requests to until
// ExpiresAt (the attestation token's expiry).
type VerifiedEnclave struct {
	PublicKey   string
	ImageDigest string
	ExpiresAt   time.Time
}

// Verifier checks enclave identities. It is safe for concurrent use.
type Verifier struct {
	Audience     string
	Issuer       string
	DiscoveryURL string
	HTTP         *http.Client
	Now          func() time.Time
	Allowlist    *AllowlistVerifier

	mu          sync.Mutex
	keys        map[string]*rsa.PublicKey
	fetchedAt   time.Time
	lastAttempt time.Time
}

// NewVerifier returns a verifier for the production issuer and the release
// allowlist keys compiled into this build.
func NewVerifier(audience string) *Verifier {
	return &Verifier{
		Audience:     audience,
		Issuer:       GoogleIssuer,
		DiscoveryURL: GoogleDiscoveryURL,
		HTTP:         &http.Client{Timeout: 10 * time.Second, CheckRedirect: httpsRedirectsOnly},
		Now:          time.Now,
		Allowlist:    NewAllowlistVerifier(audience),
	}
}

// httpsRedirectsOnly lets the issuer move its documents but never off HTTPS.
func httpsRedirectsOnly(request *http.Request, via []*http.Request) error {
	if request.URL.Scheme != "https" || len(via) >= 5 {
		return errors.New("refusing redirect")
	}
	return nil
}

func (verifier *Verifier) now() time.Time {
	if verifier.Now != nil {
		return verifier.Now()
	}
	return time.Now()
}

// KeyNonce is the eat_nonce that binds an enclave public key to its token.
func KeyNonce(publicKey string) string {
	raw, _ := base64.RawURLEncoding.Strict().DecodeString(publicKey)
	digest := sha256.Sum256(raw)
	return keyNoncePrefix + base64.RawURLEncoding.EncodeToString(digest[:])
}

type tokenHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	Typ string `json:"typ"`
}

type tokenClaims struct {
	Iss      string          `json:"iss"`
	Aud      json.RawMessage `json:"aud"`
	Exp      *json.Number    `json:"exp"`
	Iat      *json.Number    `json:"iat"`
	Nbf      *json.Number    `json:"nbf"`
	Swname   string          `json:"swname"`
	Hwmodel  string          `json:"hwmodel"`
	Dbgstat  string          `json:"dbgstat"`
	EatNonce json.RawMessage `json:"eat_nonce"`
	Submods  struct {
		Container struct {
			ImageDigest string `json:"image_digest"`
		} `json:"container"`
		ConfidentialSpace struct {
			SupportAttributes []string `json:"support_attributes"`
		} `json:"confidential_space"`
	} `json:"submods"`
}

// Verify checks every PROTOCOL.md §1 condition. Any failure returns an error
// and the host must not send anything to this enclave.
func (verifier *Verifier) Verify(ctx context.Context, identity Identity) (*VerifiedEnclave, error) {
	if identity.V != 1 {
		return nil, errors.New("attestation: unsupported identity version")
	}
	if _, err := decodePublicKey(identity.PublicKey); err != nil {
		return nil, fmt.Errorf("attestation: enclave key: %w", err)
	}
	if verifier.Allowlist == nil {
		return nil, ErrNoReleaseKey
	}
	digests, err := verifier.Allowlist.Verify(identity.Allowlist)
	if err != nil {
		return nil, err
	}
	claims, err := verifier.verifyToken(ctx, identity.Token)
	if err != nil {
		return nil, err
	}
	now := verifier.now()
	exp, err := numericTime(claims.Exp)
	if err != nil {
		return nil, errors.New("attestation: token has no valid exp")
	}
	iat, err := numericTime(claims.Iat)
	if err != nil {
		return nil, errors.New("attestation: token has no valid iat")
	}
	switch {
	case claims.Iss != verifier.issuer():
		return nil, errors.New("attestation: wrong issuer")
	case !audienceMatches(claims.Aud, verifier.Audience):
		return nil, errors.New("attestation: wrong audience")
	case !now.Before(exp):
		return nil, errors.New("attestation: token expired")
	case iat.After(now.Add(clockSkew)):
		return nil, errors.New("attestation: token issued in the future")
	case claims.Swname != "CONFIDENTIAL_SPACE":
		return nil, errors.New("attestation: not a Confidential Space workload")
	case claims.Hwmodel != "INTEL_TDX":
		return nil, errors.New("attestation: not Intel TDX hardware")
	case claims.Dbgstat != "disabled-since-boot":
		return nil, errors.New("attestation: debugging is not disabled")
	case !contains(claims.Submods.ConfidentialSpace.SupportAttributes, "STABLE"):
		return nil, errors.New("attestation: not a production (STABLE) Confidential Space image")
	case !digests[claims.Submods.Container.ImageDigest]:
		return nil, errors.New("attestation: container image is not allowlisted")
	case !nonceMatches(claims.EatNonce, KeyNonce(identity.PublicKey)):
		return nil, errors.New("attestation: enclave key is not bound to the token")
	}
	if claims.Nbf != nil {
		nbf, err := numericTime(claims.Nbf)
		if err != nil || nbf.After(now.Add(clockSkew)) {
			return nil, errors.New("attestation: token not yet valid")
		}
	}
	return &VerifiedEnclave{
		PublicKey:   identity.PublicKey,
		ImageDigest: claims.Submods.Container.ImageDigest,
		ExpiresAt:   exp,
	}, nil
}

func (verifier *Verifier) issuer() string {
	if verifier.Issuer != "" {
		return verifier.Issuer
	}
	return GoogleIssuer
}

func (verifier *Verifier) verifyToken(ctx context.Context, token string) (*tokenClaims, error) {
	if len(token) == 0 || len(token) > maxTokenChars {
		return nil, errors.New("attestation: missing or oversized token")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("attestation: malformed token")
	}
	var header tokenHeader
	if err := decodeSegment(parts[0], &header); err != nil {
		return nil, errors.New("attestation: malformed token header")
	}
	// Only RS256 is accepted: never "none", never HMAC, never whatever the token asks for.
	if header.Alg != "RS256" || header.Kid == "" {
		return nil, errors.New("attestation: token must be RS256 with a key id")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) == 0 {
		return nil, errors.New("attestation: malformed token signature")
	}
	key, err := verifier.signingKey(ctx, header.Kid)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature); err != nil {
		return nil, errors.New("attestation: token signature does not verify")
	}
	var claims tokenClaims
	if err := decodeSegment(parts[1], &claims); err != nil {
		return nil, errors.New("attestation: malformed token claims")
	}
	return &claims, nil
}

func decodeSegment(segment string, into any) error {
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decoder.Decode(into)
}

func numericTime(value *json.Number) (time.Time, error) {
	if value == nil {
		return time.Time{}, errors.New("missing")
	}
	seconds, err := value.Float64()
	if err != nil || seconds <= 0 || seconds > 1e11 {
		return time.Time{}, errors.New("invalid")
	}
	return time.UnixMilli(int64(seconds * 1000)), nil
}

func audienceMatches(raw json.RawMessage, audience string) bool {
	var single string
	if json.Unmarshal(raw, &single) == nil {
		return single == audience
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		return len(many) == 1 && many[0] == audience
	}
	return false
}

func nonceMatches(raw json.RawMessage, want string) bool {
	var single string
	if json.Unmarshal(raw, &single) == nil {
		return single == want
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		return contains(many, want)
	}
	return false
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// signingKey returns the issuer key for kid, refreshing the key set when it is
// stale or the kid is unknown (key rotation), at most once a minute.
func (verifier *Verifier) signingKey(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	verifier.mu.Lock()
	defer verifier.mu.Unlock()
	now := verifier.now()
	key, known := verifier.keys[kid]
	fresh := now.Sub(verifier.fetchedAt) < jwksMaxAge
	if known && fresh {
		return key, nil
	}
	if now.Sub(verifier.lastAttempt) >= jwksRefetchFloor || verifier.keys == nil {
		verifier.lastAttempt = now
		keys, err := verifier.fetchKeys(ctx)
		if err != nil {
			return nil, err
		}
		verifier.keys = keys
		verifier.fetchedAt = now
		key, known = keys[kid]
	}
	if !known {
		return nil, errors.New("attestation: token signed by an unknown key")
	}
	return key, nil
}

func (verifier *Verifier) fetchKeys(ctx context.Context) (map[string]*rsa.PublicKey, error) {
	var discovery struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := verifier.getJSON(ctx, verifier.DiscoveryURL, maxDiscoveryBody, &discovery); err != nil {
		return nil, fmt.Errorf("attestation: discovery: %w", err)
	}
	if discovery.Issuer != verifier.issuer() {
		return nil, errors.New("attestation: discovery issuer mismatch")
	}
	var set struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			Alg string `json:"alg"`
			Use string `json:"use"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := verifier.getJSON(ctx, discovery.JWKSURI, maxJWKSBody, &set); err != nil {
		return nil, fmt.Errorf("attestation: signing keys: %w", err)
	}
	keys := map[string]*rsa.PublicKey{}
	for _, entry := range set.Keys {
		if entry.Kty != "RSA" || entry.Kid == "" || (entry.Alg != "" && entry.Alg != "RS256") || (entry.Use != "" && entry.Use != "sig") {
			continue
		}
		n, errN := base64.RawURLEncoding.DecodeString(entry.N)
		e, errE := base64.RawURLEncoding.DecodeString(entry.E)
		if errN != nil || errE != nil || len(e) == 0 || len(e) > 4 {
			continue
		}
		modulus := new(big.Int).SetBytes(n)
		exponent := int(new(big.Int).SetBytes(e).Int64())
		if modulus.BitLen() < 2048 || exponent < 3 || exponent%2 == 0 {
			continue
		}
		keys[entry.Kid] = &rsa.PublicKey{N: modulus, E: exponent}
	}
	if len(keys) == 0 {
		return nil, errors.New("attestation: issuer published no usable keys")
	}
	return keys, nil
}

func (verifier *Verifier) getJSON(ctx context.Context, address string, limit int64, into any) error {
	parsed, err := url.Parse(address)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return errors.New("URL must be HTTPS")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	client := verifier.HTTP
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return err
	}
	if int64(len(body)) > limit {
		return errors.New("response too large")
	}
	return json.Unmarshal(body, into)
}
