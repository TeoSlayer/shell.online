package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"shell.online/internal/account"
)

// fakeBriefingAdapter is a synthetic adapter for the coordinator tests. No real
// agent is prompted; the test controls every boundary.
type fakeBriefingAdapter struct {
	name        string
	bindID      string
	bindOK      bool
	idle        bool
	idleOK      bool
	submitErr   error
	ack         string
	result      *Briefing
	onIdle      func()
	onResult    func()
	submits     atomic.Int32
	idleCalls   atomic.Int32
	resultCalls atomic.Int32
}

func (f *fakeBriefingAdapter) Name() string { return f.name }
func (f *fakeBriefingAdapter) Bind(argv []string) (string, bool) {
	return f.bindID, f.bindOK
}
func (f *fakeBriefingAdapter) Idle(ctx context.Context, sessionID string) (bool, bool, error) {
	f.idleCalls.Add(1)
	if f.onIdle != nil {
		f.onIdle()
	}
	return f.idle, f.idleOK, nil
}
func (f *fakeBriefingAdapter) Submit(ctx context.Context, sessionID, prompt string) (string, error) {
	f.submits.Add(1)
	return f.ack, f.submitErr
}
func (f *fakeBriefingAdapter) Result(ctx context.Context, sessionID, ack string) (*Briefing, error) {
	f.resultCalls.Add(1)
	if f.onResult != nil {
		f.onResult()
	}
	return f.result, nil
}

// testBriefingEnv stands up the synthetic accounts endpoints the coordinator
// touches (policy, vault key, publish) and returns the server URL + upload count.
// The vault key is shared with the test credentials so the trusted-key gate passes.
func testBriefingEnv(t *testing.T, policy account.SessionContentPolicy, key string) (string, *atomic.Int32) {
	t.Helper()
	var uploads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "content-policy"):
			_ = json.NewEncoder(w).Encode(policy)
		case strings.HasSuffix(r.URL.Path, "/key"):
			_ = json.NewEncoder(w).Encode(map[string]any{"public_key": key, "version": 1})
		case r.Method == http.MethodPut:
			uploads.Add(1)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server.URL, &uploads
}

func testCoordinator(t *testing.T, adapter BriefingAdapter, serverURL, statePath string) *BriefingCoordinator {
	t.Helper()
	return &BriefingCoordinator{
		adapter:   adapter,
		client:    account.NewClient(serverURL, "test"),
		sessionID: "shell-session",
		statePath: statePath,
		prompt:    "briefing prompt",
		now:       func() time.Time { return time.UnixMilli(1700000000000) },
	}
}

func testCredentials(t *testing.T, key string) account.Credentials {
	return account.Credentials{UID: "owner", AccountKey: key, ExpiresAt: time.Now().Add(time.Hour)}
}

// writeState writes a durable state file directly (to simulate a prior attempt
// or a crash mid-attempt).
func writeState(t *testing.T, path string, state *briefingState) {
	t.Helper()
	if err := saveBriefingState(path, state); err != nil {
		t.Fatalf("writeState: %v", err)
	}
}

func TestBriefingOncePerRollingWindow(t *testing.T) {
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
	serverURL, _ := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
	statePath := filepath.Join(t.TempDir(), "briefing.json")
	coordinator := testCoordinator(t, adapter, serverURL, statePath)
	credentials := testCredentials(t, key)
	ctx := context.Background()

	// First tick: a fresh prompt.
	coordinator.Tick(ctx, nil, "test-token", credentials)
	if adapter.submits.Load() != 1 {
		t.Fatalf("expected 1 prompt, got %d", adapter.submits.Load())
	}
	// Complete the summary so the attempt resolves to "completed".
	adapter.result = &Briefing{Title: "T", Description: "Summary", ObservedAt: 1700000000000}
	coordinator.Tick(ctx, nil, "test-token", credentials)

	// Within the window (1 minute later): no new prompt.
	coordinator.now = func() time.Time { return time.UnixMilli(1700000000000).Add(time.Minute) }
	coordinator.Tick(ctx, nil, "test-token", credentials)
	if adapter.submits.Load() != 1 {
		t.Fatalf("re-prompted within the rolling window: %d", adapter.submits.Load())
	}

	// After the window (24h later): a new prompt is allowed.
	coordinator.now = func() time.Time { return time.UnixMilli(1700000000000).Add(24 * time.Hour) }
	coordinator.Tick(ctx, nil, "test-token", credentials)
	if adapter.submits.Load() != 2 {
		t.Fatalf("expected a prompt after the window, got %d", adapter.submits.Load())
	}
}

