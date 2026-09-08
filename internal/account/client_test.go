package account

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func decodeJSON(t *testing.T, request *http.Request, target any) {
	t.Helper()
	contents, err := io.ReadAll(request.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if err := json.Unmarshal(contents, target); err != nil {
		t.Fatalf("decode body %q: %v", contents, err)
	}
}

func writeJSON(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(body)
}

func TestExchangeStoresTokensAndAccount(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/api/cli/token" || request.Method != http.MethodPost {
				t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
			}
			writeJSON(writer, http.StatusOK, map[string]any{
				"access_token":  "sha_a",
				"refresh_token": "shr_r",
				"expires_in":    3600,
				"account":       map[string]string{"uid": "u1", "email": "ana@example.com", "name": "Ana"},
			})
		}))
	defer service.Close()

	credentials, err := NewClient(service.URL, "test").
		Exchange(context.Background(), "shc_c", "verifier", "http://127.0.0.1:1/callback", "box", "m1")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if credentials.AccessToken != "sha_a" || credentials.RefreshToken != "shr_r" {
		t.Fatalf("tokens = %+v", credentials)
	}
	if credentials.Email != "ana@example.com" {
		t.Fatalf("email = %q", credentials.Email)
	}
	if credentials.ExpiresAt.Before(time.Now().Add(50 * time.Minute)) {
		t.Fatalf("ExpiresAt = %v, want about an hour out", credentials.ExpiresAt)
	}
}

func TestExchangeSendsTheVerifierAndRedirect(t *testing.T) {
	var seen map[string]string
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			decodeJSON(t, request, &seen)
			writeJSON(writer, http.StatusOK, map[string]any{
				"access_token": "a", "refresh_token": "r", "expires_in": 60,
			})
		}))
	defer service.Close()

	if _, err := NewClient(service.URL, "test").
		Exchange(context.Background(), "code1", "verifier1", "http://127.0.0.1:9/callback", "box", "m1"); err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if seen["code"] != "code1" || seen["code_verifier"] != "verifier1" {
		t.Fatalf("payload = %+v", seen)
	}
	if seen["redirect_uri"] != "http://127.0.0.1:9/callback" || seen["label"] != "box" {
		t.Fatalf("payload = %+v", seen)
	}
	if seen["machine_id"] != "m1" {
		t.Fatalf("payload = %+v", seen)
	}
}

func TestExchangeOmitsAnAbsentMachineID(t *testing.T) {
	var seen map[string]string
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			decodeJSON(t, request, &seen)
			writeJSON(writer, http.StatusOK, map[string]any{
				"access_token": "a", "refresh_token": "r", "expires_in": 60,
			})
		}))
	defer service.Close()

	if _, err := NewClient(service.URL, "test").
		Exchange(context.Background(), "code1", "verifier1", "http://127.0.0.1:9/callback", "box", ""); err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	// An empty string is not an identifier; sending one would ask the service
	// to match on it.
	if _, present := seen["machine_id"]; present {
		t.Fatalf("payload = %+v, want no machine_id", seen)
	}
}

func TestExchangeSurfacesTheServiceErrorMessage(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writeJSON(writer, http.StatusBadRequest, map[string]string{
				"error": "authorization code replayed",
			})
		}))
	defer service.Close()

	_, err := NewClient(service.URL, "test").
		Exchange(context.Background(), "c", "v", "http://127.0.0.1:1/callback", "box", "m1")
	if err == nil {
		t.Fatal("Exchange accepted a 400")
	}
	// The service's own words are the useful part; do not bury them.
	if !strings.Contains(err.Error(), "authorization code replayed") {
		t.Fatalf("error = %v", err)
	}
}

func TestExchangeRejectsAResponseWithoutTokens(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writeJSON(writer, http.StatusOK, map[string]any{"account": map[string]string{"uid": "u1"}})
		}))
	defer service.Close()

	if _, err := NewClient(service.URL, "test").
		Exchange(context.Background(), "c", "v", "http://127.0.0.1:1/callback", "box", "m1"); err == nil {
		t.Fatal("Exchange accepted a response with no tokens")
	}
}

func TestRefreshKeepsTheRefreshTokenAndRenewsAccess(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writeJSON(writer, http.StatusOK, map[string]any{
				"access_token": "sha_new", "expires_in": 3600,
			})
		}))
	defer service.Close()

	before := Credentials{RefreshToken: "shr_keep", AccessToken: "sha_old", Email: "ana@example.com"}
	after, err := NewClient(service.URL, "test").Refresh(context.Background(), before)
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if after.AccessToken != "sha_new" {
		t.Fatalf("AccessToken = %q, want the renewed one", after.AccessToken)
	}
	if after.RefreshToken != "shr_keep" {
		t.Fatalf("RefreshToken = %q, want it preserved", after.RefreshToken)
	}
	if after.Email != "ana@example.com" {
		t.Fatalf("Email = %q, want it preserved when the service omits it", after.Email)
	}
}

