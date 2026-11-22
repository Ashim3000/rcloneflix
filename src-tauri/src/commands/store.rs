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
    #[serde(rename = "bwLimit", default)]
    pub bw_limit: Option<String>,
    #[serde(rename = "softDeleteEnabled", default)]
    pub soft_delete_enabled: bool,
    #[serde(rename = "softDeleteTrashDir", default = "default_soft_delete_trash_dir")]
    pub soft_delete_trash_dir: String,
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
fn default_soft_delete_trash_dir() -> String {
    ".rcloneflix_trash".to_string()
}

/// Validates an rclone `--bwlimit` value: empty, "off", a rate like "5M" / "500k" / "10M:100M",
/// or space-separated "HH:MM,<rate|off>" schedule tokens.
pub fn validate_bw_limit(raw: &str) -> Result<Option<String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    static BW_TOKEN_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = BW_TOKEN_RE.get_or_init(|| {
        regex::Regex::new(
            r"^(?:off|\d+(?:\.\d+)?[bBkKmMgGtTpP]?(?::\d+(?:\.\d+)?[bBkKmMgGtTpP]?)?|(?:[01]\d|2[0-3]):[0-5]\d,(?:off|\d+(?:\.\d+)?[bBkKmMgGtTpP]?(?::\d+(?:\.\d+)?[bBkKmMgGtTpP]?)?))$",
        )
        .unwrap()
    });
    for token in trimmed.split_whitespace() {
        if !re.is_match(token) {
            return Err(format!(
                "Invalid bwLimit token '{}'. Expected 'off', a rate like '5M', or schedule entries like '08:00,5M 23:00,off'.",
                token
            ));
        }
    }
    Ok(Some(trimmed.to_string()))
}

pub fn validate_soft_delete_trash_dir(raw: &str) -> Result<String, String> {
    let t = raw.trim().trim_matches('/');
    if t.is_empty() {
        return Ok(".rcloneflix_trash".to_string());
    }
    if t == "."
        || t == ".."
        || !t
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(
            "App Trash Folder Name may only contain letters, numbers, '.', '_', and '-' (no spaces, slashes, or glob characters)."
                .to_string(),
        );
    }
    Ok(t.to_string())
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
            bw_limit: None,
            soft_delete_enabled: false,
            soft_delete_trash_dir: default_soft_delete_trash_dir(),
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

    pub fn clean_bw_limit(&self) -> Option<String> {
        self.bw_limit
            .as_deref()
            .and_then(|s| validate_bw_limit(s).ok().flatten())
    }

    pub fn clean_soft_delete_trash_dir(&self) -> &str {
        let t = self.soft_delete_trash_dir.trim().trim_matches('/');
        if t.is_empty()
            || t == "."
            || t == ".."
            || !t
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        {
            ".rcloneflix_trash"
        } else {
            t
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
pub async fn save_rclone_settings(app: AppHandle, mut settings: RcloneSettings) -> Result<(), String> {
    if let Some(ref raw_bw) = settings.bw_limit {
        settings.bw_limit = validate_bw_limit(raw_bw)?;
    }
    settings.soft_delete_trash_dir = validate_soft_delete_trash_dir(&settings.soft_delete_trash_dir)?;
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

/// Persists the rclone config text in the app store (used for Drive backups) WITHOUT writing any file.
pub fn set_rclone_config_content_in_store(app: &AppHandle, content: &str) -> Result<(), String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("Failed to open store: {}", e))?;
    store.set("rclone_config_content", serde_json::json!(content));
    store
        .save()
        .map_err(|e| format!("Failed to save store: {}", e))
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum CacheBucket {
    Artwork,
    Photos,
    ComicCache,
    Extract,
    CatboxTemp,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppCacheUsage {
    pub artwork_bytes: u64,
    pub photos_bytes: u64,
    pub comic_cache_bytes: u64,
    pub extract_bytes: u64,
    pub catbox_temp_bytes: u64,
}

fn dir_size_bytes(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                total = total.saturating_add(meta.len());
            } else if meta.is_dir() {
                total = total.saturating_add(dir_size_bytes(&entry.path()));
            }
        }
    }
    total
}

fn resolve_cache_bucket_dir(app: &AppHandle, bucket: CacheBucket) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let base_cache = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("No cache dir: {}", e))?;
    let path = match bucket {
        CacheBucket::Artwork => base_cache.join("artwork"),
        CacheBucket::Photos => base_cache.join("photos"),
        CacheBucket::ComicCache => base_cache.join("comic_cache"),
        CacheBucket::Extract => std::env::temp_dir().join("rcloneflix_extract"),
        CacheBucket::CatboxTemp => std::env::temp_dir().join("rcloneflix_catbox"),
    };
    Ok(path)
}

#[tauri::command]
pub async fn get_app_cache_usage(app: AppHandle) -> Result<AppCacheUsage, String> {
    Ok(AppCacheUsage {
        artwork_bytes: dir_size_bytes(&resolve_cache_bucket_dir(&app, CacheBucket::Artwork)?),
        photos_bytes: dir_size_bytes(&resolve_cache_bucket_dir(&app, CacheBucket::Photos)?),
        comic_cache_bytes: dir_size_bytes(&resolve_cache_bucket_dir(&app, CacheBucket::ComicCache)?),
        extract_bytes: dir_size_bytes(&resolve_cache_bucket_dir(&app, CacheBucket::Extract)?),
        catbox_temp_bytes: dir_size_bytes(&resolve_cache_bucket_dir(&app, CacheBucket::CatboxTemp)?),
    })
}

#[tauri::command]
pub async fn clear_app_cache_bucket(app: AppHandle, bucket: CacheBucket) -> Result<u64, String> {
    let dir = resolve_cache_bucket_dir(&app, bucket)?;
    let freed = dir_size_bytes(&dir);
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
    }
    Ok(freed)
}

