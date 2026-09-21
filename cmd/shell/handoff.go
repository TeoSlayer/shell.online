package main

import (
	"path/filepath"
	"strings"
)

// commandLaunch is the result of preparing a command for the shared terminal.
// When a conversation handoff applies, Arguments and Environment are rewritten
// to fork the current agent conversation, and Handoff/HandoffDisplay describe it.
type commandLaunch struct {
	Arguments        []string
	DisplayArguments []string
	Environment      []string
	Handoff          string
	HandoffDisplay   string
	HandoffNote      string
}

// harnessAdapter knows how to detect that shell is being launched from inside a
// particular agent harness, and how to relaunch that harness as a fork of the
// current conversation so it can be shared. Adding a new harness means adding a
// new adapter to harnessAdapters; no other call site changes.
type harnessAdapter struct {
	// Binary is the command basename that triggers this adapter.
	Binary string
	// Handoff is the machine marker reported to operators and JSON consumers
	// (e.g. "claude_conversation_fork").
	Handoff string
	// Display is the human-readable name of the conversation being forked
	// (e.g. "Claude conversation").
	Display string
	// Detect reports whether the launch is happening inside this harness and is
	// eligible for a conversation handoff.
	Detect func(environment []string) bool
	// SessionID returns the current conversation/session id, or "" when the
	// harness does not expose one. Adapters fall back to a "continue the latest
	// session" strategy when this is empty.
	SessionID func(environment []string) string
	// Rewrite returns the arguments that relaunch the harness as a fork of the
	// current conversation, the environment variables to strip from the child so
	// it does not inherit the parent's session identity, and an optional note for
	// the operator (e.g. a caveat that the fork is a best-effort heuristic).
	Rewrite func(binary, sessionID string) (arguments []string, stripEnv []string, note string)
}

// harnessAdapters is the registry of supported agent harnesses. Order is not
// significant because each adapter matches a distinct binary name.
var harnessAdapters = []harnessAdapter{
	claudeAdapter,
	opencodeAdapter,
}

// prepareCommandLaunch rewrites a bare agent-harness command into a fork of the
// current conversation when shell is launched from inside that harness. It is a
// no-op for foreground launches, multi-argument commands, and unknown binaries.
func prepareCommandLaunch(arguments, environment []string, allowHandoff bool) commandLaunch {
	launch := commandLaunch{
		Arguments:        append([]string(nil), arguments...),
		DisplayArguments: append([]string(nil), arguments...),
		Environment:      append([]string(nil), environment...),
	}
	if !allowHandoff || len(arguments) != 1 {
		return launch
	}
	binary := arguments[0]
	for _, adapter := range harnessAdapters {
		if filepath.Base(binary) != adapter.Binary {
			continue
		}
		if !adapter.Detect(environment) {
			continue
		}
		sessionID := adapter.SessionID(environment)
		newArguments, stripEnv, note := adapter.Rewrite(binary, sessionID)
		launch.Arguments = newArguments
		launch.Environment = removeEnvironmentVariables(environment, stripEnv...)
		launch.Handoff = adapter.Handoff
		launch.HandoffDisplay = adapter.Display
		launch.HandoffNote = note
		return launch
	}
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
