//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"shell.online/internal/account"
)

/*
 * What keeps a machine showing as online is one thing: the agent's poll of
 * /api/agent/commands, which the service dates. A machine that stops polling
 * reads as offline within fifteen seconds, whatever else is true about it. The
 * tests here are about the ways that poll used to stop.
 */

type pollService struct {
	mutex sync.Mutex
	polls int
	/* accept is the access token the service will honour. */
	accept        string
	refreshCalls  int
	refreshFails  bool
	refreshIssues string
}

func (service *pollService) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/agent/commands", func(writer http.ResponseWriter, request *http.Request) {
		service.mutex.Lock()
		defer service.mutex.Unlock()
		token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if token != service.accept {
			writer.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(writer).Encode(map[string]any{"error": "not signed in"})
			return
		}
		service.polls++
		_ = json.NewEncoder(writer).Encode(map[string]any{"commands": []any{}})
	})
	mux.HandleFunc("/api/cli/refresh", func(writer http.ResponseWriter, request *http.Request) {
		service.mutex.Lock()
		defer service.mutex.Unlock()
		service.refreshCalls++
		if service.refreshFails {
			writer.WriteHeader(http.StatusBadGateway)
			_ = json.NewEncoder(writer).Encode(map[string]any{"error": "upstream down"})
			return
		}
		service.accept = service.refreshIssues
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"access_token": service.refreshIssues,
			"expires_in":   3600,
		})
	})
	return mux
}

func (service *pollService) counts() (polls, refreshes int) {
	service.mutex.Lock()
	defer service.mutex.Unlock()
	return service.polls, service.refreshCalls
}

func (service *pollService) setRefreshFails(fails bool) {
	service.mutex.Lock()
	defer service.mutex.Unlock()
	service.refreshFails = fails
}

/*
 * testPollInterval keeps these tests off the wall clock. The loop's real
 * interval is two seconds; waiting out several of those under -race, and again
 * under QEMU on an emulated architecture, is a test that fails for reasons
 * that have nothing to do with what it is checking.
 */
const testPollInterval = 5 * time.Millisecond

// settleFor is how long to allow for a handful of polls at that interval.
// Generous by three orders of magnitude, because what is being judged is
// whether the loop polls at all, never how fast. waitFor, in
// daemon_integration_test.go, is the same idea with its own budget.
const settleFor = 15 * time.Second

// runBriefly runs the loop until it has polled enough times to judge, or the
// deadline passes.
func runBriefly(t *testing.T, loop *agentLoop, service *pollService, wantPolls int) int {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = loop.run(ctx); close(done) }()
	deadline := time.After(settleFor)
	for {
		if polls, _ := service.counts(); polls >= wantPolls {
			break
		}
		select {
		case <-deadline:
			cancel()
			<-done
			polls, _ := service.counts()
			return polls
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	<-done
	polls, _ := service.counts()
	return polls
}

func loopFor(t *testing.T, service *httptest.Server, credentials account.Credentials) *agentLoop {
	t.Helper()
	path := filepath.Join(t.TempDir(), "credentials.json")
	credentials.Server = service.URL
	if err := account.Save(path, credentials); err != nil {
		t.Fatal(err)
	}
	return &agentLoop{
		credentialsPath: path,
		credentials:     credentials,
		self:            "/nonexistent/shell",
		report:          &strings.Builder{},
		interval:        testPollInterval,
	}
}

/*
 * The one that made a machine "go unhealthy" for no reason anybody could see.
 * Renewal starts a minute before the token expires, so a blip there catches a
 * token that still works perfectly -- and standing down from the poll for the
 * whole backoff, up to a minute, is the machine reporting itself offline over
 * a renewal it did not need yet.
 */
func TestAFailedRenewalDoesNotStopTheMachineReportingIn(t *testing.T) {
	stub := &pollService{accept: "good-token", refreshFails: true, refreshIssues: "fresh-token"}
	service := httptest.NewServer(stub.handler())
	defer service.Close()

	loop := loopFor(t, service, account.Credentials{
		AccessToken: "good-token", RefreshToken: "refresh", UID: "uid-1",
		/* Inside the renewal grace, so every pass tries to renew and fails. */
		ExpiresAt: time.Now().Add(30 * time.Second),
	})

	polls := runBriefly(t, loop, stub, 3)

	if polls < 3 {
		t.Fatalf("polled %d times while renewal was failing, want at least 3", polls)
	}
	if _, refreshes := stub.counts(); refreshes < 1 {
		t.Errorf("renewal was never attempted (%d)", refreshes)
	}
}

/*
 * The service is the authority on its own tokens. A machine whose clock is
 * slow, or whose token was invalidated before its stated expiry, used to
 * present the same dead token every two seconds for as long as it stayed up,
 * because nothing but the local clock could start a renewal.
 */
func TestARefusedTokenIsRenewedWhateverTheClockSays(t *testing.T) {
	stub := &pollService{accept: "server-side-only", refreshIssues: "server-side-only"}
	service := httptest.NewServer(stub.handler())
	defer service.Close()

	loop := loopFor(t, service, account.Credentials{
		AccessToken: "stale-token", RefreshToken: "refresh", UID: "uid-1",
		/* The machine believes this is good for another hour. It is not. */
		ExpiresAt: time.Now().Add(time.Hour),
	})

	polls := runBriefly(t, loop, stub, 1)

	if polls < 1 {
		t.Fatalf("never recovered from a refused token (%d polls)", polls)
	}
	if _, refreshes := stub.counts(); refreshes < 1 {
		t.Errorf("a refusal did not trigger a renewal (%d)", refreshes)
	}
}

/* A login in another terminal writes working credentials; the daemon reads them. */
func TestARenewalFailureRereadsCredentialsFromDisk(t *testing.T) {
	stub := &pollService{accept: "from-login", refreshFails: true, refreshIssues: "unused"}
	service := httptest.NewServer(stub.handler())
	defer service.Close()

	loop := loopFor(t, service, account.Credentials{
		AccessToken: "old-token", RefreshToken: "old-refresh", UID: "uid-1",
		ExpiresAt: time.Now().Add(-time.Minute),
	})
	if err := account.Save(loop.credentialsPath, account.Credentials{
		Server: service.URL, AccessToken: "from-login", RefreshToken: "new-refresh",
		UID: "uid-1", ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	if polls := runBriefly(t, loop, stub, 1); polls < 1 {
		t.Fatalf("the daemon never picked up the credentials a login wrote (%d polls)", polls)
	}
}

/* A blip must not leave the machine renewing on a minute's delay forever. */
func TestASuccessfulPollClearsTheRenewalBackoff(t *testing.T) {
	stub := &pollService{accept: "good-token", refreshFails: true, refreshIssues: "fresh-token"}
	service := httptest.NewServer(stub.handler())
	defer service.Close()

	loop := loopFor(t, service, account.Credentials{
		AccessToken: "good-token", RefreshToken: "refresh", UID: "uid-1",
		ExpiresAt: time.Now().Add(30 * time.Second),
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = loop.run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	/* Let a couple of renewals fail, then let renewal work again. */
	waitFor(t, "two failed renewals", func() bool {
		_, refreshes := stub.counts()
		return refreshes >= 2
	})
	stub.setRefreshFails(false)

	/* The backoff was reset by every successful poll, so this is quick. */
	before, _ := stub.counts()
	waitFor(t, "polling to continue once renewal recovered", func() bool {
		polls, _ := stub.counts()
		return polls > before+2
	})
}
