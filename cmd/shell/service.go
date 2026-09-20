package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"shell.online/internal/account"
)

// The daemon comes back on its own whenever any shell command runs, which
// covers a crash and covers a reboot the moment somebody uses the tool. It
// does not cover the machine that is signed in and sitting idle after a
// restart -- the one somebody wants to reach from a browser precisely because
// they are not at it.
//
// A user service closes that gap. It is separate from consent: agreeing that a
// browser may start sessions here is a different question from wanting the
// operating system to keep a process alive, and someone may reasonably want
// the first without the second.

// serviceLabel identifies the unit to the operating system.
const serviceLabel = "online.shell.daemon"

// errServiceUnsupported is what a platform with no installer returns.
//
// Declared here rather than beside the one implementation that returns it, so
// that a caller which merely wants to stay quiet about it -- the first login --
// can say so on every platform.
var errServiceUnsupported = errors.New(
	"installing a background service is not supported on this platform yet.\n" +
		"The daemon still starts whenever you run a shell command")

// servicePassthrough are the variables a service inherits nothing of.
//
// A service starts from the operating system, not from a shell, so it sees
// none of the environment the person who installed it had. Carrying these
// across is what lets the daemon be installed against a local stack; in
// production they are all unset and the defaults apply.
var servicePassthrough = []string{
	"SHELL_ONLINE_LOCAL",
	"SHELL_ONLINE_ACCOUNTS",
	"SHELL_ONLINE_SERVER",
	"SHELL_ONLINE_WEB",
	"SHELL_ONLINE_CONFIG",
	"SHELL_ONLINE_RUNTIME_DIR",
}

func serviceEnvironment() map[string]string {
	values := map[string]string{}
	for _, name := range servicePassthrough {
		if value := os.Getenv(name); value != "" {
			values[name] = value
		}
	}
	return values
}

func runServiceCommand(arguments []string, stdout, stderr io.Writer) int {
	verb := ""
	if len(arguments) > 0 {
		verb = arguments[0]
	}
	switch verb {
	case "install":
		return installServiceCommand(stdout, stderr)
	case "uninstall", "remove":
		return uninstallServiceCommand(stdout, stderr)
	case "status":
		return serviceStatusCommand(stdout)
	default:
		fmt.Fprintln(stderr, "Usage: shell service install | uninstall | status")
		fmt.Fprintln(stderr, "Keeps this machine reachable from your browser across restarts.")
		return 2
	}
}

// installDaemonService writes and loads the user service for this binary.
//
// Shared by `shell service install` and by the first login, so the two cannot
// disagree about when installing one is a bad idea.
func installDaemonService() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locate this binary: %w", err)
	}
	// A service points at a path, so a binary that moves leaves one pointing
	// at nothing. Worth saying before it happens rather than after.
	if strings.HasPrefix(self, os.TempDir()) {
		return "", fmt.Errorf("%s looks temporary. Install shell somewhere permanent first", self)
	}
	/*
	 * Never from a test binary. Installing one would hand the operating
	 * system a path under the build cache and ask it to keep running it,
	 * which is the supervised version of the fork bomb daemon.go guards
	 * against. The temporary-path check above already catches the usual
	 * layout; this catches the rest.
	 */
	if isGoTestBinary(self) {
		return "", errors.New("a test binary is never installed as a service")
	}
	return installService(self, serviceEnvironment())
}

func installServiceCommand(stdout, stderr io.Writer) int {
	path, err := account.DefaultPath()
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	credentials, err := account.Load(path)
	if errors.Is(err, account.ErrNotLinked) {
		fmt.Fprintln(stderr, "shell: not signed in. Run 'shell auth' first.")
		return 1
	}
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	// Installing a service for a machine that does not accept remote starts
	// would keep a process alive to do nothing.
	if !credentials.RemoteStart {
		fmt.Fprintln(stderr, "shell: this machine does not accept sessions started from the browser.")
		fmt.Fprintln(stderr, "Run 'shell daemon start' to allow it, then install the service.")
		return 1
	}

	written, err := installDaemonService()
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "Installed %s\n", written)
	fmt.Fprintln(stdout, "This machine stays reachable from your browser across restarts.")
	fmt.Fprintln(stdout, "Remove it with 'shell service uninstall'.")
	return 0
}

func uninstallServiceCommand(stdout, stderr io.Writer) int {
	removed, err := uninstallService()
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	if !removed {
		fmt.Fprintln(stdout, "No service is installed.")
		return 0
	}
	fmt.Fprintln(stdout, "Removed. The daemon still starts when you run a shell command.")
	return 0
}

func serviceStatusCommand(stdout io.Writer) int {
	path, installed := serviceInstalled()
	if !installed {
		fmt.Fprintln(stdout, "No service is installed.")
		fmt.Fprintln(stdout, "The daemon starts when you run a shell command, and stops with a restart.")
		return 1
	}
	fmt.Fprintf(stdout, "Installed at %s\n", path)
	return 0
}
