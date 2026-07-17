// ourcord-desktop-bridge is the narrow native boundary used by the Tauri UI.
// It keeps account credentials and daemon transport details outside WebView.
package main

import (
	"bufio"
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
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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

	daemonMu sync.Mutex
	daemon   *client.Client
}

func main() {
	once := flag.String("once", "", "execute one JSON request and exit")
	flag.Parse()
	b := &bridge{
		controlURL: envOr("OURCORD_CONTROL_URL", client.DefaultControlURL),
		serviceURL: envOr("OURCORD_SERVICE_URL", "https://service.ourcord.mou.best"),
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
	// Persistent mode: one JSON request per line, responses correlated by id.
	// Requests are handled concurrently so a slow HTTP call cannot stall the
	// UI's 1 Hz daemon.snapshot poll; the encoder is the only shared writer.
	var encMu sync.Mutex
	reply := func(resp response) {
		encMu.Lock()
		defer encMu.Unlock()
		_ = enc.Encode(resp)
	}
	var wg sync.WaitGroup
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			reply(response{Error: "invalid request"})
			continue
		}
		wg.Add(1)
		go func(req request) {
			defer wg.Done()
			reply(b.handle(req))
		}(req)
	}
	wg.Wait()
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
		if daemon, dialErr := b.daemonClient(); dialErr == nil {
			_, enrollErr = daemon.EnrollLocalDevice(exchanged.Token, exchanged.UserID, host)
			b.dropDaemon(daemon, enrollErr)
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
	case "lobbies.members":
		path := "/api/lobbies/" + pathSegment(stringParam(params, "lobby_id")) + "/members"
		return b.authedJSON(http.MethodGet, b.serviceURL, path, nil)
	case "rooms.create":
		roomType := stringParam(params, "type")
		if roomType == "" {
			roomType = "voice"
		}
		path := "/api/lobbies/" + pathSegment(stringParam(params, "lobby_id")) + "/rooms"
		return b.authedJSON(http.MethodPost, b.serviceURL, path, map[string]string{"name": stringParam(params, "name"), "type": roomType})
	case "rooms.update":
		path := "/api/rooms/" + pathSegment(stringParam(params, "room_id"))
		payload := map[string]any{}
		if name := stringParam(params, "name"); name != "" {
			payload["name"] = name
		}
		if _, ok := params["position"]; ok {
			payload["position"] = int(numberParam(params, "position", 0))
		}
		return b.authedJSON(http.MethodPatch, b.serviceURL, path, payload)
	case "rooms.delete":
		path := "/api/rooms/" + pathSegment(stringParam(params, "room_id"))
		return b.authedJSON(http.MethodDelete, b.serviceURL, path, nil)
	case "files.list":
		path := "/api/rooms/" + pathSegment(stringParam(params, "room_id")) + "/files"
		return b.authedJSON(http.MethodGet, b.serviceURL, path, nil)
	case "files.download":
		return b.downloadFile(stringParam(params, "room_id"), stringParam(params, "file_id"), stringParam(params, "filename"))
	case "messages.list":
		path := messagesPath(stringParam(params, "room_id"), stringParam(params, "before"), int(numberParam(params, "limit", 50)))
		return b.authedJSON(http.MethodGet, b.serviceURL, path, nil)
	case "messages.send":
		path := "/api/rooms/" + pathSegment(stringParam(params, "room_id")) + "/messages"
		return b.authedJSON(http.MethodPost, b.serviceURL, path, map[string]string{"content": stringParam(params, "content")})
	case "messages.delete":
		path := "/api/rooms/" + pathSegment(stringParam(params, "room_id")) + "/messages/" + pathSegment(stringParam(params, "message_id"))
		return b.authedJSON(http.MethodDelete, b.serviceURL, path, nil)
	case "profiles.lookup":
		ids := stringSliceParam(params, "user_ids")
		if len(ids) == 0 {
			return map[string]any{"profiles": []any{}}, nil
		}
		return b.authedJSON(http.MethodPost, b.controlURL, "/api/profiles/lookup", map[string]any{"user_ids": ids})
	case "daemon.snapshot":
		return b.daemonSnapshot()
	case "daemon.profile":
		return b.daemonProfile()
	case "diagnostics.ping":
		return b.daemonPing()
	case "diagnostics.force_derp":
		return b.forceDERP(stringParam(params, "public_key"), stringParam(params, "reason"))
	case "devices.list":
		return b.listDevices()
	case "devices.revoke":
		return b.revokeDevice(stringParam(params, "id"))
	case "network.connect", "network.disconnect", "network.enter", "network.leave",
		"voice.join", "voice.leave", "voice.mute", "voice.deafen", "voice.input_mode",
		"voice.ptt", "voice.devices", "voice.set_devices":
		return b.daemonCommand(method, params)
	default:
		return nil, errors.New("unsupported bridge method")
	}
}

