//go:build !windows

package main

import (
	"errors"
	"syscall"
)

// Only ESRCH proves absence. EPERM and any unexpected error are unknown, not
// permission to discard a session or close it in the accounts service.
func localSessionProcessGone(pid int) bool {
	// Do not let a malformed 64-bit JSON pid wrap to a different pid_t.
	return pid > 0 && uint64(pid) <= 1<<31-1 && errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
}
