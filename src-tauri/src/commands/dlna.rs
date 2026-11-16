use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, State};
use crate::process_ext::tokio_command;
use crate::commands::player::rclone_binary;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DlnaStatus {
    pub running: bool,
    pub remote: String,
    pub path: String,
    pub port: u16,
    pub friendly_name: String,
    pub error: Option<String>,
}

impl Default for DlnaStatus {
    fn default() -> Self {
        Self {
            running: false,
            remote: "".to_string(),
            path: "".to_string(),
            port: 8200,
            friendly_name: "RcloneFlix (Xbox & TV)".to_string(),
            error: None,
        }
    }
}

pub struct DlnaManager {
    inner: Arc<Mutex<DlnaState>>,
}

struct DlnaState {
    status: DlnaStatus,
    child: Option<tokio::process::Child>,
}

impl DlnaManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(DlnaState {
                status: DlnaStatus::default(),
                child: None,
            })),
        }
    }

    pub fn stop(&self) {
        let inner = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            let mut state = inner.lock().await;
            if let Some(mut child) = state.child.take() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            state.status.running = false;
        });
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TailscaleStatusResult {
    pub installed: bool,
    pub running: bool,
    pub backend_state: String,
    pub auth_url: Option<String>,
    pub dns_name: Option<String>,
    pub ip: Option<String>,
}

