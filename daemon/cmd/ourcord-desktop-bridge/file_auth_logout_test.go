package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	"github.com/zalando/go-keyring"
)

func TestFileAuthRefreshPreservesLogout(t *testing.T) {
	for _, phase := range []string{"credential-exchange", "upload-stream"} {
		t.Run(phase, func(t *testing.T) {
			started, resume := make(chan struct{}), make(chan struct{})
			var resumeOnce sync.Once
			release := func() { resumeOnce.Do(func() { close(resume) }) }
			var exchanges atomic.Int32
			store := &lockedCredentials{memoryCredentials: memoryCredentials{
				credentialKey(credentialService, jwtCredential):    "expired-jwt",
				credentialKey(credentialService, deviceCredential): "dt_device",
			}}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/auth/device":
					exchanges.Add(1)
					if phase == "credential-exchange" {
						close(started)
						<-resume
					}
					_, _ = io.WriteString(w, `{"token":"fresh-jwt"}`)
				case "/api/rooms/room/files/attachment/download":
					if r.Header.Get("Authorization") != "Bearer fresh-jwt" {
						w.WriteHeader(http.StatusUnauthorized)
						return
					}
					w.Header().Set("Content-Disposition", `attachment; filename="file.txt"`)
					_, _ = io.WriteString(w, "bytes")
				case "/api/rooms/room/files":
					_, _ = io.WriteString(w, `{"id":"attachment","storage_location":"r2","upload_url":"/api/rooms/room/files/attachment/upload"}`)
				case "/api/rooms/room/files/attachment/upload":
					_, _ = io.Copy(io.Discard, r.Body)
					close(started)
					<-resume
					w.WriteHeader(http.StatusUnauthorized)
				case "/api/presence", "/api/devices/device-1":
					_, _ = io.WriteString(w, `{}`)
				default:
					t.Errorf("unexpected request: %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			b := &bridge{
				controlURL: server.URL, serviceURL: server.URL,
				http: server.Client(), fileHTTP: server.Client(),
				credentials: store, stateDir: t.TempDir(), downloadDir: t.TempDir(),
				daemon: client.New(logoutDaemonConn{}),
			}
			path := filepath.Join(t.TempDir(), "upload.txt")
			if err := os.WriteFile(path, []byte("bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			params, _ := json.Marshal(map[string]string{"room_id": "room", "path": path})
			fileDone := make(chan struct{})
			var fileErr error
			go func() {
				defer close(fileDone)
				if phase == "upload-stream" {
					_, fileErr = b.dispatch("files.upload", params)
				} else {
					_, fileErr = downloadAttachment(b, "file.txt")
				}
			}()
			defer func() {
				release()
				select {
				case <-fileDone:
				case <-time.After(5 * time.Second):
					t.Error("file operation did not finish")
				}
			}()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("file operation never reached the controlled interleaving")
			}
			logoutDone := make(chan error, 1)
			go func() { _, err := b.dispatch("auth.logout", nil); logoutDone <- err }()
			logoutFinished := false
			if phase == "upload-stream" {
				select {
				case err := <-logoutDone:
					if err != nil {
						t.Fatal(err)
					}
					logoutFinished = true
				case <-time.After(5 * time.Second):
					t.Fatal("logout was blocked by a file stream")
				}
			} else {
				select {
				case err := <-logoutDone:
					t.Errorf("logout finished before the credential write was protected: %v", err)
					logoutFinished = true
				case <-time.After(100 * time.Millisecond):
				}
			}
			release()
			if !logoutFinished {
				select {
				case err := <-logoutDone:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("logout did not finish after the credential exchange")
				}
			}
			<-fileDone
			if phase == "upload-stream" && (fileErr == nil || exchanges.Load() != 0) {
				t.Fatalf("late upload 401 revived logout: err=%v exchanges=%d", fileErr, exchanges.Load())
			}
			for _, credential := range []string{jwtCredential, deviceCredential} {
				if value, err := store.Get(credentialService, credential); !errors.Is(err, keyring.ErrNotFound) {
					t.Errorf("%s remains after logout: %q, %v", credential, value, err)
				}
			}
		})
	}
}
