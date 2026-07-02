package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTokenRefreshDelay(t *testing.T) {
	now := int64(1_000_000)

	// A one-hour JWT refreshes lead-time early.
	got := tokenRefreshDelay(now+3600, now)
	want := 3600*time.Second - tokenRefreshLead
	if got != want {
		t.Fatalf("delay = %v, want %v", got, want)
	}
	// Already inside the lead window: clamp to the floor, never negative.
	if got := tokenRefreshDelay(now+60, now); got != tokenRefreshFloor {
		t.Fatalf("near-expiry delay = %v, want floor %v", got, tokenRefreshFloor)
	}
	if got := tokenRefreshDelay(now-10, now); got != tokenRefreshFloor {
		t.Fatalf("expired delay = %v, want floor %v", got, tokenRefreshFloor)
	}
}

func TestLoadDeviceTokenPrecedence(t *testing.T) {
	dir := t.TempDir()

	// Nothing configured → empty (legacy JWT path).
	t.Setenv("OURCORD_DEVICE_TOKEN", "")
	if got := loadDeviceToken(dir); got != "" {
		t.Fatalf("expected empty device token, got %q", got)
	}

	// State file present → used (trailing whitespace trimmed).
	if err := os.WriteFile(filepath.Join(dir, "device.token"), []byte("dt_from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadDeviceToken(dir); got != "dt_from-file" {
		t.Fatalf("file token = %q", got)
	}

	// Env var wins over the file.
	t.Setenv("OURCORD_DEVICE_TOKEN", "dt_from-env")
	if got := loadDeviceToken(dir); got != "dt_from-env" {
		t.Fatalf("env token = %q", got)
	}
}
