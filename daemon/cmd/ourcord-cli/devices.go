package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	"github.com/ourcord/ourcord/daemon/pkg/wg"
)

// Device commands are a thin presenter over daemon/pkg/client: parse flags,
// resolve the one-time user JWT, call the core, format output. No control-plane
// logic lives here.

func runDeviceCommand(command string, args []string) int {
	switch command {
	case "enroll":
		return runEnroll(args)
	case "devices":
		return runListDevices(args)
	case "revoke-device":
		return runRevokeDevice(args)
	default:
		fmt.Fprintf(os.Stderr, "unknown device command: %s\n", command)
		return 2
	}
}

func deviceFlags(fs *flag.FlagSet) (*string, *string, *string) {
	controlURL := fs.String("control-url", client.DefaultControlURL, "Control plane URL")
	userToken := fs.String("user-token", os.Getenv("OURCORD_USER_JWT"), "One-time user JWT (prefer OURCORD_USER_JWT environment variable)")
	userTokenFile := fs.String("user-token-file", "", "File containing a one-time user JWT")
	return controlURL, userToken, userTokenFile
}

func resolveUserToken(raw, filePath string) (string, error) {
	if filePath != "" {
		data, err := os.ReadFile(filePath)
		if err != nil {
			return "", fmt.Errorf("read user token file: %w", err)
		}
		raw = string(data)
	}
	token := strings.TrimSpace(raw)
	if token == "" {
		return "", errors.New("a one-time user JWT is required; use OURCORD_USER_JWT, --user-token, or --user-token-file")
	}
	return token, nil
}

func runEnroll(args []string) int {
	fs := flag.NewFlagSet("enroll", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	controlURL, rawToken, tokenFile := deviceFlags(fs)
	stateDir := fs.String("state-dir", wg.DefaultStateDir(), "Daemon state directory")
	name := fs.String("name", "", "Human-readable device name")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 0 {
		fs.Usage()
		return 2
	}
	token, err := resolveUserToken(*rawToken, *tokenFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "enroll:", err)
		return 2
	}
	if *name == "" {
		*name, _ = os.Hostname()
	}
	result, err := client.EnrollDevice(context.Background(), http.DefaultClient, *controlURL, *stateDir, token, *name)
	if err != nil {
		fmt.Fprintln(os.Stderr, "enroll:", err)
		return 1
	}
	// Deliberately omit DeviceToken: it has already been persisted mode 0600 and
	// must not be copied into scrollback, CI output, or support tickets.
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
		"id":         result.ID,
		"public_key": result.PublicKey,
		"name":       result.Name,
		"created_at": result.CreatedAt,
		"token_path": filepath.Join(*stateDir, "device.token"),
	})
	return 0
}

func runListDevices(args []string) int {
	fs := flag.NewFlagSet("devices", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	controlURL, rawToken, tokenFile := deviceFlags(fs)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	token, err := resolveUserToken(*rawToken, *tokenFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "devices:", err)
		return 2
	}
	devices, err := client.ListDevices(context.Background(), http.DefaultClient, *controlURL, token)
	if err != nil {
		fmt.Fprintln(os.Stderr, "devices:", err)
		return 1
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"devices": devices})
	return 0
}

func runRevokeDevice(args []string) int {
	fs := flag.NewFlagSet("revoke-device", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	controlURL, rawToken, tokenFile := deviceFlags(fs)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "Usage: ourcord-cli revoke-device [flags] <device_id>")
		return 2
	}
	token, err := resolveUserToken(*rawToken, *tokenFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "revoke-device:", err)
		return 2
	}
	if err := client.RevokeDevice(context.Background(), http.DefaultClient, *controlURL, token, fs.Arg(0)); err != nil {
		fmt.Fprintln(os.Stderr, "revoke-device:", err)
		return 1
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "id": fs.Arg(0)})
	return 0
}
