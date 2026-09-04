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
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
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
	info, err := os.Stat(directory)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return "", fmt.Errorf("local session directory is not owned by the current user")
	}
	if info.Mode().Perm() != 0o700 {
		if err := os.Chmod(directory, 0o700); err != nil {
			return "", err
		}
	}
	return directory, nil
}

func localSessionDirectory() (string, error) {
	return filepath.Join("/tmp", fmt.Sprintf("shell-online-%d", os.Getuid())), nil
}

func localSessionSocketPath(directory, id string) string {
	return filepath.Join(directory, id+".sock")
}
