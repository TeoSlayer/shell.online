package summary

import (
	"context"
	"crypto/ecdh"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeEnclave serves /v1/identity and /v1/summarize the way the real enclave
// does: it opens the request with its private key and seals a summary to the
// recipient named inside.
type fakeEnclave struct {
	private   *ecdh.PrivateKey
	identity  Identity
	requests  atomic.Int32
	staleOnce atomic.Bool
	lastBody  atomic.Value
}

func newFakeEnclave(t *testing.T, fake *issuer, last byte) (*fakeEnclave, *httptest.Server) {
	enclave := &fakeEnclave{private: scalarKey(t, last)}
	enclave.identity = fake.identity(encode(enclave.private.PublicKey().Bytes()), nil)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/identity", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(enclave.identity)
	})
	mux.HandleFunc("POST /v1/summarize", func(w http.ResponseWriter, r *http.Request) {
		enclave.requests.Add(1)
		var body summarizeBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"bad_request"}`, http.StatusBadRequest)
			return
		}
		enclave.lastBody.Store(body)
		if enclave.staleOnce.CompareAndSwap(true, false) {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"stale_key"}`))
			return
		}
		request, err := openRequest(enclave.private, body.EnclaveKey, body.SenderPublicKey, body.Sealed)
		if err != nil {
			http.Error(w, `{"error":"bad_envelope"}`, http.StatusBadRequest)
			return
		}
		sender, sealed, err := SealSummary(request.RecipientPublicKey, request.SessionID, request.RecipientUID, request.Generation,
			Summary{Version: 1, Title: "Dev server", Summary: "Server is ready.", State: StateIdle, Source: SourceEnclave, ObservedAt: request.ObservedAt})
		if err != nil {
			http.Error(w, `{"error":"seal"}`, http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(summarizeResult{V: 1, SenderPublicKey: sender, Sealed: sealed})
	})
	server := httptest.NewTLSServer(mux)
	t.Cleanup(server.Close)
	return enclave, server
}

func TestClientSummarizesThroughAVerifiedEnclave(t *testing.T) {
	fake := newIssuer(t)
	enclave, server := newFakeEnclave(t, fake, 21)
	client, err := NewClient(server.URL, fake.verifier, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	owner := scalarKey(t, 22)
	request := sampleRequest(t)
	request.RecipientPublicKey = encode(owner.PublicKey().Bytes())
	result, err := client.Summarize(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := openSummary(owner, request.SessionID, request.RecipientUID, request.Generation, request.ObservedAt, result.SenderPublicKey, result.Sealed)
	if err != nil || opened.Source != SourceEnclave {
		t.Fatalf("owner cannot open the result: %v %+v", err, opened)
	}
	body := enclave.lastBody.Load().(summarizeBody)
	if strings.Contains(body.Sealed, "ready on port") || body.EnclaveKey != enclave.identity.PublicKey {
		t.Fatal("request was not sealed to the enclave key")
	}

	enclave.staleOnce.Store(true)
	if _, err := client.Summarize(context.Background(), request); err != nil {
		t.Fatalf("stale key was not retried: %v", err)
	}
}

func TestClientSendsNothingToAnUnverifiedEnclave(t *testing.T) {
	fake := newIssuer(t)
	enclave, server := newFakeEnclave(t, fake, 23)
	enclave.identity = fake.identity(enclave.identity.PublicKey, func(_, c map[string]any) { c["dbgstat"] = "enabled" })
	client, _ := NewClient(server.URL, fake.verifier, server.Client())
	if _, err := client.Summarize(context.Background(), sampleRequest(t)); err == nil {
		t.Fatal("debug enclave accepted")
	}
	if enclave.requests.Load() != 0 {
		t.Fatal("terminal text was sent to an unverified enclave")
	}
}

func TestClientRejectsMalformedResults(t *testing.T) {
	fake := newIssuer(t)
	enclave := scalarKey(t, 24)
	identity := fake.identity(encode(enclave.PublicKey().Bytes()), nil)
	for name, reply := range map[string]string{
		"extra field": `{"v":1,"sender_public_key":"x","sealed":"ss1.x","note":"hi"}`,
		"wrong type":  `{"v":1,"sender_public_key":"` + identity.PublicKey + `","sealed":"sc1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`,
		"version":     `{"v":2,"sender_public_key":"` + identity.PublicKey + `","sealed":"ss1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`,
	} {
		mux := http.NewServeMux()
		mux.HandleFunc("GET /v1/identity", func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(identity) })
		mux.HandleFunc("POST /v1/summarize", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(reply)) })
		server := httptest.NewTLSServer(mux)
		client, _ := NewClient(server.URL, fake.verifier, server.Client())
		if _, err := client.Summarize(context.Background(), sampleRequest(t)); err == nil {
			t.Errorf("%s: accepted", name)
		}
		server.Close()
	}
}

func TestValidateEndpoint(t *testing.T) {
	for _, ok := range []string{"https://summarizer.shell.online", "https://summarizer.shell.online/", "http://127.0.0.1:8080", "http://localhost:9", "http://[::1]:1"} {
		if _, err := ValidateEndpoint(ok); err != nil {
			t.Errorf("%s refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"http://summarizer.shell.online", "https://u:p@host", "https://host/?q=1", "https://host/#f", "ftp://host", "summarizer.shell.online", "http://10.0.0.1"} {
		if _, err := ValidateEndpoint(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}
