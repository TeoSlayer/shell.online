package agentlog

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"time"
)

// ClaudeCode reads ~/.claude/projects/<slug>/<session>.jsonl.
//
// Records are typed and timestamped, and the file is appended to as the
// conversation happens rather than when a turn ends -- sampled twice eleven
// seconds apart inside a running turn, it had grown and the newest record was
// the tool call from a moment before.
type ClaudeCode struct{}

func (ClaudeCode) Name() string { return "claude-code" }

/*
 * A question is drawn as a numbered menu and a bare digit picks from it --
 * no Return, no arrow keys. Verified against a real one: driving a session to
 * `AskUserQuestion` and writing "1" left the screen saying
 *
 *     ⏺ User answered Claude's questions:
 *       ⎿  · Which colour do you prefer? → Red
 *
 * The menu holds more entries than the record does: the harness adds its own
 * "Type something" and "Chat about this" underneath. The record's options come
 * first and in order, so option `index` is digit `index+1`, and the additions
 * sit beyond the ones anybody can press a button for.
 *
 * Past nine there are no digits left. No question this harness asks comes
 * close -- they run to four -- but a menu that did would silently select the
 * wrong thing, so it refuses instead.
 */
func (ClaudeCode) Answer(index int) []byte {
	if index < 0 || index > 8 {
		return nil
	}
	return []byte{byte('1' + index)}
}

func (c ClaudeCode) Open(home, dir string, since time.Time) (Reader, error) {
	pattern := filepath.Join(home, ".claude", "projects", "*", "*.jsonl")
	path, err := newestStartedIn(pattern, dir, since, func(path string) string {
		return headStates(path, func(line []byte) (string, bool) { return jsonField(line, "cwd") })
	})
	if err != nil {
		return nil, err
	}
	return &jsonlReader{path: path, decode: c.decode}, nil
}

func (ClaudeCode) decode(line []byte) (Event, bool) {
	var record struct {
		Type      string `json:"type"`
		Timestamp string `json:"timestamp"`
		Message   struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &record) != nil {
		return Event{}, false
	}
	var kind Kind
	switch record.Type {
	case "user":
		kind = KindUser
	case "assistant":
		kind = KindAssistant
	default:
		/* Modes, titles, permission state, attachments -- whole files -- are
		 * not the conversation and do not leave this machine. */
		return Event{}, false
	}
	text, tool, choice := claudeContent(record.Message.Content)
	if choice != nil {
		return Event{Kind: KindChoice, Text: choice.Question, At: millis(record.Timestamp), Choice: choice}, true
	}
	if tool != "" {
		kind = KindTool
		text = tool
	}
	if strings.TrimSpace(text) == "" {
		return Event{}, false
	}
	return Event{Kind: kind, Text: text, At: millis(record.Timestamp)}, true
}

// claudeQuestion is the shape of a question this harness records.
type claudeQuestion struct {
	Question string `json:"question"`
	Header   string `json:"header"`
	Options  []struct {
		Label string `json:"label"`
	} `json:"options"`
}

// claudeContent flattens a message body to its text, and names a tool if that
// is what the body is.
//
// Only text, and the *name* of a tool. A tool's input is whatever the agent
// decided to pass it -- a file, a patch, a command -- and none of that is on
// the screen a viewer would otherwise be reading.
func claudeContent(raw json.RawMessage) (text string, tool string, choice *Choice) {
	if len(raw) == 0 {
		return "", "", nil
	}
	var plain string
	if json.Unmarshal(raw, &plain) == nil {
		return plain, "", nil
	}
	var parts []struct {
		Type  string `json:"type"`
		Text  string `json:"text"`
		Name  string `json:"name"`
		Input struct {
			Questions []claudeQuestion `json:"questions"`
		} `json:"input"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return "", "", nil
	}
	var written []string
	for _, part := range parts {
		switch part.Type {
		case "text":
			if strings.TrimSpace(part.Text) != "" {
				written = append(written, part.Text)
			}
		case "tool_use":
			if asked := asking(part.Name, part.Input.Questions); asked != nil {
				return "", "", asked
			}
			if tool == "" {
				tool = part.Name
			}
		}
	}
	return strings.Join(written, "\n"), tool, nil
}

/*
 * The tools that stop and wait for a person.
 *
 * Named rather than sniffed, because this is the one case where a tool's
 * input travels, and what travels should be decided by a list somebody can
 * read rather than by the shape of an argument.
 */
var waitsForAnAnswer = map[string]bool{"AskUserQuestion": true}

func asking(name string, questions []claudeQuestion) *Choice {
	if !waitsForAnAnswer[name] || len(questions) == 0 {
		return nil
	}
	first := questions[0]
	choice := &Choice{Question: first.Question, Header: first.Header}
	for _, option := range first.Options {
		if strings.TrimSpace(option.Label) != "" {
			choice.Options = append(choice.Options, option.Label)
		}
	}
	if choice.Question == "" || len(choice.Options) == 0 {
		return nil
	}
	return choice
}
