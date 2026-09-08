package main

import (
	"net/url"
	"strings"
	"testing"
)

func TestSessionQRPayloadEmbedsPasswordOnlyInFragment(t *testing.T) {
	payload, err := sessionQRPayload(backgroundLaunchResult{
		ShareURL: "https://shell.online/s/example#salt=Abcd_-12",
		Password: "correct horse & battery",
	})
	if err != nil {
		t.Fatalf("sessionQRPayload: %v", err)
	}
	parsed, err := url.Parse(payload)
	if err != nil {
		t.Fatalf("parse payload: %v", err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		t.Fatalf("parse fragment: %v", err)
	}
	if fragment.Get("salt") != "Abcd_-12" || fragment.Get("password") != "correct horse & battery" {
		t.Fatalf("QR fragment = %q", parsed.Fragment)
	}
	if strings.Contains(strings.Split(payload, "#")[0], "correct") {
		t.Fatalf("password escaped the fragment: %s", payload)
	}
}

func TestTerminalQRCodeIsCompact(t *testing.T) {
	payload, err := sessionQRPayload(backgroundLaunchResult{
		ShareURL: "https://shell.online/s/abcdefghijklmnopqrstuvwxyz123456#salt=abcdefghijklmnopqrstuv",
		Password: "Ab3dE7-_",
	})
	if err != nil {
		t.Fatal(err)
	}
	rendered, err := terminalQRCode(payload)
	if err != nil {
		t.Fatalf("terminalQRCode: %v", err)
	}
	lines := strings.Split(strings.TrimSuffix(rendered, "\n"), "\n")
	if len(lines) > 30 {
		t.Fatalf("terminal QR is %d rows high", len(lines))
	}
	if !strings.Contains(rendered, "▀") || !strings.Contains(rendered, "▄") || !strings.Contains(rendered, "\x1b[47m") {
		t.Fatalf("terminal QR lacks half blocks or explicit colours")
	}
}

func TestSessionQRPayloadLeavesUnencryptedLinkUnchanged(t *testing.T) {
	const shareURL = "https://shell.online/s/example"
	payload, err := sessionQRPayload(backgroundLaunchResult{ShareURL: shareURL})
	if err != nil {
		t.Fatal(err)
	}
	if payload != shareURL {
		t.Fatalf("payload = %q, want %q", payload, shareURL)
	}
}
