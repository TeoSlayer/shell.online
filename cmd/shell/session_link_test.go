package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"shell.online/internal/account"
)

func sampleSessionInput() account.SessionInput {
	return account.SessionInput{
		ID:        "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
		ShareURL:  "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
		Command:   "claude",
		Encrypted: true,
	}
}

func TestOpenSessionLinkReturnsNilWhenNotSignedIn(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "absent.json"))
	var warn bytes.Buffer

	if link := openSessionLink(context.Background(), &warn); link != nil {
		t.Fatal("a machine that is not signed in must produce no link")
	}
	// Not being signed in is the normal case; it must stay silent.
	if warn.Len() != 0 {
		t.Fatalf("openSessionLink warned unnecessarily: %q", warn.String())
	}
}

func TestNilLinkMethodsAreSafe(t *testing.T) {
	// The launch path calls these unconditionally, so nil must be inert.
	var link *sessionLink
	link.Register(context.Background(), sampleSessionInput(), "")
	exitCode := 0
	link.Close(&exitCode)
}

func TestRegisterPublishesTheSession(t *testing.T) {
	var received map[string]any
	var authorization string
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			authorization = request.Header.Get("Authorization")
			_ = json.NewDecoder(request.Body).Decode(&received)
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{}`))
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	if link == nil {
		t.Fatal("expected a link for a signed-in machine")
	}
	link.Register(context.Background(), sampleSessionInput(), "")

	if authorization != "Bearer sha_access" {
		t.Fatalf("Authorization = %q", authorization)
	}
	if received["command"] != "claude" {
		t.Fatalf("payload = %+v", received)
	}
	if received["host"] == "" {
		t.Fatal("host should be filled in from the machine")
	}
	if received["started_at"] == nil {
		t.Fatal("started_at should be filled in when absent")
	}
	if warn.Len() != 0 {
		t.Fatalf("a successful register should stay silent, got %q", warn.String())
	}
}

func TestRegisterWarnsButDoesNotFailTheLaunch(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusInternalServerError)
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	link.Register(context.Background(), sampleSessionInput(), "")

	if !strings.Contains(warn.String(), "will not appear in your account") {
		t.Fatalf("warning = %q", warn.String())
	}
}

func TestCloseIsSkippedWhenRegistrationNeverSucceeded(t *testing.T) {
	var closeCalls atomic.Int32
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			if request.Method == http.MethodPatch {
				closeCalls.Add(1)
			}
			writer.WriteHeader(http.StatusInternalServerError)
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	link.Register(context.Background(), sampleSessionInput(), "")

	exitCode := 0
	link.Close(&exitCode)

	if closeCalls.Load() != 0 {
		t.Fatal("closing a session that was never registered would 404 for no reason")
	}
}

func TestCloseMarksTheSessionFinished(t *testing.T) {
	var patchedPath string
	var patchedBody map[string]any
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			if request.Method == http.MethodPatch {
				patchedPath = request.URL.Path
				_ = json.NewDecoder(request.Body).Decode(&patchedBody)
			}
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{}`))
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	input := sampleSessionInput()
	link.Register(context.Background(), input, "")

	exitCode := 3
	link.Close(&exitCode)

	if patchedPath != "/api/sessions/"+input.ID {
		t.Fatalf("patched %q", patchedPath)
	}
	if patchedBody["exit_code"] != float64(3) {
		t.Fatalf("exit_code = %v, want 3", patchedBody["exit_code"])
	}
}

