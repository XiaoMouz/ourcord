package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
)

func TestRoomUpdatesForwardAtomicSwap(t *testing.T) {
	for _, tc := range []struct{ name, input, path, payload string }{
		{"swap from zero", `{"room_id":"source","position":7,"expected_position":0,"swap_with":"target"}`, "/api/rooms/source/reorder", `{"position":7,"expected_position":0,"swap_with":"target"}`},
		{"swap to zero", `{"room_id":"source","position":0,"expected_position":7,"swap_with":"target"}`, "/api/rooms/source/reorder", `{"position":0,"expected_position":7,"swap_with":"target"}`},
		{"rename", `{"room_id":"source","name":"new"}`, "/api/rooms/source", `{"name":"new"}`},
		{"legacy position", `{"room_id":"source","position":0}`, "/api/rooms/source", `{"position":0}`},
		{"incomplete swap", `{"room_id":"source","position":0,"expected_position":7}`, "/api/rooms/source/reorder", `{"position":0,"expected_position":7}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Method != http.MethodPatch || r.URL.Path != tc.path {
					t.Errorf("request = %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("Authorization") != "Bearer expired-jwt" {
					t.Error("missing account authorization")
				}
				var got, want map[string]any
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Error(err)
				}
				if err := json.Unmarshal([]byte(tc.payload), &want); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("payload = %v, want %v", got, want)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"id":"source"}`)
			}))
			defer server.Close()
			b := refreshTestBridge(t, server)
			if _, err := b.dispatch("rooms.update", json.RawMessage(tc.input)); err != nil {
				t.Fatal(err)
			}
			if requests.Load() != 1 {
				t.Fatalf("requests = %d, want 1", requests.Load())
			}
		})
	}
}

func TestRoomSwapDoesNotFallBackOrRetry(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusConflict, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.URL.Path != "/api/rooms/source/reorder" {
					t.Errorf("unsafe fallback: %s", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"error":"swap unavailable"}`)
			}))
			defer server.Close()
			b := refreshTestBridge(t, server)
			_, err := b.dispatch("rooms.update", json.RawMessage(`{"room_id":"source","position":0,"expected_position":7,"swap_with":"target"}`))
			if !isHTTPStatus(err, status) {
				t.Fatalf("error = %v, want HTTP %d", err, status)
			}
			if requests.Load() != 1 {
				t.Fatalf("requests = %d, want 1", requests.Load())
			}
		})
	}
}
