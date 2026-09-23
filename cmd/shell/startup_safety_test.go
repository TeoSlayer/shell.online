//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"

	"shell.online/internal/api"
)

func startupFixture(t *testing.T) (string, persistentSessionState, string) {
	t.Helper()
	isolatedRuntime(t)
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "no-account.json"))
	t.Setenv("SHELL_ONLINE_E2EE_PASSWORD", "")
	t.Setenv(backgroundChildEnvironment, "")
	state := persistentSessionState{Version: 1, HostToken: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", Encrypted: true,
		Fragment: "#key=" + strings.Repeat("A", 43), EncryptionKey: strings.Repeat("A", 43)}
	state.ID = persistentSessionID(state.HostToken)
	path := filepath.Join(t.TempDir(), "persistent.json")
	if err := writePersistentState(path, state); err != nil {
		t.Fatal(err)
	}
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	return path, state, directory
}

func startupRecord(id string) localSessionRecord {
	return localSessionRecord{ID: id, PID: os.Getpid(), StartedAt: time.Now(), Persistent: true, Encrypted: true,
		Password: "synthetic-password", ShareURL: "https://invalid.test/original"}
}

func startupBytes(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func assertStartupBytes(t *testing.T, path string, before []byte) {
	t.Helper()
	if !bytes.Equal(startupBytes(t, path), before) {
		t.Fatal("startup altered existing private state")
	}
}

func startupReply(response http.ResponseWriter, state persistentSessionState) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(response).Encode(map[string]any{"session_id": state.ID, "host_token": state.HostToken,
		"read_only": state.ReadOnly, "encrypted": state.Encrypted, "persistent": true, "expires_at": time.Now().Add(time.Hour)})
}

func startupRun(server, path string) (int, string) {
	var stderr bytes.Buffer
	code := run([]string{"--foreground", "--server", server, "--persistent", path, "/usr/bin/true"}, io.Discard, &stderr)
	return code, stderr.String()
}

// F4: a duplicate --persistent launch must refuse locally before it resumes the
// remote session, for foreground and background alike, and must not mutate the
// state file or the retained record.
func TestStartupLocalRefusalPrecedesRemoteMutation(t *testing.T) {
	for _, background := range []bool{false, true} {
		for _, kind := range []string{"live", "abandoned-live", "dead", "malformed", "socket-only"} {
			t.Run(strconv.FormatBool(background)+"/"+kind, func(t *testing.T) {
				path, state, directory := startupFixture(t)
				var readiness *os.File
				if background {
					t.Setenv(backgroundChildEnvironment, "1")
					t.Setenv(backgroundParentEnvironment, strconv.Itoa(os.Getppid()))
					if !isBackgroundChild() {
						t.Fatal("background fixture requires a nonzero parent PID; use a container init process")
					}
					reader, writer, err := os.Pipe()
					if err != nil {
						t.Fatal(err)
					}
					defer reader.Close()
					if err := reader.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
						t.Fatal(err)
					}
					fd, err := syscall.Dup(int(writer.Fd()))
					_ = writer.Close()
					if err != nil {
						t.Fatal(err)
					}
					t.Setenv(backgroundReadyEnvironment, strconv.Itoa(fd))
					readiness = reader
				}
				recordPath := localSessionRecordPath(directory, state.ID)
				var recordBefore []byte
				if kind == "socket-only" {
					listener, err := listenLocalControl(state.ID)
					if err != nil {
						t.Fatal(err)
					}
					defer listener.Close()
				} else {
					record := startupRecord(state.ID)
					if kind == "dead" {
						record.PID = 999999
					}
					if kind == "abandoned-live" {
						at := time.Now()
						record.AbandonedAt = &at
					}
					if err := writeLocalSessionRecord(directory, record); err != nil {
						t.Fatal(err)
					}
					if kind == "malformed" {
						if err := os.WriteFile(recordPath, []byte("{"), 0o600); err != nil {
							t.Fatal(err)
						}
					}
					recordBefore = startupBytes(t, recordPath)
				}
				stateBefore := startupBytes(t, path)
				var requests atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests.Add(1)
					if r.URL.Path == "/api/sessions/resume" {
						startupReply(w, state)
						return
					}
					http.Error(w, "synthetic stop before PTY", http.StatusBadRequest)
				}))
				defer server.Close()
				code, message := startupRun(server.URL, path)
				if code == 0 || !strings.Contains(message, "local session management") {
					t.Fatalf("missing local refusal: code=%d", code)
				}
				if requests.Load() != 0 {
					t.Fatalf("local refusal happened after %d remote requests", requests.Load())
				}
				if readiness != nil {
					var result backgroundLaunchResult
					if err := json.NewDecoder(readiness).Decode(&result); err != nil || result.OK || !strings.Contains(result.Error, "local session management") {
						t.Fatal("background refusal was not reported to launcher")
					}
				}
				assertStartupBytes(t, path, stateBefore)
				if recordBefore != nil {
					assertStartupBytes(t, recordPath, recordBefore)
				}
			})
		}
	}
}

