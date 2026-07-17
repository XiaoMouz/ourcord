package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestMessagesPath(t *testing.T) {
	tests := []struct {
		name           string
		roomID, before string
		limit          int
		want           string
	}{
		{name: "default page", roomID: "room1", limit: 50, want: "/api/rooms/room1/messages?limit=50"},
		{name: "pagination cursor", roomID: "room1", before: "msg9", limit: 25, want: "/api/rooms/room1/messages?before=msg9&limit=25"},
		{name: "no limit", roomID: "room1", want: "/api/rooms/room1/messages"},
		{name: "path traversal stripped", roomID: "../admin", limit: 10, want: "/api/rooms/..admin/messages?limit=10"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := messagesPath(tt.roomID, tt.before, tt.limit); got != tt.want {
				t.Fatalf("messagesPath() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestStringSliceParam(t *testing.T) {
	params := map[string]any{}
	if err := json.Unmarshal([]byte(`{"user_ids":["a"," b ","",42,null,"c"]}`), &params); err != nil {
		t.Fatal(err)
	}
	got := stringSliceParam(params, "user_ids")
	if want := []string{"a", "b", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("stringSliceParam() = %v, want %v", got, want)
	}
	if got := stringSliceParam(params, "missing"); len(got) != 0 {
		t.Fatalf("missing key should yield empty slice, got %v", got)
	}
}

func TestSafeFilename(t *testing.T) {
	tests := []struct{ in, want string }{
		{"photo.png", "photo.png"},
		{"../../etc/passwd", "_.._etc_passwd"},
		{"a\\b/c.txt", "a_b_c.txt"},
		{"  spaced.jpg  ", "spaced.jpg"},
		{"...hidden", "hidden"},
		{"", ""},
	}
	for _, tt := range tests {
		if got := safeFilename(tt.in); got != tt.want {
			t.Errorf("safeFilename(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestHandleRejectsUnknownMethod(t *testing.T) {
	b := &bridge{}
	resp := b.handle(request{ID: "7", Method: "definitely.not.a.method"})
	if resp.ID != "7" {
		t.Fatalf("response ID = %q, want %q", resp.ID, "7")
	}
	if resp.Error != "unsupported bridge method" {
		t.Fatalf("response Error = %q", resp.Error)
	}
}

func TestHandleRejectsMalformedParams(t *testing.T) {
	b := &bridge{}
	resp := b.handle(request{ID: "8", Method: "profiles.lookup", Params: json.RawMessage(`[1,2]`)})
	if resp.Error != "invalid parameters" {
		t.Fatalf("response Error = %q, want invalid parameters", resp.Error)
	}
}

func TestProfilesLookupEmptyShortCircuits(t *testing.T) {
	// No user_ids → no network call, empty result, no auth required.
	b := &bridge{}
	result, err := b.dispatch("profiles.lookup", json.RawMessage(`{"user_ids":[]}`))
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}
	out, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("result type %T", result)
	}
	profiles, ok := out["profiles"].([]any)
	if !ok || len(profiles) != 0 {
		t.Fatalf("profiles = %#v, want empty slice", out["profiles"])
	}
}
