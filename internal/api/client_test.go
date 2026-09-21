package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestCreateSessionRequestsAndVerifiesReadOnlyMode(t *testing.T) {
	const sessionID = "abcdefghijklmnopqrstuvwxyzABCDEF"
	expiresAt := time.Now().UTC().Add(time.Hour).Truncate(time.Second)

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/sessions" {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		var body struct {
			Label      string `json:"label"`
			ReadOnly   *bool  `json:"read_only"`
			Encrypted  *bool  `json:"encrypted"`
			Persistent *bool  `json:"persistent"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if body.Label != "train.py" || body.ReadOnly == nil || !*body.ReadOnly || body.Encrypted == nil || !*body.Encrypted || body.Persistent == nil || *body.Persistent {
			t.Fatalf("unexpected request body: %#v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(Session{
			ID:           sessionID,
			ShareURL:     "https://untrusted.invalid/share",
			WebSocketURL: "wss://untrusted.invalid/socket",
			HostToken:    "host-token",
			ReadOnly:     true,
			Encrypted:    true,
			ExpiresAt:    expiresAt,
		})
	}))
	defer server.Close()

	session, err := NewClient(server.URL, "shell/test").CreateSession(context.Background(), "train.py", true, true, false, false)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if !session.ReadOnly {
		t.Fatal("CreateSession returned an interactive session")
	}
	if session.ShareURL != server.URL+"/s/"+sessionID {
		t.Fatalf("ShareURL = %q", session.ShareURL)
	}
	if !strings.HasPrefix(session.WebSocketURL, "ws://") || !strings.HasSuffix(session.WebSocketURL, "/api/sessions/"+sessionID+"/ws") {
		t.Fatalf("WebSocketURL = %q", session.WebSocketURL)
	}
}

func TestCreateSessionRejectsAccessModeMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(Session{
			ID:        "abcdefghijklmnopqrstuvwxyzABCDEF",
			HostToken: "host-token",
			ReadOnly:  false,
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		})
	}))
	defer server.Close()

	_, err := NewClient(server.URL, "shell/test").CreateSession(context.Background(), "train.py", true, false, false, false)
	if err == nil || !strings.Contains(err.Error(), "wrong access mode") {
		t.Fatalf("CreateSession error = %v", err)
	}
}

func TestCreateSessionPreservesExplicitE2EEOptOut(t *testing.T) {
	const sessionID = "abcdefghijklmnopqrstuvwxyzABCDEF"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Encrypted *bool `json:"encrypted"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Encrypted == nil || *body.Encrypted {
			t.Fatalf("E2EE opt-out request = %#v", body.Encrypted)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(Session{
			ID: sessionID, HostToken: "host-token", Encrypted: false,
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		})
	}))
	defer server.Close()

	session, err := NewClient(server.URL, "shell/test").CreateSession(context.Background(), "bash", false, false, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if session.Encrypted {
		t.Fatal("E2EE opt-out became encrypted")
	}
}

