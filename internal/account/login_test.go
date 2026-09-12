package account

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func callbackRequest(query string) *http.Request {
	return httptest.NewRequest(http.MethodGet, "/callback?"+query, nil)
}

func TestCallbackHandlerAcceptsAMatchingState(t *testing.T) {
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "", results)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, callbackRequest("code=shc_abc&state=state-123"))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "You are signed in.") {
		t.Fatalf("body did not confirm sign-in: %s", recorder.Body.String())
	}
	result := <-results
	if result.err != nil {
		t.Fatalf("unexpected error: %v", result.err)
	}
	if result.code != "shc_abc" {
		t.Fatalf("code = %q, want shc_abc", result.code)
	}
}

func TestCallbackHandlerRejectsAMismatchedState(t *testing.T) {
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "", results)

	recorder := httptest.NewRecorder()
	// This is the check that stops another page's callback completing our login.
	handler.ServeHTTP(recorder, callbackRequest("code=shc_attacker&state=state-999"))

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	result := <-results
	if result.err == nil {
		t.Fatal("a mismatched state must not resolve the login")
	}
	if result.code != "" {
		t.Fatalf("code must be discarded, got %q", result.code)
	}
}

func TestCallbackHandlerRejectsAMissingState(t *testing.T) {
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "", results)

	handler.ServeHTTP(httptest.NewRecorder(), callbackRequest("code=shc_abc"))

	if result := <-results; result.err == nil {
		t.Fatal("a callback with no state must not resolve the login")
	}
}

func TestCallbackHandlerReportsAnAuthorizationError(t *testing.T) {
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "", results)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, callbackRequest(
		"error=access_denied&error_description="+url.QueryEscape("you declined the request")))

	result := <-results
	if result.err == nil {
		t.Fatal("an error callback must fail the login")
	}
	if !strings.Contains(result.err.Error(), "you declined the request") {
		t.Fatalf("error should carry the description, got %v", result.err)
	}
	if !strings.Contains(recorder.Body.String(), "you declined the request") {
		t.Fatalf("page should show the description, got %s", recorder.Body.String())
	}
}

func TestCallbackHandlerEscapesAuthorizationErrors(t *testing.T) {
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "", results)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, callbackRequest(
		"error=access_denied&error_description="+url.QueryEscape(`<img src=x onerror="alert(1)">`)))

	<-results
	body := recorder.Body.String()
	if strings.Contains(body, "<img") || strings.Contains(body, "onerror=\"") {
		t.Fatalf("page rendered callback markup: %s", body)
	}
	if !strings.Contains(body, "&lt;img") {
		t.Fatalf("page did not render the escaped description: %s", body)
	}
	if policy := recorder.Header().Get("Content-Security-Policy"); !strings.Contains(policy, "default-src 'none'") {
		t.Fatalf("callback page has no restrictive CSP: %q", policy)
	}
}

func TestCallbackHandlerRejectsAMissingCode(t *testing.T) {
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "", results)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, callbackRequest("state=state-123"))

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if result := <-results; result.err == nil {
		t.Fatal("a callback with no code must fail the login")
	}
}

func TestCallbackHandlerResolvesOnlyOnce(t *testing.T) {
	// A browser refresh must not push a second result and wedge the flow.
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "", results)

	handler.ServeHTTP(httptest.NewRecorder(), callbackRequest("code=shc_abc&state=state-123"))
	handler.ServeHTTP(httptest.NewRecorder(), callbackRequest("code=shc_def&state=state-123"))

	if result := <-results; result.code != "shc_abc" {
		t.Fatalf("first code = %q, want shc_abc", result.code)
	}
	select {
	case extra := <-results:
		t.Fatalf("handler delivered a second result: %+v", extra)
	default:
	}
}

func TestCallbackHandlerIgnoresOtherPaths(t *testing.T) {
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "", results)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/favicon.ico", nil))

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
	select {
	case result := <-results:
		t.Fatalf("an unrelated path resolved the login: %+v", result)
	default:
	}
}

func TestAuthorizeURL(t *testing.T) {
	built := AuthorizeURL("http://localhost:5173/", "http://127.0.0.1:4000/callback", "st", "ch")
	parsed, err := url.Parse(built)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if parsed.Path != "/cli/authorize" {
		t.Fatalf("path = %q, want /cli/authorize", parsed.Path)
	}
	query := parsed.Query()
	for key, want := range map[string]string{
		"redirect_uri":          "http://127.0.0.1:4000/callback",
		"state":                 "st",
		"code_challenge":        "ch",
		"code_challenge_method": "S256",
	} {
		if got := query.Get(key); got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}
}

