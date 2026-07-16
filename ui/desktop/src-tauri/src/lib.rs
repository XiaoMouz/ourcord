use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

const ALLOWED_METHODS: &[&str] = &[
    "auth.begin", "auth.magic", "auth.exchange", "auth.status", "auth.logout",
    "profile.update", "lobbies.list", "lobbies.create", "lobbies.join",
    "lobbies.invite", "rooms.create", "daemon.snapshot", "network.connect",
    "network.disconnect", "network.enter", "network.leave", "voice.join",
    "voice.leave", "voice.mute", "voice.deafen", "voice.input_mode", "voice.ptt",
    "voice.devices", "voice.set_devices",
];

#[tauri::command]
async fn bridge_call(app: AppHandle, method: String, params: Value) -> Result<Value, String> {
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err("unsupported bridge method".into());
    }
    let request = json!({ "id": "tauri", "method": method, "params": params }).to_string();
    let output = app.shell().sidecar("ourcord-desktop-bridge")
        .map_err(|_| "desktop bridge is not installed".to_string())?
        .args(["--once", &request])
        .output().await
        .map_err(|_| "desktop bridge failed to start".to_string())?;
    if !output.status.success() { return Err("desktop bridge failed".into()); }
    let envelope: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "invalid desktop bridge response".to_string())?;
    if let Some(message) = envelope.get("error").and_then(Value::as_str) {
        if !message.is_empty() { return Err(message.to_string()); }
    }
    Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
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
        .invoke_handler(tauri::generate_handler![bridge_call])
        .run(tauri::generate_context!())
        .expect("error while running OurCord desktop");
}
