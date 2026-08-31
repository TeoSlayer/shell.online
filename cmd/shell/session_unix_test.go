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
		if size != [2]uint16{120, 42} {
			t.Fatalf("resize = %v", size)
		}
	case <-time.After(time.Second):
		t.Fatal("resize was not forwarded")
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
