package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"shell.online/internal/e2ee"
)

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)

type Session struct {
	ID           string       `json:"session_id"`
	ShareURL     string       `json:"share_url"`
	WebSocketURL string       `json:"websocket_url"`
	HostToken    string       `json:"host_token"`
	ReadOnly     bool         `json:"read_only"`
	Encrypted    bool         `json:"encrypted"`
	Persistent   bool         `json:"persistent"`
	ExpiresAt    time.Time    `json:"expires_at"`
	Cipher       *e2ee.Cipher `json:"-"`
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
		http:      &http.Client{Timeout: 15 * time.Second},
	}
}

func (client *Client) CreateSession(ctx context.Context, label string, readOnly, encrypted, persistent bool) (Session, error) {
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
	}{Label: label, ReadOnly: readOnly, Encrypted: encrypted, Persistent: persistent})
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

	if err := json.NewDecoder(io.LimitReader(response.Body, 16*1024)).Decode(&session); err != nil {
		return session, fmt.Errorf("decode session: %w", err)
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
