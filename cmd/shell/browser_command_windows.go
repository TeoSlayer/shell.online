//go:build windows

package main

// Windows PowerShell is present on every supported Windows edition. Passing
// the command as the value of -Command preserves quoted arguments without
// asking Go or the web app to imitate PowerShell's parser.
func browserCommandArguments(command string) []string {
	return []string{"powershell.exe", "-NoLogo", "-NoProfile", "-Command", command}
}
