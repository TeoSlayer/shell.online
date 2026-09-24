package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/term"

	"shell.online/internal/api"
	"shell.online/internal/e2ee"
	"shell.online/internal/protocol"
	"shell.online/internal/relay"
	"shell.online/internal/ringbuffer"
)

const (
	outputBatchInterval = 10 * time.Millisecond
	outputBatchBytes    = 32 * 1024
	snapshotBytes       = 512 * 1024
	desktopTerminalCols = 120
	desktopTerminalRows = 36
	// The wider desktop grid, offered only to a relay that asked for it. A
	// terminal shows what fits in its grid and nothing else, and on a wide
	// screen 120x36 was the amount of work you could see at once.
	wideDesktopCols        = 160
	wideDesktopRows        = 48
	mobileTerminalCols     = 80
	mobileTerminalRows     = 40
	legacyMobileRows       = 24
	backgroundStartupGrace = 250 * time.Millisecond
	// mcpTypingWindow is the quiescence after the last human PTY write during which an MCP
	// shell_send is rejected (delivery_uncertain, nothing written) rather than interleaved
	// with the human's keystrokes.
	mcpTypingWindow = 250 * time.Millisecond
)

type sharedTerminalProcess interface {
	io.ReadWriteCloser
	Resize(cols, rows int) error
	Wait() error
	Process() *os.Process
	Finish() error
}

// sessionCipher allows one active session to change credentials without
// changing its relay identity or PTY. Every frame takes the read lock; a
// rotation therefore has a single boundary after which no old-key frame can
// be emitted or accepted.
type sessionCipher struct {
	mu    sync.RWMutex
	value *e2ee.Cipher
}

func newSessionCipher(value *e2ee.Cipher) *sessionCipher { return &sessionCipher{value: value} }

func (cipher *sessionCipher) Seal(frame []byte) ([]byte, error) {
	cipher.mu.RLock()
	defer cipher.mu.RUnlock()
	if cipher.value == nil {
		return frame, nil
	}
	return cipher.value.SealFrame(frame)
}

func (cipher *sessionCipher) Open(frame []byte) ([]byte, error) {
	cipher.mu.RLock()
	defer cipher.mu.RUnlock()
	if cipher.value == nil {
		return frame, nil
	}
	return cipher.value.OpenFrame(frame)
}

func (cipher *sessionCipher) Rotate(value *e2ee.Cipher) *e2ee.Cipher {
	cipher.mu.Lock()
	previous := cipher.value
	cipher.value = value
	cipher.mu.Unlock()
	return previous
}

func (cipher *sessionCipher) Key() []byte {
	cipher.mu.RLock()
	defer cipher.mu.RUnlock()
	return cipher.value.Key()
}

