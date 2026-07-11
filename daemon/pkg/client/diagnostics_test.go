package client

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

func TestWriteDiagnosticsArchiveRedactsLogCredentials(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "daemon.log")
	if err := os.WriteFile(logPath, []byte("failed using dt_abcdefghijklmnopqrstuvwxyz0123456789\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	archivePath := filepath.Join(dir, "diagnostics.zip")
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
	info, err := os.Stat(archivePath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("archive mode = %v err=%v", info.Mode().Perm(), err)
	}
}
