package main

import (
	"bytes"
	"strings"
	"testing"
)

/*
 * A service is a path the operating system is asked to keep running. Handing
 * it one under the build cache is the supervised version of the fork bomb
 * daemon.go guards against, so the guard is checked from the place that would
 * trip it: a test binary, which is both temporary and a test binary.
 */
func TestInstallDaemonServiceRefusesATestBinary(t *testing.T) {
	written, err := installDaemonService()
	if err == nil {
		t.Fatalf("a test binary was installed as a service at %q", written)
	}
	if written != "" {
		t.Errorf("nothing should have been written, got %q", written)
	}
}

// A login that cannot install a service is still a login. It says what was
// lost -- surviving a restart -- and what to run once it is sorted.
func TestInstallServiceAfterLoginExplainsItselfWithoutFailing(t *testing.T) {
	var stdout, stderr bytes.Buffer
	installServiceAfterLogin(&stdout, &stderr)

	if _, installed := serviceInstalled(); installed {
		t.Skip("a real service is installed on this machine; nothing to observe")
	}
	if stderr.Len() == 0 {
		t.Fatal("a failed install should say so")
	}
	for _, expected := range []string{"reachable across restarts", "shell service install"} {
		if !strings.Contains(stderr.String(), expected) {
			t.Errorf("stderr %q does not mention %q", stderr.String(), expected)
		}
	}
}
