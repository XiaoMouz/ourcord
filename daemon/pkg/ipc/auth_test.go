package ipc

import (
	"crypto/rand"
	"net"
	"path/filepath"
	"testing"
)

func TestLoadOrCreateHMACKey_GeneratesAndPersists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ipc.key")

	first, err := LoadOrCreateHMACKey(path)
	if err != nil {
		t.Fatalf("first load: %v", err)
	}
	if len(first) != HMACKeyLen {
		t.Fatalf("expected %d bytes, got %d", HMACKeyLen, len(first))
	}
	second, err := LoadOrCreateHMACKey(path)
	if err != nil {
		t.Fatalf("second load: %v", err)
	}
	if string(first) != string(second) {
		t.Fatal("secret should persist across loads")
	}
}

func TestLoadOrCreateHMACKey_RejectsWrongLength(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ipc.key")
	// Hex-encoded 16 bytes = wrong length
	if err := writeFile(path, []byte("00112233445566778899aabbccddeeff\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateHMACKey(path); err == nil {
		t.Fatal("expected error for short key")
	}
}

func writeFile(path string, data []byte) error {
	f, err := openCreate(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(data)
	return err
}

func TestAuthHandshake_ValidSecret(t *testing.T) {
	secret := make([]byte, HMACKeyLen)
	rand.Read(secret)
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	errCh := make(chan error, 2)
	go func() { _, err := authHandshakeServer(a, secret); errCh <- err }()
	go func() { errCh <- authHandshakeClient(b, secret) }()
	for i := 0; i < 2; i++ {
		if err := <-errCh; err != nil {
			t.Fatalf("handshake error: %v", err)
		}
	}
}

func TestAuthHandshake_WrongSecret(t *testing.T) {
	srvSecret := make([]byte, HMACKeyLen)
	cliSecret := make([]byte, HMACKeyLen)
	rand.Read(srvSecret)
	rand.Read(cliSecret)

	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	srvErr := make(chan error, 1)
	cliErr := make(chan error, 1)
	go func() { _, err := authHandshakeServer(a, srvSecret); srvErr <- err }()
	go func() { cliErr <- authHandshakeClient(b, cliSecret) }()

	if err := <-srvErr; err == nil {
		t.Fatal("server should reject wrong-secret client")
	}
	// client may succeed (it just sends its computed HMAC and exits)
	<-cliErr
}
