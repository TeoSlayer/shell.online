package account

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
)

// Team reports contain usable credentials before recipient sealing. Restrict
// these endpoints to the configured HTTPS origin and never replay on redirects.
// Explicit loopback URLs support isolated local accounts services and canaries.
func (client *Client) doMcpTeam(ctx context.Context, method, path, bearer string, body any) ([]byte, error) {
	origin, err := url.Parse(client.baseURL)
	if err != nil || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" ||
		(origin.Path != "" && origin.Path != "/") {
		return nil, errors.New("team MCP requires an accounts origin without credentials, path, query or fragment")
	}
	loopback := origin.Hostname() == "127.0.0.1" || origin.Hostname() == "::1" || origin.Hostname() == "localhost"
	if origin.Scheme != "https" && !(origin.Scheme == "http" && loopback) {
		return nil, errors.New("team MCP requires HTTPS (or an explicit loopback accounts URL)")
	}
	protected := *client
	transport := *client.http
	transport.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	protected.http = &transport
	contents, err := protected.do(ctx, method, path, bearer, body)
	if err != nil {
		// Remote response text and transport errors can echo secrets or URLs.
		var status *statusError
		if errors.As(err, &status) {
			return nil, &statusError{status: status.status, message: fmt.Sprintf("team accounts request refused (HTTP %d)", status.status)}
		}
		return nil, errors.New("team accounts request failed")
	}
	return contents, nil
}

// Team MCP grant requests, the host half of the team-connection slice.
//
// A teammate (their own account) asks for an observe-only grant on a session
// whose owner opted into team MCP. The session's own machine is the only one
// that may answer: it mints a grant through the existing host-token path and
// reports the opaque bearer back. The service is the authority on membership
// and consent; the host just does the minting and the revoking it is told to.

// McpTeamRequestStatus is the lifecycle of one request.
type McpTeamRequestStatus = string

// McpTeamHostRequest is one item in the host's work list.
type McpTeamHostRequest struct {
	RequestID    string `json:"requestId"`
	RequesterUID string `json:"requesterUid"`
	// "issue" or "revoke".
	Action string `json:"action"`
	// Set on a revoke: the grant to revoke.
	GrantID string `json:"grantId,omitempty"`
	// Set on an issue: the pending deadline, Unix milliseconds.
	ExpiresAt int64 `json:"expiresAt,omitempty"`
}

// McpTeamWorkList is the host's current work for one session.
type McpTeamWorkList struct {
	Issues      []McpTeamHostRequest `json:"issues"`
	Revocations []McpTeamHostRequest `json:"revocations"`
}

// McpTeamGrantReport is what the host reports after minting the grant.
type McpTeamGrantReport struct {
	GrantID   string `json:"grantId"`
	ExpiresAt int64  `json:"expiresAt"`
	Bearer    string `json:"bearer"`
}

// ListMcpTeamRequests asks for the session's current team work. An empty list
// is the common answer and is not an error.
func (client *Client) ListMcpTeamRequests(ctx context.Context, accessToken, sessionID string) (McpTeamWorkList, error) {
	var list McpTeamWorkList
	path := "/api/cli/sessions/" + url.PathEscape(sessionID) + "/mcp/team-requests"
	contents, err := client.doMcpTeam(ctx, http.MethodGet, path, accessToken, nil)
	if err != nil {
		return list, err
	}
	if err := json.Unmarshal(contents, &list); err != nil {
		return list, fmt.Errorf("decode team work list: %w", err)
	}
	return list, nil
}

// ReportMcpTeamGrant hands the minted grant back for one request. The service
// answers whether it stored it; a request that is no longer answerable (expired
// or revoked) is not an error the host should retry blindly.
func (client *Client) ReportMcpTeamGrant(
	ctx context.Context, accessToken, sessionID, requestID string, report McpTeamGrantReport,
) error {
	path := "/api/cli/sessions/" + url.PathEscape(sessionID) + "/mcp/team-requests/" + url.PathEscape(requestID) + "/grant"
	_, err := client.doMcpTeam(ctx, http.MethodPost, path, accessToken, report)
	return err
}

