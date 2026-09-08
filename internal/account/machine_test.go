package account

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMachineIDPathSitsBesideTheCredentials(t *testing.T) {
	credentials := filepath.Join("somewhere", "shell-online", "credentials.json")
	want := filepath.Join("somewhere", "shell-online", "machine-id")
	if got := MachineIDPath(credentials); got != want {
		t.Fatalf("MachineIDPath = %q, want %q", got, want)
	}
}

func TestMachineIDIsCreatedOnFirstUse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "machine-id")
	id, err := MachineID(path)
	if err != nil {
		t.Fatalf("MachineID: %v", err)
	}
	if !validMachineID(id) {
		t.Fatalf("MachineID = %q, which the accounts service would refuse", id)
	}
	// 32 random bytes, base64url encoded without padding.
	if len(id) != 43 {
		t.Fatalf("MachineID = %q, want 43 characters", id)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if strings.TrimSpace(string(contents)) != id {
		t.Fatalf("file holds %q, want %q", strings.TrimSpace(string(contents)), id)
	}
}

func TestMachineIDIsStableAcrossReads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machine-id")
	first, err := MachineID(path)
	if err != nil {
		t.Fatalf("first MachineID: %v", err)
	}
	for range 3 {
		again, err := MachineID(path)
		if err != nil {
			t.Fatalf("repeat MachineID: %v", err)
		}
		if again != first {
			t.Fatalf("MachineID = %q, want the identifier already on disk (%q)", again, first)
		}
	}
}

func TestMachineIDIsGeneratedOnlyOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machine-id")
	// A value this CLI could have written, so the only reason to replace it
	// would be a generate-every-time bug.
	if err := os.WriteFile(path, []byte("already-here_0\n"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	id, err := MachineID(path)
	if err != nil {
		t.Fatalf("MachineID: %v", err)
	}
	if id != "already-here_0" {
		t.Fatalf("MachineID = %q, want the identifier already on disk", id)
	}
}

func TestMachineIDDiffersBetweenMachines(t *testing.T) {
	first, err := MachineID(filepath.Join(t.TempDir(), "machine-id"))
	if err != nil {
		t.Fatalf("first MachineID: %v", err)
	}
	second, err := MachineID(filepath.Join(t.TempDir(), "machine-id"))
	if err != nil {
		t.Fatalf("second MachineID: %v", err)
	}
	if first == second {
		t.Fatal("two machines were given the same identifier")
	}
}

func TestMachineIDSurvivesClear(t *testing.T) {
	directory := t.TempDir()
	credentials := filepath.Join(directory, "credentials.json")
	if err := Save(credentials, sampleCredentials()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	before, err := MachineID(MachineIDPath(credentials))
	if err != nil {
		t.Fatalf("MachineID: %v", err)
	}

	if err := Clear(credentials); err != nil {
		t.Fatalf("Clear: %v", err)
	}

	// Signing out and back in is the same machine, so the identifier the
	// accounts service matches on has to outlive the credentials.
	after, err := MachineID(MachineIDPath(credentials))
	if err != nil {
		t.Fatalf("MachineID after Clear: %v", err)
	}
	if after != before {
		t.Fatalf("MachineID after Clear = %q, want %q", after, before)
	}
}

func TestMachineIDReplacesAnUnusableFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machine-id")
	// Whitespace and a character outside the alphabet: the accounts service
	// would ignore it, so keeping it would mean never matching a device.
	if err := os.WriteFile(path, []byte("  not a machine id!  \n"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	id, err := MachineID(path)
	if err != nil {
		t.Fatalf("MachineID: %v", err)
	}
	if !validMachineID(id) {
		t.Fatalf("MachineID = %q, want a usable identifier", id)
	}
	if again, err := MachineID(path); err != nil || again != id {
		t.Fatalf("the replacement was not persisted: %q, %v", again, err)
	}
}

func TestMachineIDIsReadableOnlyByTheOwner(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission bits are not meaningful on Windows")
	}
	directory := t.TempDir()
	path := filepath.Join(directory, "machine-id")
	if _, err := MachineID(path); err != nil {
		t.Fatalf("MachineID: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if permissions := info.Mode().Perm(); permissions != 0o600 {
		t.Fatalf("machine-id mode = %o, want 600", permissions)
	}

	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("MachineID left %s behind", entry.Name())
		}
	}
}

func TestValidMachineIDRejectsWhatTheServiceWould(t *testing.T) {
	tests := []struct {
		name string
		id   string
		want bool
	}{
		{"generated", "abcDEF012-_", true},
		{"empty", "", false},
		{"a space", "two words", false},
		{"punctuation", "a.b", false},
		{"too long", strings.Repeat("a", maxMachineIDLength+1), false},
		{"at the limit", strings.Repeat("a", maxMachineIDLength), true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := validMachineID(test.id); got != test.want {
				t.Fatalf("validMachineID(%q) = %v, want %v", test.id, got, test.want)
			}
		})
	}
}
