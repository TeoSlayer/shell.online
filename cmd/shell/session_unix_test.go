//go:build !windows

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
	"golang.org/x/term"
	"shell.online/internal/api"
	"shell.online/internal/e2ee"

	"shell.online/internal/protocol"
	"shell.online/internal/ringbuffer"
)

func TestPasswordCommandRetrievesAndRotatesAnActiveSession(t *testing.T) {
	runtimeDir, err := os.MkdirTemp("/tmp", "shell-pw-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(runtimeDir) })
	t.Setenv("SHELL_ONLINE_RUNTIME_DIR", runtimeDir)
	id := strings.Repeat("p", 32)
	control, err := startLocalSession(localSessionRecord{
		ID: id, ShareURL: "https://shell.online/s/" + id + "#salt=old",
		Encrypted: true, Password: "old-pass", Command: "top", PID: 1234, StartedAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	control.BindPasswordRotation(func(password string) (string, error) {
		url := "https://shell.online/s/" + id + "#salt=new"
		if err := control.UpdateCredentials(url, password); err != nil {
			return "", err
		}
		return url, nil
	})

	var out, warnings strings.Builder
	if code := runSessionPassword([]string{id[:10]}, &out, &warnings); code != 0 || out.String() != "old-pass\n" {
		t.Fatalf("retrieve code=%d out=%q err=%q", code, out.String(), warnings.String())
	}
	t.Setenv("SHELL_ONLINE_E2EE_PASSWORD", "new-pass")
	out.Reset()
	warnings.Reset()
	if code := runSessionPassword([]string{"rotate", id[:10]}, &out, &warnings); code != 0 {
		t.Fatalf("rotate code=%d out=%q err=%q", code, out.String(), warnings.String())
	}
	if !strings.Contains(out.String(), "Password: new-pass") || !strings.Contains(out.String(), "#salt=new") {
		t.Fatalf("rotation output = %q", out.String())
	}
	loaded, err := loadActiveLocalSessions()
	if err != nil || len(loaded) != 1 || loaded[0].Password != "new-pass" {
		t.Fatalf("rotated local record = %+v, %v", loaded, err)
	}
}

func TestSessionCipherRotationRejectsOldGeneration(t *testing.T) {
	oldCipher, _, err := e2ee.Generate("old-password")
	if err != nil {
		t.Fatal(err)
	}
	newCipher, _, err := e2ee.Generate("new-password")
	if err != nil {
		t.Fatal(err)
	}
	rotating := newSessionCipher(oldCipher)
	oldFrame, err := rotating.Seal([]byte{protocol.Output, 'a'})
	if err != nil {
		t.Fatal(err)
	}
	rotating.Rotate(newCipher)
	if _, err := rotating.Open(oldFrame); err == nil {
		t.Fatal("old generation opened after rotation")
	}
	newFrame, err := rotating.Seal([]byte{protocol.Output, 'b'})
	if err != nil {
		t.Fatal(err)
	}
	opened, err := rotating.Open(newFrame)
	if err != nil || string(opened) != string([]byte{protocol.Output, 'b'}) {
		t.Fatalf("new generation = %v, %v", opened, err)
	}
}

func TestReadOnlySessionRejectsInputInsideTheCLI(t *testing.T) {
	for _, opcode := range []byte{protocol.Input, protocol.ConfirmedEOF} {
		if acceptsViewerInput(true, opcode) {
			t.Fatalf("read-only CLI accepted opcode 0x%02x", opcode)
		}
		if !acceptsViewerInput(false, opcode) {
			t.Fatalf("interactive CLI rejected opcode 0x%02x", opcode)
		}
	}
}

func TestSharedProcessCancelsHangingRelayDialBeforeAnnouncing(t *testing.T) {
	requestStarted := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		close(requestStarted)
		<-request.Context().Done()
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	announced := make(chan struct{}, 1)
	go func() {
		_, err := runSharedProcess(
			ctx,
			api.Session{WebSocketURL: "ws" + strings.TrimPrefix(server.URL, "http"), HostToken: "test-token"},
			[]string{"/bin/sh", "-c", "sleep 1"},
			nil,
			io.Discard,
			io.Discard,
			func() { announced <- struct{}{} },
			nil,
			nil,
			"",
			"",
			nil,
			nil,
			nil,
		)
		result <- err
	}()

	select {
	case <-requestStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("relay dial never started")
	}
	cancel()
	select {
	case err := <-result:
		if err == nil || !strings.Contains(err.Error(), "context canceled") {
			t.Fatalf("cancelled relay dial returned %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("relay dial ignored cancellation")
	}
	select {
	case <-announced:
		t.Fatal("share was announced before the relay connected")
	default:
	}
}

func TestTerminalEnvironmentAdvertisesBrowserCapabilities(t *testing.T) {
	environment := terminalEnvironment([]string{
		"PATH=/bin",
		"TERM=dumb",
		"COLORTERM=old",
		"COLORFGBG=0;15",
		backgroundChildEnvironment + "=1",
		backgroundReadyEnvironment + "=3",
		backgroundParentEnvironment + "=12345",
	})

	want := map[string]string{
		"TERM":         "xterm-256color",
		"COLORTERM":    "truecolor",
		"COLORFGBG":    "15;0",
		"SHELL_ONLINE": "1",
	}
	for name, value := range want {
		prefix := name + "="
		found := false
		for _, entry := range environment {
			if entry == prefix+value {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("terminalEnvironment() does not contain %q", prefix+value)
		}
	}
	for _, name := range []string{
		backgroundChildEnvironment,
		backgroundReadyEnvironment,
		backgroundParentEnvironment,
	} {
		if value := environmentValue(environment, name); value != "" {
			t.Errorf("terminalEnvironment() retained internal %s=%q", name, value)
		}
	}
}

func TestTerminalProcessRoundTripsInputAndResize(t *testing.T) {
	process, err := startTerminalProcess(
		[]string{"/bin/sh", "-c", `stty -echo; printf 'ready\n'; IFS= read -r line; stty size; printf 'reply:%s\n' "$line"`},
		terminalEnvironment([]string{"PATH=/usr/bin:/bin"}),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		terminateProcess(process.Process(), true)
		_ = process.Close()
	}()

	type terminalReadEvent struct {
		line string
		err  error
	}
	events := make(chan terminalReadEvent, 4)
	go func() {
		reader := bufio.NewReader(process)
		for {
			line, readError := reader.ReadString('\n')
			if line != "" {
				events <- terminalReadEvent{line: strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")}
			}
			if readError != nil {
				events <- terminalReadEvent{err: readError}
				return
			}
		}
	}()

	nextLine := func() string {
		t.Helper()
		select {
		case event := <-events:
			if event.err != nil {
				t.Fatalf("read terminal output: %v", event.err)
			}
			return event.line
		case <-time.After(5 * time.Second):
			t.Fatal("timed out reading terminal output")
		}
		return ""
	}

	if line := nextLine(); line != "ready" {
		t.Fatalf("first terminal line = %q", line)
	}
	if err := process.Resize(91, 37); err != nil {
		t.Fatal(err)
	}
	if _, err := process.Write([]byte("hello from qemu\n")); err != nil {
		t.Fatal(err)
	}
	if line := nextLine(); line != "37 91" {
		t.Fatalf("resized terminal reported %q", line)
	}
	if line := nextLine(); line != "reply:hello from qemu" {
		t.Fatalf("terminal reply = %q", line)
	}
	if err := process.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := process.Finish(); err != nil {
		t.Fatal(err)
	}
}

func TestTerminalProcessRejectsDimensionsThatWouldWrap(t *testing.T) {
	process := &unixTerminalProcess{}
	for _, size := range [][2]int{{0, 24}, {80, 0}, {65_536, 24}, {80, 65_536}} {
		if err := process.Resize(size[0], size[1]); err == nil {
			t.Fatalf("Resize(%d, %d) accepted a size outside uint16", size[0], size[1])
		}
	}
}

func TestWaitForTerminalInputRejectsInvalidDescriptor(t *testing.T) {
	if _, err := waitForTerminalInput(-1, time.Millisecond); err == nil {
		t.Fatal("negative file descriptor was accepted")
	}
}

type capturedInput struct {
	values chan []byte
}

func (capture *capturedInput) Write(value []byte) (int, error) {
	capture.values <- append([]byte(nil), value...)
	return len(value), nil
}

func TestLocalAttachmentReplaysAndMirrorsTerminal(t *testing.T) {
	id := strings.Repeat("a", 31) + "1"
	control, err := startLocalSession(localSessionRecord{
		ID:        id,
		ShareURL:  "https://shell.online/s/" + id,
		Command:   "test-command",
		PID:       12345,
		StartedAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()

	output := ringbuffer.New(1024)
	input := &capturedInput{values: make(chan []byte, 1)}
	resizes := make(chan [2]uint16, 1)
	attachChanges := make(chan bool, 2)
	control.BindTerminal(input, output, func(cols, rows uint16) error {
		resizes <- [2]uint16{cols, rows}
		return nil
	}, nil, func(attached bool) { attachChanges <- attached })
	control.PublishOutput([]byte("existing\r\n"))

	directory, _ := localSessionDirectory()
	connection, err := net.DialTimeout("unix", localSessionSocketPath(directory, id), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := fmt.Fprintln(connection, "attach"); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(connection)
	responseLine, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var response localControlResponse
	if err := json.Unmarshal(responseLine, &response); err != nil || !response.OK {
		t.Fatalf("attach response = %q, error = %v", responseLine, err)
	}

	replayed := make([]byte, len("existing\r\n"))
	if _, err := io.ReadFull(reader, replayed); err != nil {
		t.Fatal(err)
	}
	if string(replayed) != "existing\r\n" {
		t.Fatalf("replayed output = %q", replayed)
	}
	select {
	case attached := <-attachChanges:
		if !attached {
			t.Fatal("local attachment did not claim PTY sizing")
		}
	case <-time.After(time.Second):
		t.Fatal("local attachment change was not reported")
	}

	if err := writeAll(connection, []byte("local input")); err != nil {
		t.Fatal(err)
	}
	select {
	case value := <-input.values:
		if string(value) != "local input" {
			t.Fatalf("attached input = %q", value)
		}
	case <-time.After(time.Second):
		t.Fatal("attached input was not forwarded")
	}

	control.PublishOutput([]byte("mirrored"))
	mirrored := make([]byte, len("mirrored"))
	if _, err := io.ReadFull(reader, mirrored); err != nil {
		t.Fatal(err)
	}
	if string(mirrored) != "mirrored" {
		t.Fatalf("mirrored output = %q", mirrored)
	}

	if err := requestLocalSessionResize(id, 120, 42); err != nil {
		t.Fatal(err)
	}
	select {
	case size := <-resizes:
		t.Fatalf("shared terminal was resized to %v", size)
	case <-time.After(50 * time.Millisecond):
		// The compatibility request is acknowledged without deforming the PTY.
	}
	// The observable contract is the server-side detach below. Some emulated
	// Unix kernels report EBADF when both ends finish the socket concurrently,
	// even though the descriptor is already closed as requested.
	_ = connection.Close()
	select {
	case attached := <-attachChanges:
		if attached {
			t.Fatal("local detachment did not release PTY sizing")
		}
	case <-time.After(time.Second):
		t.Fatal("local detachment change was not reported")
	}
}

func TestSharedTerminalUsesLargeGridUntilPhoneCompatibilityIsRequested(t *testing.T) {
	size := sharedTerminalSize()
	if size.Cols != 120 || size.Rows != 36 {
		t.Fatalf("shared terminal size = %dx%d, want 120x36", size.Cols, size.Rows)
	}
	for _, candidate := range [][2]uint16{{120, 36}, {160, 48}, {80, 40}, {80, 24}} {
		if !isCanonicalTerminalSize(candidate[0], candidate[1]) {
			t.Fatalf("canonical terminal size %v was rejected", candidate)
		}
	}
	for _, candidate := range [][2]uint16{{160, 50}, {79, 24}, {80, 25}, {161, 48}} {
		if isCanonicalTerminalSize(candidate[0], candidate[1]) {
			t.Fatalf("arbitrary terminal size %v was accepted", candidate)
		}
	}
}

func TestBackgroundStartupWaitDetectsFastExit(t *testing.T) {
	result := make(chan error, 1)
	result <- nil
	if err, exited := waitForBackgroundStartup(result, time.Second); err != nil || !exited {
		t.Fatalf("fast exit = (%v, %v), want (nil, true)", err, exited)
	}
}

func TestBackgroundStartupWaitReleasesLongRunningTask(t *testing.T) {
	result := make(chan error)
	started := time.Now()
	if err, exited := waitForBackgroundStartup(result, 10*time.Millisecond); err != nil || exited {
		t.Fatalf("long-running task = (%v, %v), want (nil, false)", err, exited)
	}
	if time.Since(started) < 8*time.Millisecond {
		t.Fatal("startup grace returned before its deadline")
	}
}

func TestViewerInputPayloadRequiresExplicitConfirmedEOF(t *testing.T) {
	if got := viewerInputPayload([]byte{protocol.Input, 'o', 'k'}); string(got) != "ok" {
		t.Fatalf("regular viewer input = %q, want ok", got)
	}
	if got := viewerInputPayload([]byte{protocol.ConfirmedEOF}); len(got) != 1 || got[0] != 4 {
		t.Fatalf("confirmed EOF = %v, want [4]", got)
	}
	for _, frame := range [][]byte{{protocol.Input}, {protocol.Input, 4}, {protocol.ConfirmedEOF, 4}, {4}} {
		if got := viewerInputPayload(frame); len(got) != 0 {
			t.Fatalf("invalid frame %v produced input %v", frame, got)
		}
	}
}

func TestBuildSendPayload(t *testing.T) {
	if got := buildSendPayload([]byte("hello"), false); string(got) != "hello" {
		t.Fatalf("buildSendPayload(no enter) = %q, want hello", got)
	}
	if got := buildSendPayload([]byte("hello"), true); string(got) != "hello\r" {
		t.Fatalf("buildSendPayload(enter) = %q, want hello\\r", got)
	}
}

func TestSendResult(t *testing.T) {
	if got := sendResult(5, 5, nil); got != protocol.SendResultDelivered {
		t.Fatalf("sendResult(full) = %d, want delivered", got)
	}
	if got := sendResult(3, 5, nil); got != protocol.SendResultUncertain {
		t.Fatalf("sendResult(partial) = %d, want uncertain", got)
	}
	if got := sendResult(0, 5, io.ErrClosedPipe); got != protocol.SendResultUncertain {
		t.Fatalf("sendResult(error) = %d, want uncertain", got)
	}
}

func testDispatchToken() []byte {
	token := make([]byte, protocol.SendDispatchTokenBytes)
	for i := range token {
		token[i] = byte(i + 1)
	}
	return token
}

// TestHandleMcpSendWritesAtomicPayloadAndResult verifies the ACTUAL PTY write (not just a
// counter): the text + optional \r reach the writer in a single write, the result code
// reflects the write outcome, and the ack carries the frame's dispatch token verbatim.
func TestHandleMcpSendWritesAtomicPayloadAndResult(t *testing.T) {
	opID := "550e8400-e29b-41d4-a716-446655440000"
	token := testDispatchToken()
	for _, tc := range []struct {
		enter bool
		want  string
	}{
		{false, "echo hi"},
		{true, "echo hi\r"},
	} {
		var buf bytes.Buffer
		var gotOp string
		var gotToken []byte
		var result byte
		acked := false
		frame := protocol.EncodeSend(opID, tc.enter, token, []byte("echo hi"))
		ok := handleMcpSend(newInputArbiter(&buf), frame, func(op string, dispatchToken []byte, code byte) {
			gotOp, gotToken, result, acked = op, append([]byte(nil), dispatchToken...), code, true
		})
		if !ok || !acked {
			t.Fatalf("handleMcpSend ok/acked = %v/%v for enter=%v", ok, acked, tc.enter)
		}
		if gotOp != opID {
			t.Fatalf("handleMcpSend op = %q, want %q", gotOp, opID)
		}
		if !bytes.Equal(gotToken, token) {
			t.Fatalf("handleMcpSend token = %x, want %x", gotToken, token)
		}
		if result != protocol.SendResultDelivered {
			t.Fatalf("handleMcpSend result = %d, want delivered", result)
		}
		if buf.String() != tc.want {
			t.Fatalf("PTY write = %q, want %q", buf.String(), tc.want)
		}
	}
	// a non-Send frame is rejected and writes nothing
	var buf bytes.Buffer
	if handleMcpSend(newInputArbiter(&buf), protocol.Frame(protocol.Input, []byte("x")), func(string, []byte, byte) {}) {
		t.Fatal("handleMcpSend accepted a non-Send frame")
	}
	if buf.Len() != 0 {
		t.Fatalf("malformed frame wrote %q", buf.String())
	}
}

// shortWriter delivers only a prefix of each write (a partial write, no error).
type shortWriter struct{ limit int }

func (s *shortWriter) Write(p []byte) (int, error) {
	n := len(p)
	if n > s.limit {
		n = s.limit
	}
	return n, nil
}

// TestHandleMcpSendPartialWriteIsUncertain verifies a partial PTY write yields uncertain (the
// complete operation was not confirmed), never delivered.
func TestHandleMcpSendPartialWriteIsUncertain(t *testing.T) {
	opID := "550e8400-e29b-41d4-a716-446655440000"
	var result byte
	acked := false
	ok := handleMcpSend(newInputArbiter(&shortWriter{limit: 3}), protocol.EncodeSend(opID, true, testDispatchToken(), []byte("hello")), func(_ string, _ []byte, code byte) {
		result, acked = code, true
	})
	if !ok || !acked {
		t.Fatal("handleMcpSend not ok")
	}
	if result != protocol.SendResultUncertain {
		t.Fatalf("partial write result = %d, want uncertain", result)
	}
}

// openTestPTY opens a real PTY pair and returns the master (the side the host writes to, as in
// production) plus a capture of everything that crosses to the slave side. The slave is put in
// raw mode (as a raw-mode TUI child would be) so host writes arrive byte-exact, without the
// line discipline canonicalizing or translating them.
func openTestPTY(t *testing.T) (ptmx *os.File, captured func() string) {
	t.Helper()
	master, tty, err := pty.Open()
	if err != nil {
		t.Fatalf("open pty: %v", err)
	}
	t.Cleanup(func() {
		_ = master.Close()
		_ = tty.Close()
	})
	if _, err := term.MakeRaw(int(tty.Fd())); err != nil {
		t.Fatalf("raw pty: %v", err)
	}
	var mu sync.Mutex
	var out []byte
	go func() {
		buffer := make([]byte, 4096)
		for {
			count, readErr := tty.Read(buffer)
			if count > 0 {
				mu.Lock()
				out = append(out, buffer[:count]...)
				mu.Unlock()
			}
			if readErr != nil {
				return
			}
		}
	}()
	return master, func() string {
		mu.Lock()
		defer mu.Unlock()
		return string(out)
	}
}

func waitForPTYCapture(t *testing.T, captured func() string, want string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if out := captured(); strings.Contains(out, want) {
			return out
		}
		if time.Now().After(deadline) {
			t.Fatalf("PTY output never contained %q (got %q)", want, captured())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestMcpSendRejectedWhileHumanIsTyping is the F3 regression on a REAL PTY: a human burst
// inside the typing window causes the MCP send to be REJECTED (ack SendResultUncertain, token
// echoed verbatim) and its bytes to NEVER appear in the PTY — not even after the human stops
// typing and a generous wait elapses. The human's own bytes do appear.
func TestMcpSendRejectedWhileHumanIsTyping(t *testing.T) {
	ptmx, captured := openTestPTY(t)
	arbiter := newInputArbiter(ptmx)
	opID := "550e8400-e29b-41d4-a716-446655440000"
	token := testDispatchToken()

	if _, err := arbiter.humanWrite([]byte("human-burst")); err != nil {
		t.Fatal(err)
	}
	var gotOp string
	var gotToken []byte
	var result byte
	acked := make(chan struct{})
	if !handleMcpSend(arbiter, protocol.EncodeSend(opID, true, token, []byte("mcp-line")), func(op string, dispatchToken []byte, code byte) {
		gotOp = op
		gotToken = append([]byte(nil), dispatchToken...)
		result = code
		close(acked)
	}) {
		t.Fatal("handleMcpSend rejected a well-formed frame")
	}
	select {
	case <-acked:
	case <-time.After(time.Second):
		t.Fatal("rejected send was not acknowledged")
	}
	if gotOp != opID {
		t.Fatalf("rejected ack op = %q, want %q", gotOp, opID)
	}
	if !bytes.Equal(gotToken, token) {
		t.Fatalf("rejected ack token = %x, want %x (host must echo verbatim)", gotToken, token)
	}
	if result != protocol.SendResultUncertain {
		t.Fatalf("rejected send result = %d, want uncertain", result)
	}

	// The human now stops typing. Wait well past the 250ms typing window (and past the old
	// 2s defer budget) — the rejected payload must still never appear.
	time.Sleep(1 * time.Second)
	out := captured()
	if !strings.Contains(out, "human-burst") {
		t.Fatalf("PTY output %q missing the human's bytes", out)
	}
	if strings.Contains(out, "mcp-line") {
		t.Fatalf("rejected MCP bytes appeared in the PTY after the human stopped typing: %q", out)
	}
}

// TestMcpSendProceedsWhenHumanIsIdle verifies the fast path: once the human is outside the
// typing window, the MCP write proceeds immediately, is reported delivered, and the ack
// carries the frame's dispatch token verbatim.
func TestMcpSendProceedsWhenHumanIsIdle(t *testing.T) {
	ptmx, captured := openTestPTY(t)
	arbiter := newInputArbiter(ptmx)
	opID := "550e8400-e29b-41d4-a716-446655440000"
	token := testDispatchToken()

	if _, err := arbiter.humanWrite([]byte("earlier")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(320 * time.Millisecond) // beyond the 250ms typing window

	acks := make(chan struct{}, 1)
	var gotToken []byte
	var result byte
	started := time.Now()
	if !handleMcpSend(arbiter, protocol.EncodeSend(opID, false, token, []byte("quiet-send")), func(_ string, dispatchToken []byte, code byte) {
		gotToken = append([]byte(nil), dispatchToken...)
		result = code
		acks <- struct{}{}
	}) {
		t.Fatal("handleMcpSend rejected a well-formed frame")
	}
	select {
	case <-acks:
	case <-time.After(time.Second):
		t.Fatal("idle send was not acknowledged")
	}
	if result != protocol.SendResultDelivered {
		t.Fatalf("idle send result = %d, want delivered", result)
	}
	if !bytes.Equal(gotToken, token) {
		t.Fatalf("idle send token = %x, want %x (host must echo verbatim)", gotToken, token)
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("idle send took %s, want immediate", elapsed)
	}
	out := waitForPTYCapture(t, captured, "quiet-send", time.Second)
	if strings.Index(out, "earlier") > strings.Index(out, "quiet-send") {
		t.Fatalf("PTY output order = %q, want earlier then quiet-send", out)
	}
}

// TestMcpSendRejectedImmediatelyWhileHumanKeepsTyping verifies the rejection is immediate (no
// defer budget, no goroutine): with a continuously typing human the MCP send is acked
// delivery_uncertain right away and nothing is written, even while typing continues.
func TestMcpSendRejectedImmediatelyWhileHumanKeepsTyping(t *testing.T) {
	ptmx, captured := openTestPTY(t)
	arbiter := newInputArbiter(ptmx)
	opID := "550e8400-e29b-41d4-a716-446655440000"

	if _, err := arbiter.humanWrite([]byte("prime")); err != nil {
		t.Fatal(err)
	}
	stopTyping := make(chan struct{})
	defer close(stopTyping)
	go func() {
		for {
			select {
			case <-stopTyping:
				return
			default:
			}
			if _, err := arbiter.humanWrite([]byte("k")); err != nil {
				return
			}
			time.Sleep(30 * time.Millisecond)
		}
	}()

	acks := make(chan byte, 1)
	started := time.Now()
	if !handleMcpSend(arbiter, protocol.EncodeSend(opID, true, testDispatchToken(), []byte("starved-send")), func(_ string, _ []byte, result byte) {
		acks <- result
	}) {
		t.Fatal("handleMcpSend rejected a well-formed frame")
	}
	select {
	case result := <-acks:
		if result != protocol.SendResultUncertain {
			t.Fatalf("rejected send result = %d, want uncertain", result)
		}
		if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
			t.Fatalf("rejection took %s, want immediate (no defer budget)", elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("rejected send was not acknowledged")
	}
	if strings.Contains(captured(), "starved-send") {
		t.Fatalf("rejected MCP write reached the PTY: %q", captured())
	}
}

// TestMcpControlDelayedIssuanceDeliversBearer is a regression test for the control-socket
// deadline alignment: a successful grant issuance that takes longer than the old 5s client
// deadline must still deliver its one-time bearer. The fake socket delays its response past the
// old deadline to prove the client waits long enough.
func TestMcpControlDelayedIssuanceDeliversBearer(t *testing.T) {
	if testing.Short() {
		t.Skip("delayed-issuance test takes several seconds")
	}
	const sessionID = "abcdefghijklmnopqrstuvwxyzABCDEF"
	const delay = 6 * time.Second
	if delay <= 5*time.Second {
		t.Fatalf("delay must exceed the old 5s client deadline to prove the fix")
	}

	directory, err := localSessionDirectory()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := localSessionSocketPath(directory, sessionID)
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	defer os.Remove(socketPath)

	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		_, _ = bufio.NewReader(connection).ReadString('\n')
		time.Sleep(delay)
		_ = json.NewEncoder(connection).Encode(localControlResponse{
			OK: true, ID: sessionID, PID: 1234, Bearer: "delayed-bearer",
		})
	}()

	start := time.Now()
	response, err := sendLocalControlMcp(sessionID, "mcp grant codex observe 0")
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("sendLocalControlMcp: %v (elapsed %s)", err, elapsed)
	}
	if response.Bearer != "delayed-bearer" {
		t.Fatalf("bearer = %q, want delayed-bearer", response.Bearer)
	}
	if elapsed < delay {
		t.Fatalf("response arrived before the delay (elapsed %s)", elapsed)
	}
}
