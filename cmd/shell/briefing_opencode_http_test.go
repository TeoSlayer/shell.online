package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestOpenCodeHTTPDoesNotTrustGlobalKVOrPromptAsync(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)
	kvPath := filepath.Join(t.TempDir(), "kv.json")
	if err := os.WriteFile(kvPath, []byte(`{"shell.current_session":"ses_another_tui"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	adapter := newOpenCodeHTTPAdapter(server.URL, kvPath, "unused.db")
	if adapter.supportsIdleOnlySubmit() {
		t.Fatal("plain HTTP status + prompt_async was advertised as atomic")
	}
	if _, ok := adapter.Bind(nil); ok {
		t.Fatal("trusted another TUI's global marker as this host's conversation")
	}
	if idle, ok, err := adapter.Idle(context.Background(), "ses_x"); err != nil || idle || ok {
		t.Fatalf("Idle = %v, %v, %v; must be unsupported", idle, ok, err)
	}
	if _, err := adapter.Submit(context.Background(), "ses_x", "briefing prompt"); !errors.Is(err, errBriefingNotSafe) {
		t.Fatalf("Submit = %v; must reject before any request", err)
	}
	if result, err := adapter.Result(context.Background(), "ses_x", "prompt_async"); err != nil || result != nil {
		t.Fatal("treated an uncorrelated acknowledgement as a summary")
	}
	if requests.Load() != 0 {
		t.Fatalf("unsupported adapter made %d HTTP requests", requests.Load())
	}
}

func TestStartBriefingsUnsupportedAdapterDoesNotStartPoller(t *testing.T) {
	// A nil account client is intentional: an unsupported adapter must return
	// before account polling, even with consent/port setup otherwise present.
	link := &sessionLink{sessionID: "synthetic-share"}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	link.StartBriefings(ctx, []string{"opencode", "--pure", "-s", "ses_x", "--port", "4096"})
	if newOpenCodeBriefingAdapter().supportsIdleOnlySubmit() {
		t.Fatal("unsupported runtime could start an automatic briefing loop")
	}
}
