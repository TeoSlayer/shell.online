package main

import (
	"os"
	"testing"
)

// Portable across platforms: it only exercises localSessionProcessGone, which
// has a Unix (ESRCH) and a Windows (OpenProcess/WaitForSingleObject) body.
func TestLocalProcessGoneRequiresPositiveAbsence(t *testing.T) {
	if localSessionProcessGone(os.Getpid()) {
		t.Fatal("current process reported absent")
	}
	for _, pid := range []int{0, -1} {
		if localSessionProcessGone(pid) {
			t.Fatal("invalid pid reported definitively absent")
		}
	}
}
