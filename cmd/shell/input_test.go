package main

import (
	"strings"
	"testing"
)

func TestWantsPasteReader(t *testing.T) {
	cases := []struct {
		name                   string
		noBrowser, interactive bool
		want                   bool
	}{
		{"somebody at a terminal", false, true, true},
		/*
		 * The one that shipped broken in 0.18.0: --no-browser is for a machine
		 * whose browser is elsewhere, so the paste is the only way that login
		 * ends. Requiring a terminal turned it off for a piped callback, and
		 * for anyone who redirected standard error to a log.
		 */
		{"--no-browser with no terminal", true, false, true},
		{"--no-browser at a terminal", true, true, true},
		/* Nothing to paste and nothing to ask: leave the caller's input alone. */
		{"a scripted login", false, false, false},
	}
	for _, test := range cases {
		if got := wantsPasteReader(test.noBrowser, test.interactive); got != test.want {
			t.Errorf("%s: wantsPasteReader(%v, %v) = %v, want %v",
				test.name, test.noBrowser, test.interactive, got, test.want)
		}
	}
}

func TestTerminalLinesHandsOutOneLineAtATime(t *testing.T) {
	lines := terminalLines(strings.NewReader("first\nsecond\n"))

	if got := <-lines; got != "first" {
		t.Fatalf("first line = %q", got)
	}
	if got := <-lines; got != "second" {
		t.Fatalf("second line = %q", got)
	}
	if _, open := <-lines; open {
		t.Fatal("the channel should close when the input ends")
	}
}
