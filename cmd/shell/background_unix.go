//go:build !windows

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func launchBackgroundProcess(arguments []string, jsonOutput bool, stdout, stderr io.Writer) int {
	_ = stdout
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintf(stderr, "shell: locate executable: %v\n", err)
		return 1
	}

	readyReader, readyWriter, err := os.Pipe()
	if err != nil {
		fmt.Fprintf(stderr, "shell: create background channel: %v\n", err)
		return 1
	}
	defer readyReader.Close()

	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		_ = readyWriter.Close()
		fmt.Fprintf(stderr, "shell: open null device: %v\n", err)
		return 1
	}

	command := exec.Command(executable, arguments...)
	command.Env = setEnvironmentValue(os.Environ(), backgroundChildEnvironment, "1")
	command.Env = setEnvironmentValue(command.Env, backgroundReadyEnvironment, "3")
	command.Env = setEnvironmentValue(command.Env, backgroundParentEnvironment, fmt.Sprint(os.Getpid()))
	command.Stdin = null
	command.Stdout = null
	command.Stderr = null
	command.ExtraFiles = []*os.File{readyWriter}
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		_ = readyWriter.Close()
		_ = null.Close()
		fmt.Fprintf(stderr, "shell: start in background: %v\n", err)
		return 1
	}
	_ = readyWriter.Close()
	_ = null.Close()
	_ = readyReader.SetReadDeadline(time.Now().Add(20 * time.Second))

	stopAnimation := func() {}
	if !jsonOutput {
		stopAnimation = startSessionAnimation(stderr)
	}
	var result backgroundLaunchResult
	decodeError := json.NewDecoder(io.LimitReader(readyReader, 16*1024)).Decode(&result)
	stopAnimation()
	if decodeError != nil {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		fmt.Fprintf(stderr, "shell: background session did not start: %v\n", decodeError)
		return 1
	}
	if !result.OK {
		if result.Error == "" {
			result.Error = "unknown startup error"
		}
		if result.ExitCode != nil {
			_, _ = command.Process.Wait()
			fmt.Fprintf(stderr, "shell: %s\n", result.Error)
			return *result.ExitCode
		}
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		fmt.Fprintf(stderr, "shell: background session did not start: %s\n", result.Error)
		return 1
	}
	if err := command.Process.Release(); err != nil {
		fmt.Fprintf(stderr, "shell: release background process: %v\n", err)
		return 1
	}

	if jsonOutput {
		event := map[string]any{
			"type":       "session",
			"session_id": result.ID,
			"share_url":  result.ShareURL,
			"read_only":  result.ReadOnly,
			"encrypted":  result.Encrypted,
			"persistent": result.Persistent,
			"auto_close": "task",
			"expires_at": result.ExpiresAt.Format(time.RFC3339),
			"background": true,
		}
		if result.Password != "" {
			event["e2ee_password"] = result.Password
		}
		if result.ClosesAt != nil {
			event["auto_close"] = "deadline"
			event["closes_at"] = result.ClosesAt.Format(time.RFC3339)
		}
		if result.Handoff != "" {
			event["handoff"] = result.Handoff
		}
		encoded, _ := json.Marshal(event)
		fmt.Fprintf(stderr, "%s\n", encoded)
		return 0
	}

	printSessionCard(stderr, result, true)
	return 0
}
