//go:build darwin

package main

import (
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// A LaunchAgent, so it runs as the person who installed it and starts when
// they log in. Not a LaunchDaemon: this holds one account's credentials and
// starts processes as that person, so it has no business running as root or
// before anybody has logged in.

func servicePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", serviceLabel+".plist"), nil
}

func serviceInstalled() (string, bool) {
	path, err := servicePath()
	if err != nil {
		return "", false
	}
	if _, err := os.Stat(path); err != nil {
		return path, false
	}
	return path, true
}

// plistEscape renders a string as XML character data.
//
// A home directory can contain an ampersand, and hand-rolled XML that does not
// escape one produces a plist launchd silently refuses to load.
func plistEscape(value string) string {
	var builder strings.Builder
	_ = xml.EscapeText(&builder, []byte(value))
	return builder.String()
}

func servicePlist(self string, environment map[string]string) string {
	var variables strings.Builder
	if len(environment) > 0 {
		variables.WriteString("  <key>EnvironmentVariables</key>\n  <dict>\n")
		// Sorted, so reinstalling produces the same file rather than a diff.
		for _, name := range servicePassthrough {
			value, ok := environment[name]
			if !ok {
				continue
			}
			fmt.Fprintf(&variables, "    <key>%s</key>\n    <string>%s</string>\n",
				plistEscape(name), plistEscape(value))
		}
		variables.WriteString("  </dict>\n")
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + plistEscape(serviceLabel) + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + plistEscape(self) + `</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restarted if it exits, but throttled: a daemon that cannot start should
       not be relaunched in a tight loop for the rest of the session. -->
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
` + variables.String() + `  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}

func installService(self string, environment map[string]string) (string, error) {
	path, err := servicePath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("create the LaunchAgents directory: %w", err)
	}
	if err := os.WriteFile(path, []byte(servicePlist(self, environment)), 0o644); err != nil {
		return "", fmt.Errorf("write the launch agent: %w", err)
	}

	target := fmt.Sprintf("gui/%d", os.Getuid())
	// Booted out first so a reinstall picks up the new file rather than
	// leaving the old definition loaded.
	_ = exec.Command("launchctl", "bootout", target+"/"+serviceLabel).Run()
	if output, err := exec.Command("launchctl", "bootstrap", target, path).CombinedOutput(); err != nil {
		return "", fmt.Errorf("load the launch agent: %v: %s", err, strings.TrimSpace(string(output)))
	}
	return path, nil
}

// restartService asks launchd to replace the running daemon.
//
// A daemon that launchd started is launchd's to replace: stopping it and
// spawning a detached one leaves two supervisors for one process, and the
// KeepAlive would bring launchd's back anyway.
//
// It is not waited on. `kickstart -k` kills the job and then blocks until it
// is running again, and the agent sets ThrottleInterval to ten seconds, so
// waiting costs eleven seconds of a silent terminal at the end of a login that
// has already succeeded -- which is exactly what "shell login hangs" looked
// like. Nothing here needs the answer: the daemon comes back on launchd's
// schedule and reads the credentials that are already on disk, and the only
// thing the caller has to know is that a supervisor owns this daemon, which
// serviceInstalled has already said.
//
// The report is therefore whether the request was made, not whether the
// restart finished. A launchctl that will not start at all is worth falling
// back from, because a detached daemon beside a stalled agent is better than
// no daemon at all.
func restartService() bool {
	if _, installed := serviceInstalled(); !installed {
		return false
	}
	target := fmt.Sprintf("gui/%d/%s", os.Getuid(), serviceLabel)
	command := exec.Command("launchctl", "kickstart", "-k", target)
	if err := command.Start(); err != nil {
		return false
	}
	_ = command.Process.Release()
	return true
}

func uninstallService() (bool, error) {
	path, installed := serviceInstalled()
	if !installed {
		return false, nil
	}
	_ = exec.Command("launchctl", "bootout", fmt.Sprintf("gui/%d/%s", os.Getuid(), serviceLabel)).Run()
	if err := os.Remove(path); err != nil {
		return false, fmt.Errorf("remove the launch agent: %w", err)
	}
	return true, nil
}
