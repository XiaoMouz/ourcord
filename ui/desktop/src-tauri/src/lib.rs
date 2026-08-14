use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::fs::{self, File, OpenOptions};
#[cfg(target_os = "macos")]
use std::io::{Read, Write};
#[cfg(target_os = "macos")]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::mpsc::{RecvTimeoutError, Sender};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const ALLOWED_METHODS: &[&str] = &[
    "auth.begin",
    "auth.magic",
    "auth.exchange",
    "auth.status",
    "auth.logout",
    "profile.update",
    "profiles.lookup",
    "lobbies.list",
    "lobbies.create",
    "lobbies.join",
    "lobbies.invite",
    "lobbies.members",
    "presence.update",
    "presence.leave",
    "rooms.create",
    "rooms.update",
    "rooms.delete",
    "messages.list",
    "messages.send",
    "messages.delete",
    "files.list",
    "files.download",
    "files.upload",
    "daemon.snapshot",
    "daemon.profile",
    "diagnostics.ping",
    "diagnostics.force_derp",
    "devices.list",
    "devices.revoke",
    "network.connect",
    "network.disconnect",
    "network.enter",
    "network.leave",
    "voice.join",
    "voice.join_network",
    "voice.leave",
    "voice.mute",
    "voice.deafen",
    "voice.input_mode",
    "voice.ptt",
    "voice.devices",
    "voice.set_devices",
];

// The Go bridge answers every request (even internal panics), so a response
// always arrives unless the process dies — Terminated fails all waiters. The
// timeout is a last-resort guard against a wedged daemon RPC.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

type Waiter = Sender<Result<Value, String>>;

#[derive(Default)]
struct BridgeInner {
    child: Option<CommandChild>,
    generation: u64,
    next_id: u64,
    pending: HashMap<u64, Waiter>,
}

/// Long-lived sidecar handle. One `ourcord-desktop-bridge` process serves all
/// bridge calls over line-delimited JSON instead of a process spawn per call,
/// which also keeps auth codes out of process command lines.
#[derive(Default)]
struct BridgeState(Arc<Mutex<BridgeInner>>);

#[cfg(target_os = "macos")]
const MACOS_DAEMON_LABEL: &str = "app.ourcord.daemon";
#[cfg(target_os = "macos")]
const MACOS_DAEMON_PATH: &str = "/Library/PrivilegedHelperTools/OurCord/MacOS/ourcordd";
#[cfg(target_os = "macos")]
const MACOS_PLIST_PATH: &str = "/Library/LaunchDaemons/app.ourcord.daemon.plist";

#[cfg(target_os = "macos")]
fn current_uid() -> Result<u32, String> {
    let output = Command::new("/usr/bin/id")
        .arg("-u")
        .output()
        .map_err(|error| format!("read user id: {error}"))?;
    if !output.status.success() {
        return Err("read user id failed".into());
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|_| "invalid user id".into())
}

#[cfg(target_os = "macos")]
fn daemon_socket_path(uid: u32) -> String {
    format!("/var/run/ourcordd-{uid}.sock")
}

#[cfg(target_os = "macos")]
fn user_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "user home is unavailable".into())
}

