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
	"math"
	"mime"
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
	"golang.org/x/sync/singleflight"
)

const (
	credentialService = "OurCord Desktop"
	jwtCredential     = "account-jwt"
	deviceCredential  = "device-token"
	pkceCredential    = "desktop-pkce-verifier"
)

type credentialStore interface {
	Get(service, user string) (string, error)
	Set(service, user, password string) error
	Delete(service, user string) error
}

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
	controlURL  string
	serviceURL  string
	http        *http.Client
	fileHTTP    *http.Client // no client-level timeout; file transfers are context-bounded
	socketPath  string
	stateDir    string
	downloadDir string // optional destination override; defaults to the OS downloads directory
	credentials credentialStore

	daemonMu    sync.Mutex
	daemon      *client.Client
	authMu      sync.Mutex
	authRefresh singleflight.Group
	sessionMu   sync.RWMutex
}

func main() {
	once := flag.String("once", "", "execute one JSON request and exit")
	flag.Parse()
	b := &bridge{
		controlURL: envOr("OURCORD_CONTROL_URL", client.DefaultControlURL),
		serviceURL: envOr("OURCORD_SERVICE_URL", "https://service.ourcord.mou.best"),
		http:       &http.Client{Timeout: 15 * time.Second},
		fileHTTP:   &http.Client{},
		socketPath: envOr("OURCORD_DAEMON_SOCKET", ipc.DefaultSocketPath()),
		stateDir:   wg.DefaultStateDir(),
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
	// Account requests may refresh credentials or enroll the daemon. Let them
	// finish before logout retires that identity and clears its credentials.
	// Ordinary requests still run concurrently. File transfers guard their short
	// credential exchanges separately so logout never waits for a full stream.
	if method == "auth.logout" {
		b.sessionMu.Lock()
		defer b.sessionMu.Unlock()
	} else if method != "files.upload" && method != "files.download" {
		family, _, _ := strings.Cut(method, ".")
		switch family {
		case "auth", "profile", "profiles", "lobbies", "rooms", "messages", "presence", "devices", "files":
			b.sessionMu.RLock()
			defer b.sessionMu.RUnlock()
		}
	}
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
		if err := b.credentialStore().Set(credentialService, pkceCredential, verifier); err != nil {
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
		verifier, err := b.credentialStore().Get(credentialService, pkceCredential)
		if err != nil {
			return nil, errors.New("start login again")
		}
		challenge := pkceChallenge(verifier)
		data, err := b.api(http.MethodPost, b.controlURL, "/api/auth/desktop/magic", "", map[string]string{"email": email, "code_challenge": challenge})
		if err != nil {
			return nil, err
		}
		return decodeMagicResponse(data)
	case "auth.exchange":
		code := stringParam(params, "code")
		verifier, err := b.credentialStore().Get(credentialService, pkceCredential)
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
		if err := b.credentialStore().Set(credentialService, jwtCredential, exchanged.Token); err != nil {
			return nil, fmt.Errorf("store account credential: %w", err)
		}
		_ = b.credentialStore().Delete(credentialService, pkceCredential)
		host, _ := os.Hostname()
		// The daemon and bridge share the state directory in the current user-mode
		// deployment. The Windows installer later redirects this enrollment through
		// the service profile RPC without exposing the device token to WebView.
		enrollErr := error(nil)
		if daemon, dialErr := b.daemonClient(); dialErr == nil {
			_, enrollErr = daemon.EnrollLocalDevice(exchanged.Token, exchanged.UserID, host)
			b.dropDaemon(daemon, enrollErr)
		} else {
			var enrolled *client.EnrollResult
			enrolled, enrollErr = client.EnrollDevice(context.Background(), b.http, b.controlURL, b.clientStateDir(), exchanged.Token, host)
			if enrollErr == nil {
				enrollErr = b.credentialStore().Set(credentialService, deviceCredential, enrolled.DeviceToken)
			}
		}
		if enrollErr == nil {
			_ = b.cacheDeviceCredentialFromDisk()
		}
		return map[string]any{"authenticated": true, "user_id": exchanged.UserID, "device_enrolled": enrollErr == nil}, nil
	case "auth.status":
		return b.authStatus()
	case "auth.logout":
		if daemon, err := b.daemonClient(); err == nil {
			// Retire the server-side device/peer before erasing the only local
			// identity that tells us which record belongs to this installation.
			// A failed remote revoke leaves the session intact so logout can be
			// retried instead of silently creating a ghost peer.
			if profile, profileErr := daemon.LocalProfile(); profileErr == nil && profile.DeviceID != "" {
				// Root-owned macOS state is not readable by the bridge, so refresh
				// through the daemon itself before revoking the current device.
				if session, refreshErr := daemon.RefreshSession(); refreshErr == nil && session.AccessToken != "" {
					_ = b.credentialStore().Set(credentialService, jwtCredential, session.AccessToken)
				}
				if _, revokeErr := b.revokeDevice(profile.DeviceID); revokeErr != nil && !isHTTPStatus(revokeErr, http.StatusNotFound) {
					b.dropDaemon(daemon, nil)
					return nil, fmt.Errorf("retire device: %w", revokeErr)
				}
			}
			err = daemon.UnenrollLocalDevice()
			b.dropDaemon(daemon, err)
			if err != nil {
				return nil, err
			}
		}
		// Presence is account-scoped and independent from the daemon's network
		// lease. Retire it before deleting the JWT; TTL remains the crash fallback.
		if b.http != nil && b.serviceURL != "" {
			_, _ = b.authedJSON(http.MethodDelete, b.serviceURL, "/api/presence", nil)
		}
		_ = b.credentialStore().Delete(credentialService, jwtCredential)
		_ = b.credentialStore().Delete(credentialService, deviceCredential)
		_ = b.credentialStore().Delete(credentialService, pkceCredential)
		_ = os.Remove(filepath.Join(b.clientStateDir(), "device.token"))
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
	case "presence.update":
		return b.authedJSON(http.MethodPost, b.serviceURL, "/api/presence", map[string]string{"voice_room_id": stringParam(params, "voice_room_id")})
	case "presence.leave":
		return b.authedJSON(http.MethodDelete, b.serviceURL, "/api/presence", nil)
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
		before := stringParam(params, "before")
		var beforeCreatedAt *int64
		if raw, supplied := params["before_created_at"]; supplied {
			value, number := raw.(float64)
			if !number || before == "" || value < 0 || value > 9007199254740991 || math.Trunc(value) != value {
				return nil, errors.New("before_created_at must be a non-negative safe integer with before")
			}
			seconds := int64(value)
			beforeCreatedAt = &seconds
		}
		path := messagesPath(stringParam(params, "room_id"), before, int(numberParam(params, "limit", 50)), beforeCreatedAt)
		return b.authedJSON(http.MethodGet, b.serviceURL, path, nil)
	case "messages.send":
		path := "/api/rooms/" + pathSegment(stringParam(params, "room_id")) + "/messages"
		payload := map[string]any{"content": stringParam(params, "content")}
		if attachments := stringSliceParam(params, "attachments"); len(attachments) > 0 {
			payload["attachments"] = attachments
		}
		return b.authedJSON(http.MethodPost, b.serviceURL, path, payload)
	case "files.upload":
		return b.uploadFile(stringParam(params, "room_id"), stringParam(params, "path"))
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
		"voice.join", "voice.join_network", "voice.leave", "voice.mute", "voice.deafen",
		"voice.input_mode", "voice.ptt", "voice.devices", "voice.set_devices":
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
	return b.authedJSON(http.MethodGet, b.controlURL, "/api/devices", nil)
}

// revokeDevice revokes one device credential by id without touching the
// account's other devices.
func (b *bridge) revokeDevice(id string) (any, error) {
	if id == "" {
		return nil, errors.New("device id required")
	}
	return b.authedJSON(http.MethodDelete, b.controlURL, "/api/devices/"+pathSegment(id), nil)
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
	case "voice.join_network":
		// The leave/connect/enter/join orchestration lives in the client core;
		// prefs only apply when the UI sends a mode (it owns the persisted values).
		var prefs *client.VoiceInputPrefs
		if mode := stringParam(p, "mode"); mode != "" {
			prefs = &client.VoiceInputPrefs{Mode: mode, ThresholdDBFS: numberParam(p, "threshold_dbfs", -45), HangoverMS: uint32(numberParam(p, "hangover_ms", 300))}
		}
		err = c.JoinVoiceNetwork(stringParam(p, "network_id"), prefs)
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

// uploadFile reads a local file and runs the service's tiered upload: initiate
// (declaring exact size + a param-free mime type), then either an authed PUT to
// the R2 proxy or a presigned PUT to a registered backend followed by an authed
// complete. Returns the file id for attaching to a message.
func (b *bridge) uploadFile(roomID, path string) (any, error) {
	if roomID == "" || path == "" {
		return nil, errors.New("room_id and path required")
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return nil, errors.New("file not found")
	}
	filename := safeFilename(filepath.Base(path))
	initPath := "/api/rooms/" + pathSegment(roomID) + "/files"
	initBody := map[string]any{"filename": filepath.Base(path), "mime_type": detectMIME(path), "size_bytes": info.Size()}
	initData, err := b.fileAPI(http.MethodPost, initPath, initBody)
	if err != nil {
		return nil, err
	}
	var init struct {
		ID              string `json:"id"`
		StorageLocation string `json:"storage_location"`
		UploadURL       string `json:"upload_url"`
		CompleteURL     string `json:"complete_url"`
		UploadToken     string `json:"upload_token"`
	}
	if err := json.Unmarshal(initData, &init); err != nil || init.ID == "" {
		return nil, errors.New("upload could not be started")
	}

	if init.StorageLocation == "r2" {
		// R2 proxy PUT is authed and enforces an exact byte count.
		if err := b.fileAccountRequest(func(token string) error {
			return b.putFile(strings.TrimRight(b.serviceURL, "/")+init.UploadURL, token, path, info.Size())
		}); err != nil {
			return nil, err
		}
	} else {
		// Backend PUT is presigned (no auth); then complete with the token.
		if err := b.putFile(init.UploadURL, "", path, info.Size()); err != nil {
			return nil, err
		}
		if init.CompleteURL != "" {
			if _, err := b.fileAPI(http.MethodPost, init.CompleteURL, map[string]string{"upload_token": init.UploadToken}); err != nil {
				return nil, fmt.Errorf("finalize upload: %w", err)
			}
		}
	}
	return map[string]any{"file_id": init.ID, "filename": filename, "size_bytes": info.Size()}, nil
}

// putFile streams a local file as the body of a PUT with an exact Content-Length.
func (b *bridge) putFile(url, token, path string, size int64) error {
	file, err := os.Open(path)
	if err != nil {
		return errors.New("file not found")
	}
	defer file.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, file)
	if err != nil {
		return err
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", detectMIME(path))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := b.fileHTTP.Do(req)
	if err != nil {
		return errors.New("upload failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &httpStatusError{status: resp.StatusCode, message: fmt.Sprintf("upload failed (%d)", resp.StatusCode)}
	}
	return nil
}

// detectMIME resolves a param-free media type from the file extension; the
// control plane rejects parameters (e.g. "; charset=..."), so they are stripped.
func detectMIME(path string) string {
	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	if mimeType == "" {
		return "application/octet-stream"
	}
	if idx := strings.IndexByte(mimeType, ';'); idx >= 0 {
		mimeType = strings.TrimSpace(mimeType[:idx])
	}
	return mimeType
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
	url := strings.TrimRight(b.serviceURL, "/") + "/api/rooms/" + pathSegment(roomID) + "/files/" + pathSegment(fileID) + "/download"
	var body io.ReadCloser
	var headers http.Header
	err := b.fileAccountRequest(func(token string) error {
		var requestErr error
		body, headers, requestErr = b.fetchStream(http.MethodGet, url, token)
		return requestErr
	})
	if err != nil {
		return nil, err
	}
	defer body.Close()
	// R2 objects retain their original MIME type, including application/json.
	// The service marks raw file bytes as an attachment; only its unmarked
	// JSON response is a backend download descriptor.
	contentType, _, _ := mime.ParseMediaType(headers.Get("Content-Type"))
	disposition, _, _ := mime.ParseMediaType(headers.Get("Content-Disposition"))
	if contentType == "application/json" && disposition != "attachment" {
		data, err := io.ReadAll(io.LimitReader(body, 1<<20))
		if err != nil {
			return nil, errors.New("download unavailable")
		}
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
func (b *bridge) fetchStream(method, url, token string) (io.ReadCloser, http.Header, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := b.fileHTTP.Do(req)
	if err != nil {
		cancel()
		return nil, nil, errors.New("download failed")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		resp.Body.Close()
		cancel()
		return nil, nil, &httpStatusError{status: resp.StatusCode, message: fmt.Sprintf("download failed (%d)", resp.StatusCode)}
	}
	return &cancelReadCloser{ReadCloser: resp.Body, cancel: cancel}, resp.Header, nil
}

type cancelReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

// fileAccountRequest is only for our service, never capability URLs on a file
// backend. Reopen PUT files on retry, and release rejected GET bodies before
// returning a status error. Credential writes are protected from logout without
// holding sessionMu across a potentially long upload or download.
func (b *bridge) fileAccountRequest(send func(string) error) error {
	b.sessionMu.RLock()
	token, err := b.token()
	if err != nil {
		token, err = b.exchangeStoredDeviceCredential(token)
	}
	b.sessionMu.RUnlock()
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) || isHTTPStatus(err, http.StatusUnauthorized) {
			return errors.New("not authenticated")
		}
		return err
	}

	requestErr := send(token)
	if !isHTTPStatus(requestErr, http.StatusUnauthorized) {
		return requestErr
	}
	b.sessionMu.RLock()
	// A logout may have completed while the stream was in flight. Do not
	// revive its identity from a delayed 401 or a disk credential fallback.
	if _, err = b.token(); err == nil {
		token, err = b.exchangeStoredDeviceCredential(token)
	}
	b.sessionMu.RUnlock()
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) || isHTTPStatus(err, http.StatusUnauthorized) {
			return requestErr
		}
		return err
	}
	return send(token)
}

func (b *bridge) fileAPI(method, path string, body any) ([]byte, error) {
	var data []byte
	err := b.fileAccountRequest(func(token string) error {
		var requestErr error
		data, requestErr = b.api(method, b.serviceURL, path, token, body)
		return requestErr
	})
	return data, err
}

func (c *cancelReadCloser) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}

// saveDownload writes a complete stream to a new file and returns its path.
func (b *bridge) saveDownload(filename, fileID string, src io.Reader) (any, error) {
	return b.saveDownloadWithLimit(filename, fileID, src, 512<<20)
}

func (b *bridge) saveDownloadWithLimit(filename, fileID string, src io.Reader, limit int64) (any, error) {
	name := safeFilename(filename)
	if name == "" {
		name = "ourcord-" + pathSegment(fileID)
	}
	dir := b.downloadDir
	if dir == "" {
		dir = downloadsDir()
	}
	target := filepath.Join(dir, name)
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		ext := filepath.Ext(name)
		stem := strings.TrimSuffix(name, ext) + "-" + pathSegment(fileID)
		target = filepath.Join(dir, stem+ext)
		out, err = os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if errors.Is(err, os.ErrExist) {
			// CreateTemp also uses exclusive creation, so concurrent downloads
			// and existing symlinks can never redirect or overwrite this copy.
			out, err = os.CreateTemp(dir, stem+"-*"+ext)
			if err == nil {
				target = out.Name()
			}
		}
	}
	if err != nil {
		return nil, fmt.Errorf("save file: %w", err)
	}
	saved := false
	defer func() {
		_ = out.Close()
		if !saved {
			_ = os.Remove(target)
		}
	}()
	written, err := io.Copy(out, io.LimitReader(src, limit+1))
	if err != nil {
		return nil, fmt.Errorf("save file: %w", err)
	}
	if written > limit {
		return nil, fmt.Errorf("download exceeds size limit (%d bytes)", limit)
	}
	if err := out.Close(); err != nil {
		return nil, fmt.Errorf("save file: %w", err)
	}
	saved = true
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
func messagesPath(roomID, before string, limit int, beforeCreatedAt *int64) string {
	query := url.Values{}
	if before != "" {
		query.Set("before", before)
		if beforeCreatedAt != nil {
			query.Set("before_created_at", strconv.FormatInt(*beforeCreatedAt, 10))
		}
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
	data, _, err := b.apiWithAccount(method, base, path, body)
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

type httpStatusError struct {
	status  int
	message string
}

func (e *httpStatusError) Error() string { return e.message }

func isHTTPStatus(err error, status int) bool {
	var responseErr *httpStatusError
	return errors.As(err, &responseErr) && responseErr.status == status
}

func (b *bridge) apiWithAccount(method, base, path string, body any) ([]byte, string, error) {
	token, err := b.token()
	if err != nil {
		token, err = b.exchangeStoredDeviceCredential(token)
		if err != nil {
			if errors.Is(err, keyring.ErrNotFound) || isHTTPStatus(err, http.StatusUnauthorized) {
				return nil, "", errors.New("not authenticated")
			}
			return nil, "", err
		}
	}
	data, err := b.api(method, base, path, token, body)
	if !isHTTPStatus(err, http.StatusUnauthorized) {
		return data, token, err
	}
	token, refreshErr := b.exchangeStoredDeviceCredential(token)
	if refreshErr != nil {
		if errors.Is(refreshErr, keyring.ErrNotFound) || isHTTPStatus(refreshErr, http.StatusUnauthorized) {
			return nil, "", err
		}
		return nil, "", refreshErr
	}
	data, err = b.api(method, base, path, token, body)
	return data, token, err
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
		return nil, &httpStatusError{status: resp.StatusCode, message: failure.Error}
	}
	return data, nil
}

func (b *bridge) credentialStore() credentialStore {
	if b.credentials == nil {
		return newCredentialStore(b.clientStateDir())
	}
	return b.credentials
}

func (b *bridge) clientStateDir() string {
	if b.stateDir == "" {
		return wg.DefaultStateDir()
	}
	return b.stateDir
}

func (b *bridge) token() (string, error) {
	return b.credentialStore().Get(credentialService, jwtCredential)
}

func (b *bridge) authStatus() (any, error) {
	token, err := b.token()
	if err == nil {
		if profile, err := b.fetchProfile(token); err == nil {
			b.ensureDaemonEnrollment(token, profile)
			return map[string]any{"authenticated": true, "profile": profile}, nil
		} else if !isHTTPStatus(err, http.StatusUnauthorized) {
			return nil, err
		}
	}

	token, err = b.exchangeStoredDeviceCredential(token)
	if errors.Is(err, keyring.ErrNotFound) || isHTTPStatus(err, http.StatusUnauthorized) {
		token, err = b.exchangeDaemonSession()
	}
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) || isHTTPStatus(err, http.StatusUnauthorized) {
			return map[string]bool{"authenticated": false}, nil
		}
		return nil, err
	}
	profile, err := b.fetchProfile(token)
	if err != nil {
		return nil, err
	}
	b.ensureDaemonEnrollment(token, profile)
	return map[string]any{"authenticated": true, "profile": profile}, nil
}

