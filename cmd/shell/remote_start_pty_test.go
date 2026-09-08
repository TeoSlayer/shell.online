//go:build !windows

package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aymanbagabas/go-pty"
)

// The consent prompt only appears when there is a terminal at both ends, which
// is the one thing the unit tests cannot arrange. These run the real binary
// under a pty and answer it, so what is checked is the wiring: that the
// question is asked, that the answer is written down, and that the machine
// ends up in the state the answer describes.

// answerUnderPTY runs the binary with a terminal attached, sends one reply,
// and returns everything it printed.
func answerUnderPTY(t *testing.T, binary, configPath, runtime, reply string, arguments ...string) string {
	t.Helper()
	terminal, err := pty.New()
	if err != nil {
		t.Skipf("no pty available: %v", err)
	}
	defer terminal.Close()

	command := terminal.Command(binary, arguments...)
	command.Env = append(os.Environ(),
		"SHELL_ONLINE_CONFIG="+configPath,
		"SHELL_ONLINE_RUNTIME_DIR="+filepath.Join(runtime, "run"),
		// Colour codes would only make the assertions harder to read.
		"NO_COLOR=1",
	)
	if err := command.Start(); err != nil {
		t.Fatalf("start under pty: %v", err)
	}

	transcript := make(chan string, 1)
	go func() {
		output, _ := io.ReadAll(terminal)
		transcript <- string(output)
	}()

	// The prompt is written before the read, so a short pause is enough to be
	// answering a question rather than racing it.
	time.Sleep(300 * time.Millisecond)
	if reply != "" {
		/*
		 * A write error is not a failure. A command that was never going to
		 * ask -- a machine that already agreed -- can finish before the reply
		 * arrives, and writing into the pty of an exited child reports an I/O
		 * error. What the test asserts is the transcript, not the write.
		 */
		_, _ = terminal.Write([]byte(reply))
	}

	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("the command never finished")
	}
	_ = terminal.Close()

	select {
	case output := <-transcript:
		return output
	case <-time.After(5 * time.Second):
		return ""
	}
}

func recordedConsent(t *testing.T, configPath string) bool {
	t.Helper()
	contents, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read credentials: %v", err)
	}
	var stored struct {
		RemoteStart bool `json:"remote_start"`
	}
	if err := json.Unmarshal(contents, &stored); err != nil {
		t.Fatalf("decode credentials: %v", err)
	}
	return stored.RemoteStart
}

func TestConsentPromptGrantsOnYes(t *testing.T) {
	binary := buildShell(t)
	configPath, runtime := linkedMachine(t, false)

	output := answerUnderPTY(t, binary, configPath, runtime, "y\n", "daemon", "start")
	if !strings.Contains(output, "Allow it?") {
		t.Fatalf("expected the consent prompt, got:\n%s", output)
	}
	if !recordedConsent(t, configPath) {
		t.Fatal("yes should have been written to the credentials file")
	}
	waitForDaemon(t, binary, configPath, runtime, true)
	_ = daemonCommand(t, binary, configPath, runtime, "daemon", "stop").Run()
}

func TestConsentPromptLeavesNothingRunningOnNo(t *testing.T) {
	binary := buildShell(t)
	configPath, runtime := linkedMachine(t, false)

	output := answerUnderPTY(t, binary, configPath, runtime, "n\n", "daemon", "start")
	if !strings.Contains(output, "Allow it?") {
		t.Fatalf("expected the consent prompt, got:\n%s", output)
	}
	if recordedConsent(t, configPath) {
		t.Fatal("no should not have granted anything")
	}
	if daemonCommand(t, binary, configPath, runtime, "daemon", "status").Run() == nil {
		t.Fatal("a machine that said no should have no daemon")
	}
}

// Pressing enter without reading is the commonest way to answer a prompt, and
// it must not be how someone grants a browser the right to run commands here.
func TestConsentPromptTreatsEnterAsNo(t *testing.T) {
	binary := buildShell(t)
	configPath, runtime := linkedMachine(t, false)

	answerUnderPTY(t, binary, configPath, runtime, "\n", "daemon", "start")
	if recordedConsent(t, configPath) {
		t.Fatal("a bare enter should not have granted anything")
	}
}

// Once granted, the question is never put again.
func TestConsentIsNotAskedTwice(t *testing.T) {
	binary := buildShell(t)
	configPath, runtime := linkedMachine(t, true)

	output := answerUnderPTY(t, binary, configPath, runtime, "", "daemon", "start")
	if strings.Contains(output, "Allow it?") {
		t.Fatalf("a machine that already agreed should not be asked, got:\n%s", output)
	}
	waitForDaemon(t, binary, configPath, runtime, true)
	_ = daemonCommand(t, binary, configPath, runtime, "daemon", "stop").Run()
}
