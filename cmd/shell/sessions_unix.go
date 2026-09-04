package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type managedLocalSession struct {
	record         localSessionRecord
	listener       net.Listener
	stop           chan struct{}
	stopOnce       sync.Once
	close          sync.Once
	terminalMu     sync.Mutex
	terminalInput  io.Writer
	terminalOutput localTerminalOutput
	onLocalInput   func()
	onAttachChange func(bool)
	attached       net.Conn
}

type localControlResponse struct {
	OK    bool   `json:"ok"`
	ID    string `json:"id,omitempty"`
	PID   int    `json:"pid,omitempty"`
	Error string `json:"error,omitempty"`
}

func startLocalSession(record localSessionRecord) (localSessionControl, error) {
	if !localSessionIDPattern.MatchString(record.ID) {
		return nil, fmt.Errorf("invalid session id")
	}
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		return nil, err
	}
	listener, err := listenLocalControl(record.ID)
	if err != nil {
		return nil, fmt.Errorf("listen on local control channel: %w", err)
	}

	session := &managedLocalSession{
		record:   record,
		listener: listener,
		stop:     make(chan struct{}),
	}
	if err := writeLocalSessionRecord(directory, record); err != nil {
		_ = listener.Close()
		cleanupLocalControl(record.ID)
		return nil, err
	}
	go session.serve()
	return session, nil
}

func (session *managedLocalSession) StopRequested() <-chan struct{} {
	return session.stop
}

func (session *managedLocalSession) BindTerminal(
	input io.Writer,
	output localTerminalOutput,
	_ func(cols, rows uint16) error,
	onInput func(),
	onAttachChange func(bool),
) {
	session.terminalMu.Lock()
	session.terminalInput = input
	session.terminalOutput = output
	session.onLocalInput = onInput
	session.onAttachChange = onAttachChange
	session.terminalMu.Unlock()
}

func (session *managedLocalSession) PublishOutput(value []byte) {
	session.terminalMu.Lock()
	defer session.terminalMu.Unlock()
	if session.terminalOutput != nil {
		_, _ = session.terminalOutput.Write(value)
	}
	if session.attached == nil {
		return
	}
	_ = session.attached.SetWriteDeadline(time.Now().Add(250 * time.Millisecond))
	if err := writeAll(session.attached, value); err != nil {
		_ = session.attached.Close()
		session.attached = nil
		return
	}
	_ = session.attached.SetWriteDeadline(time.Time{})
}

func (session *managedLocalSession) Close() error {
	var closeError error
	session.close.Do(func() {
		closeError = session.listener.Close()
		session.terminalMu.Lock()
		if session.attached != nil {
			_ = session.attached.Close()
			session.attached = nil
		}
		session.terminalMu.Unlock()
		directory, err := localSessionDirectory()
		if err == nil {
			cleanupLocalControl(session.record.ID)
			_ = os.Remove(localSessionRecordPath(directory, session.record.ID))
		}
	})
	if errors.Is(closeError, net.ErrClosed) {
		return nil
	}
	return closeError
}

func (session *managedLocalSession) serve() {
	for {
		connection, err := session.listener.Accept()
		if err != nil {
			return
		}
		go session.handleConnection(connection)
	}
}

func (session *managedLocalSession) handleConnection(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(time.Second))
	request, err := bufio.NewReader(io.LimitReader(connection, 64)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return
	}
	fields := strings.Fields(request)
	if len(fields) == 1 && fields[0] == "attach" {
		_ = connection.SetDeadline(time.Time{})
		session.handleAttach(connection)
		return
	}

	response := localControlResponse{OK: true, ID: session.record.ID, PID: session.record.PID}
	switch {
	case len(fields) == 1 && fields[0] == "ping":
	case len(fields) == 1 && fields[0] == "stop":
		session.stopOnce.Do(func() { close(session.stop) })
	case len(fields) == 3 && fields[0] == "resize":
		// Accepted for compatibility with older attach clients, but ignored.
		// The shared PTY grid is deliberately immutable.
	default:
		response.OK = false
		response.Error = "unknown command"
	}
	_ = json.NewEncoder(connection).Encode(response)
}

