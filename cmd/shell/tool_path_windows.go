//go:build windows

package main

import "context"

/**
 * Nothing to ask.
 *
 * Windows has no login shell whose rc files decide where tools live: PATH is
 * a machine and user setting the service manager already hands to a service,
 * so a probe would be asking the same environment the daemon already has. The
 * conventional directories still apply.
 */
func probeLoginShellPath(context.Context) (string, error) {
	return "", nil
}
