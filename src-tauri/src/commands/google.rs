use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;
use std::sync::{Arc, Mutex};

const STORE_PATH: &str = "rcloneflix-keys.json";

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GoogleTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub email: String,
    pub display_name: String,
}

/// Open the Google OAuth URL in the system browser and start a local
/// HTTP server on the given port to capture the redirect callback.
/// Emits "oauth-callback" event with the code when it arrives.
#[tauri::command]
pub async fn start_google_oauth(
    app: AppHandle,
    auth_url: String,
    port: u16,
) -> Result<(), String> {
    // Open browser
    #[cfg(target_os = "linux")]
    Command::new("xdg-open").arg(&auth_url).spawn()
        .map_err(|e| format!("Failed to open browser: {}", e))?;
    #[cfg(target_os = "macos")]
    Command::new("open").arg(&auth_url).spawn()
        .map_err(|e| format!("Failed to open browser: {}", e))?;
    #[cfg(target_os = "windows")]
    Command::new("cmd").args(["/C", "start", &auth_url]).spawn()
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    // Spawn local HTTP server to capture callback
    let app_clone = app.clone();
    tokio::spawn(async move {
        let addr = format!("127.0.0.1:{}", port);
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to bind OAuth callback server: {}", e);
                return;
            }
        };

        // Accept one connection (the OAuth redirect)
        if let Ok((mut stream, _)) = listener.accept().await {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = vec![0u8; 4096];
            if let Ok(n) = stream.read(&mut buf).await {
                let request = String::from_utf8_lossy(&buf[..n]);
                // Parse ?code=xxx from GET /oauth/callback?code=xxx
                if let Some(code) = extract_code(&request) {
                    // Send success response to browser
                    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
                        <html><body style='font-family:sans-serif;text-align:center;padding:60px'>\
                        <h2>✓ Signed in successfully</h2>\
                        <p>You can close this tab and return to RcloneFlix.</p>\
                        </body></html>";
                    let _ = stream.write_all(response.as_bytes()).await;

                    // Emit event to frontend
                    let _ = app_clone.emit("oauth-callback", serde_json::json!({ "code": code }));
                } else {
                    let response = "HTTP/1.1 400 Bad Request\r\n\r\nMissing code parameter";
                    let _ = stream.write_all(response.as_bytes()).await;
                }
            }
        }
    });

    Ok(())
}

fn extract_code(request: &str) -> Option<String> {
    // GET /oauth/callback?code=xxxx&... HTTP/1.1
    let line = request.lines().next()?;
    let path = line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for param in query.split('&') {
        let mut parts = param.splitn(2, '=');
        if parts.next() == Some("code") {
            return parts.next().map(|s| s.to_string());
        }
    }
    None
}

/// Save Google tokens to encrypted store
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
