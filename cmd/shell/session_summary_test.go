package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
	"shell.online/internal/summary"
)

func TestSummaryOutputIsInertUntilEnabled(t *testing.T) {
	output := newSummaryOutput()
	output.Write([]byte("before"))
	if data, total, _ := output.snapshot(); data != nil || total != 0 || output.buffer != nil {
		t.Fatal("output buffered while disabled")
	}
	output.setEnabled(true)
	output.Write(bytes.Repeat([]byte("a"), 3*summaryOutputBytes))
	output.Write([]byte("tail"))
	data, total, last := output.snapshot()
	if len(data) != summaryOutputBytes || !bytes.HasSuffix(data, []byte("tail")) || total != 3*summaryOutputBytes+4 || last.IsZero() {
		t.Fatalf("snapshot len=%d total=%d", len(data), total)
	}
	for i := 0; i < 1000; i++ {
		output.Write(bytes.Repeat([]byte("b"), 1000))
	}
	if cap(output.buffer) > 4*summaryOutputBytes {
		t.Fatalf("buffer grew to %d", cap(output.buffer))
	}
	output.setEnabled(false)
	if data, total, _ := output.snapshot(); data != nil || total != 0 {
		t.Fatal("disabling kept output")
	}
	var nilOutput *summaryOutput
	nilOutput.Write([]byte("x"))
	nilOutput.setEnabled(true)
}

func TestSummaryOutputConcurrentUse(t *testing.T) {
	output := newSummaryOutput()
	output.setEnabled(true)
	var group sync.WaitGroup
	for i := 0; i < 4; i++ {
		group.Add(2)
		go func() {
			defer group.Done()
			for j := 0; j < 500; j++ {
				output.Write([]byte("chunk\n"))
			}
		}()
		go func() {
			defer group.Done()
			for j := 0; j < 200; j++ {
				output.snapshot()
				output.setEnabled(j%50 != 0)
			}
		}()
	}
	group.Wait()
}

// summaryService is a fake account service for the summary endpoints.
type summaryService struct {
	t        *testing.T
	key      string
	policy   account.SessionSummaryPolicy
	uploads  chan account.SessionSummaryUpload
	tickets  atomic.Int32
	requests atomic.Int32
}

func newSummaryService(t *testing.T, key string) (*summaryService, *httptest.Server) {
	service := &summaryService{t: t, key: key, uploads: make(chan account.SessionSummaryUpload, 8),
		policy: account.SessionSummaryPolicy{Enabled: true, Generation: "gen-1", OwnerUID: "owner"}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		service.requests.Add(1)
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Error("missing authentication")
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/cli/sessions/session-1/summary-policy":
			_ = json.NewEncoder(w).Encode(service.policy)
		case r.Method == http.MethodGet && r.URL.Path == "/api/account/key":
			_ = json.NewEncoder(w).Encode(map[string]any{"public_key": service.key, "version": 1})
		case r.Method == http.MethodPost && r.URL.Path == "/api/cli/sessions/session-1/summary-ticket":
			service.tickets.Add(1)
			_ = json.NewEncoder(w).Encode(account.SummaryTicket{Ticket: "st1.p.s", Generation: service.policy.Generation, OwnerUID: "owner"})
		case r.Method == http.MethodPut && r.URL.Path == "/api/cli/sessions/session-1/summary":
			var upload account.SessionSummaryUpload
			decoder := json.NewDecoder(r.Body)
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&upload); err != nil {
				t.Errorf("upload: %v", err)
			}
			service.uploads <- upload
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return service, server
}

type fakeSummarizer struct {
	calls   atomic.Int32
	last    summary.Request
	mu      sync.Mutex
	fail    bool
	private *ecdh.PrivateKey
}

