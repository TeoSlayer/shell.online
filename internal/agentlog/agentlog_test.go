package agentlog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// write appends one record, as the agent does.
func write(t *testing.T, path string, record any) {
	t.Helper()
	line, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Write(append(line, '\n')); err != nil {
		t.Fatal(err)
	}
}

func message(role, text string) map[string]any {
	return map[string]any{
		"type":      role,
		"timestamp": "2026-09-25T12:00:00.000Z",
		"message":   map[string]any{"role": role, "content": text},
	}
}

/*
 * A transcript is append-only and is written while the turn is still running,
 * so following it is reading forward from where the last read stopped.
 */
func TestReadsOnlyWhatIsNew(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	write(t, path, message("user", "first"))
	reader := Follow(path)

	events, err := reader.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Text != "first" || events[0].Kind != KindUser {
		t.Fatalf("first read = %+v", events)
	}
	if again, _ := reader.Read(); len(again) != 0 {
		t.Fatalf("re-read gave %+v", again)
	}

	write(t, path, message("assistant", "second"))
	events, err = reader.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Text != "second" || events[0].Kind != KindAssistant {
		t.Fatalf("second read = %+v", events)
	}
	if events[0].Seq != 2 {
		t.Fatalf("seq = %d, want 2", events[0].Seq)
	}
}

/*
 * A record half-written when this ran is a record that will be whole a moment
 * later. Half of one is not an event, and consuming it would lose the rest.
 */
func TestLeavesAHalfWrittenRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	write(t, path, message("user", "whole"))
	if err := os.WriteFile(path, append(mustRead(t, path), []byte(`{"type":"assistant","mess`)...), 0o600); err != nil {
		t.Fatal(err)
	}
	reader := Follow(path)
	events, _ := reader.Read()
	if len(events) != 1 {
		t.Fatalf("read %+v, want only the whole record", events)
	}
	/* Finished later, it arrives whole. */
	rest := []byte("age\":{\"role\":\"assistant\",\"content\":\"rest\"},\"timestamp\":\"2026-09-25T12:00:01.000Z\"}\n")
	if err := os.WriteFile(path, append(mustRead(t, path), rest...), 0o600); err != nil {
		t.Fatal(err)
	}
	events, _ = reader.Read()
	if len(events) != 1 || events[0].Text != "rest" {
		t.Fatalf("after completion = %+v", events)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

/*
 * Everything the agent keeps that is not the conversation stays on the
 * machine: modes, titles, permission state, and attachments, which are whole
 * files. None of it is on the screen a viewer would otherwise be reading.
 */
func TestKeepsEverythingThatIsNotTheConversation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	for _, record := range []map[string]any{
		{"type": "mode", "mode": "normal"},
		{"type": "permission-mode", "permissionMode": "bypassPermissions"},
		{"type": "ai-title", "title": "Something private"},
		{"type": "attachment", "content": "the whole of a file"},
		{"type": "last-prompt", "leafUuid": "x"},
	} {
		write(t, path, record)
	}
	write(t, path, message("user", "said out loud"))
	events, _ := Follow(path).Read()
	if len(events) != 1 || events[0].Text != "said out loud" {
		t.Fatalf("read %+v, want only the message", events)
	}
}

/* A tool is named, never detailed: its input is a file, a patch, a command. */
func TestNamesAToolWithoutItsInput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	write(t, path, map[string]any{
		"type":      "assistant",
		"timestamp": "2026-09-25T12:00:00.000Z",
		"message": map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "name": "Bash", "input": map[string]any{"command": "rm -rf /secret"}},
		}},
	})
	events, _ := Follow(path).Read()
	if len(events) != 1 || events[0].Kind != KindTool || events[0].Text != "Bash" {
		t.Fatalf("read %+v", events)
	}
	for _, event := range events {
		if event.Text == "rm -rf /secret" {
			t.Fatal("a tool's input left the machine")
		}
	}
}

