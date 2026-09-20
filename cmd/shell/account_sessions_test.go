package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"shell.online/internal/account"
)

func accountSessionsService(t *testing.T, sessions []map[string]any) *httptest.Server {
	t.Helper()
	service := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/cli/sessions" || request.Method != http.MethodGet {
			t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer sha_access" {
			t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"sessions": sessions})
	}))
	t.Cleanup(service.Close)
	return service
}

func sampleAccountSessions(now time.Time) []map[string]any {
	return []map[string]any{
		{
			"id": "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t", "name": "web app", "command": "npm run dev",
			"host": "ana-mbp", "shareUrl": "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
			"startedAt": now.Add(-2 * time.Hour).UnixMilli(), "relayStatus": "connected",
		},
		{
			"id": "Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Njc4", "command": "pytest -x",
			"host": "build-01", "shareUrl": "https://shell.online/s/Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Njc4",
			"startedAt": now.Add(-3 * time.Hour).UnixMilli(), "closedAt": now.Add(-150 * time.Minute).UnixMilli(),
			"exitCode": 1,
		},
	}
}

func TestAccountSessionListShowsOpenSessionsAndCountsEndedOnes(t *testing.T) {
	service := accountSessionsService(t, sampleAccountSessions(time.Now()))
	linkedAccount(t, service.URL)

	var stdout, stderr bytes.Buffer
	if code := runAccountSessionList(nil, &stdout, &stderr); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	output := stdout.String()
	for _, expected := range []string{"NAME", "qN7wKb3xTm", "web app", "online", "ana-mbp", "npm run dev", "1 ended session hidden · shell ls --all"} {
		if !strings.Contains(output, expected) {
			t.Errorf("output does not contain %q\n%s", expected, output)
		}
	}
	if strings.Contains(output, "pytest") {
		t.Errorf("an ended session was listed without --all\n%s", output)
	}
}

