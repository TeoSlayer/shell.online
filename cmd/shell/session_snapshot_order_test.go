//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"shell.online/internal/protocol"
	"shell.online/internal/relay"
	"shell.online/internal/ringbuffer"
)

// These tests pin the ordering between the replay ring, readRelay snapshot
// replies, and the output emitter. A viewer resets its terminal on any
// snapshot and then replays subsequent output, so every byte must appear
// exactly once across "last snapshot + later output". The emitter must
// commit its cut (enqueue pending output) before it publishes a snapshot
// reply, and it must re-broadcast the ring state when the relay reconnects.

type snapshotOrderFrame struct {
	opcode  byte
	payload []byte
}

type snapshotOrderHarness struct {
	t          *testing.T
	ctx        context.Context
	viewer     *websocket.Conn
	viewers    chan *websocket.Conn
	connection *relay.Connection
	ring       *ringbuffer.Buffer
	kicks      chan struct{}
	emitter    *outputEmitter
	frames     []snapshotOrderFrame
}

func startSnapshotOrderHarness(t *testing.T, ringCapacity int) *snapshotOrderHarness {
	t.Helper()
	viewers := make(chan *websocket.Conn, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		conn, err := websocket.Accept(w, request, nil)
		if err != nil {
			return
		}
		viewers <- conn
	}))
	t.Cleanup(server.Close)

	harnessContext, cancelHarness := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancelHarness)
	connection, err := relay.Dial(harnessContext, "ws"+strings.TrimPrefix(server.URL, "http"), "test-token")
	if err != nil {
		t.Fatalf("dial test relay: %v", err)
	}
	t.Cleanup(connection.Close)

	var viewer *websocket.Conn
	select {
	case viewer = <-viewers:
	case <-harnessContext.Done():
		t.Fatal("test relay never accepted the host connection")
	}

	harness := &snapshotOrderHarness{
		t:          t,
		ctx:        harnessContext,
		viewer:     viewer,
		viewers:    viewers,
		connection: connection,
		ring:       ringbuffer.New(ringCapacity),
		kicks:      make(chan struct{}, 64),
	}
	harness.emitter = newOutputEmitter(connection, harness.ring, newSessionCipher(nil))

	exitAcknowledged := make(chan struct{}, 1)
	rotationAcknowledged := make(chan struct{}, 1)
	var supportsRotation atomic.Bool
	relayDone := make(chan error, 1)
	go func() {
		relayDone <- readRelay(connection, nil, nil, harness.emitter, newSessionCipher(nil), false, exitAcknowledged, rotationAcknowledged, &supportsRotation, nil)
	}()
	return harness
}

func (harness *snapshotOrderHarness) startBatch() {
	done := make(chan struct{})
	go batchOutput(harness.ctx, harness.kicks, harness.emitter, done)
}

// publish mirrors the PTY reader: the ring receives the chunk, then a
// non-blocking kick wakes the emitter.
func (harness *snapshotOrderHarness) publish(chunk []byte) {
	harness.t.Helper()
	if _, err := harness.ring.Write(chunk); err != nil {
		harness.t.Fatalf("write chunk to ring: %v", err)
	}
	select {
	case harness.kicks <- struct{}{}:
	default:
	}
}

func (harness *snapshotOrderHarness) requestSnapshot(viewerID uint32) {
	harness.t.Helper()
	request, err := json.Marshal(map[string]any{"type": "snapshot_request", "viewerId": viewerID})
	if err != nil {
		harness.t.Fatalf("encode snapshot request: %v", err)
	}
	if err := harness.viewer.Write(harness.ctx, websocket.MessageText, request); err != nil {
		harness.t.Fatalf("send snapshot request: %v", err)
	}
}

