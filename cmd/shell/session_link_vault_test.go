package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"shell.online/internal/account"
)

const vaultTestPassword = "Kw9eHbru"

// vaultService stands in for the accounts service: it answers the key request
// with keyStatus and records what each registration carried.
type vaultService struct {
	server    *httptest.Server
	mu        sync.Mutex
	keyAsks   int
	published []map[string]any
}

func newVaultService(t *testing.T, keyStatus int, publicKey string) *vaultService {
	t.Helper()
	service := &vaultService{}
	service.server = httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			service.mu.Lock()
			defer service.mu.Unlock()
			writer.Header().Set("Content-Type", "application/json")
			switch request.URL.Path {
			case "/api/account/key":
				service.keyAsks++
				writer.WriteHeader(keyStatus)
				switch keyStatus {
				case http.StatusOK:
					_ = json.NewEncoder(writer).Encode(map[string]any{"public_key": publicKey, "version": 1})
				case http.StatusNotFound:
					_, _ = writer.Write([]byte(`{"error":"no vault"}`))
				default:
					_, _ = writer.Write([]byte(`{"error":"database down"}`))
				}
			case "/api/sessions":
				var body map[string]any
				_ = json.NewDecoder(request.Body).Decode(&body)
				service.published = append(service.published, body)
				writer.WriteHeader(http.StatusCreated)
				_, _ = writer.Write([]byte(`{}`))
			default:
				http.NotFound(writer, request)
			}
		}))
	t.Cleanup(service.server.Close)
	return service
}

func (service *vaultService) lastShare(t *testing.T) map[string]any {
	t.Helper()
	service.mu.Lock()
	defer service.mu.Unlock()
	if len(service.published) != 1 {
		t.Fatalf("published %d sessions, want 1", len(service.published))
	}
	share, _ := service.published[0]["owner_share"].(map[string]any)
	return share
}

func testAccountKey(t *testing.T) string {
	t.Helper()
	private, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(private.PublicKey().Bytes())
}

func pinAccountKey(t *testing.T, path, key string) {
	t.Helper()
	credentials, err := account.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	credentials.AccountKey = key
	if err := account.Save(path, credentials); err != nil {
		t.Fatalf("Save: %v", err)
	}
}

func registerWithPassword(t *testing.T, password string) string {
	t.Helper()
	var warn bytes.Buffer
	link := openSessionLink(context.Background(), &warn)
	if link == nil {
		t.Fatal("expected a link for a signed-in machine")
	}
	link.Register(context.Background(), sampleSessionInput(), password)
	if strings.Contains(warn.String(), password) && password != "" {
		t.Fatalf("the password was printed: %q", warn.String())
	}
	return warn.String()
}

func TestFirstVaultKeyIsPinnedAndUsed(t *testing.T) {
	key := testAccountKey(t)
	service := newVaultService(t, http.StatusOK, key)
	path := linkedAccount(t, service.server.URL)

	warn := registerWithPassword(t, vaultTestPassword)

	share := service.lastShare(t)
	if share == nil || !strings.HasPrefix(share["sealed"].(string), "v2.") {
		t.Fatalf("owner_share = %+v, want a v2 envelope", share)
	}
	if strings.Contains(share["sealed"].(string), vaultTestPassword) {
		t.Fatal("the password was sent in the clear")
	}
	stored, err := account.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if stored.AccountKey != key {
		t.Fatalf("pinned %q, want the key the service reported", stored.AccountKey)
	}
	fingerprint, _ := account.Fingerprint(key)
	if !strings.Contains(warn, "saving session passwords to your vault (key "+fingerprint+")") {
		t.Fatalf("output = %q, want the fingerprint announced once", warn)
	}
}

func TestPinnedVaultKeyIsUsedSilently(t *testing.T) {
	key := testAccountKey(t)
	service := newVaultService(t, http.StatusOK, key)
	pinAccountKey(t, linkedAccount(t, service.server.URL), key)

	warn := registerWithPassword(t, vaultTestPassword)

	if service.lastShare(t) == nil {
		t.Fatal("no owner_share for a key that matches the pin")
	}
	if warn != "" {
		t.Fatalf("a matching key should stay silent, got %q", warn)
	}
}

// The service hands the key over. If it could swap it at will, it could read
// every password sealed afterwards, so a changed key is refused.
func TestChangedVaultKeyIsRefused(t *testing.T) {
	service := newVaultService(t, http.StatusOK, testAccountKey(t))
	path := linkedAccount(t, service.server.URL)
	pinned := testAccountKey(t)
	pinAccountKey(t, path, pinned)

	warn := registerWithPassword(t, vaultTestPassword)

	if share := service.lastShare(t); share != nil {
		t.Fatalf("sealed to a key that does not match the pin: %+v", share)
	}
	if !strings.Contains(warn, "your vault key changed since this machine signed in") {
		t.Fatalf("output = %q", warn)
	}
	stored, _ := account.Load(path)
	if stored.AccountKey != pinned {
		t.Fatal("the pin was replaced by the service's key")
	}
}

func TestNoVaultMeansNoShareAndNoNoise(t *testing.T) {
	service := newVaultService(t, http.StatusNotFound, "")
	linkedAccount(t, service.server.URL)

	warn := registerWithPassword(t, vaultTestPassword)

	if share := service.lastShare(t); share != nil {
		t.Fatalf("owner_share = %+v with no vault", share)
	}
	if warn != "" {
		t.Fatalf("an account without a vault is normal; got %q", warn)
	}
}

func TestVaultFailureStillPublishesTheSession(t *testing.T) {
	service := newVaultService(t, http.StatusInternalServerError, "")
	linkedAccount(t, service.server.URL)

	warn := registerWithPassword(t, vaultTestPassword)

	if share := service.lastShare(t); share != nil {
		t.Fatalf("owner_share = %+v after a failed key request", share)
	}
	if !strings.Contains(warn, "this session's password was not saved to your vault") {
		t.Fatalf("output = %q", warn)
	}
}

func TestSessionWithoutAPasswordDoesNotAskForTheKey(t *testing.T) {
	service := newVaultService(t, http.StatusOK, testAccountKey(t))
	linkedAccount(t, service.server.URL)

	registerWithPassword(t, "")

	if service.keyAsks != 0 {
		t.Fatalf("asked for the vault key %d times for a session with no password", service.keyAsks)
	}
	if share := service.lastShare(t); share != nil {
		t.Fatalf("owner_share = %+v", share)
	}
}

func TestSignInWithoutAUIDSkipsTheVault(t *testing.T) {
	service := newVaultService(t, http.StatusOK, testAccountKey(t))
	path := linkedAccount(t, service.server.URL)
	credentials, _ := account.Load(path)
	credentials.UID = ""
	if err := account.Save(path, credentials); err != nil {
		t.Fatalf("Save: %v", err)
	}

	warn := registerWithPassword(t, vaultTestPassword)

	if share := service.lastShare(t); share != nil {
		t.Fatalf("sealed without knowing whose vault it is: %+v", share)
	}
	if !strings.Contains(warn, "run 'shell login'") {
		t.Fatalf("output = %q", warn)
	}
}
