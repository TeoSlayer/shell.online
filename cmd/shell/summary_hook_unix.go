//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// newClaudeHookFile creates an empty owner-only file in the private local
// session directory for Claude Code's SessionStart hook to write to. The
// caller removes it when the session ends. "" means no hook.
func newClaudeHookFile() string {
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		return ""
	}
	removeStaleClaudeHooks(directory)
	// The owning host's process id is in the name, so a later host can tell
	// a live session's file from one left behind by a host that was killed.
	file, err := os.CreateTemp(directory, fmt.Sprintf("claude-hook-%d-*.json", os.Getpid()))
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

// removeStaleClaudeHooks deletes hook files whose host is no longer running.
// A deferred removal does not run when a host is killed, and the files name
// the conversation and its transcript path. Files without a process id (an
// older format) are removed once they are a day old.
func removeStaleClaudeHooks(directory string) {
	matches, err := filepath.Glob(filepath.Join(directory, "claude-hook-*.json"))
	if err != nil {
		return
	}
	for _, path := range matches {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		fields := strings.SplitN(strings.TrimPrefix(filepath.Base(path), "claude-hook-"), "-", 2)
		pid, err := strconv.Atoi(fields[0])
		if len(fields) < 2 || err != nil || pid <= 0 {
			if time.Since(info.ModTime()) > 24*time.Hour {
				_ = os.Remove(path)
			}
			continue
		}
		if pid != os.Getpid() && errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			_ = os.Remove(path)
		}
	}
}
