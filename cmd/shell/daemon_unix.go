//go:build !windows

package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// The daemon's lock and socket live beside the session sockets, in a directory
// this user owns, so the same ownership check guards all of them.
func daemonPath(name string) (string, error) {
	directory, err := localSessionDirectory()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, name), nil
}

func daemonSocketPath() (string, error) { return daemonPath("daemon.sock") }

// daemonLock is the exclusive right to be this machine's daemon.
type daemonLock struct{ file *os.File }

// acquireDaemonLock takes an advisory lock on a file, held for the life of the
// process.
//
// The socket cannot serve as the lock. A daemon killed outright leaves the
// socket file behind, and a start that reacted by deleting it would race
// another start doing the same: both would bind, one onto an inode nobody can
// reach, and the machine would have two pollers. The browser seals a session
// password to a single key, so the second poller receives commands it cannot
// open.
//
// flock has neither problem. The kernel releases it when the process dies,
// however it dies, and grants it to exactly one holder.
func acquireDaemonLock() (*daemonLock, error) {
	if _, err := ensureLocalSessionDirectory(); err != nil {
		return nil, err
	}
	path, err := daemonPath("daemon.lock")
	if err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	// x/sys/unix rather than syscall: syscall.Flock is absent on Solaris, which
	// is a supported platform here, so the build broke everywhere the release
	// matrix reaches past Linux and the BSDs.
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, errDaemonAlreadyRunning
		}
		return nil, fmt.Errorf("lock the daemon: %w", err)
	}
	return &daemonLock{file: file}, nil
}

func (lock *daemonLock) release() {
	if lock == nil || lock.file == nil {
		return
	}
	_ = unix.Flock(int(lock.file.Fd()), unix.LOCK_UN)
	_ = lock.file.Close()
}

// listenDaemonControl binds the control socket.
//
// Safe to remove whatever is at the path first, because the caller holds the
// lock: anything there is left over from a daemon that is gone.
func listenDaemonControl() (net.Listener, error) {
	if _, err := ensureLocalSessionDirectory(); err != nil {
		return nil, err
	}
	path, err := daemonSocketPath()
	if err != nil {
		return nil, err
	}
	// A unix socket path lives in a fixed-size field in the kernel: 104 bytes
	// on the BSDs, 108 on Linux. Over that, bind fails with "invalid
	// argument", which describes nothing a person could act on.
	if len(path) >= 104 {
		return nil, fmt.Errorf(
			"the socket path is too long for the operating system (%d of 103 bytes): %s\n"+
				"Set SHELL_ONLINE_RUNTIME_DIR to a shorter directory", len(path), path)
	}
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

func dialDaemonControl(timeout time.Duration) (net.Conn, error) {
	path, err := daemonSocketPath()
	if err != nil {
		return nil, err
	}
	return net.DialTimeout("unix", path, timeout)
}

func cleanupDaemonControl() {
	if path, err := daemonSocketPath(); err == nil {
		_ = os.Remove(path)
	}
}

// startDetachedDaemon launches the daemon and returns without waiting.
//
// Setsid so it outlives the terminal that happened to start it, and the null
// device on all three streams so it never writes into somebody's session.
func startDetachedDaemon(self string) {
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return
	}
	defer null.Close()

	command := exec.Command(self, "daemon")
	command.Env = os.Environ()
	command.Stdin = null
	command.Stdout = null
	command.Stderr = null
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return
	}
	// Released rather than waited on: this process is about to do something
	// else, and the daemon is not its child to reap.
	_ = command.Process.Release()
}
