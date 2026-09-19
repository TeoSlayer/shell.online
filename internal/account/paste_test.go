package account

import (
	"errors"
	"strings"
	"testing"
)

/*
 * --no-browser is for a machine with no browser on it. The person opens the
 * link on a computer that has one, and that browser is then sent to a loopback
 * address which on that computer means nothing: it stops on a page that will
 * not load, with the whole callback URL in the address bar. Before this there
 * was nothing to do with it, and the CLI waited five minutes for a callback
 * that could never arrive.
 */

const pasteState = "ZnPpMpqs_h354fGo6sALBoYOGXyZcfyH_dTWwIqpN1U"

func TestPastedCallbackAcceptsTheURLTheBrowserStoppedOn(t *testing.T) {
	line := "http://127.0.0.1:52284/callback?code=shc_abc123def456&state=" + pasteState

	result, err := pastedCallback(line, pasteState)

	if err != nil {
		t.Fatalf("pastedCallback: %v", err)
	}
	if result.code != "shc_abc123def456" {
		t.Errorf("code = %q", result.code)
	}
}

func TestPastedCallbackAcceptsABareCode(t *testing.T) {
	result, err := pastedCallback("  shc_abc123def456  ", pasteState)

	if err != nil {
		t.Fatalf("pastedCallback: %v", err)
	}
	if result.code != "shc_abc123def456" {
		t.Errorf("code = %q", result.code)
	}
}

// The state is the only thing tying a pasted URL to this process, so a URL
// from some other sign-in is refused rather than exchanged.
func TestPastedCallbackRefusesAnotherSignIn(t *testing.T) {
	line := "http://127.0.0.1:52284/callback?code=shc_abc123def456&state=" + strings.Repeat("x", 43)

	if _, err := pastedCallback(line, pasteState); err == nil {
		t.Fatal("a URL from a different sign-in should be refused")
	}
}

func TestPastedCallbackCarriesTheAccountKeyAndDropsAnUnusableOne(t *testing.T) {
	base := "http://127.0.0.1:52284/callback?code=shc_abc&state=" + pasteState

	broken, err := pastedCallback(base+"&account_key=not-a-key", pasteState)
	if err != nil {
		t.Fatalf("pastedCallback: %v", err)
	}
	if broken.accountKey != "" {
		t.Errorf("an unusable key should be dropped, got %q", broken.accountKey)
	}
}

func TestPastedCallbackReportsARefusal(t *testing.T) {
	line := "http://127.0.0.1:52284/callback?error=access_denied&error_description=You+said+no"

	_, err := pastedCallback(line, pasteState)

	if err == nil || !strings.Contains(err.Error(), "You said no") {
		t.Fatalf("err = %v", err)
	}
}

// A blank line is somebody pressing return, which deserves no complaint.
func TestPastedCallbackTreatsABlankLineAsNothing(t *testing.T) {
	if _, err := pastedCallback("   ", pasteState); !errors.Is(err, errNothingPasted) {
		t.Fatalf("err = %v, want errNothingPasted", err)
	}
}

func TestPastedCallbackRefusesSomethingThatIsNeither(t *testing.T) {
	for _, line := range []string{
		"hello there",
		"http://127.0.0.1:52284/callback?state=" + pasteState,
		"sh",
	} {
		if _, err := pastedCallback(line, pasteState); err == nil {
			t.Errorf("%q should not be taken for a code", line)
		}
	}
}
