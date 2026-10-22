package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func dispatchUpload(t *testing.T, b *bridge) (any, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "attachment.txt")
	if err := os.WriteFile(path, []byte("complete file bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	params, _ := json.Marshal(map[string]string{"room_id": "room", "path": path})
	return b.dispatch("files.upload", params)
}

func TestFileUploadRefreshesAccount(t *testing.T) {
	for _, stage := range []string{"init", "r2-put", "external-complete", "background-refresh", "missing-jwt"} {
		t.Run(stage, func(t *testing.T) {
			var exchanges, initiations, reservations, puts, completions atomic.Int32
			var b *bridge
			external := strings.Contains(stage, "external") || stage == "background-refresh"
			checkBody := func(r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil || string(body) != "complete file bytes" {
					t.Errorf("upload bytes = %q, %v", body, err)
				}
			}
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				puts.Add(1)
				checkBody(r)
				if r.Header.Get("Authorization") != "" {
					t.Error("account JWT leaked to autonomous backend")
				}
				if stage == "background-refresh" {
					// A normal chat/presence poll refreshes the shared credential
					// while a longer external file transfer is still in progress.
					if err := b.credentialStore().Set(credentialService, jwtCredential, "fresh-jwt"); err != nil {
						t.Error(err)
					}
				}
			}))
			defer backend.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				fresh := r.Header.Get("Authorization") == "Bearer fresh-jwt"
				switch r.URL.Path {
				case "/api/auth/device":
					exchanges.Add(1)
					_, _ = io.WriteString(w, `{"token":"fresh-jwt"}`)
				case "/api/rooms/room/files":
					initiations.Add(1)
					if (stage == "init" || stage == "missing-jwt") && !fresh {
						w.WriteHeader(http.StatusUnauthorized)
						return
					}
					reservations.Add(1)
					if external {
						_ = json.NewEncoder(w).Encode(map[string]string{
							"id": "attachment", "storage_location": "user_server",
							"upload_url": backend.URL + "/files/attachment", "upload_token": "ut_test",
							"complete_url": "/api/rooms/room/files/attachment/complete",
						})
					} else {
						_, _ = io.WriteString(w, `{"id":"attachment","storage_location":"r2","upload_url":"/api/rooms/room/files/attachment/upload"}`)
					}
				case "/api/rooms/room/files/attachment/upload":
					puts.Add(1)
					checkBody(r)
					if stage == "r2-put" && !fresh {
						w.WriteHeader(http.StatusUnauthorized)
						return
					}
					_, _ = io.WriteString(w, `{"uploaded":true}`)
				case "/api/rooms/room/files/attachment/complete":
					completions.Add(1)
					if !fresh {
						w.WriteHeader(http.StatusUnauthorized)
						return
					}
					var body map[string]string
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["upload_token"] != "ut_test" {
						t.Errorf("completion capability = %v, %v", body, err)
					}
					_, _ = io.WriteString(w, `{"uploaded":true}`)
				default:
					t.Errorf("unexpected request: %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			b = refreshTestBridge(t, server)
			b.fileHTTP = server.Client()
			if stage == "missing-jwt" {
				if err := b.credentialStore().Delete(credentialService, jwtCredential); err != nil {
					t.Fatal(err)
				}
			}
			result, err := dispatchUpload(t, b)
			if err != nil {
				t.Fatalf("file transfer failed instead of refreshing: %v", err)
			}
			if result.(map[string]any)["file_id"] != "attachment" {
				t.Fatalf("unexpected upload result: %v", result)
			}
			wantExchanges, wantInit, wantPuts, wantComplete := int32(1), int32(1), int32(1), int32(0)
			switch stage {
			case "init":
				wantInit = 2
			case "r2-put":
				wantPuts = 2
			case "external-complete":
				wantComplete = 2
			case "background-refresh":
				wantExchanges, wantComplete = 0, 1
			}
			if exchanges.Load() != wantExchanges || initiations.Load() != wantInit ||
				puts.Load() != wantPuts || completions.Load() != wantComplete || reservations.Load() != 1 {
				t.Fatalf("exchange/init/reservation/put/complete = %d/%d/%d/%d/%d; want %d/%d/1/%d/%d",
					exchanges.Load(), initiations.Load(), reservations.Load(), puts.Load(), completions.Load(),
					wantExchanges, wantInit, wantPuts, wantComplete)
			}
		})
	}
}

