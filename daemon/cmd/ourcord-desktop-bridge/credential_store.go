package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/zalando/go-keyring"
)

type resilientCredentialStore struct {
	primary  credentialStore
	fallback credentialStore
}

func newCredentialStore(stateDir string) credentialStore {
	return resilientCredentialStore{
		primary:  osCredentialStore{},
		fallback: fileCredentialStore{dir: filepath.Join(stateDir, "credentials")},
	}
}

func (s resilientCredentialStore) Get(service, user string) (string, error) {
	if value, err := s.primary.Get(service, user); err == nil {
		return value, nil
	}
	return s.fallback.Get(service, user)
}

func (s resilientCredentialStore) Set(service, user, password string) error {
	if err := s.primary.Set(service, user, password); err == nil {
		_ = s.fallback.Delete(service, user)
		return nil
	}
	return s.fallback.Set(service, user, password)
}

func (s resilientCredentialStore) Delete(service, user string) error {
	primaryErr := s.primary.Delete(service, user)
	fallbackErr := s.fallback.Delete(service, user)
	if primaryErr == nil || fallbackErr == nil {
		return nil
	}
	if errors.Is(primaryErr, keyring.ErrNotFound) && errors.Is(fallbackErr, keyring.ErrNotFound) {
		return keyring.ErrNotFound
	}
	if !errors.Is(fallbackErr, keyring.ErrNotFound) {
		return fallbackErr
	}
	return primaryErr
}

type fileCredentialStore struct {
	dir string
}

func (s fileCredentialStore) path(service, user string) string {
	sum := sha256.Sum256([]byte(service + "\x00" + user))
	return filepath.Join(s.dir, fmt.Sprintf("%x", sum[:]))
}

func (s fileCredentialStore) Get(service, user string) (string, error) {
	data, err := os.ReadFile(s.path(service, user))
	if errors.Is(err, os.ErrNotExist) {
		return "", keyring.ErrNotFound
	}
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return "", keyring.ErrNotFound
	}
	return value, nil
}

func (s fileCredentialStore) Set(service, user, password string) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("create credential directory: %w", err)
	}
	if err := os.Chmod(s.dir, 0o700); err != nil {
		return fmt.Errorf("secure credential directory: %w", err)
	}
	temporary, err := os.CreateTemp(s.dir, ".credential-*")
	if err != nil {
		return fmt.Errorf("create credential file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("secure credential file: %w", err)
	}
	if _, err := temporary.WriteString(password + "\n"); err != nil {
		temporary.Close()
		return fmt.Errorf("write credential: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("write credential: %w", err)
	}
	if err := os.Rename(temporaryPath, s.path(service, user)); err != nil {
		return fmt.Errorf("store credential: %w", err)
	}
	return nil
}

func (s fileCredentialStore) Delete(service, user string) error {
	err := os.Remove(s.path(service, user))
	if errors.Is(err, os.ErrNotExist) {
		return keyring.ErrNotFound
	}
	return err
}
