package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"shell.online/internal/api"
	"shell.online/internal/e2ee"
)

type persistentSessionState struct {
	Version         int    `json:"version"`
	ID              string `json:"session_id"`
	HostToken       string `json:"host_token"`
	ReadOnly        bool   `json:"read_only"`
	Encrypted       bool   `json:"encrypted"`
	Fragment        string `json:"fragment"`
	EncryptionKey   string `json:"encryption_key"`
	BrowserPassword string `json:"browser_password,omitempty"`
}

var persistentFragmentPattern = regexp.MustCompile(`^#(?:key=[A-Za-z0-9_-]{43}|salt=[A-Za-z0-9_-]{22})$`)

type preparedPersistentSession struct {
	state    persistentSessionState
	password string
	cipher   *e2ee.Cipher
	created  bool
	prior    []byte
}

// preparePersistentSession is read-only: every credential and encryption
// material is checked before reserving local control or contacting the relay.
func preparePersistentSession(path string, readOnly, encrypted bool, password string) (*preparedPersistentSession, error) {
	state, prior, err := readPersistentStateSnapshot(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	created := os.IsNotExist(err)
	if created {
		state = persistentSessionState{Version: 1, ReadOnly: readOnly, Encrypted: encrypted}
		state.HostToken, err = randomPersistentToken(32)
		if err != nil {
			return nil, err
		}
		state.ID = persistentSessionID(state.HostToken)
		if encrypted {
			if password == "" {
				password, err = e2ee.GenerateBrowserPassword()
				if err != nil {
					return nil, err
				}
			}
			if err := e2ee.ValidateBrowserPassword(password); err != nil {
				return nil, err
			}
			var key []byte
			var keyError error
			_, state.Fragment, key, keyError = e2ee.GenerateMaterial(password)
			if keyError != nil {
				return nil, keyError
			}
			state.EncryptionKey = base64.RawURLEncoding.EncodeToString(key)
			state.BrowserPassword = password
		}
	} else if state.Version != 1 || state.ReadOnly != readOnly || state.Encrypted != encrypted {
		return nil, fmt.Errorf("persistent state access/encryption mode does not match the requested flags")
	}
	if encrypted && !created && len(state.Fragment) > len("#salt=") && state.Fragment[:len("#salt=")] == "#salt=" {
		if state.BrowserPassword != "" {
			if err := e2ee.ValidateBrowserPassword(state.BrowserPassword); err != nil {
				return nil, fmt.Errorf("persistent state browser password: %w", err)
			}
			if password != "" && password != state.BrowserPassword {
				return nil, fmt.Errorf("persistent state password does not match SHELL_ONLINE_E2EE_PASSWORD")
			}
			password = state.BrowserPassword
		} else if password == "" {
			return nil, fmt.Errorf("legacy persistent state requires its original SHELL_ONLINE_E2EE_PASSWORD")
		}
		salt, decodeError := base64.RawURLEncoding.DecodeString(state.Fragment[len("#salt="):])
		if decodeError != nil {
			return nil, fmt.Errorf("decode persistent E2EE salt: %w", decodeError)
		}
		derivedKey, deriveError := e2ee.DerivePasswordKey(password, salt)
		if deriveError != nil {
			return nil, deriveError
		}
		storedKey, decodeError := base64.RawURLEncoding.DecodeString(state.EncryptionKey)
		if decodeError != nil || subtle.ConstantTimeCompare(derivedKey, storedKey) != 1 {
			return nil, fmt.Errorf("persistent state password does not match its encryption key")
		}
		// Do not silently upgrade existing credential files during startup.
	} else if encrypted && !created {
		// Releases before password-by-default embedded a random key in the URL.
		// Keep those links working without claiming the unrelated environment
		// password is required by the browser.
		password = ""
	}
	prepared := &preparedPersistentSession{state: state, password: password, created: created, prior: prior}
	if encrypted {
		key, decodeError := base64.RawURLEncoding.DecodeString(state.EncryptionKey)
		if decodeError != nil {
			return nil, fmt.Errorf("decode persistent E2EE key: %w", decodeError)
		}
		prepared.cipher, err = e2ee.New(key)
		if err != nil {
			return nil, err
		}
	}
	return prepared, nil
}

// persist publishes new credentials without replacement before resume, so
// concurrent fresh launches cannot choose two identities for one path. It is
// called only after the local reservation.
func (prepared *preparedPersistentSession) persist(path string) error {
	if prepared.created {
		return writeNewPersistentState(path, prepared.state)
	}
	_, current, err := readPersistentStateSnapshot(path)
	if err != nil || !bytes.Equal(current, prepared.prior) {
		return fmt.Errorf("persistent state changed during preparation; refusing resume")
	}
	return nil
}

// resume contacts the relay. It is called only after the local reservation and
// persist, so a launch that cannot own the session locally never mutates it.
func (prepared *preparedPersistentSession) resume(ctx context.Context, client *api.Client, label string) (api.Session, error) {
	state := prepared.state
	session, err := client.ResumeSession(ctx, label, api.Session{ID: state.ID, HostToken: state.HostToken, ReadOnly: state.ReadOnly, Encrypted: state.Encrypted, Persistent: true})
	if err != nil {
		return api.Session{}, err
	}
	session.Cipher = prepared.cipher
	session.ShareURL += state.Fragment
	return session, nil
}

func persistentSessionID(hostToken string) string {
	digest := sha256.Sum256([]byte("shell.online persistent session\x00" + hostToken))
	return base64.RawURLEncoding.EncodeToString(digest[:24])
}

func readPersistentState(path string) (persistentSessionState, error) {
	state, _, err := readPersistentStateSnapshot(path)
	return state, err
}

// readPersistentStateSnapshot reads the state and the exact bytes on disk, so a
// later persist can refuse to resume if the file changed during preparation.
func readPersistentStateSnapshot(path string) (persistentSessionState, []byte, error) {
	var state persistentSessionState
	before, err := os.Lstat(path)
	if err != nil {
		return state, nil, err
	}
	if !before.Mode().IsRegular() {
		return state, nil, fmt.Errorf("persistent state must be a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return state, nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return state, nil, err
	}
	if !os.SameFile(before, info) {
		return state, nil, fmt.Errorf("persistent state changed while opening")
	}
	if err := validatePrivateStateFile(path, info); err != nil {
		return state, nil, err
	}
	data, err := io.ReadAll(io.LimitReader(file, 16*1024+1))
	if err != nil || len(data) > 16*1024 {
		return state, nil, fmt.Errorf("persistent state is unreadable or too large")
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return state, nil, fmt.Errorf("decode persistent state: %w", err)
	}
	if !localSessionIDPattern.MatchString(state.ID) || len(state.HostToken) < 32 || len(state.HostToken) > 128 || state.ID != persistentSessionID(state.HostToken) {
		return state, nil, fmt.Errorf("persistent state contains invalid credentials")
	}
	if state.Encrypted && (!persistentFragmentPattern.MatchString(state.Fragment) || state.EncryptionKey == "") {
		return state, nil, fmt.Errorf("persistent state contains invalid E2EE material")
	}
	return state, data, nil
}

func writePersistentState(path string, state persistentSessionState) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create persistent state directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".shell-online-state-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := json.NewEncoder(temporary).Encode(state); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := securePrivateStateFile(temporaryPath); err != nil {
		return err
	}
	if err := replaceFileAtomically(temporaryPath, path); err != nil {
		return err
	}
	return securePrivateStateFile(path)
}

// writeNewPersistentState publishes a brand-new state file by hard link, which
// is atomic and never overwrites a competing winner. Unsupported filesystems
// fail closed, before any relay mutation.
func writeNewPersistentState(path string, state persistentSessionState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("cannot prepare persistent state directory")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".shell-online-state-*")
	if err != nil {
		return fmt.Errorf("cannot stage persistent state")
	}
	name := file.Name()
	defer os.Remove(name)
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	if err := securePrivateStateFile(name); err != nil {
		return err
	}
	if err := json.NewEncoder(file).Encode(state); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Link(name, path); err != nil {
		return fmt.Errorf("cannot exclusively save persistent state; recovery may be needed")
	}
	return nil
}

func randomPersistentToken(length int) (string, error) {
	value := make([]byte, length)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
