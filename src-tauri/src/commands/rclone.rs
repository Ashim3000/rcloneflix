use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use tauri::AppHandle;
use tauri::Manager;
use crate::commands::player::{parse_remote_root, percent_encode_path, wait_for_port};

// Global storage for the rclone serve child process (so it doesn't get dropped)
use std::sync::Mutex;
static SERVE_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

/// Represents a single rclone remote parsed from the config file
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RcloneRemote {
    pub name: String,
    pub remote_type: String,
}

/// Represents a file/directory listed by rclone
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RcloneListItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: i64,
    pub mime_type: Option<String>,
}

/// Find the bundled rclone binary path.
/// In development we look on PATH; in production it's bundled as a sidecar.
fn rclone_binary(app: &AppHandle) -> PathBuf {
    // Try to find sidecar first
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let sidecar = if cfg!(target_os = "windows") {
        resource_dir.join("rclone.exe")
    } else {
        resource_dir.join("rclone")
    };

    if sidecar.exists() {
        return sidecar;
    }

    // Fall back to PATH (useful in dev)
    PathBuf::from("rclone")
}

/// Parse an rclone config file and return the list of remotes.
/// The rclone config format is an INI-style file where section names are remote names
/// and the `type` key gives the remote type.
#[tauri::command]
pub fn parse_rclone_config(
    config_path: String,
) -> Result<Vec<RcloneRemote>, String> {
    let path = Path::new(&config_path);
    if !path.exists() {
        return Err(format!("Config file not found: {}", config_path));
    }

    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let mut remotes = Vec::new();
    let mut current_section: Option<String> = None;
    let mut current_type: Option<String> = None;

    for line in content.lines() {
        let line = line.trim();

        if line.starts_with('[') && line.ends_with(']') {
            // Save previous section if it had a type
            if let (Some(name), Some(rtype)) = (current_section.take(), current_type.take()) {
                remotes.push(RcloneRemote {
                    name,
                    remote_type: rtype,
                });
            }
            current_section = Some(line[1..line.len() - 1].to_string());
            current_type = None;
        } else if line.starts_with("type") {
            if let Some(value) = line.splitn(2, '=').nth(1) {
                current_type = Some(value.trim().to_string());
            }
        }
    }

    // Don't forget the last section
    if let (Some(name), Some(rtype)) = (current_section, current_type) {
        remotes.push(RcloneRemote {
            name,
            remote_type: rtype,
        });
    }

    if remotes.is_empty() {
        return Err("No remotes found in the config file. Is this a valid rclone config?".to_string());
    }

    Ok(remotes)
}

/// List the contents of a remote path using rclone lsjson
#[tauri::command]
pub async fn list_remote_path(
    app: AppHandle,
    config_path: String,
    remote_path: String,
) -> Result<Vec<RcloneListItem>, String> {
    let rclone = rclone_binary(&app);

    let output = Command::new(&rclone)
        .args([
            "lsjson",
            "--config",
            &config_path,
            "--no-modtime",
            &remote_path,
        ])
        .output()
        .map_err(|e| format!("Failed to run rclone: {}. Is rclone installed?", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rclone error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    #[derive(Deserialize)]
    struct RcloneJsonItem {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "Path")]
        path: String,
        #[serde(rename = "IsDir")]
        is_dir: bool,
        #[serde(rename = "Size")]
        size: i64,
        #[serde(rename = "MimeType")]
        mime_type: Option<String>,
    }

    let items: Vec<RcloneJsonItem> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse rclone output: {}", e))?;

    let result = items
        .into_iter()
        .map(|i| RcloneListItem {
            name: i.name,
            path: i.path,
            is_dir: i.is_dir,
            size: i.size,
            mime_type: i.mime_type,
        })
        .collect();

    Ok(result)
}

/// Get rclone version string (also validates rclone is available)
#[tauri::command]
pub async fn get_rclone_version(app: AppHandle) -> Result<String, String> {
    let rclone = rclone_binary(&app);

    let output = Command::new(&rclone)
        .arg("version")
        .output()
        .map_err(|e| format!("rclone not found: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout.lines().next().unwrap_or("rclone unknown").to_string();
    Ok(first_line)
}

/// Start rclone serve http for a remote path and return the local URL.
/// This is used for streaming video/audio via libVLC.
/// Spins up a dedicated rclone serve http process and returns the local URL.
#[tauri::command]
pub async fn get_stream_url(
    app: AppHandle,
    config_path: String,
    remote_path: String,
) -> Result<String, String> {
    let rclone = rclone_binary(&app);
    
    // Pick an available port with retry logic
    let mut last_error = None;
    for _ in 0..3 {
        let port = portpicker::pick_unused_port().ok_or("No available port")?;
        
        // Parse remote path to get root and sub-path
        let (remote_name, sub_path) = parse_remote_root(&remote_path);
        let remote_root = format!("{}:{}", remote_name, 
            if sub_path.starts_with('/') { &sub_path[1..] } else { &sub_path });
        
        let _ = app.emit(
            "rclone:status",
            serde_json::json!({ "state": "starting", "message": "Starting stream server…" }),
        );

        let mut child = Command::new(&rclone)
            .args([
                "serve", "http",
                "--config", &config_path,
                "--addr", &format!("127.0.0.1:{}", port),
                "--read-only",
                "--no-checksum",
                "--allow-origin", "*",
                &remote_root,
            ])
            .spawn()
            .map_err(|e| format!("Failed to start rclone serve: {}", e))?;

        // Wait for server to be ready
        match wait_for_port(port).await {
            Ok(()) => {
                // Store child process in global so it doesn't get killed when dropped
                if let Ok(mut guard) = SERVE_PROCESS.lock() {
                    // Kill any previous process
                    if let Some(mut old) = guard.take() {
                        let _ = old.kill();
                    }
                    *guard = Some(child);
                }
                
                let _ = app.emit(
                    "rclone:status",
                    serde_json::json!({ "state": "ready", "message": "Stream ready" }),
                );
                
                // Build URL - the file path within the served root
                let file_name = remote_path.rsplit('/').next().unwrap_or(&remote_path);
                let encoded = percent_encode_path(file_name);
                return Ok(format!("http://127.0.0.1:{}/{}", port, encoded));
            }
            Err(e) => {
                let _ = child.kill();
                last_error = Some(e);
                // Try again with a different port
                continue;
            }
        }
    }
    
    Err(last_error.unwrap_or_else(|| "Failed to start stream server".to_string()))
}
