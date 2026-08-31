package relay

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type MessageType websocket.MessageType

const (
	TextMessage   MessageType = MessageType(websocket.MessageText)
	BinaryMessage MessageType = MessageType(websocket.MessageBinary)
)

type outgoingMessage struct {
	typeID MessageType
	data   []byte
	done   chan error
}

type incomingMessage struct {
	typeID MessageType
	data   []byte
}

// Connection maintains one logical relay connection across transient network
// failures. The process keeps running locally while disconnected; after a
// reconnect, the server asks for the terminal ring buffer to restore viewers.
type Connection struct {
	ctx          context.Context
	cancel       context.CancelFunc
	endpoint     string
	hostToken    string
	outgoing     chan outgoingMessage
	incoming     chan incomingMessage
	stateChanged chan struct{}
	done         chan struct{}
	active       atomic.Bool
	close        sync.Once
	socketMu     sync.Mutex
	socket       *websocket.Conn
}

func Dial(parent context.Context, endpoint, hostToken string) (*Connection, error) {
	ctx, cancel := context.WithCancel(parent)
	connection := &Connection{
		ctx:          ctx,
		cancel:       cancel,
		endpoint:     endpoint,
		hostToken:    hostToken,
		outgoing:     make(chan outgoingMessage, 128),
		incoming:     make(chan incomingMessage, 128),
		stateChanged: make(chan struct{}, 1),
		done:         make(chan struct{}),
	}

	firstResult := make(chan error, 1)
	go connection.run(firstResult)
	select {
	case err := <-firstResult:
		if err != nil {
			connection.Close()
			return nil, err
		}
		return connection, nil
	case <-parent.Done():
		connection.Close()
		return nil, parent.Err()
	}
}

func (connection *Connection) run(firstResult chan<- error) {
	defer close(connection.done)
	defer connection.cancel()
	firstAttempt := true
	backoff := 500 * time.Millisecond

	for {
		socket, response, err := connection.dial()
		if err != nil {
			formatted := formatDialError(response, err)
			if firstAttempt {
				firstResult <- formatted
				return
			}
			if !wait(connection.ctx, backoff) {
				return
			}
			backoff = min(backoff*2, 10*time.Second)
			continue
		}

		if firstAttempt {
			firstAttempt = false
			firstResult <- nil
		}
		backoff = 500 * time.Millisecond
		connection.setSocket(socket)
		connection.active.Store(true)
		connection.notifyStateChange()

		connection.serve(socket)
		connection.active.Store(false)
		connection.clearSocket(socket)
		connection.notifyStateChange()
		_ = socket.CloseNow()

		if !wait(connection.ctx, backoff) {
			return
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}

func (connection *Connection) dial() (*websocket.Conn, *http.Response, error) {
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+connection.hostToken)
	return websocket.Dial(connection.ctx, connection.endpoint, &websocket.DialOptions{HTTPHeader: header})
}

func (connection *Connection) serve(socket *websocket.Conn) {
	socket.SetReadLimit(1024 * 1024)
	socketContext, cancelSocket := context.WithCancel(connection.ctx)
	defer cancelSocket()

	readResult := make(chan error, 1)
	go func() {
		for {
			messageType, data, err := socket.Read(socketContext)
			if err != nil {
				readResult <- err
				return
			}
			message := incomingMessage{typeID: MessageType(messageType), data: data}
			select {
			case connection.incoming <- message:
			case <-socketContext.Done():
				return
			}
		}
	}()

	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case message := <-connection.outgoing:
			writeContext, cancelWrite := context.WithTimeout(socketContext, 10*time.Second)
			err := socket.Write(writeContext, websocket.MessageType(message.typeID), message.data)
			cancelWrite()
			if message.done != nil {
				message.done <- err
			}
			if err != nil {
				return
			}
		case <-pingTicker.C:
			pingContext, cancelPing := context.WithTimeout(socketContext, 10*time.Second)
			err := socket.Ping(pingContext)
			cancelPing()
			if err != nil {
				return
			}
		case <-readResult:
			return
		case <-socketContext.Done():
			return
		}
	}
}

// TrySend queues a frame without allowing a slow relay to block the local PTY.
func (connection *Connection) TrySend(messageType MessageType, data []byte) bool {
	message := outgoingMessage{typeID: messageType, data: append([]byte(nil), data...)}
	select {
	case connection.outgoing <- message:
		return true
	default:
		return false
	}
}

func (connection *Connection) Send(messageType MessageType, data []byte) error {
	message := outgoingMessage{typeID: messageType, data: append([]byte(nil), data...)}
	select {
	case connection.outgoing <- message:
		return nil
	case <-connection.ctx.Done():
		return connection.ctx.Err()
	}
}

func (connection *Connection) SendSync(messageType MessageType, data []byte) error {
	return connection.SendSyncContext(context.Background(), messageType, data)
}

func (connection *Connection) SendSyncContext(ctx context.Context, messageType MessageType, data []byte) error {
	result := make(chan error, 1)
	message := outgoingMessage{typeID: messageType, data: append([]byte(nil), data...), done: result}
	select {
	case connection.outgoing <- message:
	case <-connection.ctx.Done():
		return connection.ctx.Err()
	case <-ctx.Done():
		return ctx.Err()
	}

	select {
	case err := <-result:
		return err
	case <-connection.ctx.Done():
		return connection.ctx.Err()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (connection *Connection) Read() (MessageType, []byte, error) {
	select {
	case message := <-connection.incoming:
		return message.typeID, message.data, nil
	case <-connection.ctx.Done():
		return 0, nil, connection.ctx.Err()
	}
}

func (connection *Connection) Active() bool {
	return connection.active.Load()
}

func (connection *Connection) WaitActive(ctx context.Context) bool {
	for {
		if connection.Active() {
			return true
		}
		select {
		case <-connection.stateChanged:
		case <-connection.ctx.Done():
			return false
		case <-ctx.Done():
			return false
		}
	}
}

func (connection *Connection) Done() <-chan struct{} {
	return connection.ctx.Done()
}

func (connection *Connection) Close() {
	connection.close.Do(func() {
		connection.cancel()
		connection.socketMu.Lock()
		if connection.socket != nil {
			_ = connection.socket.CloseNow()
		}
		connection.socketMu.Unlock()
		<-connection.done
	})
}

func (connection *Connection) setSocket(socket *websocket.Conn) {
	connection.socketMu.Lock()
	connection.socket = socket
	connection.socketMu.Unlock()
}

func (connection *Connection) clearSocket(socket *websocket.Conn) {
	connection.socketMu.Lock()
	if connection.socket == socket {
		connection.socket = nil
	}
	connection.socketMu.Unlock()
}

func (connection *Connection) notifyStateChange() {
	select {
	case connection.stateChanged <- struct{}{}:
	default:
	}
}

func formatDialError(response *http.Response, err error) error {
	if response != nil {
		return fmt.Errorf("%s: %w", response.Status, err)
	}
	return err
}

func wait(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