// A failed resume releases only this attempt's reservation, and the reservation
// is reusable by a later launch.
func TestStartupFailedResumeReleasesOnlyReservation(t *testing.T) {
	path, state, directory := startupFixture(t)
	before := startupBytes(t, path)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if _, err := os.Lstat(localSessionRecordPath(directory, state.ID)); !os.IsNotExist(err) {
			t.Error("record published before resume")
		}
		if _, err := os.Lstat(localSessionSocketPath(directory, state.ID)); err != nil {
			t.Error("resume ran without local reservation")
		}
		http.Error(w, "synthetic failure", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	for range 2 {
		if code, _ := startupRun(server.URL, path); code == 0 {
			t.Fatal("failed resume launched")
		}
		assertStartupBytes(t, path, before)
		entries, err := os.ReadDir(directory)
		if err != nil || len(entries) != 0 {
			t.Fatal("failed resume retained local reservation")
		}
	}
	if requests.Load() != 2 {
		t.Fatal("reservation was not reusable after failure")
	}
}

// Two concurrent launches of the same persistent state: at most one reserves and
// resumes; the other refuses locally without a second remote resume.
func TestStartupConcurrentPersistentCallersResumeOnlyOnce(t *testing.T) {
	path, _, directory := startupFixture(t)
	before := startupBytes(t, path)
	entered, release := make(chan struct{}), make(chan struct{})
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			close(entered)
			<-release
		}
		http.Error(w, "synthetic stop", 503)
	}))
	defer server.Close()
	var unblock sync.Once
	defer unblock.Do(func() { close(release) })
	done := make(chan int, 1)
	go func() { code, _ := startupRun(server.URL, path); done <- code }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("first caller never resumed")
	}
	if code, _ := startupRun(server.URL, path); code == 0 {
		t.Fatal("second caller launched")
	}
	if requests.Load() != 1 {
		t.Fatal("concurrent caller resumed the reserved identity")
	}
	unblock.Do(func() { close(release) })
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("first caller did not return")
	}
	assertStartupBytes(t, path, before)
	entries, _ := os.ReadDir(directory)
	if len(entries) != 0 {
		t.Fatal("concurrent refusal damaged reservation cleanup")
	}
}

// A normal, clean persistent stop must leave no local control or metadata, so a
// later launch can resume the same state. This is the recovery path for an
// operator who stopped the session cleanly (as opposed to a crash that leaves a
// retained record).
func TestStartupCleanExitAllowsPersistentResume(t *testing.T) {
	path, state, directory := startupFixture(t)
	before := startupBytes(t, path)
	var resumes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/sessions/resume" {
			resumes.Add(1)
			startupReply(w, state)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	for range 2 {
		if code, _ := startupRun(server.URL, path); code != 0 {
			t.Fatalf("normal synthetic task exited %d", code)
		}
		assertStartupBytes(t, path, before)
		entries, _ := os.ReadDir(directory)
		if len(entries) != 0 {
			t.Fatal("normal exit retained local control or metadata")
		}
	}
	if resumes.Load() != 2 {
		t.Fatal("clean exit blocked subsequent persistent resume")
	}
}

