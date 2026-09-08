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

func TestRemoteStartConsentIsScopedToOneAccountAndServer(t *testing.T) {
	granted := account.Credentials{
		UID: "uid-1", Server: "https://app.shell.online", RemoteStart: true,
	}
	if !sameAccount(granted, account.Credentials{UID: "uid-1", Server: granted.Server}) {
		t.Fatal("the same provider account should keep its consent")
	}
	if sameAccount(granted, account.Credentials{UID: "uid-2", Server: granted.Server}) {
		t.Fatal("consent must not cross an account switch")
	}
	if sameAccount(granted, account.Credentials{UID: "uid-1", Server: "http://127.0.0.1:8787"}) {
		t.Fatal("consent must not cross an authority switch")
	}
	if sameAccount(account.Credentials{Server: granted.Server}, account.Credentials{Server: granted.Server}) {
		t.Fatal("legacy credentials without an identity must ask again")
	}
}

/*
 * Both halves of the account live on one host. Pointing either at a hostname
 * that does not exist, or at the marketing site which answers every path with
 * its own index page, is a failure only a released binary would find.
 */
func TestProductionURLsAreOneRealHost(t *testing.T) {
	t.Setenv("SHELL_ONLINE_ACCOUNTS", "")
	t.Setenv("SHELL_ONLINE_WEB", "")
	t.Setenv("SHELL_ONLINE_LOCAL", "")
	if defaultAccountsURL() != defaultWebURL() {
		t.Fatalf("accounts %q and web %q should be the same deployment",
			defaultAccountsURL(), defaultWebURL())
	}
	if !strings.HasPrefix(productionAppURL, "https://app.") {
		t.Fatalf("production should be the app subdomain, got %q", productionAppURL)
	}
}

func TestDefaultAccountsURL(t *testing.T) {
	t.Setenv("SHELL_ONLINE_ACCOUNTS", "")
	if got := defaultAccountsURL(); got != productionAppURL {
		t.Fatalf("defaultAccountsURL = %q", got)
	}
	t.Setenv("SHELL_ONLINE_ACCOUNTS", "http://127.0.0.1:8787")
	if got := defaultAccountsURL(); got != "http://127.0.0.1:8787" {
		t.Fatalf("defaultAccountsURL did not honour the override, got %q", got)
	}
}

func TestDefaultWebURL(t *testing.T) {
	t.Setenv("SHELL_ONLINE_WEB", "")
	if got := defaultWebURL(); got != productionAppURL {
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

func TestAgentRequiresALinkedAccount(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "absent.json"))
	var stdout, stderr bytes.Buffer

	if code := runAgent(nil, &stdout, &stderr); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "shell login") {
		t.Fatalf("stderr should point at the fix, got %q", stderr.String())
	}
}

func TestAgentRejectsPositionalArguments(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "credentials.json"))
	var stdout, stderr bytes.Buffer
	if code := runAgent([]string{"extra"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
}

func TestRunSessionCommandRoutesAgent(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "credentials.json"))
	var stdout, stderr bytes.Buffer
	if _, handled := runSessionCommand([]string{"agent", "--help"}, &stdout, &stderr); !handled {
		t.Fatal("agent was not routed")
	}
}

func TestAgentCardSaysWhatItAllows(t *testing.T) {
	// Running this lets a browser start processes here, so the card has to be
	// explicit rather than merely reassuring.
	var output bytes.Buffer
	printAgentCard(&output, account.Credentials{Email: "ana@example.com"})
	for _, want := range []string{"start and stop sessions here", "ana@example.com", "Ctrl-C"} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("agent card is missing %q:\n%s", want, output.String())
		}
	}
}

func TestDefaultsAimAtProductionUnlessToldOtherwise(t *testing.T) {
	for _, name := range []string{"SHELL_ONLINE_LOCAL", "SHELL_ONLINE_ACCOUNTS", "SHELL_ONLINE_WEB", "SHELL_ONLINE_SERVER"} {
		t.Setenv(name, "")
	}
	if got := defaultAccountsURL(); got != productionAppURL {
		t.Fatalf("defaultAccountsURL = %q", got)
	}
	if got := defaultWebURL(); got != productionAppURL {
		t.Fatalf("defaultWebURL = %q", got)
	}
	if got := defaultServer(); got != "https://shell.online" {
		t.Fatalf("defaultServer = %q", got)
	}
}

func TestLocalSwitchMovesEveryServiceAtOnce(t *testing.T) {
	// Forgetting one variable used to aim that one command at production while
	// the rest stayed local, which is how a test session reached the real relay.
	for _, name := range []string{"SHELL_ONLINE_ACCOUNTS", "SHELL_ONLINE_WEB", "SHELL_ONLINE_SERVER"} {
		t.Setenv(name, "")
	}
	t.Setenv("SHELL_ONLINE_LOCAL", "1")

	if got := defaultAccountsURL(); got != localAccountsURL {
		t.Fatalf("defaultAccountsURL = %q, want %q", got, localAccountsURL)
	}
	if got := defaultWebURL(); got != localWebURL {
		t.Fatalf("defaultWebURL = %q, want %q", got, localWebURL)
	}
	if got := defaultServer(); got != localServerURL {
		t.Fatalf("defaultServer = %q, want %q", got, localServerURL)
	}
}

func TestLocalSwitchAcceptsTrue(t *testing.T) {
	t.Setenv("SHELL_ONLINE_WEB", "")
	t.Setenv("SHELL_ONLINE_LOCAL", "true")
	if got := defaultWebURL(); got != localWebURL {
		t.Fatalf("defaultWebURL = %q, want the local address", got)
	}
}

func TestAnIndividualOverrideStillWinsOverTheLocalSwitch(t *testing.T) {
	t.Setenv("SHELL_ONLINE_LOCAL", "1")
	t.Setenv("SHELL_ONLINE_WEB", "http://localhost:4000")
	if got := defaultWebURL(); got != "http://localhost:4000" {
		t.Fatalf("defaultWebURL = %q, want the explicit override", got)
	}
}

func TestLocalSwitchIgnoresOtherValues(t *testing.T) {
	t.Setenv("SHELL_ONLINE_WEB", "")
	for _, value := range []string{"", "0", "no", "yes"} {
		t.Setenv("SHELL_ONLINE_LOCAL", value)
		if got := defaultWebURL(); got != productionAppURL {
			t.Fatalf("SHELL_ONLINE_LOCAL=%q gave %q, want production", value, got)
		}
	}
}
