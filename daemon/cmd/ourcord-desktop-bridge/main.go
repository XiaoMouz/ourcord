// ourcord-desktop-bridge is the narrow native boundary used by the Tauri UI.
// It keeps account credentials and daemon transport details outside WebView.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	"github.com/ourcord/ourcord/daemon/pkg/ipc"
	"github.com/ourcord/ourcord/daemon/pkg/wg"
	"github.com/zalando/go-keyring"
)

const (
	credentialService = "OurCord Desktop"
	jwtCredential     = "account-jwt"
	pkceCredential    = "desktop-pkce-verifier"
)

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type response struct {
	ID     string `json:"id,omitempty"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type bridge struct {
	controlURL string
	serviceURL string
	http       *http.Client
	socketPath string
}

func main() {
	once := flag.String("once", "", "execute one JSON request and exit")
	flag.Parse()
	b := &bridge{
		controlURL: envOr("OURCORD_CONTROL_URL", client.DefaultControlURL),
		serviceURL: envOr("OURCORD_SERVICE_URL", "https://service.ourcord.app"),
		http:       &http.Client{Timeout: 15 * time.Second},
		socketPath: envOr("OURCORD_DAEMON_SOCKET", ipc.DefaultSocketPath()),
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if *once != "" {
		var req request
		if err := json.Unmarshal([]byte(*once), &req); err != nil {
			_ = enc.Encode(response{Error: "invalid request"})
			os.Exit(2)
		}
		_ = enc.Encode(b.handle(req))
		return
	}
	dec := json.NewDecoder(io.LimitReader(os.Stdin, 8<<20))
	for {
		var req request
		if err := dec.Decode(&req); err != nil {
			if !errors.Is(err, io.EOF) {
				_ = enc.Encode(response{Error: "invalid request"})
			}
			return
		}
		_ = enc.Encode(b.handle(req))
	}
}

func (b *bridge) handle(req request) (out response) {
	out.ID = req.ID
	defer func() {
		if recovered := recover(); recovered != nil {
			out.Result = nil
			out.Error = "bridge internal error"
		}
	}()
	result, err := b.dispatch(req.Method, req.Params)
	if err != nil {
		out.Error = safeError(err)
		return out
	}
	out.Result = result
	return out
}

func (b *bridge) dispatch(method string, raw json.RawMessage) (any, error) {
	params := map[string]any{}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, errors.New("invalid parameters")
		}
	}
	switch method {
	case "auth.begin":
		verifier, challenge, err := newPKCE()
		if err != nil {
			return nil, err
		}
		if err := keyring.Set(credentialService, pkceCredential, verifier); err != nil {
			return nil, fmt.Errorf("store login state: %w", err)
		}
		return map[string]string{
			"google_url": b.controlURL + "/api/auth/desktop/oauth/google?code_challenge=" + challenge,
			"github_url": b.controlURL + "/api/auth/desktop/oauth/github?code_challenge=" + challenge,
		}, nil
	case "auth.magic":
		email := stringParam(params, "email")
		if email == "" {
			return nil, errors.New("email required")
		}
		verifier, err := keyring.Get(credentialService, pkceCredential)
		if err != nil {
			return nil, errors.New("start login again")
		}
		challenge := pkceChallenge(verifier)
		_, err = b.api(http.MethodPost, b.controlURL, "/api/auth/desktop/magic", "", map[string]string{"email": email, "code_challenge": challenge})
		return map[string]bool{"sent": err == nil}, err
	case "auth.exchange":
		code := stringParam(params, "code")
		verifier, err := keyring.Get(credentialService, pkceCredential)
		if err != nil {
			return nil, errors.New("login session expired")
		}
		data, err := b.api(http.MethodPost, b.controlURL, "/api/auth/desktop/exchange", "", map[string]string{"code": code, "code_verifier": verifier})
		if err != nil {
			return nil, err
		}
		var exchanged struct {
			Token  string `json:"token"`
			UserID string `json:"user_id"`
		}
		if err := json.Unmarshal(data, &exchanged); err != nil || exchanged.Token == "" {
			return nil, errors.New("invalid login response")
		}
		if err := keyring.Set(credentialService, jwtCredential, exchanged.Token); err != nil {
			return nil, fmt.Errorf("store account credential: %w", err)
		}
		_ = keyring.Delete(credentialService, pkceCredential)
		host, _ := os.Hostname()
		// The daemon and bridge share the state directory in the current user-mode
		// deployment. The Windows installer later redirects this enrollment through
		// the service profile RPC without exposing the device token to WebView.
		enrollErr := error(nil)
		if daemon, dialErr := client.Dial(b.socketPath); dialErr == nil {
			_, enrollErr = daemon.EnrollLocalDevice(exchanged.Token, exchanged.UserID, host)
			_ = daemon.Close()
		} else {
			_, enrollErr = client.EnrollDevice(context.Background(), b.http, b.controlURL, wg.DefaultStateDir(), exchanged.Token, host)
		}
		return map[string]any{"authenticated": true, "user_id": exchanged.UserID, "device_enrolled": enrollErr == nil}, nil
	case "auth.status":
		token, err := b.token()
		if err != nil {
			return map[string]bool{"authenticated": false}, nil
		}
		data, err := b.api(http.MethodGet, b.controlURL, "/api/me", token, nil)
		if err != nil {
			return map[string]bool{"authenticated": false}, nil
		}
		var result any
		if err := json.Unmarshal(data, &result); err != nil {
			return nil, err
		}
		return map[string]any{"authenticated": true, "profile": result}, nil
	case "auth.logout":
		_ = keyring.Delete(credentialService, jwtCredential)
		return map[string]bool{"authenticated": false}, nil
	case "profile.update":
		return b.authedJSON(http.MethodPatch, b.controlURL, "/api/me", map[string]string{"display_name": stringParam(params, "display_name")})
	case "lobbies.list":
		return b.authedJSON(http.MethodGet, b.serviceURL, "/api/lobbies", nil)
	case "lobbies.create":
		return b.authedJSON(http.MethodPost, b.serviceURL, "/api/lobbies", map[string]string{"name": stringParam(params, "name")})
	case "lobbies.join":
		path := "/api/lobbies/" + pathSegment(stringParam(params, "lobby_id")) + "/join"
		return b.authedJSON(http.MethodPost, b.serviceURL, path, map[string]string{"code": stringParam(params, "code")})
	case "lobbies.invite":
		path := "/api/lobbies/" + pathSegment(stringParam(params, "lobby_id")) + "/invites"
		return b.authedJSON(http.MethodPost, b.serviceURL, path, map[string]any{"expires_in_seconds": 604800, "max_uses": 0})
	case "rooms.create":
		path := "/api/lobbies/" + pathSegment(stringParam(params, "lobby_id")) + "/rooms"
		return b.authedJSON(http.MethodPost, b.serviceURL, path, map[string]string{"name": stringParam(params, "name"), "type": "voice"})
	case "daemon.snapshot":
		return b.daemonSnapshot()
	case "network.connect", "network.disconnect", "network.enter", "network.leave",
		"voice.join", "voice.leave", "voice.mute", "voice.deafen", "voice.input_mode",
		"voice.ptt", "voice.devices", "voice.set_devices":
		return b.daemonCommand(method, params)
	default:
		return nil, errors.New("unsupported bridge method")
	}
}

func (b *bridge) daemonSnapshot() (any, error) {
	c, err := client.Dial(b.socketPath)
	if err != nil {
		return map[string]any{"daemon_available": false}, nil
	}
	defer c.Close()
	status, err := c.Status()
	if err != nil {
		return nil, err
	}
	peers, err := c.ListPeers()
	if err != nil {
		return nil, err
	}
	voice, err := c.VoiceStatus()
	if err != nil {
		return nil, err
	}
	return map[string]any{"daemon_available": true, "status": status, "peers": peers, "voice": voice}, nil
}

func (b *bridge) daemonCommand(method string, p map[string]any) (any, error) {
	c, err := client.Dial(b.socketPath)
	if err != nil {
		return nil, errors.New("daemon unavailable")
	}
	defer c.Close()
	switch method {
	case "network.connect":
		err = c.Connect()
	case "network.disconnect":
		err = c.Disconnect()
	case "network.enter":
		err = c.EnterNetwork(stringParam(p, "network_id"))
	case "network.leave":
		err = c.LeaveNetwork()
	case "voice.join":
		err = c.VoiceJoin()
	case "voice.leave":
		err = c.VoiceLeave()
	case "voice.mute":
		err = c.SetVoiceMute(boolParam(p, "muted"))
	case "voice.deafen":
		err = c.SetVoiceDeafen(boolParam(p, "deafened"))
	case "voice.input_mode":
		err = c.SetVoiceInputMode(stringParam(p, "mode"), numberParam(p, "threshold_dbfs", -45), uint32(numberParam(p, "hangover_ms", 300)))
	case "voice.ptt":
		err = c.SetPushToTalk(boolParam(p, "pressed"))
	case "voice.set_devices":
		err = c.SetAudioDevices(stringParam(p, "capture_id"), stringParam(p, "playback_id"))
	case "voice.devices":
		capture, playback, listErr := c.ListAudioDevices()
		return map[string]any{"capture": capture, "playback": playback}, listErr
	}
	return map[string]bool{"ok": err == nil}, err
}

func (b *bridge) authedJSON(method, base, path string, body any) (any, error) {
	token, err := b.token()
	if err != nil {
		return nil, errors.New("not authenticated")
	}
	data, err := b.api(method, base, path, token, body)
	if err != nil {
		return nil, err
	}
	var result any
	if len(data) > 0 {
		if err := json.Unmarshal(data, &result); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (b *bridge) api(method, base, path, token string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = bytes.NewReader(data)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(base, "/")+path, reader)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := b.http.Do(req)
	if err != nil {
		return nil, errors.New("service unavailable")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &failure)
		if failure.Error == "" {
			failure.Error = http.StatusText(resp.StatusCode)
		}
		return nil, errors.New(failure.Error)
	}
	return data, nil
}

func (b *bridge) token() (string, error) { return keyring.Get(credentialService, jwtCredential) }

func newPKCE() (string, string, error) {
	raw := make([]byte, 48)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	verifier := base64.RawURLEncoding.EncodeToString(raw)
	return verifier, pkceChallenge(verifier), nil
}
func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
func stringParam(p map[string]any, key string) string {
	value, _ := p[key].(string)
	return strings.TrimSpace(value)
}
func boolParam(p map[string]any, key string) bool { value, _ := p[key].(bool); return value }
func numberParam(p map[string]any, key string, fallback float64) float64 {
	value, ok := p[key].(float64)
	if !ok {
		return fallback
	}
	return value
}
func pathSegment(value string) string {
	return strings.NewReplacer("/", "", "\\", "", "?", "", "#", "").Replace(value)
}
func safeError(err error) string {
	message := err.Error()
	if len(message) > 240 {
		return message[:240]
	}
	return message
}
