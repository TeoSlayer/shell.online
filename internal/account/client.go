package account

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client talks to the shell.online accounts service.
type Client struct {
	baseURL   string
	userAgent string
	http      *http.Client
}

// NewClient returns a client for the accounts service at baseURL.
func NewClient(baseURL, userAgent string) *Client {
	return &Client{
		baseURL:   strings.TrimRight(baseURL, "/"),
		userAgent: userAgent,
		http:      &http.Client{Timeout: 15 * time.Second},
	}
}

// BaseURL is the accounts service this client targets.
func (client *Client) BaseURL() string { return client.baseURL }

// Account identifies the signed-in person.
type Account struct {
	UID   string `json:"uid"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

type tokenResponse struct {
	AccessToken  string  `json:"access_token"`
	RefreshToken string  `json:"refresh_token"`
	ExpiresIn    int64   `json:"expires_in"`
	Account      Account `json:"account"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// maxErrorBytes caps how much of a failing body is read into an error message.
const maxErrorBytes = 4 << 10

func (client *Client) do(ctx context.Context, method, path, bearer string, body any) ([]byte, error) {
	if _, err := url.ParseRequestURI(client.baseURL); err != nil {
		return nil, fmt.Errorf("invalid accounts URL %q", client.baseURL)
	}

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(ctx, method, client.baseURL+path, reader)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	request.Header.Set("User-Agent", client.userAgent)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}

	response, err := client.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("contact accounts service: %w", err)
	}
	defer response.Body.Close()

	contents, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		var failure errorResponse
		if json.Unmarshal(contents, &failure) == nil && failure.Error != "" {
			return nil, fmt.Errorf("accounts service: %s", failure.Error)
		}
		snippet := contents
		if len(snippet) > maxErrorBytes {
			snippet = snippet[:maxErrorBytes]
		}
		return nil, fmt.Errorf("accounts service returned %d: %s",
			response.StatusCode, strings.TrimSpace(string(snippet)))
	}
	return contents, nil
}

// Exchange trades a one-time authorization code for scoped CLI tokens.
func (client *Client) Exchange(
	ctx context.Context, code, verifier, redirectURI, label string,
) (Credentials, error) {
	contents, err := client.do(ctx, http.MethodPost, "/api/cli/token", "", map[string]string{
		"code":          code,
		"code_verifier": verifier,
		"redirect_uri":  redirectURI,
		"label":         label,
	})
	if err != nil {
		return Credentials{}, err
	}
	var decoded tokenResponse
	if err := json.Unmarshal(contents, &decoded); err != nil {
		return Credentials{}, fmt.Errorf("decode token response: %w", err)
	}
	if decoded.AccessToken == "" || decoded.RefreshToken == "" {
		return Credentials{}, fmt.Errorf("accounts service returned no tokens")
	}
	return Credentials{
		Server:       client.baseURL,
		AccessToken:  decoded.AccessToken,
		RefreshToken: decoded.RefreshToken,
		ExpiresAt:    time.Now().Add(time.Duration(decoded.ExpiresIn) * time.Second),
		UID:          decoded.Account.UID,
		Email:        decoded.Account.Email,
		Name:         decoded.Account.Name,
	}, nil
}

// Refresh renews the access token, keeping the same refresh token.
func (client *Client) Refresh(ctx context.Context, credentials Credentials) (Credentials, error) {
	contents, err := client.do(ctx, http.MethodPost, "/api/cli/refresh", "", map[string]string{
		"refresh_token": credentials.RefreshToken,
	})
	if err != nil {
		return credentials, err
	}
	var decoded tokenResponse
	if err := json.Unmarshal(contents, &decoded); err != nil {
		return credentials, fmt.Errorf("decode refresh response: %w", err)
	}
	if decoded.AccessToken == "" {
		return credentials, fmt.Errorf("accounts service returned no access token")
	}
	refreshed := credentials
	refreshed.AccessToken = decoded.AccessToken
	refreshed.ExpiresAt = time.Now().Add(time.Duration(decoded.ExpiresIn) * time.Second)
	if decoded.Account.UID != "" {
		refreshed.UID = decoded.Account.UID
		refreshed.Email = decoded.Account.Email
		refreshed.Name = decoded.Account.Name
	}
	return refreshed, nil
}

// Revoke invalidates the refresh token and every access token derived from it.
func (client *Client) Revoke(ctx context.Context, credentials Credentials) error {
	_, err := client.do(ctx, http.MethodPost, "/api/cli/revoke", "", map[string]string{
		"refresh_token": credentials.RefreshToken,
	})
	return err
}

// SessionInput is the metadata the CLI publishes when a session starts.
type SessionInput struct {
	ID         string `json:"id"`
	ShareURL   string `json:"share_url"`
	Command    string `json:"command"`
	ReadOnly   bool   `json:"read_only"`
	Encrypted  bool   `json:"encrypted"`
	Persistent bool   `json:"persistent"`
	Host       string `json:"host"`
	StartedAt  int64  `json:"started_at"`
}

// RegisterSession publishes a session so it appears in the account.
//
// The share URL is deliberately sent without its fragment: the E2EE key lives
// in the fragment, and the accounts service has no business holding it.
func (client *Client) RegisterSession(
	ctx context.Context, accessToken string, input SessionInput,
) error {
	input.ShareURL = stripFragment(input.ShareURL)
	_, err := client.do(ctx, http.MethodPost, "/api/sessions", accessToken, input)
	return err
}

// CloseSession marks a session finished.
func (client *Client) CloseSession(
	ctx context.Context, accessToken, id string, exitCode *int,
) error {
	body := map[string]any{}
	if exitCode != nil {
		body["exit_code"] = *exitCode
	}
	_, err := client.do(ctx, http.MethodPatch, "/api/sessions/"+url.PathEscape(id), accessToken, body)
	return err
}

func stripFragment(shareURL string) string {
	if index := strings.IndexByte(shareURL, '#'); index >= 0 {
		return shareURL[:index]
	}
	return shareURL
}
