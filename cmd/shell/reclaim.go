package main

import (
	"context"
	"fmt"
	"io"
	"time"

	"shell.online/internal/account"
)

// reclaimTimeout bounds the whole catch-up. It runs before a machine starts
// taking work, so it may not become the reason a daemon does not start.
const reclaimTimeout = 15 * time.Second

// sessionCloser is the part of the accounts client this needs, so the catch-up
// can be tested without one.
type sessionCloser interface {
	CloseSession(ctx context.Context, accessToken, id string, exitCode *int) error
}

// reclaimAbandonedSessions tells the accounts service about sessions this
// machine ended without saying so.
//
// A session normally closes itself: the process exits, the CLI patches the
// session, and the browser moves it to "Finished". A machine that is rebooted
// or loses power never runs that last step, and nothing else ever did either.
// The relay only knows that the host socket went away, which is the same thing
// it sees when a network drops, so the session stayed in the browser's "Write"
// column -- offered as something you could type into -- until the relay gave
// up on it hours later.
//
// This is the machine answering the question itself, which it is the only
// thing that can do quickly: the process is gone, it is not coming back, and
// here is the session it was.
//
// Every failure is reported and then let go. This runs on the way to doing
// something else, and a service that cannot be reached right now will be
// reached on the next run -- the record stays until the close is accepted.
func reclaimAbandonedSessions(
	ctx context.Context,
	client sessionCloser,
	accessToken string,
	report io.Writer,
) {
	abandoned, err := abandonedLocalSessions()
	if err != nil || len(abandoned) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, reclaimTimeout)
	defer cancel()

	closed := 0
	for _, record := range abandoned {
		if ctx.Err() != nil {
			return
		}
		/*
		 * No exit code. Nobody saw the process end, and inventing a 0 or a 1
		 * would put a result in the record that no one observed.
		 */
		if closeErr := client.CloseSession(ctx, accessToken, record.ID, nil); closeErr != nil {
			fmt.Fprintf(report, "shell: could not close %s, left by an earlier run: %v\n",
				shortSessionID(record.ID), closeErr)
			continue
		}
		forgetLocalSession(record.ID)
		closed++
	}
	if closed > 0 {
		fmt.Fprintf(report, "shell: closed %d session%s left behind by an earlier run\n",
			closed, pluralSuffix(closed))
	}
}

/* Compile-time proof that the real client still fits the interface above. */
var _ sessionCloser = (*account.Client)(nil)