// readFrames accumulates every binary frame observed on the relay (across
// reconnects) into harness.frames and waits until until matches the full
// observed history, so a frame that already arrived is never missed.
func (harness *snapshotOrderHarness) readFrames(until func([]snapshotOrderFrame) bool, what string) {
	harness.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !until(harness.frames) {
		readContext, cancel := context.WithDeadline(context.Background(), deadline)
		messageType, data, err := harness.viewer.Read(readContext)
		cancel()
		if err != nil {
			harness.t.Fatalf("read %s: %v", what, err)
		}
		if messageType != websocket.MessageBinary || len(data) == 0 {
			continue
		}
		frame := snapshotOrderFrame{opcode: data[0]}
		switch data[0] {
		case protocol.Snapshot:
			if len(data) < 5 {
				harness.t.Fatalf("short snapshot frame while reading %s", what)
			}
			frame.payload = data[5:]
		default:
			frame.payload = data[1:]
		}
		harness.frames = append(harness.frames, frame)
	}
}

func containsAnyFrame(frames []snapshotOrderFrame, opcode byte, marker []byte) bool {
	for _, frame := range frames {
		if frame.opcode == opcode && bytes.Contains(frame.payload, marker) {
			return true
		}
	}
	return false
}

// countReplay replays frames the way a viewer applies them (reset on any
// snapshot, then append later output) and counts marker occurrences in the
// final replay.
func countReplay(frames []snapshotOrderFrame, marker []byte) int {
	replay := []snapshotOrderFrame{}
	for _, frame := range frames {
		switch frame.opcode {
		case protocol.Snapshot, protocol.BroadcastSnapshot:
			replay = []snapshotOrderFrame{frame}
		default:
			replay = append(replay, frame)
		}
	}
	count := 0
	for _, frame := range replay {
		count += bytes.Count(frame.payload, marker)
	}
	return count
}

// assertReplayContainsEachOnce applies the targeted-viewer rule: reset on the
// last snapshot (of any kind), then replay later output; every marker must
// appear exactly once.
func assertReplayContainsEachOnce(t *testing.T, frames []snapshotOrderFrame, markers ...string) {
	t.Helper()
	last := -1
	for i, frame := range frames {
		if frame.opcode == protocol.Snapshot || frame.opcode == protocol.BroadcastSnapshot {
			last = i
		}
	}
	if last < 0 {
		t.Fatal("no snapshot frame was received")
	}
	for _, marker := range markers {
		if count := countReplay(frames[last:], []byte(marker)); count != 1 {
			t.Fatalf("marker %q appears %d times across last snapshot + later output, want exactly 1", marker, count)
		}
	}
}

// assertGlobalStreamReplaysEachOnce applies the existing-viewer rule: long-
// lived viewers receive the global Output/BroadcastSnapshot stream (no
// targeted snapshots); replayed with broadcast resets, every marker must
// appear exactly once.
func assertGlobalStreamReplaysEachOnce(t *testing.T, frames []snapshotOrderFrame, markers ...string) {
	t.Helper()
	global := []snapshotOrderFrame{}
	for _, frame := range frames {
		if frame.opcode == protocol.Output || frame.opcode == protocol.BroadcastSnapshot {
			global = append(global, frame)
		}
	}
	for _, marker := range markers {
		if count := countReplay(global, []byte(marker)); count != 1 {
			t.Fatalf("marker %q appears %d times in the replayed global stream, want exactly 1", marker, count)
		}
	}
}

// TestSnapshotRequestEmitsPendingOutputBeforeSnapshot is the deterministic
// regression: A sits in the ring with the batch worker deliberately not yet
// scheduled (a legal production interleaving), and the snapshot reply must
// carry A exactly once across the reply plus later output. The broken path
// replies Snapshot(A) while A is uncommitted and then emits Output(A),
// Output(B), duplicating A.
func TestSnapshotRequestEmitsPendingOutputBeforeSnapshot(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)

	chunkA := []byte("MARKER_A")
	harness.publish(chunkA)
	harness.requestSnapshot(7)

	// The committed-cut emitter replies only after Output(A) is enqueued;
	// wait for the snapshot alone, not for both frames.
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Snapshot, chunkA) },
		"snapshot reply",
	)

	harness.startBatch()
	chunkB := []byte("MARKER_B")
	harness.publish(chunkB)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, chunkB) },
		"output after snapshot",
	)

	assertReplayContainsEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
	assertGlobalStreamReplaysEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
}

