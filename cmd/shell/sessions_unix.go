package main

import (
	"bufio"
	"context"
	"encoding/base64"
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
	"unicode"

	"shell.online/internal/api"
	"shell.online/internal/e2ee"
)

type managedLocalSession struct {
	record         localSessionRecord
	listener       net.Listener
	stop           chan struct{}
	stopOnce       sync.Once
	close          sync.Once
	terminalMu     sync.Mutex
	rotationMu     sync.Mutex
	terminalInput  io.Writer
	terminalOutput localTerminalOutput
	onLocalInput   func()
	onAttachChange func(bool)
	onRotate       func(string) (string, error)
	attached       net.Conn
	mcpGrant       func(label string, scopes []string, ttl int) (api.McpGrantCreated, error)
	// mcpTeamGrant mints a grant for a teammate (requesterUID marks it), so the DO
	// re-authorizes every use against the accounts service, live.
	mcpTeamGrant func(label string, scopes []string, ttl int, requesterUID string) (api.McpGrantCreated, error)
	mcpList      func() ([]api.McpGrant, error)
	mcpRevoke    func(grantID string) error
	mcpRevokeAll func() error
	mcpFrameKey  func() []byte
}

// SetMcpHandlers wires the MCP grant control plane (host token + api client + E2EE key are
// captured by the caller; the session record itself never stores them).
func (session *managedLocalSession) SetMcpHandlers(
	grant func(label string, scopes []string, ttl int) (api.McpGrantCreated, error),
	list func() ([]api.McpGrant, error),
	revoke func(grantID string) error,
	revokeAll func() error,
) {
	session.mcpGrant = grant
	session.mcpList = list
	session.mcpRevoke = revoke
	session.mcpRevokeAll = revokeAll
}

// SetMcpTeamGrant wires the team-grant closure: mint an observe-only grant for a teammate,
// marked so the DO re-authorizes every use against the accounts service.
func (session *managedLocalSession) SetMcpTeamGrant(grant func(label string, scopes []string, ttl int, requesterUID string) (api.McpGrantCreated, error)) {
	session.mcpTeamGrant = grant
}

type localControlResponse struct {
	Bearer   string         `json:"bearer,omitempty"`
	Grants   []api.McpGrant `json:"grants,omitempty"`
	OK       bool           `json:"ok"`
	ID       string         `json:"id,omitempty"`
	PID      int            `json:"pid,omitempty"`
	ShareURL string         `json:"share_url,omitempty"`
	Password string         `json:"password,omitempty"`
	Error    string         `json:"error,omitempty"`
}

func (session *managedLocalSession) BindPasswordRotation(rotate func(string) (string, error)) {
	session.terminalMu.Lock()
	session.onRotate = rotate
	session.terminalMu.Unlock()
}

func (session *managedLocalSession) UpdateCredentials(shareURL, password string) error {
	session.terminalMu.Lock()
	defer session.terminalMu.Unlock()
	previousURL, previousPassword := session.record.ShareURL, session.record.Password
	session.record.ShareURL, session.record.Password = shareURL, password
	directory, err := localSessionDirectory()
	if err == nil {
		err = writeLocalSessionRecord(directory, session.record)
	}
	if err != nil {
		session.record.ShareURL, session.record.Password = previousURL, previousPassword
	}
	return err
}

