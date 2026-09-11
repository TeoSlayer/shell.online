package account

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestCallbackHandlerCarriesTheAccountKey(t *testing.T) {
	_, public := newAccountKey(t)
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "", results)

	handler.ServeHTTP(httptest.NewRecorder(),
		callbackRequest("code=shc_abc&state=state-123&account_key="+public))

	result := <-results
	if result.err != nil || result.code != "shc_abc" {
		t.Fatalf("result = %+v", result)
	}
	if result.accountKey != public {
		t.Fatalf("accountKey = %q, want the key the browser sent", result.accountKey)
	}
}

// A malformed key must not stop someone signing in: it is simply not trusted.
func TestCallbackHandlerDropsAMalformedAccountKey(t *testing.T) {
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "", results)

	handler.ServeHTTP(httptest.NewRecorder(),
		callbackRequest("code=shc_abc&state=state-123&account_key=not-a-key"))

	result := <-results
	if result.err != nil || result.code != "shc_abc" {
		t.Fatalf("result = %+v", result)
	}
	if result.accountKey != "" {
		t.Fatalf("accountKey = %q, want nothing trusted", result.accountKey)
	}
}

func TestCallbackHandlerTrustsNoKeyWhenTheStateIsWrong(t *testing.T) {
	_, public := newAccountKey(t)
	results := make(chan callbackResult, 1)
	handler := newCallbackHandler("state-123", "", results)

	handler.ServeHTTP(httptest.NewRecorder(),
		callbackRequest("code=shc_abc&state=forged&account_key="+public))

	result := <-results
	if result.err == nil {
		t.Fatal("a forged callback was accepted")
	}
	if result.accountKey != "" {
		t.Fatal("a forged callback got its key trusted")
	}
}

// End to end: the key the browser puts on the callback is the key the
// credentials carry away.
func TestLoginPinsTheAccountKeyFromTheBrowser(t *testing.T) {
	_, public := newAccountKey(t)
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			writeJSON(writer, http.StatusOK, map[string]any{
				"access_token":  "sha_access",
				"refresh_token": "shr_refresh",
				"expires_in":    3600,
				"account":       map[string]string{"uid": "uid-1", "email": "ana@example.com"},
			})
		}))
	defer service.Close()

	browser := func(authorize string) error {
		parsed, err := url.Parse(authorize)
		if err != nil {
			return err
		}
		query := parsed.Query()
		callback := fmt.Sprintf("%s?code=shc_abc&state=%s&account_key=%s",
			query.Get("redirect_uri"), url.QueryEscape(query.Get("state")), public)
		go func() {
			response, err := http.Get(callback)
			if err == nil {
				response.Body.Close()
			}
		}()
		return nil
	}

	credentials, err := Login(context.Background(), NewClient(service.URL, "test"), Options{
		WebURL:      "https://app.shell.online",
		OpenBrowser: browser,
		Timeout:     10 * time.Second,
	})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if credentials.AccountKey != public {
		t.Fatalf("AccountKey = %q, want the key from the callback", credentials.AccountKey)
	}
	if credentials.UID != "uid-1" {
		t.Fatalf("UID = %q", credentials.UID)
	}
}

func TestAccountKey(t *testing.T) {
	_, public := newAccountKey(t)
	tests := []struct {
		name    string
		status  int
		body    any
		wantKey string
		wantOK  bool
		wantErr string
	}{
		{"a vault", http.StatusOK, map[string]any{"public_key": public, "version": 1}, public, true, ""},
		{"no vault yet", http.StatusNotFound, map[string]string{"error": "no vault"}, "", false, ""},
		{"a failure", http.StatusInternalServerError, map[string]string{"error": "database down"}, "", false, "database down"},
		{"a key that is not one", http.StatusOK, map[string]any{"public_key": "junk"}, "", false, "unusable key"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var authorization, path string
			service := httptest.NewServer(http.HandlerFunc(
				func(writer http.ResponseWriter, request *http.Request) {
					authorization = request.Header.Get("Authorization")
					path = request.URL.Path
					writeJSON(writer, test.status, test.body)
				}))
			defer service.Close()

			key, ok, err := NewClient(service.URL, "test").AccountKey(context.Background(), "sha_token")
			if path != "/api/account/key" || authorization != "Bearer sha_token" {
				t.Fatalf("asked %q with %q", path, authorization)
			}
			if test.wantErr == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if test.wantErr != "" && (err == nil || !strings.Contains(err.Error(), test.wantErr)) {
				t.Fatalf("err = %v, want one mentioning %q", err, test.wantErr)
			}
			if key != test.wantKey || ok != test.wantOK {
				t.Fatalf("AccountKey = %q, %v; want %q, %v", key, ok, test.wantKey, test.wantOK)
			}
		})
	}
}

// Existing callers match on these messages, so wrapping the status in a type
// must not have changed a word of them.
func TestFailingResponsesKeepTheirMessages(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path == "/json" {
				writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "bad thing"})
				return
			}
			writer.WriteHeader(http.StatusBadGateway)
			_, _ = writer.Write([]byte("  upstream  "))
		}))
	defer service.Close()
	client := NewClient(service.URL, "test")

	if _, err := client.do(context.Background(), http.MethodGet, "/json", "", nil); err == nil ||
		err.Error() != "accounts service: bad thing" {
		t.Fatalf("err = %v", err)
	}
	if _, err := client.do(context.Background(), http.MethodGet, "/plain", "", nil); err == nil ||
		err.Error() != "accounts service returned 502: upstream" {
		t.Fatalf("err = %v", err)
	}
}

func TestRegisterSessionSendsTheOwnerShare(t *testing.T) {
	var body map[string]any
	service := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			decodeJSON(t, request, &body)
			writeJSON(writer, http.StatusCreated, map[string]any{})
		}))
	defer service.Close()
	client := NewClient(service.URL, "test")

	input := SessionInput{ID: testSessionID, ShareURL: "https://shell.online/s/x", Command: "claude"}
	if err := client.RegisterSession(context.Background(), "sha", input); err != nil {
		t.Fatalf("RegisterSession: %v", err)
	}
	if _, present := body["owner_share"]; present {
		t.Fatalf("a session without a share sent one: %+v", body)
	}

	input.OwnerShare = &KeyShare{SenderPublicKey: "sender", Sealed: "v2.sealed"}
	if err := client.RegisterSession(context.Background(), "sha", input); err != nil {
		t.Fatalf("RegisterSession: %v", err)
	}
	share, ok := body["owner_share"].(map[string]any)
	if !ok || share["sender_public_key"] != "sender" || share["sealed"] != "v2.sealed" {
		t.Fatalf("owner_share = %+v", body["owner_share"])
	}
}
