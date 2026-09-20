//go:build !windows

package main

import "testing"

/**
 * What a login shell prints, and how much of it is the answer.
 *
 * Unix only, because the probe is: Windows has no login shell whose rc files
 * decide where tools live, so nothing there ever produces this output. The
 * tests moved here when they failed on Windows for a reason that had nothing
 * to do with them.
 */
func TestPathBetweenMarkersIgnoresWhateverElseTheShellPrinted(t *testing.T) {
	/*
	 * An interactive shell prints the message of the day, a version manager
	 * announcing itself, whatever somebody put in their rc file. Reading "the
	 * last line" would pick up any of it.
	 */
	output := "Welcome to zsh!\nnvm: now using node v22\n" +
		pathMarkerStart + "/home/ada/.local/bin:/usr/bin" + pathMarkerEnd + "\n"
	if got := pathBetweenMarkers(output); got != "/home/ada/.local/bin:/usr/bin" {
		t.Fatalf("got %q", got)
	}
}

func TestPathBetweenMarkersSaysNothingWhenItWasNotPrinted(t *testing.T) {
	if got := pathBetweenMarkers("command not found: printf\n"); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestPathBetweenMarkersReadsAFishList(t *testing.T) {
	/*
	 * fish holds PATH as a list and prints it space-separated. Read as a PATH
	 * that is one directory with spaces in its name, and a fish user gets the
	 * conventional directories and nothing else.
	 */
	output := pathMarkerStart + "/usr/bin /bin /opt/homebrew/bin" + pathMarkerEnd
	if got := pathBetweenMarkers(output); got != "/usr/bin:/bin:/opt/homebrew/bin" {
		t.Fatalf("got %q", got)
	}
}

func TestPathBetweenMarkersLeavesADirectoryWithASpaceAlone(t *testing.T) {
	/* Unusual, legal, and not a list: there is a separator in it. */
	output := pathMarkerStart + "/usr/bin:/Users/ada/Application Support/bin" + pathMarkerEnd
	if got := pathBetweenMarkers(output); got != "/usr/bin:/Users/ada/Application Support/bin" {
		t.Fatalf("got %q", got)
	}
}
