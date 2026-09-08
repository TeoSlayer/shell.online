//go:build !windows

package main

import (
	"os"
	"strconv"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

func TestBackgroundReadyDescriptorIsCloseOnExec(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()

	/*
	 * A duplicate, not writer's own descriptor.
	 *
	 * openBackgroundReadyFile wraps whatever number it is given in its own
	 * *os.File, so handing it writer's would leave two files believing they
	 * own one descriptor. Closing either frees the number for the next open
	 * anywhere in the process, and the other one closes it again when the
	 * garbage collector finalises it -- by which time it belongs to somebody
	 * else's file.
	 *
	 * That is not hypothetical. It surfaced as
	 * TestPersistentStateRejectsInvalidEncryptionMaterial failing with
	 * "close .shell-online-state-...: bad file descriptor", in another file,
	 * on a run that had nothing to do with either test.
	 *
	 * dup also clears close-on-exec, which is the state ExtraFiles leaves a
	 * descriptor in, so this is the condition being tested rather than a
	 * convenience.
	 */
	duplicate, err := unix.Dup(int(writer.Fd()))
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv(backgroundChildEnvironment, "1")
	t.Setenv(backgroundParentEnvironment, strconv.Itoa(os.Getppid()))
	t.Setenv(backgroundReadyEnvironment, strconv.Itoa(duplicate))

	ready, err := openBackgroundReadyFile()
	if err != nil {
		unix.Close(duplicate)
		t.Fatal(err)
	}
	defer ready.Close()

	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(duplicate), syscall.F_GETFD, 0)
	if errno != 0 {
		t.Fatalf("read readiness descriptor flags: %v", errno)
	}
	if flags&syscall.FD_CLOEXEC == 0 {
		t.Fatal("background readiness descriptor would leak into the wrapped process")
	}
}
