package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestHelpCommandGuidesSessionLifecycle(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if exitCode := run([]string{"help"}, &stdout, &stderr); exitCode != 0 {
		t.Fatalf("run(help) = %d, stderr = %q", exitCode, stderr.String())
	}
	for _, expected := range []string{
		"shell <command>",
		"shell --read-only <command>",
		"browser input is blocked",
		"shell claude",
		"fork of this conversation",
		"Shares are interactive by default",
		"eight-character browser",
		"shell list",
		"shell attach <ID>",
		"Press Ctrl-X, then D to detach",
		"shell kill <ID>",
		"stop the process and close its link",
	} {
		if !strings.Contains(stdout.String(), expected) {
			t.Errorf("help output does not contain %q", expected)
		}
	}
}

func TestE2EEHelpExplainsAutomaticPasswordFlow(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if exitCode := run([]string{"help", "e2ee"}, &stdout, &stderr); exitCode != 0 {
		t.Fatalf("run(help e2ee) = %d, stderr = %q", exitCode, stderr.String())
	}
	for _, expected := range []string{
		"By default, every new share encrypts",
		"eight-character password",
		"SHELL_ONLINE_E2EE_PASSWORD",
		"URL and password",
		"--e2ee flag remains accepted",
	} {
		if !strings.Contains(stdout.String(), expected) {
			t.Errorf("E2EE help does not contain %q", expected)
		}
	}
}

func TestStartHelpExplainsLocalBackgroundExecution(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if exitCode := run([]string{"help", "start"}, &stdout, &stderr); exitCode != 0 {
		t.Fatalf("run(help start) = %d, stderr = %q", exitCode, stderr.String())
	}
	for _, expected := range []string{
		"stays on this machine",
		"background by default",
		"view-only link whose browser input is blocked",
		"shareable fork with its history",
		"original Claude process",
	} {
		if !strings.Contains(stdout.String(), expected) {
			t.Errorf("start help does not contain %q", expected)
		}
	}
}

func TestAttachHelpExplainsChildCannotCaptureDetach(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if exitCode := run([]string{"help", "attach"}, &stdout, &stderr); exitCode != 0 {
		t.Fatalf("run(help attach) = %d, stderr = %q", exitCode, stderr.String())
	}
	for _, expected := range []string{"Press Ctrl-X", "before Claude", "does not stop", "Ctrl-Z"} {
		if !strings.Contains(stdout.String(), expected) {
			t.Errorf("attach help does not contain %q", expected)
		}
	}
}

func TestCompleteCLIReferenceCoversPublicInterface(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if exitCode := run([]string{"help", "reference"}, &stdout, &stderr); exitCode != 0 {
		t.Fatalf("run(help reference) = %d, stderr = %q", exitCode, stderr.String())
	}
	for _, expected := range []string{
		"shell [options] [--] [command]",
		"--read-only",
		"--e2ee",
		"--no-e2ee",
		"--persistent <state-file>",
		"--foreground",
		"--auto-close",
		"--json",
		"--server <URL>",
		"--version",
		"shell list --json",
		"relay_status",
		"shell attach <session-id-or-prefix>",
		"shell kill --all",
		"SHELL_ONLINE_SERVER",
		"SHELL_ONLINE_E2EE_PASSWORD",
		"invalid CLI usage",
	} {
		if !strings.Contains(stdout.String(), expected) {
			t.Errorf("complete CLI reference does not contain %q", expected)
		}
	}
}

func TestE2EEFlagsRejectAmbiguousOrUnsafeCombinations(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if exitCode := run([]string{"--e2ee", "--no-e2ee"}, &stdout, &stderr); exitCode != 2 {
		t.Fatalf("conflicting E2EE flags returned %d", exitCode)
	}
	if !strings.Contains(stderr.String(), "cannot be used together") {
		t.Fatalf("conflict error = %q", stderr.String())
	}

	stdout.Reset()
	stderr.Reset()
	t.Setenv("SHELL_ONLINE_E2EE_PASSWORD", "configured password")
	if exitCode := run([]string{"--foreground", "--no-e2ee", "/bin/true"}, &stdout, &stderr); exitCode != 2 {
		t.Fatalf("password plus --no-e2ee returned %d", exitCode)
	}
	if !strings.Contains(stderr.String(), "cannot be used with --no-e2ee") {
		t.Fatalf("password conflict error = %q", stderr.String())
	}
}
