package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

func admitReqBody(t *testing.T, np key.NodePublic) *bytes.Buffer {
	t.Helper()
	b, err := json.Marshal(tailcfg.DERPAdmitClientRequest{NodePublic: np})
	if err != nil {
		t.Fatalf("marshal admit request: %v", err)
	}
	return bytes.NewBuffer(b)
}

func TestAdmitDecision(t *testing.T) {
	if !admitDecision(nil, "nodekey:abc") {
		t.Fatal("nil predicate must admit everyone")
	}
	banned := func(k string) bool { return k == "nodekey:bad" }
	if admitDecision(banned, "nodekey:bad") {
		t.Fatal("banned key must be denied")
	}
	if !admitDecision(banned, "nodekey:ok") {
		t.Fatal("unbanned key must be admitted")
	}
}

func TestDerpAdmitHandler(t *testing.T) {
	np := key.NewNode().Public()

	t.Run("unbanned key → Allow true", func(t *testing.T) {
		h := derpAdmitHandler(func(string) bool { return false })
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodPost, "/internal/derp-admit", admitReqBody(t, np)))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		var resp tailcfg.DERPAdmitClientResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !resp.Allow {
			t.Fatal("expected Allow=true")
		}
	})

	t.Run("banned key → Allow false", func(t *testing.T) {
		want := np.String()
		h := derpAdmitHandler(func(k string) bool { return k == want })
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodPost, "/internal/derp-admit", admitReqBody(t, np)))
		var resp tailcfg.DERPAdmitClientResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.Allow {
			t.Fatal("banned key must yield Allow=false")
		}
	})

	t.Run("nil predicate (no control plane) → Allow true", func(t *testing.T) {
		h := derpAdmitHandler(nil)
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodPost, "/internal/derp-admit", admitReqBody(t, np)))
		var resp tailcfg.DERPAdmitClientResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !resp.Allow {
			t.Fatal("nil predicate must admit")
		}
	})

	t.Run("GET → 405", func(t *testing.T) {
		h := derpAdmitHandler(nil)
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, "/internal/derp-admit", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", rec.Code)
		}
	})

	t.Run("bad JSON → 400", func(t *testing.T) {
		h := derpAdmitHandler(nil)
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodPost, "/internal/derp-admit", strings.NewReader("{not-json")))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}

func TestHealthHandler(t *testing.T) {
	h := healthHandler("us-east")
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q", ct)
	}
	var body struct {
		Status string `json:"status"`
		Region string `json:"region"`
		TS     int64  `json:"ts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode health: %v", err)
	}
	if body.Status != "ok" || body.Region != "us-east" || body.TS == 0 {
		t.Fatalf("unexpected health body: %+v", body)
	}
}