func (fake *fakeSummarizer) Summarize(_ context.Context, request summary.Request) (summary.Result, error) {
	fake.calls.Add(1)
	fake.mu.Lock()
	fake.last = request
	fake.mu.Unlock()
	if fake.fail {
		return summary.Result{}, errors.New("unavailable")
	}
	sender, sealed, err := summary.SealSummary(request.RecipientPublicKey, request.SessionID, request.RecipientUID, request.Generation,
		summary.Summary{Version: 1, Title: "Build", Summary: "Build finished.", State: summary.StateFinished, Source: summary.SourceEnclave, ObservedAt: request.ObservedAt})
	return summary.Result{SenderPublicKey: sender, Sealed: sealed}, err
}

func ownerKey(t *testing.T) (*ecdh.PrivateKey, string) {
	private, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return private, base64.RawURLEncoding.EncodeToString(private.PublicKey().Bytes())
}

func newTestRunner(server *httptest.Server, key, claudeID string, clock *time.Time, summarizer *fakeSummarizer) *summaryRunner {
	link := &sessionLink{client: account.NewClient(server.URL, "test"), accessToken: "token", sessionID: "session-1",
		credentials: account.Credentials{UID: "owner", AccountKey: key, AccessToken: "token", ExpiresAt: time.Now().Add(time.Hour)}}
	output := newSummaryOutput()
	output.now = func() time.Time { return *clock }
	return &summaryRunner{
		link: link, label: "npm run build --token=abcdef123456", claudeID: claudeID, output: output,
		now:          func() time.Time { return *clock },
		enclaveReady: func() bool { return true },
		newClient:    func() (summarizerClient, error) { return summarizer, nil },
		claudeDir:    func() (string, error) { return "", errors.New("unset") },
	}
}

func TestEnclaveSummaryWaitsForQuietOutputAndUploadsUnchanged(t *testing.T) {
	_, key := ownerKey(t)
	service, server := newSummaryService(t, key)
	summarizer := &fakeSummarizer{}
	clock := time.UnixMilli(1800000000000)
	runner := newTestRunner(server, key, "", &clock, summarizer)

	runner.tick(context.Background())
	if !runner.output.enabled.Load() {
		t.Fatal("consent did not enable output capture")
	}
	runner.output.Write([]byte("\x1b[32mcompiling\x1b[0m\npassword=hunter2 ok\n"))
	runner.tick(context.Background())
	if summarizer.calls.Load() != 0 {
		t.Fatal("summarised while output was still arriving")
	}
	clock = clock.Add(summaryQuiet)
	runner.tick(context.Background())
	if summarizer.calls.Load() != 1 {
		t.Fatalf("quiet output not summarised (calls=%d)", summarizer.calls.Load())
	}
	summarizer.mu.Lock()
	request := summarizer.last
	summarizer.mu.Unlock()
	if strings.Contains(request.Tail, "hunter2") || strings.Contains(request.Tail, "\x1b") || strings.Contains(request.Label, "abcdef123456") {
		t.Fatalf("unsanitised request: %q %q", request.Tail, request.Label)
	}
	if request.Ticket != "st1.p.s" || request.RecipientPublicKey != key || request.Generation != "gen-1" || request.RecipientUID != "owner" {
		t.Fatalf("request bindings: %+v", request)
	}
	upload := <-service.uploads
	if upload.Generation != "gen-1" || !strings.HasPrefix(upload.Sealed, "ss1.") || upload.ObservedAt != clock.UnixMilli() {
		t.Fatalf("upload: %+v", upload)
	}

	// Still idle, nothing new: summarised once only, however long it stays idle.
	for i := 0; i < 20; i++ {
		clock = clock.Add(time.Minute)
		runner.tick(context.Background())
	}
	if summarizer.calls.Load() != 1 {
		t.Fatal("an idle session was summarised more than once")
	}
}