func runSharedProcess(
	ctx context.Context,
	session api.Session,
	commandArguments []string,
	commandEnvironment []string,
	stdout io.Writer,
	stderr io.Writer,
	onConnected func(),
	onStarted func(),
	control localSessionControl,
	currentPassword string,
	persistentStatePath string,
	onPasswordRotated func(string, string),
	fileService *sharedFileService,
	flowSink mcpFlowSink,
) (int, error) {
	// Keep the relay alive after the task context is cancelled so the final
	// terminal state and exit event can still reach the browser.
	relayContext, cancelRelay := context.WithCancel(context.Background())
	type dialResult struct {
		connection *relay.Connection
		err        error
	}
	dialed := make(chan dialResult, 1)
	go func() {
		connection, err := relay.Dial(relayContext, session.WebSocketURL, session.HostToken)
		dialed <- dialResult{connection: connection, err: err}
	}()
	var connection *relay.Connection
	var err error
	select {
	case result := <-dialed:
		connection, err = result.connection, result.err
	case <-ctx.Done():
		cancelRelay()
		result := <-dialed
		if result.connection != nil {
			result.connection.Close()
		}
		return 1, fmt.Errorf("connect relay: %w", ctx.Err())
	}
	if err != nil {
		cancelRelay()
		return 1, fmt.Errorf("connect relay: %w", err)
	}
	defer func() {
		cancelRelay()
		connection.Close()
	}()
	if onConnected != nil {
		onConnected()
	}

	outputRing := ringbuffer.NewTerminal(snapshotBytes, desktopTerminalCols, desktopTerminalRows)
	defer outputRing.Close()
	frameCipher := newSessionCipher(session.Cipher)
	if managed, ok := control.(*managedLocalSession); ok {
		managed.terminalMu.Lock()
		managed.mcpFrameKey = frameCipher.Key
		managed.terminalMu.Unlock()
	}
	rotationAcknowledged := make(chan struct{}, 1)
	var supportsRotation atomic.Bool

	if terminal := os.Stdin; term.IsTerminal(int(terminal.Fd())) {
		previousState, rawError := term.MakeRaw(int(terminal.Fd()))
		if rawError != nil {
			sendFinalState(connection, outputRing, frameCipher, 1, nil)
			return 1, fmt.Errorf("enter raw terminal mode: %w", rawError)
		}
		defer func() { _ = term.Restore(int(terminal.Fd()), previousState) }()
	}

	ptmx, err := startTerminalProcess(commandArguments, terminalEnvironment(commandEnvironment))
	if err != nil {
		sendFinalState(connection, outputRing, frameCipher, 1, nil)
		return 1, fmt.Errorf("start %s: %w", commandArguments[0], err)
	}
	defer ptmx.Close()

	// All host-side input (foreground stdin, local attachment, browser viewer, MCP send)
	// routes through one arbiter so a typing human can never be interleaved by an MCP send.
	arbiter := newInputArbiter(ptmx)

	localTypingMessage := []byte(`{"type":"local_typing"}`)
	var localTypingMu sync.Mutex
	var lastLocalTyping time.Time
	notifyLocalTyping := func() {
		localTypingMu.Lock()
		if time.Since(lastLocalTyping) < 650*time.Millisecond {
			localTypingMu.Unlock()
			return
		}
		lastLocalTyping = time.Now()
		localTypingMu.Unlock()
		_ = connection.Send(relay.TextMessage, localTypingMessage)
	}
	if control != nil {
		notifyAttachChange := func(attached bool) {
			message, _ := json.Marshal(struct {
				Type     string `json:"type"`
				Attached bool   `json:"attached"`
			}{Type: "local_attached", Attached: attached})
			_ = connection.Send(relay.TextMessage, message)
		}
		control.BindTerminal(
			humanPTYWriter{arbiter},
			outputRing,
			nil,
			notifyLocalTyping,
			notifyAttachChange,
		)
		control.BindPasswordRotation(func(password string) (string, error) {
			if !session.Encrypted || !supportsRotation.Load() {
				return "", fmt.Errorf("the connected relay does not support live password rotation")
			}
			fresh, fragment, key, generateErr := e2ee.GenerateMaterial(password)
			if generateErr != nil {
				return "", generateErr
			}
			shareURL := strings.SplitN(session.ShareURL, "#", 2)[0] + fragment
			oldShareURL, oldPassword := session.ShareURL, currentPassword
			var previousCipher *e2ee.Cipher
			var previousPersistent *persistentSessionState
			if persistentStatePath != "" {
				state, readErr := readPersistentState(persistentStatePath)
				if readErr != nil {
					return "", fmt.Errorf("read persistent state: %w", readErr)
				}
				previousPersistent = &state
				state.Fragment = fragment
				state.EncryptionKey = base64.RawURLEncoding.EncodeToString(key)
				state.BrowserPassword = password
				if writeErr := writePersistentState(persistentStatePath, state); writeErr != nil {
					return "", fmt.Errorf("write persistent state: %w", writeErr)
				}
			}
			rollback := func() {
				frameCipher.Rotate(previousCipher)
				_ = control.UpdateCredentials(oldShareURL, oldPassword)
				if previousPersistent != nil {
					_ = writePersistentState(persistentStatePath, *previousPersistent)
				}
			}
			if updateErr := control.UpdateCredentials(shareURL, password); updateErr != nil {
				if previousPersistent != nil {
					_ = writePersistentState(persistentStatePath, *previousPersistent)
				}
				return "", fmt.Errorf("store new password: %w", updateErr)
			}
			/* Reject old-key input before asking the relay to disconnect its
			 * holders. This removes the acknowledgement-window race. */
			previousCipher = frameCipher.Rotate(fresh)
			if sendErr := connection.Send(relay.TextMessage, []byte(`{"type":"credentials_rotate"}`)); sendErr != nil {
				rollback()
				return "", fmt.Errorf("notify relay: %w", sendErr)
			}
			select {
			case <-rotationAcknowledged:
			case <-time.After(3 * time.Second):
				rollback()
				return "", fmt.Errorf("relay did not acknowledge password rotation")
			}
			session.ShareURL = shareURL
			currentPassword = password
			if onPasswordRotated != nil {
				onPasswordRotated(shareURL, password)
			}
			return shareURL, nil
		})
	}

	outputKicks := make(chan struct{}, 64)
	outputEmitter := newOutputEmitter(connection, outputRing, frameCipher)
	batchDone := make(chan struct{})
	go batchOutput(relayContext, outputKicks, outputEmitter, batchDone)

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buffer := make([]byte, 32*1024)
		for {
			count, readError := ptmx.Read(buffer)
			if count > 0 {
				chunk := append([]byte(nil), buffer[:count]...)
				_, _ = stdout.Write(chunk)
				if control != nil {
					control.PublishOutput(chunk)
				} else {
					_, _ = outputRing.Write(chunk)
				}
				select {
				case outputKicks <- struct{}{}:
				default:
					// The replay ring remains authoritative when the relay is slower than the PTY.
				}
			}
			if readError != nil {
				return
			}
		}
	}()

	go func() {
		_, _ = io.Copy(humanPTYWriter{arbiter}, os.Stdin)
	}()

	sharingFinished := make(chan struct{})
	exitAcknowledged := make(chan struct{}, 1)
	var relayWarning sync.Once
	go func() {
		err := readRelay(connection, ptmx, arbiter, outputEmitter, frameCipher, session.ReadOnly, exitAcknowledged, rotationAcknowledged, &supportsRotation, fileService, flowSink)
		select {
		case <-sharingFinished:
			return
		default:
		}
		if err != nil && !errors.Is(err, context.Canceled) {
			relayWarning.Do(func() {
				fmt.Fprintf(stderr, "\r\nshell: sharing connection ended: %v\r\n", err)
			})
		}
	}()
	processResult := make(chan error, 1)
	go func() { processResult <- ptmx.Wait() }()

	var waitError error
	if onStarted != nil {
		var exited bool
		waitError, exited = waitForBackgroundStartup(processResult, backgroundStartupGrace)
		if !exited {
			onStarted()
			waitError = waitForProcess(ctx, ptmx, processResult)
		}
	} else {
		waitError = waitForProcess(ctx, ptmx, processResult)
	}
	_ = ptmx.Finish()
	<-readDone
	close(outputKicks)
	<-batchDone
	close(sharingFinished)

	exitCode := processExitCode(waitError)
	sendFinalState(connection, outputRing, frameCipher, exitCode, exitAcknowledged)

	if waitError != nil {
		var exitError *exec.ExitError
		if !errors.As(waitError, &exitError) {
			return exitCode, fmt.Errorf("wait for process: %w", waitError)
		}
	}
	return exitCode, nil
}

