// Package agentlog reads an agent's own record of a conversation.
//
// A coding agent draws its conversation on the alternate screen and repaints
// it: what a viewer's terminal holds is one screenful of a projection, and
// everything above it is gone. Reading the conversation off that is reading a
// view of a view -- it cannot recover what has scrolled away, it changes when
// somebody scrolls, and it has to infer whether the agent is working from a
// spinner glyph.
//
// The agents this product runs do not make anyone guess. Each keeps its own
// machine-readable record, written as the conversation happens, and this
// package reads that instead. One adapter per harness; the rest of the
// product sees only Event.
package agentlog

import (
	"errors"
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
// Deliberately narrow, and the same shape whichever harness it came from. A
// record holds a great deal this does not carry -- thinking, full tool inputs,
// whole files as attachments -- and none of that is on the screen the viewer
// would otherwise be reading. Widening this is a decision about what leaves
// the machine, not a detail.
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
var ErrNoTranscript = errors.New("agentlog: no record for this session")

// Reader follows one session's record, yielding events as they are written.
//
// Read returns everything written since the last call and nothing twice. A
// record still being written is left alone: half of one is not an event, and
// consuming it would lose the rest.
type Reader interface {
	Read() ([]Event, error)
}

// Adapter knows where one harness keeps its records and how to read them.
//
// Adding a harness is writing one of these. Nothing else in the product
// changes, because everything downstream sees Event and not a format.
type Adapter interface {
	// Name identifies the harness in logs and in the conversation.
	Name() string
	// Open returns a reader for the session running in dir, or
	// ErrNoTranscript. `since` bounds the search, which is what tells this
	// session apart from one the same person ran in the same directory last
	// week.
	Open(home, dir string, since time.Time) (Reader, error)
}

/*
 * Order matters only in that the first to recognise a session wins, and a
 * session cannot be two harnesses at once. Hermes is absent deliberately: it
 * keeps its record in SQLite, which Go cannot read without a driver, and this
 * binary is cross-built for mips, arm and power and shipped through Homebrew.
 * That is a dependency decision rather than an adapter.
 */
var adapters = []Adapter{ClaudeCode{}, OpenClaw{}}

// Adapters lists the harnesses this build can read.
func Adapters() []Adapter { return adapters }

// Open finds whichever harness is running in dir and follows its record.
func Open(home, dir string, since time.Time) (Adapter, Reader, error) {
	for _, adapter := range adapters {
		reader, err := adapter.Open(home, dir, since)
		if err == nil {
			return adapter, reader, nil
		}
		if !errors.Is(err, ErrNoTranscript) {
			return nil, nil, err
		}
	}
	return nil, nil, ErrNoTranscript
}

func millis(stamp string) int64 {
	at, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil {
		return 0
	}
	return at.UnixMilli()
}
