//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// currentUserSID identifies the account this process runs as.
//
// The pipe namespace is machine-wide, so the name has to carry it: two people
// signed in to the same machine each need their own daemon, and a shared name
// would mean the second one simply fails to start.
func currentUserSID() (string, error) {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

func daemonPipePath() (string, error) {
	sid, err := currentUserSID()
	if err != nil {
		return "", err
	}
	return `\\.\pipe\shell-online-daemon-` + sid, nil
}

// daemonLock exists to match the unix build, where an advisory lock decides
// who the daemon is. Here the pipe already does it: a named pipe disappears
// with the process that held it, so there is no stale state to mistake for a
// running daemon and nothing separate to take.
type daemonLock struct{}

func acquireDaemonLock() (*daemonLock, error) { return &daemonLock{}, nil }

func (lock *daemonLock) release() {}

// listenDaemonControl binds the pipe that makes this process the daemon.
//
// A failure to bind means a daemon really is running.
func listenDaemonControl() (net.Listener, error) {
	path, err := daemonPipePath()
	if err != nil {
		return nil, err
	}
	sid, err := currentUserSID()
	if err != nil {
		return nil, err
	}
	sddl := fmt.Sprintf("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;%s)", sid)
	listener, err := winio.ListenPipe(path, &winio.PipeConfig{
		SecurityDescriptor: sddl,
		InputBufferSize:    16 * 1024,
		OutputBufferSize:   16 * 1024,
	})
	if err != nil {
		// The name is already taken, which here means by a daemon. Reported as
		// the same condition the unix lock reports, so the caller has one case
		// to handle rather than one per platform.
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_PIPE_BUSY) {
			return nil, errDaemonAlreadyRunning
		}
		return nil, err
	}
	return listener, nil
}

func dialDaemonControl(timeout time.Duration) (net.Conn, error) {
	path, err := daemonPipePath()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return winio.DialPipeContext(ctx, path)
}

func cleanupDaemonControl() {}

// startDetachedDaemon launches the daemon and returns without waiting.
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
	command.SysProcAttr = &windows.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
	}
	if err := command.Start(); err != nil {
		return
	}
	_ = command.Process.Release()
}
