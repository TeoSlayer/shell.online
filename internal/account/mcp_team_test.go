package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestMcpTeamReportNeverReplaysBearerOnRedirect(t *testing.T) {
	var reached atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true) }))
	defer destination.Close()
	for _, code := range []int{http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, destination.URL, code)
		}))
		client := NewClient(redirect.URL, "test")
		err := client.ReportMcpTeamGrant(context.Background(), "synthetic-token", "session", "request", McpTeamGrantReport{Bearer: "synthetic-bearer"})
		redirect.Close()
		if err == nil || reached.Load() {
			t.Fatal("team report followed a redirect")
		}
	}
}

func TestMcpTeamRefusesInsecureRemoteOrigins(t *testing.T) {
	for _, origin := range []string{"http://accounts.example", "https://user:pass@accounts.example", "https://accounts.example/path", "https://accounts.example/?x=1", "https://accounts.example/#fragment"} {
		client := NewClient(origin, "test")
		if _, err := client.ListMcpTeamRequests(context.Background(), "synthetic-token", "session"); err == nil {
			t.Fatal("accepted an insecure or ambiguous accounts origin")
		}
	}
}

func TestMcpTeamRecipientBindsKeySessionAccountAndRequest(t *testing.T) {
	recipient, err := NewMcpTeamRecipient()
	if err != nil {
		t.Fatal(err)
	}
	other, err := NewMcpTeamRecipient()
	if err != nil {
		t.Fatal(err)
	}
	key, sealed, err := SealToAccount(recipient.PublicKey(), "session-1", "uid-2\x00mcp-team:request-1", "synthetic-bearer")
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(map[string]string{"k": key, "s": sealed})
	if err != nil {
		t.Fatal(err)
	}
	fetched := McpTeamGrantFetch{Status: "issued", SealedToRecipient: true, Bearer: string(envelope)}
	got, err := recipient.Open("session-1", "uid-2", "request-1", fetched)
	if err != nil || got != "synthetic-bearer" {
		t.Fatal("requester could not recover its credential")
	}
	for _, test := range []struct {
		recipient             *McpTeamRecipient
		session, uid, request string
	}{
		{other, "session-1", "uid-2", "request-1"},
		{recipient, "session-2", "uid-2", "request-1"},
		{recipient, "session-1", "uid-3", "request-1"},
		{recipient, "session-1", "uid-2", "request-2"},
	} {
		if _, err := test.recipient.Open(test.session, test.uid, test.request, fetched); err == nil {
			t.Fatal("accepted a delivery with the wrong recipient or context")
		}
	}
	fetched.SealedToRecipient = false
	if _, err := recipient.Open("session-1", "uid-2", "request-1", fetched); err == nil {
		t.Fatal("accepted an unprotected bearer")
	}
}