func TestFileDownloadRefreshesAccount(t *testing.T) {
	for _, external := range []bool{false, true} {
		t.Run(map[bool]string{false: "r2", true: "external"}[external], func(t *testing.T) {
			var exchanges, serviceReads, backendReads atomic.Int32
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				backendReads.Add(1)
				if r.Header.Get("Authorization") != "" {
					t.Error("account JWT leaked to download backend")
				}
				_, _ = io.WriteString(w, "download bytes")
			}))
			defer backend.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/auth/device" {
					exchanges.Add(1)
					_, _ = io.WriteString(w, `{"token":"fresh-jwt"}`)
					return
				}
				serviceReads.Add(1)
				if r.Header.Get("Authorization") != "Bearer fresh-jwt" {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				if external {
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(map[string]string{"url": backend.URL})
				} else {
					w.Header().Set("Content-Disposition", `attachment; filename="file.txt"`)
					_, _ = io.WriteString(w, "download bytes")
				}
			}))
			defer server.Close()
			b := refreshTestBridge(t, server)
			b.fileHTTP, b.downloadDir = server.Client(), t.TempDir()
			result, err := downloadAttachment(b, "file.txt")
			if err != nil {
				t.Fatalf("download failed instead of refreshing: %v", err)
			}
			assertDownloaded(t, result, "download bytes")
			wantBackend := int32(0)
			if external {
				wantBackend = 1
			}
			if exchanges.Load() != 1 || serviceReads.Load() != 2 || backendReads.Load() != wantBackend {
				t.Fatalf("exchange/service/backend = %d/%d/%d", exchanges.Load(), serviceReads.Load(), backendReads.Load())
			}
		})
	}
}

func TestFileDownloadDoesNotLoopOrRefreshForOtherFailures(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var reads, exchanges atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/auth/device" {
					exchanges.Add(1)
					_, _ = io.WriteString(w, `{"token":"fresh-jwt"}`)
					return
				}
				reads.Add(1)
				w.WriteHeader(status)
			}))
			defer server.Close()
			b := refreshTestBridge(t, server)
			b.fileHTTP, b.downloadDir = server.Client(), t.TempDir()
			if _, err := downloadAttachment(b, "file.txt"); err == nil {
				t.Fatal("rejected download reported success")
			}
			wantReads, wantExchanges := int32(1), int32(0)
			if status == http.StatusUnauthorized {
				wantReads, wantExchanges = 2, 1
			}
			if reads.Load() != wantReads || exchanges.Load() != wantExchanges {
				t.Fatalf("reads/exchanges = %d/%d, want %d/%d", reads.Load(), exchanges.Load(), wantReads, wantExchanges)
			}
			if entries, err := os.ReadDir(b.downloadDir); err != nil || len(entries) != 0 {
				t.Fatalf("failed download left files: %v, %v", entries, err)
			}
		})
	}
}

func TestExternalFileUnauthorizedDoesNotRefreshAccountOrReplayUpload(t *testing.T) {
	for _, upload := range []bool{false, true} {
		t.Run(map[bool]string{false: "download", true: "upload"}[upload], func(t *testing.T) {
			var exchanges, backendCalls atomic.Int32
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				backendCalls.Add(1)
				if r.Header.Get("Authorization") != "" {
					t.Error("account JWT leaked to external backend")
				}
				w.WriteHeader(http.StatusUnauthorized)
			}))
			defer backend.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/auth/device" {
					exchanges.Add(1)
					_, _ = io.WriteString(w, `{"token":"fresh-jwt"}`)
				} else if upload {
					_ = json.NewEncoder(w).Encode(map[string]string{
						"id": "attachment", "storage_location": "user_server", "upload_url": backend.URL,
					})
				} else {
					_ = json.NewEncoder(w).Encode(map[string]string{"url": backend.URL})
				}
			}))
			defer server.Close()
			b := refreshTestBridge(t, server)
			b.fileHTTP, b.downloadDir = server.Client(), t.TempDir()
			var err error
			if upload {
				_, err = dispatchUpload(t, b)
			} else {
				_, err = downloadAttachment(b, "file.txt")
			}
			if err == nil || exchanges.Load() != 0 || backendCalls.Load() != 1 {
				t.Fatalf("external failure retried/refreshed: err=%v, exchanges=%d, calls=%d", err, exchanges.Load(), backendCalls.Load())
			}
		})
	}
}

func TestFileAndChatShareConcurrentAccountRefresh(t *testing.T) {
	var expired, exchanges atomic.Int32
	bothRejected := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(bothRejected) }) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/device" {
			exchanges.Add(1)
			_, _ = io.WriteString(w, `{"token":"fresh-jwt"}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer fresh-jwt" {
			if expired.Add(1) == 2 {
				release()
			}
			<-bothRejected
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/download") {
			w.Header().Set("Content-Disposition", `attachment; filename="file.txt"`)
			_, _ = io.WriteString(w, "bytes")
		} else {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"messages":[]}`)
		}
	}))
	defer server.Close()
	defer release()
	b := refreshTestBridge(t, server)
	b.fileHTTP, b.downloadDir = server.Client(), t.TempDir()
	done := make(chan error, 2)
	go func() { _, err := downloadAttachment(b, "file.txt"); done <- err }()
	go func() {
		_, err := b.dispatch("messages.list", json.RawMessage(`{"room_id":"room"}`))
		done <- err
	}()
	for range 2 {
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("concurrent operation failed: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("concurrent file and chat operations did not finish")
		}
	}
	if exchanges.Load() != 1 {
		t.Fatalf("device exchanges = %d, want 1 shared refresh", exchanges.Load())
	}
}
