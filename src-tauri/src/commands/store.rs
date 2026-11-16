use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_PATH: &str = "rcloneflix-keys.json";

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ApiKeys {
    pub tmdb: String,
    pub theporndb: String,
}

/// Save the rclone config body so it can be included in a Drive backup.
/// Kept out of localStorage — it contains the remotes' OAuth tokens.
#[tauri::command]
pub async fn save_rclone_config_content(app: AppHandle, content: String) -> Result<(), String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("Failed to open store: {}", e))?;
    store.set("rclone_config_content", serde_json::json!(content.clone()));
    store
        .save()
        .map_err(|e| format!("Failed to save store: {}", e))?;

    if !content.trim().is_empty() {
        if let Some(cfg_path) = crate::commands::rclone_sync::resolve_config_arg("") {
            let _ = std::fs::write(&cfg_path, &content);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn load_rclone_config_content(app: AppHandle) -> Result<String, String> {
    if let Some(cfg_path) = crate::commands::rclone_sync::resolve_config_arg("") {
        if let Ok(disk_content) = std::fs::read_to_string(&cfg_path) {
            if !disk_content.trim().is_empty() {
                return Ok(disk_content);
            }
        }
    }
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("Failed to open store: {}", e))?;
    Ok(store
        .get("rclone_config_content")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default())
}

/// Save API keys to the Tauri store
#[tauri::command]
pub async fn save_api_keys(app: AppHandle, keys: ApiKeys) -> Result<(), String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("Failed to open store: {}", e))?;

    store.set("tmdb_key", serde_json::json!(keys.tmdb));
    store.set("theporndb_key", serde_json::json!(keys.theporndb));

    store
        .save()
        .map_err(|e| format!("Failed to save store: {}", e))?;

    Ok(())
}

/// Load API keys from the Tauri store
#[tauri::command]
pub async fn load_api_keys(app: AppHandle) -> Result<ApiKeys, String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("Failed to open store: {}", e))?;

    let tmdb = store
        .get("tmdb_key")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default();

    let theporndb = store
        .get("theporndb_key")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default();

    Ok(ApiKeys { tmdb, theporndb })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RcloneSettings {
    #[serde(rename = "dirCacheTime", default = "default_dir_cache_time")]
    pub dir_cache_time: String,
    #[serde(rename = "vfsReadChunkSize", default = "default_vfs_read_chunk_size")]
    pub vfs_read_chunk_size: String,
    #[serde(rename = "vfsReadChunkSizeLimit", default = "default_vfs_read_chunk_size_limit")]
    pub vfs_read_chunk_size_limit: String,
    #[serde(rename = "vfsCacheMode", default = "default_vfs_cache_mode")]
    pub vfs_cache_mode: String,
    #[serde(rename = "tpsLimit", default = "default_tps_limit")]
    pub tps_limit: f64,
    #[serde(rename = "tpsLimitBurst", default = "default_tps_limit_burst")]
    pub tps_limit_burst: i32,
    #[serde(rename = "autoScanOnStartup", default = "default_auto_scan")]
    pub auto_scan_on_startup: bool,
}

fn default_dir_cache_time() -> String {
    "72h".to_string()
}
fn default_vfs_read_chunk_size() -> String {
    "16M".to_string()
}
fn default_vfs_read_chunk_size_limit() -> String {
    "64M".to_string()
}
fn default_vfs_cache_mode() -> String {
    "full".to_string()
}
fn default_tps_limit() -> f64 {
    4.0
}
fn default_tps_limit_burst() -> i32 {
    2
}
fn default_auto_scan() -> bool {
    false
}

impl Default for RcloneSettings {
    fn default() -> Self {
        Self {
            dir_cache_time: default_dir_cache_time(),
            vfs_read_chunk_size: default_vfs_read_chunk_size(),
            vfs_read_chunk_size_limit: default_vfs_read_chunk_size_limit(),
            vfs_cache_mode: default_vfs_cache_mode(),
            tps_limit: default_tps_limit(),
            tps_limit_burst: default_tps_limit_burst(),
            auto_scan_on_startup: default_auto_scan(),
        }
    }
}

impl RcloneSettings {
    pub fn clean_dir_cache_time(&self) -> &str {
        if self.dir_cache_time.trim().is_empty() {
            "72h"
        } else {
            self.dir_cache_time.trim()
        }
    }

    pub fn clean_vfs_read_chunk_size(&self) -> &str {
        if self.vfs_read_chunk_size.trim().is_empty() {
            "16M"
        } else {
            self.vfs_read_chunk_size.trim()
        }
    }

    pub fn clean_vfs_read_chunk_size_limit(&self) -> &str {
        if self.vfs_read_chunk_size_limit.trim().is_empty() {
            "64M"
        } else {
            self.vfs_read_chunk_size_limit.trim()
        }
    }

    pub fn clean_vfs_cache_mode(&self) -> &str {
        if self.vfs_cache_mode.trim().is_empty() {
            "full"
        } else {
            self.vfs_cache_mode.trim()
        }
    }

    pub fn clean_tps_limit(&self) -> f64 {
        if self.tps_limit <= 0.0 {
            4.0
        } else {
            self.tps_limit
        }
    }

    pub fn clean_tps_limit_burst(&self) -> i32 {
        if self.tps_limit_burst <= 0 {
            2
        } else {
            self.tps_limit_burst
        }
    }
}

pub fn get_rclone_settings_sync(app: &AppHandle) -> RcloneSettings {
    if let Ok(store) = app.store(STORE_PATH) {
        if let Some(val) = store.get("rclone_settings") {
            if let Ok(settings) = serde_json::from_value::<RcloneSettings>(val) {
                return settings;
            }
        }
    }
    RcloneSettings::default()
}

/// Save rclone streaming and rate limiting settings to the Tauri store
#[tauri::command]
pub async fn save_rclone_settings(app: AppHandle, settings: RcloneSettings) -> Result<(), String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("Failed to open store: {}", e))?;

    store.set("rclone_settings", serde_json::to_value(&settings).unwrap());

    store
        .save()
        .map_err(|e| format!("Failed to save store: {}", e))?;

    Ok(())
}

/// Load rclone streaming and rate limiting settings from the Tauri store
#[tauri::command]
pub async fn load_rclone_settings(app: AppHandle) -> Result<RcloneSettings, String> {
    Ok(get_rclone_settings_sync(&app))
}

