package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"shell.online/internal/summary"
)

// Claude Code summaries come from the conversation's own transcript, never a
// model call and never a prompt to the agent. The binding must be exact: the
// transcript read is the one for the conversation this session launched.

// claudeSubcommands are first arguments that run a Claude Code utility rather
// than a conversation. A session id is never injected into those.
var claudeSubcommands = map[string]bool{
	"mcp": true, "config": true, "update": true, "upgrade": true, "doctor": true, "install": true,
	"setup-token": true, "migrate-installer": true, "plugin": true, "plugins": true, "agents": true,
	"auth": true, "login": true, "logout": true, "remote-control": true, "api-key": true, "completion": true,
}

func isClaudeBinary(path string) bool {
	return strings.TrimSuffix(filepath.Base(path), ".exe") == "claude"
}

// claudeBinding says which Claude Code conversation a session runs.
type claudeBinding struct {
	// ID is the conversation known at launch, or "" until the hook reports one.
	ID string
	// HookFile receives Claude Code's SessionStart hook input (session id and
	// source) whenever a conversation starts, resumes, clears or compacts, so
	// the binding follows /clear and /resume. "" when no hook was installed.
	HookFile string
}

func (binding claudeBinding) bound() bool { return binding.ID != "" || binding.HookFile != "" }

// claudeHookSettings is the --settings value that makes Claude Code write its
// SessionStart hook input to path. The command is fixed; only the path, which
// the host created, is interpolated, and paths with quotes are refused.
func claudeHookSettings(path string) (string, bool) {
	if path == "" || !filepath.IsAbs(path) || strings.ContainsAny(path, "'\n\r\x00") {
		return "", false
	}
	settings := map[string]any{"hooks": map[string]any{"SessionStart": []any{
		map[string]any{"hooks": []any{map[string]any{"type": "command", "command": "cat > '" + path + "'"}}},
	}}}
	encoded, err := json.Marshal(settings)
	if err != nil {
		return "", false
	}
	return string(encoded), true
}

// bindClaudeSession returns the arguments to launch and how they are bound.
// hookFile, when set, is a private file for the SessionStart hook.
//
//   - claude [flags] ["a prompt"]  → adds the hook and --session-id <new uuid>
//   - claude --session-id <uuid>   → bound to that id, plus the hook
//   - claude --resume <uuid>       → bound to that id, plus the hook
//   - --continue, the --resume picker, --fork-session → the hook reports the
//     conversation once it starts; without a hook file these stay unbound
//   - subcommands, a bare single-word first argument (possibly a subcommand
//     this build does not know), --print, --help/--version, or the user's own
//     --settings → unchanged and unbound
func bindClaudeSession(arguments []string, hookFile string) ([]string, claudeBinding) {
	if len(arguments) == 0 || !isClaudeBinary(arguments[0]) {
		return arguments, claudeBinding{}
	}
	if len(arguments) > 1 {
		first := arguments[1]
		if claudeSubcommands[first] || (!strings.HasPrefix(first, "-") && !strings.ContainsAny(first, " \t\n")) {
			return arguments, claudeBinding{}
		}
	}
	sessionID, resumeID := "", ""
	fork, deferred, userSettings := false, false, false
	for i := 1; i < len(arguments); i++ {
		flag, value, inline := strings.Cut(arguments[i], "=")
		nextValue := func() string {
			if inline {
				return value
			}
			if i+1 < len(arguments) && !strings.HasPrefix(arguments[i+1], "-") {
				i++
				return arguments[i]
			}
			return ""
		}
		switch flag {
		case "--":
			i = len(arguments)
		case "--session-id":
			id := nextValue()
			if !claudeSessionIDPattern.MatchString(id) || sessionID != "" {
				return arguments, claudeBinding{}
			}
			sessionID = id
		case "--resume", "-r":
			id := nextValue()
			if !claudeSessionIDPattern.MatchString(id) {
				deferred = true
				continue
			}
			resumeID = id
		case "--continue", "-c":
			deferred = true
		case "--fork-session":
			fork = true
		case "--settings":
			userSettings = true
		case "-h", "--help", "-v", "--version", "-p", "--print":
			return arguments, claudeBinding{}
		}
	}
	settings, hooked := "", false
	if !userSettings {
		settings, hooked = claudeHookSettings(hookFile)
	}
	id, inject := "", false
	switch {
	case sessionID != "" && resumeID != "" && !fork:
		return arguments, claudeBinding{}
	case sessionID != "":
		id = sessionID
	case fork || deferred:
		if !hooked {
			return arguments, claudeBinding{}
		}
	case resumeID != "":
		id = resumeID
	default:
		fresh, err := newUUIDv4()
		if err != nil {
			return arguments, claudeBinding{}
		}
		id, inject = fresh, true
	}
	bound := []string{arguments[0]}
	binding := claudeBinding{ID: id}
	if hooked {
		bound = append(bound, "--settings", settings)
		binding.HookFile = hookFile
	}
	if inject {
		bound = append(bound, "--session-id", id)
	}
	return append(bound, arguments[1:]...), binding
}

// claudeHookInput is what Claude Code last reported through the SessionStart
// hook: the conversation id and, when given, the path of its transcript.
type claudeHookInput struct {
	SessionID      string `json:"session_id"`
	TranscriptPath string `json:"transcript_path"`
}

// readClaudeHook returns the conversation Claude Code last reported, with an
// empty SessionID when the file is empty, partial or invalid.
func readClaudeHook(path string) claudeHookInput {
	file, err := os.Open(path)
	if err != nil {
		return claudeHookInput{}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return claudeHookInput{}
	}
	data, err := io.ReadAll(io.LimitReader(file, 64<<10))
	if err != nil {
		return claudeHookInput{}
	}
	var input claudeHookInput
	if json.Unmarshal(data, &input) != nil || !claudeSessionIDPattern.MatchString(input.SessionID) {
		return claudeHookInput{}
	}
	return input
}