func startLocalSession(record localSessionRecord) (localSessionControl, error) {
	if !localSessionIDPattern.MatchString(record.ID) {
		return nil, fmt.Errorf("invalid session id")
	}
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		return nil, err
	}
	if response, pingError := sendLocalControl(record.ID, "ping"); pingError == nil && response.OK {
		return nil, fmt.Errorf(
			"session is already running locally (pid %d); stop it with shell kill %s",
			response.PID,
			shortSessionID(record.ID),
		)
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

// wireMcpControl captures the host token, api client, and raw E2EE key into the live session's
// MCP closures. The session record itself never stores these secrets.
func wireMcpControl(control localSessionControl, client *api.Client, session api.Session, ctx context.Context) {
	unixSession, ok := control.(*managedLocalSession)
	if !ok {
		return
	}
	unixSession.SetMcpHandlers(
		func(label string, scopes []string, ttl int) (api.McpGrantCreated, error) {
			// Serialize issuance with password rotation. Never mint a new grant with a stale key.
			unixSession.rotationMu.Lock()
			defer unixSession.rotationMu.Unlock()
			unixSession.terminalMu.Lock()
			provider := unixSession.mcpFrameKey
			unixSession.terminalMu.Unlock()
			key := session.Cipher.Key()
			if provider != nil {
				key = provider()
			}
			return client.CreateMcpGrant(ctx, session, label, scopes, ttl, key, "")
		},
		func() ([]api.McpGrant, error) {
			return client.ListMcpGrants(ctx, session)
		},
		func(grantID string) error {
			return client.RevokeMcpGrant(ctx, session, grantID)
		},
		func() error {
			return client.RevokeAllMcpGrants(ctx, session)
		},
	)
	unixSession.SetMcpTeamGrant(func(label string, scopes []string, ttl int, requesterUID string) (api.McpGrantCreated, error) {
		// Same serialization as an owner grant: never mint with a stale frame key.
		unixSession.rotationMu.Lock()
		defer unixSession.rotationMu.Unlock()
		unixSession.terminalMu.Lock()
		provider := unixSession.mcpFrameKey
		unixSession.terminalMu.Unlock()
		key := session.Cipher.Key()
		if provider != nil {
			key = provider()
		}
		return client.CreateMcpGrant(ctx, session, label, scopes, ttl, key, requesterUID)
	})
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
	request, err := bufio.NewReader(io.LimitReader(connection, 2048)).ReadString('\n')
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
	case len(fields) == 2 && fields[0] == "rotate":
		encoded, decodeErr := base64.RawURLEncoding.DecodeString(fields[1])
		if decodeErr != nil || e2ee.ValidateBrowserPassword(string(encoded)) != nil {
			response.OK = false
			response.Error = "invalid password"
			break
		}
		session.terminalMu.Lock()
		rotate := session.onRotate
		session.terminalMu.Unlock()
		if rotate == nil {
			response.OK = false
			response.Error = "password rotation is not ready"
			break
		}
		session.rotationMu.Lock()
		shareURL, rotateErr := rotate(string(encoded))
		session.rotationMu.Unlock()
		if rotateErr != nil {
			response.OK = false
			response.Error = rotateErr.Error()
			break
		}
		response.ShareURL = shareURL
		response.Password = string(encoded)
	case len(fields) >= 2 && fields[0] == "mcp":
		session.handleMcp(connection, fields[1:], response)
		return
	default:
		response.OK = false
		response.Error = "unknown command"
	}
	_ = json.NewEncoder(connection).Encode(response)
}

// mcpControlDeadline bounds a local MCP control operation. Grant issuance performs a remote HTTP
// call (up to the client's 15s timeout); the connection deadline must outlive it, or a slow but
// successful issuance would persist the grant yet fail to deliver its one-time bearer.
const mcpControlDeadline = 20 * time.Second

// handleMcp dispatches the MCP grant control plane over the local socket. The response may carry
// a one-time bearer (up to 8 KiB) or non-secret grant metadata.
func (session *managedLocalSession) handleMcp(connection net.Conn, args []string, base localControlResponse) {
	response := base
	// The connection inherited a 1s read deadline from handleConnection; extend it so a slow
	// grant issuance can still write its one-time bearer back to the operator.
	_ = connection.SetDeadline(time.Now().Add(mcpControlDeadline))
	switch {
	case len(args) == 1 && args[0] == "list":
		if session.mcpList == nil {
			response.OK = false
			response.Error = "mcp control is not available"
			break
		}
		grants, err := session.mcpList()
		if err != nil {
			response.OK = false
			response.Error = err.Error()
			break
		}
		response.Grants = grants
	case len(args) > 0 && (args[0] == "grant" || args[0] == "grant-v2"):
		request, err := parseMcpGrantCommand(args)
		if err != nil {
			response.OK = false
			response.Error = err.Error()
			break
		}
		if session.mcpGrant == nil {
			response.OK = false
			response.Error = "mcp control is not available"
			break
		}
		created, err := session.mcpGrant(request.Label, mcpGrantScopes(request.Scopes), request.TTL)
		if err != nil {
			response.OK = false
			response.Error = err.Error()
			break
		}
		response.Bearer = created.Bearer
	case len(args) == 2 && args[0] == "revoke":
		if session.mcpRevoke == nil {
			response.OK = false
			response.Error = "mcp control is not available"
			break
		}
		if err := session.mcpRevoke(args[1]); err != nil {
			response.OK = false
			response.Error = err.Error()
		}
	case len(args) == 1 && args[0] == "revoke-all":
		if session.mcpRevokeAll == nil {
			response.OK = false
			response.Error = "mcp control is not available"
			break
		}
		if err := session.mcpRevokeAll(); err != nil {
			response.OK = false
			response.Error = err.Error()
		}
	default:
		response.OK = false
		response.Error = "unknown mcp command"
	}
	if err := json.NewEncoder(connection).Encode(response); err != nil && response.Bearer != "" {
		// The grant was issued (and persisted server-side) but its one-time bearer could not be
		// delivered. It is never re-sent; the operator recovers via `mcp list` / `mcp revoke-all`.
		fmt.Fprintf(os.Stderr, "shell: mcp grant issued but bearer delivery failed: %v\n", err)
	}
}

