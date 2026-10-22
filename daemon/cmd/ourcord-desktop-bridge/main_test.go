package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"
)

type memoryCredentials map[string]string

type failingCredentials struct {
	err error
}

func (s failingCredentials) Get(string, string) (string, error) { return "", s.err }
func (s failingCredentials) Set(string, string, string) error   { return s.err }
func (s failingCredentials) Delete(string, string) error        { return s.err }

func credentialKey(service, user string) string { return service + "\x00" + user }
func (m memoryCredentials) Get(service, user string) (string, error) {
	value, ok := m[credentialKey(service, user)]
	if !ok {
		return "", keyring.ErrNotFound
	}
	return value, nil
}
func (m memoryCredentials) Set(service, user, password string) error {
	m[credentialKey(service, user)] = password
	return nil
}
func (m memoryCredentials) Delete(service, user string) error {
	key := credentialKey(service, user)
	if _, ok := m[key]; !ok {
		return keyring.ErrNotFound
	}
	delete(m, key)
	return nil
}

func TestResilientCredentialStoreFallsBackToPrivateFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "credentials")
	primaryErr := errors.New("credential store unavailable")
	store := resilientCredentialStore{
		primary:  failingCredentials{err: primaryErr},
		fallback: fileCredentialStore{dir: dir},
	}

	if err := store.Set(credentialService, jwtCredential, "persisted-jwt"); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Get(credentialService, jwtCredential); err != nil || got != "persisted-jwt" {
		t.Fatalf("Get() = %q, %v", got, err)
	}

	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := dirInfo.Mode().Perm(); got != 0o700 {
		t.Fatalf("credential directory mode = %o, want 700", got)
	}
	credentialInfo, err := os.Stat(fileCredentialStore{dir: dir}.path(credentialService, jwtCredential))
	if err != nil {
		t.Fatal(err)
	}
	if got := credentialInfo.Mode().Perm(); got != 0o600 {
		t.Fatalf("credential file mode = %o, want 600", got)
	}

	if err := store.Delete(credentialService, jwtCredential); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(credentialService, jwtCredential); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("deleted credential error = %v, want ErrNotFound", err)
	}
}

