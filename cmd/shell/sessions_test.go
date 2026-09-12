package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestListedSessionJSONKeepsPasswordButNotPrivateStatePath(t *testing.T) {
	encoded, err := json.Marshal(listedSession{localSessionRecord: localSessionRecord{
		ID:              "abcdefghijklmnopqrstuvwxyzABCDEF",
		Password:        "secret-password",
		PersistentState: "/private/state.json",
	}})
	if err != nil {
		t.Fatal(err)
	}
	got := string(encoded)
	if !strings.Contains(got, `"e2ee_password":"secret-password"`) {
		t.Fatalf("JSON omitted the explicitly requested password: %s", got)
	}
	if strings.Contains(got, "persistent_state") || strings.Contains(got, "/private/state.json") {
		t.Fatalf("JSON exposed the owner-only persistent state path: %s", got)
	}
}

func TestCompactSessionListKeepsEveryRecoveryAction(t *testing.T) {
	now := time.Date(2026, time.September, 11, 12, 0, 0, 0, time.UTC)
	closesAt := now.Add(5 * time.Minute)
	record := localSessionRecord{
		ID:         "abcdefghijklmnopqrstuvwxyzABCDEF",
		ShareURL:   "https://shell.online/s/abcdefghijklmnopqrstuvwxyzABCDEF#salt=public",
		ReadOnly:   true,
		Encrypted:  true,
		Persistent: true,
		Password:   "Ab3dE7-_",
		Command:    "python train.py --epochs 100",
		StartedAt:  now.Add(-2*time.Hour - 14*time.Minute),
		ClosesAt:   &closesAt,
	}
	var output bytes.Buffer
	printCompactSessionList(
		&output,
		[]localSessionRecord{record},
		map[string]relaySessionStatus{record.ID: relayStatusConnected},
		now,
	)

	for _, expected := range []string{
		"abcdefghij  python train.py --epochs 100",
		"online · 2h14m · view only · E2EE · stable link",
		"Closes    in 5m, or when the task exits",
		"Link      " + record.ShareURL,
		"Password  stored · shell password abcdefghij",
		"Rejoin    shell attach abcdefghij",
		"Stop      shell kill abcdefghij",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Errorf("compact session card does not contain %q\n%s", expected, output.String())
		}
	}
}

func TestCompactDuration(t *testing.T) {
	tests := []struct {
		value time.Duration
		want  string
	}{
		{value: -time.Second, want: "now"},
		{value: 500 * time.Millisecond, want: "<1s"},
		{value: 5 * time.Second, want: "5s"},
		{value: 2*time.Hour + 14*time.Minute + 9*time.Second, want: "2h14m"},
		{value: 8*24*time.Hour + 3*time.Hour, want: "8d3h"},
	}
	for _, test := range tests {
		if got := compactDuration(test.value); got != test.want {
			t.Errorf("compactDuration(%v) = %q, want %q", test.value, got, test.want)
		}
	}
}

func TestDisplayCommand(t *testing.T) {
	got := displayCommand([]string{"tool", "plain", "two words", "", `a"b`})
	want := `tool plain "two words" "" "a\"b"`
	if got != want {
		t.Fatalf("displayCommand() = %q, want %q", got, want)
	}
}

func TestTruncateText(t *testing.T) {
	if got := truncateText("a long command", 8); got != "a long …" {
		t.Fatalf("truncateText() = %q", got)
	}
	if got := truncateText("short", 8); got != "short" {
		t.Fatalf("truncateText() changed short text to %q", got)
	}
}

func TestTruncateShareURLKeepsHumanSessionListsNarrow(t *testing.T) {
	url := "https://shell.online/s/abcdefghijklmnopqrstuvwxyzABCDEF#salt=public-key-material"
	got := truncateShareURL(url)
	if len([]rune(got)) > 36 {
		t.Fatalf("truncateShareURL returned %d runes, want at most 36: %q", len([]rune(got)), got)
	}
	if got == url {
		t.Fatal("truncateShareURL did not abbreviate a long share URL")
	}
}

func TestConfirmKillAllRequiresExplicitYes(t *testing.T) {
	for _, answer := range []string{"", "n\n", "no\n", "maybe\n"} {
		if confirmKillAll(strings.NewReader(answer), new(bytes.Buffer), 2) {
			t.Fatalf("confirmKillAll accepted %q", answer)
		}
	}
	for _, answer := range []string{"y\n", "yes\n", " YES \n"} {
		if !confirmKillAll(strings.NewReader(answer), new(bytes.Buffer), 2) {
			t.Fatalf("confirmKillAll rejected %q", answer)
		}
	}
}

