//go:build !windows

package main

import (
	"errors"
	"time"

	"golang.org/x/sys/unix"
)

func waitForTerminalInput(fd int, timeout time.Duration) (bool, error) {
	milliseconds := max(1, int((timeout+time.Millisecond-1)/time.Millisecond))
	descriptors := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	for {
		_, err := unix.Poll(descriptors, milliseconds)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return false, err
		}
		return descriptors[0].Revents&unix.POLLIN != 0, nil
	}
}
