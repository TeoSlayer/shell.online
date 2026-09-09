//go:build !windows

package main

/*
 * Runs a browser-entered command as itself where that is possible.
 *
 * Most of what the browser sends is a plain program and its arguments:
 * `claude --dangerously-skip-permissions`. That has an argv, so it is run as
 * one. The session then records the program that is actually running, which is
 * what the session list reads to tell a Claude Code session from a shell.
 *
 * A line that needs a shell still gets one, whole and unsplit, so quoting,
 * pipes and redirects keep their normal meaning.
 */
func browserCommandArguments(command string) []string {
	if argv, ok := splitCommandLine(command); ok {
		return argv
	}
	return []string{"sh", "-c", command}
}