// TestSnapshotRequestWithoutWaitingForFlush keeps the batch worker running and
// issues the snapshot request without waiting for the Output frame, so the
// request may land while A is still pending. The reply plus later output must
// still contain A and B exactly once.
func TestSnapshotRequestWithoutWaitingForFlush(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)
	harness.startBatch()

	chunkA := []byte("MARKER_A")
	harness.publish(chunkA)
	harness.requestSnapshot(7)

	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Snapshot, chunkA) },
		"snapshot reply",
	)

	chunkB := []byte("MARKER_B")
	harness.publish(chunkB)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, chunkB) },
		"output after snapshot",
	)

	assertReplayContainsEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
	assertGlobalStreamReplaysEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
}

// TestSnapshotReplayWithConcurrentLaterOutput writes C while the snapshot
// request is in flight; C may be emitted before or after the reply, and the
// replay must contain A and C exactly either way.
func TestSnapshotReplayWithConcurrentLaterOutput(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)
	harness.startBatch()

	chunkA := []byte("MARKER_A")
	harness.publish(chunkA)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, chunkA) },
		"initial output",
	)

	harness.requestSnapshot(7)
	chunkC := []byte("MARKER_C")
	harness.publish(chunkC)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool {
			return containsAnyFrame(got, protocol.Snapshot, chunkA) && containsAnyFrame(got, protocol.Output, chunkC)
		},
		"snapshot reply and concurrent output",
	)

	assertReplayContainsEachOnce(t, harness.frames, "MARKER_A", "MARKER_C")
	assertGlobalStreamReplaysEachOnce(t, harness.frames, "MARKER_A", "MARKER_C")
}

// TestOverflowRecoveryBroadcastThenSnapshot fills a small ring past its
// capacity so unemitted bytes are evicted: the emitter must recover with a
// BroadcastSnapshot, and a later targeted snapshot plus output must still
// contain every marker exactly once.
func TestOverflowRecoveryBroadcastThenSnapshot(t *testing.T) {
	const marker = "OVERFLOW_MARKER"
	harness := startSnapshotOrderHarness(t, 128)
	harness.startBatch()

	chunk := append(bytes.Repeat([]byte("x"), 285), marker...)
	harness.publish(chunk)

	harness.readFrames(
		func(got []snapshotOrderFrame) bool {
			return containsAnyFrame(got, protocol.BroadcastSnapshot, []byte(marker))
		},
		"recovery broadcast",
	)
	if harness.frames[0].opcode != protocol.BroadcastSnapshot {
		t.Fatalf("first frame after overflow is opcode 0x%02x, want BroadcastSnapshot", harness.frames[0].opcode)
	}

	chunkB := []byte("MARKER_AFTER_OVERFLOW")
	harness.publish(chunkB)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, chunkB) },
		"output after recovery",
	)

	harness.requestSnapshot(7)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Snapshot, []byte(marker)) },
		"snapshot after recovery",
	)

	assertReplayContainsEachOnce(t, harness.frames, marker, "MARKER_AFTER_OVERFLOW")
	assertGlobalStreamReplaysEachOnce(t, harness.frames, marker, "MARKER_AFTER_OVERFLOW")
}

// TestSnapshotReplyWaitsForCommittedCut makes the relay hand-off fail for the
// first attempts: the reply must not be published until Output(A) is
// committed, and it must still arrive (bounded retry), with A exactly once
// across the reply plus later output.
func TestSnapshotReplyWaitsForCommittedCut(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)

	chunkA := []byte("MARKER_A")
	harness.publish(chunkA)

	realSend := harness.emitter.sendFrame
	failures := 3
	harness.emitter.sendFrame = func(frame []byte) bool {
		if failures > 0 {
			failures--
			return false
		}
		return realSend(frame)
	}
	harness.requestSnapshot(7)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Snapshot, chunkA) },
		"snapshot reply after failed sends",
	)
	harness.emitter.sendFrame = realSend

	harness.startBatch()
	chunkB := []byte("MARKER_B")
	harness.publish(chunkB)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, chunkB) },
		"output after snapshot",
	)

	assertReplayContainsEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
	assertGlobalStreamReplaysEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
}