func TestBriefingRollingWindowBoundary(t *testing.T) {
	// 23:59 then 00:01 (2 minutes apart) must not both prompt. A UTC calendar
	// day would allow both; a rolling 24h window must not.
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
	serverURL, _ := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
	statePath := filepath.Join(t.TempDir(), "briefing.json")
	coordinator := testCoordinator(t, adapter, serverURL, statePath)
	credentials := testCredentials(t, key)
	ctx := context.Background()

	// Prompt at 23:59 UTC.
	coordinator.now = func() time.Time { return time.Date(2026, 9, 21, 23, 59, 0, 0, time.UTC) }
	coordinator.Tick(ctx, nil, "test-token", credentials)
	if adapter.submits.Load() != 1 {
		t.Fatalf("expected 1 prompt at 23:59, got %d", adapter.submits.Load())
	}

	// Two minutes later (00:01 UTC, next calendar day): must NOT prompt.
	coordinator.now = func() time.Time { return time.Date(2026, 9, 22, 0, 1, 0, 0, time.UTC) }
	coordinator.Tick(ctx, nil, "test-token", credentials)
	if adapter.submits.Load() != 1 {
		t.Fatalf("re-prompted at 00:01 (2 minutes later): %d", adapter.submits.Load())
	}
}

func TestBriefingSkipsWhenNotIdle(t *testing.T) {
	for _, name := range []string{"busy", "unknown"} {
		t.Run(name, func(t *testing.T) {
			adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idleOK: true, ack: "ack-1"}
			if name == "busy" {
				adapter.idle = false
			} else {
				adapter.idleOK = false
			}
			key := testAccountKey(t)
			serverURL, _ := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
			coordinator := testCoordinator(t, adapter, serverURL, filepath.Join(t.TempDir(), "briefing.json"))
			coordinator.Tick(context.Background(), nil, "test-token", testCredentials(t, key))
			if adapter.submits.Load() != 0 {
				t.Fatal("prompted without an authoritative idle")
			}
		})
	}
}

func TestBriefingSkipsWithoutConsentOrBinding(t *testing.T) {
	t.Run("consent off", func(t *testing.T) {
		key := testAccountKey(t)
		adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
		serverURL, _ := testBriefingEnv(t, account.SessionContentPolicy{Enabled: false, Generation: "gen", OwnerUID: "owner"}, key)
		coordinator := testCoordinator(t, adapter, serverURL, filepath.Join(t.TempDir(), "briefing.json"))
		coordinator.Tick(context.Background(), nil, "test-token", testCredentials(t, key))
		if adapter.submits.Load() != 0 {
			t.Fatal("prompted without daily-briefing consent")
		}
	})
	t.Run("no binding", func(t *testing.T) {
		key := testAccountKey(t)
		adapter := &fakeBriefingAdapter{name: "fake", bindOK: false, idle: true, idleOK: true, ack: "ack-1"}
		serverURL, _ := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
		coordinator := testCoordinator(t, adapter, serverURL, filepath.Join(t.TempDir(), "briefing.json"))
		coordinator.Tick(context.Background(), nil, "test-token", testCredentials(t, key))
		if adapter.submits.Load() != 0 || adapter.idleCalls.Load() != 0 {
			t.Fatal("checked idle before a safe same-conversation binding")
		}
	})
}

func TestBriefingCrashAfterClaimNoReplay(t *testing.T) {
	// Simulate a crash after the durable claim but before/after the dispatch:
	// the state is "uncertain" with a LastPromptAt. A new coordinator must read
	// back the result, not re-submit the prompt.
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
	serverURL, _ := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
	statePath := filepath.Join(t.TempDir(), "briefing.json")
	credentials := testCredentials(t, key)

	// Write the "uncertain" claim state (as if a prior process crashed).
	writeState(t, statePath, &briefingState{
		Agent: "fake", State: briefingUncertain, Conversation: "ses_x", Generation: "gen",
		LastPromptAt: 1700000000000, UpdatedAt: 1700000000000,
	})

	coordinator := testCoordinator(t, adapter, serverURL, statePath)
	coordinator.Tick(context.Background(), nil, "test-token", credentials)
	if adapter.submits.Load() != 0 {
		t.Fatalf("re-submitted after a crash-uncertain claim: %d", adapter.submits.Load())
	}
	if adapter.resultCalls.Load() != 0 {
		t.Fatal("read a result without a correlated dispatch receipt")
	}
}

