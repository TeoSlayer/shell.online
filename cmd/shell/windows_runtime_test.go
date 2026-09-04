//go:build windows

package main

import (
	"bytes"
	"io"
	"strings"
	"testing"
	"time"

	"shell.online/internal/ringbuffer"
)

func TestWindowsConPTYRunsInteractiveCommand(t *testing.T) {
	terminal, err := startTerminalProcess([]string{"cmd.exe", "/d", "/s", "/c", "echo conpty-ready"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	output := make(chan string, 1)
	go func() {
		value, _ := io.ReadAll(terminal)
		output <- string(value)
	}()
	if err := terminal.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := terminal.Finish(); err != nil {
		t.Fatal(err)
	}
	select {
	case value := <-output:
		if !strings.Contains(value, "conpty-ready") {
			t.Fatalf("ConPTY output = %q", value)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ConPTY output did not close")
	}
	if err := terminal.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsLocalSessionListAttachAndStop(t *testing.T) {
	id := strings.Repeat("W", 32)
	record := localSessionRecord{ID: id, ShareURL: "https://shell.online/s/test", Command: "cmd.exe", PID: 123, StartedAt: time.Now()}
	control, err := startLocalSession(record)
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	input := &bytes.Buffer{}
	output := ringbuffer.New(1024)
	control.BindTerminal(input, output, nil, nil, nil)
	sessions, err := loadActiveLocalSessions()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, session := range sessions {
		found = found || session.ID == id
	}
	if !found {
		t.Fatal("active Windows session was not listed")
	}
	if err := requestLocalSessionStop(id); err != nil {
		t.Fatal(err)
	}
	select {
	case <-control.StopRequested():
	case <-time.After(time.Second):
		t.Fatal("Windows stop request was not delivered")
	}
}
