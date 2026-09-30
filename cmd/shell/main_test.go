package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMain keeps the test binary from ever acting on the developer's machine.
//
// An ordinary command brings the machine daemon up by re-executing its own
// binary with "daemon". Under go test that binary is shell.test, which would
// run the whole suite again, whose tests start more daemons in turn. Two
// guards stop that:
//
//   - A test binary started with a subcommand exits at once instead of
//     running tests, so any self-execution ends there.
//   - Credentials point at a file that does not exist, so nothing reaches
//     the linked account, and ensureDaemon finds no consent to start anything.
//     Tests that need an account set their own with t.Setenv.
//
// Nothing else of shell.online's is inherited either. Run inside a shared
// session, the suite otherwise read that session's name, command, origin and
// password as its own, and failed only there.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && (os.Args[1] == "daemon" || os.Args[1] == "agent" || os.Args[1] == "service") {
		os.Exit(0)
	}
	directory, err := os.MkdirTemp("", "shell-test-config-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "shell tests: %v\n", err)
		os.Exit(1)
	}
	for _, entry := range os.Environ() {
		if name, _, _ := strings.Cut(entry, "="); strings.HasPrefix(name, "SHELL_ONLINE") {
			_ = os.Unsetenv(name)
		}
	}
	_ = os.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(directory, "no-credentials.json"))
	code := m.Run()
	_ = os.RemoveAll(directory)
	os.Exit(code)
}

func TestIsGoTestBinary(t *testing.T) {
	for _, path := range []string{"/tmp/go-build1/b001/shell.test", "shell.test", "shell.test.exe"} {
		if !isGoTestBinary(path) {
			t.Errorf("isGoTestBinary(%q) = false, want true", path)
		}
	}
	for _, path := range []string{"/usr/local/bin/shell", "shell.exe", "/opt/test/shell", "/tmp/contest"} {
		if isGoTestBinary(path) {
			t.Errorf("isGoTestBinary(%q) = true, want false", path)
		}
	}
}
