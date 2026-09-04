//go:build !windows

package main

import (
	"fmt"
	"os"
)

func validatePrivateStateFile(_ string, info os.FileInfo) error {
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("persistent state must not be accessible by group or other users")
	}
	return nil
}

func replaceFileAtomically(source, destination string) error {
	return os.Rename(source, destination)
}

func securePrivateStateFile(path string) error {
	return os.Chmod(path, 0o600)
}
