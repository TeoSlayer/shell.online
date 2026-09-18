//go:build !windows

package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// recordingCloser stands in for the accounts client.
type recordingCloser struct {
	closed []string
	fail   error
}

func (closer *recordingCloser) CloseSession(_ context.Context, _, id string, exitCode *int) error {
	if closer.fail != nil {
		return closer.fail
	}
	if exitCode != nil {
		return errors.New("nobody saw this process exit, so there is no code to report")
	}
	closer.closed = append(closer.closed, id)
	return nil
}

// writeRecord puts a session record on disk without a process behind it, which
// is what a machine finds after it is rebooted or loses power.
func writeRecord(t *testing.T, id string) {
	t.Helper()
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	record := localSessionRecord{
		ID: id, ShareURL: "https://shell.online/s/" + id, Password: "hunter2",
		Command: "npm test", PID: 999999, StartedAt: time.Now().Add(-time.Hour),
	}
	if err := writeLocalSessionRecord(directory, record); err != nil {
		t.Fatal(err)
	}
}

func isolatedRuntime(t *testing.T) {
	t.Helper()
	runtimeDir, err := os.MkdirTemp("/tmp", "shell-reclaim-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(runtimeDir) })
	t.Setenv("SHELL_ONLINE_RUNTIME_DIR", runtimeDir)
}

func TestScanKeepsTheRecordOfASessionWhoseProcessIsGone(t *testing.T) {
	isolatedRuntime(t)
	id := strings.Repeat("a", 32)
	writeRecord(t, id)

	active, abandoned, err := scanLocalSessions()
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 0 {
		t.Fatalf("active = %+v, want none", active)
	}
	if len(abandoned) != 1 || abandoned[0].ID != id {
		t.Fatalf("abandoned = %+v", abandoned)
	}
	if abandoned[0].AbandonedAt == nil {
		t.Error("an abandoned record should be dated")
	}
	/* The browser password outlives the process in the relay, so it is dropped. */
	if abandoned[0].Password != "" {
		t.Error("an abandoned record should not keep the session password")
	}

	/* The note survives a second look, so any later run can still report it. */
	if _, again, err := scanLocalSessions(); err != nil || len(again) != 1 {
		t.Fatalf("second scan = %+v, %v", again, err)
	}
	/* And it is not offered as something still running. */
	if loaded, err := loadActiveLocalSessions(); err != nil || len(loaded) != 0 {
		t.Fatalf("loadActiveLocalSessions = %+v, %v", loaded, err)
	}
}

func TestReclaimClosesAbandonedSessionsOnce(t *testing.T) {
	isolatedRuntime(t)
	id := strings.Repeat("b", 32)
	writeRecord(t, id)
	if _, abandoned, _ := scanLocalSessions(); len(abandoned) != 1 {
		t.Fatal("setup did not produce an abandoned session")
	}

	closer := &recordingCloser{}
	var report strings.Builder
	reclaimAbandonedSessions(context.Background(), closer, "token", &report)

	if len(closer.closed) != 1 || closer.closed[0] != id {
		t.Fatalf("closed = %v", closer.closed)
	}
	if !strings.Contains(report.String(), "left behind by an earlier run") {
		t.Errorf("report = %q", report.String())
	}

	/* Reported once. A second run has nothing left to say. */
	closer.closed = nil
	reclaimAbandonedSessions(context.Background(), closer, "token", &report)
	if len(closer.closed) != 0 {
		t.Fatalf("closed again = %v", closer.closed)
	}
}

func TestReclaimKeepsTheRecordWhenTheServiceCannotBeReached(t *testing.T) {
	isolatedRuntime(t)
	id := strings.Repeat("c", 32)
	writeRecord(t, id)

	offline := &recordingCloser{fail: errors.New("dial tcp: no route to host")}
	var report strings.Builder
	reclaimAbandonedSessions(context.Background(), offline, "token", &report)

	if !strings.Contains(report.String(), "could not close") {
		t.Errorf("report = %q", report.String())
	}
	/* Still owed, so the next run tries again rather than losing the session. */
	if _, abandoned, _ := scanLocalSessions(); len(abandoned) != 1 || abandoned[0].ID != id {
		t.Fatalf("abandoned after a failed close = %+v", abandoned)
	}
}

func TestScanForgetsANoteNobodyCollected(t *testing.T) {
	isolatedRuntime(t)
	id := strings.Repeat("d", 32)
	writeRecord(t, id)
	if _, abandoned, _ := scanLocalSessions(); len(abandoned) != 1 {
		t.Fatal("setup did not produce an abandoned session")
	}

	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	_, abandoned, _ := scanLocalSessions()
	stale := abandoned[0]
	long := time.Now().Add(-abandonedRecordTTL - time.Minute)
	stale.AbandonedAt = &long
	if err := writeLocalSessionRecord(directory, stale); err != nil {
		t.Fatal(err)
	}

	if _, left, err := scanLocalSessions(); err != nil || len(left) != 0 {
		t.Fatalf("stale note = %+v, %v", left, err)
	}
	if _, err := os.Stat(localSessionRecordPath(directory, id)); !os.IsNotExist(err) {
		t.Errorf("stale record still on disk: %v", err)
	}
}
