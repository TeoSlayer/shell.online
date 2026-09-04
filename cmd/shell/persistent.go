package main

import (
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

func preparePersistentSession(ctx context.Context, client *api.Client, path, label string, readOnly, encrypted bool, password string) (api.Session, string, error) {
	state, err := readPersistentState(path)
	if err != nil && !os.IsNotExist(err) {
		return api.Session{}, "", err
	}
	created := os.IsNotExist(err)
	if created {
		state = persistentSessionState{Version: 1, ReadOnly: readOnly, Encrypted: encrypted}
		state.HostToken, err = randomPersistentToken(32)
		if err != nil {
			return api.Session{}, "", err
		}
		state.ID = persistentSessionID(state.HostToken)
		if encrypted {
			if password == "" {
				password, err = e2ee.GenerateBrowserPassword()
				if err != nil {
					return api.Session{}, "", err
				}
			}
			if err := e2ee.ValidateBrowserPassword(password); err != nil {
				return api.Session{}, "", err
			}
			var key []byte
			var keyError error
			_, state.Fragment, key, keyError = e2ee.GenerateMaterial(password)
			if keyError != nil {
				return api.Session{}, "", keyError
			}
			state.EncryptionKey = base64.RawURLEncoding.EncodeToString(key)
			state.BrowserPassword = password
		}
	} else if state.Version != 1 || state.ReadOnly != readOnly || state.Encrypted != encrypted {
		return api.Session{}, "", fmt.Errorf("persistent state access/encryption mode does not match the requested flags")
	}
	stateChanged := created
	if encrypted && !created && len(state.Fragment) > len("#salt=") && state.Fragment[:len("#salt=")] == "#salt=" {
		if state.BrowserPassword != "" {
			if err := e2ee.ValidateBrowserPassword(state.BrowserPassword); err != nil {
				return api.Session{}, "", fmt.Errorf("persistent state browser password: %w", err)
			}
			if password != "" && password != state.BrowserPassword {
				return api.Session{}, "", fmt.Errorf("persistent state password does not match SHELL_ONLINE_E2EE_PASSWORD")
			}
			password = state.BrowserPassword
		} else if password == "" {
			return api.Session{}, "", fmt.Errorf("legacy persistent state requires its original SHELL_ONLINE_E2EE_PASSWORD")
		}
		salt, decodeError := base64.RawURLEncoding.DecodeString(state.Fragment[len("#salt="):])
		if decodeError != nil {
			return api.Session{}, "", fmt.Errorf("decode persistent E2EE salt: %w", decodeError)
		}
		derivedKey, deriveError := e2ee.DerivePasswordKey(password, salt)
		if deriveError != nil {
			return api.Session{}, "", deriveError
		}
		storedKey, decodeError := base64.RawURLEncoding.DecodeString(state.EncryptionKey)
		if decodeError != nil || subtle.ConstantTimeCompare(derivedKey, storedKey) != 1 {
			return api.Session{}, "", fmt.Errorf("persistent state password does not match its encryption key")
		}
		if state.BrowserPassword == "" {
			state.BrowserPassword = password
			stateChanged = true
		}
	} else if encrypted && !created {
		// Releases before password-by-default embedded a random key in the URL.
		// Keep those links working without claiming the unrelated environment
		// password is required by the browser.
		password = ""
	}
	seed := api.Session{ID: state.ID, HostToken: state.HostToken, ReadOnly: state.ReadOnly, Encrypted: state.Encrypted, Persistent: true}
	session, err := client.ResumeSession(ctx, label, seed)
	if err != nil {
		return api.Session{}, "", err
	}
	if encrypted {
		key, decodeError := base64.RawURLEncoding.DecodeString(state.EncryptionKey)
		if decodeError != nil {
			return api.Session{}, "", fmt.Errorf("decode persistent E2EE key: %w", decodeError)
		}
		session.Cipher, err = e2ee.New(key)
		if err != nil {
			return api.Session{}, "", err
		}
		session.ShareURL += state.Fragment
	}
	if stateChanged {
		if err := writePersistentState(path, state); err != nil {
			return api.Session{}, "", err
		}
	}
	return session, password, nil
}

func persistentSessionID(hostToken string) string {
	digest := sha256.Sum256([]byte("shell.online persistent session\x00" + hostToken))
	return base64.RawURLEncoding.EncodeToString(digest[:24])
}

func readPersistentState(path string) (persistentSessionState, error) {
	var state persistentSessionState
	file, err := os.Open(path)
	if err != nil {
		return state, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return state, err
	}
	if err := validatePrivateStateFile(path, info); err != nil {
		return state, err
	}
	if err := json.NewDecoder(io.LimitReader(file, 16*1024)).Decode(&state); err != nil {
		return state, fmt.Errorf("decode persistent state: %w", err)
	}
	if !localSessionIDPattern.MatchString(state.ID) || len(state.HostToken) < 32 || len(state.HostToken) > 128 || state.ID != persistentSessionID(state.HostToken) {
		return state, fmt.Errorf("persistent state contains invalid credentials")
	}
	if state.Encrypted && (!persistentFragmentPattern.MatchString(state.Fragment) || state.EncryptionKey == "") {
		return state, fmt.Errorf("persistent state contains invalid E2EE material")
	}
	return state, nil
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
		temporary.Close()
		return err
	}
	if err := json.NewEncoder(temporary).Encode(state); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
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

func randomPersistentToken(length int) (string, error) {
	value := make([]byte, length)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
