package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

func TestSaveDownloadNeverOverwritesExistingCopies(t *testing.T) {
	b := &bridge{downloadDir: t.TempDir()}
	for _, name := range []string{"report.txt", "report-attachment.txt"} {
		if err := os.WriteFile(filepath.Join(b.downloadDir, name), []byte("keep "+name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := b.saveDownload("report.txt", "attachment", strings.NewReader("new download"))
	if err != nil {
		t.Fatal(err)
	}
	assertDownloaded(t, result, "new download")
	for _, name := range []string{"report.txt", "report-attachment.txt"} {
		content, err := os.ReadFile(filepath.Join(b.downloadDir, name))
		if err != nil || string(content) != "keep "+name {
			t.Errorf("existing copy %s overwritten: %q, %v", name, content, err)
		}
	}
}

func TestSaveDownloadConcurrentCopiesHaveSeparatePaths(t *testing.T) {
	b := &bridge{downloadDir: t.TempDir()}
	const count = 12
	results := make(chan string, count)
	var wg sync.WaitGroup
	for range count {
		wg.Go(func() {
			result, err := b.saveDownload("report.txt", "attachment", strings.NewReader("complete"))
			if err != nil {
				t.Error(err)
				return
			}
			results <- result.(map[string]string)["saved_path"]
		})
	}
	wg.Wait()
	close(results)
	paths := make(map[string]bool)
	for path := range results {
		paths[path] = true
		content, err := os.ReadFile(path)
		if err != nil || string(content) != "complete" {
			t.Errorf("bad saved file: %q, %v", content, err)
		}
	}
	if len(paths) != count {
		t.Fatalf("distinct paths = %d, want %d", len(paths), count)
	}
}

type failedDownloadReader struct{}

func (failedDownloadReader) Read([]byte) (int, error) {
	return 0, errors.New("injected interrupted transfer")
}

func TestSaveDownloadRemovesInterruptedTransfer(t *testing.T) {
	b := &bridge{downloadDir: t.TempDir()}
	_, err := b.saveDownload("report.txt", "attachment",
		io.MultiReader(strings.NewReader("partial bytes"), failedDownloadReader{}))
	if err == nil {
		t.Fatal("interrupted transfer reported success")
	}
	entries, err := os.ReadDir(b.downloadDir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("partial download left on disk: %v, %v", entries, err)
	}
}

func TestSaveDownloadEnforcesLimitWithoutSilentTruncation(t *testing.T) {
	b := &bridge{downloadDir: t.TempDir()}
	// The production path uses 512 MiB; a small limit exercises the same
	// streaming save and cleanup without writing half a GiB in every CI run.
	_, err := b.saveDownloadWithLimit("oversize.txt", "attachment", strings.NewReader("12345"), 4)
	if err == nil {
		t.Fatal("oversize download reported success with truncated bytes")
	}
	entries, err := os.ReadDir(b.downloadDir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("truncated download left on disk: %v, %v", entries, err)
	}
	result, err := b.saveDownloadWithLimit("exact.txt", "attachment", strings.NewReader("1234"), 4)
	if err != nil {
		t.Fatal(err)
	}
	assertDownloaded(t, result, "1234")
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

func TestDownloadInterruptedHTTPBodyLeavesNoFile(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Disposition", `attachment; filename="report.txt"`)
		w.Header().Set("Content-Length", "100")
		_, _ = io.WriteString(w, "partial")
	}))
	defer server.Close()
	b := downloadTestBridge(t, server)
	if _, err := downloadAttachment(b, "report.txt"); err == nil {
		t.Fatal("truncated HTTP response reported success")
	}
	entries, err := os.ReadDir(b.downloadDir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("partial HTTP download left on disk: %v, %v", entries, err)
	}
}

func TestSaveDownloadDoesNotFollowExistingSymlink(t *testing.T) {
	b := &bridge{downloadDir: t.TempDir()}
	victim := filepath.Join(t.TempDir(), "keep.txt")
	if err := os.WriteFile(victim, []byte("keep original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b.downloadDir, "report.txt"), []byte("first copy"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(b.downloadDir, "report-attachment.txt")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	result, err := b.saveDownload("report.txt", "attachment", strings.NewReader("new download"))
	if err != nil {
		t.Fatal(err)
	}
	assertDownloaded(t, result, "new download")
	content, err := os.ReadFile(victim)
	if err != nil || string(content) != "keep original" {
		t.Fatalf("symlink target overwritten: %q, %v", content, err)
	}
}
