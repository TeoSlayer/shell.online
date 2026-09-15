package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"text/tabwriter"
	"time"

	"shell.online/internal/account"
)

// accountSessionsTimeout bounds `shell ls`, which is one request and a refresh.
const accountSessionsTimeout = 15 * time.Second

// accountSessionJSON is the stable, script-facing shape of `shell ls --json`.
type accountSessionJSON struct {
	ID          string     `json:"id"`
	Name        string     `json:"name,omitempty"`
	Command     string     `json:"command"`
	Host        string     `json:"host"`
	ShareURL    string     `json:"share_url"`
	ReadOnly    bool       `json:"read_only"`
	Encrypted   bool       `json:"encrypted"`
	Persistent  bool       `json:"persistent"`
	StartedAt   time.Time  `json:"started_at"`
	ClosedAt    *time.Time `json:"closed_at,omitempty"`
	ExitCode    *int       `json:"exit_code,omitempty"`
	Status      string     `json:"status"`
	RelayStatus string     `json:"relay_status,omitempty"`
}

// runAccountSessionList prints the sessions in the linked account, from every
// machine it has, where `shell list` prints only the processes on this one.
func runAccountSessionList(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("shell ls", flag.ContinueOnError)
	flags.SetOutput(stderr)
	all := flags.Bool("all", false, "include sessions that have ended")
	jsonOutput := flags.Bool("json", false, "emit sessions as JSON")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: shell ls [--all] [--json]")
		fmt.Fprintln(stderr, "Lists the sessions in your account, from every linked machine.")
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

	ctx, cancel := context.WithTimeout(context.Background(), accountSessionsTimeout)
	defer cancel()
	client, credentials, err := linkedAccountClient(ctx, stderr)
	if errors.Is(err, account.ErrNotLinked) {
		fmt.Fprintln(stderr, "shell: shell ls lists the sessions in your account, and this machine is not signed in.")
		fmt.Fprintln(stderr, "Run 'shell login' to link it, or 'shell list' for the sessions running here.")
		return 1
	}
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	sessions, err := client.ListSessions(ctx, credentials.AccessToken)
	if err != nil {
		fmt.Fprintf(stderr, "shell: list account sessions: %v\n", err)
		return 1
	}

	shown := make([]account.AccountSession, 0, len(sessions))
	for _, session := range sessions {
		if *all || !accountSessionEnded(session) {
			shown = append(shown, session)
		}
	}
	hidden := len(sessions) - len(shown)

	if *jsonOutput {
		listed := make([]accountSessionJSON, 0, len(shown))
		for _, session := range shown {
			listed = append(listed, accountSessionForJSON(session))
		}
		encoder := json.NewEncoder(stdout)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(listed); err != nil {
			fmt.Fprintf(stderr, "shell: encode sessions: %v\n", err)
			return 1
		}
		return 0
	}

	now := time.Now()
	if len(shown) == 0 {
		if *all {
			fmt.Fprintln(stdout, "No sessions in your account.")
		} else {
			fmt.Fprintln(stdout, "No open sessions in your account.")
		}
	} else if compactSessionList(stdout) {
		printCompactAccountSessions(stdout, shown, now)
	} else {
		printAccountSessionTable(stdout, shown, now)
	}
	if hidden > 0 {
		fmt.Fprintf(stdout, "%d ended session%s hidden · shell ls --all\n", hidden, pluralSuffix(hidden))
	}
	return 0
}

// linkedAccountClient loads this machine's account and renews a stale token,
// saving the renewed one so the next command need not.
func linkedAccountClient(ctx context.Context, warn io.Writer) (*account.Client, account.Credentials, error) {
	path, err := account.DefaultPath()
	if err != nil {
		return nil, account.Credentials{}, err
	}
	credentials, err := account.Load(path)
	if err != nil {
		return nil, account.Credentials{}, err
	}
	client := account.NewClient(credentials.Server, "shell/"+version)
	if credentials.Expired(time.Now()) {
		refreshed, refreshErr := client.Refresh(ctx, credentials)
		if refreshErr != nil {
			return nil, account.Credentials{}, fmt.Errorf("renew this machine's sign-in: %w", refreshErr)
		}
		credentials = refreshed
		if saveErr := account.Save(path, credentials); saveErr != nil {
			fmt.Fprintf(warn, "shell: could not store the renewed token: %v\n", saveErr)
		}
	}
	return client, credentials, nil
}

// accountSessionEnded mirrors the web app: closed, or gone from the relay.
// A disconnected session may still come back, so it is not ended.
func accountSessionEnded(session account.AccountSession) bool {
	return session.ClosedAt != nil || session.RelayStatus == "exited" || session.RelayStatus == "missing"
}

// accountSessionStatus uses the words the web app shows for the same states.
func accountSessionStatus(session account.AccountSession) string {
	switch {
	case session.ClosedAt != nil || session.RelayStatus == "exited":
		return "finished"
	case session.RelayStatus == "missing":
		return "unavailable"
	case session.RelayStatus == "disconnected":
		return "offline"
	case session.RelayStatus == "waiting":
		return "starting"
	case session.RelayStatus == "unknown":
		return "unknown"
	default:
		return "online"
	}
}

// accountSessionDuration is how long a session has run, or ran.
func accountSessionDuration(session account.AccountSession, now time.Time) string {
	end := now
	if session.ClosedAt != nil {
		end = time.UnixMilli(*session.ClosedAt)
	}
	return compactDuration(end.Sub(time.UnixMilli(session.StartedAt)))
}

func accountSessionForJSON(session account.AccountSession) accountSessionJSON {
	listed := accountSessionJSON{
		ID:          session.ID,
		Name:        session.Name,
		Command:     session.Command,
		Host:        session.Host,
		ShareURL:    session.ShareURL,
		ReadOnly:    session.ReadOnly,
		Encrypted:   session.Encrypted,
		Persistent:  session.Persistent,
		StartedAt:   time.UnixMilli(session.StartedAt).UTC(),
		ExitCode:    session.ExitCode,
		Status:      accountSessionStatus(session),
		RelayStatus: session.RelayStatus,
	}
	if session.ClosedAt != nil {
		closedAt := time.UnixMilli(*session.ClosedAt).UTC()
		listed.ClosedAt = &closedAt
	}
	return listed
}

func printAccountSessionTable(writer io.Writer, sessions []account.AccountSession, now time.Time) {
	table := tabwriter.NewWriter(writer, 0, 4, 2, ' ', 0)
	fmt.Fprintln(table, "ID\tNAME\tSTATUS\tUPTIME\tMACHINE\tCOMMAND")
	for _, session := range sessions {
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\t%s\n",
			shortSessionID(session.ID),
			sessionNameLabel(session.Name, 32),
			accountSessionStatus(session),
			accountSessionDuration(session, now),
			truncateText(session.Host, 24),
			truncateText(session.Command, 48),
		)
	}
	_ = table.Flush()
}

func printCompactAccountSessions(writer io.Writer, sessions []account.AccountSession, now time.Time) {
	for index, session := range sessions {
		if index > 0 {
			fmt.Fprintln(writer)
		}
		title := session.Name
		if title == "" {
			title = session.Command
		}
		fmt.Fprintf(writer, "%s  %s\n", shortSessionID(session.ID), truncateText(title, 64))
		fmt.Fprintf(writer, "  %s · %s · %s\n", accountSessionStatus(session), accountSessionDuration(session, now), session.Host)
		if session.Name != "" {
			fmt.Fprintf(writer, "  Command   %s\n", truncateText(session.Command, 64))
		}
	}
}
