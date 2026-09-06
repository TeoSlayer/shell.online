package account

import (
	"regexp"
	"testing"
)

var base64URLPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func TestNewVerifierIsUnreservedAndLongEnough(t *testing.T) {
	verifier, err := NewVerifier()
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	// RFC 7636 requires 43 to 128 unreserved characters.
	if len(verifier) < 43 || len(verifier) > 128 {
		t.Fatalf("verifier length %d outside the RFC 7636 range", len(verifier))
	}
	if !base64URLPattern.MatchString(verifier) {
		t.Fatalf("verifier %q contains reserved characters", verifier)
	}
}

func TestNewVerifierDoesNotRepeat(t *testing.T) {
	seen := make(map[string]struct{}, 500)
	for i := 0; i < 500; i++ {
		verifier, err := NewVerifier()
		if err != nil {
			t.Fatalf("NewVerifier: %v", err)
		}
		if _, exists := seen[verifier]; exists {
			t.Fatalf("NewVerifier repeated %q", verifier)
		}
		seen[verifier] = struct{}{}
	}
}

func TestNewStateDoesNotRepeat(t *testing.T) {
	seen := make(map[string]struct{}, 500)
	for i := 0; i < 500; i++ {
		state, err := NewState()
		if err != nil {
			t.Fatalf("NewState: %v", err)
		}
		if _, exists := seen[state]; exists {
			t.Fatalf("NewState repeated %q", state)
		}
		seen[state] = struct{}{}
	}
}

func TestChallengeMatchesRFC7636TestVector(t *testing.T) {
	// Verifier and challenge are given verbatim in RFC 7636 appendix B.
	const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	const want = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
	if got := Challenge(verifier); got != want {
		t.Fatalf("Challenge = %q, want %q", got, want)
	}
}

func TestChallengeIsDeterministicAndUnpadded(t *testing.T) {
	verifier, err := NewVerifier()
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	first := Challenge(verifier)
	if first != Challenge(verifier) {
		t.Fatal("Challenge is not deterministic")
	}
	if len(first) != 43 {
		t.Fatalf("challenge length = %d, want 43", len(first))
	}
	if !base64URLPattern.MatchString(first) {
		t.Fatalf("challenge %q is not raw base64url", first)
	}
}

func TestSameState(t *testing.T) {
	tests := []struct {
		name             string
		expected, actual string
		want             bool
	}{
		{"identical", "abcdef", "abcdef", true},
		{"different value", "abcdef", "abcdeg", false},
		{"different length", "abcdef", "abcde", false},
		{"actual empty", "abcdef", "", false},
		{"expected empty", "", "abcdef", false},
		{"both empty is not a match", "", "", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := SameState(test.expected, test.actual); got != test.want {
				t.Fatalf("SameState(%q, %q) = %v, want %v",
					test.expected, test.actual, got, test.want)
			}
		})
	}
}
