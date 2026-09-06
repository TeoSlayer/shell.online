package account

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// OpenBrowser asks the desktop to open a URL.
//
// Only http and https are opened. Handing an arbitrary scheme to the system
// opener would let a malformed server response run a local handler.
func OpenBrowser(target string) error {
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		return fmt.Errorf("refusing to open non-http URL")
	}

	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", target)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		command = exec.Command("xdg-open", target)
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("open browser: %w", err)
	}
	// Reap the child rather than leaving a zombie behind for the session's life.
	go func() { _ = command.Wait() }()
	return nil
}