// claudeTranscriptAt accepts a transcript path reported by the hook only when
// it is exactly <config>/projects/<project>/<id>.jsonl and a regular file, so
// the hook input can never point the reader anywhere else.
func claudeTranscriptAt(configDir, id, path string) (string, bool) {
	if path == "" || !filepath.IsAbs(path) || !claudeSessionIDPattern.MatchString(id) {
		return "", false
	}
	path = filepath.Clean(path)
	projects := filepath.Join(filepath.Clean(configDir), "projects")
	if filepath.Base(path) != id+".jsonl" || filepath.Dir(filepath.Dir(path)) != projects {
		return "", false
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return path, true
}

func newUUIDv4() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

// claudeTranscriptTail bounds how much of a transcript is read per summary.
const claudeTranscriptTail = 512 << 10

// claudeConfigDir is where Claude Code keeps its projects directory.
func claudeConfigDir() (string, error) {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		if !filepath.IsAbs(dir) {
			return "", errors.New("CLAUDE_CONFIG_DIR is not absolute")
		}
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude"), nil
}

// findClaudeTranscript finds <config>/projects/*/<id>.jsonl. Exactly one
// regular file must match: anything else (none, several, a symlink) is no
// binding.
func findClaudeTranscript(configDir, id string) (string, error) {
	if !claudeSessionIDPattern.MatchString(id) {
		return "", errors.New("invalid conversation id")
	}
	matches, err := filepath.Glob(filepath.Join(configDir, "projects", "*", id+".jsonl"))
	if err != nil || len(matches) != 1 {
		return "", errors.New("transcript not found exactly once")
	}
	info, err := os.Lstat(matches[0])
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("transcript is not a regular file")
	}
	return matches[0], nil
}

type claudeEntry struct {
	Type        string          `json:"type"`
	AITitle     string          `json:"aiTitle"`
	SessionID   string          `json:"sessionId"`
	IsSidechain bool            `json:"isSidechain"`
	IsMeta      bool            `json:"isMeta"`
	Message     json.RawMessage `json:"message"`
}

type claudeMessage struct {
	Role       string          `json:"role"`
	StopReason *string         `json:"stop_reason"`
	Content    json.RawMessage `json:"content"`
}

type claudeBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// readClaudeSummary builds a summary from the transcript at path: the latest
// AI title, the latest assistant text (never thinking or tool calls), and a
// state from how the last turn ended. It returns nil when there is no
// assistant text yet: a title alone is not a summary.
func readClaudeSummary(path, id string, now time.Time) (*summary.Summary, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("transcript is not a regular file")
	}
	offset := info.Size() - claudeTranscriptTail
	if offset < 0 {
		offset = 0
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(file, claudeTranscriptTail))
	if err != nil {
		return nil, err
	}
	if offset > 0 {
		// Drop the partial first line.
		if newline := bytes.IndexByte(data, '\n'); newline >= 0 {
			data = data[newline+1:]
		} else {
			return nil, nil
		}
	}

	title, text, state := "", "", ""
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 64<<10), claudeTranscriptTail)
	for scanner.Scan() {
		var entry claudeEntry
		if json.Unmarshal(scanner.Bytes(), &entry) != nil || entry.IsSidechain {
			continue
		}
		switch entry.Type {
		case "ai-title":
			if entry.SessionID == "" || strings.EqualFold(entry.SessionID, id) {
				title = entry.AITitle
			}
		case "assistant":
			var message claudeMessage
			if json.Unmarshal(entry.Message, &message) != nil {
				continue
			}
			var blocks []claudeBlock
			if json.Unmarshal(message.Content, &blocks) == nil {
				parts := []string{}
				for _, block := range blocks {
					if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
						parts = append(parts, block.Text)
					}
				}
				if len(parts) > 0 {
					text = strings.Join(parts, "\n")
				}
			}
			if message.StopReason != nil && *message.StopReason == "end_turn" {
				state = summary.StateWaitingForInput
			} else {
				state = summary.StateWorking
			}
		case "user":
			if entry.IsMeta {
				continue
			}
			var message claudeMessage
			if json.Unmarshal(entry.Message, &message) != nil {
				continue
			}
			var prompt string
			if json.Unmarshal(message.Content, &prompt) != nil {
				var blocks []claudeBlock
				if json.Unmarshal(message.Content, &blocks) == nil && len(blocks) > 0 && blocks[0].Type == "text" {
					prompt = blocks[0].Text
				}
			}
			switch {
			case strings.HasPrefix(prompt, "[Request interrupted"):
				state = summary.StateIdle
			case isLocalCommandRecord(prompt):
				// A local slash command (/cost, /model, ...) never starts a
				// model turn, so it leaves the turn state as it was.
			default:
				state = summary.StateWorking
			}
		}
	}
	text = summary.CleanText(text, summary.MaxSummaryRunes, true)
	if text == "" {
		return nil, nil
	}
	title = summary.CleanText(title, summary.MaxTitleRunes, false)
	if title == "" {
		title = "Claude Code"
	}
	if state == "" {
		state = summary.StateUnknown
	}
	return &summary.Summary{
		Version: 1, Title: title, Summary: text, State: state,
		Source: summary.SourceClaudeCode, ObservedAt: now.UnixMilli(),
	}, nil
}

// isLocalCommandRecord reports transcript user entries that record a local
// slash command or its output rather than a prompt to the model.
func isLocalCommandRecord(text string) bool {
	text = strings.TrimSpace(text)
	for _, prefix := range []string{"<command-name>", "<command-message>", "<command-args>",
		"<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>"} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return false
}
