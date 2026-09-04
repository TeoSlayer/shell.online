//go:build !windows

package main

import (
	"io"
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

type unixTerminalProcess struct {
	terminal *os.File
	command  *exec.Cmd
}

func startTerminalProcess(arguments, environment []string) (sharedTerminalProcess, error) {
	command := exec.Command(arguments[0], arguments[1:]...)
	command.Env = environment
	terminal, err := pty.StartWithSize(command, &pty.Winsize{Cols: desktopTerminalCols, Rows: desktopTerminalRows})
	if err != nil {
		return nil, err
	}
	return &unixTerminalProcess{terminal: terminal, command: command}, nil
}

func (process *unixTerminalProcess) Read(value []byte) (int, error) {
	return process.terminal.Read(value)
}
func (process *unixTerminalProcess) Write(value []byte) (int, error) {
	return process.terminal.Write(value)
}
func (process *unixTerminalProcess) Close() error         { return process.terminal.Close() }
func (process *unixTerminalProcess) Wait() error          { return process.command.Wait() }
func (process *unixTerminalProcess) Process() *os.Process { return process.command.Process }
func (process *unixTerminalProcess) Finish() error        { return nil }
func (process *unixTerminalProcess) Resize(cols, rows int) error {
	return pty.Setsize(process.terminal, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

var _ io.ReadWriteCloser = (*unixTerminalProcess)(nil)

func terminateProcess(process *os.Process, force bool) {
	if process == nil {
		return
	}
	signal := syscall.SIGTERM
	if force {
		signal = syscall.SIGKILL
	}
	if err := syscall.Kill(-process.Pid, signal); err != nil {
		_ = process.Signal(signal)
	}
}

func platformExitCode(exitError *exec.ExitError) int {
	if status, ok := exitError.Sys().(syscall.WaitStatus); ok {
		if status.Signaled() {
			return 128 + int(status.Signal())
		}
		return status.ExitStatus()
	}
	return exitError.ExitCode()
}

func defaultShellCommand() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	return "/bin/sh"
}
