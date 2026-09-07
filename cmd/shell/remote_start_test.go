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

// Agreeing is remembered. Being asked every time trains people to say yes
// without reading, which is the opposite of consent.
func TestDecideRemoteStartNeverAsksAgainOnceGranted(t *testing.T) {
	grant, ask := decideRemoteStart(true, remoteStartFlags{}, true)
	if !grant || ask {
		t.Fatalf("a granted machine should not be asked again, got grant=%v ask=%v", grant, ask)
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
		if !askRemoteStart(strings.NewReader(answer), &output, "ana@example.com") {
			t.Fatalf("%q should have been taken as yes", answer)
		}
	}
	// Enter on its own is the common case of not reading the question.
	for _, answer := range []string{"\n", "n\n", "no\n", "sure\n", "ok\n", ""} {
		var output bytes.Buffer
		if askRemoteStart(strings.NewReader(answer), &output, "ana@example.com") {
			t.Fatalf("%q should not have been taken as yes", answer)
		}
	}
}

// The question has to say what is actually being agreed to. "Allow browser
// access?" would be true and useless.
func TestAskRemoteStartSaysWhatItGrants(t *testing.T) {
	var output bytes.Buffer
	askRemoteStart(strings.NewReader("n\n"), &output, "ana@example.com")
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