#[cfg(target_os = "macos")]
fn ensure_ipc_key(home: &Path) -> Result<PathBuf, String> {
    let directory = home.join(".config/ourcord");
    let path = directory.join("ipc.key");
    fs::create_dir_all(&directory).map_err(|error| format!("create IPC key directory: {error}"))?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("secure IPC key directory: {error}"))?;
    if let Ok(value) = fs::read_to_string(&path) {
        let value = value.trim();
        if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(path);
        }
        return Err("existing IPC key is invalid".into());
    }

    let mut random = [0_u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut random))
        .map_err(|error| format!("generate IPC key: {error}"))?;
    let encoded = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let value = fs::read_to_string(&path)
                .map_err(|read_error| format!("read IPC key after create race: {read_error}"))?;
            let value = value.trim();
            if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Ok(path);
            }
            return Err("existing IPC key is invalid".into());
        }
        Err(error) => return Err(format!("create IPC key: {error}")),
    };
    if let Err(error) = file.write_all(format!("{encoded}\n").as_bytes()) {
        let _ = fs::remove_file(&path);
        return Err(format!("write IPC key: {error}"));
    }
    Ok(path)
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn launchd_plist(uid: u32, ipc_key: &Path) -> String {
    let state_dir = format!("/Library/Application Support/OurCord/users/{uid}");
    let log_file = format!("/Library/Logs/OurCord/ourcordd-{uid}.log");
    let arguments = [
        MACOS_DAEMON_PATH.to_string(),
        "--control-url".into(),
        "https://control.ourcord.mou.best".into(),
        "--socket".into(),
        daemon_socket_path(uid),
        "--ipc-key".into(),
        ipc_key.to_string_lossy().into_owned(),
        "--ipc-uid".into(),
        uid.to_string(),
        "--state-dir".into(),
        state_dir,
        "--log-file".into(),
        log_file,
    ]
    .iter()
    .map(|argument| format!("    <string>{}</string>", xml_escape(argument)))
    .collect::<Vec<_>>()
    .join("\n");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{MACOS_DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{arguments}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>/Library/Logs/OurCord/launchd.log</string>
  <key>StandardErrorPath</key><string>/Library/Logs/OurCord/launchd.err.log</string>
</dict>
</plist>
"#
    )
}

#[cfg(target_os = "macos")]
fn files_equal(left: &Path, right: &Path) -> bool {
    let Ok(left_metadata) = fs::metadata(left) else {
        return false;
    };
    let Ok(right_metadata) = fs::metadata(right) else {
        return false;
    };
    left_metadata.len() == right_metadata.len()
        && fs::read(left)
            .ok()
            .zip(fs::read(right).ok())
            .is_some_and(|(left, right)| left == right)
}

