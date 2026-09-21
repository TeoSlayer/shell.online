package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"shell.online/internal/e2ee"
)

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)

type Session struct {
	ID           string `json:"session_id"`
	ShareURL     string `json:"share_url"`
	WebSocketURL string `json:"websocket_url"`
	HostToken    string `json:"host_token"`
	ReadOnly     bool   `json:"read_only"`
	Encrypted    bool   `json:"encrypted"`
	Persistent   bool   `json:"persistent"`
	// Control is a host capability: true means this host understands the shell_send control
	// protocol (Send/SendAck frames). Older hosts omit it and remain observe-only.
	Control   bool         `json:"control"`
	ExpiresAt time.Time    `json:"expires_at"`
	Cipher    *e2ee.Cipher `json:"-"`
}

type Client struct {
	baseURL   string
	userAgent string
	http      *http.Client
}

func NewClient(baseURL, userAgent string) *Client {
	return &Client{
		baseURL:   baseURL,
		userAgent: userAgent,
		http: &http.Client{
			Timeout:       15 * time.Second,
			CheckRedirect: rejectInsecureRedirect,
		},
	}
}

// isLoopbackHost reports whether hostname is a loopback address. Loopback is the explicit
// development allowance that permits plain-HTTP MCP grant issuance (no raw frame key crosses
// a network).
func isLoopbackHost(hostname string) bool {
	return hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1"
}

// requireSecureBase refuses MCP grant issuance over plain HTTP unless the server is loopback.
// The grant body carries the raw E2EE frame key, so it must not cross a network in the clear.
func requireSecureBase(baseURL *url.URL) error {
	if baseURL.Scheme == "https" {
		return nil
	}
	if baseURL.Scheme == "http" && isLoopbackHost(baseURL.Hostname()) {
		return nil
	}
	return fmt.Errorf("mcp grant issuance requires https (got %s://%s)", baseURL.Scheme, baseURL.Hostname())
}

// rejectInsecureRedirect applies the secure-destination rule to every redirect: the destination
// must be HTTPS or loopback. This stops a redirect from moving a key-bearing body (MCP grant
// issuance) off TLS — including from an allowed http://localhost endpoint to a remote http://
// host, where a 307/308 would replay the frame key over plain HTTP.
func rejectInsecureRedirect(req *http.Request, via []*http.Request) error {
	if len(via) == 0 {
		return nil
	}
	if req.URL.Scheme == "http" && !isLoopbackHost(req.URL.Hostname()) {
		return fmt.Errorf("redirect to insecure destination: %s", req.URL)
	}
	return nil
}

