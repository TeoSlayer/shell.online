package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"shell.online/internal/account"
	"shell.online/internal/api"
)

func TestMcpTeamCommandRecoversProtectedDelivery(t *testing.T) {
	var publicKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-account-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/cli/sessions/session-1/mcp/team":
			var body struct {
				RecipientPublicKey string `json:"recipientPublicKey"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || account.ParseAccountKey(body.RecipientPublicKey) != nil {
				http.Error(w, "bad recipient", http.StatusBadRequest)
				return
			}
			publicKey = body.RecipientPublicKey
			_ = json.NewEncoder(w).Encode(account.McpTeamRequestResult{RequestID: "request-1", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()})
		case "GET /api/cli/sessions/session-1/mcp/team/request-1":
			key, sealed, err := account.SealToAccount(publicKey, "session-1", "uid-2\x00mcp-team:request-1", "synthetic-mcp-bearer")
			if err != nil {
				http.Error(w, "seal failed", http.StatusInternalServerError)
				return
			}
			envelope, _ := json.Marshal(map[string]string{"k": key, "s": sealed})
			_ = json.NewEncoder(w).Encode(account.McpTeamGrantFetch{Status: "issued", SealedToRecipient: true, Bearer: string(envelope)})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv("SHELL_ONLINE_CONFIG", path)
	if err := account.Save(path, account.Credentials{Server: server.URL, UID: "uid-2", AccessToken: "synthetic-account-token", RefreshToken: "synthetic-refresh-token", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if code := runSessionMcpTeam([]string{"session-1"}, &stdout, &stderr); code != 0 {
		t.Fatalf("team command failed with code %d: %s", code, stderr.String())
	}
	if strings.TrimSpace(stdout.String()) != "synthetic-mcp-bearer" {
		t.Fatal("command did not print the decrypted credential")
	}
	if strings.Contains(stderr.String(), "synthetic-mcp-bearer") {
		t.Fatal("credential leaked to diagnostics")
	}
}

// A link that reports a live credential for session s1, with a client that is
// never actually called (the test injects the account calls directly).
func teamTestLink() *sessionLink {
	return &sessionLink{
		client:      account.NewClient("http://127.0.0.1:1", "shell/test"),
		accessToken: "token",
		sessionID:   "s1",
		credentials: account.Credentials{
			AccessToken: "token",
			ExpiresAt:   time.Now().Add(time.Hour),
		},
	}
}

func TestMcpTeamServiceIssuesOnceAndReReports(t *testing.T) {
	link := teamTestLink()
	var mints int
	var reported []account.McpTeamGrantReport
	service := newMcpTeamService(link,
		func(label string, scopes []string, ttl int, requesterUID string) (api.McpGrantCreated, error) {
			mints++
			return api.McpGrantCreated{GrantID: "grant-1", Bearer: "bearer-1", ExpiresAt: time.Now().Add(time.Hour)}, nil
		},
		func(grantID string) error { return nil },
	)
	service.listWork = func(ctx context.Context, token, sessionID string) (account.McpTeamWorkList, error) {
		return account.McpTeamWorkList{Issues: []account.McpTeamHostRequest{
			{RequestID: "req-1", RequesterUID: "uid-2", Action: "issue"},
		}}, nil
	}
	service.report = func(ctx context.Context, token, sessionID, requestID string, report account.McpTeamGrantReport) error {
		reported = append(reported, report)
		return nil
	}
	service.ack = func(ctx context.Context, token, sessionID, requestID string) error { return nil }

	// First poll: mint + report.
	service.poll()
	if mints != 1 || len(reported) != 1 {
		t.Fatalf("after first poll: mints=%d reports=%d, want 1/1", mints, len(reported))
	}
	if reported[0].GrantID != "grant-1" || reported[0].Bearer != "bearer-1" {
		t.Fatalf("first report = %+v", reported[0])
	}

	// The request is still pending (a lost report): re-report, do not re-mint.
	service.poll()
	if mints != 1 {
		t.Fatalf("second poll re-minted: mints=%d, want 1", mints)
	}
	if len(reported) != 2 || reported[1].GrantID != "grant-1" {
		t.Fatalf("second poll did not re-report the same grant: %+v", reported)
	}
}

func TestMcpTeamServiceRevokesAndAcks(t *testing.T) {
	link := teamTestLink()
	var revoked []string
	var acked []string
	service := newMcpTeamService(link,
		func(label string, scopes []string, ttl int, requesterUID string) (api.McpGrantCreated, error) {
			return api.McpGrantCreated{GrantID: "grant-1", Bearer: "bearer-1", ExpiresAt: time.Now().Add(time.Hour)}, nil
		},
		func(grantID string) error { revoked = append(revoked, grantID); return nil },
	)
	service.listWork = func(ctx context.Context, token, sessionID string) (account.McpTeamWorkList, error) {
		return account.McpTeamWorkList{Revocations: []account.McpTeamHostRequest{
			{RequestID: "req-1", RequesterUID: "uid-2", Action: "revoke", GrantID: "grant-1"},
		}}, nil
	}
	service.report = func(ctx context.Context, token, sessionID, requestID string, report account.McpTeamGrantReport) error {
		return nil
	}
	service.ack = func(ctx context.Context, token, sessionID, requestID string) error {
		acked = append(acked, requestID)
		return nil
	}

	service.poll()
	if len(revoked) != 1 || revoked[0] != "grant-1" {
		t.Fatalf("revoked = %v, want [grant-1]", revoked)
	}
	if len(acked) != 1 || acked[0] != "req-1" {
		t.Fatalf("acked = %v, want [req-1]", acked)
	}
}

func TestMcpTeamServiceDoesNotAckWhenRevokeFails(t *testing.T) {
	link := teamTestLink()
	var acked []string
	service := newMcpTeamService(link,
		func(label string, scopes []string, ttl int, requesterUID string) (api.McpGrantCreated, error) {
			return api.McpGrantCreated{GrantID: "grant-1", Bearer: "bearer-1", ExpiresAt: time.Now().Add(time.Hour)}, nil
		},
		func(grantID string) error { return errors.New("revoke failed") },
	)
	service.listWork = func(ctx context.Context, token, sessionID string) (account.McpTeamWorkList, error) {
		return account.McpTeamWorkList{Revocations: []account.McpTeamHostRequest{
			{RequestID: "req-1", RequesterUID: "uid-2", Action: "revoke", GrantID: "grant-1"},
		}}, nil
	}
	service.report = func(ctx context.Context, token, sessionID, requestID string, report account.McpTeamGrantReport) error {
		return nil
	}
	service.ack = func(ctx context.Context, token, sessionID, requestID string) error {
		acked = append(acked, requestID)
		return nil
	}

	service.poll()
	if len(acked) != 0 {
		t.Fatalf("acked = %v, want none (the revoke failed)", acked)
	}
}

func TestMcpTeamServiceSkipsSessionsThatWereNeverPublished(t *testing.T) {
	link := &sessionLink{
		client:      account.NewClient("http://127.0.0.1:1", "shell/test"),
		accessToken: "token",
		// sessionID empty: the session was never registered.
		credentials: account.Credentials{AccessToken: "token", ExpiresAt: time.Now().Add(time.Hour)},
	}
	called := false
	service := newMcpTeamService(link,
		func(label string, scopes []string, ttl int, requesterUID string) (api.McpGrantCreated, error) {
			return api.McpGrantCreated{}, nil
		},
		func(grantID string) error { return nil },
	)
	service.listWork = func(ctx context.Context, token, sessionID string) (account.McpTeamWorkList, error) {
		called = true
		return account.McpTeamWorkList{}, nil
	}
	service.report = func(ctx context.Context, token, sessionID, requestID string, report account.McpTeamGrantReport) error {
		return nil
	}
	service.ack = func(ctx context.Context, token, sessionID, requestID string) error { return nil }

	service.poll()
	if called {
		t.Fatal("the work list was read for a session that was never published")
	}
}

func TestMcpTeamServiceForwardsOnlyToAWiredSession(t *testing.T) {
	// A control that is not a managed local session yields a service that never polls.
	service := startMcpTeamServiceFor(localSessionControl(nil), teamTestLink())
	if service == nil {
		t.Fatal("startMcpTeamServiceFor returned nil")
	}
	// It has no grant/revoke closures, so a poll is a no-op and must not panic.
	service.poll()
	service.stop()
}