#[cfg(target_os = "macos")]
fn ensure_privileged_daemon() -> Result<(), String> {
    let uid = current_uid()?;
    let home = user_home()?;
    let ipc_key = ensure_ipc_key(&home)?;
    let bundled = std::env::current_exe()
        .map_err(|error| format!("locate application: {error}"))?
        .parent()
        .map(|directory| directory.join("ourcordd"))
        .ok_or_else(|| "locate bundled daemon failed".to_string())?;
    if !bundled.is_file() {
        return Err("bundled daemon is missing".into());
    }
    let frameworks = bundled
        .parent()
        .and_then(Path::parent)
        .map(|contents| contents.join("Frameworks"))
        .ok_or_else(|| "locate bundled audio libraries failed".to_string())?;
    let audio_libraries = ["libopus.0.dylib", "libopusfile.0.dylib", "libogg.0.dylib"]
        .map(|name| frameworks.join(name));
    if audio_libraries.iter().any(|library| !library.is_file()) {
        return Err("bundled audio libraries are missing".into());
    }

    let plist = launchd_plist(uid, &ipc_key);
    let installed_plist_matches =
        fs::read_to_string(MACOS_PLIST_PATH).ok().as_deref() == Some(&plist);
    let service_loaded = Command::new("/bin/launchctl")
        .args(["print", &format!("system/{MACOS_DAEMON_LABEL}")])
        .status()
        .is_ok_and(|status| status.success());
    let installed_audio_matches = audio_libraries.iter().all(|library| {
        let Some(name) = library.file_name() else {
            return false;
        };
        files_equal(
            library,
            &Path::new("/Library/PrivilegedHelperTools/OurCord/Frameworks").join(name),
        )
    });
    if files_equal(&bundled, Path::new(MACOS_DAEMON_PATH))
        && installed_audio_matches
        && installed_plist_matches
        && service_loaded
    {
        return Ok(());
    }

    let plist_source = std::env::temp_dir().join(format!(
        "ourcord-launchd-{uid}-{}.plist",
        std::process::id()
    ));
    fs::write(&plist_source, &plist)
        .map_err(|error| format!("prepare launchd service: {error}"))?;
    let script = r#"on run argv
set sourceBinary to item 1 of argv
set sourcePlist to item 2 of argv
set uidText to item 3 of argv
set sourceOpus to item 4 of argv
set sourceOpusFile to item 5 of argv
set sourceOgg to item 6 of argv
set stateDirectory to "/Library/Application Support/OurCord/users/" & uidText
set commandText to "/usr/bin/pkill -u " & uidText & " -x ourcordd >/dev/null 2>&1 || true; " & ¬
  "/bin/launchctl bootout system/app.ourcord.daemon >/dev/null 2>&1 || true; " & ¬
  "/bin/rm -f /Library/PrivilegedHelperTools/app.ourcord.daemon; " & ¬
  "/usr/bin/install -d -o root -g wheel -m 0755 /Library/PrivilegedHelperTools/OurCord/MacOS /Library/PrivilegedHelperTools/OurCord/Frameworks /Library/LaunchDaemons '/Library/Application Support/OurCord' '/Library/Application Support/OurCord/users' /Library/Logs/OurCord; " & ¬
  "/usr/bin/install -d -o root -g wheel -m 0700 " & quoted form of stateDirectory & "; " & ¬
  "/usr/bin/install -o root -g wheel -m 0755 " & quoted form of sourceBinary & " /Library/PrivilegedHelperTools/OurCord/MacOS/ourcordd; " & ¬
  "/usr/bin/install -o root -g wheel -m 0644 " & quoted form of sourceOpus & " /Library/PrivilegedHelperTools/OurCord/Frameworks/libopus.0.dylib; " & ¬
  "/usr/bin/install -o root -g wheel -m 0644 " & quoted form of sourceOpusFile & " /Library/PrivilegedHelperTools/OurCord/Frameworks/libopusfile.0.dylib; " & ¬
  "/usr/bin/install -o root -g wheel -m 0644 " & quoted form of sourceOgg & " /Library/PrivilegedHelperTools/OurCord/Frameworks/libogg.0.dylib; " & ¬
  "/usr/bin/install -o root -g wheel -m 0644 " & quoted form of sourcePlist & " /Library/LaunchDaemons/app.ourcord.daemon.plist; " & ¬
  "/bin/launchctl bootstrap system /Library/LaunchDaemons/app.ourcord.daemon.plist; " & ¬
  "/bin/launchctl kickstart -k system/app.ourcord.daemon"
do shell script commandText with administrator privileges
end run"#;
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .arg(&bundled)
        .arg(&plist_source)
        .arg(uid.to_string())
        .args(&audio_libraries)
        .output()
        .map_err(|error| format!("install privileged daemon: {error}"));
    let _ = fs::remove_file(&plist_source);
    let output = output?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "administrator authorization was cancelled".into()
        } else {
            format!("install privileged daemon: {message}")
        });
    }
    Ok(())
}

fn fail_pending(inner: &mut BridgeInner, reason: &str) {
    for (_, waiter) in inner.pending.drain() {
        let _ = waiter.send(Err(reason.to_string()));
    }
}

fn ensure_child(app: &AppHandle, state: &Arc<Mutex<BridgeInner>>) -> Result<(), String> {
    let mut inner = state.lock().unwrap();
    if inner.child.is_some() {
        return Ok(());
    }
    let command = app
        .shell()
        .sidecar("ourcord-desktop-bridge")
        .map_err(|_| "desktop bridge is not installed".to_string())?;
    #[cfg(target_os = "macos")]
    let command = command.env("OURCORD_DAEMON_SOCKET", daemon_socket_path(current_uid()?));
    let (events, child) = command
        .spawn()
        .map_err(|_| "desktop bridge failed to start".to_string())?;
    inner.generation += 1;
    let generation = inner.generation;
    inner.child = Some(child);
    drop(inner);
    let state = Arc::clone(state);
    tauri::async_runtime::spawn(read_events(state, generation, events));
    Ok(())
}

