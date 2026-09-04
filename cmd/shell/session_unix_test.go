//go:build !windows

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"shell.online/internal/protocol"
	"shell.online/internal/ringbuffer"
)

func TestTerminalEnvironmentAdvertisesBrowserCapabilities(t *testing.T) {
	environment := terminalEnvironment([]string{
		"PATH=/bin",
		"TERM=dumb",
		"COLORTERM=old",
		"COLORFGBG=0;15",
		backgroundChildEnvironment + "=1",
		backgroundReadyEnvironment + "=3",
		backgroundParentEnvironment + "=12345",
	})

	want := map[string]string{
		"TERM":         "xterm-256color",
		"COLORTERM":    "truecolor",
		"COLORFGBG":    "15;0",
		"SHELL_ONLINE": "1",
	}
	for name, value := range want {
		prefix := name + "="
		found := false
		for _, entry := range environment {
			if entry == prefix+value {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("terminalEnvironment() does not contain %q", prefix+value)
		}
	}
	for _, name := range []string{
		backgroundChildEnvironment,
		backgroundReadyEnvironment,
		backgroundParentEnvironment,
	} {
		if value := environmentValue(environment, name); value != "" {
			t.Errorf("terminalEnvironment() retained internal %s=%q", name, value)
		}
	}
}

func TestTerminalProcessRoundTripsInputAndResize(t *testing.T) {
	process, err := startTerminalProcess(
		[]string{"/bin/sh", "-c", `stty -echo; printf 'ready\n'; IFS= read -r line; stty size; printf 'reply:%s\n' "$line"`},
		terminalEnvironment([]string{"PATH=/usr/bin:/bin"}),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		terminateProcess(process.Process(), true)
		_ = process.Close()
	}()

	lines := make(chan string, 4)
	readErrors := make(chan error, 1)
	go func() {
		reader := bufio.NewReader(process)
		for {
			line, readError := reader.ReadString('\n')
			if line != "" {
				lines <- strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
			}
			if readError != nil {
				readErrors <- readError
				return
			}
		}
	}()

	nextLine := func() string {
		t.Helper()
		select {
		case line := <-lines:
			return line
		case readError := <-readErrors:
			t.Fatalf("read terminal output: %v", readError)
		case <-time.After(5 * time.Second):
			t.Fatal("timed out reading terminal output")
		}
		return ""
	}

	if line := nextLine(); line != "ready" {
		t.Fatalf("first terminal line = %q", line)
	}
	if err := process.Resize(91, 37); err != nil {
		t.Fatal(err)
	}
	if _, err := process.Write([]byte("hello from qemu\n")); err != nil {
		t.Fatal(err)
	}
	if line := nextLine(); line != "37 91" {
		t.Fatalf("resized terminal reported %q", line)
	}
	if line := nextLine(); line != "reply:hello from qemu" {
		t.Fatalf("terminal reply = %q", line)
	}
	if err := process.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := process.Finish(); err != nil {
		t.Fatal(err)
	}
}

type capturedInput struct {
	values chan []byte
}

func (capture *capturedInput) Write(value []byte) (int, error) {
	capture.values <- append([]byte(nil), value...)
	return len(value), nil
}

func TestLocalAttachmentReplaysAndMirrorsTerminal(t *testing.T) {
	id := strings.Repeat("a", 31) + "1"
	control, err := startLocalSession(localSessionRecord{
		ID:        id,
		ShareURL:  "https://shell.online/s/" + id,
		Command:   "test-command",
		PID:       12345,
		StartedAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()

	output := ringbuffer.New(1024)
	input := &capturedInput{values: make(chan []byte, 1)}
	resizes := make(chan [2]uint16, 1)
	attachChanges := make(chan bool, 2)
	control.BindTerminal(input, output, func(cols, rows uint16) error {
		resizes <- [2]uint16{cols, rows}
		return nil
	}, nil, func(attached bool) { attachChanges <- attached })
	control.PublishOutput([]byte("existing\r\n"))

	directory, _ := localSessionDirectory()
	connection, err := net.DialTimeout("unix", localSessionSocketPath(directory, id), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := fmt.Fprintln(connection, "attach"); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(connection)
	responseLine, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var response localControlResponse
	if err := json.Unmarshal(responseLine, &response); err != nil || !response.OK {
		t.Fatalf("attach response = %q, error = %v", responseLine, err)
	}

	replayed := make([]byte, len("existing\r\n"))
	if _, err := io.ReadFull(reader, replayed); err != nil {
		t.Fatal(err)
	}
	if string(replayed) != "existing\r\n" {
		t.Fatalf("replayed output = %q", replayed)
	}
	select {
	case attached := <-attachChanges:
		if !attached {
			t.Fatal("local attachment did not claim PTY sizing")
		}
	case <-time.After(time.Second):
		t.Fatal("local attachment change was not reported")
	}

	if err := writeAll(connection, []byte("local input")); err != nil {
		t.Fatal(err)
	}
	select {
	case value := <-input.values:
		if string(value) != "local input" {
			t.Fatalf("attached input = %q", value)
		}
	case <-time.After(time.Second):
		t.Fatal("attached input was not forwarded")
	}

	control.PublishOutput([]byte("mirrored"))
	mirrored := make([]byte, len("mirrored"))
	if _, err := io.ReadFull(reader, mirrored); err != nil {
		t.Fatal(err)
	}
	if string(mirrored) != "mirrored" {
		t.Fatalf("mirrored output = %q", mirrored)
	}

	if err := requestLocalSessionResize(id, 120, 42); err != nil {
		t.Fatal(err)
	}
	select {
	case size := <-resizes:
		t.Fatalf("shared terminal was resized to %v", size)
	case <-time.After(50 * time.Millisecond):
		// The compatibility request is acknowledged without deforming the PTY.
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case attached := <-attachChanges:
		if attached {
			t.Fatal("local detachment did not release PTY sizing")
		}
	case <-time.After(time.Second):
		t.Fatal("local detachment change was not reported")
	}
}

func TestSharedTerminalUsesLargeGridUntilPhoneCompatibilityIsRequested(t *testing.T) {
	size := sharedTerminalSize()
	if size.Cols != 120 || size.Rows != 36 {
		t.Fatalf("shared terminal size = %dx%d, want 120x36", size.Cols, size.Rows)
	}
	for _, candidate := range [][2]uint16{{120, 36}, {80, 24}} {
		if !isCanonicalTerminalSize(candidate[0], candidate[1]) {
			t.Fatalf("canonical terminal size %v was rejected", candidate)
		}
	}
	for _, candidate := range [][2]uint16{{160, 50}, {79, 24}, {80, 25}} {
		if isCanonicalTerminalSize(candidate[0], candidate[1]) {
			t.Fatalf("arbitrary terminal size %v was accepted", candidate)
		}
	}
}

func TestBackgroundStartupWaitDetectsFastExit(t *testing.T) {
	result := make(chan error, 1)
	result <- nil
	if err, exited := waitForBackgroundStartup(result, time.Second); err != nil || !exited {
		t.Fatalf("fast exit = (%v, %v), want (nil, true)", err, exited)
	}
}

func TestBackgroundStartupWaitReleasesLongRunningTask(t *testing.T) {
	result := make(chan error)
	started := time.Now()
	if err, exited := waitForBackgroundStartup(result, 10*time.Millisecond); err != nil || exited {
		t.Fatalf("long-running task = (%v, %v), want (nil, false)", err, exited)
	}
	if time.Since(started) < 8*time.Millisecond {
		t.Fatal("startup grace returned before its deadline")
	}
}

func TestViewerInputPayloadRequiresExplicitConfirmedEOF(t *testing.T) {
	if got := viewerInputPayload([]byte{protocol.Input, 'o', 'k'}); string(got) != "ok" {
		t.Fatalf("regular viewer input = %q, want ok", got)
	}
	if got := viewerInputPayload([]byte{protocol.ConfirmedEOF}); len(got) != 1 || got[0] != 4 {
		t.Fatalf("confirmed EOF = %v, want [4]", got)
	}
	for _, frame := range [][]byte{{protocol.Input}, {protocol.Input, 4}, {protocol.ConfirmedEOF, 4}, {4}} {
		if got := viewerInputPayload(frame); len(got) != 0 {
			t.Fatalf("invalid frame %v produced input %v", frame, got)
		}
	}
}
