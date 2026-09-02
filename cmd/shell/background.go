package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

const (
	backgroundChildEnvironment  = "SHELL_ONLINE_BACKGROUND_CHILD"
	backgroundReadyEnvironment  = "SHELL_ONLINE_READY_FD"
	backgroundParentEnvironment = "SHELL_ONLINE_BACKGROUND_PARENT_PID"
)

type backgroundLaunchResult struct {
	OK         bool       `json:"ok"`
	Error      string     `json:"error,omitempty"`
	ID         string     `json:"session_id,omitempty"`
	ShareURL   string     `json:"share_url,omitempty"`
	ReadOnly   bool       `json:"read_only,omitempty"`
	Encrypted  bool       `json:"encrypted,omitempty"`
	Password   string     `json:"e2ee_password,omitempty"`
	Persistent bool       `json:"persistent,omitempty"`
	ExpiresAt  time.Time  `json:"expires_at,omitempty"`
	ClosesAt   *time.Time `json:"closes_at,omitempty"`
	Handoff    string     `json:"handoff,omitempty"`
	ExitCode   *int       `json:"exit_code,omitempty"`
}

func isBackgroundChild() bool {
	if os.Getenv(backgroundChildEnvironment) != "1" {
		return false
	}
	parentPID, err := strconv.Atoi(os.Getenv(backgroundParentEnvironment))
	return err == nil && parentPID > 0 && parentPID == os.Getppid()
}

func openBackgroundReadyFile() (*os.File, error) {
	if !isBackgroundChild() {
		return nil, nil
	}
	fileDescriptor, err := strconv.Atoi(os.Getenv(backgroundReadyEnvironment))
	if err != nil || fileDescriptor < 3 {
		return nil, fmt.Errorf("invalid background readiness channel")
	}
	file := os.NewFile(uintptr(fileDescriptor), "shell-online-ready")
	if file == nil {
		return nil, fmt.Errorf("open background readiness channel")
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("open background readiness channel: %w", err)
	}
	if info.Mode()&os.ModeNamedPipe == 0 {
		_ = file.Close()
		return nil, fmt.Errorf("invalid background readiness channel")
	}
	return file, nil
}
