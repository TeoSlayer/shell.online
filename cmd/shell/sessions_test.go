package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

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
