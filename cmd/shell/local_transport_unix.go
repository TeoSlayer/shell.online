//go:build !windows

package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func listenLocalControl(id string) (net.Listener, error) {
	directory, err := localSessionDirectory()
	if err != nil {
		return nil, err
	}
	path := localSessionSocketPath(directory, id)
	listener, err := net.Listen("unix", path)
	if err == nil {
		return secureLocalControlSocket(path, listener)
	}
	// A denied/timed-out dial cannot distinguish a stale socket from a live
	// listener. Even ECONNREFUSED is only a snapshot: another host can bind
	// before an unlink. Startup never removes an existing control path.
	return nil, fmt.Errorf("local control channel is already active or unavailable; refusing automatic removal: %w", err)
}

func secureLocalControlSocket(path string, listener net.Listener) (net.Listener, error) {
	if err := os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		_ = os.Remove(path)
		return nil, err
	}
	return listener, nil
}

func dialLocalControl(id string, timeout time.Duration) (net.Conn, error) {
	directory, err := localSessionDirectory()
	if err != nil {
		return nil, err
	}
	return net.DialTimeout("unix", localSessionSocketPath(directory, id), timeout)
}

func cleanupLocalControl(id string) {
	directory, err := localSessionDirectory()
	if err == nil {
		_ = os.Remove(localSessionSocketPath(directory, id))
	}
}

func ensureLocalSessionDirectory() (string, error) {
	directory, err := localSessionDirectory()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || !ok || int(stat.Uid) != os.Getuid() {
		return "", fmt.Errorf("local session directory is not owned by the current user")
	}
	if info.Mode().Perm() != 0o700 {
		if err := os.Chmod(directory, 0o700); err != nil {
			return "", err
		}
	}
	return directory, nil
}

// existingLocalSessionDirectory reports the runtime directory only when it is a
// private directory owned by the current user. Discovery must not create it:
// a missing directory means there is nothing to observe, and a directory that
// is not ours is not ours to rewrite.
func existingLocalSessionDirectory() (string, error) {
	directory, err := localSessionDirectory()
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || !ok || int(stat.Uid) != os.Getuid() || info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("local session directory is not private to the current user")
	}
	return directory, nil
}

// localSessionDirectory holds the control sockets for this user's sessions and
// the daemon lock beside them.
//
// A fixed path, because every shell command has to find the same one without
// being told. SHELL_ONLINE_RUNTIME_DIR overrides it so a test can have a
// machine to itself: without that, two tests -- or a test and the daemon the
// developer is actually running -- contend for one lock.
func localSessionDirectory() (string, error) {
	if override := os.Getenv("SHELL_ONLINE_RUNTIME_DIR"); override != "" {
		return override, nil
	}
	return filepath.Join("/tmp", fmt.Sprintf("shell-online-%d", os.Getuid())), nil
}

func localSessionSocketPath(directory, id string) string {
	return filepath.Join(directory, id+".sock")
}