// daemonProfile reports local enrollment identity (public key, device id,
// enrolled state) so the UI can show device/account status.
func (b *bridge) daemonProfile() (any, error) {
	c, err := b.daemonClient()
	if err != nil {
		return map[string]any{"enrolled": false, "daemon_available": false}, nil
	}
	profile, err := c.LocalProfile()
	if err != nil {
		b.dropDaemon(c, err)
		return nil, err
	}
	return map[string]any{"daemon_available": true, "profile": profile}, nil
}

// daemonPing round-trips the daemon control socket for a liveness check.
func (b *bridge) daemonPing() (any, error) {
	c, err := b.daemonClient()
	if err != nil {
		return nil, errors.New("daemon unavailable")
	}
	start := time.Now()
	if err := c.Ping(); err != nil {
		b.dropDaemon(c, err)
		return nil, err
	}
	return map[string]any{"ok": true, "rtt_ms": time.Since(start).Milliseconds()}, nil
}

// forceDERP pins a peer to the relay path for diagnostics (mirrors the TUI's
// "D" action and the CLI force-derp command).
func (b *bridge) forceDERP(publicKey, reason string) (any, error) {
	if publicKey == "" {
		return nil, errors.New("public_key required")
	}
	c, err := b.daemonClient()
	if err != nil {
		return nil, errors.New("daemon unavailable")
	}
	err = c.ForceDERP(publicKey, reason)
	b.dropDaemon(c, err)
	return map[string]bool{"ok": err == nil}, err
}

// listDevices returns the account's enrolled device records (metadata only)
// from the control plane using the stored account JWT.
func (b *bridge) listDevices() (any, error) {
	token, err := b.token()
	if err != nil {
		return nil, errors.New("not authenticated")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	devices, err := client.ListDevices(ctx, b.http, b.controlURL, token)
	if err != nil {
		return nil, err
	}
	return map[string]any{"devices": devices}, nil
}

// revokeDevice revokes one device credential by id without touching the
// account's other devices.
func (b *bridge) revokeDevice(id string) (any, error) {
	if id == "" {
		return nil, errors.New("device id required")
	}
	token, err := b.token()
	if err != nil {
		return nil, errors.New("not authenticated")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := client.RevokeDevice(ctx, b.http, b.controlURL, token, id); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

// daemonClient returns the cached daemon connection, dialing on first use.
// The gRPC connection re-authenticates through its context dialer, so it
// survives daemon restarts; dropDaemon handles the cases it does not.
func (b *bridge) daemonClient() (*client.Client, error) {
	b.daemonMu.Lock()
	defer b.daemonMu.Unlock()
	if b.daemon != nil {
		return b.daemon, nil
	}
	c, err := client.Dial(b.socketPath)
	if err != nil {
		return nil, err
	}
	b.daemon = c
	return c, nil
}

// dropDaemon discards the cached connection after a transport-level failure
// so the next call redials. Daemon rejections (*client.DaemonError) keep it.
func (b *bridge) dropDaemon(c *client.Client, err error) {
	var rejection *client.DaemonError
	if err == nil || errors.As(err, &rejection) {
		return
	}
	b.daemonMu.Lock()
	defer b.daemonMu.Unlock()
	if b.daemon == c {
		_ = c.Close()
		b.daemon = nil
	}
}

func (b *bridge) daemonSnapshot() (any, error) {
	c, err := b.daemonClient()
	if err != nil {
		return map[string]any{"daemon_available": false}, nil
	}
	status, err := c.Status()
	if err != nil {
		b.dropDaemon(c, err)
		return map[string]any{"daemon_available": false}, nil
	}
	peers, err := c.ListPeers()
	if err != nil {
		b.dropDaemon(c, err)
		return nil, err
	}
	voice, err := c.VoiceStatus()
	if err != nil {
		b.dropDaemon(c, err)
		return nil, err
	}
	return map[string]any{"daemon_available": true, "status": status, "peers": peers, "voice": voice}, nil
}

func (b *bridge) daemonCommand(method string, p map[string]any) (any, error) {
	c, err := b.daemonClient()
	if err != nil {
		return nil, errors.New("daemon unavailable")
	}
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
		b.dropDaemon(c, listErr)
		return map[string]any{"capture": capture, "playback": playback}, listErr
	}
	b.dropDaemon(c, err)
	return map[string]bool{"ok": err == nil}, err
}

// downloadFile fetches a room attachment and saves it to the OS downloads
// directory. The service serves R2-backed files as raw bytes and
// backend-hosted files as a JSON {url} redirect, so this follows both: it
// streams the download to disk (bypassing the 1 MB api() cap) and returns the
// saved path for the UI to reveal. Uploading stays a separate concern.
func (b *bridge) downloadFile(roomID, fileID, filename string) (any, error) {
	if roomID == "" || fileID == "" {
		return nil, errors.New("room_id and file_id required")
	}
	token, err := b.token()
	if err != nil {
		return nil, errors.New("not authenticated")
	}
	url := strings.TrimRight(b.serviceURL, "/") + "/api/rooms/" + pathSegment(roomID) + "/files/" + pathSegment(fileID) + "/download"
	body, contentType, err := b.fetchStream(http.MethodGet, url, token)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	// Backend-hosted files answer with a JSON redirect; follow it unauthenticated.
	if strings.HasPrefix(contentType, "application/json") {
		data, _ := io.ReadAll(io.LimitReader(body, 1<<20))
		var redirect struct {
			URL string `json:"url"`
		}
		if json.Unmarshal(data, &redirect) != nil || redirect.URL == "" {
			return nil, errors.New("download unavailable")
		}
		next, _, err := b.fetchStream(http.MethodGet, redirect.URL, "")
		if err != nil {
			return nil, err
		}
		defer next.Close()
		return b.saveDownload(filename, fileID, next)
	}
	return b.saveDownload(filename, fileID, body)
}

// fetchStream issues a GET and returns the still-open body for streaming. The
// caller must Close it.
func (b *bridge) fetchStream(method, url, token string) (io.ReadCloser, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		cancel()
		return nil, "", err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := b.http.Do(req)
	if err != nil {
		cancel()
		return nil, "", errors.New("download failed")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		resp.Body.Close()
		cancel()
		return nil, "", fmt.Errorf("download failed (%d)", resp.StatusCode)
	}
	return &cancelReadCloser{ReadCloser: resp.Body, cancel: cancel}, resp.Header.Get("Content-Type"), nil
}

type cancelReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelReadCloser) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}