func (session *managedLocalSession) handleAttach(connection net.Conn) {
	session.terminalMu.Lock()
	if session.terminalInput == nil || session.terminalOutput == nil {
		_ = json.NewEncoder(connection).Encode(localControlResponse{OK: false, Error: "terminal is not ready"})
		session.terminalMu.Unlock()
		return
	}
	if session.attached != nil {
		_ = json.NewEncoder(connection).Encode(localControlResponse{OK: false, Error: "another local terminal is attached"})
		session.terminalMu.Unlock()
		return
	}

	input := session.terminalInput
	onInput := session.onLocalInput
	onAttachChange := session.onAttachChange
	snapshot := session.terminalOutput.Bytes()
	_ = connection.SetWriteDeadline(time.Now().Add(2 * time.Second))
	response := localControlResponse{OK: true, ID: session.record.ID, PID: session.record.PID}
	if err := json.NewEncoder(connection).Encode(response); err != nil {
		session.terminalMu.Unlock()
		return
	}
	if err := writeAll(connection, snapshot); err != nil {
		session.terminalMu.Unlock()
		return
	}
	session.attached = connection
	_ = connection.SetDeadline(time.Time{})
	session.terminalMu.Unlock()
	if onAttachChange != nil {
		onAttachChange(true)
	}

	buffer := make([]byte, 32*1024)
	for {
		count, readError := connection.Read(buffer)
		if count > 0 {
			if onInput != nil {
				onInput()
			}
			if err := writeAll(input, buffer[:count]); err != nil {
				break
			}
		}
		if readError != nil {
			break
		}
	}

	session.terminalMu.Lock()
	if session.attached == connection {
		session.attached = nil
	}
	session.terminalMu.Unlock()
	if onAttachChange != nil {
		onAttachChange(false)
	}
}

func writeAll(writer io.Writer, value []byte) error {
	for len(value) > 0 {
		written, err := writer.Write(value)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		value = value[written:]
	}
	return nil
}

func loadActiveLocalSessions() ([]localSessionRecord, error) {
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		return nil, err
	}
	paths, err := filepath.Glob(filepath.Join(directory, "*.json"))
	if err != nil {
		return nil, err
	}
	sessions := make([]localSessionRecord, 0, len(paths))
	for _, path := range paths {
		file, openError := os.Open(path)
		if openError != nil {
			continue
		}
		var record localSessionRecord
		decodeError := json.NewDecoder(io.LimitReader(file, 16*1024)).Decode(&record)
		_ = file.Close()
		expectedID := strings.TrimSuffix(filepath.Base(path), ".json")
		if decodeError != nil || !localSessionIDPattern.MatchString(record.ID) || record.ID != expectedID || record.PID <= 0 || record.StartedAt.IsZero() {
			_ = os.Remove(path)
			continue
		}
		response, pingError := sendLocalControl(record.ID, "ping")
		if pingError != nil || !response.OK || response.ID != record.ID || response.PID != record.PID {
			_ = os.Remove(path)
			cleanupLocalControl(record.ID)
			continue
		}
		sessions = append(sessions, record)
	}
	return sessions, nil
}

func requestLocalSessionStop(id string) error {
	if !localSessionIDPattern.MatchString(id) {
		return fmt.Errorf("invalid session id")
	}
	response, err := sendLocalControl(id, "stop")
	if err != nil {
		return err
	}
	if !response.OK {
		if response.Error == "" {
			response.Error = "request rejected"
		}
		return errors.New(response.Error)
	}
	return nil
}

func requestLocalSessionResize(id string, cols, rows int) error {
	response, err := sendLocalControl(id, fmt.Sprintf("resize %d %d", cols, rows))
	if err != nil {
		return err
	}
	if !response.OK {
		if response.Error == "" {
			response.Error = "request rejected"
		}
		return errors.New(response.Error)
	}
	return nil
}

func sendLocalControl(id, command string) (localControlResponse, error) {
	var response localControlResponse
	if !localSessionIDPattern.MatchString(id) {
		return response, fmt.Errorf("invalid session id")
	}
	connection, err := dialLocalControl(id, 300*time.Millisecond)
	if err != nil {
		return response, err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(time.Second))
	if _, err := fmt.Fprintln(connection, command); err != nil {
		return response, err
	}
	if err := json.NewDecoder(io.LimitReader(connection, 4*1024)).Decode(&response); err != nil {
		return response, err
	}
	return response, nil
}

func localSessionRecordPath(directory, id string) string {
	return filepath.Join(directory, id+".json")
}

func writeLocalSessionRecord(directory string, record localSessionRecord) error {
	temporary, err := os.CreateTemp(directory, ".session-*.json")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := json.NewEncoder(temporary).Encode(record); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := securePrivateStateFile(temporaryPath); err != nil {
		return err
	}
	path := localSessionRecordPath(directory, record.ID)
	if err := replaceFileAtomically(temporaryPath, path); err != nil {
		return err
	}
	return securePrivateStateFile(path)
}
