package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"shell.online/internal/account"
)

func sampleSessionInput() account.SessionInput {
	return account.SessionInput{
		ID:        "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
		ShareURL:  "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
		Command:   "claude",
		Encrypted: true,
	}
}

func TestOpenSessionLinkReturnsNilWhenNotSignedIn(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "absent.json"))
	var warn bytes.Buffer

	if link := openSessionLink(context.Background(), &warn); link != nil {
		t.Fatal("a machine that is not signed in must produce no link")
	}
	// Not being signed in is the normal case; it must stay silent.
	if warn.Len() != 0 {
		t.Fatalf("openSessionLink warned unnecessarily: %q", warn.String())
	}
}

func TestNilLinkMethodsAreSafe(t *testing.T) {
	// The launch path calls these unconditionally, so nil must be inert.
	var link *sessionLink
	link.Register(context.Background(), sampleSessionInput())
	exitCode := 0
	link.Close(&exitCode)
}

func TestRegisterPublishesTheSession(t *testing.T) {
	var received map[string]any
	var authorization string
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			authorization = request.Header.Get("Authorization")
			_ = json.NewDecoder(request.Body).Decode(&received)
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{}`))
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	if link == nil {
		t.Fatal("expected a link for a signed-in machine")
	}
	link.Register(context.Background(), sampleSessionInput())

	if authorization != "Bearer sha_access" {
		t.Fatalf("Authorization = %q", authorization)
	}
	if received["command"] != "claude" {
		t.Fatalf("payload = %+v", received)
	}
	if received["host"] == "" {
		t.Fatal("host should be filled in from the machine")
	}
	if received["started_at"] == nil {
		t.Fatal("started_at should be filled in when absent")
	}
	if warn.Len() != 0 {
		t.Fatalf("a successful register should stay silent, got %q", warn.String())
	}
}

func TestRegisterWarnsButDoesNotFailTheLaunch(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusInternalServerError)
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	link.Register(context.Background(), sampleSessionInput())

	if !strings.Contains(warn.String(), "will not appear in your account") {
		t.Fatalf("warning = %q", warn.String())
	}
}

func TestCloseIsSkippedWhenRegistrationNeverSucceeded(t *testing.T) {
	var closeCalls atomic.Int32
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			if request.Method == http.MethodPatch {
				closeCalls.Add(1)
			}
			writer.WriteHeader(http.StatusInternalServerError)
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	link.Register(context.Background(), sampleSessionInput())

	exitCode := 0
	link.Close(&exitCode)

	if closeCalls.Load() != 0 {
		t.Fatal("closing a session that was never registered would 404 for no reason")
	}
}

func TestCloseMarksTheSessionFinished(t *testing.T) {
	var patchedPath string
	var patchedBody map[string]any
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			if request.Method == http.MethodPatch {
				patchedPath = request.URL.Path
				_ = json.NewDecoder(request.Body).Decode(&patchedBody)
			}
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{}`))
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	input := sampleSessionInput()
	link.Register(context.Background(), input)

	exitCode := 3
	link.Close(&exitCode)

	if patchedPath != "/api/sessions/"+input.ID {
		t.Fatalf("patched %q", patchedPath)
	}
	if patchedBody["exit_code"] != float64(3) {
		t.Fatalf("exit_code = %v, want 3", patchedBody["exit_code"])
	}
}

func TestCloseRunsEvenAfterTheProcessContextIsCancelled(t *testing.T) {
	// A session ends by its context being cancelled. Close must not inherit it.
	var patched atomic.Bool
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			if request.Method == http.MethodPatch {
				patched.Store(true)
			}
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{}`))
		}))
	defer service.Close()

	linkedAccount(t, service.URL)
	ctx, cancel := context.WithCancel(context.Background())
	var warn bytes.Buffer
	link := openSessionLink(ctx, &warn)
	link.Register(ctx, sampleSessionInput())
	cancel()

	exitCode := 0
	link.Close(&exitCode)

	if !patched.Load() {
		t.Fatal("Close did not reach the service after the process context ended")
	}
}

func TestExpiredCredentialsAreRefreshedAndPersisted(t *testing.T) {
	var refreshed atomic.Bool
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("Content-Type", "application/json")
			if request.URL.Path == "/api/cli/refresh" {
				refreshed.Store(true)
				_, _ = writer.Write([]byte(`{"access_token":"sha_fresh","expires_in":3600}`))
				return
			}
			if request.Header.Get("Authorization") != "Bearer sha_fresh" {
				t.Errorf("register used a stale token: %q", request.Header.Get("Authorization"))
			}
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{}`))
		}))
	defer service.Close()

	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv("SHELL_ONLINE_CONFIG", path)
	if err := account.Save(path, account.Credentials{
		Server:       service.URL,
		AccessToken:  "sha_stale",
		RefreshToken: "shr_refresh",
		ExpiresAt:    time.Now().Add(-time.Hour),
		Email:        "ana@example.com",
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	if link == nil {
		t.Fatalf("expected a link after refresh; warnings %q", warn.String())
	}
	link.Register(context.Background(), sampleSessionInput())

	if !refreshed.Load() {
		t.Fatal("a stale access token should have been refreshed")
	}
	stored, err := account.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if stored.AccessToken != "sha_fresh" {
		t.Fatalf("renewed token was not persisted, got %q", stored.AccessToken)
	}
}

func TestRefreshFailureDisablesPublishingWithoutFailingTheLaunch(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusUnauthorized)
			_, _ = writer.Write([]byte(`{"error":"refresh token revoked"}`))
		}))
	defer service.Close()

	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv("SHELL_ONLINE_CONFIG", path)
	if err := account.Save(path, account.Credentials{
		Server:       service.URL,
		RefreshToken: "shr_dead",
		ExpiresAt:    time.Now().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)

	if link != nil {
		t.Fatal("a revoked account must not produce a live link")
	}
	if !strings.Contains(warn.String(), "will not appear in your account") {
		t.Fatalf("warning = %q", warn.String())
	}
}
