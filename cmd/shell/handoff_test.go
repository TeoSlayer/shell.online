package main

import (
	"reflect"
	"testing"
)

const (
	testClaudeSessionID   = "123e4567-e89b-12d3-a456-426614174000"
	testOpencodeSessionID = "ses_f457b8b67ffemBlZSIoVLVW7Xh"
)

func TestPrepareCommandLaunchForksCurrentClaudeConversation(t *testing.T) {
	launch := prepareCommandLaunch([]string{"claude"}, []string{
		"CLAUDECODE=1",
		"CLAUDE_CODE_CHILD_SESSION=1",
		"CLAUDE_CODE_SESSION_ID=" + testClaudeSessionID,
		"CLAUDE_CODE_BRIDGE_SESSION_ID=session_secret",
		"KEEP_ME=yes",
	}, true)

	wantArguments := []string{"claude", "--resume", testClaudeSessionID, "--fork-session"}
	if !reflect.DeepEqual(launch.Arguments, wantArguments) {
		t.Fatalf("arguments = %#v, want %#v", launch.Arguments, wantArguments)
	}
	if !reflect.DeepEqual(launch.DisplayArguments, []string{"claude"}) {
		t.Fatalf("display arguments = %#v", launch.DisplayArguments)
	}
	if launch.Handoff != claudeConversationHandoff {
		t.Fatalf("handoff = %q", launch.Handoff)
	}
	if launch.HandoffDisplay != "Claude conversation" {
		t.Fatalf("handoff display = %q", launch.HandoffDisplay)
	}
	if got := environmentValue(launch.Environment, "KEEP_ME"); got != "yes" {
		t.Fatalf("KEEP_ME = %q", got)
	}
	for _, name := range []string{
		"CLAUDECODE",
		"CLAUDE_CODE_CHILD_SESSION",
		"CLAUDE_CODE_SESSION_ID",
		"CLAUDE_CODE_BRIDGE_SESSION_ID",
	} {
		if got := environmentValue(launch.Environment, name); got != "" {
			t.Errorf("%s was retained as %q", name, got)
		}
	}
}

func TestPrepareCommandLaunchLeavesExplicitClaudeCommandAlone(t *testing.T) {
	arguments := []string{"claude", "--resume", testClaudeSessionID}
	launch := prepareCommandLaunch(arguments, []string{
		"CLAUDE_CODE_CHILD_SESSION=1",
		"CLAUDE_CODE_SESSION_ID=" + testClaudeSessionID,
	}, true)

	if !reflect.DeepEqual(launch.Arguments, arguments) {
		t.Fatalf("arguments = %#v, want %#v", launch.Arguments, arguments)
	}
	if launch.Handoff != "" {
		t.Fatalf("handoff = %q", launch.Handoff)
	}
}

func TestPrepareCommandLaunchRequiresClaudeToolSubprocess(t *testing.T) {
	launch := prepareCommandLaunch([]string{"claude"}, []string{
		"CLAUDE_CODE_SESSION_ID=" + testClaudeSessionID,
	}, true)

	if !reflect.DeepEqual(launch.Arguments, []string{"claude"}) {
		t.Fatalf("arguments = %#v", launch.Arguments)
	}
	if launch.Handoff != "" {
		t.Fatalf("handoff = %q", launch.Handoff)
	}
}

func TestPrepareCommandLaunchDoesNotHandoffInForeground(t *testing.T) {
	launch := prepareCommandLaunch([]string{"claude"}, []string{
		"CLAUDE_CODE_CHILD_SESSION=1",
		"CLAUDE_CODE_SESSION_ID=" + testClaudeSessionID,
	}, false)

	if !reflect.DeepEqual(launch.Arguments, []string{"claude"}) {
		t.Fatalf("arguments = %#v", launch.Arguments)
	}
	if launch.Handoff != "" {
		t.Fatalf("handoff = %q", launch.Handoff)
	}
}

func TestPrepareCommandLaunchForksCurrentOpencodeConversationByResolvedSession(t *testing.T) {
	withOpencodeSession(t, "/Users/calinteodor", "ses_abc123", 3)
	launch := prepareCommandLaunch([]string{"opencode"}, []string{
		"OPENCODE=1",
		"OPENCODE_PID=840",
		"AGENT=1",
		"KEEP_ME=yes",
	}, true)

	wantArguments := []string{"opencode", "--session", "ses_abc123", "--fork"}
	if !reflect.DeepEqual(launch.Arguments, wantArguments) {
		t.Fatalf("arguments = %#v, want %#v", launch.Arguments, wantArguments)
	}
	if !reflect.DeepEqual(launch.DisplayArguments, []string{"opencode"}) {
		t.Fatalf("display arguments = %#v", launch.DisplayArguments)
	}
	if launch.Handoff != opencodeConversationHandoff {
		t.Fatalf("handoff = %q", launch.Handoff)
	}
	if launch.HandoffDisplay != "opencode conversation" {
		t.Fatalf("handoff display = %q", launch.HandoffDisplay)
	}
	if got := environmentValue(launch.Environment, "KEEP_ME"); got != "yes" {
		t.Fatalf("KEEP_ME = %q", got)
	}
	for _, name := range []string{"OPENCODE", "OPENCODE_PID", "AGENT"} {
		if got := environmentValue(launch.Environment, name); got != "" {
			t.Errorf("%s was retained as %q", name, got)
		}
	}
}

