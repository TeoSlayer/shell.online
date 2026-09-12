package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
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

// sessionCommandEnvironment carries the command a browser asked for.
//
// A browser-started session is run as `shell sh -c "<command>"`, so the argv
// this process sees is the shell, not the thing anybody asked for. Publishing
// that argv recorded `sh -c "claude ..."` as the command, which is not what
// was requested and not what the session is: every one of them showed up as a
// terminal process, because the program being run is the second word.
//
// The shell is how it is run. This is what was asked for, and it is what the
// session should say it is.
const sessionCommandEnvironment = "SHELL_ONLINE_SESSION_COMMAND"

// sessionCommandFromEnvironment returns the requested command, if any.
func sessionCommandFromEnvironment() string {
	return strings.TrimSpace(os.Getenv(sessionCommandEnvironment))
}

// sessionNameFromEnvironment returns the label for this session, if any.
func sessionNameFromEnvironment() string {
	return strings.TrimSpace(os.Getenv(sessionNameEnvironment))
}

// sessionLink publishes a running session to the linked account.
//
// It is nil whenever this machine is not signed in, so every method is safe to
// call unconditionally from the launch path.
type sessionLink struct {
	mu          sync.Mutex
	client      *account.Client
	accessToken string
	sessionID   string
	warn        io.Writer
	// credentials and path are kept so a vault key seen for the first time
	// can be pinned into the file it came from.
	credentials account.Credentials
	path        string
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

	return &sessionLink{
		client:      client,
		accessToken: credentials.AccessToken,
		warn:        warn,
		credentials: credentials,
		path:        path,
	}
}

// Register publishes the session. Failure is reported, never fatal.
//
// password is the session's browser password, or empty when it has none. A
// password is sealed to the account's vault so the session can be opened from
// the web app after this terminal is gone; it is never sent any other way.
func (link *sessionLink) Register(ctx context.Context, input account.SessionInput, password string) {
	if link == nil {
		return
	}
	/* Live rotation is handled by the local control goroutine, while process
	 * exit is handled by the main goroutine. Keep their account writes ordered
	 * so a close cannot race a replacement vault share. */
	link.mu.Lock()
	defer link.mu.Unlock()
	if password != "" {
		input.OwnerShare = link.vaultShare(ctx, input.ID, password)
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
	/*
	 * Authoritative when set, unlike the two above, which only fill a gap.
	 * input.Command is never empty: it is this process's own argv, and for a
	 * browser-started session that argv is the shell wrapper rather than the
	 * command. The wrapper is an implementation detail of running it.
	 */
	if requested := sessionCommandFromEnvironment(); requested != "" {
		input.Command = requested
	}

	registerContext, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	if err := link.client.RegisterSession(registerContext, link.accessToken, input); err != nil {
		fmt.Fprintf(link.warn, "shell: this session will not appear in your account: %v\n", err)
		return
	}
	link.sessionID = input.ID
}

// vaultShare seals a session password to the account's vault key, or returns
// nil when that cannot be done safely. Failing here costs only the saved copy;
// the session itself is unaffected.
//
// The key is checked against the one this machine already trusts. The first
// key seen is pinned; a different one later is refused, because the accounts
// service is the thing that hands the key over and the thing that must not be
// able to read what is sealed to it.
func (link *sessionLink) vaultShare(ctx context.Context, sessionID, password string) *account.KeyShare {
	const notSaved = "shell: this session's password was not saved to your vault"
	if link.credentials.UID == "" {
		fmt.Fprintf(link.warn, "%s: this machine's sign-in predates the vault; run 'shell login'\n", notSaved)
		return nil
	}

	keyContext, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	fetched, ok, err := link.client.AccountKey(keyContext, link.accessToken)
	if err != nil {
		fmt.Fprintf(link.warn, "%s: %v\n", notSaved, err)
		return nil
	}
	if !ok {
		return nil
	}

	switch pinned := link.credentials.AccountKey; {
	case pinned == "":
		link.credentials.AccountKey = fetched
		if saveErr := account.Save(link.path, link.credentials); saveErr != nil {
			fmt.Fprintf(link.warn, "shell: could not remember your vault key: %v\n", saveErr)
		}
		fingerprint, _ := account.Fingerprint(fetched)
		fmt.Fprintf(link.warn, "shell: saving session passwords to your vault (key %s)\n", fingerprint)
	case pinned != fetched:
		fmt.Fprintf(link.warn, "shell: your vault key changed since this machine signed in. "+
			"Run 'shell login' to trust the new one; %s.\n", strings.TrimPrefix(notSaved, "shell: "))
		return nil
	}

	sender, sealed, err := account.SealToAccount(link.credentials.AccountKey, sessionID, link.credentials.UID, password)
	if err != nil {
		fmt.Fprintf(link.warn, "%s: %v\n", notSaved, err)
		return nil
	}
	return &account.KeyShare{SenderPublicKey: sender, Sealed: sealed}
}

// Close marks the session finished in the account.
//
// It deliberately uses a fresh background context: the process context is
// already cancelled by the time a session ends, so inheriting it would abort
// this call before it left the machine.
func (link *sessionLink) Close(exitCode *int) {
	if link == nil {
		return
	}
	link.mu.Lock()
	defer link.mu.Unlock()
	if link.sessionID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), linkTimeout)
	defer cancel()
	if err := link.client.CloseSession(ctx, link.accessToken, link.sessionID, exitCode); err != nil {
		fmt.Fprintf(link.warn, "shell: could not mark the session closed: %v\n", err)
	}
}
