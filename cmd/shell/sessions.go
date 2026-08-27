package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

var localSessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)

type localSessionRecord struct {
	ID        string     `json:"id"`
	ShareURL  string     `json:"share_url"`
	ReadOnly  bool       `json:"read_only"`
	Command   string     `json:"command"`
	PID       int        `json:"pid"`
	StartedAt time.Time  `json:"started_at"`
	ClosesAt  *time.Time `json:"closes_at,omitempty"`
}

type localSessionControl interface {
	StopRequested() <-chan struct{}
	BindTerminal(
		input io.Writer,
		output localTerminalOutput,
		resize func(cols, rows uint16) error,
		onInput func(),
	)
	PublishOutput([]byte)
	Close() error
}

type localTerminalOutput interface {
	Write([]byte) (int, error)
	Bytes() []byte
}

type listedSession struct {
	localSessionRecord
	UptimeSeconds   int64  `json:"uptime_seconds"`
	ClosesInSeconds *int64 `json:"closes_in_seconds,omitempty"`
}

func runSessionCommand(arguments []string, stdout, stderr io.Writer) (int, bool) {
	if len(arguments) == 0 {
		return 0, false
	}
	switch arguments[0] {
	case "help":
		return runHelp(arguments[1:], stdout, stderr), true
	case "list", "ps":
		return runSessionList(arguments[1:], stdout, stderr), true
	case "attach":
		return runSessionAttach(arguments[1:], stdout, stderr), true
	case "kill", "stop":
		return runSessionKill(arguments[1:], stdout, stderr), true
	default:
		return 0, false
	}
}

func runSessionAttach(arguments []string, stdout, stderr io.Writer) int {
	if len(arguments) != 1 {
		fmt.Fprintln(stderr, "Usage: shell attach <session-id-or-prefix>")
		fmt.Fprintln(stderr, "Run 'shell list' to find an ID, or 'shell help attach' for the guided flow.")
		return 2
	}
	query := arguments[0]
	if len(query) < 6 {
		fmt.Fprintln(stderr, "shell: session prefix must contain at least 6 characters")
		return 2
	}

	sessions, err := loadActiveLocalSessions()
	if err != nil {
		fmt.Fprintf(stderr, "shell: list sessions: %v\n", err)
		return 1
	}
	matches := make([]localSessionRecord, 0, 1)
	for _, session := range sessions {
		if session.ID == query {
			matches = []localSessionRecord{session}
			break
		}
		if strings.HasPrefix(session.ID, query) {
			matches = append(matches, session)
		}
	}
	if len(matches) == 0 {
		fmt.Fprintf(stderr, "shell: no active session matches %q\n", query)
		return 1
	}
	if len(matches) > 1 {
		fmt.Fprintf(stderr, "shell: session prefix %q is ambiguous\n", query)
		return 1
	}

	if err := attachLocalSession(matches[0].ID, stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "shell: attach %s: %v\n", shortSessionID(matches[0].ID), err)
		return 1
	}
	return 0
}

func runSessionList(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("shell list", flag.ContinueOnError)
	flags.SetOutput(stderr)
	jsonOutput := flags.Bool("json", false, "emit active sessions as JSON")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: shell list [--json]")
	}
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() != 0 {
		flags.Usage()
		return 2
	}

	sessions, err := loadActiveLocalSessions()
	if err != nil {
		fmt.Fprintf(stderr, "shell: list sessions: %v\n", err)
		return 1
	}
	sort.Slice(sessions, func(left, right int) bool {
		return sessions[left].StartedAt.Before(sessions[right].StartedAt)
	})

	if *jsonOutput {
		now := time.Now()
		listed := make([]listedSession, 0, len(sessions))
		for _, session := range sessions {
			item := listedSession{
				localSessionRecord: session,
				UptimeSeconds:      max(0, int64(now.Sub(session.StartedAt).Seconds())),
			}
			if session.ClosesAt != nil {
				seconds := max(0, int64(time.Until(*session.ClosesAt).Seconds()))
				item.ClosesInSeconds = &seconds
			}
			listed = append(listed, item)
		}
		encoder := json.NewEncoder(stdout)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(listed); err != nil {
			fmt.Fprintf(stderr, "shell: encode sessions: %v\n", err)
			return 1
		}
		return 0
	}

	if len(sessions) == 0 {
		fmt.Fprintln(stdout, "No active shell.online sessions.")
		return 0
	}

	now := time.Now()
	table := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(table, "ID\tUPTIME\tCLOSES\tACCESS\tCOMMAND\tSHARE URL")
	for _, session := range sessions {
		closes := "on exit"
		if session.ClosesAt != nil {
			closes = "in " + compactDuration(session.ClosesAt.Sub(now))
		}
		access := "interactive"
		if session.ReadOnly {
			access = "view-only"
		}
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\t%s\n",
			shortSessionID(session.ID),
			compactDuration(now.Sub(session.StartedAt)),
			closes,
			access,
			truncateText(session.Command, 48),
			session.ShareURL,
		)
	}
	_ = table.Flush()
	return 0
}

