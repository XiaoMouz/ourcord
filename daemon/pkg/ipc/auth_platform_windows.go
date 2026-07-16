//go:build windows

package ipc

// The named-pipe DACL provides the local OS authentication boundary. A
// per-user HMAC file cannot be shared safely with a LocalSystem service.
func UsesHMACAuth() bool { return false }
