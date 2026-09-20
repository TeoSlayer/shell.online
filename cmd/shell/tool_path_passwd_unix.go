//go:build !windows

package main

import (
	"os"
	"strings"
)

/**
 * The shell the system has on file for a user.
 *
 * Read from /etc/passwd rather than asked of the directory service, because
 * the daemon may be starting before anything else is up and because the
 * answer only has to be good enough to print a PATH. A machine whose users
 * live in a directory service will not be found here, and falls through to the
 * platform default, which is the same shell it would have.
 */
func shellFromPasswd(username string) string {
	contents, err := os.ReadFile("/etc/passwd")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(contents), "\n") {
		fields := strings.Split(line, ":")
		if len(fields) < 7 || fields[0] != username {
			continue
		}
		return strings.TrimSpace(fields[6])
	}
	return ""
}
