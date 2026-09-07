//go:build darwin

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The plist is generated text that launchd either accepts or silently refuses,
// so it is checked by the same parser launchd uses rather than by reading it.

func TestServicePlistIsValid(t *testing.T) {
	plist := servicePlist("/usr/local/bin/shell", map[string]string{
		"SHELL_ONLINE_LOCAL":    "1",
		"SHELL_ONLINE_ACCOUNTS": "http://127.0.0.1:8787",
	})

	path := filepath.Join(t.TempDir(), "agent.plist")
	if err := os.WriteFile(path, []byte(plist), 0o644); err != nil {
		t.Fatalf("write the plist: %v", err)
	}
	if output, err := exec.Command("plutil", "-lint", path).CombinedOutput(); err != nil {
		t.Fatalf("plutil rejected the plist: %v\n%s\n%s", err, output, plist)
	}

	for _, expected := range []string{
		"<string>/usr/local/bin/shell</string>",
		"<string>daemon</string>",
		"<key>SHELL_ONLINE_ACCOUNTS</key>",
		"<string>http://127.0.0.1:8787</string>",
	} {
		if !strings.Contains(plist, expected) {
			t.Fatalf("expected the plist to contain %q, got:\n%s", expected, plist)
		}
	}
}

// A home directory can contain an ampersand. Unescaped, it produces a plist
// launchd refuses, and the failure would appear as a service that never runs.
func TestServicePlistEscapesAwkwardPaths(t *testing.T) {
	plist := servicePlist(`/Users/a&b/bin/shell`, map[string]string{
		"SHELL_ONLINE_WEB": `http://example.com/?a=1&b=<2>`,
	})

	path := filepath.Join(t.TempDir(), "agent.plist")
	if err := os.WriteFile(path, []byte(plist), 0o644); err != nil {
		t.Fatalf("write the plist: %v", err)
	}
	if output, err := exec.Command("plutil", "-lint", path).CombinedOutput(); err != nil {
		t.Fatalf("plutil rejected the plist: %v\n%s\n%s", err, output, plist)
	}
	if strings.Contains(plist, "a&b") {
		t.Fatal("the ampersand should have been escaped")
	}
}

// Only what was set is carried across, so a production install does not end up
// with a stray development address baked into it.
func TestServicePlistCarriesOnlyWhatIsSet(t *testing.T) {
	plist := servicePlist("/usr/local/bin/shell", map[string]string{})
	if strings.Contains(plist, "EnvironmentVariables") {
		t.Fatalf("an empty environment should add no dict, got:\n%s", plist)
	}
}

func TestServiceEnvironmentReadsOnlyTheKnownNames(t *testing.T) {
	t.Setenv("SHELL_ONLINE_ACCOUNTS", "http://127.0.0.1:8787")
	t.Setenv("SHELL_ONLINE_NOT_A_REAL_ONE", "should not travel")
	t.Setenv("PATH", os.Getenv("PATH"))

	environment := serviceEnvironment()
	if environment["SHELL_ONLINE_ACCOUNTS"] != "http://127.0.0.1:8787" {
		t.Fatalf("expected the accounts URL to be carried, got %v", environment)
	}
	if _, present := environment["SHELL_ONLINE_NOT_A_REAL_ONE"]; present {
		t.Fatalf("only the listed names should travel, got %v", environment)
	}
	if _, present := environment["PATH"]; present {
		t.Fatalf("the whole environment should not travel, got %v", environment)
	}
}

// Installing against a binary in a temporary directory produces a service
// pointing at a path that will not exist tomorrow. A test binary is exactly
// that, so this is checked by trying it.
func TestInstallRefusesATemporaryBinary(t *testing.T) {
	self, err := os.Executable()
	if err != nil || !strings.HasPrefix(self, os.TempDir()) {
		t.Skip("this test binary is not in a temporary directory")
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	configPath := filepath.Join(home, "credentials.json")
	t.Setenv("SHELL_ONLINE_CONFIG", configPath)
	if err := os.WriteFile(configPath, []byte(`{"server":"http://127.0.0.1:9","refresh_token":"shr","access_token":"sha","uid":"u","email":"a@b.c","remote_start":true}`), 0o600); err != nil {
		t.Fatalf("write credentials: %v", err)
	}

	var out, errOut strings.Builder
	if code := installServiceCommand(&out, &errOut); code == 0 {
		t.Fatalf("installing from a temporary path should have been refused, got:\n%s", out.String())
	}
	if !strings.Contains(errOut.String(), "temporary") {
		t.Fatalf("the refusal should say why, got: %s", errOut.String())
	}
	// Nothing should have been written.
	if _, installed := serviceInstalled(); installed {
		t.Fatal("a refused install should leave no service behind")
	}
}
