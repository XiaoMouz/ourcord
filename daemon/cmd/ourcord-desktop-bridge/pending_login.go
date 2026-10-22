package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/zalando/go-keyring"
)

const pendingLoginTTL = 12 * time.Minute

var pendingVerifierPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)

type pendingLogin struct {
	Verifier   string `json:"verifier"`
	ControlURL string `json:"control_url"`
	CreatedAt  int64  `json:"created_at"`
	ExpiresAt  int64  `json:"expires_at"`
}

func (desktop *bridge) readPendingLogin(now time.Time) (pendingLogin, error) {
	raw, err := desktop.credentialStore().Get(credentialService, pkceCredential)
	if err != nil {
		return pendingLogin{}, err
	}
	if pendingVerifierPattern.MatchString(raw) {
		pending := pendingLogin{Verifier: raw, ControlURL: desktop.controlURL, CreatedAt: now.Unix(), ExpiresAt: now.Add(pendingLoginTTL).Unix()}
		return pending, desktop.storePendingLogin(pending)
	}
	var pending pendingLogin
	if err := json.Unmarshal([]byte(raw), &pending); err != nil || !pendingVerifierPattern.MatchString(pending.Verifier) || pending.CreatedAt <= 0 || pending.ExpiresAt <= pending.CreatedAt {
		return pendingLogin{}, keyring.ErrNotFound
	}
	return pending, nil
}

func (desktop *bridge) beginPendingLogin(restart, activate bool, now time.Time) (pendingLogin, error) {
	pending, err := desktop.readPendingLogin(now)
	if err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return pendingLogin{}, fmt.Errorf("read login state: %w", err)
	}
	if restart || err != nil || pending.ControlURL != desktop.controlURL || pending.ExpiresAt <= now.Unix() {
		verifier, _, err := newPKCE()
		if err != nil {
			return pendingLogin{}, err
		}
		pending = pendingLogin{Verifier: verifier, ControlURL: desktop.controlURL, CreatedAt: now.Unix(), ExpiresAt: now.Add(pendingLoginTTL).Unix()}
	} else if activate {
		pending.ExpiresAt = now.Add(pendingLoginTTL).Unix()
	}
	return pending, desktop.storePendingLogin(pending)
}

func (desktop *bridge) storePendingLogin(pending pendingLogin) error {
	encoded, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	if err := desktop.credentialStore().Set(credentialService, pkceCredential, string(encoded)); err != nil {
		return fmt.Errorf("store login state: %w", err)
	}
	return nil
}