async fn read_events(
    state: Arc<Mutex<BridgeInner>>,
    generation: u64,
    mut events: tauri::async_runtime::Receiver<CommandEvent>,
) {
    // Stdout arrives line-split by default; the buffer only matters if a
    // response ever straddles events.
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                buffer.extend_from_slice(&bytes);
                if let Ok(envelope) = serde_json::from_slice::<Value>(&buffer) {
                    buffer.clear();
                    dispatch_envelope(&state, envelope);
                } else if buffer.len() > (4 << 20) {
                    buffer.clear();
                }
            }
            CommandEvent::Error(_) | CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }
    let mut inner = state.lock().unwrap();
    if inner.generation == generation {
        if let Some(child) = inner.child.take() {
            let _ = child.kill();
        }
        fail_pending(&mut inner, "desktop bridge exited");
    }
}

fn dispatch_envelope(state: &Arc<Mutex<BridgeInner>>, envelope: Value) {
    let Some(id) = envelope
        .get("id")
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse::<u64>().ok())
    else {
        return;
    };
    let Some(waiter) = state.lock().unwrap().pending.remove(&id) else {
        return;
    };
    let outcome = match envelope.get("error").and_then(Value::as_str) {
        Some(message) if !message.is_empty() => Err(message.to_string()),
        _ => Ok(envelope.get("result").cloned().unwrap_or(Value::Null)),
    };
    let _ = waiter.send(outcome);
}

#[tauri::command]
async fn bridge_call(
    app: AppHandle,
    state: tauri::State<'_, BridgeState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err("unsupported bridge method".into());
    }
    let state = Arc::clone(&state.0);
    // Retry once only when the write itself fails (request never reached the
    // bridge); an in-flight request is never re-sent.
    for attempt in 0..2 {
        ensure_child(&app, &state)?;
        let (tx, rx) = mpsc::channel();
        let (id, line) = {
            let mut inner = state.lock().unwrap();
            inner.next_id += 1;
            let id = inner.next_id;
            inner.pending.insert(id, tx);
            let mut line =
                json!({ "id": id.to_string(), "method": &method, "params": &params }).to_string();
            line.push('\n');
            (id, line)
        };
        let wrote = {
            let mut inner = state.lock().unwrap();
            match inner.child.as_mut() {
                Some(child) => child.write(line.as_bytes()).is_ok(),
                None => false,
            }
        };
        if !wrote {
            let mut inner = state.lock().unwrap();
            inner.pending.remove(&id);
            if let Some(child) = inner.child.take() {
                let _ = child.kill();
            }
            drop(inner);
            if attempt == 0 {
                continue;
            }
            return Err("desktop bridge failed".into());
        }
        let received =
            tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(CALL_TIMEOUT)).await;
        let outcome = match received {
            Ok(result) => result,
            Err(_) => Err(RecvTimeoutError::Disconnected),
        };
        let result = match outcome {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                state.lock().unwrap().pending.remove(&id);
                Err("desktop bridge timed out".into())
            }
            Err(RecvTimeoutError::Disconnected) => Err("desktop bridge exited".into()),
        };
        return result;
    }
    Err("desktop bridge failed".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init());
    // Release builds receive the signed updater configuration from CI. Dev
    // builds intentionally skip the plugin so local UI work needs no key.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .manage(BridgeState::default())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            {
                if let Err(error) = ensure_privileged_daemon() {
                    eprintln!("{error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bridge_call])
        .run(tauri::generate_context!())
        .expect("error while running OurCord desktop");
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn launchd_plist_scopes_root_daemon_to_installing_user() {
        let plist = launchd_plist(501, Path::new("/Users/test/.config/ourcord/ipc.key"));
        for expected in [
            MACOS_DAEMON_PATH,
            "/var/run/ourcordd-501.sock",
            "--ipc-uid",
            "<string>501</string>",
            "/Library/Application Support/OurCord/users/501",
            "/Users/test/.config/ourcord/ipc.key",
        ] {
            assert!(plist.contains(expected), "missing {expected}");
        }
    }

    #[test]
    fn launchd_plist_escapes_user_paths() {
        let plist = launchd_plist(501, Path::new("/Users/a&b/.config/ipc.key"));
        assert!(plist.contains("/Users/a&amp;b/.config/ipc.key"));
        assert!(!plist.contains("/Users/a&b/.config/ipc.key"));
    }
}
