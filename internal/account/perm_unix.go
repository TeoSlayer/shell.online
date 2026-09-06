//go:build !windows

package account

import "os"

func secureCredentialsFile(path string) error {
	return os.Chmod(path, 0o600)
}
