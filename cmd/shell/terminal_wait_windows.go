//go:build windows

package main

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows"
)

func waitForTerminalInput(fd int, timeout time.Duration) (bool, error) {
	milliseconds := uint32(max(1, int((timeout+time.Millisecond-1)/time.Millisecond)))
	status, err := windows.WaitForSingleObject(windows.Handle(fd), milliseconds)
	if err != nil {
		return false, err
	}
	switch status {
	case windows.WAIT_OBJECT_0:
		return true, nil
	case uint32(windows.WAIT_TIMEOUT):
		return false, nil
	default:
		return false, fmt.Errorf("wait for terminal input: status %#x", status)
	}
}
