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

func TestMessageHistoryPreservesDeletionRevision(t *testing.T) {
	for _, tt := range []struct {
		name string
		body string
		want *int64
	}{
		{name: "initial", body: `{"messages":[],"deletion_revision":0}`, want: new(int64(0))},
		{name: "deleted", body: `{"messages":[],"deletion_revision":7}`, want: new(int64(7))},
		{name: "legacy", body: `{"messages":[]}`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, tt.body)
			}))
			defer server.Close()
			b := refreshTestBridge(t, server)
			result, err := b.dispatch("messages.list", json.RawMessage(`{"room_id":"room"}`))
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			var page struct {
				Messages         []json.RawMessage `json:"messages"`
				DeletionRevision *int64            `json:"deletion_revision"`
			}
			if err := json.Unmarshal(encoded, &page); err != nil {
				t.Fatal(err)
			}
			if page.Messages == nil || (page.DeletionRevision == nil) != (tt.want == nil) ||
				tt.want != nil && *page.DeletionRevision != *tt.want {
				t.Fatalf("message page metadata changed in bridge: %s", encoded)
			}
		})
	}
}
