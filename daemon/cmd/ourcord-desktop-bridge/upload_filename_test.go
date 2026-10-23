package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUploadUnicodeFilenamePreservesMetadataAndNotice(t *testing.T) {
	for _, tc := range []struct{ name, filename string }{
		{"CJK", strings.Repeat("\u6587", 61) + ".txt"},
		{"emoji", strings.Repeat("\U0001f680", 45) + "x.txt"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			filename := tc.filename
			path := filepath.Join(t.TempDir(), filename)
			if err := os.WriteFile(path, []byte("file bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/rooms/room/files":
					var metadata struct {
						Filename string `json:"filename"`
					}
					if err := json.NewDecoder(r.Body).Decode(&metadata); err != nil || metadata.Filename != filename {
						t.Errorf("original upload filename changed: %q, %v", metadata.Filename, err)
					}
					_, _ = io.WriteString(w, `{"id":"attachment","storage_location":"r2","upload_url":"/upload"}`)
				case "/upload":
					body, err := io.ReadAll(r.Body)
					if err != nil || string(body) != "file bytes" {
						t.Errorf("upload contents changed: %q, %v", body, err)
					}
					_, _ = io.WriteString(w, `{"uploaded":true}`)
				default:
					t.Errorf("unexpected upload path %s", r.URL.Path)
				}
			}))
			defer server.Close()
			b := downloadTestBridge(t, server)
			b.http = server.Client()
			params, _ := json.Marshal(map[string]string{"room_id": "room", "path": path})
			result, err := b.dispatch("files.upload", params)
			if err != nil {
				t.Fatal(err)
			}
			wire, err := json.Marshal(response{ID: "upload", Result: result})
			if err != nil {
				t.Fatal(err)
			}
			var decoded struct {
				Result struct {
					Filename string `json:"filename"`
				} `json:"result"`
			}
			if err := json.Unmarshal(wire, &decoded); err != nil {
				t.Fatal(err)
			}
			// ChatPane shows this returned name in its upload-success notice.
			if decoded.Result.Filename == "" || !strings.HasSuffix(filename, decoded.Result.Filename) {
				t.Fatalf("upload-success filename is corrupt: %q", decoded.Result.Filename)
			}
		})
	}
}