func TestParseSessionKillArgumentsAcceptsLeadingHyphen(t *testing.T) {
	query, all, valid := parseSessionKillArguments([]string{"-abcde-session-prefix"})
	if !valid || all || query != "-abcde-session-prefix" {
		t.Fatalf("parseSessionKillArguments() = (%q, %t, %t)", query, all, valid)
	}

	query, all, valid = parseSessionKillArguments([]string{"--", "-abcde-session-prefix"})
	if !valid || all || query != "-abcde-session-prefix" {
		t.Fatalf("parseSessionKillArguments() with separator = (%q, %t, %t)", query, all, valid)
	}
}

func TestParseSessionKillArgumentsPreservesAll(t *testing.T) {
	query, all, valid := parseSessionKillArguments([]string{"--all"})
	if !valid || !all || query != "" {
		t.Fatalf("parseSessionKillArguments() = (%q, %t, %t)", query, all, valid)
	}

	if _, _, valid := parseSessionKillArguments([]string{"--all", "unexpected"}); valid {
		t.Fatal("parseSessionKillArguments() accepted --all with a session ID")
	}
}

func TestFetchRelaySessionStatus(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		body       string
		want       relaySessionStatus
	}{
		{name: "connected", statusCode: http.StatusOK, body: `{"exists":true,"status":"connected"}`, want: relayStatusConnected},
		{name: "disconnected", statusCode: http.StatusOK, body: `{"exists":true,"status":"disconnected"}`, want: relayStatusDisconnected},
		{name: "waiting", statusCode: http.StatusOK, body: `{"exists":true,"status":"waiting"}`, want: relayStatusWaiting},
		{name: "gone", statusCode: http.StatusGone, body: `{"exists":false}`, want: relayStatusExpired},
		{name: "not found", statusCode: http.StatusNotFound, body: `{"exists":false}`, want: relayStatusExpired},
		{name: "rate limited", statusCode: http.StatusTooManyRequests, body: `{"error":"slow down"}`, want: relayStatusUnknown},
		{name: "invalid status", statusCode: http.StatusOK, body: `{"exists":true,"status":"surprising"}`, want: relayStatusUnknown},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path != "/api/sessions/abcdefghijklmnopqrstuvwxyzABCDEF" {
					t.Errorf("status path = %q", request.URL.Path)
				}
				response.WriteHeader(test.statusCode)
				_, _ = response.Write([]byte(test.body))
			}))
			defer server.Close()

			got := fetchRelaySessionStatus(context.Background(), server.Client(), localSessionRecord{
				ID:       "abcdefghijklmnopqrstuvwxyzABCDEF",
				ShareURL: server.URL + "/s/ignored?query=ignored#key=must-not-leak",
			})
			if got != test.want {
				t.Fatalf("fetchRelaySessionStatus() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestFetchRelaySessionStatusDoesNotSendFragment(t *testing.T) {
	requestTarget := ""
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestTarget = request.RequestURI
		_, _ = response.Write([]byte(`{"exists":true,"status":"connected"}`))
	}))
	defer server.Close()

	status := fetchRelaySessionStatus(context.Background(), server.Client(), localSessionRecord{
		ID:       "abcdefghijklmnopqrstuvwxyzABCDEF",
		ShareURL: server.URL + "/s/ignored?private=query#key=private-fragment",
	})
	if status != relayStatusConnected {
		t.Fatalf("fetchRelaySessionStatus() = %q", status)
	}
	if strings.Contains(requestTarget, "private") || requestTarget != "/api/sessions/abcdefghijklmnopqrstuvwxyzABCDEF" {
		t.Fatalf("status request leaked share URL data: %q", requestTarget)
	}
}

func TestRelayStatusLabel(t *testing.T) {
	if got := relayStatusLabel(relayStatusDisconnected); got != "reconnecting" {
		t.Fatalf("relayStatusLabel(disconnected) = %q", got)
	}
	if got := relayStatusLabel(relayStatusExpired); got != "expired" {
		t.Fatalf("relayStatusLabel(expired) = %q", got)
	}
}
