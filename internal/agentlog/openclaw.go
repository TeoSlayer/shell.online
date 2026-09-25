package agentlog

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"time"
)

// OpenClaw reads ~/.openclaw/**/sessions/*.trajectory.jsonl.
//
// A trajectory is an event log rather than a message list: the conversation is
// in two of its record types, and the rest is the runtime talking to itself.
// A prompt carries the person's text; a completion carries everything the
// agent said during that run, which is why one completion can be several
// messages.
type OpenClaw struct{}

func (OpenClaw) Name() string { return "openclaw" }

/*
 * Not yet. The records say what was asked, but nothing here has been driven to
 * one of this harness's menus to see how it expects to be answered, and a
 * guess would press a button nobody chose. Until that is watched happening,
 * the chat lets somebody type their reply.
 */
func (OpenClaw) Answer(int) []byte { return nil }

func (o OpenClaw) Open(home, dir string, since time.Time) (Reader, error) {
	/*
	 * Sessions live under an agent's own directory, and there is more than one
	 * shape of that in the wild: `<home>/.openclaw/agents/<name>/sessions` and
	 * `<home>/.openclaw/<name>/sessions` both exist on a machine that has been
	 * used for a while. Both are looked at.
	 */
	for _, pattern := range []string{
		filepath.Join(home, ".openclaw", "agents", "*", "sessions", "*.trajectory.jsonl"),
		filepath.Join(home, ".openclaw", "*", "sessions", "*.trajectory.jsonl"),
	} {
		path, err := newestStartedIn(pattern, dir, since, func(path, dir string) bool {
			return headStates(path, dir, func(line []byte) (string, bool) {
				if stated, ok := jsonField(line, "workspaceDir"); ok {
					return stated, true
				}
				return jsonField(line, "cwd")
			})
		})
		if err == nil {
			return &jsonlReader{path: path, decode: o.decode}, nil
		}
	}
	return nil, ErrNoTranscript
}

func (OpenClaw) decode(line []byte) (Event, bool) {
	var record struct {
		Type string `json:"type"`
		Ts   string `json:"ts"`
		Data struct {
			Prompt string `json:"prompt"`
			/* Everything the agent said in this run, in order. */
			AssistantTexts []string `json:"assistantTexts"`
		} `json:"data"`
	}
	if json.Unmarshal(line, &record) != nil {
		return Event{}, false
	}
	switch record.Type {
	case "prompt.submitted":
		if strings.TrimSpace(record.Data.Prompt) == "" {
			return Event{}, false
		}
		return Event{Kind: KindUser, Text: record.Data.Prompt, At: millis(record.Ts)}, true
	case "model.completed":
		/*
		 * One record, everything said. Joined rather than split: the record
		 * does not say where one message ended and the next began, and
		 * inventing boundaries here is the guessing this package exists to
		 * stop.
		 */
		var written []string
		for _, text := range record.Data.AssistantTexts {
			if strings.TrimSpace(text) != "" {
				written = append(written, text)
			}
		}
		if len(written) == 0 {
			return Event{}, false
		}
		return Event{Kind: KindAssistant, Text: strings.Join(written, "\n\n"), At: millis(record.Ts)}, true
	default:
		/* Context, artifacts, metadata, model changes: the runtime's business. */
		return Event{}, false
	}
}
