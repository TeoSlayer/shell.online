package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestDecideRemoteStartAsksWhenNothingIsKnown(t *testing.T) {
	grant, ask := decideRemoteStart(false, false, remoteStartFlags{}, true)
	if grant || !ask {
		t.Fatalf("first interactive login should ask, got grant=%v ask=%v", grant, ask)
	}
}

// The question is put once per account on this machine.
//
// Signing in again is not a consent decision, and a question re-put at every
// sign-in is one people learn to dismiss. The way back is the line printed
// after every login and the two flags it names, neither of which interrupts
// anybody.
func TestDecideRemoteStartDoesNotAskAgainOnceItHasBeenAnswered(t *testing.T) {
	grant, ask := decideRemoteStart(true, true, remoteStartFlags{}, true)
	if ask {
		t.Fatal("a settled machine should not be asked again")
	}
	if !grant {
		t.Fatal("the standing answer should carry forward")
	}
}

// Refusing is a decision too. Putting the same question at the next sign-in
// is how a prompt becomes something to click through.
func TestDecideRemoteStartRemembersARefusal(t *testing.T) {
	grant, ask := decideRemoteStart(false, true, remoteStartFlags{}, true)
	if ask {
		t.Fatal("a machine that refused should not be asked again")
	}
	if grant {
		t.Fatal("a refusal must not become a grant")
	}
}

// Credentials written before the question was recorded have no answer on file,
// only its effect. Asking once more is the right way round: it is one question
// on one login, and the alternative is holding somebody to a decision the file
// cannot prove they ever made.
func TestDecideRemoteStartAsksOnceMoreWhenNothingWasRecorded(t *testing.T) {
	if _, ask := decideRemoteStart(true, false, remoteStartFlags{}, true); !ask {
		t.Fatal("a machine with no recorded answer should be asked")
	}
}

func TestDecideRemoteStartHonoursFlagsWithoutAsking(t *testing.T) {
	if grant, ask := decideRemoteStart(false, false, remoteStartFlags{allow: true}, true); !grant || ask {
		t.Fatalf("--allow-remote-start should grant silently, got grant=%v ask=%v", grant, ask)
	}
	if grant, ask := decideRemoteStart(true, false, remoteStartFlags{deny: true}, true); grant || ask {
		t.Fatalf("--no-remote-start should withdraw silently, got grant=%v ask=%v", grant, ask)
	}
	/* And they are the way back once the question has been settled. */
	if grant, ask := decideRemoteStart(false, true, remoteStartFlags{allow: true}, true); !grant || ask {
		t.Fatalf("--allow-remote-start should still reverse a settled no, got grant=%v ask=%v", grant, ask)
	}
	if grant, ask := decideRemoteStart(true, true, remoteStartFlags{deny: true}, true); grant || ask {
		t.Fatalf("--no-remote-start should still reverse a settled yes, got grant=%v ask=%v", grant, ask)
	}
}

// A script has nobody to answer for. Defaulting to yes there would mean a
// machine provisioned by automation quietly accepts remote commands.
func TestDecideRemoteStartRefusesWithNobodyToAsk(t *testing.T) {
	grant, ask := decideRemoteStart(false, false, remoteStartFlags{}, false)
	if grant || ask {
		t.Fatalf("non-interactive login should default to no, got grant=%v ask=%v", grant, ask)
	}
}

// A machine that already agreed keeps working unattended, or every scripted
// deploy would silently turn its own daemon off.
func TestDecideRemoteStartKeepsAGrantWithoutATerminal(t *testing.T) {
	grant, ask := decideRemoteStart(true, false, remoteStartFlags{}, false)
	if !grant || ask {
		t.Fatalf("a granted machine should stay granted, got grant=%v ask=%v", grant, ask)
	}
}

// A scripted login decides nothing, so it must not close the question for the
// person who next sits down at this machine.
func TestASilentLoginDoesNotSettleTheQuestion(t *testing.T) {
	_, ask := decideRemoteStart(true, false, remoteStartFlags{}, false)
	if ask {
		t.Fatal("a non-interactive login cannot ask")
	}
	/* The next interactive login still does. */
	if _, ask := decideRemoteStart(true, false, remoteStartFlags{}, true); !ask {
		t.Fatal("the question survives a scripted login")
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

func TestRemoteStartSettledRecordsOnlyRealDecisions(t *testing.T) {
	cases := []struct {
		name         string
		alreadyAsked bool
		asked        bool
		flags        remoteStartFlags
		want         bool
	}{
		{"the question was put", false, true, remoteStartFlags{}, true},
		{"a flag answered it", false, false, remoteStartFlags{allow: true}, true},
		{"a flag withdrew it", false, false, remoteStartFlags{deny: true}, true},
		{"it was settled before", true, false, remoteStartFlags{}, true},
		{"a scripted login decided nothing", false, false, remoteStartFlags{}, false},
	}
	for _, test := range cases {
		if got := remoteStartSettled(test.alreadyAsked, test.asked, test.flags); got != test.want {
			t.Errorf("%s: settled = %v, want %v", test.name, got, test.want)
		}
	}
}

// Every branch of the note names the command that reverses it. That line is
// the only way back to the question now that it is put once, so a branch
// without one is a machine in a state nobody can find or change.
func TestRemoteStartNoteAlwaysSaysHowToChangeIt(t *testing.T) {
	cases := []struct {
		granted, asked bool
		expect         string
	}{
		{true, true, "--no-remote-start"},
		{true, false, "--no-remote-start"},
		{false, true, "--allow-remote-start"},
		{false, false, "--allow-remote-start"},
	}
	for _, test := range cases {
		var out bytes.Buffer
		printRemoteStartNote(&out, test.granted, test.asked)
		if !strings.Contains(out.String(), test.expect) {
			t.Errorf("granted=%v asked=%v: %q does not name %s",
				test.granted, test.asked, out.String(), test.expect)
		}
	}
}
