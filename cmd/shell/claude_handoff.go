package main

import (
	"path/filepath"
	"regexp"
	"strings"
)

const claudeConversationHandoff = "claude_conversation_fork"

var claudeSessionIDPattern = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
)

type commandLaunch struct {
	Arguments        []string
	DisplayArguments []string
	Environment      []string
	Handoff          string
}

func prepareCommandLaunch(arguments, environment []string, allowClaudeHandoff bool) commandLaunch {
	launch := commandLaunch{
		Arguments:        append([]string(nil), arguments...),
		DisplayArguments: append([]string(nil), arguments...),
		Environment:      append([]string(nil), environment...),
	}
	if !allowClaudeHandoff || len(arguments) != 1 || filepath.Base(arguments[0]) != "claude" {
		return launch
	}
	if environmentValue(environment, "CLAUDE_CODE_CHILD_SESSION") != "1" {
		return launch
	}

	sessionID := environmentValue(environment, "CLAUDE_CODE_SESSION_ID")
	if !claudeSessionIDPattern.MatchString(sessionID) {
		return launch
	}

	launch.Arguments = []string{arguments[0], "--resume", sessionID, "--fork-session"}
	launch.Environment = removeEnvironmentVariables(
		environment,
		"CLAUDECODE",
		"CLAUDE_CODE_CHILD_SESSION",
		"CLAUDE_CODE_SESSION_ID",
		"CLAUDE_CODE_BRIDGE_SESSION_ID",
		"CLAUDE_CODE_REMOTE_SESSION_ID",
	)
	launch.Handoff = claudeConversationHandoff
	return launch
}

func environmentValue(environment []string, name string) string {
	prefix := name + "="
	for _, entry := range environment {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix)
		}
	}
	return ""
}

func removeEnvironmentVariables(environment []string, names ...string) []string {
	removed := make(map[string]struct{}, len(names))
	for _, name := range names {
		removed[name] = struct{}{}
	}

	filtered := make([]string, 0, len(environment))
	for _, entry := range environment {
		name, _, found := strings.Cut(entry, "=")
		if found {
			if _, shouldRemove := removed[name]; shouldRemove {
				continue
			}
		}
		filtered = append(filtered, entry)
	}
	return filtered
}
