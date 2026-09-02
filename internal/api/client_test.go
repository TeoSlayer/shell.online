package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

	session, err := NewClient(server.URL, "shell/test").CreateSession(context.Background(), "train.py", true, true, false)
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

	_, err := NewClient(server.URL, "shell/test").CreateSession(context.Background(), "train.py", true, false, false)
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

	session, err := NewClient(server.URL, "shell/test").CreateSession(context.Background(), "bash", false, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if session.Encrypted {
		t.Fatal("E2EE opt-out became encrypted")
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
