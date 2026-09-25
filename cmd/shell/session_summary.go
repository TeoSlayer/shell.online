package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	"time"

	"shell.online/internal/account"
	"shell.online/internal/summary"
)

// Session summaries (opt-in per session, "summariesEnabled").
//
// Claude Code sessions are summarised from their own transcript on this
// machine and sealed here; no model runs. Every other process is summarised by
// the attested summarizer enclave: the host sends it the sanitised,
// redacted tail of recent output, sealed to a key the enclave proved it holds,
// and the enclave seals the summary to the owner's vault key. Either way the
// account service stores only an ss1. envelope it cannot open.
//
// This path never writes to the PTY, never logs content, and on any error does
// nothing until the next tick.

const (
	summaryEndpointEnvironment = "SHELL_ONLINE_SUMMARIZER_URL"

	summaryFirstTick    = 10 * time.Second
	summaryTick         = 15 * time.Second
	summaryPolicyMaxAge = time.Minute
	// summaryQuiet is how long output must pause before it is summarised.
	summaryQuiet = 20 * time.Second
	// summaryFlowing summarises output that never pauses, at most this often.
	summaryFlowing = 5 * time.Minute
	// summaryRequestTimeout bounds one enclave round trip (a CPU model).
	summaryRequestTimeout = 60 * time.Second
)

type summaryRunner struct {
	link     *sessionLink
	label    string
	claudeID string
	output   *summaryOutput
	now      func() time.Time

	// newClient builds the enclave client on first use; tests replace it.
	newClient func() (summarizerClient, error)
	client    summarizerClient
	// claudeDir resolves the Claude Code configuration directory.
	claudeDir func() (string, error)

	policy        account.SessionSummaryPolicy
	policyAt      time.Time
	lastPublished time.Time
	lastTotal     uint64
	generation    string
	fingerprint   [32]byte
}

type summarizerClient interface {
	Summarize(context.Context, summary.Request) (summary.Result, error)
}

func defaultSummarizerClient() (summarizerClient, error) {
	endpoint := os.Getenv(summaryEndpointEnvironment)
	if endpoint == "" {
		endpoint = summary.DefaultEndpoint
	}
	return summary.NewClient(endpoint, summary.NewVerifier(summary.DefaultAudience), nil)
}

// StartSummaries runs the summary loop until ctx ends. label is the command as
// published; claudeID is the exact Claude Code conversation this session runs,
// or "" for any other process.
func (link *sessionLink) StartSummaries(ctx context.Context, label, claudeID string, output *summaryOutput) {
	if link == nil {
		return
	}
	runner := &summaryRunner{
		link: link, label: label, claudeID: claudeID, output: output, now: time.Now,
		newClient: defaultSummarizerClient, claudeDir: claudeConfigDir,
	}
	go runner.run(ctx)
}

func (runner *summaryRunner) run(ctx context.Context) {
	timer := time.NewTimer(summaryFirstTick)
	defer timer.Stop()
	defer runner.output.setEnabled(false)
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		runner.tick(ctx)
		timer.Reset(summaryTick)
	}
}

// identity reads what the runner needs from the link under its lock.
func (link *sessionLink) summaryIdentity() (uid, pinnedKey string, closed bool) {
	link.mu.Lock()
	defer link.mu.Unlock()
	return link.credentials.UID, link.credentials.AccountKey, link.contentClosed
}

func (runner *summaryRunner) tick(ctx context.Context) {
	link := runner.link
	token, sessionID := link.reportCredential(ctx, false)
	if token == "" || sessionID == "" {
		return
	}
	uid, pinnedKey, closed := link.summaryIdentity()
	if closed || uid == "" || pinnedKey == "" {
		return
	}
	now := runner.now()
	if now.Sub(runner.policyAt) >= summaryPolicyMaxAge {
		bounded, cancel := context.WithTimeout(ctx, linkTimeout)
		policy, err := link.client.SessionSummaryPolicy(bounded, token, sessionID)
		cancel()
		if err != nil {
			return
		}
		runner.policy, runner.policyAt = policy, now
	}
	policy := runner.policy
	enabled := policy.Enabled && policy.Generation != "" && policy.OwnerUID == uid
	// Only generic sessions need the output copy.
	runner.output.setEnabled(enabled && runner.claudeID == "")
	if !enabled {
		return
	}
	if policy.Generation != runner.generation {
		runner.generation, runner.fingerprint = policy.Generation, [32]byte{}
	}
	if policy.NextPublishAt > now.UnixMilli() {
		return
	}
	if runner.claudeID != "" {
		runner.publishClaude(ctx, token, sessionID, uid, pinnedKey, now)
		return
	}
	runner.publishEnclave(ctx, token, sessionID, uid, pinnedKey, now)
}