// TestSnapshotReplyRetriesFailedTargetEnqueue lets the pending Output commit
// but makes only the first targeted Snapshot enqueue fail: the reply must
// still arrive (retried within the bounded window) with A exactly once.
func TestSnapshotReplyRetriesFailedTargetEnqueue(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)

	chunkA := []byte("MARKER_A")
	harness.publish(chunkA)

	realSend := harness.emitter.sendFrame
	failFirstSnapshot := true
	harness.emitter.sendFrame = func(frame []byte) bool {
		if frame[0] == protocol.Snapshot && failFirstSnapshot {
			failFirstSnapshot = false
			return false
		}
		return realSend(frame)
	}
	harness.requestSnapshot(7)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Snapshot, chunkA) },
		"snapshot reply after failed target enqueue",
	)
	harness.emitter.sendFrame = realSend

	harness.startBatch()
	chunkB := []byte("MARKER_B")
	harness.publish(chunkB)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, chunkB) },
		"output after snapshot",
	)

	assertReplayContainsEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
	assertGlobalStreamReplaysEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
}

// TestSnapshotReplyBoundedFailureOnFullQueue keeps the relay queue
// permanently full: snapshotFor must give up within the bounded window,
// report the failure, enqueue nothing, and leave A uncommitted so it is
// still emitted later.
func TestSnapshotReplyBoundedFailureOnFullQueue(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)
	harness.publish([]byte("MARKER_A"))

	realSend := harness.emitter.sendFrame
	harness.emitter.sendFrame = func([]byte) bool { return false }
	start := time.Now()
	err := harness.emitter.snapshotFor(7)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("snapshot reply succeeded although the relay queue never accepted a frame")
	}
	if elapsed > 2*snapshotReplyTimeout {
		t.Fatalf("snapshot reply took %s, want bounded by %s", elapsed, snapshotReplyTimeout)
	}
	if len(harness.frames) != 0 {
		t.Fatalf("%d frames were enqueued although every send failed", len(harness.frames))
	}

	harness.emitter.sendFrame = realSend
	harness.startBatch()
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, []byte("MARKER_A")) },
		"output after bounded failure",
	)
	assertGlobalStreamReplaysEachOnce(t, harness.frames, "MARKER_A")
}

// TestEmitterWaitDoesNotBlockRingWrites parks the emitter inside its bounded
// wait and checks that a concurrent ring write (the PTY reader's path) still
// completes promptly: the emitter lock must not hold the ring lock.
func TestEmitterWaitDoesNotBlockRingWrites(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)

	gate := make(chan struct{})
	parked := make(chan struct{})
	var parkedOnce sync.Once
	harness.emitter.sendFrame = func([]byte) bool {
		parkedOnce.Do(func() { close(parked) })
		<-gate
		return false
	}
	replyDone := make(chan error, 1)
	go func() { replyDone <- harness.emitter.snapshotFor(7) }()

	<-parked
	close(gate)

	start := time.Now()
	if _, err := harness.ring.Write([]byte("CONCURRENT_WRITE")); err != nil {
		t.Fatalf("write during emitter wait: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("ring write took %s while the emitter waited", elapsed)
	}

	if err := <-replyDone; err == nil {
		t.Fatal("snapshot reply succeeded although every send failed")
	}
}

