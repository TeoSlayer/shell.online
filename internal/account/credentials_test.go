package account

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func sampleCredentials() Credentials {
	return Credentials{
		Server:       "http://127.0.0.1:8787",
		AccessToken:  "sha_access",
		RefreshToken: "shr_refresh",
		ExpiresAt:    time.Now().Add(time.Hour).UTC().Truncate(time.Second),
		UID:          "uid-1",
		Email:        "ana@example.com",
		Name:         "Ana Ferreira",
	}
}

func TestSaveThenLoadRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "credentials.json")
	want := sampleCredentials()
	if err := Save(path, want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.AccessToken != want.AccessToken || got.RefreshToken != want.RefreshToken ||
		got.UID != want.UID || got.Email != want.Email || got.Name != want.Name ||
		got.Server != want.Server || !got.ExpiresAt.Equal(want.ExpiresAt) {
		t.Fatalf("round trip changed the record:\n got %+v\nwant %+v", got, want)
	}
}

func TestSaveCreatesTheDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a", "b", "c", "credentials.json")
	if err := Save(path, sampleCredentials()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("credentials file missing: %v", err)
	}
}

func TestSaveIsReadableOnlyByTheOwner(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission bits are not meaningful on Windows")
	}
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := Save(path, sampleCredentials()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	// A refresh token is a live credential; group and other must have nothing.
	if permissions := info.Mode().Perm(); permissions != 0o600 {
		t.Fatalf("credentials mode = %o, want 600", permissions)
	}
}

func TestSaveLeavesNoTemporaryFileBehind(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "credentials.json")
	if err := Save(path, sampleCredentials()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("Save left %s behind", entry.Name())
		}
	}
}

func TestSaveOverwritesAnEarlierAccount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := Save(path, sampleCredentials()); err != nil {
		t.Fatalf("first Save: %v", err)
	}
	second := sampleCredentials()
	second.Email = "bruno@example.com"
	second.UID = "uid-2"
	if err := Save(path, second); err != nil {
		t.Fatalf("second Save: %v", err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.Email != "bruno@example.com" || got.UID != "uid-2" {
		t.Fatalf("Save did not replace the earlier account, got %+v", got)
	}
}

func TestLoadReportsNotLinkedWhenMissing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent.json")
	if _, err := Load(path); !errors.Is(err, ErrNotLinked) {
		t.Fatalf("Load = %v, want ErrNotLinked", err)
	}
}

func TestLoadReportsNotLinkedWithoutARefreshToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(path, []byte(`{"access_token":"sha_only"}`), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	// An access token alone cannot be renewed, so it is not a linked account.
	if _, err := Load(path); !errors.Is(err, ErrNotLinked) {
		t.Fatalf("Load = %v, want ErrNotLinked", err)
	}
}

func TestLoadReportsCorruptionDistinctlyFromNotLinked(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	_, err := Load(path)
	if err == nil {
		t.Fatal("Load accepted a corrupt file")
	}
	if errors.Is(err, ErrNotLinked) {
		t.Fatal("corruption must not be reported as ErrNotLinked")
	}
	if !strings.Contains(err.Error(), "shell login") {
		t.Fatalf("error should tell the user how to recover, got %q", err)
	}
}

func TestClearRemovesTheAccount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := Save(path, sampleCredentials()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := Clear(path); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if _, err := Load(path); !errors.Is(err, ErrNotLinked) {
		t.Fatalf("Load after Clear = %v, want ErrNotLinked", err)
	}
}

func TestClearIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent.json")
	if err := Clear(path); err != nil {
		t.Fatalf("Clear on a missing file: %v", err)
	}
}

func TestExpired(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name      string
		expiresAt time.Time
		want      bool
	}{
		{"zero value is expired", time.Time{}, true},
		{"already past", now.Add(-time.Second), true},
		{"exactly now", now, true},
		{"inside the grace window", now.Add(30 * time.Second), true},
		{"just outside the grace window", now.Add(expiryGrace + time.Second), false},
		{"an hour out", now.Add(time.Hour), false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			credentials := Credentials{ExpiresAt: test.expiresAt}
			if got := credentials.Expired(now); got != test.want {
				t.Fatalf("Expired = %v, want %v", got, test.want)
			}
		})
	}
}

func TestDefaultPathHonoursTheOverride(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", "/tmp/custom/credentials.json")
	path, err := DefaultPath()
	if err != nil {
		t.Fatalf("DefaultPath: %v", err)
	}
	if path != "/tmp/custom/credentials.json" {
		t.Fatalf("DefaultPath = %q, want the override", path)
	}
}

func TestDefaultPathFallsBackToTheConfigDirectory(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", "")
	path, err := DefaultPath()
	if err != nil {
		t.Fatalf("DefaultPath: %v", err)
	}
	if filepath.Base(path) != "credentials.json" {
		t.Fatalf("DefaultPath = %q, want a credentials.json leaf", path)
	}
	if filepath.Base(filepath.Dir(path)) != "shell-online" {
		t.Fatalf("DefaultPath = %q, want a shell-online directory", path)
	}
}
