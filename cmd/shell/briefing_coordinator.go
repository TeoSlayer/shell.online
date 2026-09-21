package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"shell.online/internal/account"
)

// briefingRollingWindow is the at-most-once-per-window gate. It is a rolling
// 24-hour span anchored on the last dispatch (LastPromptAt), NOT a UTC calendar
// day: a prompt at 23:59 and one at 00:01 two minutes later must not both fire.
const briefingRollingWindow = 24 * time.Hour

// Durable per-session attempt states. They survive a crash/retry so the agent
// is prompted at most once per rolling window, and an uncertain dispatch is
// never auto-resubmitted.
const (
	briefingUncertain = "uncertain" // claim persisted; dispatch may or may not have happened
	briefingPending   = "pending"   // dispatch acked; summary not read back yet
	briefingCompleted = "completed" // summary read back and published
	briefingStale     = "stale"     // gave up (window elapsed, or identity/generation changed)
)

// briefingState is the durable attempt record for one session/run. It is bound
// to the conversation and consent generation captured at dispatch, so a
// read-back is only honoured if the identity still matches.
type briefingState struct {
	Agent        string   `json:"agent"`
	State        string   `json:"state"`
	Ack          string   `json:"ack,omitempty"`
	Conversation string   `json:"conversation,omitempty"`
	Generation   string   `json:"generation,omitempty"`
	PromptHash   [32]byte `json:"promptHash"`
	LastPromptAt int64    `json:"lastPromptAt"` // unix millis of the claim/dispatch
	StaleAt      int64    `json:"staleAt,omitempty"`
	UpdatedAt    int64    `json:"updatedAt"`
}

// BriefingCoordinator asks the adapter for a daily briefing at most once per
// rolling window, gated on daily-briefing consent and an authoritative idle
// check. It reuses the existing owner-encrypted publication path and never
// guesses: a missing safe idle, same-conversation targeting, or a durability
// failure is a skip.
type BriefingCoordinator struct {
	adapter   BriefingAdapter
	client    *account.Client
	sessionID string // the shell.online share session id (stable; for state + publish)
	statePath string
	prompt    string
	now       func() time.Time
}

func (c *BriefingCoordinator) window() time.Duration { return briefingRollingWindow }

// withinWindow reports whether now is still inside the rolling window anchored
// on lastPromptAt. A zero lastPromptAt means no prompt has been dispatched.
func (c *BriefingCoordinator) withinWindow(now time.Time, lastPromptAt int64) bool {
	return lastPromptAt > 0 && now.Sub(time.UnixMilli(lastPromptAt)) < c.window()
}

func (c *BriefingCoordinator) consentOK(policy account.SessionContentPolicy, credentials account.Credentials) bool {
	return policy.Enabled && policy.Generation != "" && credentials.UID != "" &&
		policy.OwnerUID == credentials.UID
}