// TestRefusedSnapshotReplyRetriedWithoutSecondRequest drives the real
// readRelay path: the relay queue rejects every frame for longer than the
// reply window, so the targeted reply is deferred, and then recovers. The
// viewer sends exactly one snapshot request; the deferred reply must arrive
// on the flush cadence, and later output must still contain every marker
// exactly once.
func TestRefusedSnapshotReplyRetriedWithoutSecondRequest(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)
	harness.startBatch()

	chunkA := []byte("MARKER_A")
	harness.publish(chunkA)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, chunkA) },
		"initial output",
	)

	realSend := harness.emitter.sendFrame
	harness.emitter.mu.Lock()
	harness.emitter.sendFrame = func([]byte) bool { return false }
	harness.emitter.mu.Unlock()
	harness.requestSnapshot(7)

	// Wait until the reply window has fully expired and the reply is
	// deferred; this guarantees the refusal outlasted snapshotReplyTimeout.
	deadline := time.Now().Add(5 * time.Second)
	for {
		harness.emitter.mu.Lock()
		_, pending := harness.emitter.pendingSnapshots[7]
		harness.emitter.mu.Unlock()
		if pending {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("refused snapshot reply was not deferred for retry")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Recovery without any second viewer request.
	harness.emitter.mu.Lock()
	harness.emitter.sendFrame = realSend
	harness.emitter.mu.Unlock()
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Snapshot, chunkA) },
		"deferred snapshot reply",
	)

	chunkB := []byte("MARKER_B")
	harness.publish(chunkB)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, chunkB) },
		"output after deferred reply",
	)

	assertReplayContainsEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
	assertGlobalStreamReplaysEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
}

// TestOverflowDefersRecoveryBroadcast retries the overflow path: more
// distinct refused requests than the pending limit, while every send fails.
// The queue recovers with no new viewer requests, and the recovery broadcast
// must still arrive, with later output containing every marker once.
func TestOverflowDefersRecoveryBroadcast(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)
	harness.startBatch()

	realSend := harness.emitter.sendFrame
	harness.emitter.mu.Lock()
	harness.emitter.sendFrame = func([]byte) bool { return false }
	harness.emitter.mu.Unlock()
	harness.publish([]byte("MARKER_A"))

	if err := harness.emitter.snapshotFor(1); err == nil {
		t.Fatal("first deferred reply succeeded although every send failed")
	}
	for id := uint32(2); id <= pendingSnapshotLimit; id++ {
		harness.emitter.mu.Lock()
		err := harness.emitter.deferSnapshot(id)
		harness.emitter.mu.Unlock()
		if err == nil {
			t.Fatalf("deferred reply %d succeeded although every send failed", id)
		}
	}
	harness.emitter.mu.Lock()
	overflowErr := harness.emitter.deferSnapshot(pendingSnapshotLimit + 1)
	harness.emitter.mu.Unlock()
	if overflowErr == nil {
		t.Fatal("overflow reply succeeded although every send failed")
	}

	harness.emitter.mu.Lock()
	overflow := harness.emitter.pendingBroadcast
	_, seventeenth := harness.emitter.pendingSnapshots[pendingSnapshotLimit+1]
	pendingCount := len(harness.emitter.pendingSnapshots)
	harness.emitter.mu.Unlock()
	if !overflow || seventeenth || pendingCount != pendingSnapshotLimit {
		t.Fatalf("overflow state = broadcast %v, seventeenth pending %v, pending %d; want broadcast, bounded set", overflow, seventeenth, pendingCount)
	}
	if len(harness.frames) != 0 {
		t.Fatalf("%d frames were enqueued although every send failed", len(harness.frames))
	}

	// Recovery without any new viewer request.
	harness.emitter.mu.Lock()
	harness.emitter.sendFrame = realSend
	harness.emitter.mu.Unlock()
	harness.readFrames(
		func(got []snapshotOrderFrame) bool {
			return containsAnyFrame(got, protocol.BroadcastSnapshot, []byte("MARKER_A"))
		},
		"recovery broadcast",
	)

	chunkB := []byte("MARKER_B")
	harness.publish(chunkB)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, chunkB) },
		"output after recovery",
	)

	assertReplayContainsEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
	assertGlobalStreamReplaysEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
}

