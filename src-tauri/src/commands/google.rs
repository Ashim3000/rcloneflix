use serde::{Deserialize, Serialize};
use crate::process_ext::std_command;
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;
use std::time::Duration;

const STORE_PATH: &str = "rcloneflix-keys.json";

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GoogleTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub email: String,
    pub display_name: String,
}

/// Percent-decode a query-string value. Decodes into a byte buffer first so
/// multi-byte UTF-8 sequences (`%C3%A9`) survive; a byte-per-char decode would
/// turn them into mojibake.
fn url_decode(s: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        match b {
            b'%' => {
                let h1 = bytes.next();
                let h2 = bytes.next();
                match (h1, h2) {
                    (Some(h1), Some(h2)) => {
                        let hex = [h1, h2];
                        match std::str::from_utf8(&hex)
                            .ok()
                            .and_then(|h| u8::from_str_radix(h, 16).ok())
                        {
                            Some(byte) => out.push(byte),
                            None => {
                                // Not a valid escape — keep the literal text.
                                out.push(b'%');
                                out.push(h1);
                                out.push(h2);
                            }
                        }
                    }
                    _ => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            other => out.push(other),
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Open the Google OAuth URL in the system browser after binding the local
/// HTTP server on the given port to capture the redirect callback.
#[tauri::command]
pub async fn start_google_oauth(
    app: AppHandle,
    auth_url: String,
    port: u16,
) -> Result<(), String> {
    let addr = format!("127.0.0.1:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind callback server on {}: {}", addr, e))?;

    // Spawn local HTTP server to capture callback BEFORE opening browser
    let app_clone = app.clone();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let timeout = Duration::from_secs(120);

        let accept_loop = async {
            loop {
                let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    continue;
                }
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let first_line = request.lines().next().unwrap_or("");
                if first_line.contains("/favicon.ico") {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                    continue;
                }
                let code = extract_code(&request);
                let error = if request.contains("error=") {
                    extract_error(&request).or_else(|| Some("Unknown OAuth error".to_string()))
                } else {
                    None
                };
                if code.is_none() && error.is_none() {
                    let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n").await;
                    continue;
                }
                if let Some(c) = code {
                    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n\
                        <html><body style='background:#0E1116;color:#F3F4F6;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>\
                        <div style='text-align:center'><h2 style='color:#10B981'>&#10003; Signed in to RcloneFlix</h2>\
                        <p>You can close this tab and return to the app.</p></div></body></html>";
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                    let _ = app_clone.emit("oauth-callback", serde_json::json!({ "code": c }));
                    return Ok::<(), String>(());
                } else if let Some(e) = error {
                    let response = format!("HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\n\r\n\
                        <html><body style='background:#0E1116;color:#F3F4F6;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>\
                        <div style='text-align:center'><h2 style='color:#EF4444'>Sign-in failed</h2>\
                        <p>OAuth error: {}</p></div></body></html>", e);
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                    let _ = app_clone.emit("oauth-error", serde_json::json!({ "error": e }));
                    return Ok::<(), String>(());
                }
            }
        };

        match tokio::time::timeout(timeout, accept_loop).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                eprintln!("OAuth callback accept error: {}", e);
                let _ = app_clone.emit("oauth-error", serde_json::json!({
                    "error": format!("Connection error: {}", e)
                }));
            }
            Err(_) => {
                let _ = app_clone.emit("oauth-error", serde_json::json!({
                    "error": "OAuth timeout - please try again"
                }));
            }
        }
    });

    // Now open browser safely
    #[cfg(target_os = "linux")]
    std_command("xdg-open").arg(&auth_url).spawn()
        .map_err(|e| format!("Failed to open browser: {}", e))?;
    #[cfg(target_os = "macos")]
    std_command("open").arg(&auth_url).spawn()
        .map_err(|e| format!("Failed to open browser: {}", e))?;
    #[cfg(target_os = "windows")]
    {
        let escaped_url = auth_url.replace('&', "^&");
        std_command("cmd").args(["/C", "start", "", &escaped_url]).spawn()
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }

    Ok(())
}

fn extract_code(request: &str) -> Option<String> {
    let line = request.lines().next()?;
    let path = line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for param in query.split('&') {
        let mut parts = param.splitn(2, '=');
        if parts.next() == Some("code") {
            return parts.next().map(|s| url_decode(s));
        }
    }
    None
}

fn extract_error(request: &str) -> Option<String> {
    let line = request.lines().next()?;
    let path = line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for param in query.split('&') {
        let mut parts = param.splitn(2, '=');
        if parts.next() == Some("error") {
            return parts.next().map(|s| url_decode(s));
        }
    }
    None
}

/// Save Google tokens to the Tauri store
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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_google_authorization_codes() {
        // Real codes contain %2F; not decoding it caused invalid_grant.
        assert_eq!(url_decode("4%2F0AY0e-g5abc"), "4/0AY0e-g5abc");
        assert_eq!(url_decode("plain"), "plain");
        assert_eq!(url_decode("a+b"), "a b");
    }

    #[test]
    fn decodes_multibyte_utf8() {
        // A byte-per-char decode turned this into mojibake.
        assert_eq!(url_decode("caf%C3%A9"), "café");
    }

    #[test]
    fn leaves_malformed_escapes_alone() {
        assert_eq!(url_decode("100%"), "100%");
        assert_eq!(url_decode("%zz"), "%zz");
    }

    #[test]
    fn extracts_code_from_request_line() {
        let req = "GET /oauth/callback?code=4%2Fabc&scope=email HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(extract_code(req), Some("4/abc".to_string()));
    }

    #[test]
    fn extracts_error_and_ignores_missing_code() {
        let req = "GET /oauth/callback?error=access_denied HTTP/1.1\r\n\r\n";
        assert_eq!(extract_code(req), None);
        assert_eq!(extract_error(req), Some("access_denied".to_string()));
    }
}
