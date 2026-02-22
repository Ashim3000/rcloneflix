use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_PATH: &str = "rcloneflix-keys.json";

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ApiKeys {
    pub tmdb: String,
    pub theporndb: String,
}

/// Save API keys to Tauri's encrypted store
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

/// Load API keys from Tauri's encrypted store
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
