package main

import (
	"sync"
	"sync/atomic"
	"time"
)

// summaryOutputBytes bounds the raw PTY output kept for a summary. Only the
// sanitised last summary.MaxTailBytes of it are ever sent anywhere.
const summaryOutputBytes = 64 << 10

// summaryOutput is a bounded copy of recent PTY output for session summaries.
//
// It costs one atomic load per PTY read until summaries are enabled for the
// session: nothing is buffered, and no memory is allocated, before that.
// Disabling drops the buffer.
type summaryOutput struct {
	enabled atomic.Bool
	now     func() time.Time

	mu         sync.Mutex
	buffer     []byte
	total      uint64
	lastOutput time.Time
}

func newSummaryOutput() *summaryOutput {
	return &summaryOutput{now: time.Now}
}

// Write records chunk when summaries are enabled. It never fails and never
// blocks the PTY on anything but a short mutex.
func (output *summaryOutput) Write(chunk []byte) {
	if output == nil || len(chunk) == 0 || !output.enabled.Load() {
		return
	}
	output.mu.Lock()
	defer output.mu.Unlock()
	if !output.enabled.Load() {
		return
	}
	if len(chunk) >= summaryOutputBytes {
		output.buffer = append(output.buffer[:0], chunk[len(chunk)-summaryOutputBytes:]...)
	} else {
		output.buffer = append(output.buffer, chunk...)
		// Amortised trim: shift only once the buffer holds twice the bound.
		if len(output.buffer) > 2*summaryOutputBytes {
			output.buffer = append(output.buffer[:0], output.buffer[len(output.buffer)-summaryOutputBytes:]...)
		}
	}
	output.total += uint64(len(chunk))
	output.lastOutput = output.now()
}

func (output *summaryOutput) setEnabled(enabled bool) {
	if output == nil {
		return
	}
	output.mu.Lock()
	defer output.mu.Unlock()
	if enabled == output.enabled.Load() {
		return
	}
	output.enabled.Store(enabled)
	if !enabled {
		clear(output.buffer)
		output.buffer = nil
		output.total = 0
		output.lastOutput = time.Time{}
	}
}

// snapshot returns a copy of the last summaryOutputBytes, the total bytes seen
// since enabling, and when output last arrived.
func (output *summaryOutput) snapshot() ([]byte, uint64, time.Time) {
	if output == nil {
		return nil, 0, time.Time{}
	}
	output.mu.Lock()
	defer output.mu.Unlock()
	data := output.buffer
	if len(data) > summaryOutputBytes {
		data = data[len(data)-summaryOutputBytes:]
	}
	return append([]byte(nil), data...), output.total, output.lastOutput
}
