use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri::Manager;

/// Manages rclone serve http processes, one per active stream session
pub struct ServeProcesses(pub Mutex<HashMap<String, Child>>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StreamSession {
    pub session_id: String,
    pub serve_url: String,
    pub file_url: String,
}

fn rclone_binary(app: &AppHandle) -> PathBuf {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let s = resource_dir.join("rclone");
    if s.exists() { s } else { PathBuf::from("rclone") }
}

/// Start rclone serve http for a remote path and return a stream URL.
/// Uses portpicker to find a free port, spawns rclone serve http in the background.
#[tauri::command]
pub async fn start_stream_session(
    app: AppHandle,
    processes: State<'_, ServeProcesses>,
    config_path: String,
    remote_root: String,   // e.g. "gdrive:/Movies"
    file_path: String,     // relative path within the remote root
    session_id: String,
) -> Result<StreamSession, String> {
    let port = portpicker::pick_unused_port()
        .ok_or("No available port found")?;

    let rclone = rclone_binary(&app);

    // Kill any existing session with same id
    {
        let mut procs = processes.0.lock().unwrap();
        if let Some(mut child) = procs.remove(&session_id) {
            let _ = child.kill();
        }
    }

    let child = Command::new(&rclone)
        .args([
            "serve", "http",
            "--config", &config_path,
            "--addr", &format!("127.0.0.1:{}", port),
            "--read-only",
            "--no-checksum",
            &remote_root,
        ])
        .spawn()
        .map_err(|e| format!("Failed to start rclone serve: {}", e))?;

    {
        let mut procs = processes.0.lock().unwrap();
        procs.insert(session_id.clone(), child);
    }

    // Small delay to let rclone start up
    tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;

    let serve_url = format!("http://127.0.0.1:{}", port);
    let encoded = file_path
        .split('/')
        .map(|seg| urlencoding_simple(seg))
        .collect::<Vec<_>>()
        .join("/");
    let file_url = format!("{}/{}", serve_url, encoded.trim_start_matches('/'));

    let _ = app.emit("stream-ready", serde_json::json!({
        "sessionId": session_id,
        "fileUrl": file_url,
    }));

    Ok(StreamSession { session_id, serve_url, file_url })
}

/// Stop a stream session and kill the rclone process
#[tauri::command]
pub async fn stop_stream_session(
    processes: State<'_, ServeProcesses>,
    session_id: String,
) -> Result<(), String> {
    let mut procs = processes.0.lock().unwrap();
    if let Some(mut child) = procs.remove(&session_id) {
        child.kill().map_err(|e| format!("Failed to kill process: {}", e))?;
    }
    Ok(())
}

/// Stop all stream sessions (called on app exit)
#[tauri::command]
pub async fn stop_all_sessions(
    processes: State<'_, ServeProcesses>,
) -> Result<(), String> {
    let mut procs = processes.0.lock().unwrap();
    for (_, mut child) in procs.drain() {
        let _ = child.kill();
    }
    Ok(())
}

/// Get subtitle tracks available for a file via ffprobe (if installed)
#[derive(Debug, Serialize, Deserialize)]
pub struct SubtitleTrack {
    pub index: u32,
    pub language: Option<String>,
    pub title: Option<String>,
}

#[tauri::command]
pub async fn get_media_info(file_url: String) -> Result<serde_json::Value, String> {
    // Try ffprobe to get duration, subtitle tracks, audio tracks
    let output = Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            &file_url,
        ])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            serde_json::from_str(&stdout)
                .map_err(|e| format!("Failed to parse ffprobe output: {}", e))
        }
        _ => {
            // ffprobe not available — return minimal info
            Ok(serde_json::json!({ "streams": [] }))
        }
    }
}

// Simple URL encoding without external crate
fn urlencoding_simple(s: &str) -> String {
    let mut out = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}
