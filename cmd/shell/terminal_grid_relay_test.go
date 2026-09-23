package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"shell.online/internal/relay"
)

type lockedResizer struct {
	mu    sync.Mutex
	calls []terminalGrid
}

func (resizer *lockedResizer) Resize(cols, rows int) error {
	resizer.mu.Lock()
	defer resizer.mu.Unlock()
	resizer.calls = append(resizer.calls, terminalGrid{Cols: uint16(cols), Rows: uint16(rows)})
	return nil
}

func (resizer *lockedResizer) snapshot() []terminalGrid {
	resizer.mu.Lock()
	defer resizer.mu.Unlock()
	return append([]terminalGrid(nil), resizer.calls...)
}

// The relay's control messages reach the grid controller: a writer's
// grid_request within the local terminal, a legacy relay's terminal_size as
// an instruction (also within it), and a dynamic relay's echo of this host's
// grid not at all.
func TestReadRelayRoutesGridMessagesToTheController(t *testing.T) {
	relaySide := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		relaySide <- socket
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connection, err := relay.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), "token")
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	peer := <-relaySide
	defer peer.CloseNow()

	process := &lockedResizer{}
	grid := newGridController(terminalGrid{Cols: 120, Rows: 36}, true, process, nil, nil)
	exitAcknowledged := make(chan struct{}, 1)
	rotationAcknowledged := make(chan struct{}, 1)
	var supportsRotation atomic.Bool
	go func() {
		_ = readRelay(connection, grid, nil, nil, newSessionCipher(nil), false,
			exitAcknowledged, rotationAcknowledged, &supportsRotation, nil, nil)
	}()

	for _, message := range []string{
		`{"type":"grid_request","cols":45,"rows":30,"viewerId":2}`,
		`{"type":"grid_request","cols":45,"rows":30,"viewerId":2}`,
		`{"type":"grid_request","cols":900,"rows":30,"viewerId":2}`,
		`{"type":"terminal_size","cols":120,"rows":36,"dynamic":true,"credentialRotation":true}`,
		`{"type":"grid_request","cols":300,"rows":90,"viewerId":3}`,
		`{"type":"terminal_size","cols":80,"rows":40,"credentialRotation":true}`,
	} {
		if err := peer.Write(ctx, websocket.MessageText, []byte(message)); err != nil {
			t.Fatal(err)
		}
	}

	want := []terminalGrid{{Cols: 45, Rows: 30}, {Cols: 120, Rows: 36}, {Cols: 80, Rows: 36}}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(process.snapshot()) < len(want) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	got := process.snapshot()
	if len(got) != len(want) {
		t.Fatalf("resizes = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("resizes = %v, want %v", got, want)
		}
	}
	if !supportsRotation.Load() {
		t.Fatal("credential rotation support was not negotiated from terminal_size")
	}
}

// A relay that knows the host owns its grid never sends it terminal_size, so
// live password rotation is offered in relay_features instead. It must turn
// rotation on without touching the grid.
func TestReadRelayNegotiatesRotationFromRelayFeatures(t *testing.T) {
	relaySide := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		relaySide <- socket
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connection, err := relay.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), "token")
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	peer := <-relaySide
	defer peer.CloseNow()

	process := &lockedResizer{}
	grid := newGridController(terminalGrid{Cols: 120, Rows: 36}, true, process, nil, nil)
	var supportsRotation atomic.Bool
	go func() {
		_ = readRelay(connection, grid, nil, nil, newSessionCipher(nil), false,
			make(chan struct{}, 1), make(chan struct{}, 1), &supportsRotation, nil, nil)
	}()
	if err := peer.Write(ctx, websocket.MessageText, []byte(`{"type":"relay_features","credentialRotation":true}`)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !supportsRotation.Load() {
		time.Sleep(10 * time.Millisecond)
	}
	if !supportsRotation.Load() {
		t.Fatal("relay_features did not turn on credential rotation")
	}
	if got := process.snapshot(); len(got) != 0 {
		t.Fatalf("relay_features resized the terminal: %v", got)
	}
}

// Over a real socket: a relay that only speaks the old protocol is never sent
// terminal_grid (it would close the host), and one that says it takes grids
// gets the current grid at once.
func TestHostSendsItsGridOnlyToARelayThatTakesGrids(t *testing.T) {
	relaySide := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		relaySide <- socket
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connection, err := relay.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), "token")
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	peer := <-relaySide
	defer peer.CloseNow()

	grid := newGridController(terminalGrid{Cols: 132, Rows: 43}, true, &lockedResizer{}, nil, func(next terminalGrid) {
		_ = connection.Send(relay.TextMessage, terminalGridMessage(next))
	})
	var supportsRotation atomic.Bool
	go func() {
		_ = readRelay(connection, grid, nil, nil, newSessionCipher(nil), false,
			make(chan struct{}, 1), make(chan struct{}, 1), &supportsRotation, nil, nil)
	}()

	// An old relay's own grid choice: applied, and nothing sent back about it.
	if err := peer.Write(ctx, websocket.MessageText, []byte(`{"type":"terminal_size","cols":120,"rows":36,"credentialRotation":true}`)); err != nil {
		t.Fatal(err)
	}
	quiet, stop := context.WithTimeout(ctx, 300*time.Millisecond)
	_, data, readErr := peer.Read(quiet)
	stop()
	if readErr == nil {
		t.Fatalf("host sent %q to a relay that never said it takes grids", data)
	}
	if got := grid.Current(); got != (terminalGrid{Cols: 120, Rows: 36}) {
		t.Fatalf("grid = %v, want the old relay's 120x36", got)
	}
}

func TestHostSendsItsGridOnceTheRelaySaysItTakesOne(t *testing.T) {
	relaySide := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		relaySide <- socket
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connection, err := relay.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), "token")
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	peer := <-relaySide
	defer peer.CloseNow()

	grid := newGridController(terminalGrid{Cols: 132, Rows: 43}, true, &lockedResizer{}, nil, func(next terminalGrid) {
		_ = connection.Send(relay.TextMessage, terminalGridMessage(next))
	})
	var supportsRotation atomic.Bool
	go func() {
		_ = readRelay(connection, grid, nil, nil, newSessionCipher(nil), false,
			make(chan struct{}, 1), make(chan struct{}, 1), &supportsRotation, nil, nil)
	}()
	if err := peer.Write(ctx, websocket.MessageText, []byte(`{"type":"relay_features","terminalGrid":true,"credentialRotation":true}`)); err != nil {
		t.Fatal(err)
	}
	_, data, err := peer.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"type":"terminal_grid","cols":132,"rows":43}` {
		t.Fatalf("host sent %q, want its grid", data)
	}
	if !supportsRotation.Load() {
		t.Fatal("relay_features did not turn on credential rotation")
	}
}