func (b *bridge) exchangeDaemonSession() (string, error) {
	daemon, err := b.daemonClient()
	if err != nil {
		return "", keyring.ErrNotFound
	}
	profile, err := daemon.LocalProfile()
	b.dropDaemon(daemon, err)
	if err != nil {
		return "", err
	}
	// A running daemon without a device token is normal on first launch and
	// after logout. Do not turn that state into a failed auth.status request.
	if !profile.Enrolled {
		return "", keyring.ErrNotFound
	}
	session, err := daemon.RefreshSession()
	b.dropDaemon(daemon, err)
	if err != nil {
		return "", err
	}
	if err := b.credentialStore().Set(credentialService, jwtCredential, session.AccessToken); err != nil {
		return "", fmt.Errorf("store account credential: %w", err)
	}
	return session.AccessToken, nil
}

func (b *bridge) ensureDaemonEnrollment(token string, profile any) {
	root, ok := profile.(map[string]any)
	if !ok {
		return
	}
	user, ok := root["user"].(map[string]any)
	if !ok {
		return
	}
	userID, _ := user["id"].(string)
	if userID == "" {
		return
	}
	daemon, err := b.daemonClient()
	if err != nil {
		return
	}
	local, err := daemon.LocalProfile()
	if err == nil && !local.Enrolled {
		host, _ := os.Hostname()
		_, err = daemon.EnrollLocalDevice(token, userID, host)
	}
	b.dropDaemon(daemon, err)
}

