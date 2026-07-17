use std::collections::HashMap;
use std::sync::mpsc::{RecvTimeoutError, Sender};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const ALLOWED_METHODS: &[&str] = &[
    "auth.begin", "auth.magic", "auth.exchange", "auth.status", "auth.logout",
    "profile.update", "profiles.lookup", "lobbies.list", "lobbies.create",
    "lobbies.join", "lobbies.invite", "lobbies.members", "rooms.create",
    "rooms.update", "rooms.delete", "messages.list", "messages.send",
    "messages.delete", "files.list", "files.download",
    "daemon.snapshot", "daemon.profile", "diagnostics.ping",
    "diagnostics.force_derp", "devices.list", "devices.revoke", "network.connect",
    "network.disconnect", "network.enter", "network.leave", "voice.join",
    "voice.leave", "voice.mute", "voice.deafen", "voice.input_mode", "voice.ptt",
    "voice.devices", "voice.set_devices",
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
    let (events, child) = app
        .shell()
        .sidecar("ourcord-desktop-bridge")
        .map_err(|_| "desktop bridge is not installed".to_string())?
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
        return match outcome {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                state.lock().unwrap().pending.remove(&id);
                Err("desktop bridge timed out".into())
            }
            Err(RecvTimeoutError::Disconnected) => Err("desktop bridge exited".into()),
        };
    }
    Err("desktop bridge failed".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(BridgeState::default())
        .invoke_handler(tauri::generate_handler![bridge_call])
        .run(tauri::generate_context!())
        .expect("error while running OurCord desktop");
}