func TestRefreshFailsOnRejection(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writeJSON(writer, http.StatusUnauthorized, map[string]string{"error": "refresh token revoked"})
		}))
	defer service.Close()

	_, err := NewClient(service.URL, "test").
		Refresh(context.Background(), Credentials{RefreshToken: "shr_dead"})
	if err == nil || !strings.Contains(err.Error(), "revoked") {
		t.Fatalf("error = %v, want the revocation message", err)
	}
}

func TestRegisterSessionSendsTheMetadata(t *testing.T) {
	var body map[string]any
	var authorization string
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			authorization = request.Header.Get("Authorization")
			decodeJSON(t, request, &body)
			writeJSON(writer, http.StatusCreated, map[string]any{"session": body})
		}))
	defer service.Close()

	err := NewClient(service.URL, "test").RegisterSession(context.Background(), "sha_token", SessionInput{
		ID:        "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
		ShareURL:  "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
		Command:   "claude",
		Encrypted: true,
		Host:      "ana-mbp",
		StartedAt: 1700000000,
	})
	if err != nil {
		t.Fatalf("RegisterSession: %v", err)
	}
	if authorization != "Bearer sha_token" {
		t.Fatalf("Authorization = %q", authorization)
	}
	if body["command"] != "claude" || body["encrypted"] != true {
		t.Fatalf("body = %+v", body)
	}
}

func TestCloseSessionPatchesTheSession(t *testing.T) {
	var method, path string
	var body map[string]any
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			method, path = request.Method, request.URL.Path
			decodeJSON(t, request, &body)
			writeJSON(writer, http.StatusOK, map[string]any{})
		}))
	defer service.Close()

	exitCode := 0
	if err := NewClient(service.URL, "test").
		CloseSession(context.Background(), "sha_token", "abc123def456", &exitCode); err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
	if method != http.MethodPatch {
		t.Fatalf("method = %s, want PATCH", method)
	}
	if path != "/api/sessions/abc123def456" {
		t.Fatalf("path = %q", path)
	}
	if body["exit_code"] != float64(0) {
		t.Fatalf("exit_code = %v, want 0 to be sent rather than omitted", body["exit_code"])
	}
}

func TestCloseSessionOmitsAnUnknownExitCode(t *testing.T) {
	var body map[string]any
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			decodeJSON(t, request, &body)
			writeJSON(writer, http.StatusOK, map[string]any{})
		}))
	defer service.Close()

	if err := NewClient(service.URL, "test").
		CloseSession(context.Background(), "sha_token", "abc123def456", nil); err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
	if _, present := body["exit_code"]; present {
		t.Fatalf("exit_code should be absent, got %+v", body)
	}
}

func TestClientRejectsAnInvalidBaseURL(t *testing.T) {
	_, err := NewClient("not a url", "test").
		Exchange(context.Background(), "c", "v", "http://127.0.0.1:1/callback", "box", "m1")
	if err == nil {
		t.Fatal("client accepted an invalid base URL")
	}
}

func TestClientReportsAnUnreachableService(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	address := service.URL
	service.Close()

	_, err := NewClient(address, "test").
		Exchange(context.Background(), "c", "v", "http://127.0.0.1:1/callback", "box", "m1")
	if err == nil || !strings.Contains(err.Error(), "contact accounts service") {
		t.Fatalf("error = %v, want a connection failure", err)
	}
}

func TestClientHandlesANonJSONErrorBody(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusBadGateway)
			_, _ = writer.Write([]byte("<html>gateway down</html>"))
		}))
	defer service.Close()

	_, err := NewClient(service.URL, "test").
		Exchange(context.Background(), "c", "v", "http://127.0.0.1:1/callback", "box", "m1")
	if err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("error = %v, want the status code", err)
	}
}

func TestClientSendsTheUserAgent(t *testing.T) {
	var agent string
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			agent = request.Header.Get("User-Agent")
			writeJSON(writer, http.StatusOK, map[string]any{
				"access_token": "a", "refresh_token": "r", "expires_in": 60,
			})
		}))
	defer service.Close()

	if _, err := NewClient(service.URL, "shell/1.2.3").
		Exchange(context.Background(), "c", "v", "http://127.0.0.1:1/callback", "box", "m1"); err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if agent != "shell/1.2.3" {
		t.Fatalf("User-Agent = %q", agent)
	}
}

func TestSafeShareURLKeepsTheSaltFragment(t *testing.T) {
	// The salt is not a secret. Without it the browser cannot derive the key
	// from the password, so the link published to the account would be dead.
	const withSalt = "https://shell.online/s/abc#salt=i6AaAzfYyklCDqgMRgEIDw"
	if got := SafeShareURL(withSalt); got != withSalt {
		t.Fatalf("SafeShareURL dropped the salt: %q", got)
	}
}

