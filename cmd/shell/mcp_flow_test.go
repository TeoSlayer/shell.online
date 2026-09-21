package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"shell.online/internal/account"
	"shell.online/internal/relay"
)

const flowID = "6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d1e2f"

func flowMessage(body string) []byte { return []byte(body) }

func TestParseMcpFlowMessage(t *testing.T) {
	valid := []struct {
		name      string
		message   string
		phase     string
		outcome   string
		wantValid bool
	}{
		{"started", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_screen","phase":"started","at":1730000000000}}`, "started", "", true},
		{"settled with outcome", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_send","phase":"settled","at":1730000000123,"outcome":"delivered"}}`, "settled", "delivered", true},
		{"another tool", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_wait","phase":"settled","at":1,"outcome":"timeout"}}`, "settled", "timeout", true},
		{"unknown top-level field", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"started","at":1},"bearer":"secret"}`, "", "", false},
		{"unknown event field", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"started","at":1,"args":"secret"}}`, "", "", false},
		{"sneaked credential", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"started","at":1,"share_url":"https://example.invalid/s/x#password=y"}}`, "", "", false},
		{"wrong type", `{"type":"other","event":{"id":"` + flowID + `","tool":"shell_status","phase":"started","at":1}}`, "", "", false},
		{"not a v4 uuid", `{"type":"mcp_flow","event":{"id":"6f1d9f5e-4a1b-3c8d-9f2e-0b7c3a5d1e2f","tool":"shell_status","phase":"started","at":1}}`, "", "", false},
		{"unknown tool", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_hack","phase":"started","at":1}}`, "", "", false},
		{"unknown phase", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"finished","at":1}}`, "", "", false},
		{"started claims an outcome", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"started","at":1,"outcome":"ok"}}`, "", "", false},
		{"settled without an outcome", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"settled","at":1}}`, "", "", false},
		{"settled with an unlisted outcome", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"settled","at":1,"outcome":"exploded"}}`, "", "", false},
		{"missing time", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"started"}}`, "", "", false},
		{"zero time", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"started","at":0}}`, "", "", false},
		{"fractional time", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"started","at":1.5}}`, "", "", false},
		{"trailing junk", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"started","at":1}} rest`, "", "", false},
		{"not json", `not json`, "", "", false},
		{"oversized", `{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_status","phase":"started","at":1}}` + strings.Repeat(" ", mcpFlowMessageMax), "", "", false},
	}
	for _, test := range valid {
		event, ok := parseMcpFlowMessage(flowMessage(test.message))
		if ok != test.wantValid {
			t.Fatalf("%s: valid=%v, want %v", test.name, ok, test.wantValid)
		}
		if !ok {
			continue
		}
		if event.ID != flowID || event.Phase != test.phase || event.Outcome != test.outcome {
			t.Fatalf("%s: event = %+v", test.name, event)
		}
	}
}

func reporterLink() *sessionLink {
	return &sessionLink{
		client:      account.NewClient("http://127.0.0.1:1", "test/1"),
		accessToken: "token",
		sessionID:   "session",
		credentials: account.Credentials{
			AccessToken:  "token",
			RefreshToken: "refresh",
			ExpiresAt:    time.Now().Add(time.Hour),
		},
	}
}

func TestMcpFlowReporterQueueIsBounded(t *testing.T) {
	reporter := newMcpFlowReporter(reporterLink())
	for index := 0; index < mcpFlowQueueSize*2; index++ {
		reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_status", Phase: "started", At: int64(index)})
	}
	if got := len(reporter.queue); got != mcpFlowQueueSize {
		t.Fatalf("queue holds %d events, want %d", got, mcpFlowQueueSize)
	}
}

func TestMcpFlowReporterFlushesOneBoundedBatch(t *testing.T) {
	reporter := newMcpFlowReporter(reporterLink())
	reporter.batch = 2
	var posted [][]account.McpFlowEvent
	reporter.report = func(_ context.Context, _, _ string, events []account.McpFlowEvent) error {
		posted = append(posted, append([]account.McpFlowEvent(nil), events...))
		return nil
	}
	for index := 0; index < 5; index++ {
		reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_status", Phase: "started", At: int64(index + 1)})
	}
	reporter.flush()
	reporter.flush()
	reporter.flush()
	if len(posted) != 3 || len(posted[0]) != 2 || len(posted[1]) != 2 || len(posted[2]) != 1 {
		t.Fatalf("batches = %v", posted)
	}
	var order []int64
	for _, batch := range posted {
		for _, event := range batch {
			order = append(order, event.At)
		}
	}
	for index, at := range order {
		if at != int64(index+1) {
			t.Fatalf("order = %v", order)
		}
	}
}

