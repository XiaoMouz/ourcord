package main

import (
	"archive/zip"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	"github.com/ourcord/ourcord/daemon/pkg/ipc"
	"github.com/ourcord/ourcord/daemon/pkg/logging"
	"github.com/ourcord/ourcord/daemon/pkg/wg"
)

const diagnosticsLogLimit = 512 * 1024

func runDiagnosticsCommand(args []string) int {
	if len(args) == 0 || args[0] != "collect" {
		fmt.Fprintln(os.Stderr, "Usage: ourcord-cli diagnostics collect [--socket path] [--log-file path] [--output archive.zip]")
		return 2
	}
	fs := flag.NewFlagSet("diagnostics collect", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	socket := fs.String("socket", ipc.DefaultSocketPath(), "Daemon IPC socket")
	logFile := fs.String("log-file", "", "Optional daemon JSON/text log file to include")
	output := fs.String("output", "", "Output zip path")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	if *output == "" {
		*output = filepath.Join(".", "ourcord-diagnostics-"+time.Now().UTC().Format("20060102T150405Z")+".zip")
	}
	if err := collectDiagnostics(*socket, *logFile, *output); err != nil {
		fmt.Fprintln(os.Stderr, "diagnostics:", err)
		return 1
	}
	fmt.Println(*output)
	return 0
}

func collectDiagnostics(socketPath, logFile, outputPath string) error {
	cli, err := client.Dial(socketPath)
	if err != nil {
		return fmt.Errorf("connect daemon IPC: %w", err)
	}
	defer cli.Close()
	status, err := cli.Status()
	if err != nil {
		return fmt.Errorf("read daemon status: %w", err)
	}
	peers, err := cli.ListPeers()
	if err != nil {
		return fmt.Errorf("read daemon peers: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o700); err != nil {
		return err
	}
	return writeDiagnosticsArchive(outputPath, socketPath, logFile, status, peers)
}

func writeDiagnosticsArchive(outputPath, socketPath, logFile string, status, peers any) error {
	f, err := os.OpenFile(outputPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := f.Chmod(0o600); err != nil {
		return err
	}
	zw := zip.NewWriter(f)
	defer zw.Close()

	manifest := map[string]any{
		"created_at":        time.Now().UTC().Format(time.RFC3339Nano),
		"goos":              runtime.GOOS,
		"goarch":            runtime.GOARCH,
		"socket":            socketPath,
		"log_included":      logFile != "",
		"state_dir_default": wg.DefaultStateDir(),
	}
	if err := addJSON(zw, "manifest.json", manifest); err != nil {
		return err
	}
	if err := addJSON(zw, "daemon-status.json", status); err != nil {
		return err
	}
	if err := addJSON(zw, "peers.json", peers); err != nil {
		return err
	}
	if logFile != "" {
		data, err := tailFile(logFile, diagnosticsLogLimit)
		if err != nil {
			return fmt.Errorf("read log file: %w", err)
		}
		entry, err := zw.Create("daemon.log")
		if err != nil {
			return err
		}
		if _, err := io.WriteString(entry, logging.Redact(string(data))); err != nil {
			return err
		}
	}
	return nil
}

func addJSON(zw *zip.Writer, name string, value any) error {
	entry, err := zw.Create(name)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(entry)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}

func tailFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	start := info.Size() - limit
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(f, limit))
}
