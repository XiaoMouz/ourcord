package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
)

func TestMessageHistoryForwardsDeletedCursorPosition(t *testing.T) {
	queries := make(chan url.Values, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries <- r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"messages":[]}`)
	}))
	defer server.Close()
	b := refreshTestBridge(t, server)
	_, err := b.dispatch("messages.list", json.RawMessage(`{
		"room_id":"room", "before":"deleted-message", "before_created_at":1792627200, "limit":50
	}`))
	if err != nil {
		t.Fatal(err)
	}
	query := <-queries
	if query.Get("before") != "deleted-message" || query.Get("before_created_at") != "1792627200" || query.Get("limit") != "50" {
		t.Fatalf("history query lost cursor position: %v", query)
	}
}

func TestMessageHistoryRejectsInvalidCursorPosition(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_, _ = io.WriteString(w, `{"messages":[]}`)
	}))
	defer server.Close()
	b := refreshTestBridge(t, server)
	for _, params := range []string{
		`{"room_id":"room","before":"message","before_created_at":-1}`,
		`{"room_id":"room","before":"message","before_created_at":1.5}`,
		`{"room_id":"room","before":"message","before_created_at":9007199254740992}`,
		`{"room_id":"room","before":"message","before_created_at":"invalid"}`,
		`{"room_id":"room","before_created_at":100}`,
	} {
		if _, err := b.dispatch("messages.list", json.RawMessage(params)); err == nil {
			t.Errorf("invalid cursor accepted: %s", params)
		}
	}
	if got := requests.Load(); got != 0 {
		t.Errorf("invalid cursors made %d service requests", got)
	}
}