func waitForBackgroundStartup(result <-chan error, grace time.Duration) (error, bool) {
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case err := <-result:
		return err, true
	case <-timer.C:
		return nil, false
	}
}

func waitForProcess(ctx context.Context, command sharedTerminalProcess, result <-chan error) error {
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
	}

	terminateProcess(command.Process(), false)
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case err := <-result:
		return err
	case <-timer.C:
		terminateProcess(command.Process(), true)
		return <-result
	}
}

func sendFinalState(
	connection *relay.Connection,
	output *ringbuffer.Buffer,
	frameCipher *sessionCipher,
	exitCode int,
	exitAcknowledged <-chan struct{},
) {
	finalContext, cancelFinal := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelFinal()
	if !connection.WaitActive(finalContext) {
		return
	}

	snapshot := output.Snapshot()
	if snapshot != nil {
		finalSnapshot, err := sealFrame(frameCipher, protocol.Frame(protocol.FinalSnapshot, snapshot))
		if err != nil {
			return
		}
		if connection.SendSyncContext(finalContext, relay.BinaryMessage, finalSnapshot) != nil {
			return
		}
	}
	exitEvent, _ := json.Marshal(struct {
		Type string `json:"type"`
		Code int    `json:"code"`
	}{Type: "exit", Code: exitCode})
	if connection.SendSyncContext(finalContext, relay.TextMessage, exitEvent) != nil || exitAcknowledged == nil {
		return
	}

	acknowledgementTimeout := time.NewTimer(2 * time.Second)
	defer acknowledgementTimeout.Stop()
	select {
	case <-exitAcknowledged:
	case <-acknowledgementTimeout.C:
	case <-finalContext.Done():
	}
}

