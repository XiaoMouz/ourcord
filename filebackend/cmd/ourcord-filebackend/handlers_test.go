package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthEndpoint(t *testing.T) {
	s := &server{root: t.TempDir()}
	rec := httptest.NewRecorder()
	s.health(rec, httptest.NewRequest(http.MethodGet, "/.well-known/ourcord-file-backend/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("health status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q", ct)
	}
	var body struct {
		OK      bool   `json:"ok"`
		Service string `json:"service"`
		TS      int64  `json:"ts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode health: %v", err)
	}
	if !body.OK || body.Service != "ourcord-filebackend" || body.TS == 0 {
		t.Fatalf("unexpected health body: %+v", body)
	}
}

func TestFileMethodNotAllowed(t *testing.T) {
	s := &server{root: t.TempDir(), maxBytes: 1 << 20}
	rec := httptest.NewRecorder()
	s.file(rec, httptest.NewRequest(http.MethodDelete, "/files/F1/doc.bin", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); allow == "" {
		t.Fatal("405 must advertise an Allow header")
	}
}

func TestPutRejectsOversizedBody(t *testing.T) {
	// Open backend (no secret) so the cap layer doesn't mask the size check.
	s := &server{root: t.TempDir(), maxBytes: 4}
	mux := http.NewServeMux()
	mux.HandleFunc("/files/", s.file)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/files/F1/big.bin", strings.NewReader("way too many bytes"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized PUT status = %d, want 413", resp.StatusCode)
	}
}

func TestOpenBackendRoundTrip(t *testing.T) {
	// secret == "" → capability enforcement disabled; PUT then GET must work
	// with no ?cap= present at all.
	s := &server{root: t.TempDir(), maxBytes: 1 << 20}
	mux := http.NewServeMux()
	mux.HandleFunc("/files/", s.file)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	key := "files/F2/note.txt"
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/"+key, strings.NewReader("open-data"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("open PUT status = %d, want 201", resp.StatusCode)
	}

	resp, err = http.Get(srv.URL + "/" + key)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "open-data" {
		t.Fatalf("open GET = %d %q, want 200 open-data", resp.StatusCode, body)
	}
}