func TestBriefingCorruptStateFailsClosed(t *testing.T) {
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
	serverURL, _ := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
	statePath := filepath.Join(t.TempDir(), "briefing.json")
	credentials := testCredentials(t, key)

	// Write a corrupt state file (invalid JSON).
	if err := os.WriteFile(statePath, []byte("{not valid json"), 0o600); err != nil {
		t.Fatalf("write corrupt state: %v", err)
	}

	coordinator := testCoordinator(t, adapter, serverURL, statePath)
	coordinator.Tick(context.Background(), nil, "test-token", credentials)
	if adapter.submits.Load() != 0 {
		t.Fatal("prompted on a corrupt state file (must fail closed)")
	}
}

func TestBriefingUncertainNeverAutoResubmits(t *testing.T) {
	// A submit error leaves the state "uncertain". A later tick must not
	// auto-resubmit (even if the window has not elapsed).
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1",
		submitErr: context.DeadlineExceeded}
	serverURL, _ := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
	statePath := filepath.Join(t.TempDir(), "briefing.json")
	coordinator := testCoordinator(t, adapter, serverURL, statePath)
	credentials := testCredentials(t, key)
	ctx := context.Background()

	// First tick: the submit fails, leaving the state "uncertain".
	coordinator.Tick(ctx, nil, "test-token", credentials)
	if adapter.submits.Load() != 1 {
		t.Fatalf("expected 1 submit attempt, got %d", adapter.submits.Load())
	}

	// Second tick (same window): must NOT re-submit (uncertain is never
	// auto-resubmitted).
	coordinator.Tick(ctx, nil, "test-token", credentials)
	if adapter.submits.Load() != 1 {
		t.Fatalf("auto-resubmitted an uncertain operation: %d", adapter.submits.Load())
	}
}

func TestBriefingAckIsNotCompleted(t *testing.T) {
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
	serverURL, uploads := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
	coordinator := testCoordinator(t, adapter, serverURL, filepath.Join(t.TempDir(), "briefing.json"))
	credentials := testCredentials(t, key)
	ctx := context.Background()

	// First tick: the ack arrives but the summary is still pending.
	coordinator.Tick(ctx, nil, "test-token", credentials)
	if adapter.submits.Load() != 1 {
		t.Fatalf("submitted %d times", adapter.submits.Load())
	}
	if uploads.Load() != 0 {
		t.Fatal("published before the summary completed")
	}

	// The summary completes; the next tick reads it back without re-submitting.
	adapter.result = &Briefing{Title: "T", Description: "Summary", ObservedAt: 1700000000000}
	coordinator.Tick(ctx, nil, "test-token", credentials)
	if adapter.submits.Load() != 1 {
		t.Fatalf("re-submitted after ack: %d submits", adapter.submits.Load())
	}
	if uploads.Load() != 1 {
		t.Fatal("completed summary was not published")
	}
}

func TestBriefingGenerationMismatchOnReadback(t *testing.T) {
	// The consent generation rotates after dispatch. The read-back must void
	// the attempt (mark stale), not publish.
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
	var uploads atomic.Int32
	// The live consent generation has rotated to "gen-rotated" since the
	// dispatch (which captured "gen"). The read-back must void the attempt.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "content-policy"):
			_ = json.NewEncoder(w).Encode(account.SessionContentPolicy{Enabled: true, Generation: "gen-rotated", OwnerUID: "owner"})
		case strings.HasSuffix(r.URL.Path, "/key"):
			_ = json.NewEncoder(w).Encode(map[string]any{"public_key": key, "version": 1})
		case r.Method == http.MethodPut:
			uploads.Add(1)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	statePath := filepath.Join(t.TempDir(), "briefing.json")
	// Simulate a prior dispatch that captured generation "gen".
	writeState(t, statePath, &briefingState{
		Agent: "fake", State: briefingPending, Ack: "ack-1", Conversation: "ses_x", Generation: "gen",
		LastPromptAt: 1700000000000, UpdatedAt: 1700000000000,
	})
	adapter.result = &Briefing{Title: "T", Description: "Summary", ObservedAt: 1700000000000}

	coordinator := testCoordinator(t, adapter, server.URL, statePath)
	coordinator.Tick(context.Background(), nil, "test-token", testCredentials(t, key))
	if uploads.Load() != 0 {
		t.Fatal("published despite a consent generation mismatch")
	}
	state, _ := loadBriefingState(statePath)
	if state == nil || state.State != briefingStale {
		t.Fatalf("expected stale after generation mismatch, got %+v", state)
	}
}