func (client *Client) CreateSession(ctx context.Context, label string, readOnly, encrypted, persistent, control bool) (Session, error) {
	var session Session
	baseURL, err := url.ParseRequestURI(client.baseURL)
	if err != nil {
		return session, fmt.Errorf("invalid server URL: %w", err)
	}
	if (baseURL.Scheme != "http" && baseURL.Scheme != "https") || baseURL.Host == "" {
		return session, fmt.Errorf("invalid server URL")
	}

	body, err := json.Marshal(struct {
		Label      string `json:"label"`
		ReadOnly   bool   `json:"read_only"`
		Encrypted  bool   `json:"encrypted"`
		Persistent bool   `json:"persistent"`
		Control    bool   `json:"control"`
	}{Label: label, ReadOnly: readOnly, Encrypted: encrypted, Persistent: persistent, Control: control})
	if err != nil {
		return session, err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/api/sessions", bytes.NewReader(body))
	if err != nil {
		return session, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", client.userAgent)

	response, err := client.http.Do(request)
	if err != nil {
		return session, fmt.Errorf("create session: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusCreated {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4_096))
		var apiError struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(message, &apiError) == nil && apiError.Error != "" {
			return session, fmt.Errorf("create session: %s", apiError.Error)
		}
		return session, fmt.Errorf("create session: server returned %s", response.Status)
	}

	// Control is decoded as a pointer so an older server that does not know the field
	// (omitted, not false) is distinguishable from a server that answers explicitly.
	var wire struct {
		ID           string    `json:"session_id"`
		ShareURL     string    `json:"share_url"`
		WebSocketURL string    `json:"websocket_url"`
		HostToken    string    `json:"host_token"`
		ReadOnly     bool      `json:"read_only"`
		Encrypted    bool      `json:"encrypted"`
		Persistent   bool      `json:"persistent"`
		Control      *bool     `json:"control"`
		ExpiresAt    time.Time `json:"expires_at"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16*1024)).Decode(&wire); err != nil {
		return session, fmt.Errorf("decode session: %w", err)
	}
	session = Session{
		ID:           wire.ID,
		ShareURL:     wire.ShareURL,
		WebSocketURL: wire.WebSocketURL,
		HostToken:    wire.HostToken,
		ReadOnly:     wire.ReadOnly,
		Encrypted:    wire.Encrypted,
		Persistent:   wire.Persistent,
		ExpiresAt:    wire.ExpiresAt,
	}
	if !sessionIDPattern.MatchString(session.ID) || session.HostToken == "" || session.ExpiresAt.IsZero() {
		return Session{}, fmt.Errorf("create session: incomplete server response")
	}
	if session.ReadOnly != readOnly {
		return Session{}, fmt.Errorf("create session: server returned the wrong access mode")
	}
	if session.Encrypted != encrypted {
		return Session{}, fmt.Errorf("create session: server returned the wrong encryption mode")
	}
	if session.Persistent != persistent {
		return Session{}, fmt.Errorf("create session: server returned the wrong persistence mode")
	}
	// Control is negotiated asymmetrically for mixed-version compatibility: a server that
	// omits the field (older server) or reports false can only offer LESS capability than
	// requested, so the client degrades to observe-only instead of rejecting the session.
	// Only the impossible mismatch — the server claiming a control capability the client did
	// not request — is rejected.
	if wire.Control != nil && *wire.Control {
		if !control {
			return Session{}, fmt.Errorf("create session: server returned the wrong control capability")
		}
		session.Control = true
	}

	// Session sockets and share pages are deliberately same-origin. Deriving these
	// URLs also keeps `wrangler dev` usable when a production custom domain exists.
	baseURL.Path = ""
	baseURL.RawPath = ""
	baseURL.RawQuery = ""
	baseURL.Fragment = ""
	session.ShareURL = baseURL.JoinPath("s", session.ID).String()
	websocketURL := *baseURL
	if websocketURL.Scheme == "https" {
		websocketURL.Scheme = "wss"
	} else {
		websocketURL.Scheme = "ws"
	}
	websocketURL.Path = "/api/sessions/" + session.ID + "/ws"
	session.WebSocketURL = websocketURL.String()
	return session, nil
}

func (client *Client) ResumeSession(ctx context.Context, label string, seed Session) (Session, error) {
	baseURL, err := url.ParseRequestURI(client.baseURL)
	if err != nil || (baseURL.Scheme != "http" && baseURL.Scheme != "https") || baseURL.Host == "" {
		return Session{}, fmt.Errorf("invalid server URL")
	}
	body, _ := json.Marshal(struct {
		ID        string `json:"session_id"`
		HostToken string `json:"host_token"`
		Label     string `json:"label"`
		ReadOnly  bool   `json:"read_only"`
		Encrypted bool   `json:"encrypted"`
	}{seed.ID, seed.HostToken, label, seed.ReadOnly, seed.Encrypted})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/api/sessions/resume", bytes.NewReader(body))
	if err != nil {
		return Session{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", client.userAgent)
	response, err := client.http.Do(request)
	if err != nil {
		return Session{}, fmt.Errorf("resume session: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4_096))
		var apiError struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(message, &apiError) == nil && apiError.Error != "" {
			return Session{}, fmt.Errorf("resume session: %s", apiError.Error)
		}
		return Session{}, fmt.Errorf("resume session: server returned %s", response.Status)
	}
	var session Session
	if err := json.NewDecoder(io.LimitReader(response.Body, 16*1024)).Decode(&session); err != nil {
		return Session{}, fmt.Errorf("decode session: %w", err)
	}
	if session.ID != seed.ID || session.HostToken != seed.HostToken || !session.Persistent || session.ReadOnly != seed.ReadOnly || session.Encrypted != seed.Encrypted {
		return Session{}, fmt.Errorf("resume session: server returned mismatched credentials")
	}
	baseURL.Path, baseURL.RawPath, baseURL.RawQuery, baseURL.Fragment = "", "", "", ""
	session.ShareURL = baseURL.JoinPath("s", session.ID).String()
	websocketURL := *baseURL
	if websocketURL.Scheme == "https" {
		websocketURL.Scheme = "wss"
	} else {
		websocketURL.Scheme = "ws"
	}
	websocketURL.Path = "/api/sessions/" + session.ID + "/ws"
	session.WebSocketURL = websocketURL.String()
	return session, nil
}

// McpGrant is the non-secret metadata for a live MCP grant (never the bearer itself).
type McpGrant struct {
	GrantID   string    `json:"grant_id"`
	Label     string    `json:"label"`
	Scopes    []string  `json:"scopes"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	Revoked   bool      `json:"revoked"`
	Live      bool      `json:"live"`
}

// McpGrantCreated is the one-time creation response. Bearer is shown exactly once.
type McpGrantCreated struct {
	GrantID   string    `json:"grant_id"`
	Bearer    string    `json:"bearer"`
	ExpiresAt time.Time `json:"expires_at"`
}

func (client *Client) mcpRequest(ctx context.Context, session Session, method string, path []string, body []byte) (*http.Response, error) {
	baseURL, err := url.ParseRequestURI(client.baseURL)
	if err != nil {
		return nil, fmt.Errorf("invalid server URL: %w", err)
	}
	// The grant body can carry the raw E2EE frame key, so issuance must not cross a network in
	// the clear. Refuse non-HTTPS servers except an explicit loopback development allowance.
	if err := requireSecureBase(baseURL); err != nil {
		return nil, err
	}
	segments := append([]string{"/api/sessions", session.ID}, path...)
	requestURL := *baseURL
	requestURL.Path = strings.Join(segments, "/")
	request, err := http.NewRequestWithContext(ctx, method, requestURL.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", client.userAgent)
	request.Header.Set("Authorization", "Bearer "+session.HostToken)
	return client.http.Do(request)
}

func mcpAPIError(response *http.Response, context string) error {
	message, _ := io.ReadAll(io.LimitReader(response.Body, 4_096))
	var apiError struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(message, &apiError) == nil && apiError.Error != "" {
		return fmt.Errorf("%s: %s", context, apiError.Error)
	}
	return fmt.Errorf("%s: server returned %s", context, response.Status)
}

// CreateMcpGrant requests issuance of a short-lived, run-bound MCP bearer. The host supplies
// the raw E2EE frame key (or nil for --no-e2ee); the DO mints and returns the opaque bearer.
//
// teamRequesterUID marks the grant as minted for a teammate rather than the owner. When set, the
// DO re-authorizes every use of the grant against the accounts service, live and fail-closed; the
// owner's own grants (empty) never take that path.
func (client *Client) CreateMcpGrant(ctx context.Context, session Session, label string, scopes []string, lifetimeSec int, frameKey []byte, teamRequesterUID string) (McpGrantCreated, error) {
	var result McpGrantCreated
	frameKeyB64 := encodeFrameKey(frameKey)
	payload, err := json.Marshal(struct {
		Label    string   `json:"label"`
		Scopes   []string `json:"scopes"`
		Lifetime *int     `json:"lifetime,omitempty"`
		FrameKey string   `json:"frame_key,omitempty"`
		Team     *struct {
			RequesterUID string `json:"requester_uid"`
		} `json:"team,omitempty"`
	}{
		Label:    label,
		Scopes:   scopes,
		Lifetime: optionalInt(lifetimeSec),
		FrameKey: frameKeyB64,
		Team:     optionalTeam(teamRequesterUID),
	})
	if err != nil {
		return result, err
	}
	response, err := client.mcpRequest(ctx, session, http.MethodPost, []string{"mcp", "grant"}, payload)
	if err != nil {
		return result, fmt.Errorf("create mcp grant: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		return result, mcpAPIError(response, "create mcp grant")
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16*1024)).Decode(&result); err != nil {
		return result, fmt.Errorf("decode mcp grant: %w", err)
	}
	if result.Bearer == "" {
		return result, fmt.Errorf("create mcp grant: server returned no bearer")
	}
	return result, nil
}

func (client *Client) ListMcpGrants(ctx context.Context, session Session) ([]McpGrant, error) {
	response, err := client.mcpRequest(ctx, session, http.MethodGet, []string{"mcp", "grants"}, nil)
	if err != nil {
		return nil, fmt.Errorf("list mcp grants: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, mcpAPIError(response, "list mcp grants")
	}
	var result struct {
		Grants []McpGrant `json:"grants"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode mcp grants: %w", err)
	}
	return result.Grants, nil
}

func (client *Client) RevokeMcpGrant(ctx context.Context, session Session, grantID string) error {
	payload, _ := json.Marshal(struct {
		GrantID string `json:"grant_id"`
	}{GrantID: grantID})
	response, err := client.mcpRequest(ctx, session, http.MethodDelete, []string{"mcp", "grant"}, payload)
	if err != nil {
		return fmt.Errorf("revoke mcp grant: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return mcpAPIError(response, "revoke mcp grant")
	}
	return nil
}

func (client *Client) RevokeAllMcpGrants(ctx context.Context, session Session) error {
	response, err := client.mcpRequest(ctx, session, http.MethodDelete, []string{"mcp", "grants"}, nil)
	if err != nil {
		return fmt.Errorf("revoke all mcp grants: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return mcpAPIError(response, "revoke all mcp grants")
	}
	return nil
}

func optionalInt(value int) *int {
	if value <= 0 {
		return nil
	}
	return &value
}

// optionalTeam builds the grant's team marker, or nil for the owner's own grant.
func optionalTeam(requesterUID string) *struct {
	RequesterUID string `json:"requester_uid"`
} {
	if requesterUID == "" {
		return nil
	}
	return &struct {
		RequesterUID string `json:"requester_uid"`
	}{RequesterUID: requesterUID}
}

func encodeFrameKey(frameKey []byte) string {
	if len(frameKey) == 0 {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(frameKey)
}
