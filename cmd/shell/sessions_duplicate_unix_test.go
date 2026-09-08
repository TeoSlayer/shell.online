//go:build !windows

package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestStartLocalSessionRefusesDuplicateOwner(t *testing.T) {
	runtimeDirectory, err := os.MkdirTemp("/tmp", "shell-duplicate-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(runtimeDirectory) })
	t.Setenv("SHELL_ONLINE_RUNTIME_DIR", runtimeDirectory)
	record := localSessionRecord{
		ID:        strings.Repeat("a", 32),
		PID:       1234,
		StartedAt: time.Now(),
		Command:   "sleep 60",
	}
	first, err := startLocalSession(record)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()

	if _, err := startLocalSession(record); err == nil ||
		(!strings.Contains(err.Error(), "already running") && !strings.Contains(err.Error(), "already active")) {
		t.Fatalf("duplicate start error = %v, want an active-session refusal", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		response, pingError := sendLocalControl(record.ID, "ping")
		if pingError == nil && response.OK && response.PID == record.PID {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("original control channel was clobbered: response=%+v err=%v", response, pingError)
		}
		time.Sleep(25 * time.Millisecond)
	}
}
