use crate::process_ext::tokio_command;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const CATBOX_MAX_BYTES: u64 = 200 * 1024 * 1024;

struct DirGuard(PathBuf);
impl Drop for DirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Copies `remote_path` (e.g. "gdrive:Music/a.flac") into the app cache dir and uploads it to catbox.moe.
/// Returns the public `https://files.catbox.moe/...` URL.
#[tauri::command]
pub async fn catbox_upload_file(
    app: AppHandle,
    config_path: String,
    remote_path: String,
    filename: String,
    userhash: Option<String>,
) -> Result<String, String> {
    if remote_path.starts_with("shared_") {
        return Err("Guest pass items cannot be offloaded to Catbox.".to_string());
    }
    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| "Invalid filename".to_string())?;
    let lower = safe_name.to_lowercase();
    for ext in [".exe", ".scr", ".cpl", ".doc", ".docx", ".jar"] {
        if lower.ends_with(ext) {
            return Err(format!("Catbox.moe does not allow uploading {} files.", ext));
        }
    }

    let work = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("No app cache dir: {}", e))?
        .join("catbox")
        .join(format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
    std::fs::create_dir_all(&work).map_err(|e| format!("Failed creating work dir: {}", e))?;
    let _guard = DirGuard(work.clone());
    let local = work.join(&safe_name);

    let rclone = crate::commands::player::rclone_binary(&app);
    let cfg_opt = crate::commands::rclone_sync::resolve_config_arg(&config_path);
    let mut cmd = tokio_command(&rclone);
    if let Some(ref cfg) = cfg_opt {
        cmd.args(["--config", cfg]);
    }
    cmd.args(["copyto", &remote_path, &local.to_string_lossy()]);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("rclone copy failed: {}", e))?;
    if !out.status.success() {
        return Err(format!("rclone copy failed: {}", String::from_utf8_lossy(&out.stderr)));
    }

    let len = std::fs::metadata(&local).map_err(|e| e.to_string())?.len();
    if len > CATBOX_MAX_BYTES {
        return Err(format!("File exceeds Catbox.moe's 200 MB limit ({} MB).", len / 1_048_576));
    }
    let local_clone = local.clone();
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(local_clone))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(safe_name.clone())
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new()
        .text("reqtype", "fileupload")
        .part("fileToUpload", part);
    if let Some(h) = userhash.map(|h| h.trim().to_string()).filter(|h| !h.is_empty()) {
        form = form.text("userhash", h);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post("https://catbox.moe/user/api.php")
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Catbox upload failed: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let url = body.trim().to_string();
    if !status.is_success() || !url.starts_with("https://files.catbox.moe/") {
        return Err(format!("Catbox upload failed (HTTP {}): {}", status.as_u16(), url));
    }
    Ok(url)
}