// AckMcpTeamRevocation confirms the host revoked a grant the service told it to.
func (client *Client) AckMcpTeamRevocation(
	ctx context.Context, accessToken, sessionID, requestID string,
) error {
	path := "/api/cli/sessions/" + url.PathEscape(sessionID) + "/mcp/team-requests/" + url.PathEscape(requestID) + "/revoke-ack"
	_, err := client.doMcpTeam(ctx, http.MethodPost, path, accessToken, struct{}{})
	return err
}

// McpTeamRequestResult is the answer to a teammate's request for a grant.
type McpTeamRequestResult struct {
	RequestID string `json:"requestId"`
	ExpiresAt int64  `json:"expiresAt"`
}

// RequestMcpTeamGrant asks, as a teammate, for an observe-only grant on a
// session whose owner opted into team MCP. The session's own machine answers;
// this only opens the request.
func (client *Client) RequestMcpTeamGrant(ctx context.Context, accessToken, sessionID, recipientPublicKey string) (McpTeamRequestResult, error) {
	var result McpTeamRequestResult
	path := "/api/cli/sessions/" + url.PathEscape(sessionID) + "/mcp/team"
	contents, err := client.doMcpTeam(ctx, http.MethodPost, path, accessToken, map[string]string{"recipientPublicKey": recipientPublicKey})
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(contents, &result); err != nil {
		return result, fmt.Errorf("decode team request: %w", err)
	}
	return result, nil
}

// McpTeamGrantFetch is the answer to a teammate's poll for their grant.
type McpTeamGrantFetch struct {
	// "pending" until the session's machine answers.
	Status string `json:"status"`
	// Set once issued.
	GrantID           string `json:"grantId,omitempty"`
	ExpiresAt         int64  `json:"expiresAt,omitempty"`
	SealedToRecipient bool   `json:"sealedToRecipient,omitempty"`
	// The recipient-bound encrypted credential, present exactly once.
	Bearer string `json:"bearer,omitempty"`
}

// McpTeamRecipient holds one request's private key only in client memory.
// It deliberately does not use or require an account vault private key.
type McpTeamRecipient struct {
	private *ecdh.PrivateKey
}

func NewMcpTeamRecipient() (*McpTeamRecipient, error) {
	private, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate team delivery key: %w", err)
	}
	return &McpTeamRecipient{private: private}, nil
}

func (recipient *McpTeamRecipient) PublicKey() string {
	return base64.RawURLEncoding.EncodeToString(recipient.private.PublicKey().Bytes())
}

func (recipient *McpTeamRecipient) Open(sessionID, requesterUID, requestID string, fetched McpTeamGrantFetch) (string, error) {
	if !fetched.SealedToRecipient || len(fetched.Bearer) > 16*1024 || requesterUID == "" || requestID == "" {
		return "", errors.New("team grant is not sealed to this request")
	}
	var envelope struct {
		SenderPublicKey string `json:"k"`
		Sealed          string `json:"s"`
	}
	if err := json.Unmarshal([]byte(fetched.Bearer), &envelope); err != nil {
		return "", errors.New("invalid team delivery envelope")
	}
	return openFromAccount(recipient.private, sessionID, requesterUID+"\x00mcp-team:"+requestID, envelope.SenderPublicKey, envelope.Sealed)
}

// FetchMcpTeamGrant polls for the grant a teammate requested. A 410 (revoked,
// expired, or already delivered) or 404 is returned as an error the caller can
// act on; a pending request is not an error.
func (client *Client) FetchMcpTeamGrant(ctx context.Context, accessToken, sessionID, requestID string) (McpTeamGrantFetch, error) {
	var result McpTeamGrantFetch
	path := "/api/cli/sessions/" + url.PathEscape(sessionID) + "/mcp/team/" + url.PathEscape(requestID)
	contents, err := client.doMcpTeam(ctx, http.MethodGet, path, accessToken, nil)
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(contents, &result); err != nil {
		return result, fmt.Errorf("decode team grant: %w", err)
	}
	return result, nil
}
