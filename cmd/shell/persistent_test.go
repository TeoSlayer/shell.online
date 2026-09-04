package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"shell.online/internal/api"
)

func TestPersistentStateIsOwnerOnlyAndRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "session.json")
	state := persistentSessionState{
		Version:         1,
		ID:              "EkMXVp1uVpwCpBHQHlMNIj-AVjpR2hr3",
		HostToken:       "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
		Encrypted:       true,
		Fragment:        "#key=" + strings.Repeat("A", 43),
		EncryptionKey:   strings.Repeat("A", 43),
		BrowserPassword: "Abcd12-_",
	}
	if err := writePersistentState(path, state); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state permissions = %#o", info.Mode().Perm())
	}
	loaded, err := readPersistentState(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ID != state.ID || loaded.HostToken != state.HostToken || loaded.BrowserPassword != state.BrowserPassword {
		t.Fatal("persistent state changed")
	}
}

func TestPersistentStateRejectsInvalidEncryptionMaterial(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.json")
	state := persistentSessionState{
		Version:       1,
		ID:            "EkMXVp1uVpwCpBHQHlMNIj-AVjpR2hr3",
		HostToken:     "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
		Encrypted:     true,
		Fragment:      "#key=too-short",
		EncryptionKey: "too-short",
	}
	if err := writePersistentState(path, state); err != nil {
		t.Fatal(err)
	}
	if _, err := readPersistentState(path); err == nil {
		t.Fatal("accepted invalid persistent E2EE material")
	}
}

func TestPersistentSessionIDIsBoundToHostToken(t *testing.T) {
	const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
	if id := persistentSessionID(token); id != "EkMXVp1uVpwCpBHQHlMNIj-AVjpR2hr3" {
		t.Fatalf("persistent session ID = %q", id)
	}
	if persistentSessionID(token+"x") == persistentSessionID(token) {
		t.Fatal("different host tokens produced the same session ID")
	}
}

func TestPersistentStateRejectsLoosePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows uses ACLs rather than Unix permission bits")
	}
	path := filepath.Join(t.TempDir(), "session.json")
	if err := os.WriteFile(path, []byte(`{"version":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readPersistentState(path); err == nil {
		t.Fatal("accepted group-readable persistent credentials")
	}
}

func TestPersistentSessionGeneratesAndReusesBrowserPassword(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var body struct {
			ID        string `json:"session_id"`
			HostToken string `json:"host_token"`
			ReadOnly  bool   `json:"read_only"`
			Encrypted bool   `json:"encrypted"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode resume request: %v", err)
		}
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(response).Encode(map[string]any{
			"session_id": body.ID, "host_token": body.HostToken,
			"read_only": body.ReadOnly, "encrypted": body.Encrypted,
			"persistent": true, "expires_at": time.Now().Add(time.Hour),
		})
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "session.json")
	client := api.NewClient(server.URL, "test")
	first, password, err := preparePersistentSession(context.Background(), client, path, "bash", false, true, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(password) != 8 || !strings.Contains(first.ShareURL, "#salt=") {
		t.Fatalf("generated password/share = %q, %q", password, first.ShareURL)
	}
	second, reused, err := preparePersistentSession(context.Background(), client, path, "bash", false, true, "")
	if err != nil {
		t.Fatal(err)
	}
	if reused != password || second.ShareURL != first.ShareURL {
		t.Fatalf("persistent access changed: password %q/%q, URL %q/%q", password, reused, first.ShareURL, second.ShareURL)
	}
	if _, _, err := preparePersistentSession(context.Background(), client, path, "bash", false, true, "different"); err == nil {
		t.Fatal("accepted a replacement password for existing persistent state")
	}
}
