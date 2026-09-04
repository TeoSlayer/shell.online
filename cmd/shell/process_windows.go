//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"unsafe"

	"github.com/aymanbagabas/go-pty"
	"golang.org/x/sys/windows"
)

type windowsTerminalProcess struct {
	terminal   pty.ConPty
	command    *pty.Cmd
	handle     windows.Handle
	job        windows.Handle
	finishOnce sync.Once
	closeOnce  sync.Once
	closeError error
}

func startTerminalProcess(arguments, environment []string) (sharedTerminalProcess, error) {
	terminal, err := pty.New()
	if err != nil {
		return nil, err
	}
	if err := terminal.Resize(desktopTerminalCols, desktopTerminalRows); err != nil {
		_ = terminal.Close()
		return nil, err
	}
	command := terminal.Command(arguments[0], arguments[1:]...)
	command.Env = environment
	if err := command.Start(); err != nil {
		_ = terminal.Close()
		return nil, err
	}
	conPTY, ok := terminal.(pty.ConPty)
	if !ok {
		_ = terminal.Close()
		return nil, pty.ErrUnsupported
	}
	// A job object makes shell kill terminate descendants as well as the root.
	// Very short commands can exit before Windows allows assignment; the PTY is
	// still valid in that case and the normal process wait reports its status.
	job, _ := createProcessJob(command.Process.Pid)
	return &windowsTerminalProcess{terminal: conPTY, command: command, handle: windows.Handle(terminal.Fd()), job: job}, nil
}

func (process *windowsTerminalProcess) Read(value []byte) (int, error) {
	return process.terminal.Read(value)
}
func (process *windowsTerminalProcess) Write(value []byte) (int, error) {
	return process.terminal.Write(value)
}
func (process *windowsTerminalProcess) Finish() error {
	process.finishOnce.Do(func() {
		if process.job != 0 {
			_ = windows.CloseHandle(process.job)
		}
		windows.ClosePseudoConsole(process.handle)
	})
	return nil
}
func (process *windowsTerminalProcess) Close() error {
	process.closeOnce.Do(func() {
		_ = process.Finish()
		process.closeError = errors.Join(process.terminal.InputPipe().Close(), process.terminal.OutputPipe().Close())
	})
	return process.closeError
}
func (process *windowsTerminalProcess) Resize(cols, rows int) error {
	return process.terminal.Resize(cols, rows)
}
func (process *windowsTerminalProcess) Wait() error          { return process.command.Wait() }
func (process *windowsTerminalProcess) Process() *os.Process { return process.command.Process }

func createProcessJob(processID int) (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	processHandle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(processID))
	if err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	defer windows.CloseHandle(processHandle)
	if err := windows.AssignProcessToJobObject(job, processHandle); err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func terminateProcess(process *os.Process, _ bool) {
	if process != nil {
		_ = process.Kill()
	}
}

func platformExitCode(exitError *exec.ExitError) int {
	return exitError.ExitCode()
}

func defaultShellCommand() string {
	for _, candidate := range []string{"pwsh.exe", "powershell.exe"} {
		if path, err := exec.LookPath(candidate); err == nil {
			return path
		}
	}
	if shell := os.Getenv("COMSPEC"); shell != "" {
		return shell
	}
	return "cmd.exe"
}
