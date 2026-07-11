package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestEnrollDevicePersistsCredentialWithoutReturningIt(t *testing.T) {
	var request struct {
		PublicKey string `json:"public_key"`
		Name      string `json:"name"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/devices/enroll" || r.Header.Get("Authorization") != "Bearer user-jwt" {
			t.Fatalf("unexpected request %s auth=%q", r.URL, r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(enrollResponse{deviceRecord: deviceRecord{ID: "dev-1", PublicKey: request.PublicKey, Name: request.Name}, DeviceToken: "dt_abcdefghijklmnopqrstuvwxyz0123456789"})
	}))
	defer server.Close()

	stateDir := t.TempDir()
	result, err := enrollDevice(context.Background(), server.Client(), server.URL, stateDir, "user-jwt", "laptop")
	if err != nil {
		t.Fatal(err)
	}
	if result.PublicKey == "" || request.PublicKey != result.PublicKey {
		t.Fatalf("public key mismatch: request=%q response=%q", request.PublicKey, result.PublicKey)
	}
	path := filepath.Join(stateDir, "device.token")
	data, err := os.ReadFile(path)
	if err != nil || string(data) != result.DeviceToken+"\n" {
		t.Fatalf("stored token = %q err=%v", data, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("token mode = %v err=%v", info.Mode().Perm(), err)
	}
}

func TestListAndRevokeDevices(t *testing.T) {
	var deleted string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer user-jwt" {
			t.Fatal("missing auth")
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /api/devices":
			_ = json.NewEncoder(w).Encode(map[string]any{"devices": []deviceRecord{{ID: "dev-1", Name: "laptop"}}})
		case "DELETE /api/devices/dev-1":
			deleted = "dev-1"
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	devices, err := listDevices(context.Background(), server.Client(), server.URL, "user-jwt")
	if err != nil || len(devices) != 1 || devices[0].ID != "dev-1" {
		t.Fatalf("devices=%+v err=%v", devices, err)
	}
	if err := revokeDevice(context.Background(), server.Client(), server.URL, "user-jwt", "dev-1"); err != nil || deleted != "dev-1" {
		t.Fatalf("revoke err=%v deleted=%q", err, deleted)
	}
}
