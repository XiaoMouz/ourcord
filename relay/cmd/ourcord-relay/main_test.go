package main

import "testing"

func TestRelayAuthTokenFromEnv(t *testing.T) {
	t.Setenv("OURCORD_RELAY_AUTH_TOKEN", "  operator-secret\n")
	if got := relayAuthTokenFromEnv(); got != "operator-secret" {
		t.Fatalf("relayAuthTokenFromEnv() = %q, want %q", got, "operator-secret")
	}
}

func TestRelayRegistrationPort(t *testing.T) {
	tests := []struct {
		name       string
		listenAddr string
		publicPort int
		want       int
		wantErr    bool
	}{
		{name: "direct listener", listenAddr: ":443", want: 443},
		{name: "reverse proxy override", listenAddr: "127.0.0.1:3340", publicPort: 443, want: 443},
		{name: "invalid override", listenAddr: ":3340", publicPort: 70000, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := relayRegistrationPort(tt.listenAddr, tt.publicPort)
			if (err != nil) != tt.wantErr {
				t.Fatalf("relayRegistrationPort() error = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("relayRegistrationPort() = %d, want %d", got, tt.want)
			}
		})
	}
}
