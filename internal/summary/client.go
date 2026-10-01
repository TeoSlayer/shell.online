package summary

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// DefaultEndpoint is the hosted summarizer.
const DefaultEndpoint = "https://summarizer.shell.online"

const (
	maxIdentityBody = 64 << 10
	maxResultBody   = 16 << 10
	// refreshMargin re-verifies an enclave before its token lapses mid-request.
	refreshMargin = 2 * time.Minute
)

// ErrStaleKey is returned when the enclave restarted with a new key twice in
// a row; the caller should simply try again later.
var ErrStaleKey = errors.New("summarizer: enclave key changed")

// Result is an ss1. envelope sealed inside the enclave to the owner's vault.
// The host cannot open it and uploads it unchanged.
type Result struct {
	SenderPublicKey string
	Sealed          string
}

// Client talks to one summarizer endpoint. It never logs request or response
// content, and it sends nothing until the enclave's attestation verifies.
type Client struct {
	endpoint *url.URL
	http     *http.Client
	verifier *Verifier

	mu      sync.Mutex
	current *VerifiedEnclave
}

// ValidateEndpoint accepts HTTPS URLs, and plain HTTP only to a loopback
// address (local testing). Credentials, queries and fragments are refused.
func ValidateEndpoint(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("summarizer URL must be an absolute URL without credentials, query or fragment")
	}
	switch parsed.Scheme {
	case "https":
		return parsed, nil
	case "http":
		host := parsed.Hostname()
		if host == "localhost" {
			return parsed, nil
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			return parsed, nil
		}
	}
	return nil, errors.New("summarizer URL must use HTTPS")
}

// NewClient returns a client for endpoint using verifier for attestation.
func NewClient(endpoint string, verifier *Verifier, httpClient *http.Client) (*Client, error) {
	parsed, err := ValidateEndpoint(endpoint)
	if err != nil {
		return nil, err
	}
	if verifier == nil {
		return nil, errors.New("summarizer: no attestation verifier")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 45 * time.Second}
	}
	// Never follow a redirect off the verified origin.
	guarded := *httpClient
	guarded.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{endpoint: parsed, http: &guarded, verifier: verifier}, nil
}

// Summarize seals request to a freshly verified enclave key and returns the
// enclave's sealed summary. request.Tail must already be PrepareTail output.
func (client *Client) Summarize(ctx context.Context, request Request) (Result, error) {
	for attempt := 0; attempt < 2; attempt++ {
		enclave, err := client.enclave(ctx)
		if err != nil {
			return Result{}, err
		}
		result, stale, err := client.post(ctx, enclave, request)
		if stale {
			client.forget(enclave)
			continue
		}
		return result, err
	}
	return Result{}, ErrStaleKey
}

func (client *Client) enclave(ctx context.Context) (*VerifiedEnclave, error) {
	client.mu.Lock()
	current := client.current
	client.mu.Unlock()
	if current != nil && client.verifier.now().Add(refreshMargin).Before(current.ExpiresAt) {
		return current, nil
	}
	var identity Identity
	if err := client.getJSON(ctx, "/v1/identity", maxIdentityBody, &identity); err != nil {
		return nil, fmt.Errorf("summarizer identity: %w", err)
	}
	verified, err := client.verifier.Verify(ctx, identity)
	if err != nil {
		return nil, err
	}
	client.mu.Lock()
	client.current = verified
	client.mu.Unlock()
	return verified, nil
}

func (client *Client) forget(enclave *VerifiedEnclave) {
	client.mu.Lock()
	if client.current == enclave {
		client.current = nil
	}
	client.mu.Unlock()
}

type summarizeBody struct {
	V               int    `json:"v"`
	EnclaveKey      string `json:"enclave_key"`
	SenderPublicKey string `json:"sender_public_key"`
	Sealed          string `json:"sealed"`
}

type summarizeResult struct {
	V               int    `json:"v"`
	SenderPublicKey string `json:"sender_public_key"`
	Sealed          string `json:"sealed"`
}

func (client *Client) post(ctx context.Context, enclave *VerifiedEnclave, request Request) (Result, bool, error) {
	sender, sealed, err := SealRequest(enclave.PublicKey, request)
	if err != nil {
		return Result{}, false, err
	}
	body, err := json.Marshal(summarizeBody{V: 1, EnclaveKey: enclave.PublicKey, SenderPublicKey: sender, Sealed: sealed})
	if err != nil {
		return Result{}, false, err
	}
	if len(body) > MaxRequestBody {
		return Result{}, false, errors.New("summarizer: request too large")
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, client.endpoint.String()+"/v1/summarize", bytes.NewReader(body))
	if err != nil {
		return Result{}, false, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "application/json")
	response, err := client.http.Do(httpRequest)
	if err != nil {
		return Result{}, false, fmt.Errorf("summarizer: %w", err)
	}
	defer response.Body.Close()
	contents, err := io.ReadAll(io.LimitReader(response.Body, maxResultBody+1))
	if err != nil {
		return Result{}, false, fmt.Errorf("summarizer: read: %w", err)
	}
	if len(contents) > maxResultBody {
		return Result{}, false, errors.New("summarizer: response too large")
	}
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(contents, &failure)
		if response.StatusCode == http.StatusConflict && failure.Error == "stale_key" {
			return Result{}, true, nil
		}
		// Only a short, known-safe code is surfaced; the body is never echoed.
		code := failure.Error
		if len(code) > 40 || strings.IndexFunc(code, func(r rune) bool { return !(r == '_' || (r >= 'a' && r <= 'z')) }) >= 0 {
			code = ""
		}
		return Result{}, false, fmt.Errorf("summarizer: status %d %s", response.StatusCode, code)
	}
	var decoded summarizeResult
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil || decoder.More() || decoded.V != 1 {
		return Result{}, false, errors.New("summarizer: malformed response")
	}
	if !ValidSealedSummary(decoded.SenderPublicKey, decoded.Sealed) {
		return Result{}, false, errors.New("summarizer: malformed sealed summary")
	}
	return Result{SenderPublicKey: decoded.SenderPublicKey, Sealed: decoded.Sealed}, false, nil
}

func (client *Client) getJSON(ctx context.Context, path string, limit int64, into any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, client.endpoint.String()+path, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return err
	}
	if int64(len(body)) > limit {
		return errors.New("response too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	return decoder.Decode(into)
}