func TestCloseRunsEvenAfterTheProcessContextIsCancelled(t *testing.T) {
	// A session ends by its context being cancelled. Close must not inherit it.
	var patched atomic.Bool
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			if request.Method == http.MethodPatch {
				patched.Store(true)
			}
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{}`))
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	ctx, cancel := context.WithCancel(context.Background())
	var warn bytes.Buffer
	link := openSessionLink(ctx, &warn)
	link.Register(ctx, sampleSessionInput(), "")
	cancel()

	exitCode := 0
	link.Close(&exitCode)

	if !patched.Load() {
		t.Fatal("Close did not reach the service after the process context ended")
	}
}

func TestExpiredCredentialsAreRefreshedAndPersisted(t *testing.T) {
	var refreshed atomic.Bool
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("Content-Type", "application/json")
			if request.URL.Path == "/api/cli/refresh" {
				refreshed.Store(true)
				_, _ = writer.Write([]byte(`{"access_token":"sha_fresh","expires_in":3600}`))
				return
			}
			if request.Header.Get("Authorization") != "Bearer sha_fresh" {
				t.Errorf("register used a stale token: %q", request.Header.Get("Authorization"))
			}
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{}`))
		}))
	defer service.Close()

	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv("SHELL_ONLINE_CONFIG", path)
	if err := account.Save(path, account.Credentials{
		Server:       service.URL,
		AccessToken:  "sha_stale",
		RefreshToken: "shr_refresh",
		ExpiresAt:    time.Now().Add(-time.Hour),
		Email:        "ana@example.com",
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	if link == nil {
		t.Fatalf("expected a link after refresh; warnings %q", warn.String())
	}
	link.Register(context.Background(), sampleSessionInput(), "")

	if !refreshed.Load() {
		t.Fatal("a stale access token should have been refreshed")
	}
	stored, err := account.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if stored.AccessToken != "sha_fresh" {
		t.Fatalf("renewed token was not persisted, got %q", stored.AccessToken)
	}
}

func TestRefreshFailureDisablesPublishingWithoutFailingTheLaunch(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusUnauthorized)
			_, _ = writer.Write([]byte(`{"error":"refresh token revoked"}`))
		}))
	defer service.Close()

	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv("SHELL_ONLINE_CONFIG", path)
	if err := account.Save(path, account.Credentials{
		Server:       service.URL,
		RefreshToken: "shr_dead",
		ExpiresAt:    time.Now().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)

	if link != nil {
		t.Fatal("a revoked account must not produce a live link")
	}
	if !strings.Contains(warn.String(), "will not appear in your account") {
		t.Fatalf("warning = %q", warn.String())
	}
}