// TestOverflowDuplicateAtLimitDoesNotBroadcast checks that a repeated
// request from an already-pending viewer does not count as new capacity:
// at the full limit no recovery broadcast is raised, and recovery delivers
// the targeted replies only.
func TestOverflowDuplicateAtLimitDoesNotBroadcast(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)
	harness.startBatch()

	realSend := harness.emitter.sendFrame
	harness.emitter.mu.Lock()
	harness.emitter.sendFrame = func([]byte) bool { return false }
	harness.emitter.mu.Unlock()

	for id := uint32(1); id <= pendingSnapshotLimit; id++ {
		harness.emitter.mu.Lock()
		err := harness.emitter.deferSnapshot(id)
		harness.emitter.mu.Unlock()
		if err == nil {
			t.Fatalf("deferred reply %d succeeded although every send failed", id)
		}
	}
	harness.emitter.mu.Lock()
	duplicateErr := harness.emitter.deferSnapshot(7)
	harness.emitter.mu.Unlock()
	if duplicateErr == nil {
		t.Fatal("duplicate deferred reply succeeded although every send failed")
	}

	harness.emitter.mu.Lock()
	overflow := harness.emitter.pendingBroadcast
	pendingCount := len(harness.emitter.pendingSnapshots)
	harness.emitter.mu.Unlock()
	if overflow || pendingCount != pendingSnapshotLimit {
		t.Fatalf("duplicate raised overflow = %v with pending %d; want no broadcast, bounded set", overflow, pendingCount)
	}

	harness.emitter.mu.Lock()
	harness.emitter.sendFrame = realSend
	harness.emitter.mu.Unlock()
	harness.readFrames(
		func(got []snapshotOrderFrame) bool {
			snapshots := 0
			for _, frame := range got {
				if frame.opcode == protocol.BroadcastSnapshot {
					t.Fatal("recovery broadcast was sent although no overflow occurred")
				}
				if frame.opcode == protocol.Snapshot {
					snapshots++
				}
			}
			return snapshots >= pendingSnapshotLimit
		},
		"targeted replies after recovery",
	)

	harness.emitter.mu.Lock()
	pendingCount = len(harness.emitter.pendingSnapshots)
	harness.emitter.mu.Unlock()
	if pendingCount != 0 {
		t.Fatalf("%d targeted replies were still pending after recovery", pendingCount)
	}
}

// TestReconnectGenerationRebroadcastsRingState drops the relay socket with
// the cut fully committed and no new output pending: the relay redials, and
// the generation change must re-broadcast the ring state to viewers on the
// new connection.
func TestReconnectGenerationRebroadcastsRingState(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)
	harness.startBatch()

	chunkA := []byte("MARKER_A")
	harness.publish(chunkA)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, chunkA) },
		"initial output",
	)

	_ = harness.viewer.Close(websocket.StatusNormalClosure, "")
	var reconnected *websocket.Conn
	select {
	case reconnected = <-harness.viewers:
	case <-time.After(10 * time.Second):
		t.Fatal("relay never reconnected")
	}
	harness.viewer = reconnected

	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.BroadcastSnapshot, chunkA) },
		"reconnect broadcast",
	)

	chunkB := []byte("MARKER_B")
	harness.publish(chunkB)
	harness.readFrames(
		func(got []snapshotOrderFrame) bool { return containsAnyFrame(got, protocol.Output, chunkB) },
		"output after reconnect",
	)

	assertReplayContainsEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
	assertGlobalStreamReplaysEachOnce(t, harness.frames, "MARKER_A", "MARKER_B")
}

// TestBurstOutputCoalesces publishes a burst back-to-back: the first chunk
// flushes immediately and the rest coalesce on the tick, so the burst costs
// at most two Output frames and every marker reaches the global stream
// exactly once.
func TestBurstOutputCoalesces(t *testing.T) {
	harness := startSnapshotOrderHarness(t, snapshotBytes)
	harness.startBatch()

	markers := [][]byte{[]byte("BURST_A"), []byte("BURST_B"), []byte("BURST_C")}
	for _, chunk := range markers {
		harness.publish(chunk)
	}
	harness.readFrames(
		func(got []snapshotOrderFrame) bool {
			for _, marker := range markers {
				if !containsAnyFrame(got, protocol.Output, marker) {
					return false
				}
			}
			return true
		},
		"burst output",
	)

	outputs := 0
	for _, frame := range harness.frames {
		if frame.opcode == protocol.Output {
			outputs++
		}
	}
	if outputs > 2 {
		t.Fatalf("burst of %d chunks produced %d Output frames, want at most 2 (coalesced)", len(markers), outputs)
	}
	assertGlobalStreamReplaysEachOnce(t, harness.frames, "BURST_A", "BURST_B", "BURST_C")
}
