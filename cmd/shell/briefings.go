package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"time"

	"shell.online/internal/account"
)

// briefingsTimeout bounds shell briefings: one request, plus a token refresh.
const briefingsTimeout = 15 * time.Second

// briefingNotAvailableNote is printed after a saved change. The consent is
// real and stored on the account, but nothing in this build generates a
// briefing yet, and the output should not imply otherwise.
const briefingNotAvailableNote = "Permission saved; an updated compatible host can publish owner-encrypted existing conversation titles and response excerpts, at most once daily. No new prompt or model call; team delivery is not available yet."

func briefingsUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage: shell briefings status")
	fmt.Fprintln(writer, "       shell briefings on [--all]")
	fmt.Fprintln(writer, "       shell briefings off [--all]")
	fmt.Fprintln(writer, "Sets your daily-briefing consent on your account. on/off is the default")
	fmt.Fprintln(writer, "your new sessions start with; --all applies it to the sessions you")
	fmt.Fprintln(writer, "currently have as well.")
}

// runBriefings handles shell briefings status|on|off [--all].
func runBriefings(arguments []string, stdout, stderr io.Writer) int {
	if len(arguments) == 0 {
		briefingsUsage(stderr)
		return 2
	}
	verb := arguments[0]
	rest := arguments[1:]
	if verb == "-h" || verb == "--help" {
		briefingsUsage(stdout)
		return 0
	}
	var enabled *bool
	on, off := true, false
	switch verb {
	case "status":
	case "on":
		enabled = &on
	case "off":
		enabled = &off
	default:
		fmt.Fprintf(stderr, "shell: unknown briefings command %q\n", verb)
		briefingsUsage(stderr)
		return 2
	}

	flags := flag.NewFlagSet("shell briefings "+verb, flag.ContinueOnError)
	flags.SetOutput(stderr)
	all := flags.Bool("all", false, "apply to your current sessions as well")
	flags.Usage = func() { briefingsUsage(stderr) }
	if err := flags.Parse(rest); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() != 0 {
		briefingsUsage(stderr)
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), briefingsTimeout)
	defer cancel()
	client, credentials, err := linkedAccountClient(ctx, stderr)
	if errors.Is(err, account.ErrNotLinked) {
		fmt.Fprintln(stderr, "shell: shell briefings sets the daily-briefing consent for your account, and this machine is not signed in.")
		fmt.Fprintln(stderr, "Run 'shell auth' to link it.")
		return 1
	}
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	if enabled == nil {
		current, err := client.GetBriefingPreference(ctx, credentials.AccessToken)
		if err != nil {
			fmt.Fprintf(stderr, "shell: read briefing preference: %v\n", err)
			return 1
		}
		if current {
			fmt.Fprintln(stdout, "Daily briefings: on for your new sessions. Turn them off with 'shell briefings off'.")
		} else {
			fmt.Fprintln(stdout, "Daily briefings: off. New sessions start with briefings off; turn them on with 'shell briefings on'.")
		}
		return 0
	}

	result, err := client.SetBriefingPreference(ctx, credentials.AccessToken, *enabled, *all)
	if err != nil {
		fmt.Fprintf(stderr, "shell: save briefing preference: %v\n", err)
		return 1
	}
	state := "off"
	if result.Enabled {
		state = "on"
	}
	if *all {
		fmt.Fprintf(stdout, "Daily briefings: %s for your new sessions and %d current session%s.\n",
			state, result.Applied, pluralSuffix(result.Applied))
	} else {
		fmt.Fprintf(stdout, "Daily briefings: %s for your new sessions. Use 'shell briefings %s --all' to apply to current sessions.\n",
			state, state)
	}
	fmt.Fprintln(stdout, briefingNotAvailableNote)
	return 0
}