const (
	snapshotReplyTimeout = time.Second
	snapshotRetryDelay   = 5 * time.Millisecond
	// pendingSnapshotLimit bounds deferred snapshot replies; at the limit a
	// broadcast recovery covers every waiting viewer instead of growing the
	// set.
	pendingSnapshotLimit = 16
)

// outputEmitter is the single host-side producer of terminal output frames.
// Every Output delta, recovery BroadcastSnapshot, and targeted Snapshot is
// enqueued under one lock, derived from one captured cut of the replay ring:
// emitter.cut is the ring offset through which every byte has been enqueued.
// A viewer therefore receives each byte either in its last snapshot or in
// output after that snapshot, never both. The ring stays the authoritative
// store; the emitter lock is separate from the ring lock, which is held only
// long enough to copy a view.
type outputEmitter struct {
	mu           sync.Mutex
	connection   *relay.Connection
	output       *ringbuffer.Buffer
	frameCipher  *sessionCipher
	cut          int64
	generation   uint64
	lastFlush    time.Time
	lastRecovery time.Time
	// pendingSnapshots holds viewer IDs whose targeted snapshot reply the
	// relay refused; the flush cadence retries them with a fresh ordered cut.
	pendingSnapshots map[uint32]struct{}
	// pendingBroadcast is set when deferred replies overflowed the bound and
	// the immediate recovery broadcast was refused; the flush cadence retries
	// that single broadcast until it is enqueued.
	pendingBroadcast bool
	// sendFrame is the relay hand-off; tests replace it to simulate
	// backpressure deterministically.
	sendFrame func([]byte) bool
}

func newOutputEmitter(connection *relay.Connection, output *ringbuffer.Buffer, frameCipher *sessionCipher) *outputEmitter {
	emitter := &outputEmitter{
		connection:       connection,
		output:           output,
		frameCipher:      frameCipher,
		generation:       connection.Generation(),
		pendingSnapshots: make(map[uint32]struct{}),
	}
	emitter.sendFrame = emitter.enqueueFrame
	return emitter
}

func (emitter *outputEmitter) enqueueFrame(frame []byte) bool {
	if !emitter.connection.Active() {
		return false
	}
	sealed, err := sealFrame(emitter.frameCipher, frame)
	if err != nil {
		return false
	}
	return emitter.connection.TrySend(relay.BinaryMessage, sealed)
}

// emitPending enqueues every retained byte not yet covered by emitter.cut:
// as Output frames from the cut, or as one recovery BroadcastSnapshot when
// the ring evicted bytes before they were emitted. Callers hold emitter.mu.
func (emitter *outputEmitter) emitPending(view ringbuffer.View) {
	if view.End == emitter.cut {
		return
	}
	if emitter.cut < view.Start {
		if view.Replay == nil {
			return
		}
		if time.Since(emitter.lastRecovery) < 250*time.Millisecond {
			return
		}
		emitter.lastRecovery = time.Now()
		if emitter.sendFrame(protocol.Frame(protocol.BroadcastSnapshot, view.Replay)) {
			emitter.cut = view.End
		}
		return
	}
	delta := view.Bytes[emitter.cut-view.Start:]
	for len(delta) > 0 {
		piece := delta
		if len(piece) > outputBatchBytes {
			piece = piece[:outputBatchBytes]
		}
		if !emitter.sendFrame(protocol.Frame(protocol.Output, piece)) {
			return
		}
		emitter.cut += int64(len(piece))
		delta = delta[len(piece):]
	}
}

