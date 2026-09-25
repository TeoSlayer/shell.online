package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"shell.online/internal/summary"
)

const testConversation = "0f8fad5b-d9cb-469f-a165-70867728950e"

func TestBindClaudeSession(t *testing.T) {
	bound, id := bindClaudeSession([]string{"claude", "--model", "opus"})
	if !claudeSessionIDPattern.MatchString(id) || id[14] != '4' {
		t.Fatalf("fresh launch not bound to a v4 uuid: %q", id)
	}
	if want := []string{"claude", "--session-id", id, "--model", "opus"}; !reflect.DeepEqual(bound, want) {
		t.Fatalf("bound = %q, want %q", bound, want)
	}
	if _, other := bindClaudeSession([]string{"claude"}); other == id {
		t.Fatal("ids are not fresh")
	}
	if bound, id := bindClaudeSession([]string{"/usr/local/bin/claude.exe"}); id == "" || bound[1] != "--session-id" {
		t.Fatal("full path and .exe not recognised")
	}

	unchanged := map[string]string{
		"--session-id " + testConversation:                 testConversation,
		"--session-id=" + testConversation:                 testConversation,
		"--resume " + testConversation:                     testConversation,
		"-r " + testConversation + " --model opus":         testConversation,
		"--resume " + testConversation + " --fork-session": "",
		"--continue":                "",
		"-c":                        "",
		"--resume":                  "",
		"--resume --model opus":     "",
		"--resume my-named-session": "",
		"mcp list":                  "",
		"doctor":                    "",
		"--help":                    "",
		"--version":                 "",
		"--session-id not-a-uuid":   "",
		"--session-id " + testConversation + " --session-id " + testConversation:                 "",
		"--resume " + testConversation + " --session-id " + testConversation + " --fork-session": testConversation,
	}
	for arguments, wantID := range unchanged {
		argv := append([]string{"claude"}, strings.Fields(arguments)...)
		bound, id := bindClaudeSession(argv)
		if !reflect.DeepEqual(bound, argv) || id != wantID {
			t.Errorf("claude %s: bound %q id %q, want unchanged and %q", arguments, bound, id, wantID)
		}
	}
	for _, argv := range [][]string{{"opencode"}, {"/bin/sh", "-c", "claude"}, {}} {
		if bound, id := bindClaudeSession(argv); id != "" || !reflect.DeepEqual(bound, argv) {
			t.Errorf("%q was rewritten", argv)
		}
	}
}

func writeTranscript(t *testing.T, dir, id string, entries ...map[string]any) string {
	t.Helper()
	project := filepath.Join(dir, "projects", "-Users-someone-app")
	if err := os.MkdirAll(project, 0o700); err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, entry := range entries {
		encoded, _ := json.Marshal(entry)
		lines = append(lines, string(encoded))
	}
	path := filepath.Join(project, id+".jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func assistant(stop string, blocks ...map[string]any) map[string]any {
	message := map[string]any{"role": "assistant", "content": blocks}
	if stop != "" {
		message["stop_reason"] = stop
	}
	return map[string]any{"type": "assistant", "isSidechain": false, "message": message}
}

func text(value string) map[string]any { return map[string]any{"type": "text", "text": value} }

func TestReadClaudeSummary(t *testing.T) {
	dir := t.TempDir()
	now := time.UnixMilli(1800000000000)
	path := writeTranscript(t, dir, testConversation,
		map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "fix the login bug"}},
		map[string]any{"type": "ai-title", "aiTitle": "Old title", "sessionId": testConversation},
		assistant("tool_use", map[string]any{"type": "thinking", "thinking": "SECRET REASONING"}),
		assistant("tool_use", map[string]any{"type": "tool_use", "name": "Bash", "input": map[string]any{"command": "rm -rf /"}}),
		map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "content": "TOOL OUTPUT"}}}},
		assistant("tool_use", text("Checking the session handler.")),
		map[string]any{"type": "ai-title", "aiTitle": "Fix **login** bug", "sessionId": testConversation},
		assistant("end_turn", text("## Fixed\nThe login bug is fixed; see [PR](https://github.com/o/r/pull/9). Run `npm test`.")),
		assistant("end_turn", map[string]any{"type": "text", "text": "sidechain"}),
	)
	// Mark the last entry as a subagent sidechain; it must be ignored.
	raw, _ := os.ReadFile(path)
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	lines[len(lines)-1] = strings.Replace(lines[len(lines)-1], `"isSidechain":false`, `"isSidechain":true`, 1)
	_ = os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600)

	found, err := findClaudeTranscript(dir, testConversation)
	if err != nil || found != path {
		t.Fatalf("find: %v %q", err, found)
	}
	value, err := readClaudeSummary(found, testConversation, now)
	if err != nil || value == nil {
		t.Fatalf("read: %v", err)
	}
	if value.Title != "Fix **login** bug" || value.State != summary.StateWaitingForInput || value.Source != summary.SourceClaudeCode || value.ObservedAt != now.UnixMilli() {
		t.Fatalf("unexpected %+v", value)
	}
	if value.Summary != "Fixed\nThe login bug is fixed; see PR. Run npm test." {
		t.Fatalf("summary %q", value.Summary)
	}
	for _, leaked := range []string{"SECRET", "TOOL OUTPUT", "rm -rf", "github", "sidechain"} {
		if strings.Contains(value.Summary+value.Title, leaked) {
			t.Fatalf("%q leaked into the summary", leaked)
		}
	}
	if err := summary.ValidateSummary("s", "o", "g", *value); err != nil {
		t.Fatalf("summary fails validation: %v", err)
	}
}

