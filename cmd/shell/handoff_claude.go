package main

import "regexp"

const claudeConversationHandoff = "claude_conversation_fork"

var claudeSessionIDPattern = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
)

// claudeAdapter forks the current Claude Code conversation. Claude exposes the
// active session id and a child-session marker to its Bash tool subprocesses,
// so the fork is exact via `claude --resume <id> --fork-session`.
var claudeAdapter = harnessAdapter{
	Binary:  "claude",
	Handoff: claudeConversationHandoff,
	Display: "Claude conversation",
	Detect: func(environment []string) bool {
		if environmentValue(environment, "CLAUDE_CODE_CHILD_SESSION") != "1" {
			return false
		}
		return claudeSessionIDPattern.MatchString(environmentValue(environment, "CLAUDE_CODE_SESSION_ID"))
	},
	SessionID: func(environment []string) string {
		return environmentValue(environment, "CLAUDE_CODE_SESSION_ID")
	},
	Rewrite: func(binary, sessionID string) ([]string, []string, string) {
		return []string{binary, "--resume", sessionID, "--fork-session"}, []string{
			"CLAUDECODE",
			"CLAUDE_CODE_CHILD_SESSION",
			"CLAUDE_CODE_SESSION_ID",
			"CLAUDE_CODE_BRIDGE_SESSION_ID",
			"CLAUDE_CODE_REMOTE_SESSION_ID",
		}, ""
	},
}