// flush emits pending output on the batch cadence. A relay reconnect (a new
// connection generation) re-broadcasts the ring state even when no new output
// arrived, because frames enqueued across the dead window may never have
// reached viewers.
func (emitter *outputEmitter) flush() {
	emitter.mu.Lock()
	defer emitter.mu.Unlock()
	if generation := emitter.connection.Generation(); generation != emitter.generation {
		view := emitter.output.SnapshotView()
		if view.Replay == nil {
			return
		}
		if emitter.sendFrame(protocol.Frame(protocol.BroadcastSnapshot, view.Replay)) {
			emitter.generation = generation
			emitter.cut = view.End
		}
		return
	}
	if emitter.pendingBroadcast {
		emitter.retryPendingBroadcast()
	}
	if len(emitter.pendingSnapshots) > 0 {
		emitter.retryPendingSnapshots()
	}
	if emitter.output.End() == emitter.cut {
		return
	}
	emitter.lastFlush = time.Now()
	view := emitter.output.View()
	if emitter.cut < view.Start {
		view = emitter.output.SnapshotView()
	}
	emitter.emitPending(view)
}

// retryPendingSnapshots re-sends refused targeted snapshot replies on the
// flush cadence, one fresh ordered cut for all waiting viewers; a reply is
// removed only after its frame is actually enqueued. It stops at the first
// refused send so a full queue costs at most one sealed snapshot per tick.
// Callers hold emitter.mu.
func (emitter *outputEmitter) retryPendingSnapshots() {
	view := emitter.output.SnapshotView()
	emitter.emitPending(view)
	if emitter.cut != view.End {
		return
	}
	for viewerID := range emitter.pendingSnapshots {
		if !emitter.sendSnapshot(viewerID, view) {
			return
		}
		delete(emitter.pendingSnapshots, viewerID)
	}
}

// retryPendingBroadcast re-sends the overflow recovery broadcast on the
// flush cadence until it is enqueued; it covers every deferred target, so
// the pending set is cleared with it. Callers hold emitter.mu.
func (emitter *outputEmitter) retryPendingBroadcast() {
	view := emitter.output.SnapshotView()
	if view.Replay == nil {
		return
	}
	emitter.emitPending(view)
	if emitter.cut != view.End {
		return
	}
	if emitter.sendFrame(protocol.Frame(protocol.BroadcastSnapshot, view.Replay)) {
		emitter.pendingBroadcast = false
		emitter.pendingSnapshots = make(map[uint32]struct{})
	}
}

// deferSnapshot records a refused targeted reply for the flush cadence. A
// duplicate ID is not new capacity. At the bound, a broadcast recovery
// covers every waiting viewer (browsers reset on broadcasts); a refused
// broadcast is retried on the flush cadence until enqueued, so no target is
// dropped. Callers hold emitter.mu.
func (emitter *outputEmitter) deferSnapshot(viewerID uint32) error {
	if _, pending := emitter.pendingSnapshots[viewerID]; pending {
		return fmt.Errorf("relay did not accept the snapshot reply within %s; retrying on the output cadence", snapshotReplyTimeout)
	}
	if len(emitter.pendingSnapshots) < pendingSnapshotLimit {
		emitter.pendingSnapshots[viewerID] = struct{}{}
		return fmt.Errorf("relay did not accept the snapshot reply within %s; retrying on the output cadence", snapshotReplyTimeout)
	}
	view := emitter.output.SnapshotView()
	emitter.emitPending(view)
	if view.Replay != nil && emitter.cut == view.End && emitter.sendFrame(protocol.Frame(protocol.BroadcastSnapshot, view.Replay)) {
		emitter.pendingSnapshots = make(map[uint32]struct{})
		return nil
	}
	emitter.pendingBroadcast = true
	return fmt.Errorf("relay did not accept the snapshot reply or its broadcast recovery within %s", snapshotReplyTimeout)
}

