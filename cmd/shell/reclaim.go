package main

import (
	"context"
	"io"

	"shell.online/internal/account"
)

// sessionCloser is the part of the accounts client this needs, so the catch-up
// can be tested without one.
type sessionCloser interface {
	CloseSession(ctx context.Context, accessToken, id string, exitCode *int) error
}

// Automatic catch-up is disabled until the account service supports a close
// conditional on the exact host run, and local cleanup can bind that same
// incarnation. CloseSession currently accepts only an id. A replacement can
// start after any local check, while its predecessor's close is in flight;
// deleting by id afterwards can discard the replacement's credentials too.
//
// Retain this call boundary for the agent loop, but perform no discovery,
// remote calls or local cleanup. A local lock is insufficient for already
// running hosts/older clients that do not share it. Normal host exit and
// explicit stop keep their existing paths; saved stale evidence is retained.
func reclaimAbandonedSessions(
	_ context.Context,
	_ sessionCloser,
	_ string,
	_ io.Writer,
) {
}

/* Compile-time proof that the real client still fits the interface above. */
var _ sessionCloser = (*account.Client)(nil)