// Presets are CLI conveniences; the API validates concrete scope sets.
func mcpGrantScopes(value string) []string {
	switch value {
	case "control":
		return []string{"observe", "input"}
	case "controlInterrupt":
		return []string{"observe", "input", "interrupt"}
	default:
		return strings.Split(value, ",")
	}
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
	snapshot := session.terminalOutput.Snapshot()
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

// abandonedRecordTTL is how long a note about an unreported session is kept.
//
// The note only exists to tell the accounts service about an end it never
// heard about. Past a day the service has worked that out for itself -- the
// relay has long since expired the session -- so a machine that stays signed
// out does not collect files forever.
const abandonedRecordTTL = 24 * time.Hour

func loadActiveLocalSessions() ([]localSessionRecord, error) {
	sessions, _, err := scanLocalSessions()
	return sessions, err
}

// abandonedLocalSessions returns the sessions this machine started and never
// got to report the end of.
func abandonedLocalSessions() ([]localSessionRecord, error) {
	_, abandoned, err := scanLocalSessions()
	return abandoned, err
}

// scanLocalSessions reads the session records this machine keeps and sorts
// them into the ones still running and the ones whose process has gone.
//
// A record whose control socket does not answer is not deleted on the spot any
// more. The process is gone, but whether anybody was told is a separate
// question: a session that exits normally closes itself in the accounts
// service, and one that dies with its machine -- a reboot, a power cut -- never
// does. Deleting the record here threw away the only local evidence that the
// session had ever existed, and the browser was left showing it as something
// you could still type into. So the record is kept, dated, and cleared once
// the service has been told.
func scanLocalSessions() (active, abandoned []localSessionRecord, err error) {
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		return nil, nil, err
	}
	paths, err := filepath.Glob(filepath.Join(directory, "*.json"))
	if err != nil {
		return nil, nil, err
	}
	active = make([]localSessionRecord, 0, len(paths))
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
		if record.AbandonedAt != nil {
			if time.Since(*record.AbandonedAt) >= abandonedRecordTTL {
				_ = os.Remove(path)
				continue
			}
			abandoned = append(abandoned, record)
			continue
		}
		response, pingError := sendLocalControl(record.ID, "ping")
		if pingError != nil || !response.OK || response.ID != record.ID || response.PID != record.PID {
			cleanupLocalControl(record.ID)
			noticed := time.Now().UTC()
			record.AbandonedAt = &noticed
			/*
			 * Closing the session needs its id and nothing else. The browser
			 * password would still open the relay's copy for as long as it is
			 * retained, so a record that outlives its process does not keep it.
			 */
			record.Password = ""
			if writeError := writeLocalSessionRecord(directory, record); writeError != nil {
				/* Nowhere to leave the note: the old behaviour is still better than a stale record. */
				_ = os.Remove(path)
				continue
			}
			abandoned = append(abandoned, record)
			continue
		}
		active = append(active, record)
	}
	return active, abandoned, nil
}

// forgetLocalSession drops the record for a session whose end has been
// reported, so it is not reported again.
func forgetLocalSession(id string) {
	if !localSessionIDPattern.MatchString(id) {
		return
	}
	directory, err := ensureLocalSessionDirectory()
	if err != nil {
		return
	}
	_ = os.Remove(localSessionRecordPath(directory, id))
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
	return sendLocalControlWithLimit(id, command, 4*1024, 5*time.Second)
}

// mcpControlClientDeadline must outlive the server's mcpControlDeadline, or a slow-but-successful
// issuance (up to the server's 20s) would complete server-side yet the client would give up before
// receiving its one-time bearer.
const mcpControlClientDeadline = 25 * time.Second

// sendLocalControlMcp reads a larger response (a one-time bearer can be up to 8 KiB) and waits
// long enough for a remote grant issuance.
func sendLocalControlMcp(id, command string) (localControlResponse, error) {
	return sendLocalControlWithLimit(id, command, 16*1024, mcpControlClientDeadline)
}

func sendLocalControlWithLimit(id, command string, responseLimit int64, deadline time.Duration) (localControlResponse, error) {
	var response localControlResponse
	if !localSessionIDPattern.MatchString(id) {
		return response, fmt.Errorf("invalid session id")
	}
	connection, err := dialLocalControl(id, 300*time.Millisecond)
	if err != nil {
		return response, err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(deadline))
	if _, err := fmt.Fprintln(connection, command); err != nil {
		return response, err
	}
	if err := json.NewDecoder(io.LimitReader(connection, responseLimit)).Decode(&response); err != nil {
		return response, err
	}
	return response, nil
}