// Tick runs one bounded briefing pass. The caller holds the link lock and passes
// the current bearer/credentials (they change on refresh).
func (c *BriefingCoordinator) Tick(ctx context.Context, argv []string, accessToken string, credentials account.Credentials) {
	if ctx.Err() != nil {
		return
	}
	now := c.now()

	// Fail closed on a corrupt or unreadable state file: never prompt on a guess.
	state, err := loadBriefingState(c.statePath)
	if err != nil {
		return
	}
	if state == nil {
		state = &briefingState{}
	}

	// An in-flight attempt (uncertain/pending) only reads the result back; it
	// never re-submits the prompt.
	if state.State == briefingUncertain || state.State == briefingPending {
		c.readBackAndPublish(ctx, argv, accessToken, credentials, state, now)
		return
	}

	// A completed/stale attempt (or a fresh state) may dispatch only once the
	// rolling window anchored on the last dispatch has elapsed.
	if c.withinWindow(now, state.LastPromptAt) {
		return
	}

	bounded, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()

	// Daily-briefing consent (the owner-encrypted content policy). A new
	// external-provider consent is NOT inferred from this.
	policy, err := c.client.SessionContentPolicy(bounded, accessToken, c.sessionID)
	if err != nil || !c.consentOK(policy, credentials) || policy.NextPublishAt > now.UnixMilli() {
		return
	}
	generation := policy.Generation

	// Same-conversation targeting: only the authoritatively bound conversation.
	sessionID, ok := c.adapter.Bind(argv)
	if !ok || sessionID == "" {
		return
	}

	// Authoritative idle check. ok=false or busy is a skip, never a guess.
	idle, ok, err := c.adapter.Idle(bounded, sessionID)
	if err != nil || !ok || !idle {
		return
	}

	// Recheck consent IMMEDIATELY before dispatch: the Idle check above may be
	// slow, and consent must not go stale between the check and the side effect.
	policy, err = c.client.SessionContentPolicy(bounded, accessToken, c.sessionID)
	if err != nil || !c.consentOK(policy, credentials) || policy.Generation != generation ||
		policy.NextPublishAt > c.now().UnixMilli() || bounded.Err() != nil {
		return
	}
	if current, ok := c.adapter.Bind(argv); !ok || current != sessionID {
		return
	}

	// Persist a durable CLAIM before dispatch so a crash or error after the
	// side effect cannot replay the input. The claim is "uncertain" until the
	// ack confirms the dispatch.
	claim := &briefingState{
		Agent: c.adapter.Name(), State: briefingUncertain,
		Conversation: sessionID, Generation: policy.Generation,
		PromptHash:   sha256.Sum256([]byte(c.prompt)),
		LastPromptAt: now.UnixMilli(), UpdatedAt: now.UnixMilli(),
	}
	if err := saveBriefingState(c.statePath, claim); err != nil {
		return // durability failed: fail closed, do not dispatch
	}
	if bounded.Err() != nil {
		return
	}
	if current, ok := c.adapter.Bind(argv); !ok || current != sessionID {
		return
	}

	// Dispatch. On ack success, promote to "pending" (with the ack); on error,
	// leave "uncertain" (we cannot know whether the dispatch happened).
	ack, err := c.adapter.Submit(bounded, sessionID, c.prompt)
	if err != nil || ack == "" {
		return
	}
	claim.Ack = ack
	claim.State = briefingPending
	claim.UpdatedAt = c.now().UnixMilli()
	if err := saveBriefingState(c.statePath, claim); err != nil {
		return
	}

	c.readBackAndPublish(bounded, argv, accessToken, credentials, claim, c.now())
}

// readBackAndPublish reads the completed summary for a dispatched prompt and
// publishes it. It re-verifies the stored conversation identity and consent
// generation before honouring the result, and never re-submits.
func (c *BriefingCoordinator) readBackAndPublish(ctx context.Context, argv []string, accessToken string, credentials account.Credentials, state *briefingState, now time.Time) {
	if ctx.Err() != nil {
		return
	}
	if !c.withinWindow(now, state.LastPromptAt) || state.Agent != c.adapter.Name() {
		c.markStale(state, now)
		return
	}
	// Without a dispatch receipt there is no response identity to read back.
	// Never turn an uncertain submission into an unrelated completed response.
	if state.Ack == "" {
		return
	}
	bounded, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()

	// Identity check: the re-bound conversation must still be the one we
	// dispatched to. A switched conversation means this attempt is void.
	sessionID, ok := c.adapter.Bind(argv)
	if !ok {
		return
	}
	if sessionID != state.Conversation {
		c.markStale(state, now)
		return
	}

	// Generation check: the live consent generation must match the one captured
	// at dispatch. A rotated/revoked consent voids the attempt.
	policy, err := c.client.SessionContentPolicy(bounded, accessToken, c.sessionID)
	if err != nil {
		return
	}
	if !c.consentOK(policy, credentials) || policy.Generation != state.Generation {
		c.markStale(state, now)
		return
	}

	briefing, err := c.adapter.Result(bounded, sessionID, state.Ack)
	if err != nil || briefing == nil || briefing.ObservedAt < state.LastPromptAt ||
		briefing.ObservedAt > c.now().Add(time.Minute).UnixMilli() {
		// Still pending. The next pass expires it before calling the adapter.
		return
	}
	if bounded.Err() != nil {
		return
	}
	if current, ok := c.adapter.Bind(argv); !ok || current != state.Conversation {
		return
	}

	// A publish failure (e.g. the shared daily slot was already consumed by the
	// existing excerpt publisher) leaves the attempt pending so it can retry on
	// a later tick; it is not marked completed.
	if !c.publish(bounded, accessToken, credentials, state.Generation, briefing) {
		return
	}
	state.State = briefingCompleted
	state.UpdatedAt = now.UnixMilli()
	_ = saveBriefingState(c.statePath, state)
}

