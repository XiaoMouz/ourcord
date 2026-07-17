package main

import "testing"

func TestRelayAuthTokenFromEnv(t *testing.T) {
	t.Setenv("OURCORD_RELAY_AUTH_TOKEN", "  operator-secret\n")
	if got := relayAuthTokenFromEnv(); got != "operator-secret" {
		t.Fatalf("relayAuthTokenFromEnv() = %q, want %q", got, "operator-secret")
	}
}
