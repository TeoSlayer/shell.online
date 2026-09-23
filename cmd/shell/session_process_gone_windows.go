//go:build windows

package main

import (
	"errors"

	"golang.org/x/sys/windows"
)

func localSessionProcessGone(pid int) bool {
	if pid <= 0 || uint64(pid) > 1<<32-1 {
		return false
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return errors.Is(err, windows.ERROR_INVALID_PARAMETER)
	}
	defer windows.CloseHandle(handle)
	status, err := windows.WaitForSingleObject(handle, 0)
	return err == nil && status == windows.WAIT_OBJECT_0
}
