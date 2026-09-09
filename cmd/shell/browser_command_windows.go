//go:build windows

package main

/*
 * Runs a browser-entered command as itself where that is possible; see the
 * Unix file for why.
 *
 * The fallback is PowerShell, present on every supported Windows edition.
 * Passing the line as the value of -Command preserves quoted arguments
 * without asking Go or the web app to imitate PowerShell's parser.
 */
func browserCommandArguments(command string) []string {
	if argv, ok := splitCommandLine(command); ok {
		return argv
	}
	return []string{"powershell.exe", "-NoLogo", "-NoProfile", "-Command", command}
}