func TestSafeShareURLStripsARawKeyFragment(t *testing.T) {
	// "#key=" is the AES key itself. Publishing it would let the service
	// decrypt the terminal, which is the whole point of E2EE.
	got := SafeShareURL("https://shell.online/s/abc#key=AAAAAAAAAAAAAAAAAAAAAA")
	if got != "https://shell.online/s/abc" {
		t.Fatalf("SafeShareURL = %q, want the key removed", got)
	}
}

func TestSafeShareURLStripsAnUnrecognisedFragment(t *testing.T) {
	// Allowlist, not blocklist: a fragment form added later must be reviewed
	// before it can be published, rather than leaking by default.
	for _, shareURL := range []string{
		"https://shell.online/s/abc#secret=xyz",
		"https://shell.online/s/abc#saltier=xyz",
		"https://shell.online/s/abc#",
	} {
		if got := SafeShareURL(shareURL); got != "https://shell.online/s/abc" {
			t.Fatalf("SafeShareURL(%q) = %q, want the fragment removed", shareURL, got)
		}
	}
}

func TestSafeShareURLLeavesAPlainURLAlone(t *testing.T) {
	const plain = "https://shell.online/s/abc"
	if got := SafeShareURL(plain); got != plain {
		t.Fatalf("SafeShareURL = %q, want it unchanged", got)
	}
}

func TestRegisterSessionPublishesAWorkingEncryptedLink(t *testing.T) {
	var body map[string]any
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			decodeJSON(t, request, &body)
			writeJSON(writer, http.StatusCreated, map[string]any{})
		}))
	defer service.Close()

	err := NewClient(service.URL, "test").RegisterSession(context.Background(), "sha_token", SessionInput{
		ID:       "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
		ShareURL: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t#salt=i6AaAzfYyklCDqgMRgEIDw",
		Command:  "claude",
	})
	if err != nil {
		t.Fatalf("RegisterSession: %v", err)
	}
	shareURL, _ := body["share_url"].(string)
	if !strings.Contains(shareURL, "#salt=") {
		t.Fatalf("the published link cannot be opened without the salt: %q", shareURL)
	}
}

func TestPollCommandsPublishesTheKeyAndTheHarnesses(t *testing.T) {
	var query url.Values
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			query = request.URL.Query()
			writeJSON(writer, http.StatusOK, map[string]any{
				"commands": []map[string]string{{"id": "cmd_1", "kind": "start", "command": "htop"}},
			})
		}))
	defer service.Close()

	commands, err := NewClient(service.URL, "test").PollCommands(
		context.Background(), "sha_token", "AGENT_KEY", []string{"claude-code", "openclaw"})
	if err != nil {
		t.Fatalf("PollCommands: %v", err)
	}
	if len(commands) != 1 || commands[0].ID != "cmd_1" {
		t.Fatalf("commands = %+v", commands)
	}
	if got := query.Get("key"); got != "AGENT_KEY" {
		t.Fatalf("key = %q", got)
	}
	if got := query.Get("harnesses"); got != "claude-code,openclaw" {
		t.Fatalf("harnesses = %q", got)
	}
}

// A machine with none of them installed still says so. Sending nothing would
// leave the browser unable to tell "reported none" from "never reported".
func TestPollCommandsReportsAnEmptyHarnessList(t *testing.T) {
	var query url.Values
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			query = request.URL.Query()
			writeJSON(writer, http.StatusOK, map[string]any{})
		}))
	defer service.Close()

	if _, err := NewClient(service.URL, "test").PollCommands(
		context.Background(), "sha_token", "", []string{}); err != nil {
		t.Fatalf("PollCommands: %v", err)
	}
	if _, ok := query["harnesses"]; !ok {
		t.Fatalf("query = %v, want an empty harnesses parameter", query)
	}
	if got := query.Get("harnesses"); got != "" {
		t.Fatalf("harnesses = %q, want empty", got)
	}
}

// An older caller that knows nothing about harnesses sends no parameter at
// all, which the service leaves alone rather than recording as "none".
func TestPollCommandsOmitsHarnessesWhenNoneWereDetected(t *testing.T) {
	var raw string
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			raw = request.URL.RawQuery
			writeJSON(writer, http.StatusOK, map[string]any{})
		}))
	defer service.Close()

	if _, err := NewClient(service.URL, "test").PollCommands(
		context.Background(), "sha_token", "", nil); err != nil {
		t.Fatalf("PollCommands: %v", err)
	}
	if strings.Contains(raw, "harnesses") {
		t.Fatalf("query = %q, want no harnesses parameter", raw)
	}
}
