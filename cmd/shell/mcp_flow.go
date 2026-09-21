package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"shell.online/internal/account"
)

// Host-side MCP flow reporting.
//
// The relay observes every MCP tool call it serves and sends the host one text
// message per observation:
//
//	{"type":"mcp_flow","event":{"id":"<uuid v4>","tool":"shell_screen","phase":"started","at":1730000000000}}
//	{"type":"mcp_flow","event":{"id":"<uuid v4>","tool":"shell_screen","phase":"settled","at":1730000000123,"outcome":"ok"}}
//
// The host treats that as untrusted input: the message is parsed strictly
// (unknown fields and unknown values are refused whole), validated against the
// shared allowlists, and then dropped into a bounded queue. A single goroutine
// drains at most mcpFlowBatchMax events per tick and posts them with the
// session's own linked-account credential. Every step is best effort: a full
// queue, a failed batch, an unreachable service or a revoked token costs
// observations, never a terminal.
const (
	// Enough to ride out one slow second without ever blocking the relay reader.
	mcpFlowQueueSize = 128
	// The service accepts at most 32 events per request.
	mcpFlowBatchMax = 32
	// One flush a second: the feed is for a live game, not an audit of record.
	mcpFlowFlushInterval = time.Second
	// Bounds one report; a hung service must not hold the reporter forever.
	mcpFlowReportTimeout = 5 * time.Second
	// A valid observation is far smaller than this; anything bigger is not one.
	mcpFlowMessageMax = 4 << 10
)

// mcpFlowSink accepts one validated observation. It must never block.
type mcpFlowSink func(account.McpFlowEvent)

// parseMcpFlowMessage strictly decodes one host text message. Anything that is
// not exactly a well-formed mcp_flow observation is refused: unknown fields at
// either level, a non-v4 id, an unlisted tool or outcome, a settled event with
// no actual outcome, or a started event that claims one.
func parseMcpFlowMessage(message []byte) (account.McpFlowEvent, bool) {
	if len(message) > mcpFlowMessageMax {
		/* Bounded before any decoding: the reader must not parse unbounded input. */
		return account.McpFlowEvent{}, false
	}
	var envelope struct {
		Type  string `json:"type"`
		Event struct {
			ID      string  `json:"id"`
			Tool    string  `json:"tool"`
			Phase   string  `json:"phase"`
			At      int64   `json:"at"`
			Outcome *string `json:"outcome"`
		} `json:"event"`
	}
	decoder := json.NewDecoder(bytes.NewReader(message))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return account.McpFlowEvent{}, false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		/* Trailing bytes after the object are not this message. */
		return account.McpFlowEvent{}, false
	}
	if envelope.Type != "mcp_flow" || envelope.Event.At <= 0 {
		return account.McpFlowEvent{}, false
	}
	if !account.IsUUIDV4(envelope.Event.ID) || !account.ValidMcpFlowTool(envelope.Event.Tool) {
		return account.McpFlowEvent{}, false
	}
	event := account.McpFlowEvent{
		ID:    envelope.Event.ID,
		Tool:  envelope.Event.Tool,
		Phase: envelope.Event.Phase,
		At:    envelope.Event.At,
	}
	switch envelope.Event.Phase {
	case "started":
		if envelope.Event.Outcome != nil {
			return account.McpFlowEvent{}, false
		}
		return event, true
	case "settled":
		if envelope.Event.Outcome == nil || !account.ValidMcpAuditOutcome(*envelope.Event.Outcome) {
			return account.McpFlowEvent{}, false
		}
		event.Outcome = *envelope.Event.Outcome
		return event, true
	default:
		return account.McpFlowEvent{}, false
	}
}

// mcpFlowReporter batches validated observations to the linked account.
type mcpFlowReporter struct {
	link   *sessionLink
	queue  chan account.McpFlowEvent
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
	// True once stop ran; enqueue becomes a no-op so nothing new can be queued
	// while the reader drains a final message.
	stopped atomic.Bool
	// Set when the service refused the token; the next flush renews before
	// reporting. Only the reporter's own goroutine reads or writes it.
	refused bool
	// Test seams: the cadence and the batch size, and the call itself.
	interval time.Duration
	batch    int
	report   func(context.Context, string, string, []account.McpFlowEvent) error
}

