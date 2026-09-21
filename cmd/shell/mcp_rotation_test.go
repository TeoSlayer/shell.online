package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"shell.online/internal/api"
	"shell.online/internal/e2ee"
)

func TestMcpIssuanceUsesCurrentRotatedFrameKey(t *testing.T) {
	oldKey, newKey := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	oldCipher, _ := e2ee.New(oldKey)
	newCipher, _ := e2ee.New(newKey)
	rotating := newSessionCipher(oldCipher)
	keys := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			FrameKey string `json:"frame_key"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		keys <- body.FrameKey
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"bearer": "synthetic-test-bearer"})
	}))
	defer server.Close()
	managed := &managedLocalSession{mcpFrameKey: rotating.Key}
	wireMcpControl(managed, api.NewClient(server.URL, "test"), api.Session{
		ID: strings.Repeat("a", 32), HostToken: "synthetic-host", Cipher: oldCipher,
	}, context.Background())
	if _, err := managed.mcpGrant("test", []string{"observe"}, 60); err != nil {
		t.Fatal(err)
	}
	if got := <-keys; got != base64.RawURLEncoding.EncodeToString(oldKey) {
		t.Fatal("wrong original key")
	}
	rotating.Rotate(newCipher)
	if _, err := managed.mcpGrant("test", []string{"observe"}, 60); err != nil {
		t.Fatal(err)
	}
	if got := <-keys; got != base64.RawURLEncoding.EncodeToString(newKey) {
		t.Fatal("issued grant with stale key after rotation")
	}
}

func TestMcpScopePresetsExpandToWireScopes(t *testing.T) {
	for preset, expected := range map[string]string{
		"observe": "observe", "control": "observe,input",
		"controlInterrupt": "observe,input,interrupt", "observe,input": "observe,input",
	} {
		if got := strings.Join(mcpGrantScopes(preset), ","); got != expected {
			t.Errorf("%s = %s, want %s", preset, got, expected)
		}
	}
}
