//go:build windows

package main

import (
	"fmt"
	"io"
)

func startLocalSession(localSessionRecord) (localSessionControl, error) {
	return nil, fmt.Errorf("local session management is not available on Windows")
}

func loadActiveLocalSessions() ([]localSessionRecord, error) {
	return nil, fmt.Errorf("local session management is not available on Windows")
}

func requestLocalSessionStop(string) error {
	return fmt.Errorf("local session management is not available on Windows")
}

func requestLocalSessionResize(string, int, int) error {
	return fmt.Errorf("local session management is not available on Windows")
}

func attachLocalSession(string, io.Writer, io.Writer) error {
	return fmt.Errorf("local session management is not available on Windows")
}