func TestMcpFlowReporterDropsFailedBatches(t *testing.T) {
	reporter := newMcpFlowReporter(reporterLink())
	var mu sync.Mutex
	var calls int
	reporter.report = func(_ context.Context, _, _ string, _ []account.McpFlowEvent) error {
		mu.Lock()
		defer mu.Unlock()
		calls++
		return errors.New("service down")
	}
	reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_status", Phase: "started", At: 1})
	reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_status", Phase: "settled", At: 2, Outcome: "ok"})
	reporter.flush()
	if got := len(reporter.queue); got != 0 {
		t.Fatalf("failed batch stayed queued (%d)", got)
	}
	reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_status", Phase: "started", At: 3})
	reporter.flush()
	mu.Lock()
	defer mu.Unlock()
	if calls != 2 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestMcpFlowReporterSkipsSessionsThatWereNeverPublished(t *testing.T) {
	link := reporterLink()
	link.sessionID = ""
	reporter := newMcpFlowReporter(link)
	called := false
	reporter.report = func(_ context.Context, _, _ string, _ []account.McpFlowEvent) error {
		called = true
		return nil
	}
	reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_status", Phase: "started", At: 1})
	reporter.flush()
	if called {
		t.Fatal("an unpublished session must not be reported")
	}
	if len(reporter.queue) != 0 {
		t.Fatal("events for an unpublished session must be dropped, not stuck")
	}
}

func TestMcpFlowReporterStopIsIdempotent(t *testing.T) {
	reporter := newMcpFlowReporter(reporterLink())
	/* Configured before the goroutine starts; it is never written afterwards. */
	reporter.interval = 5 * time.Millisecond
	go reporter.run()
	reporter.stop()
	reporter.stop()
	select {
	case <-reporter.done:
	default:
		t.Fatal("stop did not close the reporter")
	}
	/* A no-link reporter has nothing running and is still safe. */
	nilReporter := startMcpFlowReporter(nil)
	nilReporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_status", Phase: "started", At: 1})
	nilReporter.stop()
}

func TestMcpFlowReporterPostsOnlyAllowlistedFields(t *testing.T) {
	type received struct {
		body map[string]json.RawMessage
		auth string
	}
	requests := make(chan received, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string]json.RawMessage
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		}
		requests <- received{body: body, auth: request.Header.Get("Authorization")}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	link := reporterLink()
	link.client = account.NewClient(server.URL, "test/1")
	reporter := newMcpFlowReporter(link)
	reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_screen", Phase: "started", At: 1730000000000})
	reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_screen", Phase: "settled", At: 1730000000123, Outcome: "ok"})
	reporter.flush()

	got := <-requests
	if got.auth != "Bearer token" {
		t.Fatalf("authorization = %q", got.auth)
	}
	if len(got.body) != 1 {
		t.Fatalf("body keys = %v", got.body)
	}
	var events []map[string]json.RawMessage
	if err := json.Unmarshal(got.body["events"], &events); err != nil {
		t.Fatalf("events: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("events = %v", events)
	}
	for _, event := range events {
		for key := range event {
			switch key {
			case "id", "tool", "phase", "at", "outcome":
			default:
				t.Fatalf("unapproved field %q left the host", key)
			}
		}
	}
}

func TestMcpFlowReporterRefreshesExpiredTokens(t *testing.T) {
	var mu sync.Mutex
	seenTokens := []string{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/cli/refresh", func(writer http.ResponseWriter, request *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(request.Body).Decode(&body)
		if body["refresh_token"] != "old-refresh" {
			t.Errorf("refresh token = %q", body["refresh_token"])
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"fresh-token","refresh_token":"new-refresh","expires_in":3600,"account":{"uid":"uid-1","email":"a@b.c","name":"A"}}`))
	})
	mux.HandleFunc("/api/cli/sessions/session-1/mcp-flows", func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		seenTokens = append(seenTokens, request.Header.Get("Authorization"))
		mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"accepted":true}`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	path := filepath.Join(t.TempDir(), "credentials.json")
	link := &sessionLink{
		client:      account.NewClient(server.URL, "test/1"),
		accessToken: "stale-token",
		sessionID:   "session-1",
		path:        path,
		credentials: account.Credentials{
			Server: server.URL, AccessToken: "stale-token", RefreshToken: "old-refresh",
			ExpiresAt: time.Now().Add(-time.Minute), UID: "uid-1",
		},
	}
	reporter := newMcpFlowReporter(link)
	reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_status", Phase: "started", At: 1730000000000})
	reporter.flush()

	mu.Lock()
	defer mu.Unlock()
	if len(seenTokens) != 1 || seenTokens[0] != "Bearer fresh-token" {
		t.Fatalf("tokens seen = %v", seenTokens)
	}
	saved, err := account.Load(path)
	if err != nil {
		t.Fatalf("renewed credentials were not saved: %v", err)
	}
	/* Refresh keeps the existing refresh token; only the access token changes. */
	if saved.AccessToken != "fresh-token" || saved.RefreshToken != "old-refresh" {
		t.Fatalf("saved credentials = %+v", saved)
	}
}

func TestMcpFlowReporterStopCancelsInFlightReportAndDropsQueue(t *testing.T) {
	reporter := newMcpFlowReporter(reporterLink())
	started := make(chan struct{})
	finished := make(chan struct{})
	reporter.report = func(ctx context.Context, _, _ string, _ []account.McpFlowEvent) error {
		close(started)
		<-ctx.Done()
		close(finished)
		return ctx.Err()
	}
	reporter.interval = time.Hour
	go reporter.run()
	reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_status", Phase: "started", At: 1})
	go reporter.flush()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("report never started")
	}
	reporter.stop()
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("stop did not cancel the in-flight report")
	}
	if got := len(reporter.queue); got != 0 {
		t.Fatalf("stop left %d queued events", got)
	}
	reporter.enqueue(account.McpFlowEvent{ID: flowID, Tool: "shell_status", Phase: "started", At: 2})
	if got := len(reporter.queue); got != 0 {
		t.Fatalf("enqueue after stop queued %d events", got)
	}
}