func TestCreateSessionRoundTripsControlCapability(t *testing.T) {
	const sessionID = "abcdefghijklmnopqrstuvwxyzABCDEF"
	var gotControl *bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Control *bool `json:"control"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		gotControl = body.Control
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(Session{
			ID: sessionID, HostToken: "host-token", Control: true,
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		})
	}))
	defer server.Close()

	session, err := NewClient(server.URL, "shell/test").CreateSession(context.Background(), "bash", false, false, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if gotControl == nil || !*gotControl {
		t.Fatalf("request did not advertise control: %#v", gotControl)
	}
	if !session.Control {
		t.Fatal("CreateSession did not report the control capability")
	}

	// A server that reports no control when control was requested degrades to observe-only.
	fallback := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(Session{
			ID: sessionID, HostToken: "host-token", Control: false,
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		})
	}))
	defer fallback.Close()
	session, err = NewClient(fallback.URL, "shell/test").CreateSession(context.Background(), "bash", false, false, false, true)
	if err != nil {
		t.Fatalf("observe-only fallback CreateSession: %v", err)
	}
	if session.Control {
		t.Fatal("fallback session reported the control capability")
	}

	// The impossible mismatch (server claims control the client did not request) is rejected.
	mismatch := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(Session{
			ID: sessionID, HostToken: "host-token", Control: true,
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		})
	}))
	defer mismatch.Close()
	if _, err := NewClient(mismatch.URL, "shell/test").CreateSession(context.Background(), "bash", false, false, false, false); err == nil || !strings.Contains(err.Error(), "wrong control capability") {
		t.Fatalf("control mismatch error = %v", err)
	}
}

// TestCreateSessionFallsBackToObserveOnlyWhenControlOmitted covers the mixed-version case: an
// older server that does not know the control field omits it entirely; the client must succeed
// in observe-only mode rather than rejecting the session.
func TestCreateSessionFallsBackToObserveOnlyWhenControlOmitted(t *testing.T) {
	const sessionID = "abcdefghijklmnopqrstuvwxyzABCDEF"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"session_id": sessionID,
			"host_token": "host-token",
			"expires_at": time.Now().UTC().Add(time.Hour).Format(time.RFC3339),
		})
	}))
	defer server.Close()

	session, err := NewClient(server.URL, "shell/test").CreateSession(context.Background(), "bash", false, false, false, true)
	if err != nil {
		t.Fatalf("CreateSession against a control-omitting server: %v", err)
	}
	if session.Control {
		t.Fatal("observe-only fallback reported the control capability")
	}
	if session.ID != sessionID || session.HostToken != "host-token" {
		t.Fatalf("fallback session = %#v", session)
	}
}

func TestResumeSessionPreservesStableCredentials(t *testing.T) {
	const sessionID = "abcdefghijklmnopqrstuvwxyzABCDEF"
	const hostToken = "a-stable-host-token-that-is-long-enough"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/sessions/resume" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["session_id"] != sessionID || body["host_token"] != hostToken {
			t.Fatalf("body = %#v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(Session{
			ID: sessionID, HostToken: hostToken, ReadOnly: true, Encrypted: true, Persistent: true,
			ExpiresAt: time.Now().Add(30 * 24 * time.Hour),
		})
	}))
	defer server.Close()
	seed := Session{ID: sessionID, HostToken: hostToken, ReadOnly: true, Encrypted: true, Persistent: true}
	session, err := NewClient(server.URL, "shell/test").ResumeSession(context.Background(), "bash", seed)
	if err != nil {
		t.Fatal(err)
	}
	if session.ShareURL != server.URL+"/s/"+sessionID || !strings.HasPrefix(session.WebSocketURL, "ws://") {
		t.Fatalf("session URLs = %q %q", session.ShareURL, session.WebSocketURL)
	}
}

func TestRequireSecureBase(t *testing.T) {
	cases := []struct {
		rawurl string
		ok     bool
	}{
		{"https://shell.online", true},
		{"https://api.shell.online", true},
		{"http://127.0.0.1:8787", true},
		{"http://localhost:8787", true},
		{"http://[::1]:8787", true},
		{"http://shell.online", false},
		{"http://example.com", false},
		{"ftp://shell.online", false},
	}
	for _, c := range cases {
		u, err := url.Parse(c.rawurl)
		if err != nil {
			t.Fatalf("parse %q: %v", c.rawurl, err)
		}
		if got := requireSecureBase(u); (got == nil) != c.ok {
			t.Errorf("requireSecureBase(%q) ok = %v, want %v", c.rawurl, got == nil, c.ok)
		}
	}
}

func TestRejectInsecureRedirect(t *testing.T) {
	httpsOrigin := &http.Request{URL: &url.URL{Scheme: "https", Host: "shell.online"}}
	loopbackOrigin := &http.Request{URL: &url.URL{Scheme: "http", Host: "localhost:8787"}}
	cases := []struct {
		name    string
		req     *http.Request
		via     []*http.Request
		wantErr bool
	}{
		{
			name:    "https to http non-loopback is rejected",
			req:     &http.Request{URL: &url.URL{Scheme: "http", Host: "shell.online"}},
			via:     []*http.Request{httpsOrigin},
			wantErr: true,
		},
		{
			name:    "https to http loopback is allowed (dev)",
			req:     &http.Request{URL: &url.URL{Scheme: "http", Host: "127.0.0.1:8787"}},
			via:     []*http.Request{httpsOrigin},
			wantErr: false,
		},
		{
			name:    "https to https is allowed",
			req:     &http.Request{URL: &url.URL{Scheme: "https", Host: "shell.online"}},
			via:     []*http.Request{httpsOrigin},
			wantErr: false,
		},
		{
			name:    "http to http non-loopback is rejected",
			req:     &http.Request{URL: &url.URL{Scheme: "http", Host: "example.com"}},
			via:     []*http.Request{{URL: &url.URL{Scheme: "http", Host: "example.com"}}},
			wantErr: true,
		},
		{
			name:    "http loopback to http remote is rejected (frame key)",
			req:     &http.Request{URL: &url.URL{Scheme: "http", Host: "remote.example"}},
			via:     []*http.Request{loopbackOrigin},
			wantErr: true,
		},
		{
			name:    "http loopback to http loopback is allowed (dev)",
			req:     &http.Request{URL: &url.URL{Scheme: "http", Host: "127.0.0.1:8787"}},
			via:     []*http.Request{loopbackOrigin},
			wantErr: false,
		},
	}
	for _, c := range cases {
		if got := rejectInsecureRedirect(c.req, c.via); (got != nil) != c.wantErr {
			t.Errorf("%s: rejectInsecureRedirect err = %v, wantErr %v", c.name, got, c.wantErr)
		}
	}
}

func TestCreateMcpGrantRefusesNonHTTPSNonLoopback(t *testing.T) {
	session := Session{ID: "abcdefghijklmnopqrstuvwxyzABCDEF", HostToken: "host-token"}
	client := NewClient("http://shell.online", "shell/test")
	_, err := client.CreateMcpGrant(context.Background(), session, "codex", []string{"observe"}, 0, make([]byte, 32))
	if err == nil || !strings.Contains(err.Error(), "requires https") {
		t.Fatalf("CreateMcpGrant error = %v", err)
	}
}

func TestCreateMcpGrantOverLoopbackHTTP(t *testing.T) {
	const sessionID = "abcdefghijklmnopqrstuvwxyzABCDEF"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/sessions/"+sessionID+"/mcp/grant" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		var body struct {
			FrameKey string `json:"frame_key"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.FrameKey == "" {
			t.Fatal("frame key was not sent in the grant body")
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(McpGrantCreated{
			GrantID:   "grant-1",
			Bearer:    "opaque-bearer",
			ExpiresAt: time.Now().Add(time.Hour),
		})
	}))
	defer server.Close()

	session := Session{ID: sessionID, HostToken: "host-token"}
	grant, err := NewClient(server.URL, "shell/test").CreateMcpGrant(
		context.Background(), session, "codex", []string{"observe"}, 0, make([]byte, 32),
	)
	if err != nil {
		t.Fatalf("CreateMcpGrant: %v", err)
	}
	if grant.Bearer != "opaque-bearer" {
		t.Fatalf("bearer = %q", grant.Bearer)
	}
}