// due reports whether a kick should flush immediately: the first output after
// an idle interval goes out at once, while a burst coalesces until the tick.
func (emitter *outputEmitter) due() bool {
	emitter.mu.Lock()
	defer emitter.mu.Unlock()
	return time.Since(emitter.lastFlush) >= outputBatchInterval
}

// snapshotFor answers one viewer's snapshot request. Pending output is
// enqueued first, through the same captured cut, and the reply is published
// only once that cut is committed and retained. The targeted frame is
// retried within the same bounded window; if the relay still cannot accept
// it, the reply is deferred to the flush cadence (deferSnapshot) instead of
// publishing a partial or empty snapshot.
func (emitter *outputEmitter) snapshotFor(viewerID uint32) error {
	emitter.mu.Lock()
	defer emitter.mu.Unlock()
	deadline := time.Now().Add(snapshotReplyTimeout)
	for {
		view := emitter.output.SnapshotView()
		emitter.emitPending(view)
		if emitter.cut == view.End && emitter.sendSnapshot(viewerID, view) {
			return nil
		}
		if time.Now().After(deadline) {
			return emitter.deferSnapshot(viewerID)
		}
		time.Sleep(snapshotRetryDelay)
	}
}

func (emitter *outputEmitter) sendSnapshot(viewerID uint32, view ringbuffer.View) bool {
	if view.Replay == nil {
		return false
	}
	frame := make([]byte, 5+len(view.Replay))
	frame[0] = protocol.Snapshot
	binary.BigEndian.PutUint32(frame[1:5], viewerID)
	copy(frame[5:], view.Replay)
	return emitter.sendFrame(frame)
}

func batchOutput(ctx context.Context, kicks <-chan struct{}, emitter *outputEmitter, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(outputBatchInterval)
	defer ticker.Stop()
	for {
		select {
		case _, open := <-kicks:
			if !open {
				emitter.flush()
				return
			}
			if emitter.due() {
				emitter.flush()
			}
		case <-ticker.C:
			emitter.flush()
		case <-ctx.Done():
			return
		}
	}
}

