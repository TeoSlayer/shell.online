package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"shell.online/internal/agentlog"
	"shell.online/internal/protocol"
)

/*
 * The conversation, from the agent's own record rather than from its screen.
 *
 * A full-screen agent repaints a grid, so what a viewer's terminal holds is
 * one screenful of a projection: history is gone, scrolling changes it, and
 * whether the agent is working has to be guessed from a spinner. Every agent
 * this runs keeps a machine-readable record of the same conversation on this
 * machine, written as it happens. This follows that and sends it.
 *
 * What it sends is narrow by construction -- see internal/agentlog, which
 * carries text, the name of a tool, and the questions an agent is waiting on,
 * and leaves thinking, tool inputs and attachments where they are. It is
 * sealed with the session's frame cipher exactly as terminal output is, so a
 * relay forwards it without being able to read it.
 */

// agentTapPoll is how often the record is checked.
//
// The record is appended per message and per tool step, which is seconds
// apart, so polling is the right shape and this is fast enough to feel live
// without spending a wakeup on nothing.
const agentTapPoll = 700 * time.Millisecond

/*
 * How often to look when there is nothing to find yet.
 *
 * A session is a shell first and becomes an agent session when somebody types
 * `claude`, which for most sessions is never. Looking every second for the
 * lifetime of every shell is a cost paid by the sessions that get nothing for
 * it, so after a while of finding nothing the question is asked less often.
 * An agent started later is noticed within this rather than within a second,
 * which is the right trade for something somebody has just typed.
 */
const agentTapIdlePoll = 5 * time.Second

// agentTapEager is how long to look often before settling into the slow poll.
const agentTapEager = 90 * time.Second

// agentTapLookback bounds which records can belong to this session.
//
// A session started an hour ago is not this one. Generous enough to survive a
// host restarting and reattaching, short enough that yesterday's conversation
// in the same directory is not adopted.
const agentTapLookback = 6 * time.Hour

// agentTapMaxBatch caps how many events travel in one frame, so a long
// conversation arriving at once is many ordinary frames rather than one
// enormous one.
const agentTapMaxBatch = 40

/*
 * And a cap on the frame itself, which is the one that matters.
 *
 * The relay refuses an agent frame over 256KB and closes the socket that sent
 * it. Counting events alone does not stay under that: forty messages at the
 * 32KB each is capped at would be 1.28MB, so a long conversation of long
 * answers would have disconnected the host rather than arriving. Batches are
 * therefore built by size, and the count is only a second bound.
 *
 * Under the relay's limit with room to spare, because what is measured here
 * is the payload and what the relay measures is the frame after it has been
 * sealed.
 */
const agentTapMaxFrameBytes = 160 * 1024

// agentTapFrame is what a viewer receives.
type agentTapFrame struct {
	// Harness names the adapter that read this, so a viewer can say where the
	// conversation came from.
	Harness string           `json:"harness"`
	Events  []agentlog.Event `json:"events"`
}

// followAgentRecord watches for an agent's record appearing in dir and sends
// its conversation until ctx ends.
//
// It is patient by design: a session is a shell first and becomes an agent
// session when somebody types `claude`, which may be minutes later or never.
// Until then there is nothing to find and nothing is sent.
func followAgentRecord(ctx context.Context, dir string, send func([]byte) bool) {
	home, err := os.UserHomeDir()
	if err != nil || dir == "" {
		return
	}
	started := time.Now()
	since := started.Add(-agentTapLookback)
	ticker := time.NewTicker(agentTapPoll)
	defer ticker.Stop()
	eager := true

	var adapter agentlog.Adapter
	var reader agentlog.Reader
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if reader == nil {
			found, opened, err := agentlog.Open(home, dir, since)
			if err != nil {
				if !errors.Is(err, agentlog.ErrNoTranscript) {
					return
				}
				if eager && time.Since(started) > agentTapEager {
					eager = false
					ticker.Reset(agentTapIdlePoll)
				}
				continue
			}
			adapter, reader = found, opened
			if !eager {
				eager = true
				ticker.Reset(agentTapPoll)
			}
		}
		events, err := reader.Read()
		if err != nil {
			/* The record was moved or removed; look for it again. */
			reader = nil
			continue
		}
		if !sendBatches(adapter.Name(), events, send) {
			return
		}
	}
}

/*
 * Sends events in frames that fit.
 *
 * A batch grows until the next event would take it over the limit, and then
 * goes. One event is smaller than the limit by construction -- the record
 * reader caps a message at 32KB -- so a batch always holds at least one and
 * this always makes progress.
 *
 * Returns false when the connection has gone, which is the caller's signal to
 * stop.
 */
func sendBatches(harness string, events []agentlog.Event, send func([]byte) bool) bool {
	batch := make([]agentlog.Event, 0, agentTapMaxBatch)
	flush := func() bool {
		if len(batch) == 0 {
			return true
		}
		payload, err := json.Marshal(agentTapFrame{Harness: harness, Events: batch})
		batch = batch[:0]
		if err != nil || len(payload) > agentTapMaxFrameBytes {
			/* Refused rather than sent: a frame the relay would close the
			 * socket over is worse than a gap in the conversation. */
			return true
		}
		return send(protocol.Frame(protocol.AgentEvent, payload))
	}
	size := 0
	for _, event := range events {
		/* The text plus what the fields around it cost, generously. */
		cost := len(event.Text) + 256
		if event.Choice != nil {
			cost += len(event.Choice.Question) + len(event.Choice.Header)
			for _, option := range event.Choice.Options {
				cost += len(option) + 8
			}
		}
		if len(batch) > 0 && (size+cost > agentTapMaxFrameBytes || len(batch) >= agentTapMaxBatch) {
			if !flush() {
				return false
			}
			size = 0
		}
		batch = append(batch, event)
		size += cost
	}
	return flush()
}

// workingDirectory is where this session is running, which is the only thing
// that identifies which of a machine's records belongs to it.
func workingDirectory() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	return dir
}