func TestAccountSessionListAllIncludesEndedSessions(t *testing.T) {
	service := accountSessionsService(t, sampleAccountSessions(time.Now()))
	linkedAccount(t, service.URL)

	var stdout, stderr bytes.Buffer
	if code := runAccountSessionList([]string{"--all"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	for _, expected := range []string{"web app", "pytest -x", "finished", "build-01"} {
		if !strings.Contains(stdout.String(), expected) {
			t.Errorf("output does not contain %q\n%s", expected, stdout.String())
		}
	}
	if strings.Contains(stdout.String(), "hidden") {
		t.Errorf("--all should hide nothing\n%s", stdout.String())
	}
}

func TestAccountSessionListJSONIsStable(t *testing.T) {
	now := time.Now()
	service := accountSessionsService(t, sampleAccountSessions(now))
	linkedAccount(t, service.URL)

	var stdout, stderr bytes.Buffer
	if code := runAccountSessionList([]string{"--json", "--all"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	var listed []map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &listed); err != nil {
		t.Fatalf("decode %q: %v", stdout.String(), err)
	}
	if len(listed) != 2 {
		t.Fatalf("listed %d sessions, want 2", len(listed))
	}
	if listed[0]["name"] != "web app" || listed[0]["status"] != "online" || listed[0]["share_url"] == nil {
		t.Errorf("first session = %+v", listed[0])
	}
	if listed[1]["status"] != "finished" || listed[1]["closed_at"] == nil || listed[1]["exit_code"] != float64(1) {
		t.Errorf("second session = %+v", listed[1])
	}
	if _, present := listed[1]["name"]; present {
		t.Errorf("an unnamed session should omit name: %+v", listed[1])
	}
}

func TestAccountSessionListExplainsAnUnlinkedMachine(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "absent.json"))
	var stdout, stderr bytes.Buffer
	if code := runAccountSessionList(nil, &stdout, &stderr); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	for _, expected := range []string{"not signed in", "shell auth", "shell list"} {
		if !strings.Contains(stderr.String(), expected) {
			t.Errorf("stderr does not contain %q: %q", expected, stderr.String())
		}
	}
}

func TestAccountSessionListRejectsArguments(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := runAccountSessionList([]string{"extra"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
}

func TestRunSessionCommandRoutesLs(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code, handled := runSessionCommand([]string{"ls", "--help"}, &stdout, &stderr)
	if !handled || code != 0 {
		t.Fatalf("ls --help = %d, handled %v", code, handled)
	}
	if !strings.Contains(stderr.String(), "shell ls") {
		t.Fatalf("usage = %q", stderr.String())
	}
}

func TestAccountSessionStatusMatchesTheWebApp(t *testing.T) {
	closed := int64(1)
	now := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	justNow := now.Add(-30 * time.Second).UnixMilli()
	longAgo := now.Add(-2 * time.Hour).UnixMilli()
	tests := []struct {
		session account.AccountSession
		status  string
		ended   bool
	}{
		{account.AccountSession{RelayStatus: "connected"}, "online", false},
		{account.AccountSession{}, "online", false},
		{account.AccountSession{RelayStatus: "waiting"}, "starting", false},
		{account.AccountSession{RelayStatus: "disconnected"}, "offline", false},
		{account.AccountSession{RelayStatus: "unknown"}, "unknown", false},
		{account.AccountSession{RelayStatus: "missing"}, "unavailable", true},
		{account.AccountSession{RelayStatus: "exited"}, "finished", true},
		{account.AccountSession{ClosedAt: &closed, RelayStatus: "connected"}, "finished", true},
		/* A machine that dropped a moment ago is reconnecting, not gone. */
		{account.AccountSession{RelayStatus: "disconnected", HostLastSeenAt: &justNow}, "offline", false},
		/* One that has said nothing for hours was rebooted or lost power. */
		{account.AccountSession{RelayStatus: "disconnected", HostLastSeenAt: &longAgo}, "machine gone", true},
		/* Waiting to be resumed is what a persistent session is for. */
		{account.AccountSession{RelayStatus: "disconnected", HostLastSeenAt: &longAgo, Persistent: true}, "offline", false},
	}
	for _, test := range tests {
		if got := accountSessionStatus(test.session, now); got != test.status {
			t.Errorf("status(%+v) = %q, want %q", test.session, got, test.status)
		}
		if got := accountSessionEnded(test.session, now); got != test.ended {
			t.Errorf("ended(%+v) = %v, want %v", test.session, got, test.ended)
		}
	}
}

func TestValidateSessionName(t *testing.T) {
	if err := validateSessionName(""); err != nil {
		t.Errorf("empty name: %v", err)
	}
	if err := validateSessionName(strings.Repeat("é", sessionNameLimit)); err != nil {
		t.Errorf("name at the limit: %v", err)
	}
	if err := validateSessionName(strings.Repeat("a", sessionNameLimit+1)); err == nil {
		t.Error("an over-long name was accepted")
	}
	if err := validateSessionName("two\nlines"); err == nil {
		t.Error("a multi-line name was accepted")
	}
}

func TestValidateSessionNameRefusesADirectionOverride(t *testing.T) {
	if err := validateSessionName("build\u202etxt.gnuf"); err == nil {
		t.Error("a name that reverses the rest of its row was accepted")
	}
}

func TestSanitizeSessionNameCleansRatherThanRefuses(t *testing.T) {
	tests := []struct {
		name string
		want string
	}{
		{name: "deploy\nnow", want: "deploy now"},
		{name: "build\u202etxt.gnuf", want: "build txt.gnuf"},
		{name: "  spaced   out  ", want: "spaced out"},
		{name: "\u202a\u202c", want: ""},
		{name: "", want: ""},
	}
	for _, test := range tests {
		if got := sanitizeSessionName(test.name); got != test.want {
			t.Errorf("sanitizeSessionName(%q) = %q, want %q", test.name, got, test.want)
		}
	}
	long := sanitizeSessionName(strings.Repeat("e", sessionNameLimit+40))
	if utf8.RuneCountInString(long) != sessionNameLimit {
		t.Errorf("an over-long name was not cut to %d runes", sessionNameLimit)
	}
	if err := validateSessionName(sanitizeSessionName("deploy\nnow\u202egnuf")); err != nil {
		t.Errorf("a cleaned name should always be acceptable: %v", err)
	}
}

func TestNameFlagIsRejectedBeforeAnythingStarts(t *testing.T) {
	// run() may try to bring the daemon up; with no account there is nothing to start.
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "absent.json"))
	var stdout, stderr bytes.Buffer
	code := run([]string{"--name", strings.Repeat("a", sessionNameLimit+1), "true"}, &stdout, &stderr)
	if code != 2 || !strings.Contains(stderr.String(), "--name is limited") {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
}

func TestAutoCloseNormalizationSkipsTheNameValue(t *testing.T) {
	now := time.Date(2026, time.September, 11, 12, 0, 0, 0, time.UTC)
	got, err := normalizeAutoCloseArguments([]string{"--name", "nightly", "--auto-close", "in", "5m", "make"}, now)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--name", "nightly", "--auto-close=in 5m", "make"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("normalized = %q, want %q", got, want)
	}
}

func TestCompactSessionListLeadsWithTheName(t *testing.T) {
	now := time.Date(2026, time.September, 11, 12, 0, 0, 0, time.UTC)
	record := localSessionRecord{
		ID:        "abcdefghijklmnopqrstuvwxyzABCDEF",
		Name:      "training run",
		ShareURL:  "https://shell.online/s/abcdefghijklmnopqrstuvwxyzABCDEF",
		Command:   "python train.py",
		StartedAt: now.Add(-time.Minute),
	}
	var output bytes.Buffer
	printCompactSessionList(&output, []localSessionRecord{record}, map[string]relaySessionStatus{}, now)
	for _, expected := range []string{"abcdefghij  training run", "Command   python train.py"} {
		if !strings.Contains(output.String(), expected) {
			t.Errorf("card does not contain %q\n%s", expected, output.String())
		}
	}
}