func TestBriefingConversationIdentityMismatchOnReadback(t *testing.T) {
	// The conversation switches after dispatch. The read-back must void the
	// attempt (mark stale), not publish to the wrong conversation.
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_CHANGED", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
	serverURL, uploads := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
	statePath := filepath.Join(t.TempDir(), "briefing.json")
	// Simulate a prior dispatch to "ses_x".
	writeState(t, statePath, &briefingState{
		Agent: "fake", State: briefingPending, Ack: "ack-1", Conversation: "ses_x", Generation: "gen",
		LastPromptAt: 1700000000000, UpdatedAt: 1700000000000,
	})
	adapter.result = &Briefing{Title: "T", Description: "Summary", ObservedAt: 1700000000000}

	coordinator := testCoordinator(t, adapter, serverURL, statePath)
	coordinator.Tick(context.Background(), nil, "test-token", testCredentials(t, key))
	if uploads.Load() != 0 {
		t.Fatal("published to a switched conversation")
	}
	state, _ := loadBriefingState(statePath)
	if state == nil || state.State != briefingStale {
		t.Fatalf("expected stale after conversation switch, got %+v", state)
	}
}

func TestBriefingConsentRecheckBeforeDispatch(t *testing.T) {
	// Consent is revoked between the first check and the dispatch (during the
	// Idle check). The dispatch must not happen.
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
	var policyCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "content-policy"):
			n := policyCalls.Add(1)
			enabled := n <= 1 // revoked on the recheck (second call)
			_ = json.NewEncoder(w).Encode(account.SessionContentPolicy{Enabled: enabled, Generation: "gen", OwnerUID: "owner"})
		case strings.HasSuffix(r.URL.Path, "/key"):
			_ = json.NewEncoder(w).Encode(map[string]any{"public_key": key, "version": 1})
		case r.Method == http.MethodPut:
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	coordinator := testCoordinator(t, adapter, server.URL, filepath.Join(t.TempDir(), "briefing.json"))
	coordinator.Tick(context.Background(), nil, "test-token", testCredentials(t, key))
	if adapter.submits.Load() != 0 {
		t.Fatal("dispatched despite consent revocation before dispatch")
	}
}

func TestBriefingExcerptSlotCompetition(t *testing.T) {
	// The shared daily slot is already consumed (NextPublishAt in the future).
	// The briefing must defer (no publish, state stays pending), not drop.
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
	// NextPublishAt in the future: the excerpt publisher consumed the slot.
	policy := account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}
	policy.NextPublishAt = 1700000000000 + time.Hour.Milliseconds()
	serverURL, uploads := testBriefingEnv(t, policy, key)
	statePath := filepath.Join(t.TempDir(), "briefing.json")
	coordinator := testCoordinator(t, adapter, serverURL, statePath)
	credentials := testCredentials(t, key)
	ctx := context.Background()

	writeState(t, statePath, &briefingState{
		Agent: "fake", State: briefingPending, Ack: "ack-1", Conversation: "ses_x", Generation: "gen",
		LastPromptAt: 1700000000000, UpdatedAt: 1700000000000,
	})
	adapter.result = &Briefing{Title: "T", Description: "Summary", ObservedAt: 1700000000000}
	coordinator.Tick(ctx, nil, "test-token", credentials)
	if adapter.submits.Load() != 0 {
		t.Fatal("re-submitted while waiting for the daily publication slot")
	}
	if uploads.Load() != 0 {
		t.Fatal("published despite the daily slot being consumed")
	}
	// The state must remain "pending" (not completed/stale) so it can retry.
	state, _ := loadBriefingState(statePath)
	if state == nil || state.State != briefingPending {
		t.Fatalf("expected pending after slot competition, got %+v", state)
	}
}

func TestBriefingDoesNotDispatchAfterCancellationOrConversationSwitch(t *testing.T) {
	for _, scenario := range []string{"cancelled", "conversation switched"} {
		t.Run(scenario, func(t *testing.T) {
			key := testAccountKey(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
			adapter.onIdle = func() {
				if scenario == "cancelled" {
					cancel()
				} else {
					adapter.bindID = "ses_other"
				}
			}
			serverURL, _ := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
			coordinator := testCoordinator(t, adapter, serverURL, filepath.Join(t.TempDir(), "briefing.json"))
			coordinator.Tick(ctx, nil, "test-token", testCredentials(t, key))
			if adapter.submits.Load() != 0 {
				t.Fatal("submitted after cancellation or a changed conversation")
			}
		})
	}
}

func TestBriefingRejectsResultFromBeforeDispatch(t *testing.T) {
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1",
		result: &Briefing{Title: "Previous", Description: "An unrelated earlier response", ObservedAt: 1699999999999}}
	serverURL, uploads := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
	coordinator := testCoordinator(t, adapter, serverURL, filepath.Join(t.TempDir(), "briefing.json"))
	coordinator.Tick(context.Background(), nil, "test-token", testCredentials(t, key))
	if uploads.Load() != 0 {
		t.Fatal("published an assistant response older than the briefing request")
	}
}

