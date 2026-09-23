package relay

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Every socket, including one made by a reconnect, opens with the greeting
// ahead of anything queued, and says the host owns its grid.
func TestGreetingOpensEveryReconnectedSocket(t *testing.T) {
	sockets := make(chan *websocket.Conn, 4)
	var badHeader atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		// The fixed sizes stay for relays that choose a grid; "dynamic" is for
		// relays that let the host own it (shared/terminal-grid.ts).
		if request.Header.Get("X-Shell-Terminal-Grid") != "80x40,160x48,dynamic" {
			badHeader.Store(true)
		}
		socket, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		sockets <- socket
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	connection, err := Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), "token")
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	first := <-sockets

	var grid atomic.Value
	grid.Store("80x24")
	connection.SetGreeting(func() []byte { return []byte(grid.Load().(string)) })
	grid.Store("132x43")

	// Drop the first socket; the connection redials.
	_ = first.CloseNow()
	second := <-sockets
	defer second.CloseNow()
	if err := connection.Send(TextMessage, []byte("queued")); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"132x43", "queued"} {
		kind, data, err := second.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if kind != websocket.MessageText || string(data) != want {
			t.Fatalf("frame = %v %q, want text %q", kind, data, want)
		}
	}
	if badHeader.Load() {
		t.Fatal("a dial did not send X-Shell-Terminal-Grid: 80x40,160x48,dynamic")
	}
}