// vaultKey confirms the account's vault key is still the one pinned at
// registration, as the excerpt publisher does. A changed key is never used.
func (runner *summaryRunner) vaultKey(ctx context.Context, token, pinnedKey string) (string, bool) {
	bounded, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	key, ok, err := runner.link.client.AccountKey(bounded, token)
	if err != nil || !ok || key == "" || key != pinnedKey {
		return "", false
	}
	return key, true
}

func (runner *summaryRunner) publishClaude(ctx context.Context, token, sessionID, uid, pinnedKey string, now time.Time) {
	dir, err := runner.claudeDir()
	if err != nil {
		return
	}
	path, err := findClaudeTranscript(dir, runner.claudeID)
	if err != nil {
		return
	}
	value, err := readClaudeSummary(path, runner.claudeID, now)
	if err != nil || value == nil {
		return
	}
	// The fingerprint ignores the observation time: an unchanged turn is not republished.
	unstamped := *value
	unstamped.ObservedAt = 0
	encoded, _ := json.Marshal(unstamped)
	fingerprint := sha256.Sum256(encoded)
	if fingerprint == runner.fingerprint {
		return
	}
	key, ok := runner.vaultKey(ctx, token, pinnedKey)
	if !ok {
		return
	}
	sender, sealed, err := summary.SealSummary(key, sessionID, uid, runner.policy.Generation, *value)
	if err != nil {
		return
	}
	if runner.upload(ctx, token, sessionID, account.SessionSummaryUpload{
		Generation: runner.policy.Generation, ObservedAt: value.ObservedAt, SenderPublicKey: sender, Sealed: sealed,
	}) {
		runner.fingerprint = fingerprint
	}
}

func (runner *summaryRunner) publishEnclave(ctx context.Context, token, sessionID, uid, pinnedKey string, now time.Time) {
	raw, total, lastOutput := runner.output.snapshot()
	if total == 0 || total == runner.lastTotal {
		return
	}
	if runner.lastPublished.IsZero() {
		// The flowing interval counts from the first output seen, not from the epoch.
		runner.lastPublished = now
	}
	quiet := now.Sub(lastOutput) >= summaryQuiet
	flowing := now.Sub(runner.lastPublished) >= summaryFlowing
	if !quiet && !flowing {
		return
	}
	tail := summary.PrepareTail(raw)
	if tail == "" {
		runner.lastTotal = total
		return
	}
	fingerprint := sha256.Sum256([]byte(runner.label + "\x00" + tail))
	if fingerprint == runner.fingerprint {
		runner.lastTotal = total
		return
	}
	key, ok := runner.vaultKey(ctx, token, pinnedKey)
	if !ok {
		return
	}
	bounded, cancel := context.WithTimeout(ctx, linkTimeout)
	ticket, err := runner.link.client.RequestSummaryTicket(bounded, token, sessionID)
	cancel()
	if err != nil || ticket.Generation != runner.policy.Generation || ticket.OwnerUID != uid {
		return
	}
	if runner.client == nil {
		client, err := runner.newClient()
		if err != nil {
			return
		}
		runner.client = client
	}
	request := summary.Request{
		V: 1, Ticket: ticket.Ticket, SessionID: sessionID, RecipientUID: uid, Generation: ticket.Generation,
		ObservedAt: now.UnixMilli(), RecipientPublicKey: key, Label: summary.RedactLabel(runner.label), Tail: tail,
	}
	summarizeContext, cancelSummarize := context.WithTimeout(ctx, summaryRequestTimeout)
	result, err := runner.client.Summarize(summarizeContext, request)
	cancelSummarize()
	if err != nil || !summary.ValidSealedSummary(result.SenderPublicKey, result.Sealed) {
		return
	}
	if runner.upload(ctx, token, sessionID, account.SessionSummaryUpload{
		Generation: ticket.Generation, ObservedAt: request.ObservedAt, SenderPublicKey: result.SenderPublicKey, Sealed: result.Sealed,
	}) {
		runner.fingerprint, runner.lastTotal, runner.lastPublished = fingerprint, total, now
	}
}

func (runner *summaryRunner) upload(ctx context.Context, token, sessionID string, upload account.SessionSummaryUpload) bool {
	if _, _, closed := runner.link.summaryIdentity(); closed || ctx.Err() != nil {
		return false
	}
	bounded, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	if runner.link.client.PublishSessionSummary(bounded, token, sessionID, upload) != nil {
		return false
	}
	// The service moves nextPublishAt on; read it again before the next attempt.
	runner.policyAt = time.Time{}
	return true
}