func TestBriefingDoesNotPublishAfterGenerationChangesDuringReadback(t *testing.T) {
	key := testAccountKey(t)
	var generationChanged atomic.Bool
	var uploads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "content-policy"):
			generation := "gen"
			if generationChanged.Load() {
				generation = "gen-new"
			}
			_ = json.NewEncoder(w).Encode(account.SessionContentPolicy{Enabled: true, Generation: generation, OwnerUID: "owner"})
		case strings.HasSuffix(r.URL.Path, "/key"):
			_ = json.NewEncoder(w).Encode(map[string]any{"public_key": key, "version": 1})
		case r.Method == http.MethodPut:
			uploads.Add(1)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1",
		result:   &Briefing{Title: "T", Description: "Summary", ObservedAt: 1700000000000},
		onResult: func() { generationChanged.Store(true) }}
	coordinator := testCoordinator(t, adapter, server.URL, filepath.Join(t.TempDir(), "briefing.json"))
	coordinator.Tick(context.Background(), nil, "test-token", testCredentials(t, key))
	if uploads.Load() != 0 {
		t.Fatal("published a prior-generation response under renewed consent")
	}
}

func TestBriefingStructurallyInvalidStateFailsClosed(t *testing.T) {
	for _, raw := range []string{"null", "{}", `{"state":"unknown","lastPromptAt":1}`, `{"state":"pending","conversation":"ses_x","generation":"gen","lastPromptAt":1}`} {
		t.Run(raw, func(t *testing.T) {
			key := testAccountKey(t)
			adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
			serverURL, _ := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
			statePath := filepath.Join(t.TempDir(), "briefing.json")
			if err := os.WriteFile(statePath, []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			testCoordinator(t, adapter, serverURL, statePath).Tick(context.Background(), nil, "test-token", testCredentials(t, key))
			if adapter.submits.Load() != 0 || adapter.resultCalls.Load() != 0 {
				t.Fatal("trusted structurally invalid durable state")
			}
		})
	}
}

func TestBriefingDoesNotPromptWhenPublicationSlotIsUnavailable(t *testing.T) {
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true, ack: "ack-1"}
	serverURL, _ := testBriefingEnv(t, account.SessionContentPolicy{
		Enabled: true, Generation: "gen", OwnerUID: "owner", NextPublishAt: 1700000000001,
	}, key)
	coordinator := testCoordinator(t, adapter, serverURL, filepath.Join(t.TempDir(), "briefing.json"))
	coordinator.Tick(context.Background(), nil, "test-token", testCredentials(t, key))
	if adapter.submits.Load() != 0 {
		t.Fatal("spent a model prompt while the publication budget was unavailable")
	}
}

func TestBriefingEmptyReceiptRemainsUncertain(t *testing.T) {
	key := testAccountKey(t)
	adapter := &fakeBriefingAdapter{name: "fake", bindID: "ses_x", bindOK: true, idle: true, idleOK: true,
		result: &Briefing{Title: "T", Description: "Summary", ObservedAt: 1700000000000}}
	serverURL, uploads := testBriefingEnv(t, account.SessionContentPolicy{Enabled: true, Generation: "gen", OwnerUID: "owner"}, key)
	statePath := filepath.Join(t.TempDir(), "briefing.json")
	coordinator := testCoordinator(t, adapter, serverURL, statePath)
	for range 2 {
		coordinator.Tick(context.Background(), nil, "test-token", testCredentials(t, key))
	}
	state, err := loadBriefingState(statePath)
	if err != nil || state == nil || state.State != briefingUncertain {
		t.Fatalf("missing receipt did not remain uncertain: %+v, %v", state, err)
	}
	if adapter.submits.Load() != 1 || adapter.resultCalls.Load() != 0 || uploads.Load() != 0 {
		t.Fatal("retried or published an operation without a receipt")
	}
}
