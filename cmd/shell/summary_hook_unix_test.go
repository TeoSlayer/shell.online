//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRemoveStaleClaudeHooks(t *testing.T) {
	dir := t.TempDir()
	live := filepath.Join(dir, fmt.Sprintf("claude-hook-%d-1.json", os.Getpid()))
	dead := filepath.Join(dir, "claude-hook-999999999-1.json")
	legacy := filepath.Join(dir, "claude-hook-123.json")
	for _, path := range []string{live, dead, legacy} {
		if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-48 * time.Hour)
	_ = os.Chtimes(legacy, old, old)
	removeStaleClaudeHooks(dir)
	if _, err := os.Stat(live); err != nil {
		t.Error("a live host's hook file was removed")
	}
	for _, path := range []string{dead, legacy} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("stale hook file kept: %s", filepath.Base(path))
		}
	}
}
