//go:build windows

package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func localPipePath(id string) string {
	return `\\.\pipe\shell-online-` + id
}

func listenLocalControl(id string) (net.Listener, error) {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return nil, err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	sddl := fmt.Sprintf("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;%s)", user.User.Sid.String())
	return winio.ListenPipe(localPipePath(id), &winio.PipeConfig{
		SecurityDescriptor: sddl,
		InputBufferSize:    64 * 1024,
		OutputBufferSize:   64 * 1024,
	})
}

func dialLocalControl(id string, timeout time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return winio.DialPipeContext(ctx, localPipePath(id))
}

func cleanupLocalControl(string) {}

func ensureLocalSessionDirectory() (string, error) {
	directory, err := localSessionDirectory()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	return directory, nil
}

// localSessionDirectory holds this user's session records. The daemon's own
// lock is the named pipe, not a file here.
//
// SHELL_ONLINE_RUNTIME_DIR overrides it so a test can have a machine to
// itself, matching the unix build.
func localSessionDirectory() (string, error) {
	if override := os.Getenv("SHELL_ONLINE_RUNTIME_DIR"); override != "" {
		return override, nil
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cache, "shell.online", "sessions"), nil
}