func TestEnclaveSummaryOncePerIdlePeriod(t *testing.T) {
	_, key := ownerKey(t)
	service, server := newSummaryService(t, key)
	summarizer := &fakeSummarizer{}
	clock := time.UnixMilli(1800000000000)
	runner := newTestRunner(server, key, "", &clock, summarizer)
	runner.tick(context.Background())

	// Output that never pauses is never summarised: the session is not idle.
	for i := 0; i < 30; i++ {
		runner.output.Write([]byte(fmt.Sprintf("line %d\n", i)))
		clock = clock.Add(15 * time.Second)
		runner.tick(context.Background())
	}
	if summarizer.calls.Load() != 0 {
		t.Fatalf("busy session summarised %d times", summarizer.calls.Load())
	}
	clock = clock.Add(summaryQuiet)
	runner.tick(context.Background())
	if summarizer.calls.Load() != 1 {
		t.Fatalf("first idle period: calls=%d", summarizer.calls.Load())
	}
	<-service.uploads

	// New output, then idle again: exactly one more summary.
	runner.output.Write([]byte("tests finished\n"))
	clock = clock.Add(5 * time.Second)
	runner.tick(context.Background())
	if summarizer.calls.Load() != 1 {
		t.Fatal("summarised before the session went idle again")
	}
	clock = clock.Add(summaryQuiet + 3*time.Minute)
	for i := 0; i < 5; i++ {
		runner.tick(context.Background())
		clock = clock.Add(time.Minute)
	}
	if summarizer.calls.Load() != 2 {
		t.Fatalf("second idle period: calls=%d", summarizer.calls.Load())
	}
}

func TestEnclaveSummaryRetriesWithinTheSameIdlePeriod(t *testing.T) {
	_, key := ownerKey(t)
	service, server := newSummaryService(t, key)
	summarizer := &fakeSummarizer{fail: true}
	clock := time.UnixMilli(1800000000000)
	runner := newTestRunner(server, key, "", &clock, summarizer)
	runner.tick(context.Background())
	runner.output.Write([]byte("done\n"))
	clock = clock.Add(summaryQuiet)
	runner.tick(context.Background())
	if summarizer.calls.Load() != 1 {
		t.Fatalf("calls=%d", summarizer.calls.Load())
	}
	summarizer.fail = false
	clock = clock.Add(time.Minute)
	runner.tick(context.Background())
	if summarizer.calls.Load() != 1 {
		t.Fatal("retried before the backoff elapsed")
	}
	clock = clock.Add(summaryBackoffMin)
	runner.tick(context.Background())
	select {
	case <-service.uploads:
	default:
		t.Fatal("a failed attempt was not retried while the session stayed idle")
	}
}

func TestNoEnclaveMeansNothingCapturedOrSent(t *testing.T) {
	_, key := ownerKey(t)
	service, server := newSummaryService(t, key)
	summarizer := &fakeSummarizer{}
	clock := time.UnixMilli(1800000000000)
	runner := newTestRunner(server, key, "", &clock, summarizer)
	runner.enclaveReady = func() bool { return false }
	runner.tick(context.Background())
	runner.output.Write([]byte("output\n"))
	clock = clock.Add(time.Hour)
	runner.tick(context.Background())
	if runner.output.enabled.Load() || summarizer.calls.Load() != 0 || service.tickets.Load() != 0 {
		t.Fatal("a build without a release key captured output or spent a ticket")
	}
}

func TestClaudeSummaryFollowsClear(t *testing.T) {
	private, key := ownerKey(t)
	service, server := newSummaryService(t, key)
	clock := time.UnixMilli(1800000000000)
	runner := newTestRunner(server, key, testConversation, &clock, &fakeSummarizer{})
	dir := t.TempDir()
	runner.claudeDir = func() (string, error) { return dir, nil }
	runner.hookFile = filepath.Join(t.TempDir(), "hook.json")
	writeTranscript(t, dir, testConversation, assistant("end_turn", text("Old task done.")))
	awaitUpload(t, service, runner, &clock)

	// /clear starts a new conversation; the SessionStart hook reports it.
	const next = otherConversation
	nextPath := writeTranscript(t, dir, next, assistant("end_turn", text("New task done.")))
	hookInput, _ := json.Marshal(map[string]string{"session_id": next, "transcript_path": nextPath, "source": "clear"})
	if err := os.WriteFile(runner.hookFile, hookInput, 0o600); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(3 * time.Minute)
	runner.policyAt = time.Time{}
	if opened := openHostSummary(t, private, awaitUpload(t, service, runner, &clock)); opened.Summary != "New task done." {
		t.Fatalf("still summarising the cleared conversation: %+v", opened)
	}
}