func TestMessagesPath(t *testing.T) {
	tests := []struct {
		name           string
		roomID, before string
		limit          int
		want           string
	}{
		{name: "default page", roomID: "room1", limit: 50, want: "/api/rooms/room1/messages?limit=50"},
		{name: "pagination cursor", roomID: "room1", before: "msg9", limit: 25, want: "/api/rooms/room1/messages?before=msg9&limit=25"},
		{name: "no limit", roomID: "room1", want: "/api/rooms/room1/messages"},
		{name: "path traversal stripped", roomID: "../admin", limit: 10, want: "/api/rooms/..admin/messages?limit=10"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := messagesPath(tt.roomID, tt.before, tt.limit, nil); got != tt.want {
				t.Fatalf("messagesPath() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestStringSliceParam(t *testing.T) {
	params := map[string]any{}
	if err := json.Unmarshal([]byte(`{"user_ids":["a"," b ","",42,null,"c"]}`), &params); err != nil {
		t.Fatal(err)
	}
	got := stringSliceParam(params, "user_ids")
	if want := []string{"a", "b", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("stringSliceParam() = %v, want %v", got, want)
	}
	if got := stringSliceParam(params, "missing"); len(got) != 0 {
		t.Fatalf("missing key should yield empty slice, got %v", got)
	}
}

func TestSafeFilename(t *testing.T) {
	tests := []struct{ in, want string }{
		{"photo.png", "photo.png"},
		{"../../etc/passwd", "_.._etc_passwd"},
		{"a\\b/c.txt", "a_b_c.txt"},
		{"  spaced.jpg  ", "spaced.jpg"},
		{"...hidden", "hidden"},
		{"", ""},
	}
	for _, tt := range tests {
		if got := safeFilename(tt.in); got != tt.want {
			t.Errorf("safeFilename(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestDetectMIME(t *testing.T) {
	if got := detectMIME("photo.PNG"); got != "image/png" {
		t.Errorf("detectMIME(png) = %q, want image/png", got)
	}
	// Extensions that resolve with a charset parameter must be stripped.
	if got := detectMIME("notes.txt"); strings.Contains(got, ";") || !strings.HasPrefix(got, "text/plain") {
		t.Errorf("detectMIME(txt) = %q, want param-free text/plain", got)
	}
	if got := detectMIME("mystery.zzz"); got != "application/octet-stream" {
		t.Errorf("detectMIME(unknown) = %q, want application/octet-stream", got)
	}
}

func TestHandleRejectsUnknownMethod(t *testing.T) {
	b := &bridge{}
	resp := b.handle(request{ID: "7", Method: "definitely.not.a.method"})
	if resp.ID != "7" {
		t.Fatalf("response ID = %q, want %q", resp.ID, "7")
	}
	if resp.Error != "unsupported bridge method" {
		t.Fatalf("response Error = %q", resp.Error)
	}
}

func TestHandleRejectsMalformedParams(t *testing.T) {
	b := &bridge{}
	resp := b.handle(request{ID: "8", Method: "profiles.lookup", Params: json.RawMessage(`[1,2]`)})
	if resp.Error != "invalid parameters" {
		t.Fatalf("response Error = %q, want invalid parameters", resp.Error)
	}
}

func TestProfilesLookupEmptyShortCircuits(t *testing.T) {
	// No user_ids → no network call, empty result, no auth required.
	b := &bridge{}
	result, err := b.dispatch("profiles.lookup", json.RawMessage(`{"user_ids":[]}`))
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}
	out, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("result type %T", result)
	}
	profiles, ok := out["profiles"].([]any)
	if !ok || len(profiles) != 0 {
		t.Fatalf("profiles = %#v, want empty slice", out["profiles"])
	}
}

func TestDecodeMagicResponse(t *testing.T) {
	got, err := decodeMagicResponse([]byte(`{"expires_in":600,"retry_after":43}`))
	if err != nil {
		t.Fatalf("decodeMagicResponse() error: %v", err)
	}
	if got["sent"] != true || got["expires_in"] != 600 || got["retry_after"] != 43 {
		t.Fatalf("decodeMagicResponse() = %#v", got)
	}
	if _, err := decodeMagicResponse([]byte(`{"expires_in":600}`)); err == nil {
		t.Fatal("missing retry_after should fail")
	}
}

func TestAuthStatusRecoversExpiredJWTFromDeviceCredential(t *testing.T) {
	credentials := memoryCredentials{
		credentialKey(credentialService, jwtCredential):    "expired-jwt",
		credentialKey(credentialService, deviceCredential): "dt_persistent-device-token",
	}
	var profileCalls, exchangeCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/me":
			profileCalls++
			if r.Header.Get("Authorization") != "Bearer fresh-jwt" {
				http.Error(w, `{"error":"Unauthorized"}`, http.StatusUnauthorized)
				return
			}
			_, _ = w.Write([]byte(`{"user":{"id":"user-1","email":"user@example.com"}}`))
		case "/api/auth/device":
			exchangeCalls++
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["device_token"] != "dt_persistent-device-token" {
				t.Fatalf("device token = %q", body["device_token"])
			}
			_, _ = w.Write([]byte(`{"token":"fresh-jwt","user_id":"user-1","expires_at":4102444800}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	b := &bridge{controlURL: server.URL, http: server.Client(), credentials: credentials, stateDir: t.TempDir()}
	result, err := b.authStatus()
	if err != nil {
		t.Fatal(err)
	}
	status := result.(map[string]any)
	if status["authenticated"] != true {
		t.Fatalf("auth status = %#v", status)
	}
	if profileCalls != 2 || exchangeCalls != 1 {
		t.Fatalf("profile calls = %d, exchange calls = %d", profileCalls, exchangeCalls)
	}
	if got, _ := credentials.Get(credentialService, jwtCredential); got != "fresh-jwt" {
		t.Fatalf("stored JWT = %q", got)
	}
}

func TestAuthStatusRestoresDeviceCredentialFromDisk(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "device.token"), []byte("dt_from-disk\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	credentials := memoryCredentials{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/device":
			_, _ = w.Write([]byte(`{"token":"disk-jwt","user_id":"user-1","expires_at":4102444800}`))
		case "/api/me":
			if r.Header.Get("Authorization") != "Bearer disk-jwt" {
				http.Error(w, `{"error":"Unauthorized"}`, http.StatusUnauthorized)
				return
			}
			_, _ = w.Write([]byte(`{"user":{"id":"user-1"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	b := &bridge{controlURL: server.URL, http: server.Client(), credentials: credentials, stateDir: stateDir}
	result, err := b.authStatus()
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["authenticated"] != true {
		t.Fatalf("auth status = %#v", result)
	}
	if got, _ := credentials.Get(credentialService, deviceCredential); got != "dt_from-disk" {
		t.Fatalf("cached device credential = %q", got)
	}
}

func TestAuthStatusWithoutCredentialsStaysLoggedOut(t *testing.T) {
	b := &bridge{http: http.DefaultClient, credentials: memoryCredentials{}, stateDir: t.TempDir()}
	result, err := b.authStatus()
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]bool)["authenticated"] {
		t.Fatalf("auth status = %#v", result)
	}
}

func TestLogoutClearsSessionAndDeviceCredentials(t *testing.T) {
	stateDir := t.TempDir()
	devicePath := filepath.Join(stateDir, "device.token")
	if err := os.WriteFile(devicePath, []byte("dt_local\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	credentials := memoryCredentials{
		credentialKey(credentialService, jwtCredential):    "jwt",
		credentialKey(credentialService, deviceCredential): "dt_local",
		credentialKey(credentialService, pkceCredential):   "pending-login-verifier",
	}
	b := &bridge{credentials: credentials, stateDir: stateDir}
	if _, err := b.dispatch("auth.logout", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := credentials.Get(credentialService, jwtCredential); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("JWT still stored: %v", err)
	}
	if _, err := credentials.Get(credentialService, deviceCredential); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("device credential still stored: %v", err)
	}
	if _, err := credentials.Get(credentialService, pkceCredential); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("pending login verifier still stored: %v", err)
	}
	if _, err := os.Stat(devicePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("device token file still exists: %v", err)
	}
}
