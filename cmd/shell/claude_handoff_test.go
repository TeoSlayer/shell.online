package main

import (
	"reflect"
	"testing"
)

const testClaudeSessionID = "123e4567-e89b-12d3-a456-426614174000"

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
