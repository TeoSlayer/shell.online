//go:build !windows

package main

import "os"

// newClaudeHookFile creates an empty owner-only file in the private local
// session directory for Claude Code's SessionStart hook to write to. The
// caller removes it when the session ends. "" means no hook.
func newClaudeHookFile() string {
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		return ""
	}
	file, err := os.CreateTemp(directory, "claude-hook-*.json")
	if err != nil {
		return ""
	}
	path := file.Name()
	if file.Chmod(0o600) != nil || file.Close() != nil {
		_ = os.Remove(path)
		return ""
	}
	return path
}
