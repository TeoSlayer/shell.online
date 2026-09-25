package agentlog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
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

/*
 * A question is drawn as a numbered menu and a bare digit picks from it --
 * no Return, no arrow keys. Verified by driving a real session to a question
 * and writing "1", which left the screen saying the question had been
 * answered "Red", the first option.
 */
func TestAQuestionIsAnsweredWithItsDigit(t *testing.T) {
	for index, want := range map[int]string{0: "1", 1: "2", 8: "9"} {
		if got := string((ClaudeCode{}).Answer(index)); got != want {
			t.Fatalf("Answer(%d) = %q, want %q", index, got, want)
		}
	}
	/* Past nine there are no digits left, and a wrong one presses a button
	 * nobody chose. No question this harness asks runs that long. */
	for _, index := range []int{-1, 9, 40} {
		if got := (ClaudeCode{}).Answer(index); got != nil {
			t.Fatalf("Answer(%d) = %q, want nil", index, got)
		}
	}
}

/* A harness nobody has watched being answered says so rather than guessing. */
func TestAnUnknownMenuIsNotGuessedAt(t *testing.T) {
	if got := (OpenClaw{}).Answer(0); got != nil {
		t.Fatalf("Answer(0) = %q, want nil", got)
	}
}

/* Every adapter answers the interface, so a new one cannot forget a method. */
func TestEveryAdapterCanBeAsked(t *testing.T) {
	for _, adapter := range Adapters() {
		if adapter.Name() == "" {
			t.Fatal("an adapter with no name")
		}
		/* nil is a real answer; the call simply has to exist. */
		_ = adapter.Answer(0)
	}
}

/*
 * A message is not a file. The record is written by the agent running in the
 * session -- the same trust domain as the terminal's output -- but an answer
 * with a pasted file in it should not become a frame nobody budgeted for.
 */
func TestAMessageIsCappedBeforeItIsSent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	write(t, path, map[string]any{
		"type":      "assistant",
		"timestamp": "2026-09-25T12:00:00.000Z",
		"message":   map[string]any{"role": "assistant", "content": strings.Repeat("é", 400_000)},
	})
	events, _ := (&jsonlReader{path: path, decode: ClaudeCode{}.decode}).Read()
	if len(events) != 1 {
		t.Fatalf("events = %d", len(events))
	}
	if len(events[0].Text) > 32*1024 {
		t.Fatalf("text = %d bytes, want <= 32k", len(events[0].Text))
	}
	/* Cut on a rune boundary, so what arrives is still text. */
	if !utf8.ValidString(events[0].Text) {
		t.Fatal("the cut left invalid utf-8")
	}
}

/* And a menu is bounded, however long the record says it is. */
func TestAMenuIsBounded(t *testing.T) {
	options := make([]any, 0, 200)
	for i := 0; i < 200; i++ {
		options = append(options, map[string]any{"label": "option"})
	}
	path := filepath.Join(t.TempDir(), "session.jsonl")
	write(t, path, map[string]any{
		"type":      "assistant",
		"timestamp": "2026-09-25T12:00:00.000Z",
		"message": map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "name": "AskUserQuestion", "input": map[string]any{
				"questions": []any{map[string]any{"question": "pick", "options": options}},
			}},
		}},
	})
	events, _ := (&jsonlReader{path: path, decode: ClaudeCode{}.decode}).Read()
	if len(events) != 1 || events[0].Choice == nil {
		t.Fatalf("events = %+v", events)
	}
	if len(events[0].Choice.Options) > 12 {
		t.Fatalf("options = %d", len(events[0].Choice.Options))
	}
}

/*
 * A record states the directory it was started in once, at the top, and never
 * restates it -- so asking again costs a file open for an answer that cannot
 * have changed. A session that never runs an agent asks for as long as it
 * lives, against every candidate on the machine.
 *
 * What is cached is what the file said, not whether it matched: caching the
 * answer to "does this belong to /x" would answer for /y too.
 */
func TestAFileIsReadOnceUntilItChanges(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "projects", "-p")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "s.jsonl")
	write(t, path, map[string]any{"type": "session", "cwd": "/tmp/one"})

	reads := 0
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	read := func(string) string {
		reads++
		return "/tmp/one"
	}
	for i := 0; i < 5; i++ {
		if got := statedDir(path, info.ModTime(), read); got != "/tmp/one" {
			t.Fatalf("statedDir = %q", got)
		}
	}
	if reads != 1 {
		t.Fatalf("read the file %d times, want 1", reads)
	}

	/* The same file, asked about a different directory, is not re-read and
	 * still says what it said. */
	if got := statedDir(path, info.ModTime(), read); got != "/tmp/one" || reads != 1 {
		t.Fatalf("statedDir = %q after %d reads", got, reads)
	}

	/* Changed, and it is asked again. */
	later := info.ModTime().Add(time.Second)
	if got := statedDir(path, later, func(string) string { reads++; return "/tmp/two" }); got != "/tmp/two" {
		t.Fatalf("after a change statedDir = %q", got)
	}
	if reads != 2 {
		t.Fatalf("reads = %d, want 2", reads)
	}
}
