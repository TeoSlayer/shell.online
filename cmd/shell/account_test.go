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

	"shell.online/internal/account"
)

// linkedAccount points SHELL_ONLINE_CONFIG at a temporary file holding
// credentials for the given service, and returns that path.
func linkedAccount(t *testing.T, server string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv("SHELL_ONLINE_CONFIG", path)
	credentials := account.Credentials{
		Server:       server,
		AccessToken:  "sha_access",
		RefreshToken: "shr_refresh",
		ExpiresAt:    time.Now().Add(time.Hour),
		UID:          "uid-1",
		Email:        "ana@example.com",
		Name:         "Ana Ferreira",
	}
	if err := account.Save(path, credentials); err != nil {
		t.Fatalf("Save: %v", err)
	}
	return path
}

func TestRunSessionCommandRoutesAccountVerbs(t *testing.T) {
	for _, verb := range []string{"login", "logout", "whoami"} {
		t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "credentials.json"))
		var stdout, stderr bytes.Buffer
		// --help returns before any network work, so this only proves routing.
		_, handled := runSessionCommand([]string{verb, "--help"}, &stdout, &stderr)
		if !handled {
			t.Fatalf("%q was not routed to the account commands", verb)
		}
	}
}

func TestRunSessionCommandLeavesOtherVerbsAlone(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if _, handled := runSessionCommand([]string{"claude"}, &stdout, &stderr); handled {
		t.Fatal("a wrapped command must not be treated as an account verb")
	}
}

func TestWhoamiReportsWhenNotSignedIn(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "absent.json"))
	var stdout, stderr bytes.Buffer

	code := runWhoami(nil, &stdout, &stderr)

	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stdout.String(), "shell login") {
		t.Fatalf("output should point at the fix, got %q", stdout.String())
	}
}

func TestWhoamiShowsTheLinkedAccount(t *testing.T) {
	linkedAccount(t, "http://127.0.0.1:1")
	var stdout, stderr bytes.Buffer

	if code := runWhoami(nil, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr %q", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "ana@example.com") {
		t.Fatalf("output = %q, want the email", stdout.String())
	}
}

func TestWhoamiNeverPrintsTheTokens(t *testing.T) {
	linkedAccount(t, "http://127.0.0.1:1")
	var stdout, stderr bytes.Buffer
	runWhoami(nil, &stdout, &stderr)

	combined := stdout.String() + stderr.String()
	for _, secret := range []string{"sha_access", "shr_refresh"} {
		if strings.Contains(combined, secret) {
			t.Fatalf("output leaked %q", secret)
		}
	}
}

func TestLogoutWhenNotSignedIn(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "absent.json"))
	var stdout, stderr bytes.Buffer

	if code := runLogout(nil, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if !strings.Contains(stdout.String(), "Not signed in") {
		t.Fatalf("output = %q", stdout.String())
	}
}

func TestLogoutRevokesRemotelyAndClearsLocally(t *testing.T) {
	var revokedWith string
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/api/cli/revoke" {
				t.Errorf("unexpected path %s", request.URL.Path)
			}
			var body struct {
				RefreshToken string `json:"refresh_token"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			revokedWith = body.RefreshToken
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"revoked":true}`))
		}))
	defer service.Close()

	path := linkedAccount(t, service.URL)
	var stdout, stderr bytes.Buffer

	if code := runLogout(nil, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr %q", code, stderr.String())
	}
	if revokedWith != "shr_refresh" {
		t.Fatalf("revoked with %q, want the refresh token", revokedWith)
	}
	if _, err := account.Load(path); err == nil {
		t.Fatal("credentials should be gone after logout")
	}
	if !strings.Contains(stdout.String(), "ana@example.com") {
		t.Fatalf("output = %q, want the account that was signed out", stdout.String())
	}
}

func TestLogoutClearsLocallyEvenWhenRevokeFails(t *testing.T) {
	// A machine must never be stuck signed in because the service is down.
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusInternalServerError)
		}))
	defer service.Close()

	path := linkedAccount(t, service.URL)
	var stdout, stderr bytes.Buffer

	if code := runLogout(nil, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if _, err := account.Load(path); err == nil {
		t.Fatal("credentials should be cleared even when revoke fails")
	}
	if !strings.Contains(stderr.String(), "could not revoke remotely") {
		t.Fatalf("stderr should explain, got %q", stderr.String())
	}
}

func TestLogoutClearsACorruptCredentialsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv("SHELL_ONLINE_CONFIG", path)
	if err := writeFileForTest(path, "{not json"); err != nil {
		t.Fatalf("write: %v", err)
	}
	var stdout, stderr bytes.Buffer

	if code := runLogout(nil, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if _, err := account.Load(path); err == nil {
		t.Fatal("a corrupt file should still be cleared")
	}
}

func TestLoginRejectsPositionalArguments(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "credentials.json"))
	var stdout, stderr bytes.Buffer

	if code := runLogin([]string{"extra"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
}

func TestLoginRejectsAnUnknownFlag(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "credentials.json"))
	var stdout, stderr bytes.Buffer

	if code := runLogin([]string{"--nope"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
}

func TestDefaultAccountsURL(t *testing.T) {
	t.Setenv("SHELL_ONLINE_ACCOUNTS", "")
	if got := defaultAccountsURL(); got != "https://accounts.shell.online" {
		t.Fatalf("defaultAccountsURL = %q", got)
	}
	t.Setenv("SHELL_ONLINE_ACCOUNTS", "http://127.0.0.1:8787")
	if got := defaultAccountsURL(); got != "http://127.0.0.1:8787" {
		t.Fatalf("defaultAccountsURL did not honour the override, got %q", got)
	}
}

func TestDefaultWebURL(t *testing.T) {
	t.Setenv("SHELL_ONLINE_WEB", "")
	if got := defaultWebURL(); got != "https://shell.online" {
		t.Fatalf("defaultWebURL = %q", got)
	}
	t.Setenv("SHELL_ONLINE_WEB", "http://localhost:5173")
	if got := defaultWebURL(); got != "http://localhost:5173" {
		t.Fatalf("defaultWebURL did not honour the override, got %q", got)
	}
}

func TestPrintAccountCardLayout(t *testing.T) {
	var output bytes.Buffer
	printAccountCard(&output, account.Credentials{
		Email: "ana@example.com",
		Name:  "Ana Ferreira",
	}, "ana-mbp")

	text := output.String()
	for _, want := range []string{"shell.online", "Signed in", "ana@example.com", "Device", "ana-mbp"} {
		if !strings.Contains(text, want) {
			t.Fatalf("card is missing %q:\n%s", want, text)
		}
	}
	// Writing to a buffer is not a terminal, so no escape codes should appear.
	if strings.Contains(text, "\x1b[") {
		t.Fatalf("card emitted colour to a non-terminal writer:\n%q", text)
	}
}

func TestPrintAccountCardOmitsAnAbsentDevice(t *testing.T) {
	var output bytes.Buffer
	printAccountCard(&output, account.Credentials{Email: "ana@example.com"}, "")
	if strings.Contains(output.String(), "Device") {
		t.Fatalf("card should omit an empty device:\n%s", output.String())
	}
}

func TestResolvedLabelPrefersTheFlag(t *testing.T) {
	if got := resolvedLabel("build-box"); got != "build-box" {
		t.Fatalf("resolvedLabel = %q, want the flag", got)
	}
	if got := resolvedLabel(""); got == "" {
		t.Fatal("resolvedLabel should fall back to a hostname")
	}
}