func TestSummaryGuards(t *testing.T) {
	for _, name := range []string{"disabled", "owner mismatch", "rate limited", "key changed", "closed", "enclave fails", "no generation"} {
		t.Run(name, func(t *testing.T) {
			_, key := ownerKey(t)
			service, server := newSummaryService(t, key)
			summarizer := &fakeSummarizer{}
			clock := time.UnixMilli(1800000000000)
			runner := newTestRunner(server, key, "", &clock, summarizer)
			switch name {
			case "disabled":
				service.policy.Enabled = false
			case "owner mismatch":
				service.policy.OwnerUID = "someone-else"
			case "rate limited":
				service.policy.NextPublishAt = clock.Add(2 * time.Hour).UnixMilli()
			case "key changed":
				_, service.key = ownerKey(t)
			case "closed":
				runner.link.contentClosed = true
			case "enclave fails":
				summarizer.fail = true
			case "no generation":
				service.policy.Generation = ""
			}
			runner.output.setEnabled(true)
			runner.output.Write([]byte("output\n"))
			clock = clock.Add(time.Hour)
			runner.tick(context.Background())
			select {
			case upload := <-service.uploads:
				t.Fatalf("uploaded despite %s: %+v", name, upload)
			default:
			}
			if name == "disabled" || name == "owner mismatch" || name == "no generation" {
				if runner.output.enabled.Load() {
					t.Error("output capture left on without consent")
				}
			}
			if name != "enclave fails" && summarizer.calls.Load() != 0 {
				t.Errorf("summarizer called despite %s", name)
			}
		})
	}
}

func TestClaudeSummaryIsSealedOnTheHostWithoutTheEnclave(t *testing.T) {
	private, key := ownerKey(t)
	service, server := newSummaryService(t, key)
	summarizer := &fakeSummarizer{}
	clock := time.UnixMilli(1800000000000)
	runner := newTestRunner(server, key, testConversation, &clock, summarizer)
	dir := t.TempDir()
	runner.claudeDir = func() (string, error) { return dir, nil }
	writeTranscript(t, dir, testConversation,
		map[string]any{"type": "ai-title", "aiTitle": "Refactor parser"},
		assistant("end_turn", text("Parser refactored; all tests pass.")))

	runner.tick(context.Background())
	if runner.output.enabled.Load() {
		t.Error("claude sessions must not capture terminal output")
	}
	upload := <-service.uploads
	if summarizer.calls.Load() != 0 || service.tickets.Load() != 0 {
		t.Fatal("claude summary used the enclave")
	}
	opened := openHostSummary(t, private, upload)
	if opened.Title != "Refactor parser" || opened.Source != summary.SourceClaudeCode || opened.State != summary.StateWaitingForInput {
		t.Fatalf("opened %+v", opened)
	}

	clock = clock.Add(time.Hour)
	runner.tick(context.Background())
	select {
	case <-service.uploads:
		t.Fatal("unchanged transcript republished")
	default:
	}
}