func TestReadClaudeSummaryStates(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	cases := map[string][]map[string]any{
		summary.StateWorking: {assistant("end_turn", text("Done.")), {"type": "user", "message": map[string]any{"role": "user", "content": "next task"}}},
		summary.StateIdle:    {assistant("tool_use", text("Starting.")), {"type": "user", "message": map[string]any{"role": "user", "content": "[Request interrupted by user]"}}},
	}
	for want, entries := range cases {
		dir := t.TempDir()
		path := writeTranscript(t, dir, testConversation, entries...)
		value, err := readClaudeSummary(path, testConversation, now)
		if err != nil || value == nil || value.State != want || value.Title != "Claude Code" {
			t.Errorf("%s: got %+v %v", want, value, err)
		}
	}
	dir := t.TempDir()
	path := writeTranscript(t, dir, testConversation, map[string]any{"type": "ai-title", "aiTitle": "Only a title"})
	if value, _ := readClaudeSummary(path, testConversation, now); value != nil {
		t.Error("a title alone was published")
	}
}

func TestFindClaudeTranscriptRequiresOneRegularFile(t *testing.T) {
	dir := t.TempDir()
	if _, err := findClaudeTranscript(dir, testConversation); err == nil {
		t.Error("missing transcript found")
	}
	if _, err := findClaudeTranscript(dir, "../../etc/passwd"); err == nil {
		t.Error("non-uuid accepted")
	}
	path := writeTranscript(t, dir, testConversation, assistant("end_turn", text("x")))
	second := filepath.Join(dir, "projects", "other")
	_ = os.MkdirAll(second, 0o700)
	if err := os.Symlink(path, filepath.Join(second, testConversation+".jsonl")); err != nil {
		t.Skip("symlinks unavailable")
	}
	if _, err := findClaudeTranscript(dir, testConversation); err == nil {
		t.Error("ambiguous transcript accepted")
	}
	_ = os.Remove(path)
	if _, err := findClaudeTranscript(dir, testConversation); err == nil {
		t.Error("symlinked transcript accepted")
	}
}

func TestReadClaudeSummaryBoundsLargeTranscripts(t *testing.T) {
	dir := t.TempDir()
	filler := assistant("tool_use", text(strings.Repeat("x", 1000)))
	entries := make([]map[string]any, 0, 700)
	for i := 0; i < 700; i++ {
		entries = append(entries, filler)
	}
	entries = append(entries, assistant("end_turn", text("Final answer.")))
	path := writeTranscript(t, dir, testConversation, entries...)
	value, err := readClaudeSummary(path, testConversation, time.Now())
	if err != nil || value == nil || value.Summary != "Final answer." {
		t.Fatalf("large transcript: %+v %v", value, err)
	}
}