// markStale records that we gave up on this attempt (identity/generation
// changed, or the window elapsed without a completed summary). It is terminal:
// a new prompt is only allowed once the rolling window has elapsed.
func (c *BriefingCoordinator) markStale(state *briefingState, now time.Time) {
	if state.State == briefingStale || state.State == briefingCompleted {
		return
	}
	state.State = briefingStale
	state.StaleAt = now.UnixMilli()
	state.UpdatedAt = now.UnixMilli()
	_ = saveBriefingState(c.statePath, state)
}

// publish reuses the existing owner-encrypted publication path (the daily slot,
// the trusted vault key, and the sealed envelope are all preserved). NOTE: this
// shares policy.NextPublishAt with the existing excerpt publisher; whichever
// publishes first consumes the slot, so a briefing can be deferred to a later
// tick/day rather than silently dropped.
func (c *BriefingCoordinator) publish(ctx context.Context, accessToken string, credentials account.Credentials, generation string, briefing *Briefing) bool {
	if briefing.Description == "" {
		return false
	}
	bounded, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	policy, err := c.client.SessionContentPolicy(bounded, accessToken, c.sessionID)
	if err != nil || !c.consentOK(policy, credentials) || policy.Generation != generation {
		return false
	}
	if policy.NextPublishAt > c.now().UnixMilli() {
		return false
	}
	key, ok, err := c.client.AccountKey(bounded, accessToken)
	if err != nil || !ok || key == "" || key != credentials.AccountKey {
		return false
	}
	// "generic" is the only non-launch source the sealed-content validator
	// accepts today; a dedicated briefing source would be a backend schema change.
	content := account.SessionContent{
		Version: 1, SuggestedTitle: briefing.Title, Description: briefing.Description,
		Source: "generic", ObservedAt: briefing.ObservedAt,
	}
	sender, sealed, err := account.SealSessionContent(key, c.sessionID, policy.OwnerUID, policy.Generation, content)
	if err != nil || bounded.Err() != nil {
		return false
	}
	return c.client.PublishSessionContent(bounded, accessToken, c.sessionID, account.SessionContentUpload{
		Generation: policy.Generation, ObservedAt: briefing.ObservedAt, SenderPublicKey: sender, Sealed: sealed,
	}) == nil
}

// briefingStatePath returns the durable state file for a session.
func briefingStatePath(sessionID string) string {
	if sessionID == "" || filepath.Base(sessionID) != sessionID || sessionID == "." || sessionID == ".." {
		return ""
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".local", "share")
	}
	if !filepath.IsAbs(base) {
		return ""
	}
	return filepath.Join(base, "shell-online", "briefing-"+sessionID+".json")
}

func loadBriefingState(path string) (*briefingState, error) {
	if path == "" {
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 16*1024+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 16*1024 {
		return nil, errors.New("briefing state exceeds its size limit")
	}
	var state briefingState
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, err
	}
	if state.Agent == "" || state.Conversation == "" || state.Generation == "" ||
		state.LastPromptAt <= 0 || state.UpdatedAt < state.LastPromptAt {
		return nil, errors.New("invalid briefing state binding")
	}
	switch state.State {
	case briefingUncertain, briefingStale:
	case briefingPending, briefingCompleted:
		if state.Ack == "" {
			return nil, errors.New("missing briefing dispatch receipt")
		}
	default:
		return nil, errors.New("invalid briefing state")
	}
	return &state, nil
}

func saveBriefingState(path string, state *briefingState) error {
	if path == "" {
		return errors.New("no state path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".briefing-*.json")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	defer temporary.Close()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if err := json.NewEncoder(temporary).Encode(state); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := securePrivateStateFile(temporaryPath); err != nil {
		return err
	}
	if err := replaceFileAtomically(temporaryPath, path); err != nil {
		return err
	}
	return securePrivateStateFile(path)
}
