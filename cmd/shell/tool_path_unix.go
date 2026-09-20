//go:build !windows

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/user"
	"runtime"
)

/**
 * Asks the login shell what PATH a terminal here would have.
 *
 * Interactive as well as login (`-i`), which looks excessive and is the whole
 * point: a version manager is a function defined in an interactive rc file,
 * and two of the four harnesses are installed by one. A login-only shell finds
 * neither.
 *
 * The shell is the user's own and the files are their own, so this is the same
 * code that runs when they open a terminal. It is given a deadline because an
 * rc file that waits for something -- a prompt, a network call -- must not
 * keep the daemon from starting; a timeout costs the conventional directories
 * instead of the real answer.
 */
func probeLoginShellPath(ctx context.Context) (string, error) {
	shell := loginShell()
	if shell == "" {
		return "", errors.New("no login shell to ask")
	}

	command := exec.CommandContext(ctx, shell, "-lic", loginShellScript)
	/*
	 * No terminal, and nothing to read. An interactive shell with a pipe for
	 * stdin reaches end of file and exits, which is what is wanted; without
	 * this it can inherit the daemon's own stdin and sit there.
	 */
	command.Stdin = nil
	output, err := command.Output()
	found := pathBetweenMarkers(string(output))
	if found != "" {
		/*
		 * Answered, whatever else it did. An rc file that ends in a non-zero
		 * status is somebody's normal Tuesday and says nothing about the PATH
		 * it printed on the way.
		 */
		return found, nil
	}
	if err != nil {
		return "", err
	}
	return "", errors.New("the login shell printed no PATH")
}

/** The user's shell: what they are logged in with, then what the system says. */
func loginShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	/*
	 * A service is not started by a shell, so SHELL is often unset under
	 * launchd and systemd -- which is exactly the case this file exists for.
	 * The account record knows.
	 */
	if current, err := user.Current(); err == nil && current.Username != "" {
		if shell := shellFromPasswd(current.Username); shell != "" {
			return shell
		}
	}
	if runtime.GOOS == "darwin" {
		return "/bin/zsh"
	}
	return "/bin/sh"
}