func TestAuthorizeURLTrimsTrailingSlashes(t *testing.T) {
	built := AuthorizeURL("http://localhost:5173///", "http://127.0.0.1:4000/callback", "s", "c")
	if !strings.HasPrefix(built, "http://localhost:5173/cli/authorize?") {
		t.Fatalf("built = %q, want a single slash before cli/authorize", built)
	}
}

func TestLoginRejectsAnInvalidWebURL(t *testing.T) {
	client := NewClient("http://127.0.0.1:1", "test")
	_, err := Login(context.Background(), client, Options{WebURL: "not a url"})
	if err == nil {
		t.Fatal("Login accepted an invalid web URL")
	}
}

func TestLoginTimesOutWhenTheBrowserNeverReturns(t *testing.T) {
	client := NewClient("http://127.0.0.1:1", "test")
	_, err := Login(context.Background(), client, Options{
		WebURL:      "http://localhost:5173",
		Timeout:     150 * time.Millisecond,
		OpenBrowser: func(string) error { return nil },
	})
	if err == nil {
		t.Fatal("Login should time out")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("error = %v, want a timeout", err)
	}
}

func TestLoginStopsWhenTheContextIsCancelled(t *testing.T) {
	client := NewClient("http://127.0.0.1:1", "test")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := Login(ctx, client, Options{
		WebURL:      "http://localhost:5173",
		Timeout:     5 * time.Second,
		OpenBrowser: func(string) error { return nil },
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestLoginSurvivesABrowserThatWillNotOpen(t *testing.T) {
	// A headless box has no opener. The URL is printed instead, not fatal.
	client := NewClient("http://127.0.0.1:1", "test")
	var output strings.Builder
	_, err := Login(context.Background(), client, Options{
		WebURL:      "http://localhost:5173",
		Timeout:     150 * time.Millisecond,
		Output:      &output,
		OpenBrowser: func(string) error { return errors.New("no display") },
	})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("error = %v, want a timeout rather than an opener failure", err)
	}
	if !strings.Contains(output.String(), "/cli/authorize?") {
		t.Fatalf("the fallback URL was not printed, got %q", output.String())
	}
}

func TestLoginCompletesThroughTheLoopbackListener(t *testing.T) {
	// End to end: Login opens the listener, a stand-in browser calls back, and
	// the code is exchanged against a stand-in accounts service.
	var exchanged struct {
		code, verifier, redirectURI, machineID string
	}
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/api/cli/token" {
				http.NotFound(writer, request)
				return
			}
			var body struct {
				Code        string `json:"code"`
				Verifier    string `json:"code_verifier"`
				RedirectURI string `json:"redirect_uri"`
				MachineID   string `json:"machine_id"`
			}
			decodeJSON(t, request, &body)
			exchanged.code = body.Code
			exchanged.verifier = body.Verifier
			exchanged.redirectURI = body.RedirectURI
			exchanged.machineID = body.MachineID
			writeJSON(writer, http.StatusOK, map[string]any{
				"access_token":  "sha_new",
				"refresh_token": "shr_new",
				"expires_in":    3600,
				"account":       map[string]string{"uid": "uid-1", "email": "ana@example.com", "name": "Ana"},
			})
		}))
	defer service.Close()

	credentials, err := Login(context.Background(), NewClient(service.URL, "test"), Options{
		WebURL:    "http://localhost:5173",
		Label:     "test-box",
		MachineID: "machine-under-test",
		Timeout:   5 * time.Second,
		OpenBrowser: func(target string) error {
			parsed, parseErr := url.Parse(target)
			if parseErr != nil {
				return parseErr
			}
			query := parsed.Query()
			// Act as the browser: hit the loopback callback with the state.
			go func() {
				callback := query.Get("redirect_uri") +
					"?code=shc_from_browser&state=" + url.QueryEscape(query.Get("state"))
				response, requestErr := http.Get(callback)
				if requestErr == nil {
					_ = response.Body.Close()
				}
			}()
			return nil
		},
	})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if credentials.AccessToken != "sha_new" || credentials.RefreshToken != "shr_new" {
		t.Fatalf("tokens not stored: %+v", credentials)
	}
	if credentials.Email != "ana@example.com" || credentials.UID != "uid-1" {
		t.Fatalf("account not stored: %+v", credentials)
	}
	if credentials.Server != service.URL {
		t.Fatalf("Server = %q, want %q", credentials.Server, service.URL)
	}
	if credentials.Expired(time.Now()) {
		t.Fatal("a freshly issued token must not read as expired")
	}
	if exchanged.code != "shc_from_browser" {
		t.Fatalf("exchanged code = %q", exchanged.code)
	}
	if Challenge(exchanged.verifier) == "" || len(exchanged.verifier) < 43 {
		t.Fatalf("verifier was not sent intact: %q", exchanged.verifier)
	}
	if exchanged.machineID != "machine-under-test" {
		t.Fatalf("machine_id = %q, want the one Login was given", exchanged.machineID)
	}
	if !strings.HasPrefix(exchanged.redirectURI, "http://127.0.0.1:") {
		t.Fatalf("redirect_uri = %q, want a loopback callback", exchanged.redirectURI)
	}
}

