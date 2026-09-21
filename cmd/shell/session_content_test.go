package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"shell.online/internal/account"
)

func TestPublishExistingContentDeduplicatesUnchangedMaterial(t *testing.T) {
	key := testAccountKey(t)
	var writes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "content-policy"):
			_ = json.NewEncoder(w).Encode(account.SessionContentPolicy{Enabled: true, Generation: "generation", OwnerUID: "owner"})
		case strings.HasSuffix(r.URL.Path, "/key"):
			_ = json.NewEncoder(w).Encode(map[string]any{"public_key": key, "version": 1})
		case r.Method == http.MethodPut:
			writes.Add(1)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	link := &sessionLink{client: account.NewClient(server.URL, "test"), accessToken: "test", sessionID: "session",
		credentials: account.Credentials{UID: "owner", AccountKey: key, ExpiresAt: time.Now().Add(time.Hour)}}
	content := account.SessionContent{Version: 1, SuggestedTitle: "Title", Description: "Existing response", Source: "opencode-launch", ObservedAt: 1000}
	read := func(context.Context, []string, time.Time) (*account.SessionContent, error) { return &content, nil }
	link.publishExistingContentWith(context.Background(), nil, read)
	link.publishExistingContentWith(context.Background(), nil, read)
	if writes.Load() != 1 {
		t.Fatalf("unchanged content published %d times", writes.Load())
	}
	content.Description = "Changed response"
	link.publishExistingContentWith(context.Background(), nil, read)
	if writes.Load() != 2 {
		t.Fatal("changed content was not eligible")
	}
}

func TestPublishExistingContentGuardsAndEncryption(t *testing.T) {
	for _, name := range []string{
		"disabled consent", "owner mismatch", "key mismatch", "untrusted key", "closed host", "canceled",
		"daily limit", "no generation", "read unavailable", "title only", "cancel during read", "encrypted success",
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			key := testAccountKey(t)
			policy := account.SessionContentPolicy{Enabled: true, Generation: "generation-1", OwnerUID: "owner-1"}
			switch name {
			case "disabled consent":
				policy.Enabled = false
			case "owner mismatch":
				policy.OwnerUID = "another-owner"
			case "daily limit":
				policy.NextPublishAt = time.Now().Add(time.Hour).UnixMilli()
			case "no generation":
				policy.Generation = ""
			case "canceled":
				cancel()
			}
			var requests, keyReads atomic.Int32
			uploads := make(chan []byte, 2)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Header.Get("Authorization") != "Bearer test-token" {
					t.Error("missing caller authentication")
				}
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/api/cli/sessions/shell-session/content-policy":
					_ = json.NewEncoder(w).Encode(policy)
				case r.Method == http.MethodGet && r.URL.Path == "/api/account/key":
					keyReads.Add(1)
					_ = json.NewEncoder(w).Encode(map[string]any{"public_key": key, "version": 1})
				case r.Method == http.MethodPut && r.URL.Path == "/api/cli/sessions/shell-session/content":
					body, err := io.ReadAll(io.LimitReader(r.Body, 32*1024))
					if err != nil {
						t.Error(err)
					}
					uploads <- body
					w.WriteHeader(http.StatusNoContent)
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			link := &sessionLink{
				client: account.NewClient(server.URL, "synthetic-test"), accessToken: "test-token", sessionID: "shell-session",
				credentials: account.Credentials{UID: "owner-1", AccountKey: key, ExpiresAt: time.Now().Add(time.Hour)},
				warn:        io.Discard,
			}
			if name == "closed host" {
				link.contentClosed = true
			}
			if name == "key mismatch" {
				link.credentials.AccountKey = testAccountKey(t)
			}
			if name == "untrusted key" {
				link.credentials.AccountKey = ""
			}
			reads := 0
			link.publishExistingContentWith(ctx, []string{"opencode", "--pure", "-s", "ses_synthetic"}, func(ctx context.Context, argv []string, now time.Time) (*account.SessionContent, error) {
				reads++
				if ctx.Err() != nil {
					t.Fatal("read started with canceled context")
				}
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("read must have deadline")
				}
				if len(argv) != 4 || argv[3] != "ses_synthetic" {
					t.Fatal("launch binding changed")
				}
				if name == "read unavailable" {
					return nil, nil
				}
				content := &account.SessionContent{Version: 1, SuggestedTitle: "Synthetic confidential title", Description: "Synthetic confidential completed response", Source: "opencode-launch", ObservedAt: now.Add(-time.Second).UnixMilli()}
				if name == "title only" {
					content.Description = ""
				}
				if name == "cancel during read" {
					cancel()
				}
				return content, nil
			})
			switch name {
			case "closed host", "canceled":
				if requests.Load() != 0 {
					t.Fatal("closed/canceled publisher made requests")
				}
			case "disabled consent", "owner mismatch", "daily limit", "no generation":
				if requests.Load() != 1 || keyReads.Load() != 0 {
					t.Fatal("consent gate did not stop before key lookup")
				}
			}
			switch name {
			case "read unavailable", "title only", "cancel during read", "encrypted success":
				if reads != 1 {
					t.Fatal("eligible content not read exactly once")
				}
			default:
				if reads != 0 {
					t.Fatal("ineligible publisher read local content")
				}
			}
			if name != "encrypted success" {
				if len(uploads) != 0 {
					t.Fatal("ineligible publisher uploaded content")
				}
				return
			}
			if len(uploads) != 1 {
				t.Fatal("eligible publisher did not upload exactly once")
			}
			body := <-uploads
			for _, forbidden := range []string{"Synthetic confidential", "suggestedTitle", "description", "opencode-launch", "ses_synthetic"} {
				if strings.Contains(string(body), forbidden) {
					t.Fatal("upload exposed plaintext content or provider binding")
				}
			}
			var uploaded account.SessionContentUpload
			if json.Unmarshal(body, &uploaded) != nil || !strings.HasPrefix(uploaded.Sealed, "sc1.") || uploaded.SenderPublicKey == "" || uploaded.Generation != policy.Generation || uploaded.ObservedAt <= 0 {
				t.Fatal("missing authenticated encrypted envelope")
			}
			var fields map[string]any
			_ = json.Unmarshal(body, &fields)
			if len(fields) != 4 {
				t.Fatal("unexpected outbound metadata fields")
			}
		})
	}
}
