package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestSessionCardMakesEncryptedAccessExplicit(t *testing.T) {
	var output bytes.Buffer
	printSessionCard(&output, backgroundLaunchResult{
		ID: "abcdefghijklmnopqrstuvwxyzABCDEF", ShareURL: "https://shell.online/s/example#salt=value",
		Password: "Ab3dE7-_", Encrypted: true,
	}, true)
	for _, expected := range []string{"shell.online  ✦", "Password", "Ab3dE7-_", "interactive · end-to-end encrypted", "Rejoin", "shell attach abcdefghij"} {
		if !strings.Contains(output.String(), expected) {
			t.Errorf("session card does not contain %q:\n%s", expected, output.String())
		}
	}
	if strings.Contains(output.String(), "\x1b[") {
		t.Fatal("non-TTY output contained ANSI styling")
	}
}

func TestSessionCardWarnsWhenE2EEIsDisabled(t *testing.T) {
	var output bytes.Buffer
	printSessionCard(&output, backgroundLaunchResult{
		ID: "abcdefghijklmnopqrstuvwxyzABCDEF", ShareURL: "https://shell.online/s/example",
	}, true)
	if !strings.Contains(output.String(), "transport encryption only") || !strings.Contains(output.String(), "Cloudflare can relay terminal plaintext") {
		t.Fatalf("plaintext boundary is unclear:\n%s", output.String())
	}
	if strings.Contains(output.String(), "Password") {
		t.Fatalf("no-E2EE output claimed to have a password:\n%s", output.String())
	}
}

func TestSessionTextStylingCanBeDisabled(t *testing.T) {
	if got := styleSessionText(false, "31", "value"); got != "value" {
		t.Fatalf("unstyled value = %q", got)
	}
	if got := styleSessionText(true, "31", "value"); got != "\x1b[31mvalue\x1b[0m" {
		t.Fatalf("styled value = %q", got)
	}
}
