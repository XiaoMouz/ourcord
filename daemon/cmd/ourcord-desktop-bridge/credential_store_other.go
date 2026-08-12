//go:build !darwin || !cgo

package main

import "github.com/zalando/go-keyring"

type osCredentialStore struct{}

func (osCredentialStore) Get(service, user string) (string, error) {
	return keyring.Get(service, user)
}

func (osCredentialStore) Set(service, user, password string) error {
	return keyring.Set(service, user, password)
}

func (osCredentialStore) Delete(service, user string) error {
	return keyring.Delete(service, user)
}
