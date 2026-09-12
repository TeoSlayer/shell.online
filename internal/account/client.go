package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

// statusError is a failing answer from the service. It keeps the status so a
// caller can tell "there is nothing here" from "something went wrong"; its
// message is exactly what callers have always seen.
type statusError struct {
	status  int
	message string
}

func (failure *statusError) Error() string { return failure.message }

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
			return nil, &statusError{status: response.StatusCode, message: "accounts service: " + failure.Error}
		}
		snippet := contents
		if len(snippet) > maxErrorBytes {
			snippet = snippet[:maxErrorBytes]
		}
		return nil, &statusError{
			status: response.StatusCode,
			message: fmt.Sprintf("accounts service returned %d: %s",
				response.StatusCode, strings.TrimSpace(string(snippet))),
		}
	}
	return contents, nil
}

// Exchange trades a one-time authorization code for scoped CLI tokens.
//
// machineID names the machine this login is happening on, so the service can
// recognise one it has already linked instead of recording another. An empty
// one is left out of the request: a machine that cannot identify itself gets
// the older behaviour of a fresh device per login rather than a rejection.
func (client *Client) Exchange(
	ctx context.Context, code, verifier, redirectURI, label, machineID string,
) (Credentials, error) {
	body := map[string]string{
		"code":          code,
		"code_verifier": verifier,
		"redirect_uri":  redirectURI,
		"label":         label,
	}
	if machineID != "" {
		body["machine_id"] = machineID
	}
	contents, err := client.do(ctx, http.MethodPost, "/api/cli/token", "", body)
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
	ID       string `json:"id"`
	ShareURL string `json:"share_url"`
	Command  string `json:"command"`
	Name     string `json:"name,omitempty"`
	// Origin ties a session back to the request that started it, so the
	// browser that chose the password can recognise its own session.
	Origin     string `json:"origin,omitempty"`
	ReadOnly   bool   `json:"read_only"`
	Encrypted  bool   `json:"encrypted"`
	Persistent bool   `json:"persistent"`
	Host       string `json:"host"`
	StartedAt  int64  `json:"started_at"`
	// CredentialRotation tells the account registry to replace every old
	// sealed copy atomically. The new owner copy remains opaque to it.
	CredentialRotation bool `json:"credential_rotation,omitempty"`
	// OwnerShare is the session password sealed to the account's vault key,
	// so any of the person's browsers can open the session later. Absent when
	// the session has no password or the account has no vault.
	OwnerShare *KeyShare `json:"owner_share,omitempty"`
}

// KeyShare is a session password sealed to one account key. The accounts
// service stores it and cannot open it.
type KeyShare struct {
	SenderPublicKey string `json:"sender_public_key"`
	Sealed          string `json:"sealed"`
}

// AccountKey asks for the account's vault public key.
//
// ok is false, with no error, when the account has no vault yet: that is the
// state of every account until its owner sets one up in the browser, and not
// something to warn about. A key that does not parse is an error rather than
// a missing vault, so a broken answer is not mistaken for an absent one.
func (client *Client) AccountKey(ctx context.Context, accessToken string) (key string, ok bool, err error) {
	contents, err := client.do(ctx, http.MethodGet, "/api/account/key", accessToken, nil)
	var failure *statusError
	if errors.As(err, &failure) && failure.status == http.StatusNotFound {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	var decoded struct {
		PublicKey string `json:"public_key"`
	}
	if err := json.Unmarshal(contents, &decoded); err != nil {
		return "", false, fmt.Errorf("decode account key: %w", err)
	}
	if err := ParseAccountKey(decoded.PublicKey); err != nil {
		return "", false, fmt.Errorf("the accounts service returned an unusable key: %w", err)
	}
	return decoded.PublicKey, true, nil
}

// RegisterSession publishes a session so it appears in the account.
func (client *Client) RegisterSession(
	ctx context.Context, accessToken string, input SessionInput,
) error {
	input.ShareURL = SafeShareURL(input.ShareURL)
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

// saltFragmentPrefix marks the one fragment form that is safe to publish.
const saltFragmentPrefix = "#salt="

// SafeShareURL returns the share URL with any fragment the accounts service
// must not hold removed.
//
// E2EE produces two fragment forms. "#salt=" carries a PBKDF2 salt, which is
// not a secret: the eight-character browser password is, and it is never sent
// here. "#key=" carries the raw AES key, so publishing it would hand the
// service everything it needs to decrypt the terminal.
//
// The check is an allowlist rather than a blocklist. A fragment form added
// later must be reviewed before it can be published, instead of leaking by
// default.
func SafeShareURL(shareURL string) string {
	index := strings.IndexByte(shareURL, '#')
	if index < 0 {
		return shareURL
	}
	if strings.HasPrefix(shareURL[index:], saltFragmentPrefix) {
		return shareURL
	}
	return shareURL[:index]
}

// AgentCommand is work the web app has queued for this machine.
type AgentCommand struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Command   string `json:"command,omitempty"`
	Name      string `json:"name,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	// SenderPublicKey and SealedPassword carry a browser password sealed to
	// this agent's key. The accounts service relays them without being able
	// to read the password inside.
	SenderPublicKey string `json:"senderPublicKey,omitempty"`
	SealedPassword  string `json:"sealedPassword,omitempty"`
}

// PollCommands claims everything queued for this machine, publishing the key
// a browser should seal a password to and the agent harnesses installed here.
//
// Claiming happens server-side in the same step as the read, so two agents on
// one machine cannot both run the same command.
//
// harnesses rides along on the poll rather than getting an endpoint of its
// own: it is only useful while a machine is reachable, which is exactly the
// window in which it is polling. It is joined with commas because this request
// goes out every two seconds and the ids are short and few.
func (client *Client) PollCommands(
	ctx context.Context, accessToken, agentPublicKey string, harnesses []string,
) ([]AgentCommand, error) {
	path := "/api/agent/commands"
	query := url.Values{}
	if agentPublicKey != "" {
		query.Set("key", agentPublicKey)
	}
	if harnesses != nil {
		// An empty value still says "this machine reported, and has none of
		// them", which the browser must not read as "not known yet".
		query.Set("harnesses", strings.Join(harnesses, ","))
	}
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	contents, err := client.do(ctx, http.MethodGet, path, accessToken, nil)
	if err != nil {
		return nil, err
	}
	var decoded struct {
		Commands []AgentCommand `json:"commands"`
	}
	if err := json.Unmarshal(contents, &decoded); err != nil {
		return nil, fmt.Errorf("decode commands: %w", err)
	}
	return decoded.Commands, nil
}

// FinishCommand reports a command as done, with an error when it failed.
func (client *Client) FinishCommand(
	ctx context.Context, accessToken, id string, failure error,
) error {
	body := map[string]string{}
	if failure != nil {
		body["error"] = failure.Error()
	}
	_, err := client.do(ctx, http.MethodPost, "/api/agent/commands/"+url.PathEscape(id), accessToken, body)
	return err
}
