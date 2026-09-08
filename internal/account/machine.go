package account

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// machineIDName is the file the identifier lives in, beside the credentials.
const machineIDName = "machine-id"

// machineIDBytes is the amount of randomness behind an identifier. It is not a
// secret, but it is compared for equality across every machine an account has,
// so it is sized to never collide rather than to resist guessing.
const machineIDBytes = 32

// MachineIDPath returns where this machine's identifier belongs, given the
// path the credentials are kept at.
//
// Deriving it from the credentials path rather than the config directory means
// SHELL_ONLINE_CONFIG moves both together, so a test or a second profile gets
// its own identity instead of borrowing the real one.
func MachineIDPath(credentialsPath string) string {
	return filepath.Join(filepath.Dir(credentialsPath), machineIDName)
}

// MachineID returns the stable identifier for this machine, generating it on
// first use and reading it thereafter.
//
// The accounts service uses it to recognise a machine it has already linked,
// so that signing in again updates that machine's entry instead of adding a
// second one for the same laptop.
//
// It deliberately lives outside the credentials file: `shell logout` removes
// those, and logging out and back in is still the same machine.
//
// It names only the machine, never an account. Signing out of one account and
// into another on the same login therefore reuses the identifier, which is
// correct -- it is still the same machine -- and safe, because the service
// scopes every lookup by account before it compares identifiers. A second
// person with their own login gets their own file, since this path sits under
// the per-user config directory.
func MachineID(path string) (string, error) {
	contents, err := os.ReadFile(path)
	switch {
	case err == nil:
		// Anything the accounts service would refuse is treated as no
		// identifier at all, so a truncated or hand-edited file costs one
		// duplicate device rather than every future login silently failing to
		// match.
		if id := strings.TrimSpace(string(contents)); validMachineID(id) {
			return id, nil
		}
	case !errors.Is(err, os.ErrNotExist):
		return "", fmt.Errorf("read machine id: %w", err)
	}

	id, err := newMachineID()
	if err != nil {
		return "", err
	}
	if err := writeMachineID(path, id); err != nil {
		return "", err
	}
	return id, nil
}

func newMachineID() (string, error) {
	raw := make([]byte, machineIDBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate machine id: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// writeMachineID stores the identifier the way credentials are stored: private
// to this user, and swapped in whole so an interrupted write cannot leave a
// truncated identifier that reads as a different machine.
func writeMachineID(path, id string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, []byte(id+"\n"), 0o600); err != nil {
		return fmt.Errorf("write machine id: %w", err)
	}
	if err := secureCredentialsFile(temporary); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("restrict machine id file: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("replace machine id: %w", err)
	}
	return secureCredentialsFile(path)
}

// maxMachineIDLength matches what the accounts service accepts.
const maxMachineIDLength = 128

// validMachineID reports whether the service would accept this identifier.
// The alphabet is the one base64url produces, so a generated identifier always
// passes and anything else is not one this CLI wrote.
func validMachineID(id string) bool {
	if id == "" || len(id) > maxMachineIDLength {
		return false
	}
	for _, character := range id {
		switch {
		case character >= 'a' && character <= 'z':
		case character >= 'A' && character <= 'Z':
		case character >= '0' && character <= '9':
		case character == '-' || character == '_':
		default:
			return false
		}
	}
	return true
}
