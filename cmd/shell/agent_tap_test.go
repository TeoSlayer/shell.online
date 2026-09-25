package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"shell.online/internal/protocol"
)

// session writes a Claude Code record for dir, as the agent would.
func session(t *testing.T, home, dir string, records ...map[string]any) {
	t.Helper()
	project := filepath.Join(home, ".claude", "projects", "-project")
	if err := os.MkdirAll(project, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(project, "session.jsonl")
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	all := append([]map[string]any{{"type": "session", "cwd": dir}}, records...)
	for _, record := range all {
		line, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(append(line, '\n')); err != nil {
			t.Fatal(err)
		}
	}
}

func said(role, text string) map[string]any {
	return map[string]any{
		"type":      role,
		"timestamp": "2026-09-25T12:00:00.000Z",
		"message":   map[string]any{"role": role, "content": text},
	}
}

// collected runs the tap against a home directory and returns the frames it sent.
func collected(t *testing.T, home, dir string, wait time.Duration) [][]byte {
	t.Helper()
	/*
	 * Both, because os.UserHomeDir reads a different one per platform:
	 * USERPROFILE on Windows, HOME everywhere else. Setting only HOME left the
	 * tap looking in the real profile on a Windows runner, finding nothing,
	 * and sending nothing -- which is exactly what the test then reported.
	 */
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	var frames [][]byte
	done := make(chan struct{})
	go func() {
		defer close(done)
		followAgentRecord(ctx, dir, func(frame []byte) bool {
			mu.Lock()
			frames = append(frames, append([]byte(nil), frame...))
			mu.Unlock()
			return true
		})
	}()
	time.Sleep(wait)
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	return frames
}

/*
 * The conversation an agent recorded reaches the wire as its own opcode. It is
 * sealed by the emitter that sends it -- the same one and therefore the same
 * cipher as terminal output -- so the relay forwards it without being able to
 * read it. That sealing is asserted where it happens; what this asserts is
 * that the tap hands its frames to that emitter and nowhere else.
 */
func TestTheTapSendsTheConversationAsItsOwnOpcode(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "work")
	session(t, home, dir, said("user", "npm test"), said("assistant", "all passed"))

	frames := collected(t, home, dir, 2*time.Second)
	if len(frames) == 0 {
		t.Fatal("the tap sent nothing")
	}
	for _, frame := range frames {
		if frame[0] != protocol.AgentEvent {
			t.Fatalf("opcode = %#x, want AgentEvent", frame[0])
		}
	}
	var batch agentTapFrame
	if err := json.Unmarshal(frames[0][1:], &batch); err != nil {
		t.Fatal(err)
	}
	if batch.Harness != "claude-code" || len(batch.Events) != 2 {
		t.Fatalf("batch = %+v", batch)
	}
	if batch.Events[0].Text != "npm test" || batch.Events[1].Text != "all passed" {
		t.Fatalf("events = %+v", batch.Events)
	}
}

/* A session that is only ever a shell has no record, and nothing is sent. */
func TestTheTapSendsNothingWithoutARecord(t *testing.T) {
	home := t.TempDir()
	if frames := collected(t, home, filepath.Join(home, "work"), 1500*time.Millisecond); len(frames) != 0 {
		t.Fatalf("sent %d frames with no record", len(frames))
	}
}

/*
 * What the agent keeps that is not the conversation stays on the machine.
 * Asserted here as well as in the adapter, because this is the boundary that
 * actually puts bytes on a wire.
 */
func TestTheTapDoesNotSendWhatItWasNotAskedTo(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "work")
	session(t, home, dir,
		map[string]any{"type": "attachment", "content": "the whole of a private file"},
		map[string]any{"type": "ai-title", "title": "a private title"},
		map[string]any{
			"type": "assistant", "timestamp": "2026-09-25T12:00:00.000Z",
			"message": map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "tool_use", "name": "Bash", "input": map[string]any{"command": "cat /etc/shadow"}},
			}},
		},
	)
	frames := collected(t, home, dir, 2*time.Second)
	if len(frames) == 0 {
		t.Fatal("the tap sent nothing")
	}
	whole := string(frames[0])
	for _, secret := range []string{"private file", "private title", "/etc/shadow", "cat "} {
		if strings.Contains(whole, secret) {
			t.Fatalf("%q left the machine", secret)
		}
	}
	/* The tool is named, which is the whole of what a viewer needs. */
	if !strings.Contains(whole, "Bash") {
		t.Fatalf("frame = %s", whole)
	}
}

/*
 * Every frame fits what the relay will accept.
 *
 * The relay refuses an agent frame over 256KB and closes the socket that sent
 * it, so counting events is not enough: forty messages at the 32KB each is
 * capped at is 1.28MB. A long conversation of long answers would have
 * disconnected the host rather than arriving.
 */
func TestEveryFrameFitsWhatTheRelayAccepts(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "work")
	var records []map[string]any
	for i := 0; i < 30; i++ {
		records = append(records, said("assistant", strings.Repeat("x", 30_000)))
	}
	session(t, home, dir, records...)

	frames := collected(t, home, dir, 2*time.Second)
	if len(frames) < 5 {
		t.Fatalf("frames = %d, want the conversation split across several", len(frames))
	}
	for _, frame := range frames {
		if len(frame) > agentTapMaxFrameBytes {
			t.Fatalf("a frame of %d bytes, want <= %d", len(frame), agentTapMaxFrameBytes)
		}
	}
	/* And all of it arrived: nothing was dropped to make the frames fit. */
	seen := 0
	for _, frame := range frames {
		var batch agentTapFrame
		if err := json.Unmarshal(frame[1:], &batch); err != nil {
			t.Fatal(err)
		}
		seen += len(batch.Events)
	}
	if seen != 30 {
		t.Fatalf("events = %d, want 30", seen)
	}
}

/* A long conversation arrives as many ordinary frames, not one enormous one. */
func TestTheTapBatches(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "work")
	var records []map[string]any
	for i := 0; i < agentTapMaxBatch*2+5; i++ {
		records = append(records, said("assistant", "line"))
	}
	session(t, home, dir, records...)

	frames := collected(t, home, dir, 2*time.Second)
	if len(frames) < 3 {
		t.Fatalf("frames = %d, want the batch split", len(frames))
	}
	for _, frame := range frames {
		var batch agentTapFrame
		if err := json.Unmarshal(frame[1:], &batch); err != nil {
			t.Fatal(err)
		}
		if len(batch.Events) > agentTapMaxBatch {
			t.Fatalf("batch of %d, want <= %d", len(batch.Events), agentTapMaxBatch)
		}
	}
}
