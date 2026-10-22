package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func downloadTestBridge(t *testing.T, server *httptest.Server) *bridge {
	t.Helper()
	return &bridge{
		serviceURL:  server.URL,
		fileHTTP:    server.Client(),
		downloadDir: t.TempDir(),
		credentials: memoryCredentials{
			credentialKey(credentialService, jwtCredential): "test-download-token",
		},
	}
}

func downloadAttachment(b *bridge, filename string) (any, error) {
	params, _ := json.Marshal(map[string]string{
		"room_id": "room", "file_id": "attachment", "filename": filename,
	})
	return b.dispatch("files.download", params)
}

func assertDownloaded(t *testing.T, result any, want string) string {
	t.Helper()
	path := result.(map[string]string)["saved_path"]
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != want {
		t.Fatalf("saved bytes = %q, want %q", content, want)
	}
	return path
}

func TestDownloadR2JSONAttachment(t *testing.T) {
	for _, withURL := range []bool{false, true} {
		t.Run(map[bool]string{false: "ordinary JSON", true: "JSON containing a URL"}[withURL], func(t *testing.T) {
			var extraRequests atomic.Int32
			content := `{"configuration":true}`
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/rooms/room/files/attachment/download" {
					extraRequests.Add(1)
					_, _ = io.WriteString(w, "unexpected replacement content")
					return
				}
				if r.Header.Get("Authorization") != "Bearer test-download-token" {
					t.Error("service download must authenticate")
				}
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Content-Disposition", `attachment; filename="config.json"; filename*=UTF-8''config.json`)
				_, _ = io.WriteString(w, content)
			}))
			defer server.Close()
			if withURL {
				content = `{"url":"` + server.URL + `/not-the-attachment"}`
			}
			b := downloadTestBridge(t, server)
			result, err := downloadAttachment(b, "config.json")
			if err != nil {
				t.Fatal(err)
			}
			assertDownloaded(t, result, content)
			if extraRequests.Load() != 0 {
				t.Fatal("JSON attachment bytes must never be followed as a URL")
			}
		})
	}
}

func TestDownloadExternalJSONAttachment(t *testing.T) {
	content := `{"url":"this-is-data","configuration":true}`
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("account token leaked to the external backend")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, content)
	}))
	defer backend.Close()
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"url": backend.URL + "/file?cap=test", "storage_location": "user_server",
		})
	}))
	defer service.Close()
	b := downloadTestBridge(t, service)
	result, err := downloadAttachment(b, "config.json")
	if err != nil {
		t.Fatal(err)
	}
	path := assertDownloaded(t, result, content)
	if filepath.Dir(path) != b.downloadDir {
		t.Fatal("download escaped the destination directory")
	}
}
