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
	outputBatchInterval    = 10 * time.Millisecond
	outputBatchBytes       = 32 * 1024
	snapshotBytes          = 512 * 1024
	desktopTerminalCols    = 120
	desktopTerminalRows    = 36
	mobileTerminalCols     = 80
	mobileTerminalRows     = 40
	legacyMobileRows       = 24
	backgroundStartupGrace = 250 * time.Millisecond
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

	outputRing := ringbuffer.New(snapshotBytes)
	frameCipher := newSessionCipher(session.Cipher)
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
			ptmx,
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

	outputChunks := make(chan []byte, 64)
	var outputDirty atomic.Bool
	batchDone := make(chan struct{})
	go batchOutput(relayContext, connection, outputChunks, outputRing, frameCipher, &outputDirty, batchDone)

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
				case outputChunks <- chunk:
				default:
					// The replay ring remains authoritative when the relay is slower than the PTY.
					outputDirty.Store(true)
				}
			}
			if readError != nil {
				return
			}
		}
	}()

	go func() {
		_, _ = io.Copy(ptmx, os.Stdin)
	}()

	sharingFinished := make(chan struct{})
	exitAcknowledged := make(chan struct{}, 1)
	var relayWarning sync.Once
	go func() {
		err := readRelay(connection, ptmx, outputRing, frameCipher, exitAcknowledged, rotationAcknowledged, &supportsRotation)
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
	close(outputChunks)
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

	finalSnapshot, err := sealFrame(frameCipher, protocol.Frame(protocol.FinalSnapshot, output.Bytes()))
	if err != nil {
		return
	}
	if connection.SendSyncContext(finalContext, relay.BinaryMessage, finalSnapshot) != nil {
		return
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

func batchOutput(
	ctx context.Context,
	connection *relay.Connection,
	chunks <-chan []byte,
	output *ringbuffer.Buffer,
	frameCipher *sessionCipher,
	dirty *atomic.Bool,
	done chan<- struct{},
) {
	defer close(done)
	ticker := time.NewTicker(outputBatchInterval)
	defer ticker.Stop()
	buffer := make([]byte, 0, outputBatchBytes)
	lastFlush := time.Time{}
	lastRecoveryAttempt := time.Time{}

	flush := func() {
		if len(buffer) == 0 {
			return
		}
		if !connection.Active() {
			dirty.Store(true)
			buffer = buffer[:0]
			return
		}
		lastFlush = time.Now()
		frame, err := sealFrame(frameCipher, protocol.Frame(protocol.Output, buffer))
		if err != nil {
			dirty.Store(true)
			buffer = buffer[:0]
			return
		}
		if !connection.TrySend(relay.BinaryMessage, frame) {
			dirty.Store(true)
		}
		buffer = buffer[:0]
	}
	recoverSnapshot := func() {
		if !dirty.Load() || !connection.Active() || time.Since(lastRecoveryAttempt) < 250*time.Millisecond {
			return
		}
		lastRecoveryAttempt = time.Now()
		frame, err := sealFrame(frameCipher, protocol.Frame(protocol.BroadcastSnapshot, output.Bytes()))
		if err != nil {
			return
		}
		if connection.TrySend(relay.BinaryMessage, frame) {
			dirty.Store(false)
		}
	}

	for {
		select {
		case chunk, open := <-chunks:
			if !open {
				flush()
				return
			}
			flushAfterFirstAppend := len(buffer) == 0 && time.Since(lastFlush) >= outputBatchInterval
			for len(chunk) > 0 {
				remaining := outputBatchBytes - len(buffer)
				if remaining > len(chunk) {
					remaining = len(chunk)
				}
				buffer = append(buffer, chunk[:remaining]...)
				chunk = chunk[remaining:]
				if flushAfterFirstAppend || len(buffer) == outputBatchBytes {
					flush()
					flushAfterFirstAppend = false
				}
			}
		case <-ticker.C:
			flush()
			recoverSnapshot()
		case <-ctx.Done():
			return
		}
	}
}

func readRelay(
	connection *relay.Connection,
	ptmx sharedTerminalProcess,
	output *ringbuffer.Buffer,
	frameCipher *sessionCipher,
	exitAcknowledged chan<- struct{},
	rotationAcknowledged chan<- struct{},
	supportsRotation *atomic.Bool,
) error {
	for {
		messageType, message, err := connection.Read()
		if err != nil {
			return err
		}

		if messageType == relay.TextMessage {
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
				snapshot := output.Bytes()
				frame := make([]byte, 5+len(snapshot))
				frame[0] = protocol.Snapshot
				binary.BigEndian.PutUint32(frame[1:5], event.ViewerID)
				copy(frame[5:], snapshot)
				sealed, sealError := sealFrame(frameCipher, frame)
				if sealError == nil {
					_ = connection.Send(relay.BinaryMessage, sealed)
				}
			}
			if event.Type == "terminal_size" {
				if isCanonicalTerminalSize(event.Cols, event.Rows) {
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
			_, _ = ptmx.Write(viewerInputPayload(message))
		case protocol.ConfirmedEOF:
			_, _ = ptmx.Write(viewerInputPayload(message))
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
