//go:build !windows

package main

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/unix"
)

func waitForTerminalInput(fd int, timeout time.Duration) (bool, error) {
	if fd < 0 || int64(fd) > int64(2_147_483_647) {
		return false, fmt.Errorf("terminal file descriptor %d is outside the poll range", fd)
	}
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
