//go:build !windows

package ipc

func UsesHMACAuth() bool { return true }
