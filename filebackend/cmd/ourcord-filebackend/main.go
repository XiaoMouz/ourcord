package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	addr := flag.String("addr", ":8090", "HTTP listen address")
	dataDir := flag.String("data-dir", "./data", "directory used to store files")
	maxBytes := flag.Int64("max-bytes", 5<<30, "maximum bytes accepted by one PUT")
	flag.Parse()

	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		log.Fatalf("create data dir: %v", err)
	}

	s := &server{root: *dataDir, maxBytes: *maxBytes}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/ourcord-file-backend/health", s.health)
	mux.HandleFunc("/files/", s.file)

	log.Printf("ourcord-filebackend listening on %s data_dir=%s", *addr, *dataDir)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatal(err)
	}
}

type server struct {
	root     string
	maxBytes int64
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"service": "ourcord-filebackend",
		"ts":      time.Now().Unix(),
	})
}

func (s *server) file(w http.ResponseWriter, r *http.Request) {
	path, err := s.resolve(r.URL.Path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodPut:
		s.put(w, r, path)
	case http.MethodHead, http.MethodGet:
		http.ServeFile(w, r, path)
	default:
		w.Header().Set("Allow", "PUT, GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) put(w http.ResponseWriter, r *http.Request, path string) {
	if r.Body == nil {
		http.Error(w, "missing body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		http.Error(w, fmt.Sprintf("create parent: %v", err), http.StatusInternalServerError)
		return
	}

	tmp, err := tempPath(filepath.Dir(path))
	if err != nil {
		http.Error(w, fmt.Sprintf("temp path: %v", err), http.StatusInternalServerError)
		return
	}
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		http.Error(w, fmt.Sprintf("create temp: %v", err), http.StatusInternalServerError)
		return
	}
	defer func() {
		_ = f.Close()
		_ = os.Remove(tmp)
	}()

	written, err := io.Copy(f, http.MaxBytesReader(w, r.Body, s.maxBytes))
	if err != nil {
		http.Error(w, fmt.Sprintf("write body: %v", err), http.StatusRequestEntityTooLarge)
		return
	}
	if err := f.Close(); err != nil {
		http.Error(w, fmt.Sprintf("close temp: %v", err), http.StatusInternalServerError)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		http.Error(w, fmt.Sprintf("commit file: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]any{"stored": true, "bytes": written})
}

func (s *server) resolve(rawPath string) (string, error) {
	if !strings.HasPrefix(rawPath, "/files/") {
		return "", errors.New("path must start with /files/")
	}
	rel := strings.TrimPrefix(rawPath, "/")
	if rel == "" || strings.Contains(rel, "\x00") {
		return "", errors.New("invalid path")
	}
	clean := filepath.Clean(filepath.FromSlash(rel))
	if clean == "." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) || clean == ".." {
		return "", errors.New("invalid path")
	}
	if !strings.HasPrefix(clean, "files"+string(os.PathSeparator)) {
		return "", errors.New("invalid path")
	}
	return filepath.Join(s.root, clean), nil
}

func tempPath(dir string) (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return filepath.Join(dir, ".upload-"+hex.EncodeToString(b[:])+".tmp"), nil
}
