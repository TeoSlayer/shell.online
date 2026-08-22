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
		"shell claude",
		"fork of this conversation",
		"Anyone with the link can view",
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

func TestStartHelpExplainsLocalBackgroundExecution(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if exitCode := run([]string{"help", "start"}, &stdout, &stderr); exitCode != 0 {
		t.Fatalf("run(help start) = %d, stderr = %q", exitCode, stderr.String())
	}
	for _, expected := range []string{
		"stays on this machine",
		"background by default",
		"anyone holding it can view and type",
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