func (b *bridge) fetchProfile(token string) (any, error) {
	data, err := b.api(http.MethodGet, b.controlURL, "/api/me", token, nil)
	if err != nil {
		return nil, err
	}
	var profile any
	if err := json.Unmarshal(data, &profile); err != nil {
		return nil, err
	}
	return profile, nil
}

func (b *bridge) exchangeStoredDeviceCredential(staleToken string) (string, error) {
	// Share failures as well as successful refreshes with overlapping callers.
	// Completed failures are not cached: a later request can retry immediately.
	value, err, _ := b.authRefresh.Do(staleToken, func() (any, error) {
		return b.refreshStoredDeviceCredential(staleToken)
	})
	if err != nil {
		return "", err
	}
	return value.(string), nil
}

func (b *bridge) refreshStoredDeviceCredential(staleToken string) (string, error) {
	b.authMu.Lock()
	defer b.authMu.Unlock()

	store := b.credentialStore()
	// A concurrent request may have refreshed this same rejected JWT while
	// we waited. Reuse its replacement instead of spending another device
	// exchange (and another D1 read/write) for the same expiration.
	if current, err := store.Get(credentialService, jwtCredential); err == nil && current != "" && current != staleToken {
		return current, nil
	}
	deviceToken, err := store.Get(credentialService, deviceCredential)
	if err != nil {
		data, readErr := os.ReadFile(filepath.Join(b.clientStateDir(), "device.token"))
		if readErr != nil {
			if errors.Is(readErr, os.ErrNotExist) {
				return "", keyring.ErrNotFound
			}
			return "", readErr
		}
		deviceToken = strings.TrimSpace(string(data))
	}
	if !strings.HasPrefix(deviceToken, "dt_") {
		return "", keyring.ErrNotFound
	}
	data, err := b.api(http.MethodPost, b.controlURL, "/api/auth/device", "", map[string]string{"device_token": deviceToken})
	if err != nil {
		return "", err
	}
	var exchanged struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(data, &exchanged); err != nil || exchanged.Token == "" {
		return "", errors.New("invalid device login response")
	}
	if err := store.Set(credentialService, deviceCredential, deviceToken); err != nil {
		return "", fmt.Errorf("store device credential: %w", err)
	}
	if err := store.Set(credentialService, jwtCredential, exchanged.Token); err != nil {
		return "", fmt.Errorf("store account credential: %w", err)
	}
	return exchanged.Token, nil
}

func (b *bridge) cacheDeviceCredentialFromDisk() error {
	data, err := os.ReadFile(filepath.Join(b.clientStateDir(), "device.token"))
	if err != nil {
		return err
	}
	deviceToken := strings.TrimSpace(string(data))
	if !strings.HasPrefix(deviceToken, "dt_") {
		return errors.New("invalid device credential")
	}
	return b.credentialStore().Set(credentialService, deviceCredential, deviceToken)
}

func decodeMagicResponse(data []byte) (map[string]any, error) {
	var sent struct {
		ExpiresIn  int `json:"expires_in"`
		RetryAfter int `json:"retry_after"`
	}
	if err := json.Unmarshal(data, &sent); err != nil || sent.ExpiresIn <= 0 || sent.RetryAfter <= 0 {
		return nil, errors.New("invalid login response")
	}
	return map[string]any{
		"sent":        true,
		"expires_in":  sent.ExpiresIn,
		"retry_after": sent.RetryAfter,
	}, nil
}

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