/*
 * The directory a session ran in is stated by the transcript itself. It is not
 * derived from the directory name, which encodes the path with the separators
 * turned into dashes -- and so does a dash already in the path, and a session
 * started at `/` is a directory called `-`.
 */
func TestFindsTheSessionStartedInThisDirectory(t *testing.T) {
	home := t.TempDir()
	projects := filepath.Join(home, ".claude", "projects")
	mine := filepath.Join(projects, "-tmp-mine")
	theirs := filepath.Join(projects, "-tmp-theirs")
	for _, dir := range []string{mine, theirs} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	write(t, filepath.Join(theirs, "other.jsonl"), map[string]any{"type": "session", "cwd": "/tmp/theirs"})
	write(t, filepath.Join(mine, "wanted.jsonl"), map[string]any{"type": "session", "cwd": "/tmp/mine"})

	path, err := FindClaudeCode(home, "/tmp/mine", time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "wanted.jsonl" {
		t.Fatalf("found %s", path)
	}

	if _, err := FindClaudeCode(home, "/tmp/nobody", time.Now().Add(-time.Minute)); err != ErrNoTranscript {
		t.Fatalf("err = %v, want ErrNoTranscript", err)
	}
}

/* A session from last week in the same directory is not this session. */
func TestIgnoresATranscriptOlderThanTheSession(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "projects", "-tmp-mine")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "old.jsonl")
	write(t, path, map[string]any{"type": "session", "cwd": "/tmp/mine"})
	old := time.Now().Add(-7 * 24 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := FindClaudeCode(home, "/tmp/mine", time.Now().Add(-time.Minute)); err != ErrNoTranscript {
		t.Fatalf("err = %v, want ErrNoTranscript", err)
	}
}

/*
 * A question the agent is waiting on is the one place a tool's input has to
 * travel. Everywhere else the input is the agent's business; a question
 * nobody can see is a session that has silently stopped, which is exactly
 * what a chat must not do.
 */
func TestCarriesAQuestionAndItsOptions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	write(t, path, map[string]any{
		"type":      "assistant",
		"timestamp": "2026-09-25T12:00:00.000Z",
		"message": map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "name": "AskUserQuestion", "input": map[string]any{
				"questions": []any{map[string]any{
					"question": "Which grid should a desktop use?",
					"header":   "Terminal size",
					"options": []any{
						map[string]any{"label": "Bigger session grid", "description": "160x48"},
						map[string]any{"label": "Denser chrome", "description": "same grid"},
					},
				}},
			}},
		}},
	})
	events, _ := Follow(path).Read()
	if len(events) != 1 || events[0].Kind != KindChoice {
		t.Fatalf("read %+v", events)
	}
	choice := events[0].Choice
	if choice == nil || choice.Question != "Which grid should a desktop use?" || choice.Header != "Terminal size" {
		t.Fatalf("choice = %+v", choice)
	}
	if len(choice.Options) != 2 || choice.Options[0] != "Bigger session grid" {
		t.Fatalf("options = %v", choice.Options)
	}
	/* The descriptions are the agent's own framing and stay where they are. */
	if events[0].Text != choice.Question {
		t.Fatalf("text = %q", events[0].Text)
	}
}

/* Every other tool keeps its input, question-shaped or not. */
func TestOnlyTheAskingToolsCarryTheirInput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	write(t, path, map[string]any{
		"type":      "assistant",
		"timestamp": "2026-09-25T12:00:00.000Z",
		"message": map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "name": "Bash", "input": map[string]any{
				"questions": []any{map[string]any{
					"question": "not really a question",
					"options":  []any{map[string]any{"label": "secret"}},
				}},
			}},
		}},
	})
	events, _ := Follow(path).Read()
	if len(events) != 1 || events[0].Kind != KindTool || events[0].Choice != nil {
		t.Fatalf("read %+v", events)
	}
	if events[0].Text != "Bash" {
		t.Fatalf("text = %q", events[0].Text)
	}
}
