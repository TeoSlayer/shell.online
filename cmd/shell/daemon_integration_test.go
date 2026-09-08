//go:build !windows

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// What the daemon is for, end to end: a browser queues a command, the machine
// picks it up without anybody at a terminal, runs it, and says it is done.
//
// The accounts service is stubbed rather than mocked out of the picture, so
// what is exercised is the real HTTP conversation -- including the key the
// daemon publishes, which is what a browser seals a session password to.

type stubAccounts struct {
	mutex sync.Mutex
	// pending is handed out once, the way claiming works server-side.
	pending      []map[string]any
	polls        int
	publishedKey string
	finished     map[string]string
}

func (stub *stubAccounts) handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/agent/commands", func(writer http.ResponseWriter, request *http.Request) {
		stub.mutex.Lock()
		defer stub.mutex.Unlock()
		stub.polls++
		if key := request.URL.Query().Get("key"); key != "" {
			stub.publishedKey = key
		}
		claimed := stub.pending
		stub.pending = nil
		if claimed == nil {
			claimed = []map[string]any{}
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"commands": claimed})
	})

	mux.HandleFunc("/api/agent/commands/", func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		stub.mutex.Lock()
		stub.finished[strings.TrimPrefix(request.URL.Path, "/api/agent/commands/")] = body.Error
		stub.mutex.Unlock()
		_ = json.NewEncoder(writer).Encode(map[string]any{"ok": true})
	})

	return mux
}

func (stub *stubAccounts) queue(command map[string]any) {
	stub.mutex.Lock()
	defer stub.mutex.Unlock()
	stub.pending = append(stub.pending, command)
}

func (stub *stubAccounts) result(id string) (string, bool) {
	stub.mutex.Lock()
	defer stub.mutex.Unlock()
	value, ok := stub.finished[id]
	return value, ok
}

func (stub *stubAccounts) key() string {
	stub.mutex.Lock()
	defer stub.mutex.Unlock()
	return stub.publishedKey
}

// recordingShell stands in for the shell binary the daemon launches, writing
// down how it was called.
func recordingShell(t *testing.T, directory string) (path, log string) {
	t.Helper()
	path = filepath.Join(directory, "fake-shell")
	log = filepath.Join(directory, "launched.txt")
	script := "#!/bin/sh\n" +
		"{\n" +
		"  echo \"argv: $*\"\n" +
		"  echo \"name: ${SHELL_ONLINE_SESSION_NAME:-}\"\n" +
		"  echo \"password: ${SHELL_ONLINE_E2EE_PASSWORD:-}\"\n" +
		"} >> " + log + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write the stand-in shell: %v", err)
	}
	return path, log
}

func credentialsFor(t *testing.T, server string) (configPath, runtime string) {
	t.Helper()
	runtime = shortTempDir(t)
	configPath = filepath.Join(runtime, "credentials.json")
	contents := map[string]any{
		"server":        server,
		"access_token":  "sha_test",
		"refresh_token": "shr_test",
		"expires_at":    time.Now().Add(24 * time.Hour).Format(time.RFC3339),
		"uid":           "uid-1",
		"email":         "ana@example.com",
		"remote_start":  true,
	}
	encoded, _ := json.MarshalIndent(contents, "", "  ")
	if err := os.WriteFile(configPath, encoded, 0o600); err != nil {
		t.Fatalf("write credentials: %v", err)
	}
	return configPath, runtime
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestDaemonRunsAQueuedStartWithNobodyAtTheTerminal(t *testing.T) {
	stub := &stubAccounts{finished: map[string]string{}}
	service := httptest.NewServer(stub.handler())
	defer service.Close()

	binary := buildShell(t)
	configPath, runtime := credentialsFor(t, service.URL)
	fakeShell, launchLog := recordingShell(t, runtime)

	daemon := exec.Command(binary, "daemon", "--shell", fakeShell)
	daemon.Env = append(os.Environ(), "SHELL_ONLINE_CONFIG="+configPath, "SHELL_ONLINE_RUNTIME_DIR="+filepath.Join(runtime, "run"))
	if err := daemon.Start(); err != nil {
		t.Fatalf("start the daemon: %v", err)
	}
	defer func() {
		_ = daemon.Process.Kill()
		_, _ = daemon.Process.Wait()
	}()

	// It has to be asking before there is anything to ask for, or the browser
	// would have nothing to seal a password to.
	waitFor(t, "the first poll", func() bool { return stub.key() != "" })

	stub.queue(map[string]any{
		"id":      "cmd_one",
		"kind":    "start",
		"command": "htop",
		"name":    "watching the box",
	})

	waitFor(t, "the command to be reported done", func() bool {
		_, done := stub.result("cmd_one")
		return done
	})
	if failure, _ := stub.result("cmd_one"); failure != "" {
		t.Fatalf("the command failed: %s", failure)
	}

	launched, err := os.ReadFile(launchLog)
	if err != nil {
		t.Fatalf("nothing was launched: %v", err)
	}
	text := string(launched)
	wantArguments := "argv: " + strings.Join(browserCommandArguments("htop"), " ")
	if !strings.Contains(text, wantArguments) {
		t.Fatalf("expected %q to be launched, got:\n%s", wantArguments, text)
	}
	// The name chosen in the browser has to survive to the session list.
	if !strings.Contains(text, "name: watching the box") {
		t.Fatalf("expected the session name to be passed through, got:\n%s", text)
	}
}

func TestDaemonReportsACommandItCannotRun(t *testing.T) {
	stub := &stubAccounts{finished: map[string]string{}}
	service := httptest.NewServer(stub.handler())
	defer service.Close()

	binary := buildShell(t)
	configPath, runtime := credentialsFor(t, service.URL)

	daemon := exec.Command(binary, "daemon", "--shell", filepath.Join(runtime, "does-not-exist"))
	daemon.Env = append(os.Environ(), "SHELL_ONLINE_CONFIG="+configPath, "SHELL_ONLINE_RUNTIME_DIR="+filepath.Join(runtime, "run"))
	if err := daemon.Start(); err != nil {
		t.Fatalf("start the daemon: %v", err)
	}
	defer func() {
		_ = daemon.Process.Kill()
		_, _ = daemon.Process.Wait()
	}()

	waitFor(t, "the first poll", func() bool { return stub.key() != "" })
	stub.queue(map[string]any{"id": "cmd_bad", "kind": "start", "command": "htop"})

	// A failure that is never reported leaves the browser waiting for a
	// session that is not coming.
	waitFor(t, "the failure to be reported", func() bool {
		failure, done := stub.result("cmd_bad")
		return done && failure != ""
	})
}

// Signing out has to stop it, without anyone having to find the process.
func TestDaemonStopsWhenTheAccountGoesAway(t *testing.T) {
	stub := &stubAccounts{finished: map[string]string{}}
	service := httptest.NewServer(stub.handler())
	defer service.Close()

	binary := buildShell(t)
	configPath, runtime := credentialsFor(t, service.URL)

	daemon := exec.Command(binary, "daemon")
	daemon.Env = append(os.Environ(), "SHELL_ONLINE_CONFIG="+configPath, "SHELL_ONLINE_RUNTIME_DIR="+filepath.Join(runtime, "run"))
	if err := daemon.Start(); err != nil {
		t.Fatalf("start the daemon: %v", err)
	}
	waitFor(t, "the first poll", func() bool { return stub.key() != "" })

	if err := os.Remove(configPath); err != nil {
		t.Fatalf("sign out: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- daemon.Wait() }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		_ = daemon.Process.Kill()
		t.Fatal("the daemon kept running after the account was signed out")
	}
}
