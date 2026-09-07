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
