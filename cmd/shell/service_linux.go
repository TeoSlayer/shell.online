//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// A systemd user unit, so it runs as the person who installed it. Not a system
// unit: this holds one account's credentials and starts processes as that
// person.

func servicePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "systemd", "user", "shell-online.service"), nil
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

func serviceUnit(self string, environment map[string]string) string {
	var variables strings.Builder
	// Sorted, so reinstalling produces the same file rather than a diff.
	for _, name := range servicePassthrough {
		value, ok := environment[name]
		if !ok {
			continue
		}
		fmt.Fprintf(&variables, "Environment=%s=%s\n", name, value)
	}

	return `[Unit]
Description=shell.online daemon
Documentation=https://shell.online
After=network-online.target

[Service]
Type=simple
ExecStart=` + self + ` daemon
# Restarted if it exits, but throttled: a daemon that cannot start should not
# be relaunched in a tight loop.
Restart=always
RestartSec=10
` + variables.String() + `
[Install]
WantedBy=default.target
`
}

func installService(self string, environment map[string]string) (string, error) {
	path, err := servicePath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("create the systemd user directory: %w", err)
	}
	if err := os.WriteFile(path, []byte(serviceUnit(self, environment)), 0o644); err != nil {
		return "", fmt.Errorf("write the unit: %w", err)
	}

	if output, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
		return "", fmt.Errorf("reload systemd: %v: %s", err, strings.TrimSpace(string(output)))
	}
	if output, err := exec.Command("systemctl", "--user", "enable", "--now", "shell-online.service").CombinedOutput(); err != nil {
		return "", fmt.Errorf("enable the unit: %v: %s", err, strings.TrimSpace(string(output)))
	}
	// Without lingering, a user's units stop when their last session ends,
	// which on a server is most of the time. Saying so is better than a
	// machine that is reachable only while somebody is logged in over SSH.
	if output, err := exec.Command("loginctl", "show-user", os.Getenv("USER"), "-p", "Linger", "--value").Output(); err == nil {
		if strings.TrimSpace(string(output)) != "yes" {
			fmt.Fprintf(os.Stderr,
				"shell: this machine will stop being reachable when you log out.\n"+
					"Run 'sudo loginctl enable-linger %s' to keep it running.\n", os.Getenv("USER"))
		}
	}
	return path, nil
}

func uninstallService() (bool, error) {
	path, installed := serviceInstalled()
	if !installed {
		return false, nil
	}
	_ = exec.Command("systemctl", "--user", "disable", "--now", "shell-online.service").Run()
	if err := os.Remove(path); err != nil {
		return false, fmt.Errorf("remove the unit: %w", err)
	}
	_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	return true, nil
}
