//go:build !windows

package main

import (
	"bytes"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestLocalDetachFilterUsesTwoByteSequence(t *testing.T) {
	filter := &localDetachFilter{}
	now := time.Now()
	forward, detached := filter.consume([]byte{'a', localDetachPrefix, 'D', 'z'}, now)
	if !detached {
		t.Fatal("detach sequence was not recognized")
	}
	if string(forward) != "a" {
		t.Fatalf("forward = %q, want %q", forward, "a")
	}
}

func TestLocalDetachFilterRecognizesSplitSequence(t *testing.T) {
	filter := &localDetachFilter{}
	now := time.Now()
	forward, detached := filter.consume([]byte{localDetachPrefix}, now)
	if detached || len(forward) != 0 {
		t.Fatalf("prefix result = %q, detached %v", forward, detached)
	}
	forward, detached = filter.consume([]byte{'d'}, now.Add(10*time.Millisecond))
	if !detached || len(forward) != 0 {
		t.Fatalf("suffix result = %q, detached %v", forward, detached)
	}
}

func TestLocalDetachFilterForwardsTerminalBEL(t *testing.T) {
	filter := &localDetachFilter{}
	terminalReply := []byte("\x1b]lterminal title\x07")
	forward, detached := filter.consume(terminalReply, time.Now())
	if detached {
		t.Fatal("BEL from a terminal reply triggered detach")
	}
	if !bytes.Equal(forward, terminalReply) {
		t.Fatalf("forward = %q, want %q", forward, terminalReply)
	}
}

func TestLocalDetachFilterForwardsUnmatchedPrefix(t *testing.T) {
	filter := &localDetachFilter{}
	now := time.Now()
	forward, detached := filter.consume([]byte{localDetachPrefix, 'x'}, now)
	if detached {
		t.Fatal("unmatched prefix triggered detach")
	}
	if !bytes.Equal(forward, []byte{localDetachPrefix, 'x'}) {
		t.Fatalf("forward = %q", forward)
	}

	forward, detached = filter.consume([]byte{localDetachPrefix}, now)
	if detached || len(forward) != 0 {
		t.Fatalf("second prefix result = %q, detached %v", forward, detached)
	}
	if got := filter.flushExpired(now.Add(localDetachSequenceTimeout)); !bytes.Equal(got, []byte{localDetachPrefix}) {
		t.Fatalf("expired prefix = %q", got)
	}
}

func TestLocalDetachFilterKeepsLegacyShortcut(t *testing.T) {
	filter := &localDetachFilter{}
	forward, detached := filter.consume([]byte{'a', legacyLocalDetachByte, 'z'}, time.Now())
	if !detached || string(forward) != "a" {
		t.Fatalf("forward = %q, detached %v", forward, detached)
	}
}

func TestDiscardPendingTerminalInputWaitsForLateReply(t *testing.T) {
	input, terminal, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	defer terminal.Close()

	written := make(chan error, 1)
	go func() {
		time.Sleep(20 * time.Millisecond)
		_, writeError := terminal.Write([]byte("\x1b[?1;2c"))
		written <- writeError
	}()
	discardPendingTerminalInput(input, int(input.Fd()))
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	descriptors := []unix.PollFd{{Fd: int32(input.Fd()), Events: unix.POLLIN}}
	ready, err := unix.Poll(descriptors, 0)
	if err != nil {
		t.Fatal(err)
	}
	if ready != 0 || descriptors[0].Revents&unix.POLLIN != 0 {
		t.Fatal("late terminal reply remains pending")
	}
}

func TestAttachOutputWriterKeepsGuidanceAfterChildTitle(t *testing.T) {
	var output bytes.Buffer
	var titleOutput bytes.Buffer
	writer := &attachOutputWriter{output: &output, titleOutput: &titleOutput}
	value := []byte("before\x1b]0;child title\x07after")

	count, err := writer.Write(value)
	if err != nil {
		t.Fatal(err)
	}
	if count != len(value) {
		t.Fatalf("Write() = %d, want %d", count, len(value))
	}
	if !bytes.Equal(output.Bytes(), value) {
		t.Fatalf("output = %q, want %q", output.Bytes(), value)
	}
	if titleOutput.String() != setAttachTitle {
		t.Fatalf("title output = %q, want %q", titleOutput.String(), setAttachTitle)
	}
}

func TestAttachOutputWriterTracksSplitTitleSequence(t *testing.T) {
	var output bytes.Buffer
	var titleOutput bytes.Buffer
	writer := &attachOutputWriter{output: &output, titleOutput: &titleOutput}
	parts := [][]byte{
		[]byte("before\x1b]0;child"),
		[]byte(" title\x1b"),
		[]byte("\\after"),
	}

	for _, part := range parts {
		count, err := writer.Write(part)
		if err != nil {
			t.Fatal(err)
		}
		if count != len(part) {
			t.Fatalf("Write() = %d, want %d", count, len(part))
		}
	}
	if !bytes.Equal(output.Bytes(), bytes.Join(parts, nil)) {
		t.Fatalf("output = %q", output.Bytes())
	}
	if titleOutput.String() != setAttachTitle {
		t.Fatalf("title output = %q, want %q", titleOutput.String(), setAttachTitle)
	}
}

func TestTerminalDisplayRestoreCancelsTUIState(t *testing.T) {
	for _, expected := range []string{
		"\x18",
		"\x1b\\",
		"\x1b[0m",
		"\x1b[?25h",
		"\x1b[?1006l",
		"\x1b[?2004l",
		"\x1b[?1049l",
	} {
		if !bytes.Contains([]byte(restoreTerminalDisplay), []byte(expected)) {
			t.Errorf("terminal restore does not contain %q", expected)
		}
	}
}