func readRelay(
	connection *relay.Connection,
	ptmx sharedTerminalProcess,
	arbiter *inputArbiter,
	emitter *outputEmitter,
	frameCipher *sessionCipher,
	readOnly bool,
	exitAcknowledged chan<- struct{},
	rotationAcknowledged chan<- struct{},
	supportsRotation *atomic.Bool,
	fileService *sharedFileService,
	flowSink mcpFlowSink,
) error {
	for {
		messageType, message, err := connection.Read()
		if err != nil {
			return err
		}

		if messageType == relay.TextMessage {
			/*
			 * MCP flow observations are host-only telemetry. They are parsed
			 * strictly, validated against the shared allowlists, and handed to
			 * the bounded reporter; nothing else reads or forwards them.
			 */
			if event, ok := parseMcpFlowMessage(message); ok {
				if flowSink != nil {
					flowSink(event)
				}
				continue
			}
			var event struct {
				Type               string `json:"type"`
				ViewerID           uint32 `json:"viewerId"`
				Cols               uint16 `json:"cols"`
				Rows               uint16 `json:"rows"`
				CredentialRotation bool   `json:"credentialRotation"`
			}
			if json.Unmarshal(message, &event) != nil {
				continue
			}
			if event.Type == "exit_ack" {
				select {
				case exitAcknowledged <- struct{}{}:
				default:
				}
				continue
			}
			if event.CredentialRotation {
				supportsRotation.Store(true)
			}
			if event.Type == "credentials_rotate_ack" {
				select {
				case rotationAcknowledged <- struct{}{}:
				default:
				}
				continue
			}
			if event.Type == "snapshot_request" {
				// Viewers do not re-request a missing snapshot, so a refused
				// reply is deferred and retried by the emitter's flush
				// cadence; the error only reports that the frame was not
				// enqueued now.
				_ = emitter.snapshotFor(event.ViewerID)
			}
			if event.Type == "terminal_size" {
				if isCanonicalTerminalSize(event.Cols, event.Rows) {
					emitter.output.ResizeTerminal(int(event.Cols), int(event.Rows))
					_ = ptmx.Resize(int(event.Cols), int(event.Rows))
				}
				continue
			}
			continue
		}

		if len(message) == 0 {
			continue
		}
		message, err = frameCipher.Open(message)
		if err != nil {
			continue
		}
		switch message[0] {
		case protocol.Input:
			if acceptsViewerInput(readOnly, message[0]) {
				_, _ = arbiter.humanWrite(viewerInputPayload(message))
			}
		case protocol.ConfirmedEOF:
			if acceptsViewerInput(readOnly, message[0]) {
				_, _ = arbiter.humanWrite(viewerInputPayload(message))
			}
		case protocol.Send:
			// A human typing outranks the MCP send: the arbiter rejects the write
			// immediately when the human is inside the typing window; nothing is queued.
			if readOnly {
				continue
			}
			_ = handleMcpSend(arbiter, message, func(opID string, dispatchToken []byte, result byte) {
				sealed, sealError := sealFrame(frameCipher, protocol.EncodeSendAck(opID, dispatchToken, result))
				if sealError == nil {
					_ = connection.Send(relay.BinaryMessage, sealed)
				}
			})
		case protocol.Resize:
			// A shared PTY keeps one canonical grid. Browser and local viewport
			// changes are presentation-only so simultaneous viewers cannot
			// deform each other's TUI.
		case protocol.Ping:
			if len(message) == 5 {
				response := append([]byte(nil), message...)
				response[0] = protocol.Pong
				sealed, sealError := sealFrame(frameCipher, response)
				if sealError == nil {
					_ = connection.Send(relay.BinaryMessage, sealed)
				}
			}
		case protocol.FileRequest:
			fileService.handle(connection, frameCipher, message)
		}
	}
}

func viewerInputPayload(frame []byte) []byte {
	if len(frame) > 1 && frame[0] == protocol.Input {
		if len(frame) == 2 && frame[1] == 4 {
			return nil
		}
		return frame[1:]
	}
	if len(frame) == 1 && frame[0] == protocol.ConfirmedEOF {
		return []byte{4}
	}
	return nil
}

func acceptsViewerInput(readOnly bool, opcode byte) bool {
	return !readOnly && (opcode == protocol.Input || opcode == protocol.ConfirmedEOF)
}

// inputArbiter routes every host-side PTY write through one priority rule: human input
// (foreground stdin, local attachment, browser viewer) outranks MCP shell_send. Human writes
// stamp lastHumanWrite; an MCP write proceeds only when no human wrote within the typing
// window. The stamp, the human write, and the MCP write all take the same mutex, so an MCP
// write can never start in the middle of a human burst, and a keystroke made after the MCP
// check is serialized to land after the MCP write.
type inputArbiter struct {
	target io.Writer

	mu             sync.Mutex
	lastHumanWrite time.Time
	typingWindow   time.Duration
}

func newInputArbiter(target io.Writer) *inputArbiter {
	return &inputArbiter{
		target:       target,
		typingWindow: mcpTypingWindow,
	}
}

// humanWrite performs one human-originated PTY write and records it as active typing.
func (a *inputArbiter) humanWrite(value []byte) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.lastHumanWrite = time.Now()
	return a.target.Write(value)
}

// mcpWrite performs the single atomic MCP PTY write if the human is idle (no human write
// within the typing window). It returns wrote=false when a human is actively typing; the
// caller should then REJECT the write — nothing is queued, so a rejected payload can never
// reach the PTY later.
func (a *inputArbiter) mcpWrite(payload []byte) (written int, writeErr error, wrote bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.lastHumanWrite.IsZero() && time.Since(a.lastHumanWrite) < a.typingWindow {
		return 0, nil, false
	}
	written, writeErr = a.target.Write(payload)
	return written, writeErr, true
}

