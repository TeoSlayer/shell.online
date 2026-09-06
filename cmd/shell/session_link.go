package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"shell.online/internal/account"
)

// linkTimeout bounds every accounts call made around a session launch. Sharing
// a terminal must never block on the accounts service.
const linkTimeout = 10 * time.Second

// sessionNameEnvironment carries a label chosen elsewhere, such as in the web
// app, through to the published session.
const sessionNameEnvironment = "SHELL_ONLINE_SESSION_NAME"

// sessionOriginEnvironment carries the request that started this session, so
// the browser that made it can recognise its own session when it appears.
const sessionOriginEnvironment = "SHELL_ONLINE_SESSION_ORIGIN"

// sessionNameFromEnvironment returns the label for this session, if any.
func sessionNameFromEnvironment() string {
	return strings.TrimSpace(os.Getenv(sessionNameEnvironment))
}

// sessionLink publishes a running session to the linked account.
//
// It is nil whenever this machine is not signed in, so every method is safe to
// call unconditionally from the launch path.
type sessionLink struct {
	client      *account.Client
	accessToken string
	sessionID   string
	warn        io.Writer
}

// openSessionLink loads credentials, refreshes them when stale, and returns a
// link ready to publish. It returns nil when there is no account to publish to.
//
// Nothing here is fatal. A machine that is not signed in, or an accounts
// service that is down, must still be able to share a terminal.
func openSessionLink(ctx context.Context, warn io.Writer) *sessionLink {
	path, err := account.DefaultPath()
	if err != nil {
		return nil
	}
	credentials, err := account.Load(path)
	if errors.Is(err, account.ErrNotLinked) {
		return nil
	}
	if err != nil {
		fmt.Fprintf(warn, "shell: %v\n", err)
		return nil
	}

	client := account.NewClient(credentials.Server, "shell/"+version)
	if credentials.Expired(time.Now()) {
		refreshContext, cancel := context.WithTimeout(ctx, linkTimeout)
		defer cancel()
		refreshed, refreshErr := client.Refresh(refreshContext, credentials)
		if refreshErr != nil {
			fmt.Fprintf(warn, "shell: this session will not appear in your account: %v\n", refreshErr)
			return nil
		}
		credentials = refreshed
		if saveErr := account.Save(path, credentials); saveErr != nil {
			fmt.Fprintf(warn, "shell: could not store the renewed token: %v\n", saveErr)
		}
	}

	return &sessionLink{client: client, accessToken: credentials.AccessToken, warn: warn}
}

// Register publishes the session. Failure is reported, never fatal.
func (link *sessionLink) Register(ctx context.Context, input account.SessionInput) {
	if link == nil {
		return
	}
	if input.Host == "" {
		if host, err := os.Hostname(); err == nil {
			input.Host = host
		}
	}
	if input.StartedAt == 0 {
		input.StartedAt = time.Now().UnixMilli()
	}
	if input.Name == "" {
		input.Name = sessionNameFromEnvironment()
	}
	if input.Origin == "" {
		input.Origin = strings.TrimSpace(os.Getenv(sessionOriginEnvironment))
	}

	registerContext, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	if err := link.client.RegisterSession(registerContext, link.accessToken, input); err != nil {
		fmt.Fprintf(link.warn, "shell: this session will not appear in your account: %v\n", err)
		return
	}
	link.sessionID = input.ID
}

// Close marks the session finished in the account.
//
// It deliberately uses a fresh background context: the process context is
// already cancelled by the time a session ends, so inheriting it would abort
// this call before it left the machine.
func (link *sessionLink) Close(exitCode *int) {
	if link == nil || link.sessionID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout)
	defer cancel()
	if err := link.client.CloseSession(ctx, link.accessToken, link.sessionID, exitCode); err != nil {
		fmt.Fprintf(link.warn, "shell: could not mark the session closed: %v\n", err)
	}
}
