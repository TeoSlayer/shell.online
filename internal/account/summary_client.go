package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
)

// SessionSummaryPolicy is whether, and from when, this machine may publish a
// summary for one of its sessions. Consent lives on the session record; the
// service rotates Generation whenever consent, ownership or the owner's vault
// key changes, which invalidates every earlier envelope.
type SessionSummaryPolicy struct {
	Enabled       bool   `json:"enabled"`
	Generation    string `json:"generation"`
	OwnerUID      string `json:"ownerUid"`
	NextPublishAt int64  `json:"nextPublishAt"`
}

// SessionSummaryUpload is one sealed ss1. envelope. The service stores it as
// opaque ciphertext; only the owner's browser can open it.
type SessionSummaryUpload struct {
	Generation      string `json:"generation"`
	ObservedAt      int64  `json:"observedAt"`
	SenderPublicKey string `json:"senderPublicKey"`
	Sealed          string `json:"sealed"`
}

// SummaryTicket is the short-lived signed permission the summarizer enclave
// checks offline before it will summarize for this session.
type SummaryTicket struct {
	Ticket     string `json:"ticket"`
	Generation string `json:"generation"`
	OwnerUID   string `json:"ownerUid"`
}

func (client *Client) SessionSummaryPolicy(ctx context.Context, bearer, id string) (SessionSummaryPolicy, error) {
	var policy SessionSummaryPolicy
	data, err := client.do(ctx, http.MethodGet, "/api/cli/sessions/"+url.PathEscape(id)+"/summary-policy", bearer, nil)
	if err != nil {
		return policy, err
	}
	err = json.Unmarshal(data, &policy)
	return policy, err
}

func (client *Client) PublishSessionSummary(ctx context.Context, bearer, id string, upload SessionSummaryUpload) error {
	_, err := client.do(ctx, http.MethodPut, "/api/cli/sessions/"+url.PathEscape(id)+"/summary", bearer, upload)
	return err
}

func (client *Client) RequestSummaryTicket(ctx context.Context, bearer, id string) (SummaryTicket, error) {
	var ticket SummaryTicket
	data, err := client.do(ctx, http.MethodPost, "/api/cli/sessions/"+url.PathEscape(id)+"/summary-ticket", bearer, map[string]any{})
	if err != nil {
		return ticket, err
	}
	if err := json.Unmarshal(data, &ticket); err != nil {
		return ticket, err
	}
	if ticket.Ticket == "" || ticket.Generation == "" || ticket.OwnerUID == "" {
		return ticket, errors.New("summary ticket is incomplete")
	}
	return ticket, nil
}
