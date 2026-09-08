//go:build !windows

package main

// Browser-entered commands use POSIX shell syntax on Unix. The command stays
// one argument all the way to sh; exec never splits or re-quotes it.
func browserCommandArguments(command string) []string {
	return []string{"sh", "-c", command}
}
