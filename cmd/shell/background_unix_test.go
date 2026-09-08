//go:build !windows

package main

import (
	"os"
	"strconv"
	"syscall"
	"testing"
)

func TestBackgroundReadyDescriptorIsCloseOnExec(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	t.Setenv(backgroundChildEnvironment, "1")
	t.Setenv(backgroundParentEnvironment, strconv.Itoa(os.Getppid()))
	t.Setenv(backgroundReadyEnvironment, strconv.Itoa(int(writer.Fd())))

	ready, err := openBackgroundReadyFile()
	if err != nil {
		t.Fatal(err)
	}
	defer ready.Close()

	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, writer.Fd(), syscall.F_GETFD, 0)
	if errno != 0 {
		t.Fatalf("read readiness descriptor flags: %v", errno)
	}
	if flags&syscall.FD_CLOEXEC == 0 {
		t.Fatal("background readiness descriptor would leak into the wrapped process")
	}
}
