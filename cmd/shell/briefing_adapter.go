package main

import "context"

// Briefing is an agent's completed title and short summary for a conversation.
type Briefing struct {
	Title       string
	Description string
	ObservedAt  int64 // unix millis
}

// BriefingAdapter is the boundary between the host and a specific agent's
// supported interface for asking it to summarize its current conversation.
//
// Implementations are fail-closed: when a safe idle check or same-conversation
// targeting is not guaranteed, they report ok=false (or a pending result) and
// the coordinator skips. The coordinator never guesses, never injects a blind
// PTY prompt, and never starts a second local model or a new conversation.
type BriefingAdapter interface {
	// Name identifies the agent (e.g. "opencode") for the durable record.
	Name() string
	// Bind reports the conversation this launch authoritatively binds, or
	// ok=false when it does not. The coordinator only targets that conversation.
	Bind(argv []string) (sessionID string, ok bool)
	// Idle reports whether the bound conversation is authoritatively idle.
	// ok=false means the idle state could not be determined (skip, never guess).
	Idle(ctx context.Context, sessionID string) (idle bool, ok bool, err error)
	// Submit delivers the briefing prompt to the bound conversation only when it
	// is idle, and returns an acknowledgement. An ack is NOT a completed summary.
	Submit(ctx context.Context, sessionID, prompt string) (ack string, err error)
	// Result reads back the completed summary for the prompt. It returns a nil
	// Briefing (not an error) while the summary is still pending.
	Result(ctx context.Context, sessionID, ack string) (*Briefing, error)
}
