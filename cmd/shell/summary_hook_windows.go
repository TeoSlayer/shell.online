//go:build windows

package main

// newClaudeHookFile is unavailable on Windows: the hook command relies on a
// POSIX shell. Claude Code sessions there bind only through --session-id.
func newClaudeHookFile() string { return "" }