// openHostSummary opens an ss1. envelope the way the browser does.
func openHostSummary(t *testing.T, private *ecdh.PrivateKey, upload account.SessionSummaryUpload) summary.Summary {
	t.Helper()
	sender, err := base64.RawURLEncoding.DecodeString(upload.SenderPublicKey)
	if err != nil {
		t.Fatal(err)
	}
	senderKey, err := ecdh.P256().NewPublicKey(sender)
	if err != nil {
		t.Fatal(err)
	}
	shared, _ := private.ECDH(senderKey)
	raw, _ := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(upload.Sealed, "ss1."))
	aead := testSummaryAEAD(t, shared)
	aad, _ := json.Marshal([]any{"shell.online session summary v1", "session-1", "owner", upload.Generation, upload.ObservedAt})
	plaintext, err := aead.Open(nil, raw[:12], raw[12:], aad)
	if err != nil {
		t.Fatalf("owner cannot open: %v", err)
	}
	var value summary.Summary
	_ = json.Unmarshal(plaintext, &value)
	return value
}

func testSummaryAEAD(t *testing.T, shared []byte) cipher.AEAD {
	t.Helper()
	key, err := hkdf.Key(sha256.New, shared, nil, "shell.online session summary v1", 32)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	return aead
}

func TestClaudeSummaryWaitsForTheTurnToEnd(t *testing.T) {
	private, key := ownerKey(t)
	service, server := newSummaryService(t, key)
	clock := time.UnixMilli(1800000000000)
	runner := newTestRunner(server, key, testConversation, &clock, &fakeSummarizer{})
	dir := t.TempDir()
	runner.claudeDir = func() (string, error) { return dir, nil }
	writeTranscript(t, dir, testConversation,
		map[string]any{"type": "ai-title", "aiTitle": "Refactor parser"},
		assistant("tool_use", text("Running the tests now.")))

	runner.tick(context.Background())
	select {
	case upload := <-service.uploads:
		t.Fatalf("summarised a turn that is still running: %+v", upload)
	default:
	}

	writeTranscript(t, dir, testConversation,
		map[string]any{"type": "ai-title", "aiTitle": "Refactor parser"},
		assistant("tool_use", text("Running the tests now.")),
		assistant("end_turn", text("All tests pass.")))
	clock = clock.Add(time.Minute)
	runner.policyAt = time.Time{}
	opened := openHostSummary(t, private, awaitUpload(t, service, runner, &clock))
	if opened.State != summary.StateWaitingForInput || opened.Summary != "All tests pass." {
		t.Fatalf("opened %+v", opened)
	}
}

// awaitUpload ticks the runner until it uploads, the way the real loop keeps
// retrying, and fails with a message instead of hanging when nothing arrives.
func awaitUpload(t *testing.T, service *summaryService, runner *summaryRunner, clock *time.Time) account.SessionSummaryUpload {
	t.Helper()
	for attempt := 0; attempt < 20; attempt++ {
		runner.tick(context.Background())
		select {
		case upload := <-service.uploads:
			return upload
		case <-time.After(50 * time.Millisecond):
		}
		*clock = clock.Add(summaryTick)
		runner.policyAt = time.Time{}
	}
	t.Fatal("no summary was uploaded")
	return account.SessionSummaryUpload{}
}

func TestClaudeSummaryRetriesAnUnchangedTranscriptAfterAFailure(t *testing.T) {
	_, key := ownerKey(t)
	service, server := newSummaryService(t, key)
	clock := time.UnixMilli(1800000000000)
	runner := newTestRunner(server, key, testConversation, &clock, &fakeSummarizer{})
	dir := t.TempDir()
	runner.claudeDir = func() (string, error) { return dir, nil }
	writeTranscript(t, dir, testConversation, assistant("end_turn", text("Done.")))

	// The vault key check fails once, before anything is sealed or uploaded.
	_, service.key = ownerKey(t)
	runner.tick(context.Background())
	select {
	case upload := <-service.uploads:
		t.Fatalf("uploaded with a changed vault key: %+v", upload)
	default:
	}
	// The transcript has not changed, but its turn was never published.
	service.key = key
	awaitUpload(t, service, runner, &clock)
}
