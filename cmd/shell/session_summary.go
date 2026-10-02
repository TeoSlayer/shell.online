package main

import (
	"bytes"
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
	// summaryQuiet is how long output must pause before the session counts as
	// idle. A session is summarised once per idle period, and only again after
	// new output followed by another idle period.
	summaryQuiet = 20 * time.Second
	// summaryRequestTimeout bounds one enclave round trip. It exceeds the
	// enclave's own limits (15 s queue wait + 90 s model deadline), so the
	// host never gives up on a request the enclave is still answering.
	summaryRequestTimeout = 120 * time.Second
	// summaryBackoffMin and summaryBackoffMax space out retries after the
	// enclave fails, so an outage costs neither tickets nor requests per tick.
	summaryBackoffMin = 2 * time.Minute
	summaryBackoffMax = 30 * time.Minute
)

type summaryRunner struct {
	link  *sessionLink
	label string
	// claudeID is the Claude Code conversation currently bound, and hookFile
	// the SessionStart hook output that moves it on /clear or /resume.
	claudeID string
	hookFile string
	// claudePath is the transcript of claudeID, once located.
	claudePath string
	output     *summaryOutput
	now        func() time.Time
	// enclaveReady reports whether this build can verify an enclave at all.
	enclaveReady func() bool

	// newClient builds the enclave client on first use; tests replace it.
	newClient func() (summarizerClient, error)
	client    summarizerClient
	// claudeDir resolves the Claude Code configuration directory.
	claudeDir func() (string, error)

	policy   account.SessionSummaryPolicy
	policyAt time.Time
	// lastTotal is the output byte count covered by the last summary. More
	// output than this means the session changed since; an attempt that fails
	// or is rate limited leaves it unchanged, so the same idle period retries.
	lastTotal   uint64
	generation  string
	fingerprint [32]byte

	// transcript caches the last transcript read, so an unchanged file is not
	// globbed, read and parsed again on every tick.
	transcriptPath string
	transcriptSize int64
	transcriptMod  time.Time
	// retryAt and backoff space out enclave attempts after a failure.
	retryAt time.Time
	backoff time.Duration
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
// published; claude binds a Claude Code session to its conversation, and is
// empty for any other process.
func (link *sessionLink) StartSummaries(ctx context.Context, label string, claude claudeBinding, output *summaryOutput) {
	if link == nil {
		return
	}
	runner := &summaryRunner{
		link: link, label: label, claudeID: claude.ID, hookFile: claude.HookFile, output: output, now: time.Now,
		enclaveReady: summary.EnclaveConfigured, newClient: defaultSummarizerClient, claudeDir: claudeConfigDir,
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
	claude := runner.claudeID != "" || runner.hookFile != ""
	// Only generic sessions need the output copy, and only when this build can
	// actually verify an enclave; otherwise nothing is captured or sent.
	generic := !claude && runner.enclaveReady != nil && runner.enclaveReady()
	runner.output.setEnabled(enabled && generic)
	if !(enabled && generic) {
		// Capture restarts from zero when it is next enabled, so the count of
		// already-summarised output must restart too.
		runner.lastTotal = 0
	}
	if !enabled || (!claude && !generic) {
		return
	}
	if policy.Generation != runner.generation {
		runner.generation, runner.fingerprint = policy.Generation, [32]byte{}
	}
	if policy.NextPublishAt > now.UnixMilli() {
		return
	}
	if claude {
		runner.publishClaude(ctx, token, sessionID, uid, pinnedKey, now)
		return
	}
	if now.Before(runner.retryAt) {
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
	if runner.hookFile != "" {
		if input := readClaudeHook(runner.hookFile); input.SessionID != "" && input.SessionID != runner.claudeID {
			// /clear, /resume or a fork moved the session to another conversation.
			runner.claudeID, runner.fingerprint, runner.transcriptPath = input.SessionID, [32]byte{}, ""
			runner.claudePath, _ = claudeTranscriptAt(dir, input.SessionID, input.TranscriptPath)
		}
	}
	if runner.claudeID == "" {
		return
	}
	path := runner.claudePath
	if path == "" {
		if path, err = findClaudeTranscript(dir, runner.claudeID); err != nil {
			return
		}
		runner.claudePath = path
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		runner.transcriptPath, runner.claudePath = "", ""
		return
	}
	if path == runner.transcriptPath && info.Size() == runner.transcriptSize && info.ModTime().Equal(runner.transcriptMod) {
		return
	}
	// The transcript counts as handled only once there is nothing left to
	// publish from it; any failure below leaves it to be read again.
	handled := func() {
		runner.transcriptPath, runner.transcriptSize, runner.transcriptMod = path, info.Size(), info.ModTime()
	}
	value, err := readClaudeSummary(path, runner.claudeID, now)
	if err != nil {
		return
	}
	if value == nil {
		handled()
		return
	}
	// Only a finished turn is summarised: an agent that is still working has
	// not gone idle, and its summary would be stale by the time it is read.
	if value.State == "working" {
		handled()
		return
	}
	// The fingerprint ignores the observation time: each turn is published once.
	unstamped := *value
	unstamped.ObservedAt = 0
	encoded, _ := json.Marshal(unstamped)
	fingerprint := sha256.Sum256(encoded)
	if fingerprint == runner.fingerprint {
		handled()
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
		handled()
	}
}

func (runner *summaryRunner) publishEnclave(ctx context.Context, token, sessionID, uid, pinnedKey string, now time.Time) {
	raw, total, lastOutput := runner.output.snapshot()
	// Nothing new since the last summary, or the session is still busy.
	if total == 0 || total == runner.lastTotal || now.Sub(lastOutput) < summaryQuiet {
		return
	}
	if total > uint64(len(raw)) {
		// The copy was trimmed at an arbitrary byte, possibly inside an escape
		// sequence; start at the next line so no half sequence reads as text.
		newline := bytes.IndexByte(raw, '\n')
		if newline < 0 {
			return
		}
		raw = raw[newline+1:]
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
		runner.backoff = min(max(runner.backoff*2, summaryBackoffMin), summaryBackoffMax)
		runner.retryAt = now.Add(runner.backoff)
		return
	}
	runner.backoff, runner.retryAt = 0, time.Time{}
	if runner.upload(ctx, token, sessionID, account.SessionSummaryUpload{
		Generation: ticket.Generation, ObservedAt: request.ObservedAt, SenderPublicKey: result.SenderPublicKey, Sealed: result.Sealed,
	}) {
		runner.fingerprint, runner.lastTotal = fingerprint, total
	}
}

func (runner *summaryRunner) upload(ctx context.Context, token, sessionID string, upload account.SessionSummaryUpload) bool {
	if _, _, closed := runner.link.summaryIdentity(); closed || ctx.Err() != nil {
		return false
	}
	bounded, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	if runner.link.client.PublishSessionSummary(bounded, token, sessionID, upload) != nil {
		// A stale generation or withdrawn consent is only learned from the
		// policy; refresh it before trying again rather than repeating a 409.
		runner.policyAt = time.Time{}
		return false
	}
	// The service moves nextPublishAt on; read it again before the next attempt.
	runner.policyAt = time.Time{}
	return true
}
