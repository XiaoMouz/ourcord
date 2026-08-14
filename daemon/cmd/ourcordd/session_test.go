package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/ourcord/ourcord/daemon/pkg/wg"
)

func TestRefreshAndUnenrollLocalSession(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "device.token"), []byte("dt_root-owned\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "profile.json"), []byte(`{"user_id":"user-1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	kp, err := wg.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/device" {
			http.NotFound(w, r)
			return
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["device_token"] != "dt_root-owned" {
			t.Fatalf("device token = %q", body["device_token"])
		}
		_, _ = w.Write([]byte(`{"token":"jwt-fresh","user_id":"user-1","expires_at":4102444800}`))
	}))
	defer server.Close()

	d := &daemon{controlURL: server.URL, stateDir: stateDir, keyPair: kp}
	session, err := d.refreshLocalSession(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if session.Token != "jwt-fresh" || session.UserID != "user-1" || session.ExpiresAt != 4102444800 {
		t.Fatalf("unexpected session: %+v", session)
	}
	if err := d.unenrollLocalDevice(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"device.token", "profile.json"} {
		if _, err := os.Stat(filepath.Join(stateDir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s still exists: %v", name, err)
		}
	}
}
