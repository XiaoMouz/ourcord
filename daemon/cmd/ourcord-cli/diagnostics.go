package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

// diagnostics is a thin presenter: parse flags, delegate collection to
// daemon/pkg/client, print the output path.
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
	if err := client.CollectDiagnostics(*socket, *logFile, *output); err != nil {
		fmt.Fprintln(os.Stderr, "diagnostics:", err)
		return 1
	}
	fmt.Println(*output)
	return 0
}
