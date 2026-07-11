package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/wg"
)

const defaultControlURL = "https://control.ourcord.app"

type deviceRecord struct {
	ID        string `json:"id"`
	PublicKey string `json:"public_key"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"`
	LastUsed  *int64 `json:"last_used"`
	RevokedAt *int64 `json:"revoked_at"`
}

type enrollResponse struct {
	deviceRecord
	DeviceToken string `json:"device_token"`
}

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
	controlURL := fs.String("control-url", defaultControlURL, "Control plane URL")
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
	result, err := enrollDevice(context.Background(), http.DefaultClient, *controlURL, *stateDir, token, *name)
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
	devices, err := listDevices(context.Background(), http.DefaultClient, *controlURL, token)
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
	if err := revokeDevice(context.Background(), http.DefaultClient, *controlURL, token, fs.Arg(0)); err != nil {
		fmt.Fprintln(os.Stderr, "revoke-device:", err)
		return 1
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "id": fs.Arg(0)})
	return 0
}

func enrollDevice(ctx context.Context, client *http.Client, controlURL, stateDir, userToken, name string) (*enrollResponse, error) {
	keyPath := filepath.Join(stateDir, "wg.key")
	kp, err := wg.LoadOrCreateKeyPair(keyPath)
	if err != nil {
		return nil, fmt.Errorf("load device WireGuard key: %w", err)
	}
	body, _ := json.Marshal(map[string]string{"public_key": kp.PublicKeyBase64(), "name": strings.TrimSpace(name)})
	var result enrollResponse
	if err := deviceRequest(ctx, client, http.MethodPost, controlURL, "/api/devices/enroll", userToken, body, &result); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(result.DeviceToken, "dt_") {
		return nil, errors.New("control returned an invalid device credential")
	}
	if err := writePrivateFile(filepath.Join(stateDir, "device.token"), []byte(result.DeviceToken+"\n")); err != nil {
		return nil, fmt.Errorf("store device credential: %w", err)
	}
	return &result, nil
}

func listDevices(ctx context.Context, client *http.Client, controlURL, userToken string) ([]deviceRecord, error) {
	var result struct {
		Devices []deviceRecord `json:"devices"`
	}
	if err := deviceRequest(ctx, client, http.MethodGet, controlURL, "/api/devices", userToken, nil, &result); err != nil {
		return nil, err
	}
	return result.Devices, nil
}

func revokeDevice(ctx context.Context, client *http.Client, controlURL, userToken, id string) error {
	return deviceRequest(ctx, client, http.MethodDelete, controlURL, "/api/devices/"+id, userToken, nil, nil)
}

func deviceRequest(ctx context.Context, client *http.Client, method, controlURL, path, userToken string, body []byte, out any) error {
	base := strings.TrimRight(strings.TrimSpace(controlURL), "/")
	if base == "" {
		return errors.New("empty control URL")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+userToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &failure)
		if failure.Error == "" {
			failure.Error = http.StatusText(resp.StatusCode)
		}
		return fmt.Errorf("control returned %d: %s", resp.StatusCode, failure.Error)
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("decode control response: %w", err)
		}
	}
	return nil
}

func writePrivateFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := f.Chmod(0o600); err != nil {
		return err
	}
	_, err = f.Write(data)
	return err
}
