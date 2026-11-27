package client

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

func TestFailedDiagnosticsExportPreservesExistingArchive(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "diagnostics.zip")
	if err := writeDiagnosticsArchive(path, "test-socket", "", "first export", nil); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeDiagnosticsArchive(path, "test-socket", filepath.Join(dir, "missing.log"), "second export", nil); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("export with missing log = %v, want a read error", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(after, before) {
		t.Fatalf("failed export changed existing ZIP (read error %v)", err)
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 1 || files[0].Name() != "diagnostics.zip" {
		t.Fatalf("unexpected files after failed export: %v (%v)", files, err)
	}
	assertPrivateOutput(t, path)
}

type failingDiagnosticsWriter struct{ err error }

func (w failingDiagnosticsWriter) Write([]byte) (int, error) { return 0, w.err }

func TestDiagnosticsZIPPropagatesFlushError(t *testing.T) {
	failure := errors.New("output unavailable")
	if err := writeDiagnosticsZIP(failingDiagnosticsWriter{failure}, "test-socket", "", nil, nil); !errors.Is(err, failure) {
		t.Fatalf("ZIP write error = %v, want %v", err, failure)
	}
}

func TestWriteDiagnosticsArchiveRedactsLogCredentials(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "daemon.log")
	if err := os.WriteFile(logPath, []byte("failed using dt_abcdefghijklmnopqrstuvwxyz0123456789\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	archivePath := filepath.Join(dir, "diagnostics.zip")
	if err := os.WriteFile(archivePath, []byte("previous export"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeDiagnosticsArchive(archivePath, "/tmp/ourcordd.sock", logPath, ipc.DaemonStatus{PathSummary: "derp"}, []ipc.ConnectedPeer{{PublicKey: "peer"}}); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	var contents string
	for _, f := range zr.File {
		if f.Name != "daemon.log" {
			continue
		}
		r, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(r)
		if err != nil {
			t.Fatal(err)
		}
		_ = r.Close()
		contents = string(data)
	}
	if contents == "" || strings.Contains(contents, "dt_") || !strings.Contains(contents, "REDACTED_DEVICE_TOKEN") {
		t.Fatalf("diagnostics log was not redacted: %q", contents)
	}
	assertPrivateOutput(t, archivePath)
}
