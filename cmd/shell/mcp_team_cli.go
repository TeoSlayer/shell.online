package main

import (
	"context"
	"fmt"
	"io"
	"time"

	"shell.online/internal/account"
)

// The teammate's half of a team MCP connection.
//
// Unlike the other mcp actions, this one does not talk to a local session: the
// teammate does not own the session. It talks to the accounts service with the
// teammate's own sign-in, asks for an observe-only grant on a session whose
// owner opted into team MCP, waits for the session's own machine to answer, and
// prints the credential exactly once.
//
// The credential is delivered once and only to the requester: a lost capture is
// recovered by asking again, which costs the owner one more observe-only grant
// at most.

const (
	// How often to poll for the answer; the request itself waits up to five
	// minutes, so this is comfortably patient without being nervous.
	mcpTeamFetchInterval = 2 * time.Second
	// A hard bound on how long the command waits, a little past the request's
	// own five-minute deadline so a slow answer is not cut off at the wire.
	mcpTeamFetchMaxWait = 6 * time.Minute
)

func runSessionMcpTeam(arguments []string, stdout, stderr io.Writer) int {
	if len(arguments) != 1 || arguments[0] == "" {
		fmt.Fprintln(stderr, "Usage: shell mcp team <session-id>")
		return 2
	}
	sessionID := arguments[0]

	ctx, cancel := context.WithTimeout(context.Background(), mcpTeamFetchMaxWait+30*time.Second)
	defer cancel()

	client, credentials, err := linkedAccountClient(ctx, stderr)
	if err != nil {
		if err == account.ErrNotLinked {
			fmt.Fprintln(stderr, "shell: this machine is not signed in; sign in to ask for team MCP access")
			return 1
		}
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	recipient, err := account.NewMcpTeamRecipient()
	if err != nil {
		fmt.Fprintf(stderr, "shell: mcp team: %v\n", err)
		return 1
	}
	request, err := client.RequestMcpTeamGrant(ctx, credentials.AccessToken, sessionID, recipient.PublicKey())
	if err != nil {
		fmt.Fprintf(stderr, "shell: mcp team: %v\n", err)
		return 1
	}
	fmt.Fprintf(stderr, "shell: asked for team MCP access to %s; waiting for the session's machine to answer\n", sessionID)

	deadline := time.Now().Add(mcpTeamFetchMaxWait)
	if request.ExpiresAt > 0 {
		if expires := time.UnixMilli(request.ExpiresAt); expires.Before(deadline) {
			deadline = expires.Add(10 * time.Second)
		}
	}
	ticker := time.NewTicker(mcpTeamFetchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			fmt.Fprintln(stderr, "shell: mcp team: timed out waiting for the session's machine")
			return 1
		case <-ticker.C:
		}
		if time.Now().After(deadline) {
			fmt.Fprintln(stderr, "shell: mcp team: the request expired before the session's machine answered")
			return 1
		}
		fetch, err := client.FetchMcpTeamGrant(ctx, credentials.AccessToken, sessionID, request.RequestID)
		if err != nil {
			fmt.Fprintf(stderr, "shell: mcp team: %v\n", err)
			return 1
		}
		if fetch.Status != "issued" {
			continue
		}
		if fetch.Bearer == "" {
			// Issued but the credential was already delivered (a racing fetch).
			fmt.Fprintln(stderr, "shell: mcp team: this request was already delivered; ask again for a fresh grant")
			return 1
		}
		bearer, err := recipient.Open(sessionID, credentials.UID, request.RequestID, fetch)
		if err != nil {
			fmt.Fprintln(stderr, "shell: mcp team: could not open this request's protected credential; ask again for a fresh grant")
			return 1
		}
		fmt.Fprintln(stdout, bearer)
		return 0
	}
}