// The relay reader must forward exactly the well-formed observations and ignore
// everything else without disturbing the rest of the control stream.
func TestReadRelayForwardsValidatedMcpFlowMessages(t *testing.T) {
	viewers := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		viewers <- connection
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connection, err := relay.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), "test-token")
	if err != nil {
		t.Fatalf("dial test relay: %v", err)
	}
	defer connection.Close()
	viewer := <-viewers
	defer viewer.CloseNow()

	sink := make(chan account.McpFlowEvent, 4)
	exitAcknowledged := make(chan struct{}, 1)
	rotationAcknowledged := make(chan struct{}, 1)
	var supportsRotation atomic.Bool
	relayDone := make(chan error, 1)
	go func() {
		relayDone <- readRelay(connection, nil, nil, nil, newSessionCipher(nil), false,
			exitAcknowledged, rotationAcknowledged, &supportsRotation, nil,
			func(event account.McpFlowEvent) { sink <- event })
	}()

	send := func(text string) {
		t.Helper()
		if err := viewer.Write(ctx, websocket.MessageText, []byte(text)); err != nil {
			t.Fatalf("write control message: %v", err)
		}
	}

	send(`{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_screen","phase":"started","at":1730000000000}}`)
	send(`{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_screen","phase":"settled","at":1730000000123,"outcome":"ok"}}`)
	send(`{"type":"mcp_flow","event":{"id":"` + flowID + `","tool":"shell_screen","phase":"settled","at":1730000000124,"outcome":"ok","args":"secret"}}`)
	send(`{"type":"mcp_flow","event":{"id":"not-a-uuid","tool":"shell_screen","phase":"started","at":1}}`)

	for want := 0; want < 2; want++ {
		select {
		case event := <-sink:
			if event.ID != flowID || event.Phase != []string{"started", "settled"}[want] {
				t.Fatalf("event %d = %+v", want, event)
			}
		case <-ctx.Done():
			t.Fatalf("timed out waiting for observation %d", want)
		}
	}
	/* The two refused messages must not have reached the sink. */
	select {
	case extra := <-sink:
		t.Fatalf("refused message reached the sink: %+v", extra)
	case <-time.After(200 * time.Millisecond):
	}

	/* The reader is still alive: a later control message is still acted on. */
	send(`{"type":"exit_ack"}`)
	select {
	case <-exitAcknowledged:
	case <-ctx.Done():
		t.Fatal("reader stopped after malformed flow messages")
	}
	cancel()
	connection.Close()
	select {
	case <-relayDone:
	case <-time.After(2 * time.Second):
		t.Fatal("reader did not return")
	}
}