#[tauri::command]
pub async fn get_tailscale_status() -> Result<TailscaleStatusResult, String> {
    let output = match tokio_command("tailscale")
        .args(["status", "--json"])
        .output()
        .await
    {
        Ok(out) => out,
        Err(_) => {
            return Ok(TailscaleStatusResult {
                installed: false,
                running: false,
                backend_state: "NotInstalled".to_string(),
                auth_url: None,
                dns_name: None,
                ip: None,
            });
        }
    };

    let text = String::from_utf8_lossy(&output.stdout);
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
        let backend = val.get("BackendState").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string();
        let running = backend == "Running";
        let auth_url = val.get("AuthURL").and_then(|v| v.as_str()).map(|s| s.to_string());
        let dns = val.get("Self")
            .and_then(|s| s.get("DNSName"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim_end_matches('.').to_string());
        let ip = val.get("TailscaleIPs")
            .and_then(|arr| arr.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        Ok(TailscaleStatusResult {
            installed: true,
            running,
            backend_state: backend,
            auth_url,
            dns_name: dns,
            ip,
        })
    } else {
        Ok(TailscaleStatusResult {
            installed: true,
            running: false,
            backend_state: "ErrorParsing".to_string(),
            auth_url: None,
            dns_name: None,
            ip: None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TailscaleRoute {
    pub port: u16,
    pub target: String,
    pub is_funnel: bool,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TailscaleRoutesResult {
    pub routes: Vec<TailscaleRoute>,
    pub dns_name: Option<String>,
}

#[tauri::command]
pub async fn get_tailscale_routes() -> Result<TailscaleRoutesResult, String> {
    let output = match tokio_command("tailscale")
        .args(["serve", "status", "--json"])
        .output()
        .await
    {
        Ok(out) => out,
        Err(e) => return Err(format!("Tailscale command failed: {}", e)),
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut routes = Vec::new();
    let mut dns_name = None;

    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(web) = val.get("Web").and_then(|w| w.as_object()) {
            for (host_port, host_val) in web {
                if dns_name.is_none() {
                    let parts: Vec<&str> = host_port.split(':').collect();
                    dns_name = Some(parts[0].to_string());
                }
                let port = host_port.split(':').nth(1).and_then(|p| p.parse::<u16>().ok()).unwrap_or(443);
                let proxy_target = host_val
                    .get("Handlers")
                    .and_then(|h| h.get("/"))
                    .and_then(|p| p.get("Proxy"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let is_funnel = val
                    .get("AllowFunnel")
                    .and_then(|af| af.as_object())
                    .map(|map| map.contains_key(host_port))
                    .unwrap_or(false);

                let full_url = format!("https://{}", host_port);

                routes.push(TailscaleRoute {
                    port,
                    target: proxy_target,
                    is_funnel,
                    url: full_url,
                });
            }
        }
    }

    Ok(TailscaleRoutesResult { routes, dns_name })
}

#[tauri::command]
pub async fn set_tailscale_serve(
    listen_port: u16,
    target_port: u16,
) -> Result<String, String> {
    let target = format!("http://127.0.0.1:{}", target_port);
    let out = tokio_command("tailscale")
        .args(["serve", "--bg", "--yes", &format!("--https={}", listen_port), &target])
        .output()
        .await
        .map_err(|e| format!("Failed to run tailscale serve: {}", e))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("tailscale serve error: {}", err));
    }

    let status = get_tailscale_status().await?;
    let domain = status.dns_name.unwrap_or_else(|| "tailnet".to_string());
    Ok(format!("https://{}:{}", domain, listen_port))
}

#[tauri::command]
pub async fn set_tailscale_funnel(
    listen_port: u16,
    target_port: u16,
) -> Result<String, String> {
    let target = format!("http://127.0.0.1:{}", target_port);
    let out = tokio_command("tailscale")
        .args(["funnel", "--bg", "--yes", &format!("--https={}", listen_port), &target])
        .output()
        .await
        .map_err(|e| format!("Failed to run tailscale funnel: {}", e))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("tailscale funnel error: {}", err));
    }

    let status = get_tailscale_status().await?;
    let domain = status.dns_name.unwrap_or_else(|| "tailnet".to_string());
    Ok(format!("https://{}:{}", domain, listen_port))
}

#[tauri::command]
pub async fn reset_tailscale_routes() -> Result<(), String> {
    let _ = tokio_command("tailscale").args(["serve", "reset"]).output().await;
    let _ = tokio_command("tailscale").args(["funnel", "reset"]).output().await;
    Ok(())
}

#[tauri::command]
pub async fn start_dlna_server(
    app: AppHandle,
    manager: State<'_, DlnaManager>,
    config_path: String,
    remote: String,
    path: String,
    port: Option<u16>,
    friendly_name: Option<String>,
) -> Result<DlnaStatus, String> {
    let mut state = manager.inner.lock().await;

    // Stop existing if running
    if let Some(mut child) = state.child.take() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }

    let listen_port = port.unwrap_or(8200);
    let name = friendly_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "RcloneFlix (Xbox & TV)".to_string());

    let rclone_bin = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone_bin);

    let clean_remote = remote.trim_end_matches(':');
    let target = if clean_remote.is_empty() {
        if path.is_empty() {
            return Err("Target path cannot be empty".to_string());
        }
        path.clone()
    } else {
        let clean_path = path.trim_start_matches('/');
        if clean_path.is_empty() {
            format!("{}:", clean_remote)
        } else {
            format!("{}:{}", clean_remote, clean_path)
        }
    };

    let rclone_settings = crate::commands::store::get_rclone_settings_sync(&app);
    let tps_limit_str = rclone_settings.clean_tps_limit().to_string();
    let tps_burst_str = rclone_settings.clean_tps_limit_burst().to_string();

    cmd.args([
        "serve",
        "dlna",
        &target,
        "--addr",
        &format!("0.0.0.0:{}", listen_port),
        "--name",
        &name,
        "--dir-cache-time",
        rclone_settings.clean_dir_cache_time(),
        "--vfs-read-chunk-size",
        rclone_settings.clean_vfs_read_chunk_size(),
        "--vfs-read-chunk-size-limit",
        rclone_settings.clean_vfs_read_chunk_size_limit(),
        "--vfs-cache-mode",
        rclone_settings.clean_vfs_cache_mode(),
        "--tpslimit",
        &tps_limit_str,
        "--tpslimit-burst",
        &tps_burst_str,
    ]);

    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }

    match cmd.spawn() {
        Ok(child) => {
            state.child = Some(child);
            state.status = DlnaStatus {
                running: true,
                remote: clean_remote.to_string(),
                path: path.clone(),
                port: listen_port,
                friendly_name: name,
                error: None,
            };
            Ok(state.status.clone())
        }
        Err(e) => {
            state.status.running = false;
            state.status.error = Some(e.to_string());
            Err(format!("Failed to start DLNA server: {}", e))
        }
    }
}

#[tauri::command]
pub async fn stop_dlna_server(
    manager: State<'_, DlnaManager>,
) -> Result<DlnaStatus, String> {
    let mut state = manager.inner.lock().await;
    if let Some(mut child) = state.child.take() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    state.status.running = false;
    state.status.error = None;
    Ok(state.status.clone())
}

#[tauri::command]
pub async fn get_dlna_status(
    manager: State<'_, DlnaManager>,
) -> Result<DlnaStatus, String> {
    let mut state = manager.inner.lock().await;
    if let Some(ref mut child) = state.child {
        match child.try_wait() {
            Ok(Some(exit_status)) => {
                state.status.running = false;
                state.status.error = Some(format!("Exited with code {:?}", exit_status.code()));
                state.child = None;
            }
            Ok(None) => {
                state.status.running = true;
            }
            Err(e) => {
                state.status.running = false;
                state.status.error = Some(e.to_string());
                state.child = None;
            }
        }
    } else {
        state.status.running = false;
    }
    Ok(state.status.clone())
}
