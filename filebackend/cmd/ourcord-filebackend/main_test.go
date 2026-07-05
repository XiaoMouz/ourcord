package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func signCap(secret, storageKey, op string, exp int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%s\n%s\n%d", storageKey, op, exp)
	return fmt.Sprintf("%d.%s", exp, base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
}

func TestVerifyCap(t *testing.T) {
	const secret = "test-secret-0123456789abcdef"
	const key = "files/F1/doc.bin"
	now := int64(1_700_000_000)
	valid := signCap(secret, key, "put", now+60)

	cases := []struct {
		name    string
		secret  string
		key     string
		op      string
		cap     string
		wantErr bool
	}{
		{"open backend accepts anything", "", key, "put", "", false},
		{"valid put", secret, key, "put", valid, false},
		{"valid get", secret, key, "get", signCap(secret, key, "get", now+60), false},
		{"missing cap", secret, key, "put", "", true},
		{"malformed cap", secret, key, "put", "not-a-cap", true},
		{"garbage exp", secret, key, "put", "abc.def", true},
		{"expired", secret, key, "put", signCap(secret, key, "put", now-1), true},
		{"exp exactly now is expired", secret, key, "put", signCap(secret, key, "put", now), true},
		{"wrong op (get cap used for put)", secret, key, "put", signCap(secret, key, "get", now+60), true},
		{"wrong path", secret, "files/OTHER/doc.bin", "put", valid, true},
		{"wrong secret", "another-secret-0123456789", key, "put", valid, true},
		{"tampered exp keeps old sig", secret, key, "put", fmt.Sprintf("%d.%s", now+9999, strings.SplitN(valid, ".", 2)[1]), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := verifyCap(c.secret, c.key, c.op, c.cap, now)
			if (err != nil) != c.wantErr {
				t.Fatalf("verifyCap() err=%v, wantErr=%v", err, c.wantErr)
			}
		})
	}
}

func TestResolveRejectsTraversal(t *testing.T) {
	s := &server{root: t.TempDir()}
	bad := []string{
		"/files/../etc/passwd",
		"/files/..",
		"/files/a/../../etc/passwd",
		"/etc/passwd",
		"/files",
		"/",
		"/files/a\x00b",
	}
	for _, p := range bad {
		if _, err := s.resolve(p); err == nil {
			t.Fatalf("resolve(%q) must be rejected", p)
		}
	}
	good, err := s.resolve("/files/F1/na me #1.bin")
	if err != nil {
		t.Fatalf("resolve valid path: %v", err)
	}
	if !strings.HasPrefix(good, s.root) {
		t.Fatalf("resolved path %q escapes root %q", good, s.root)
	}
}

func TestHTTPEnforcesCapability(t *testing.T) {
	const secret = "test-secret-0123456789abcdef"
	s := &server{root: t.TempDir(), maxBytes: 1 << 20, secret: secret}
	mux := http.NewServeMux()
	mux.HandleFunc("/files/", s.file)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	key := "files/F1/doc.bin"
	exp := time.Now().Unix() + 60

	// PUT without a cap → 403; nothing stored.
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/"+key, strings.NewReader("hello"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("uncapped PUT status = %d, want 403", resp.StatusCode)
	}

	// PUT with a valid cap → 201.
	req, _ = http.NewRequest(http.MethodPut, srv.URL+"/"+key+"?cap="+signCap(secret, key, "put", exp), strings.NewReader("hello"))
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("capped PUT status = %d, want 201", resp.StatusCode)
	}

	// GET with the PUT cap → 403 (op-bound).
	resp, err = http.Get(srv.URL + "/" + key + "?cap=" + signCap(secret, key, "put", exp))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("GET with put-cap status = %d, want 403", resp.StatusCode)
	}

	// GET with a get cap → 200 + stored bytes round-trip.
	resp, err = http.Get(srv.URL + "/" + key + "?cap=" + signCap(secret, key, "get", exp))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "hello" {
		t.Fatalf("capped GET = %d %q, want 200 hello", resp.StatusCode, body)
	}
}
