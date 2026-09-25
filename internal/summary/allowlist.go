package summary

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ReleaseAllowlistKeys are the Ed25519 public keys that may sign the enclave
// image allowlist (PROTOCOL.md §2). The private half is held offline by the
// release process, never by a deployed service.
//
// Empty until the release key ceremony: with no key, VerifyAllowlist fails
// closed and no terminal text is ever sent to a summarizer.
var ReleaseAllowlistKeys = []ed25519.PublicKey{}

// ErrNoReleaseKey means this build cannot verify any allowlist.
var ErrNoReleaseKey = errors.New("summaries: this build has no enclave allowlist release key; enclave summaries are disabled")

var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

const maxAllowlistChars = 16 << 10

type allowlistPayload struct {
	V        int      `json:"v"`
	Audience string   `json:"audience"`
	Serial   uint64   `json:"serial"`
	IssuedAt int64    `json:"issued_at"`
	NotAfter int64    `json:"not_after"`
	Digests  []string `json:"digests"`
}

// AllowlistVerifier checks signed allowlists and remembers the highest serial
// it has accepted, so a replayed older allowlist (one that still lists a
// withdrawn image) is refused for the rest of this process.
type AllowlistVerifier struct {
	Keys     []ed25519.PublicKey
	Audience string
	Now      func() time.Time

	mu            sync.Mutex
	highestSerial uint64
}

// NewAllowlistVerifier uses the keys compiled into this build.
func NewAllowlistVerifier(audience string) *AllowlistVerifier {
	return &AllowlistVerifier{Keys: ReleaseAllowlistKeys, Audience: audience, Now: time.Now}
}

// Verify returns the set of image digests a valid allowlist permits.
func (verifier *AllowlistVerifier) Verify(signed string) (map[string]bool, error) {
	if len(verifier.Keys) == 0 {
		return nil, ErrNoReleaseKey
	}
	if len(signed) == 0 || len(signed) > maxAllowlistChars {
		return nil, errors.New("allowlist: missing or oversized")
	}
	encodedPayload, encodedSignature, ok := strings.Cut(signed, ".")
	if !ok || strings.Contains(encodedSignature, ".") {
		return nil, errors.New("allowlist: malformed")
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(encodedSignature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return nil, errors.New("allowlist: malformed signature")
	}
	signedOK := false
	for _, key := range verifier.Keys {
		if len(key) == ed25519.PublicKeySize && ed25519.Verify(key, []byte(encodedPayload), signature) {
			signedOK = true
			break
		}
	}
	if !signedOK {
		return nil, errors.New("allowlist: signature does not verify")
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encodedPayload)
	if err != nil {
		return nil, errors.New("allowlist: malformed payload")
	}
	var payload allowlistPayload
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || decoder.More() {
		return nil, errors.New("allowlist: invalid payload")
	}
	now := verifier.now()
	switch {
	case payload.V != 1:
		return nil, errors.New("allowlist: unsupported version")
	case payload.Audience != verifier.Audience:
		return nil, errors.New("allowlist: audience mismatch")
	case payload.Serial == 0:
		return nil, errors.New("allowlist: missing serial")
	case payload.IssuedAt > now.Add(5*time.Minute).UnixMilli():
		return nil, errors.New("allowlist: issued in the future")
	case payload.NotAfter <= now.UnixMilli():
		return nil, errors.New("allowlist: expired")
	case len(payload.Digests) == 0 || len(payload.Digests) > 64:
		return nil, errors.New("allowlist: no digests")
	}
	digests := make(map[string]bool, len(payload.Digests))
	for _, digest := range payload.Digests {
		if !digestPattern.MatchString(digest) {
			return nil, fmt.Errorf("allowlist: malformed digest")
		}
		digests[digest] = true
	}
	verifier.mu.Lock()
	defer verifier.mu.Unlock()
	if payload.Serial < verifier.highestSerial {
		return nil, errors.New("allowlist: older than one already accepted")
	}
	verifier.highestSerial = payload.Serial
	return digests, nil
}

func (verifier *AllowlistVerifier) now() time.Time {
	if verifier.Now != nil {
		return verifier.Now()
	}
	return time.Now()
}