// saveDownload writes a stream to <downloads>/<filename>, avoiding overwrite by
// suffixing the file id, and returns the saved path.
func (b *bridge) saveDownload(filename, fileID string, src io.Reader) (any, error) {
	name := safeFilename(filename)
	if name == "" {
		name = "ourcord-" + pathSegment(fileID)
	}
	dir := downloadsDir()
	target := filepath.Join(dir, name)
	if _, err := os.Stat(target); err == nil {
		ext := filepath.Ext(name)
		target = filepath.Join(dir, strings.TrimSuffix(name, ext)+"-"+pathSegment(fileID)+ext)
	}
	out, err := os.Create(target)
	if err != nil {
		return nil, fmt.Errorf("save file: %w", err)
	}
	if _, err := io.Copy(out, io.LimitReader(src, 512<<20)); err != nil {
		out.Close()
		return nil, fmt.Errorf("save file: %w", err)
	}
	if err := out.Close(); err != nil {
		return nil, fmt.Errorf("save file: %w", err)
	}
	return map[string]string{"saved_path": target}, nil
}

// downloadsDir resolves the user's Downloads folder, falling back to the OS
// temp dir when the home directory is unavailable.
func downloadsDir() string {
	if home, err := os.UserHomeDir(); err == nil {
		candidate := filepath.Join(home, "Downloads")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		return home
	}
	return os.TempDir()
}

// safeFilename strips path separators and control characters so a server-named
// file cannot escape the downloads directory.
func safeFilename(name string) string {
	name = strings.TrimSpace(name)
	name = strings.NewReplacer("/", "_", "\\", "_", "\x00", "").Replace(name)
	name = strings.TrimLeft(name, ".")
	if len(name) > 180 {
		name = name[len(name)-180:]
	}
	return name
}

// messagesPath builds the room message-history path with optional pagination.
func messagesPath(roomID, before string, limit int) string {
	query := url.Values{}
	if before != "" {
		query.Set("before", before)
	}
	if limit > 0 {
		query.Set("limit", strconv.Itoa(limit))
	}
	path := "/api/rooms/" + pathSegment(roomID) + "/messages"
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	return path
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
func stringSliceParam(p map[string]any, key string) []string {
	raw, _ := p[key].([]any)
	values := make([]string, 0, len(raw))
	for _, item := range raw {
		if value, ok := item.(string); ok {
			if value = strings.TrimSpace(value); value != "" {
				values = append(values, value)
			}
		}
	}
	return values
}
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
