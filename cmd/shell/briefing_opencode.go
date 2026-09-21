package main

import (
	"context"
	"errors"
)

// errBriefingNotSafe is returned when the running-agent interface cannot
// guarantee a safe, targeted submit. The coordinator treats it as a skip.
var errBriefingNotSafe = errors.New("briefing: safe targeted submit not guaranteed")

// openCodeBriefingAdapter reserves the adapter contract, but is unsupported.
// OpenCode v1.18.30 has a status API and prompt_async, but no atomic idle-only
// submission. Its TUI plugin API does not expose the runner lock either. A
// separate check followed by a prompt can alter a conversation that became
// busy in between. Never use a second runner or a blind PTY write to bypass it.
type openCodeBriefingAdapter struct{}

func newOpenCodeBriefingAdapter() *openCodeBriefingAdapter { return &openCodeBriefingAdapter{} }

func (a *openCodeBriefingAdapter) Name() string { return "opencode" }

// Avoid scheduling a poller when this adapter cannot safely submit anything.
func (a *openCodeBriefingAdapter) supportsIdleOnlySubmit() bool { return false }

// Bind identifies only an explicitly resumed launch conversation. It is useful
// for passive content, but does not prove what the TUI is currently displaying.
func (a *openCodeBriefingAdapter) Bind(argv []string) (string, bool) {
	return openCodeContentSessionID(argv)
}

// Idle cannot provide an idle lease valid at submission. ok=false means skip.
func (a *openCodeBriefingAdapter) Idle(ctx context.Context, sessionID string) (bool, bool, error) {
	return false, false, nil
}

// Submit refuses even direct calls until an atomic runtime operation exists.
func (a *openCodeBriefingAdapter) Submit(ctx context.Context, sessionID, prompt string) (string, error) {
	return "", errBriefingNotSafe
}

// Result is not reached while Idle reports ok=false. It would read the completed
// summary back from the bound conversation's store.
func (a *openCodeBriefingAdapter) Result(ctx context.Context, sessionID, ack string) (*Briefing, error) {
	return nil, nil
}