func TestSharingUsesTheServiceRecordedAtLoginNotTheEnvironment(t *testing.T) {
	// Linking is per machine, not per terminal. A shell started later, in a
	// window that never exported SHELL_ONLINE_ACCOUNTS, must still publish to
	// the service the login was approved against.
	var reached bool
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			reached = true
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{}`))
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	t.Setenv("SHELL_ONLINE_ACCOUNTS", "http://127.0.0.1:1/never-used")

	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	if link == nil {
		t.Fatalf("a linked machine must produce a link; warnings %q", warn.String())
	}
	link.Register(context.Background(), sampleSessionInput(), "")

	if !reached {
		t.Fatal("the share was not published to the service recorded at login")
	}
	if warn.Len() != 0 {
		t.Fatalf("publishing warned unexpectedly: %q", warn.String())
	}
}

func TestEveryShellInvocationPublishesOnALinkedMachine(t *testing.T) {
	// "Running a terminal with shell is intentional." Three separate shares,
	// as three separate terminals would produce, must all arrive.
	var published []string
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			var body struct {
				ID string `json:"id"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			published = append(published, body.ID)
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{}`))
		}))
	defer service.Close()

	linkedAccount(t, service.URL)

	for _, id := range []string{
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
		"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
	} {
		var warn bytes.Buffer
		// A fresh openSessionLink per share is exactly what a new terminal does.
		link := openSessionLink(context.Background(), &warn)
		input := sampleSessionInput()
		input.ID = id
		link.Register(context.Background(), input, "")
	}

	if len(published) != 3 {
		t.Fatalf("published %d of 3 shares: %v", len(published), published)
	}
}

func TestPublishedLinkKeepsTheSaltSoItCanBeOpened(t *testing.T) {
	var shareURL string
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			var body struct {
				ShareURL string `json:"share_url"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			shareURL = body.ShareURL
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{}`))
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	input := sampleSessionInput()
	input.ShareURL += "#salt=i6AaAzfYyklCDqgMRgEIDw"
	link.Register(context.Background(), input, "")

	if !strings.Contains(shareURL, "#salt=") {
		t.Fatalf("a link without its salt cannot be opened from the web app: %q", shareURL)
	}
}

// A browser-started session runs as `shell sh -c "<command>"`, so this
// process's argv is the shell rather than the thing anybody asked for.
// Publishing the argv recorded `sh -c "claude ..."`, which made every
// browser-started session read as a plain terminal process: the program being
// run is the second word.
func TestRequestedCommandReplacesTheShellWrapper(t *testing.T) {
	t.Setenv(sessionCommandEnvironment, "claude --dangerously-skip-permissions")
	if got := sessionCommandFromEnvironment(); got != "claude --dangerously-skip-permissions" {
		t.Fatalf("requested command = %q", got)
	}
}

func TestRequestedCommandIsAbsentByDefault(t *testing.T) {
	t.Setenv(sessionCommandEnvironment, "")
	if got := sessionCommandFromEnvironment(); got != "" {
		t.Fatalf("requested command = %q, want empty so the argv stands", got)
	}
}

// Surrounding whitespace comes from the environment, not from the person.
func TestRequestedCommandIsTrimmed(t *testing.T) {
	t.Setenv(sessionCommandEnvironment, "  claude  ")
	if got := sessionCommandFromEnvironment(); got != "claude" {
		t.Fatalf("requested command = %q", got)
	}
}

// The reporter renews under the link's lock. Copies taken outside it let two
// renewals refresh at once, race one fixed credentials.json.tmp file, and let a
// stale copy overwrite a newer token (or a pinned vault key). One expired
// credential and eight concurrent callers must produce exactly one refresh and
// one stored token.
func TestReportCredentialSerializesRefreshAndSave(t *testing.T) {
	var mu sync.Mutex
	refreshes := 0
	service := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/cli/refresh" {
			t.Errorf("unexpected path %s", request.URL.Path)
			return
		}
		mu.Lock()
		refreshes += 1
		issued := refreshes
		mu.Unlock()
		/* Widen the window in which an unserialized refresh would overlap. */
		time.Sleep(30 * time.Millisecond)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"access_token":"fresh-%d","refresh_token":"old-refresh","expires_in":3600,"account":{"uid":"uid-1","email":"a@b.c","name":"A"}}`, issued)
	}))
	defer service.Close()

	path := filepath.Join(t.TempDir(), "credentials.json")
	link := &sessionLink{
		client:      account.NewClient(service.URL, "test/1"),
		accessToken: "stale-token",
		sessionID:   "session-1",
		warn:        io.Discard,
		path:        path,
		credentials: account.Credentials{
			Server: service.URL, AccessToken: "stale-token", RefreshToken: "old-refresh",
			ExpiresAt: time.Now().Add(-time.Minute), UID: "uid-1",
		},
	}

	const workers = 8
	tokens := make([]string, workers)
	var wg sync.WaitGroup
	for index := 0; index < workers; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			tokens[index], _ = link.reportCredential(context.Background(), false)
		}(index)
	}
	wg.Wait()

	mu.Lock()
	count := refreshes
	mu.Unlock()
	if count != 1 {
		t.Fatalf("refresh calls = %d, want 1: refresh and save must be serialized", count)
	}
	for index, token := range tokens {
		if token != "fresh-1" {
			t.Fatalf("caller %d saw token %q, want the one renewed token", index, token)
		}
	}
	saved, err := account.Load(path)
	if err != nil {
		t.Fatalf("load saved credentials: %v", err)
	}
	if saved.AccessToken != "fresh-1" {
		t.Fatalf("saved token = %q, want fresh-1", saved.AccessToken)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("a credentials temp file was left behind: %v", err)
	}
}

// After Close there is no session to report for, and the link is the thing that
// knows it. The reporter must drop the batch rather than refresh and send late.
func TestMcpFlowReporterDropsAfterClose(t *testing.T) {
	var posts int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/cli/refresh", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"fresh","refresh_token":"refresh","expires_in":3600,"account":{"uid":"uid-1"}}`))
	})
	mux.HandleFunc("/api/cli/sessions/session-1/mcp-flows", func(writer http.ResponseWriter, request *http.Request) {
		atomic.AddInt32(&posts, 1)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"accepted":true}`))
	})
	mux.HandleFunc("/api/sessions/session-1", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{}`))
	})
	service := httptest.NewServer(mux)
	defer service.Close()

	link := &sessionLink{
		client:      account.NewClient(service.URL, "test/1"),
		accessToken: "token",
		sessionID:   "session-1",
		warn:        io.Discard,
		credentials: account.Credentials{
			Server: service.URL, AccessToken: "token", RefreshToken: "refresh",
			ExpiresAt: time.Now().Add(time.Hour), UID: "uid-1",
		},
	}
	link.Close(nil)

	reporter := newMcpFlowReporter(link)
	reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_status", Phase: "started", At: time.Now().UnixMilli()})
	reporter.flush()
	if got := atomic.LoadInt32(&posts); got != 0 {
		t.Fatalf("reporter sent %d batches after Close", got)
	}
}