func runSessionMcp(arguments []string, stdout, stderr io.Writer) int {
	if len(arguments) < 2 {
		fmt.Fprintln(stderr, "Usage:")
		fmt.Fprintln(stderr, "  shell mcp grant <session-id> <label> <scopes> [ttl-seconds]")
		fmt.Fprintln(stderr, "  shell mcp list <session-id>")
		fmt.Fprintln(stderr, "  shell mcp revoke <session-id> <grant-id>")
		fmt.Fprintln(stderr, "  shell mcp revoke-all <session-id>")
		fmt.Fprintln(stderr, "  shell mcp team <session-id>")
		return 2
	}
	action := arguments[0]
	if action == "team" {
		return runSessionMcpTeam(arguments[1:], stdout, stderr)
	}
	var grantCommand string
	switch action {
	case "grant":
		if len(arguments) != 4 && len(arguments) != 5 {
			fmt.Fprintln(stderr, "Usage: shell mcp grant <session-id> <label> <scopes> [ttl-seconds]")
			return 2
		}
		request := mcpGrantRequest{Label: arguments[2], Scopes: arguments[3]}
		if len(arguments) == 5 {
			var err error
			request.TTL, err = parseMcpGrantTTL(arguments[4])
			if err != nil {
				fmt.Fprintf(stderr, "shell: %v\n", err)
				return 2
			}
		}
		var err error
		grantCommand, err = encodeMcpGrantCommand(request)
		if err != nil {
			fmt.Fprintf(stderr, "shell: %v\n", err)
			return 2
		}
	case "list", "revoke-all":
		if len(arguments) != 2 {
			fmt.Fprintf(stderr, "Usage: shell mcp %s <session-id>\n", action)
			return 2
		}
	case "revoke":
		if len(arguments) != 3 || arguments[2] == "" || strings.IndexFunc(arguments[2], func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
			fmt.Fprintln(stderr, "Usage: shell mcp revoke <session-id> <grant-id>")
			return 2
		}
	default:
		fmt.Fprintf(stderr, "shell: unknown mcp action %q\n", action)
		return 2
	}
	record, err := findLocalSession(arguments[1])
	sessionID := record.ID
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	switch action {
	case "grant":
		response, err := sendLocalControlMcp(sessionID, grantCommand)
		if err != nil {
			fmt.Fprintf(stderr, "shell: mcp grant: %v\n", err)
			return 1
		}
		if !response.OK {
			if response.Error == "unknown mcp command" {
				fmt.Fprintln(stderr, "shell: host does not support safe MCP grant requests; update and restart this session's shell host")
				return 1
			}
			fmt.Fprintf(stderr, "shell: mcp grant: %s\n", response.Error)
			return 1
		}
		fmt.Fprintln(stdout, response.Bearer)
		return 0
	case "list":
		response, err := sendLocalControlMcp(sessionID, "mcp list")
		if err != nil {
			fmt.Fprintf(stderr, "shell: mcp list: %v\n", err)
			return 1
		}
		if !response.OK {
			fmt.Fprintf(stderr, "shell: mcp list: %s\n", response.Error)
			return 1
		}
		if len(response.Grants) == 0 {
			fmt.Fprintln(stdout, "No MCP grants.")
			return 0
		}
		for _, grant := range response.Grants {
			status := "live"
			if grant.Revoked {
				status = "revoked"
			} else if !grant.Live {
				status = "expired"
			}
			fmt.Fprintf(stdout, "%s  %s  %s  %s  %s\n",
				grant.GrantID, status, strings.Join(grant.Scopes, ","), grant.Label, grant.ExpiresAt.Format(time.RFC3339))
		}
		return 0
	case "revoke":
		if len(arguments) < 3 {
			fmt.Fprintln(stderr, "Usage: shell mcp revoke <session-id> <grant-id>")
			return 2
		}
		response, err := sendLocalControlMcp(sessionID, "mcp revoke "+arguments[2])
		if err != nil {
			fmt.Fprintf(stderr, "shell: mcp revoke: %v\n", err)
			return 1
		}
		if !response.OK {
			fmt.Fprintf(stderr, "shell: mcp revoke: %s\n", response.Error)
			return 1
		}
		fmt.Fprintf(stdout, "Revoked %s\n", arguments[2])
		return 0
	case "revoke-all":
		response, err := sendLocalControlMcp(sessionID, "mcp revoke-all")
		if err != nil {
			fmt.Fprintf(stderr, "shell: mcp revoke-all: %v\n", err)
			return 1
		}
		if !response.OK {
			fmt.Fprintf(stderr, "shell: mcp revoke-all: %s\n", response.Error)
			return 1
		}
		fmt.Fprintln(stdout, "Revoked all MCP grants.")
		return 0
	default:
		fmt.Fprintf(stderr, "shell: unknown mcp action %q\n", action)
		return 2
	}
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