func truncateText(value string, maximumRunes int) string {
	runes := []rune(value)
	if maximumRunes < 2 || len(runes) <= maximumRunes {
		return value
	}
	return string(runes[:maximumRunes-1]) + "…"
}

func runSessionKill(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("shell kill", flag.ContinueOnError)
	flags.SetOutput(stderr)
	all := flags.Bool("all", false, "stop every active local session")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: shell kill <session-id-or-prefix>")
		fmt.Fprintln(stderr, "       shell kill --all")
	}
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if (*all && flags.NArg() != 0) || (!*all && flags.NArg() != 1) {
		flags.Usage()
		return 2
	}

	sessions, err := loadActiveLocalSessions()
	if err != nil {
		fmt.Fprintf(stderr, "shell: list sessions: %v\n", err)
		return 1
	}
	if len(sessions) == 0 {
		fmt.Fprintln(stderr, "shell: no active sessions")
		return 1
	}

	targets := sessions
	if !*all {
		query := flags.Arg(0)
		if len(query) < 6 {
			fmt.Fprintln(stderr, "shell: session prefix must contain at least 6 characters")
			return 2
		}
		targets = nil
		for _, session := range sessions {
			if session.ID == query {
				targets = []localSessionRecord{session}
				break
			}
			if strings.HasPrefix(session.ID, query) {
				targets = append(targets, session)
			}
		}
		if len(targets) == 0 {
			fmt.Fprintf(stderr, "shell: no active session matches %q\n", query)
			return 1
		}
		if len(targets) > 1 {
			fmt.Fprintf(stderr, "shell: session prefix %q is ambiguous\n", query)
			return 1
		}
	}

	failed := false
	for _, session := range targets {
		if err := requestLocalSessionStop(session.ID); err != nil {
			fmt.Fprintf(stderr, "shell: stop %s: %v\n", shortSessionID(session.ID), err)
			failed = true
			continue
		}
		fmt.Fprintf(stdout, "Stopping %s  %s\n", shortSessionID(session.ID), truncateText(session.Command, 72))
	}
	if failed {
		return 1
	}
	return 0
}

func compactDuration(duration time.Duration) string {
	if duration <= 0 {
		return "now"
	}
	if duration < time.Second {
		return "<1s"
	}
	duration = duration.Round(time.Second)
	days := duration / (24 * time.Hour)
	duration %= 24 * time.Hour
	hours := duration / time.Hour
	duration %= time.Hour
	minutes := duration / time.Minute
	seconds := (duration % time.Minute) / time.Second
	parts := make([]string, 0, 2)
	for _, part := range []struct {
		value  time.Duration
		suffix string
	}{{days, "d"}, {hours, "h"}, {minutes, "m"}, {seconds, "s"}} {
		if part.value > 0 && len(parts) < 2 {
			parts = append(parts, strconv.FormatInt(int64(part.value), 10)+part.suffix)
		}
	}
	return strings.Join(parts, "")
}

func shortSessionID(id string) string {
	if len(id) <= 10 {
		return id
	}
	return id[:10]
}

func displayCommand(arguments []string) string {
	parts := make([]string, 0, len(arguments))
	for _, argument := range arguments {
		if argument != "" && !strings.ContainsAny(argument, " \t\n\r\"'") {
			parts = append(parts, argument)
		} else {
			parts = append(parts, strconv.Quote(argument))
		}
	}
	return strings.Join(parts, " ")
}
