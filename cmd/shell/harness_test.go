package main

import (
	"errors"
	"os/exec"
	"reflect"
	"sort"
	"testing"
)

// lookup builds a stubbed PATH search that finds exactly the named commands.
func lookup(present ...string) func(string) (string, error) {
	found := make(map[string]bool, len(present))
	for _, command := range present {
		found[command] = true
	}
	return func(command string) (string, error) {
		if !found[command] {
			return "", exec.ErrNotFound
		}
		return "/usr/local/bin/" + command, nil
	}
}

func TestDetectHarnessesFindsNothingOnABareMachine(t *testing.T) {
	if got := detectHarnesses(lookup()); len(got) != 0 {
		t.Fatalf("detectHarnesses() = %v, want empty", got)
	}
}

func TestDetectHarnessesReportsOnlyWhatIsInstalled(t *testing.T) {
	got := detectHarnesses(lookup("claude", "hermes"))
	want := []string{"claude-code", "hermes"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("detectHarnesses() = %v, want %v", got, want)
	}
}

func TestDetectHarnessesReportsAllFour(t *testing.T) {
	got := detectHarnesses(lookup("claude", "codex", "hermes", "openclaw"))
	want := []string{"claude-code", "codex", "hermes", "openclaw"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("detectHarnesses() = %v, want %v", got, want)
	}
}

// A machine where every lookup succeeds still reports only the harnesses this
// build knows about, so the list the service receives cannot grow arbitrary
// entries from a PATH full of unrelated programs.
func TestDetectHarnessesIgnoresCommandsItDoesNotKnow(t *testing.T) {
	everything := func(command string) (string, error) { return "/usr/bin/" + command, nil }
	got := detectHarnesses(everything)
	want := []string{"claude-code", "codex", "hermes", "openclaw"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("detectHarnesses() = %v, want %v", got, want)
	}
}

func TestDetectHarnessesIsSortedAndStable(t *testing.T) {
	first := detectHarnesses(lookup("openclaw", "claude", "codex"))
	if !sort.StringsAreSorted(first) {
		t.Fatalf("detectHarnesses() = %v, want sorted", first)
	}
	// Map iteration order changes between runs, so repeat until an unsorted
	// implementation would have had many chances to show itself.
	for range 50 {
		if got := detectHarnesses(lookup("openclaw", "claude", "codex")); !reflect.DeepEqual(got, first) {
			t.Fatalf("detectHarnesses() = %v, want %v on every call", got, first)
		}
	}
}

// A lookup that resolves to an empty path found nothing, whatever it says
// about the error.
func TestDetectHarnessesIgnoresAnEmptyPath(t *testing.T) {
	blank := func(string) (string, error) { return "", nil }
	if got := detectHarnesses(blank); len(got) != 0 {
		t.Fatalf("detectHarnesses() = %v, want empty", got)
	}
	failing := func(string) (string, error) { return "/usr/bin/claude", errors.New("permission denied") }
	if got := detectHarnesses(failing); len(got) != 0 {
		t.Fatalf("detectHarnesses() = %v, want empty", got)
	}
}