func TestLoginFailsWhenTheBrowserReturnsAForeignState(t *testing.T) {
	client := NewClient("http://127.0.0.1:1", "test")
	_, err := Login(context.Background(), client, Options{
		WebURL:  "http://localhost:5173",
		Timeout: 5 * time.Second,
		OpenBrowser: func(target string) error {
			parsed, parseErr := url.Parse(target)
			if parseErr != nil {
				return parseErr
			}
			go func() {
				callback := parsed.Query().Get("redirect_uri") + "?code=shc_evil&state=not-ours"
				response, requestErr := http.Get(callback)
				if requestErr == nil {
					_ = response.Body.Close()
				}
			}()
			return nil
		},
	})
	if err == nil {
		t.Fatal("Login accepted a callback with a foreign state")
	}
	if !strings.Contains(err.Error(), "state did not match") {
		t.Fatalf("error = %v, want a state mismatch", err)
	}
}

func TestNoBrowserPrintsTheURLWithoutOpeningAnything(t *testing.T) {
	// A headless machine has no opener, and an agent drives its own browser.
	// Neither should have a window forced on them.
	opened := false
	client := NewClient("http://127.0.0.1:1", "test")
	var output strings.Builder

	_, err := Login(context.Background(), client, Options{
		WebURL:      "http://localhost:5173",
		Timeout:     150 * time.Millisecond,
		Output:      &output,
		NoBrowser:   true,
		OpenBrowser: func(string) error { opened = true; return nil },
	})

	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("error = %v, want a timeout", err)
	}
	if opened {
		t.Fatal("NoBrowser must not launch a browser")
	}
	if !strings.Contains(output.String(), "/cli/authorize?") {
		t.Fatalf("the URL must still be printed, got %q", output.String())
	}
	if strings.Contains(output.String(), "Opening your browser") {
		t.Fatalf("output should not claim to open a browser, got %q", output.String())
	}
}

// A person who has just linked a terminal wants the app, not a dead-end page
// telling them to go back to the terminal they are about to leave.
func TestCallbackSendsTheBrowserToTheSessionsPage(t *testing.T) {
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "http://localhost:5173", results)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet, "/callback?code=abc&state=state-123", nil))

	if recorder.Code != http.StatusSeeOther {
		t.Fatalf("expected a redirect, got %d", recorder.Code)
	}
	if location := recorder.Header().Get("Location"); location != "http://localhost:5173/sessions?linked=1" {
		t.Fatalf("unexpected redirect target %q", location)
	}
	// The code still has to reach the CLI, redirect or no redirect.
	if result := <-results; result.code != "abc" {
		t.Fatalf("expected the code to be delivered, got %+v", result)
	}
}

// Without somewhere sensible to send them, the plain page is still served
// rather than a broken Location header.
func TestCallbackFallsBackToThePlainPage(t *testing.T) {
	for _, webURL := range []string{"", "not a url", "/sessions", "file:///etc/passwd", "javascript:alert(1)"} {
		results := make(chan callbackResult, 1)
		handler := newCallbackHandler("state-123", webURL, results)

		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(
			http.MethodGet, "/callback?code=abc&state=state-123", nil))

		if recorder.Code != http.StatusOK {
			t.Fatalf("web URL %q: expected the plain page, got %d", webURL, recorder.Code)
		}
		if location := recorder.Header().Get("Location"); location != "" {
			t.Fatalf("web URL %q: should not redirect, got %q", webURL, location)
		}
		if result := <-results; result.code != "abc" {
			t.Fatalf("web URL %q: expected the code to be delivered", webURL)
		}
	}
}

// A failed sign-in keeps the page that says what went wrong, because the
// sessions page has nowhere to show it.
func TestCallbackKeepsThePageOnFailure(t *testing.T) {
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "http://localhost:5173", results)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet, "/callback?error=access_denied&error_description=You+declined.", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected the failure page, got %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "You declined.") {
		t.Fatalf("the reason should be on the page, got: %s", recorder.Body.String())
	}
}
