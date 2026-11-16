use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

const STORE_PATH: &str = "rcloneflix-keys.json";

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GoogleTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub email: String,
}

/// Open the Google OAuth URL in the system browser.
/// The OAuth redirect will come back to our local server on port 9876.
/// Real implementation requires a Google Cloud client_id passed from frontend.
#[tauri::command]
pub async fn start_google_oauth(
    app: AppHandle,
    client_id: String,
) -> Result<(), String> {
    let redirect_uri = "http://localhost:9876/oauth/callback";
    let scopes = "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.email";

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth\
        ?client_id={}\
        &redirect_uri={}\
        &response_type=code\
        &scope={}\
        &access_type=offline\
        &prompt=consent",
        urlencoding_simple(&client_id),
        urlencoding_simple(redirect_uri),
        urlencoding_simple(scopes),
    );

    // Open in system browser
    #[cfg(target_os = "linux")]
    Command::new("xdg-open").arg(&auth_url).spawn()
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    #[cfg(target_os = "macos")]
    Command::new("open").arg(&auth_url).spawn()
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    #[cfg(target_os = "windows")]
    Command::new("cmd").args(["/C", "start", &auth_url]).spawn()
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    let _ = app.emit("google-oauth-opened", serde_json::json!({ "url": auth_url }));

    Ok(())
}

/// Save Google tokens to store
#[tauri::command]
pub async fn save_google_tokens(
    app: AppHandle,
    tokens: GoogleTokens,
) -> Result<(), String> {
    let store = app.store(STORE_PATH)
        .map_err(|e| format!("Store error: {}", e))?;
    store.set("google_tokens", serde_json::to_value(&tokens).unwrap());
    store.save().map_err(|e| format!("Save error: {}", e))?;
    Ok(())
}

/// Load Google tokens from store
#[tauri::command]
pub async fn load_google_tokens(app: AppHandle) -> Result<Option<GoogleTokens>, String> {
    let store = app.store(STORE_PATH)
        .map_err(|e| format!("Store error: {}", e))?;
    match store.get("google_tokens") {
        Some(v) => {
            let tokens: GoogleTokens = serde_json::from_value(v)
                .map_err(|e| format!("Parse error: {}", e))?;
            Ok(Some(tokens))
        }
        None => Ok(None),
    }
}

/// Clear stored Google tokens (sign out)
#[tauri::command]
pub async fn clear_google_tokens(app: AppHandle) -> Result<(), String> {
    let store = app.store(STORE_PATH)
        .map_err(|e| format!("Store error: {}", e))?;
    store.delete("google_tokens");
    store.save().map_err(|e| format!("Save error: {}", e))?;
    Ok(())
}

fn urlencoding_simple(s: &str) -> String {
    let mut out = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}
