//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The daemon is built once and run as a real process, because what is being
// tested is what happens between processes: whether a second one can take the
// lock, and whether the socket it leaves behind blocks the next one.
func buildShell(t *testing.T) string {
	t.Helper()
	if os.Getenv("SHELL_ONLINE_QEMU") == "1" {
		t.Skip("a cross-compiled child cannot be executed outside the user-mode emulator")
	}
	binary := filepath.Join(t.TempDir(), "shell")
	build := exec.Command("go", "build", "-o", binary, "shell.online/cmd/shell")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("build shell: %v", err)
	}

	/*
	 * These tests run the binary they just built. The QEMU release matrix
	 * cross-compiles the suite and runs it with `go test -exec <emulator>`, so
	 * the test process is emulated but anything it spawns is not: the host
	 * kernel cannot exec a binary built for another architecture, and every
	 * one of these fails with "exec format error".
	 *
	 * Nothing being tested here is architecture-specific -- it is process
	 * lifetime, a file lock and a socket -- so it is covered natively and
	 * skipped where a spawned binary cannot run.
	 */
	if output, err := exec.Command(binary, "--version").CombinedOutput(); err != nil {
		t.Skipf("cannot run a freshly built binary here (%v): %s", err, output)
	}
	return binary
}

// shortTempDir is a temporary directory under /tmp rather than t.TempDir().
//
// A unix socket path has about a hundred bytes to fit in, and the per-test
// directory macOS hands out is most of that on its own -- so a test would pass
// or fail on the length of its own name.
func shortTempDir(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "sh")
	if err != nil {
		t.Fatalf("create a temporary directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}

// linkedMachine writes a credentials file that says this machine agreed.
func linkedMachine(t *testing.T, remoteStart bool) (configPath, runtimeDirectory string) {
	t.Helper()
	directory := shortTempDir(t)
	configPath = filepath.Join(directory, "credentials.json")
	consent := ""
	if remoteStart {
		consent = `"remote_start": true,`
	}
	// Far enough ahead that the loop never tries to refresh against a service
	// that is not there.
	expires := time.Now().Add(24 * time.Hour).Format(time.RFC3339)
	contents := `{
  "server": "http://127.0.0.1:9",
  "access_token": "sha_test",
  "refresh_token": "shr_test",
  "expires_at": "` + expires + `",
  ` + consent + `
  "uid": "uid-1",
  "email": "ana@example.com"
}`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write credentials: %v", err)
	}
	return configPath, directory
}

func daemonCommand(t *testing.T, binary, configPath, runtime string, arguments ...string) *exec.Cmd {
	t.Helper()
	command := exec.Command(binary, arguments...)
	command.Env = append(os.Environ(),
		"SHELL_ONLINE_CONFIG="+configPath,
		// Keeps the control socket inside the test's own directory.
		"SHELL_ONLINE_RUNTIME_DIR="+filepath.Join(runtime, "run"),
	)
	return command
}

func waitForDaemon(t *testing.T, binary, configPath, runtime string, want bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		status := daemonCommand(t, binary, configPath, runtime, "daemon", "status")
		running := status.Run() == nil
		if running == want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("daemon running=%v never became %v", !want, want)
}

// Two pollers on one machine is not merely wasteful. The browser seals a
// session password to one public key on the device record, and queued work
// goes to whichever poller claims it first, so the second one receives
// commands it cannot open. Only one may hold the lock.
func TestSecondDaemonDoesNotStart(t *testing.T) {
	binary := buildShell(t)
	configPath, runtime := linkedMachine(t, true)

	first := daemonCommand(t, binary, configPath, runtime, "daemon")
	if err := first.Start(); err != nil {
		t.Fatalf("start the first daemon: %v", err)
	}
	defer func() {
		_ = first.Process.Kill()
		_, _ = first.Process.Wait()
	}()
	waitForDaemon(t, binary, configPath, runtime, true)

	second := daemonCommand(t, binary, configPath, runtime, "daemon")
	output, err := second.CombinedOutput()
	if err != nil {
		t.Fatalf("the second daemon should exit cleanly, got %v: %s", err, output)
	}
	if !strings.Contains(string(output), "already running") {
		t.Fatalf("the second daemon should say one is already running, got: %s", output)
	}
}

// A daemon that was killed leaves its socket behind. Nothing would ever start
// again if that file were treated as a running daemon.
func TestDaemonStartsOverASocketLeftByADeadDaemon(t *testing.T) {
	binary := buildShell(t)
	configPath, runtime := linkedMachine(t, true)

	first := daemonCommand(t, binary, configPath, runtime, "daemon")
	if err := first.Start(); err != nil {
		t.Fatalf("start the first daemon: %v", err)
	}
	waitForDaemon(t, binary, configPath, runtime, true)

	// SIGKILL, so nothing gets the chance to clean up after itself.
	_ = first.Process.Kill()
	_, _ = first.Process.Wait()
	waitForDaemon(t, binary, configPath, runtime, false)

	replacement := daemonCommand(t, binary, configPath, runtime, "daemon")
	if err := replacement.Start(); err != nil {
		t.Fatalf("start the replacement daemon: %v", err)
	}
	defer func() {
		_ = replacement.Process.Kill()
		_, _ = replacement.Process.Wait()
	}()
	waitForDaemon(t, binary, configPath, runtime, true)
}

// The daemon is the machine's answer to "may a browser run things here". A
// machine that never agreed must not get one, however it is started.
func TestDaemonRefusesWithoutConsent(t *testing.T) {
	binary := buildShell(t)
	configPath, runtime := linkedMachine(t, false)

	output, err := daemonCommand(t, binary, configPath, runtime, "daemon").CombinedOutput()
	if err == nil {
		t.Fatalf("the daemon should refuse without consent, got: %s", output)
	}
	if !strings.Contains(string(output), "--allow-remote-start") {
		t.Fatalf("the refusal should say how to grant it, got: %s", output)
	}
}

// An ordinary command brings the daemon back, which is what makes a machine
// reachable again after a reboot without anyone thinking about it.
func TestAnOrdinaryCommandStartsTheDaemon(t *testing.T) {
	binary := buildShell(t)
	configPath, runtime := linkedMachine(t, true)

	// `list` needs nothing from the network and exits immediately.
	if err := daemonCommand(t, binary, configPath, runtime, "list").Run(); err != nil {
		t.Fatalf("shell list: %v", err)
	}
	waitForDaemon(t, binary, configPath, runtime, true)

	stop := daemonCommand(t, binary, configPath, runtime, "daemon", "stop")
	if err := stop.Run(); err != nil {
		t.Fatalf("shell daemon stop: %v", err)
	}
	waitForDaemon(t, binary, configPath, runtime, false)
}

// Without consent nothing should appear, however many commands are run.
func TestAnOrdinaryCommandStartsNoDaemonWithoutConsent(t *testing.T) {
	binary := buildShell(t)
	configPath, runtime := linkedMachine(t, false)

	if err := daemonCommand(t, binary, configPath, runtime, "list").Run(); err != nil {
		t.Fatalf("shell list: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	if daemonCommand(t, binary, configPath, runtime, "daemon", "status").Run() == nil {
		t.Fatal("a machine that did not agree should have no daemon")
	}
}

// An ordinary command must leave a running daemon alone.
//
// ensureDaemon runs on every command, and restarting there would re-key the
// agent each time. A browser seals a session password to the key the daemon
// published, so throwing it away mid-session makes work already queued
// impossible to open. Only `shell login` replaces a daemon, because only a
// login produces credentials the running one cannot know about.
func TestAnOrdinaryCommandLeavesTheDaemonAlone(t *testing.T) {
	binary := buildShell(t)
	configPath, runtime := linkedMachine(t, true)

	first := daemonCommand(t, binary, configPath, runtime, "daemon")
	if err := first.Start(); err != nil {
		t.Fatalf("start the daemon: %v", err)
	}
	defer func() {
		_ = first.Process.Kill()
		_, _ = first.Process.Wait()
	}()
	waitForDaemon(t, binary, configPath, runtime, true)
	original := first.Process.Pid

	ordinary := daemonCommand(t, binary, configPath, runtime, "true")
	if output, err := ordinary.CombinedOutput(); err != nil {
		t.Fatalf("run an ordinary command: %v: %s", err, output)
	}

	if !processAlive(original) {
		t.Fatalf("daemon %d was replaced by an ordinary command; that re-keys the agent", original)
	}
}

// processAlive reports whether a pid still names a live process.
func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}