// newMcpFlowReporter builds a reporter around a link. A nil link yields a
// reporter every method tolerates: reporting is optional, and a machine that is
// not signed in simply has nowhere to report to.
func newMcpFlowReporter(link *sessionLink) *mcpFlowReporter {
	reportContext, cancel := context.WithCancel(context.Background())
	reporter := &mcpFlowReporter{
		link:     link,
		queue:    make(chan account.McpFlowEvent, mcpFlowQueueSize),
		ctx:      reportContext,
		cancel:   cancel,
		done:     make(chan struct{}),
		interval: mcpFlowFlushInterval,
		batch:    mcpFlowBatchMax,
	}
	if link != nil {
		reporter.report = func(ctx context.Context, token, sessionID string, events []account.McpFlowEvent) error {
			return link.client.ReportMcpFlows(ctx, token, sessionID, events)
		}
	}
	return reporter
}

// startMcpFlowReporter starts the reporter's single goroutine. Call on a link
// that exists; a nil link returns a reporter with nothing running.
func startMcpFlowReporter(link *sessionLink) *mcpFlowReporter {
	reporter := newMcpFlowReporter(link)
	if link != nil {
		go reporter.run()
	}
	return reporter
}

// enqueue records one observation without ever blocking the caller.
func (reporter *mcpFlowReporter) enqueue(event account.McpFlowEvent) {
	if reporter == nil || reporter.link == nil || reporter.report == nil || reporter.stopped.Load() {
		return
	}
	select {
	case reporter.queue <- event:
	default:
		/* Bounded and best effort: a full queue drops the observation. */
	}
}

func (reporter *mcpFlowReporter) run() {
	ticker := time.NewTicker(reporter.interval)
	defer ticker.Stop()
	for {
		select {
		case <-reporter.ctx.Done():
			return
		case <-ticker.C:
			reporter.flush()
		}
	}
}

// flush posts at most one batch. A batch that cannot be sent is dropped rather
// than retried: the feed describes the present, and a stale batch would misdate it.
func (reporter *mcpFlowReporter) flush() {
	events := make([]account.McpFlowEvent, 0, reporter.batch)
	draining := true
	for draining && len(events) < reporter.batch {
		select {
		case event := <-reporter.queue:
			events = append(events, event)
		default:
			draining = false
		}
	}
	if len(events) == 0 {
		return
	}
	token, sessionID := reporter.link.reportCredential(reporter.ctx, reporter.refused)
	if token == "" || sessionID == "" {
		/* The session was never published; there is nowhere to report it. */
		return
	}
	reporter.refused = false
	ctx, cancel := context.WithTimeout(reporter.ctx, mcpFlowReportTimeout)
	err := reporter.report(ctx, token, sessionID, events)
	cancel()
	if err == nil || !account.Unauthorized(err) {
		return
	}
	/*
	 * The service refused the token: renew once and retry this batch. A second
	 * refusal is dropped like any other failed batch.
	 */
	renewed, renewedSession := reporter.link.reportCredential(reporter.ctx, true)
	if renewed == "" || renewed == token {
		reporter.refused = true
		return
	}
	retryContext, retryCancel := context.WithTimeout(reporter.ctx, mcpFlowReportTimeout)
	_ = reporter.report(retryContext, renewed, renewedSession, events)
	retryCancel()
}

// stop ends the reporter. Idempotent and bounded: it cancels any in-flight
// report, makes further enqueues no-ops, drops whatever is still queued, and
// signals the goroutine. It never waits on the service.
func (reporter *mcpFlowReporter) stop() {
	if reporter == nil {
		return
	}
	reporter.once.Do(func() {
		reporter.stopped.Store(true)
		reporter.cancel()
		close(reporter.done)
		for {
			select {
			case <-reporter.queue:
			default:
				return
			}
		}
	})
}