// humanPTYWriter adapts an inputArbiter to io.Writer for the human input sources
// (foreground stdin, local attachment).
type humanPTYWriter struct {
	arbiter *inputArbiter
}

func (w humanPTYWriter) Write(value []byte) (int, error) {
	return w.arbiter.humanWrite(value)
}

// buildSendPayload builds the atomic PTY write payload for a shell_send: the text, plus a single
// \r when enter is set. The text and the \r are never split, so the logical operation cannot
// interleave with another actor's write.
func buildSendPayload(text []byte, enter bool) []byte {
	payload := make([]byte, 0, len(text)+1)
	payload = append(payload, text...)
	if enter {
		payload = append(payload, '\r')
	}
	return payload
}

// sendResult maps a PTY write outcome to a SendAck result code: a full write is delivered; a
// partial write or error is uncertain (the complete operation was not confirmed).
func sendResult(written, total int, writeErr error) byte {
	if writeErr != nil || written < total {
		return protocol.SendResultUncertain
	}
	return protocol.SendResultDelivered
}

// handleMcpSend performs one shell_send operation: it decodes the frame and, through the
// inputArbiter, writes the text (plus a single \r when enter is set) to the PTY in ONE atomic
// write. Human input outranks MCP: if a human wrote to the PTY within the typing window the
// send is REJECTED immediately (ack SendResultUncertain) — no write happens and nothing is
// queued, so rejected bytes can never reach the PTY later, even after the human stops typing.
// Otherwise the single write is performed and the real result is reported (delivered for a
// full write, uncertain for a partial write or error). The dispatch token decoded from the
// frame is echoed verbatim in the ack (the host never generates or interprets it). ack
// (injectable for tests) is called exactly once per frame, synchronously.
func handleMcpSend(arbiter *inputArbiter, frame []byte, ack func(opID string, dispatchToken []byte, result byte)) bool {
	op, enter, dispatchToken, text, decoded := protocol.DecodeSend(frame)
	if !decoded {
		return false
	}
	payload := buildSendPayload(text, enter)
	written, writeErr, wrote := arbiter.mcpWrite(payload)
	if !wrote {
		ack(op, dispatchToken, protocol.SendResultUncertain)
		return true
	}
	ack(op, dispatchToken, sendResult(written, len(payload), writeErr))
	return true
}

func sealFrame(frameCipher *sessionCipher, frame []byte) ([]byte, error) {
	return frameCipher.Seal(frame)
}

type terminalGrid struct {
	Cols uint16
	Rows uint16
}

func sharedTerminalSize() terminalGrid {
	return terminalGrid{Cols: desktopTerminalCols, Rows: desktopTerminalRows}
}

func isCanonicalTerminalSize(cols, rows uint16) bool {
	return (cols == desktopTerminalCols && rows == desktopTerminalRows) ||
		(cols == wideDesktopCols && rows == wideDesktopRows) ||
		(cols == mobileTerminalCols && (rows == mobileTerminalRows || rows == legacyMobileRows))
}

func terminalEnvironment(environment []string) []string {
	environment = removeEnvironmentVariables(
		environment,
		backgroundChildEnvironment,
		backgroundReadyEnvironment,
		backgroundReadyAddress,
		backgroundReadyToken,
		backgroundParentEnvironment,
	)
	environment = setEnvironmentValue(environment, "TERM", "xterm-256color")
	environment = setEnvironmentValue(environment, "COLORTERM", "truecolor")
	environment = setEnvironmentValue(environment, "COLORFGBG", "15;0")
	return setEnvironmentValue(environment, "SHELL_ONLINE", "1")
}

func setEnvironmentValue(environment []string, name, value string) []string {
	prefix := name + "="
	for index, existing := range environment {
		if strings.HasPrefix(existing, prefix) {
			environment[index] = prefix + value
			return environment
		}
	}
	return append(environment, prefix+value)
}

func processExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return platformExitCode(exitError)
	}
	return 1
}
