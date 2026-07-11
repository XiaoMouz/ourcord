package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/wg"
)

// DefaultControlURL is the production control-plane endpoint used when a caller
// does not override it.
const DefaultControlURL = "https://control.ourcord.app"

// DeviceRecord is the metadata the control plane returns for an enrolled device.
type DeviceRecord struct {
	ID        string `json:"id"`
	PublicKey string `json:"public_key"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"`
	LastUsed  *int64 `json:"last_used"`
	RevokedAt *int64 `json:"revoked_at"`
}

// EnrollResult is a DeviceRecord plus the freshly minted device token. The token
// is persisted to disk by EnrollDevice and should not be echoed to a UI.
type EnrollResult struct {
	DeviceRecord
	DeviceToken string `json:"device_token"`
}

// EnrollDevice registers this host's WireGuard key with the control plane and
// persists the returned device credential to <stateDir>/device.token (mode
// 0600). httpClient may be nil (http.DefaultClient is used). The device token is
// present on the result but has already been stored; callers should not surface
// it.
func EnrollDevice(ctx context.Context, httpClient *http.Client, controlURL, stateDir, userToken, name string) (*EnrollResult, error) {
	kp, err := wg.LoadOrCreateKeyPair(filepath.Join(stateDir, "wg.key"))
	if err != nil {
		return nil, fmt.Errorf("load device WireGuard key: %w", err)
	}
	body, _ := json.Marshal(map[string]string{"public_key": kp.PublicKeyBase64(), "name": strings.TrimSpace(name)})
	var result EnrollResult
	if err := deviceRequest(ctx, httpClient, http.MethodPost, controlURL, "/api/devices/enroll", userToken, body, &result); err != nil {
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

// ListDevices returns the caller's enrolled device records (metadata only).
func ListDevices(ctx context.Context, httpClient *http.Client, controlURL, userToken string) ([]DeviceRecord, error) {
	var result struct {
		Devices []DeviceRecord `json:"devices"`
	}
	if err := deviceRequest(ctx, httpClient, http.MethodGet, controlURL, "/api/devices", userToken, nil, &result); err != nil {
		return nil, err
	}
	return result.Devices, nil
}

// RevokeDevice revokes a single device credential by id without affecting the
// caller's other devices or user sessions.
func RevokeDevice(ctx context.Context, httpClient *http.Client, controlURL, userToken, id string) error {
	return deviceRequest(ctx, httpClient, http.MethodDelete, controlURL, "/api/devices/"+id, userToken, nil, nil)
}

func deviceRequest(ctx context.Context, httpClient *http.Client, method, controlURL, path, userToken string, body []byte, out any) error {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
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
	resp, err := httpClient.Do(req)
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
