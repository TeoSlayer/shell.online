package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestDecideRemoteStartAsksWhenNothingIsKnown(t *testing.T) {
	grant, ask := decideRemoteStart(false, remoteStartFlags{}, true)
	if grant || !ask {
		t.Fatalf("first interactive login should ask, got grant=%v ask=%v", grant, ask)
	}
}

// The question is put on every interactive login, including when the answer is
// already yes.
//
// It used to be asked once and never again, which left --allow-remote-start as
// the only way to reach a decision anyone had already made, and no way at all
// to find it if they had missed the question. The previous answer is the
// default, so agreeing again is one keystroke.
func TestDecideRemoteStartAsksAgainEvenOnceGranted(t *testing.T) {
	grant, ask := decideRemoteStart(true, remoteStartFlags{}, true)
	if !ask {
		t.Fatal("a machine that already agreed should still be asked")
	}
	if !grant {
		t.Fatal("the standing answer should be the default offered")
	}
}

// Refusing is not remembered. Someone who said no last month may well say yes
// today, and silently holding them to it would be worse than asking.
func TestDecideRemoteStartAsksAgainAfterARefusal(t *testing.T) {
	_, ask := decideRemoteStart(false, remoteStartFlags{}, true)
	if !ask {
		t.Fatal("a machine that refused before should be asked again")
	}
}

func TestDecideRemoteStartHonoursFlagsWithoutAsking(t *testing.T) {
	if grant, ask := decideRemoteStart(false, remoteStartFlags{allow: true}, true); !grant || ask {
		t.Fatalf("--allow-remote-start should grant silently, got grant=%v ask=%v", grant, ask)
	}
	if grant, ask := decideRemoteStart(true, remoteStartFlags{deny: true}, true); grant || ask {
		t.Fatalf("--no-remote-start should withdraw silently, got grant=%v ask=%v", grant, ask)
	}
}

// A script has nobody to answer for. Defaulting to yes there would mean a
// machine provisioned by automation quietly accepts remote commands.
func TestDecideRemoteStartRefusesWithNobodyToAsk(t *testing.T) {
	grant, ask := decideRemoteStart(false, remoteStartFlags{}, false)
	if grant || ask {
		t.Fatalf("non-interactive login should default to no, got grant=%v ask=%v", grant, ask)
	}
}

// A machine that already agreed keeps working unattended, or every scripted
// deploy would silently turn its own daemon off.
func TestDecideRemoteStartKeepsAGrantWithoutATerminal(t *testing.T) {
	grant, ask := decideRemoteStart(true, remoteStartFlags{}, false)
	if !grant || ask {
		t.Fatalf("a granted machine should stay granted, got grant=%v ask=%v", grant, ask)
	}
}

func TestAskRemoteStartAcceptsOnlyAnExplicitYes(t *testing.T) {
	for _, answer := range []string{"y\n", "Y\n", "yes\n", "YES\n", " y \n"} {
		var output bytes.Buffer
		if !askRemoteStart(strings.NewReader(answer), &output, "ana@example.com", false) {
			t.Fatalf("%q should have been taken as yes", answer)
		}
	}
	// Enter on its own is the common case of not reading the question.
	for _, answer := range []string{"\n", "n\n", "no\n", "sure\n", "ok\n", ""} {
		var output bytes.Buffer
		if askRemoteStart(strings.NewReader(answer), &output, "ana@example.com", false) {
			t.Fatalf("%q should not have been taken as yes", answer)
		}
	}
}

// The question has to say what is actually being agreed to. "Allow browser
// access?" would be true and useless.
func TestAskRemoteStartSaysWhatItGrants(t *testing.T) {
	var output bytes.Buffer
	askRemoteStart(strings.NewReader("n\n"), &output, "ana@example.com", false)
	text := output.String()
	for _, phrase := range []string{"ana@example.com", "start processes", "without touching this terminal"} {
		if !strings.Contains(text, phrase) {
			t.Fatalf("the prompt should mention %q, got:\n%s", phrase, text)
		}
	}
}

func TestWantsDaemonRunning(t *testing.T) {
	for _, command := range []string{"list", "attach", "kill", "sleep"} {
		if !wantsDaemonRunning([]string{command}) {
			t.Fatalf("%q should bring the daemon up", command)
		}
	}
	// These decide the daemon's own fate, or are it.
	for _, command := range []string{"daemon", "login", "logout", "agent", "help", "--version"} {
		if wantsDaemonRunning([]string{command}) {
			t.Fatalf("%q should not bring the daemon up", command)
		}
	}
	if wantsDaemonRunning(nil) {
		t.Fatal("no arguments should not bring the daemon up")
	}
}

// Enter keeps whatever is already true, in both directions.
//
// A machine that has never agreed must not be granted by somebody pressing
// enter without reading, and a machine that has agreed must not lose it the
// same way. That is the whole reason the default follows the current answer
// rather than being fixed.
func TestAskRemoteStartTreatsEnterAsLeaveItAlone(t *testing.T) {
	for _, current := range []bool{false, true} {
		var output bytes.Buffer
		if got := askRemoteStart(strings.NewReader("\n"), &output, "ana@example.com", current); got != current {
			t.Fatalf("enter with current=%v returned %v; it should change nothing", current, got)
		}
	}
}

// The prompt shows which way enter will go.
func TestAskRemoteStartShowsTheStandingAnswerAsTheDefault(t *testing.T) {
	var granted, fresh bytes.Buffer
	askRemoteStart(strings.NewReader("\n"), &granted, "ana@example.com", true)
	askRemoteStart(strings.NewReader("\n"), &fresh, "ana@example.com", false)
	if !strings.Contains(granted.String(), "[Y/n]") {
		t.Fatalf("a machine that agreed should offer [Y/n], got: %s", granted.String())
	}
	if !strings.Contains(fresh.String(), "[y/N]") {
		t.Fatalf("a machine that has not agreed should offer [y/N], got: %s", fresh.String())
	}
}