func TestPrepareCommandLaunchForksCurrentOpencodeConversationBySession(t *testing.T) {
	launch := prepareCommandLaunch([]string{"opencode"}, []string{
		"OPENCODE=1",
		"OPENCODE_SESSION_ID=" + testOpencodeSessionID,
	}, true)

	wantArguments := []string{"opencode", "--session", testOpencodeSessionID, "--fork"}
	if !reflect.DeepEqual(launch.Arguments, wantArguments) {
		t.Fatalf("arguments = %#v, want %#v", launch.Arguments, wantArguments)
	}
	if launch.Handoff != opencodeConversationHandoff {
		t.Fatalf("handoff = %q", launch.Handoff)
	}
}

func TestPrepareCommandLaunchOpencodeFallsBackToResolvedSessionOnBadSessionID(t *testing.T) {
	withOpencodeSession(t, "/Users/calinteodor", "ses_abc123", 5)
	launch := prepareCommandLaunch([]string{"opencode"}, []string{
		"OPENCODE=1",
		"OPENCODE_SESSION_ID=not-a-session",
	}, true)

	wantArguments := []string{"opencode", "--session", "ses_abc123", "--fork"}
	if !reflect.DeepEqual(launch.Arguments, wantArguments) {
		t.Fatalf("arguments = %#v, want %#v", launch.Arguments, wantArguments)
	}
}

func TestPrepareCommandLaunchLeavesOpencodeAloneOutsideHarness(t *testing.T) {
	launch := prepareCommandLaunch([]string{"opencode"}, []string{
		"OPENCODE_SESSION_ID=" + testOpencodeSessionID,
	}, true)

	if !reflect.DeepEqual(launch.Arguments, []string{"opencode"}) {
		t.Fatalf("arguments = %#v", launch.Arguments)
	}
	if launch.Handoff != "" {
		t.Fatalf("handoff = %q", launch.Handoff)
	}
}

func TestPrepareCommandLaunchDoesNotHandoffOpencodeInForeground(t *testing.T) {
	launch := prepareCommandLaunch([]string{"opencode"}, []string{
		"OPENCODE=1",
	}, false)

	if !reflect.DeepEqual(launch.Arguments, []string{"opencode"}) {
		t.Fatalf("arguments = %#v", launch.Arguments)
	}
	if launch.Handoff != "" {
		t.Fatalf("handoff = %q", launch.Handoff)
	}
}
func withOpencodeSession(t *testing.T, cwd, id string, count int) {
	t.Helper()
	previousCwd := opencodeProcessCwd
	previousSession := opencodeLatestSession
	opencodeProcessCwd = func() string { return cwd }
	opencodeLatestSession = func(dir string) (string, int, bool) {
		if dir == cwd && id != "" {
			return id, count, true
		}
		return "", 0, false
	}
	t.Cleanup(func() {
		opencodeProcessCwd = previousCwd
		opencodeLatestSession = previousSession
	})
}

func TestOpencodeForkCaveatWarnsWhenAmbiguous(t *testing.T) {
	withOpencodeSession(t, "/Users/calinteodor", "ses_abc123", 5)
	launch := prepareCommandLaunch([]string{"opencode"}, []string{"OPENCODE=1"}, true)
	if launch.HandoffNote == "" {
		t.Fatalf("expected a caveat note, got none")
	}
}

func TestOpencodeForkCaveatSilentForSingleSession(t *testing.T) {
	withOpencodeSession(t, "/Users/calinteodor", "ses_abc123", 1)
	launch := prepareCommandLaunch([]string{"opencode"}, []string{"OPENCODE=1"}, true)
	if launch.HandoffNote != "" {
		t.Fatalf("unexpected caveat note %q", launch.HandoffNote)
	}
}

func TestOpencodeForkCaveatWarnsWhenUnresolvable(t *testing.T) {
	withOpencodeSession(t, "", "", 0)
	launch := prepareCommandLaunch([]string{"opencode"}, []string{"OPENCODE=1"}, true)
	if launch.HandoffNote == "" {
		t.Fatalf("expected a caveat note when the session is unresolvable, got none")
	}
}

func TestOpencodeExactForkHasNoCaveat(t *testing.T) {
	launch := prepareCommandLaunch([]string{"opencode"}, []string{
		"OPENCODE=1",
		"OPENCODE_SESSION_ID=" + testOpencodeSessionID,
	}, true)
	if launch.HandoffNote != "" {
		t.Fatalf("exact fork should have no caveat, got %q", launch.HandoffNote)
	}
}

func TestOpencodeAdapterFallsBackToContinueWhenUnresolvable(t *testing.T) {
	withOpencodeSession(t, "", "", 0)
	launch := prepareCommandLaunch([]string{"opencode"}, []string{"OPENCODE=1"}, true)
	wantArguments := []string{"opencode", "--continue", "--fork"}
	if !reflect.DeepEqual(launch.Arguments, wantArguments) {
		t.Fatalf("arguments = %#v, want %#v", launch.Arguments, wantArguments)
	}
}
