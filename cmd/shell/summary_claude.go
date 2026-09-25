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

// bindClaudeSession returns the arguments to launch and the conversation id
// they are bound to, or "" when no exact binding exists.
//
//   - claude [flags]                → adds --session-id <new uuid>
//   - claude --session-id <uuid>    → bound to that id, unchanged
//   - claude --resume <uuid>        → bound to that id, unchanged
//   - --continue, a bare --resume picker, --fork-session, subcommands,
//     --help/--version              → unchanged and unbound: the conversation
//     that will run cannot be known in advance
func bindClaudeSession(arguments []string) ([]string, string) {
	if len(arguments) == 0 || !isClaudeBinary(arguments[0]) {
		return arguments, ""
	}
	if len(arguments) > 1 && claudeSubcommands[arguments[1]] {
		return arguments, ""
	}
	sessionID, resumeID := "", ""
	fork, unbound := false, false
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
				return arguments, ""
			}
			sessionID = id
		case "--resume", "-r":
			id := nextValue()
			if !claudeSessionIDPattern.MatchString(id) {
				unbound = true
				continue
			}
			resumeID = id
		case "--continue", "-c", "-h", "--help", "-v", "--version":
			unbound = true
		case "--fork-session":
			fork = true
		}
	}
	switch {
	case unbound:
		return arguments, ""
	case sessionID != "":
		if resumeID != "" && !fork {
			return arguments, ""
		}
		return arguments, sessionID
	case fork:
		return arguments, ""
	case resumeID != "":
		return arguments, resumeID
	}
	id, err := newUUIDv4()
	if err != nil {
		return arguments, ""
	}
	bound := append([]string{arguments[0], "--session-id", id}, arguments[1:]...)
	return bound, id
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
			if json.Unmarshal(message.Content, &prompt) == nil && strings.HasPrefix(prompt, "[Request interrupted") {
				state = summary.StateIdle
				continue
			}
			var blocks []claudeBlock
			if json.Unmarshal(message.Content, &blocks) == nil && len(blocks) > 0 && blocks[0].Type == "text" &&
				strings.HasPrefix(blocks[0].Text, "[Request interrupted") {
				state = summary.StateIdle
				continue
			}
			state = summary.StateWorking
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
