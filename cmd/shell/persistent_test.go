package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPersistentStateIsOwnerOnlyAndRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "session.json")
	state := persistentSessionState{
		Version:       1,
		ID:            "EkMXVp1uVpwCpBHQHlMNIj-AVjpR2hr3",
		HostToken:     "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
		Encrypted:     true,
		Fragment:      "#key=" + strings.Repeat("A", 43),
		EncryptionKey: strings.Repeat("A", 43),
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
	if loaded.ID != state.ID || loaded.HostToken != state.HostToken {
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
	path := filepath.Join(t.TempDir(), "session.json")
	if err := os.WriteFile(path, []byte(`{"version":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readPersistentState(path); err == nil {
		t.Fatal("accepted group-readable persistent credentials")
	}
}