// A failed reservation must not unlink a control socket or record that a
// cooperating launch already replaced (owned-inode cleanup).
func TestReservationClosePreservesReplacementSocketAndRecord(t *testing.T) {
	_, state, directory := startupFixture(t)
	reservation, err := reserveLocalSession(state.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer reservation.Close()
	if err := os.Remove(localSessionSocketPath(directory, state.ID)); err != nil {
		t.Fatal(err)
	}
	replacement, err := net.Listen("unix", localSessionSocketPath(directory, state.ID))
	if err != nil {
		t.Fatal(err)
	}
	defer replacement.Close()
	info, _ := os.Lstat(localSessionSocketPath(directory, state.ID))
	if err := writeLocalSessionRecord(directory, startupRecord(state.ID)); err != nil {
		t.Fatal(err)
	}
	before := startupBytes(t, localSessionRecordPath(directory, state.ID))
	if control, err := reservation.finalize(startupRecord(state.ID)); err == nil {
		control.Close()
		t.Fatal("replaced a competing record")
	}
	reservation.Close()
	after, err := os.Lstat(localSessionSocketPath(directory, state.ID))
	if err != nil || !os.SameFile(info, after) {
		t.Fatal("abort removed a replacement socket")
	}
	assertStartupBytes(t, localSessionRecordPath(directory, state.ID), before)
}

// A healthy session that rotates its credentials must still clean up its own
// (rotated) record and socket on Close, so a same-ID restart succeeds.
func TestRotationThenCloseAllowsCleanRestart(t *testing.T) {
	_, state, directory := startupFixture(t)
	reservation, err := reserveLocalSession(state.ID)
	if err != nil {
		t.Fatal(err)
	}
	control, err := reservation.finalize(startupRecord(state.ID))
	if err != nil {
		t.Fatal(err)
	}
	if err := control.UpdateCredentials("https://invalid.test/rotated", "rotated-password"); err != nil {
		t.Fatal(err)
	}
	if err := control.Close(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("rotation left local state: entries=%d err=%v", len(entries), err)
	}
	restart, err := reserveLocalSession(state.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer restart.Close()
	if _, err := restart.finalize(startupRecord(state.ID)); err != nil {
		t.Fatal(err)
	}
}

// A finalized session's Close must not unlink a record or socket that a
// cooperating launch already replaced (owned-inode cleanup).
func TestFinalizedClosePreservesReplacementSocketAndRecord(t *testing.T) {
	_, state, directory := startupFixture(t)
	reservation, err := reserveLocalSession(state.ID)
	if err != nil {
		t.Fatal(err)
	}
	control, err := reservation.finalize(startupRecord(state.ID))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(localSessionSocketPath(directory, state.ID)); err != nil {
		t.Fatal(err)
	}
	replacement, err := net.Listen("unix", localSessionSocketPath(directory, state.ID))
	if err != nil {
		t.Fatal(err)
	}
	defer replacement.Close()
	socketInfo, _ := os.Lstat(localSessionSocketPath(directory, state.ID))
	if err := writeLocalSessionRecord(directory, startupRecord(state.ID)); err != nil {
		t.Fatal(err)
	}
	recordBefore := startupBytes(t, localSessionRecordPath(directory, state.ID))
	if err := control.Close(); err != nil {
		t.Fatal(err)
	}
	after, err := os.Lstat(localSessionSocketPath(directory, state.ID))
	if err != nil || !os.SameFile(socketInfo, after) {
		t.Fatal("old Close removed a replacement socket")
	}
	assertStartupBytes(t, localSessionRecordPath(directory, state.ID), recordBefore)
}

// A credential update after Close is refused and must not recreate a record.
func TestUpdateCredentialsAfterCloseRefused(t *testing.T) {
	_, state, directory := startupFixture(t)
	reservation, err := reserveLocalSession(state.ID)
	if err != nil {
		t.Fatal(err)
	}
	control, err := reservation.finalize(startupRecord(state.ID))
	if err != nil {
		t.Fatal(err)
	}
	if err := control.Close(); err != nil {
		t.Fatal(err)
	}
	if err := control.UpdateCredentials("https://invalid.test/late", "late-password"); err == nil {
		t.Fatal("credential update after close was accepted")
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("late rotation recreated local state: entries=%d err=%v", len(entries), err)
	}
}

// Exclusive fresh-state publication: exactly one winner, first credentials kept.
func TestFreshPersistentStateExclusivePersist(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.json")
	first := persistentSessionState{Version: 1, HostToken: strings.Repeat("1", 43), Encrypted: false}
	first.ID = persistentSessionID(first.HostToken)
	second := persistentSessionState{Version: 1, HostToken: strings.Repeat("2", 43), Encrypted: false}
	second.ID = persistentSessionID(second.HostToken)
	if err := writeNewPersistentState(path, first); err != nil {
		t.Fatalf("first persist: %v", err)
	}
	if err := writeNewPersistentState(path, second); err == nil {
		t.Fatal("second exclusive persist overwrote the first")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	var stored persistentSessionState
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if stored.HostToken != first.HostToken || stored.ID != first.ID {
		t.Fatal("first credentials were clobbered")
	}
}

// A control socket replaced before the resume makes check() refuse, so the
// production pre-resume sequence (check, then resume only on success) makes no
// remote request. The existing replacement test covers finalize, not resume.
func TestReplacedSocketBeforeResumeMakesNoRemoteRequest(t *testing.T) {
	path, _, directory := startupFixture(t)
	prepared, err := preparePersistentSession(path, false, true, "")
	if err != nil {
		t.Fatal(err)
	}
	reservation, err := reserveLocalSession(prepared.state.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer reservation.Close()
	if err := prepared.persist(path); err != nil {
		t.Fatal(err)
	}
	// Replace the control socket before the resume (as a cooperating launch would).
	if err := os.Remove(localSessionSocketPath(directory, prepared.state.ID)); err != nil {
		t.Fatal(err)
	}
	replacement, err := net.Listen("unix", localSessionSocketPath(directory, prepared.state.ID))
	if err != nil {
		t.Fatal(err)
	}
	defer replacement.Close()
	checkErr := reservation.check()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(w, "synthetic", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	client := api.NewClient(server.URL, "shell/test")
	if checkErr == nil {
		// Production only resumes after a passing check.
		if _, err := prepared.resume(context.Background(), client, "test"); err != nil {
			t.Fatal(err)
		}
	}
	if checkErr == nil {
		t.Fatal("check passed with a replaced control socket")
	}
	if requests.Load() != 0 {
		t.Fatalf("replaced socket made %d remote requests", requests.Load())
	}
}
