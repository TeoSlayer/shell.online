package agentlog

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

/*
 * Written against the records a real OpenClaw wrote: a trajectory is an event
 * log, the conversation is in two of its types, and everything else is the
 * runtime talking to itself.
 */
func openclawSession(t *testing.T, home, agent, workspace string) string {
	t.Helper()
	dir := filepath.Join(home, ".openclaw", "agents", agent, "sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "62c8bd58.trajectory.jsonl")
	write(t, path, map[string]any{
		"type": "session.started", "ts": "2026-09-25T12:00:00.000Z", "workspaceDir": workspace,
	})
	return path
}

func TestOpenClawReadsAPromptAndAnAnswer(t *testing.T) {
	home := t.TempDir()
	path := openclawSession(t, home, "main", "/tmp/work")
	write(t, path, map[string]any{
		"type": "prompt.submitted", "ts": "2026-09-25T12:00:01.000Z", "workspaceDir": "/tmp/work",
		"data": map[string]any{"prompt": "what changed today?"},
	})
	write(t, path, map[string]any{
		"type": "model.completed", "ts": "2026-09-25T12:00:09.000Z", "workspaceDir": "/tmp/work",
		"data": map[string]any{"assistantTexts": []any{"Two things.", "The first is the grid."}},
	})

	reader, err := (OpenClaw{}).Open(home, "/tmp/work", time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	events, err := reader.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events = %+v", events)
	}
	if events[0].Kind != KindUser || events[0].Text != "what changed today?" {
		t.Fatalf("first = %+v", events[0])
	}
	/*
	 * One completion is everything said in that run. Joined rather than split:
	 * the record does not say where one message ended and the next began, and
	 * inventing boundaries is the guessing this package exists to stop.
	 */
	if events[1].Kind != KindAssistant || events[1].Text != "Two things.\n\nThe first is the grid." {
		t.Fatalf("second = %+v", events[1])
	}
	if events[1].At == 0 || events[1].At <= events[0].At {
		t.Fatalf("timestamps = %d, %d", events[0].At, events[1].At)
	}
}

/* The runtime's own chatter is not the conversation. */
func TestOpenClawKeepsTheRuntimeToItself(t *testing.T) {
	home := t.TempDir()
	path := openclawSession(t, home, "main", "/tmp/work")
	for _, kind := range []string{"trace.artifacts", "trace.metadata", "context.compiled", "model_change", "session.ended"} {
		write(t, path, map[string]any{
			"type": kind, "ts": "2026-09-25T12:00:02.000Z",
			"data": map[string]any{"prompt": "not a prompt", "assistantTexts": []any{"not an answer"}},
		})
	}
	reader, _ := (OpenClaw{}).Open(home, "/tmp/work", time.Now().Add(-time.Minute))
	events, _ := reader.Read()
	if len(events) != 0 {
		t.Fatalf("events = %+v", events)
	}
}

/* A session in another workspace is another session. */
func TestOpenClawFindsTheSessionForThisDirectory(t *testing.T) {
	home := t.TempDir()
	openclawSession(t, home, "other", "/tmp/elsewhere")
	wanted := openclawSession(t, home, "main", "/tmp/work")

	reader, err := (OpenClaw{}).Open(home, "/tmp/work", time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if got := reader.(*jsonlReader).path; got != wanted {
		t.Fatalf("opened %s, want %s", got, wanted)
	}
	if _, err := (OpenClaw{}).Open(home, "/tmp/nobody", time.Now().Add(-time.Minute)); err != ErrNoTranscript {
		t.Fatalf("err = %v", err)
	}
}

/* The other layout on a machine that has been used for a while. */
func TestOpenClawFindsASessionOutsideTheAgentsDirectory(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".openclaw", "crestodian", "sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "a.trajectory.jsonl")
	write(t, path, map[string]any{"type": "session", "ts": "2026-09-25T12:00:00.000Z", "cwd": "/tmp/work"})
	write(t, path, map[string]any{
		"type": "prompt.submitted", "ts": "2026-09-25T12:00:01.000Z",
		"data": map[string]any{"prompt": "hello"},
	})
	reader, err := (OpenClaw{}).Open(home, "/tmp/work", time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	events, _ := reader.Read()
	if len(events) != 1 || events[0].Text != "hello" {
		t.Fatalf("events = %+v", events)
	}
}

/*
 * The registry picks whichever harness is running, and says so. A session
 * cannot be two at once, and one that is neither is not an error worth
 * stopping for -- it is a program with no record, which is the ordinary case.
 */
func TestOpenPicksTheHarnessThatIsRunning(t *testing.T) {
	home := t.TempDir()
	openclawSession(t, home, "main", "/tmp/work")
	adapter, reader, err := Open(home, "/tmp/work", time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if adapter.Name() != "openclaw" || reader == nil {
		t.Fatalf("adapter = %v", adapter.Name())
	}

	if _, _, err := Open(home, "/tmp/nothing-here", time.Now().Add(-time.Minute)); err != ErrNoTranscript {
		t.Fatalf("err = %v, want ErrNoTranscript", err)
	}
}

func TestEveryAdapterIsNamed(t *testing.T) {
	seen := map[string]bool{}
	for _, adapter := range Adapters() {
		name := adapter.Name()
		if name == "" || seen[name] {
			t.Fatalf("adapter name %q is empty or repeated", name)
		}
		seen[name] = true
	}
	if !seen["claude-code"] || !seen["openclaw"] {
		t.Fatalf("adapters = %v", seen)
	}
}
