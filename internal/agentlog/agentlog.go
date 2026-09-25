// Package agentlog reads an agent's own record of a conversation.
//
// A coding agent draws its conversation on the alternate screen and repaints
// it: what a viewer's terminal holds is one screenful of a projection, and
// everything above it is gone. Reading the conversation off that screen is
// reading a view of a view -- it cannot recover what has scrolled away, it
// changes when somebody scrolls, and it has to guess at turn boundaries from
// spinner glyphs.
//
// The agents this product runs do not make anyone guess. Each keeps its own
// machine-readable record on this machine, written as the conversation
// happens:
//
//	Claude Code  ~/.claude/projects/<slug>/<session>.jsonl   typed records
//	OpenClaw     ~/.openclaw/<agent>/sessions/<id>.jsonl     event log
//	Hermes       ~/.hermes/state.db                          sqlite
//
// This package finds the record belonging to the session running in a given
// directory and follows it. What it yields is the conversation itself --
// roles, text, tool calls, timestamps -- rather than a reading of a drawing
// of it.
package agentlog

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Kind is what a record says happened.
type Kind string

const (
	// KindUser is something the person sent.
	KindUser Kind = "user"
	// KindAssistant is something the agent said.
	KindAssistant Kind = "assistant"
	// KindTool is the agent using a tool, named rather than detailed.
	KindTool Kind = "tool"
	// KindChoice is the agent asking the person to choose between options.
	KindChoice Kind = "choice"
)

// Choice is a question the agent is waiting on an answer to.
//
// These are the one place a tool's input has to travel. Everywhere else the
// input is the agent's business -- a file, a patch, a command -- but a
// question nobody can see is a session that has silently stopped, which is
// exactly what a chat must not do. The options are what the terminal is
// drawing a menu of; the chat draws them as what they are.
type Choice struct {
	Question string   `json:"question"`
	Header   string   `json:"header"`
	Options  []string `json:"options"`
}

// Event is one thing that happened, in a form a conversation can be drawn from.
//
// Deliberately narrow. A transcript holds a great deal this does not carry --
// thinking, full tool inputs, whole files as attachments -- and none of that
// is on the screen the viewer would otherwise be reading. Widening this is a
// decision about what leaves the machine, not a detail.
type Event struct {
	Kind Kind   `json:"kind"`
	Text string `json:"text"`
	// At is when the agent recorded it, in epoch milliseconds.
	At int64 `json:"at"`
	// Seq orders events within a session, so a viewer can resume from one.
	Seq int `json:"seq"`
	// Choice is set when the agent is waiting for the person to pick one.
	Choice *Choice `json:"choice,omitempty"`
}

// ErrNoTranscript means nothing on this machine looks like this session.
var ErrNoTranscript = errors.New("agentlog: no transcript for this session")

/*
 * Claude Code names a project directory after the working directory with the
 * separators turned into dashes, which is easy to get wrong and pointless to
 * reimplement: `/` becomes `-`, but so does a dash already in the path, and a
 * session started at `/` is a directory called `-`.
 *
 * So the directory is not derived. Every transcript under the projects root
 * is a candidate, and the one that belongs to this session is the one whose
 * own records say it was started in this directory. The file says where it
 * came from; there is no need to guess from its name.
 */

// FindClaudeCode returns the transcript for the newest Claude Code session
// started in dir, or ErrNoTranscript.
//
// `since` bounds the search to sessions touched at or after it, which is what
// distinguishes the session this host just started from one the same person
// ran in the same directory last week.
func FindClaudeCode(home, dir string, since time.Time) (string, error) {
	root := filepath.Join(home, ".claude", "projects")
	entries, err := filepath.Glob(filepath.Join(root, "*", "*.jsonl"))
	if err != nil || len(entries) == 0 {
		return "", ErrNoTranscript
	}
	type candidate struct {
		path string
		at   time.Time
	}
	var found []candidate
	for _, path := range entries {
		info, err := os.Stat(path)
		if err != nil || info.ModTime().Before(since) {
			continue
		}
		if !startedIn(path, dir) {
			continue
		}
		found = append(found, candidate{path: path, at: info.ModTime()})
	}
	if len(found) == 0 {
		return "", ErrNoTranscript
	}
	sort.Slice(found, func(a, b int) bool { return found[a].at.After(found[b].at) })
	return found[0].path, nil
}

// startedIn reports whether a transcript's own records place it in dir.
func startedIn(path, dir string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	/* The directory is stated early; a whole file is not worth reading for it. */
	for line := 0; line < 40 && scanner.Scan(); line++ {
		var record struct {
			Cwd string `json:"cwd"`
		}
		if json.Unmarshal(scanner.Bytes(), &record) != nil || record.Cwd == "" {
			continue
		}
		return filepath.Clean(record.Cwd) == filepath.Clean(dir)
	}
	return false
}

// Reader follows one transcript, yielding events as they are written.
//
// A transcript is append-only, so following it is reading forward from where
// the last read stopped. Nothing is re-read and nothing is held: the offset
// is the whole of the state.
type Reader struct {
	path string
	at   int64
	seq  int
}

// Follow opens a transcript for reading from the beginning.
func Follow(path string) *Reader {
	return &Reader{path: path}
}

// Read returns everything written since the last call.
//
// A partial last line is not consumed: a record half-written when this ran is
// a record that will be whole a moment later, and half of one is not an event.
func (r *Reader) Read() ([]Event, error) {
	file, err := os.Open(r.path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if _, err := file.Seek(r.at, io.SeekStart); err != nil {
		return nil, err
	}
	reader := bufio.NewReaderSize(file, 128*1024)
	var events []Event
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			/* No newline yet: leave it for the next read. */
			break
		}
		r.at += int64(len(line))
		event, ok := decodeClaudeCode(line)
		if !ok {
			continue
		}
		r.seq++
		event.Seq = r.seq
		events = append(events, event)
	}
	return events, nil
}

// decodeClaudeCode turns one record into an event, or reports that it is not one.
func decodeClaudeCode(line []byte) (Event, bool) {
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
		/* State records -- mode, permission mode, titles, attachments -- are not
		 * the conversation and do not leave this machine. */
		return Event{}, false
	}
	text, tool, choice := content(record.Message.Content)
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

// content flattens a message body to its text, and names a tool if that is
// what the body is.
//
// Only text and the *name* of a tool. A tool's input is whatever the agent
// decided to pass it -- a file, a patch, a command -- and none of that is on
// the screen a viewer would otherwise be reading.
func content(raw json.RawMessage) (text string, tool string, choice *Choice) {
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
			Questions []struct {
				Question string `json:"question"`
				Header   string `json:"header"`
				Options  []struct {
					Label string `json:"label"`
				} `json:"options"`
			} `json:"questions"`
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

func asking(name string, questions []struct {
	Question string `json:"question"`
	Header   string `json:"header"`
	Options  []struct {
		Label string `json:"label"`
	} `json:"options"`
}) *Choice {
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

func millis(stamp string) int64 {
	at, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil {
		return 0
	}
	return at.UnixMilli()
}
