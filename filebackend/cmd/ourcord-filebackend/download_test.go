package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSignedAttachmentDownloadsDoNotRedirect(t *testing.T) {
	const secret = "attachment-test-secret"
	const content = "<html>attachment content</html>"
	s := &server{root: t.TempDir(), maxBytes: 1 << 20, secret: secret}
	mux := http.NewServeMux()
	mux.HandleFunc("/files/", s.file)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	client := srv.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	exp := time.Now().Unix() + 60
	for _, name := range []string{"index.html", "report.html"} {
		key := "files/attachment/" + name
		put, err := http.NewRequest(http.MethodPut, srv.URL+"/"+key+"?cap="+signCap(secret, key, "put", exp), strings.NewReader(content))
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(put)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("PUT %s: status %d", name, response.StatusCode)
		}
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			t.Run(name+"/"+method, func(t *testing.T) {
				req, _ := http.NewRequest(method, srv.URL+"/"+key+"?cap="+signCap(secret, key, "get", exp), nil)
				response, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				if err != nil {
					t.Fatal(err)
				}
				if response.StatusCode != http.StatusOK || response.Header.Get("Location") != "" {
					t.Fatalf("signed %s returned %d, location %q", method, response.StatusCode, response.Header.Get("Location"))
				}
				if response.ContentLength != int64(len(content)) || (method == http.MethodGet && string(body) != content) || (method == http.MethodHead && len(body) != 0) {
					t.Fatalf("incorrect attachment response: length=%d body=%q", response.ContentLength, body)
				}
				if method != http.MethodGet {
					return
				}
				lastModified := response.Header.Get("Last-Modified")
				if lastModified == "" {
					t.Fatal("Last-Modified missing")
				}
				for _, partial := range []bool{true, false} {
					req, _ := http.NewRequest(http.MethodGet, req.URL.String(), nil)
					if partial {
						req.Header.Set("Range", "bytes=0-5")
					} else {
						req.Header.Set("If-Modified-Since", lastModified)
					}
					r, err := client.Do(req)
					if err != nil {
						t.Fatal(err)
					}
					body, readErr := io.ReadAll(r.Body)
					r.Body.Close()
					if readErr != nil {
						t.Fatal(readErr)
					}
					if partial && (r.StatusCode != http.StatusPartialContent || string(body) != content[:6]) {
						t.Fatalf("range: status=%d body=%q", r.StatusCode, body)
					}
					if !partial && (r.StatusCode != http.StatusNotModified || len(body) != 0) {
						t.Fatalf("conditional GET: status=%d body=%q", r.StatusCode, body)
					}
				}
			})
		}
	}
}
