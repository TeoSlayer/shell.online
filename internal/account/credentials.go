package account

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Credentials is the on-disk record of a linked account.
type Credentials struct {
	Server       string    `json:"server"`
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
	UID          string    `json:"uid"`
	Email        string    `json:"email"`
	Name         string    `json:"name,omitempty"`

	// RemoteStart records that the person agreed, on this machine, to let
	// their signed-in browser start processes here.
	//
	// Absent means they have not. Only agreement is remembered: declining is
	// not a decision worth holding someone to, so the next login asks again,
	// while agreeing is never asked about twice.
	RemoteStart bool `json:"remote_start,omitempty"`

	// AccountKey is the account's vault public key, as this machine trusts it.
	//
	// It arrives from the signed-in browser on the login callback, which never
	// passes through the accounts service, or failing that is pinned the first
	// time the service reports one. After that a different key from the
	// service is refused rather than believed: sealing a password to a key the
	// service chose would let the service read it.
	AccountKey string `json:"account_key,omitempty"`
}

// ErrNotLinked reports that no account has been linked on this machine.
var ErrNotLinked = errors.New("not signed in")

// expiryGrace refreshes slightly early so a token cannot lapse mid-request.
const expiryGrace = 60 * time.Second

// Expired reports whether the access token needs refreshing.
func (credentials Credentials) Expired(now time.Time) bool {
	if credentials.ExpiresAt.IsZero() {
		return true
	}
	return !now.Add(expiryGrace).Before(credentials.ExpiresAt)
}

// DefaultPath is where credentials live unless SHELL_ONLINE_CONFIG overrides it.
func DefaultPath() (string, error) {
	if override := os.Getenv("SHELL_ONLINE_CONFIG"); override != "" {
		return override, nil
	}
	directory, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locate config directory: %w", err)
	}
	return filepath.Join(directory, "shell-online", "credentials.json"), nil
}

// Load reads the linked account, or ErrNotLinked when there is none.
func Load(path string) (Credentials, error) {
	var credentials Credentials
	contents, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return credentials, ErrNotLinked
		}
		return credentials, fmt.Errorf("read credentials: %w", err)
	}
	if err := json.Unmarshal(contents, &credentials); err != nil {
		return Credentials{}, fmt.Errorf("credentials file is corrupt; run 'shell login' again: %w", err)
	}
	if credentials.RefreshToken == "" {
		return Credentials{}, ErrNotLinked
	}
	return credentials, nil
}

// Save writes credentials so only the current user can read them.
func Save(path string, credentials Credentials) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	encoded, err := json.MarshalIndent(credentials, "", "  ")
	if err != nil {
		return fmt.Errorf("encode credentials: %w", err)
	}

	// Write to a sibling and rename, so an interrupted write cannot leave a
	// half-written file that would read as corrupt on the next command.
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(encoded, '\n'), 0o600); err != nil {
		return fmt.Errorf("write credentials: %w", err)
	}
	if err := secureCredentialsFile(temporary); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("restrict credentials file: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("replace credentials: %w", err)
	}
	return secureCredentialsFile(path)
}

// Clear removes the linked account. Removing an absent file is not an error.
//
// The machine-id file beside it is deliberately left alone. Signing out and
// back in is the same machine, and the identifier is what tells the accounts
// service that: dropping it here would put a second entry in the device list
// on the next login, which is the thing it exists to prevent.
func Clear(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove credentials: %w", err)
	}
	return nil
}
