//! Backup and restore through any configured rclone remote.
//!
//! The Google Drive path needs an OAuth client, a consent screen and a token
//! dance before it can store a single byte. But the user has already given us
//! working credentials for every remote in their rclone config — including
//! Google Drive — so we can just write the backup there with `rclone rcat` and
//! read it back with `rclone cat`. No OAuth, no client id, and it works with
//! whichever of their remotes they prefer.
//!
//! Payloads are gzipped: a 24k-item library is ~12 MB of JSON and roughly a
//! tenth of that compressed, which matters on a slow remote.

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use tauri::{AppHandle, Manager};
use crate::process_ext::{std_command, tokio_command};

use crate::commands::player::rclone_binary;

fn gzip(data: &str) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(data.as_bytes())
        .map_err(|e| format!("Compression failed: {}", e))?;
    encoder.finish().map_err(|e| format!("Compression failed: {}", e))
}

fn gunzip(data: &[u8]) -> Result<String, String> {
    let mut out = String::new();
    GzDecoder::new(data)
        .read_to_string(&mut out)
        .map_err(|e| format!("Decompression failed: {}", e))?;
    Ok(out)
}

/// Write `content` to `remote_path` (e.g. "gdrive:RcloneFlix/backup.json.gz").
#[tauri::command]
pub async fn rclone_write_backup(
    app: AppHandle,
    config_path: String,
    remote_path: String,
    content: String,
) -> Result<u64, String> {
    let compressed = gzip(&content)?;
    crate::log_info!(
        &app,
        "sync",
        "writing backup to {} ({} bytes raw, {} gzipped)",
        remote_path,
        content.len(),
        compressed.len()
    );

    rclone_upload_bytes(app, config_path, remote_path, compressed).await
}

/// Resolves an rclone config path, falling back to standard OS default paths if empty.
/// Returns None if no config file exists, allowing rclone to use its own default behavior.
pub fn resolve_config_arg(config_path: &str) -> Option<String> {
    let trimmed = config_path.trim();
    if !trimmed.is_empty() && std::path::Path::new(trimmed).exists() {
        return Some(trimmed.to_string());
    }
    if let Ok(home) = std::env::var("HOME") {
        let p_custom = std::path::PathBuf::from(&home).join("rclone (2).conf");
        if p_custom.exists() {
            return Some(p_custom.to_string_lossy().to_string());
        }
        let p = std::path::PathBuf::from(home).join(".config/rclone/rclone.conf");
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let p = std::path::PathBuf::from(appdata).join("rclone/rclone.conf");
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

/// Read a backup back out of a remote.
#[tauri::command]
pub async fn rclone_read_backup(
    app: AppHandle,
    config_path: String,
    remote_path: String,
) -> Result<String, String> {
    let rclone = rclone_binary(&app);
    crate::log_info!(&app, "sync", "reading backup from {}", remote_path);

    let mut cmd = tokio_command(&rclone);
    cmd.arg("cat");
    if let Some(cfg) = resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.arg(&remote_path);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        crate::log_error!(&app, "sync", "cat failed for {}: {}", remote_path, stderr.trim());
        return Err(format!("rclone error: {}", stderr.trim()));
    }

    // Backups are gzipped, but accept plain JSON so a hand-written or
    // hand-edited file still restores.
    if output.stdout.starts_with(&[0x1f, 0x8b]) {
        gunzip(&output.stdout)
    } else {
        String::from_utf8(output.stdout).map_err(|e| format!("Backup is not valid UTF-8: {}", e))
    }
}

/// Read raw binary bytes of any file from an rclone remote via `rclone cat`.
#[tauri::command]
pub async fn rclone_read_bytes(
    app: AppHandle,
    config_path: String,
    remote_path: String,
) -> Result<Vec<u8>, String> {
    let rclone = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone);
    cmd.arg("cat");
    if let Some(cfg) = resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.arg(&remote_path);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone cat: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rclone cat error: {}", stderr.trim()));
    }

    Ok(output.stdout)
}

/// Create the destination folder if it doesn't exist yet.
#[tauri::command]
pub async fn rclone_mkdir(
    app: AppHandle,
    config_path: String,
    remote_path: String,
) -> Result<(), String> {
    if remote_path.starts_with("shared_") && !remote_path.contains(".rflix_passes") {
        return Err("Permission denied: directory creation is forbidden on shared access pass remotes".into());
    }

    let rclone = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone);
    cmd.arg("mkdir");
    if let Some(cfg) = resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.arg(&remote_path);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rclone error: {}", stderr.trim()));
    }
    crate::commands::rclone::spawn_best_effort_vfs_refresh(&app, &remote_path);
    Ok(())
}

/// Upload a local file or directory directly to a remote path.
#[tauri::command]
pub async fn rclone_upload_file(
    app: AppHandle,
    config_path: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    if remote_path.starts_with("shared_") && !remote_path.contains(".rflix_passes") {
        return Err("Permission denied: write operations are forbidden on shared access pass remotes".into());
    }

    let is_dir = std::path::Path::new(&local_path).is_dir();
    let subcmd = if is_dir { "copy" } else { "copyto" };

    let rclone = rclone_binary(&app);
    crate::log_info!(&app, "sync", "uploading local {} {} to {}", if is_dir { "folder" } else { "file" }, local_path, remote_path);

    let mut cmd = tokio_command(&rclone);
    cmd.arg(subcmd);
    if let Some(cfg) = resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.args([&local_path, &remote_path]);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone {}: {}", subcmd, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        crate::log_error!(&app, "sync", "{} failed for {}: {}", subcmd, remote_path, stderr.trim());
        return Err(format!("rclone error: {}", stderr.trim()));
    }
    crate::commands::rclone::spawn_best_effort_vfs_refresh(&app, &remote_path);
    Ok(())
}

/// Upload raw bytes directly to a remote path via atomic staging + copyto.
/// This creates any missing remote directories automatically and supports retries on WebDAV/OpenDrive.
#[tauri::command]
pub async fn rclone_upload_bytes(
    app: AppHandle,
    config_path: String,
    remote_path: String,
    bytes: Vec<u8>,
) -> Result<u64, String> {
    if remote_path.starts_with("shared_") && !remote_path.contains(".rflix_passes") {
        return Err("Permission denied: write operations are forbidden on shared access pass remotes".into());
    }

    let size = bytes.len() as u64;
    let rclone = rclone_binary(&app);
    crate::log_info!(&app, "sync", "uploading {} bytes to {}", size, remote_path);

    let staging_dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("No cache dir: {}", e))?
        .join("staging");
    let _ = tokio::fs::create_dir_all(&staging_dir).await;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_name = format!("staging_{}_{}.tmp", std::process::id(), now);
    let temp_path = staging_dir.join(&temp_name);

    tokio::fs::write(&temp_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write staging file: {}", e))?;

    let mut cmd = tokio_command(&rclone);
    cmd.arg("copyto");
    if let Some(cfg) = resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.args([
        temp_path.to_str().unwrap_or(""),
        remote_path.as_str(),
        "--retries",
        "3",
        "--low-level-retries",
        "10",
    ]);

    let output = cmd.output().await;

    let _ = tokio::fs::remove_file(&temp_path).await;

    let out = output.map_err(|e| format!("Failed to run rclone copyto: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        crate::log_error!(&app, "sync", "upload failed for {}: {}", remote_path, stderr.trim());
        return Err(format!("rclone error: {}", stderr.trim()));
    }
    crate::commands::rclone::spawn_best_effort_vfs_refresh(&app, &remote_path);

    Ok(size)
}

/// Read local file bytes (avoids webview fs scope limitations for arbitrary image paths).
#[tauri::command]
pub async fn read_local_file_bytes(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file {}: {}", path, e))
}

/// Write local file bytes.
#[tauri::command]
pub async fn write_local_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("Failed to write file {}: {}", path, e))
}

/// Recursively or flatly find all image files in a local directory.
#[tauri::command]
pub async fn list_local_image_files(folder_path: String) -> Result<Vec<String>, String> {
    let mut entries = tokio::fs::read_dir(&folder_path)
        .await
        .map_err(|e| format!("Failed to read folder {}: {}", folder_path, e))?;

    let valid_exts = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic", "tiff"];
    let mut files = Vec::new();

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if valid_exts.iter().any(|&v| v.eq_ignore_ascii_case(ext)) {
                    if let Some(s) = path.to_str() {
                        files.push(s.to_string());
                    }
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ArweaveUploadResponse {
    pub id: String,
    pub timestamp: Option<u64>,
    pub winc: Option<String>,
}

/// Post signed ANS-104 DataItem directly to Arweave Turbo bundler from native Rust.
/// Completely avoids WebKitGTK browser CORS restrictions.
#[tauri::command]
pub async fn arweave_post_data_item(
    bytes: Vec<u8>,
) -> Result<ArweaveUploadResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let byte_len = bytes.len();
    let res = client
        .post("https://upload.ardrive.io/v1/tx/arweave")
        .header("content-type", "application/octet-stream")
        .header("content-length", byte_len.to_string())
        .header("x-turbo-source-version", "1.40.0")
        .header("x-turbo-source-identifier", "turbo-sdk")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Arweave upload network error: {}", e))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("Failed reading Arweave response: {}", e))?;

    if !status.is_success() {
        return Err(format!("Arweave gateway error (HTTP {}): {}", status, text));
    }

    let parsed = serde_json::from_str::<ArweaveUploadResponse>(&text)
        .map_err(|e| format!("Failed to parse Arweave response ({}): {}", text, e))?;

    Ok(parsed)
}

/// Fetch encrypted photo bytes from Arweave gateways with automatic fallback in native Rust.
#[tauri::command]
pub async fn arweave_fetch_bytes(arweave_id: String) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let urls = [
        format!("https://turbo-gateway.com/{}", arweave_id),
        format!("https://arweave.net/{}", arweave_id),
        format!("https://gateway.irys.xyz/{}", arweave_id),
    ];

    let mut last_err = String::new();
    for url in urls {
        match client.get(&url).send().await {
            Ok(res) if res.status().is_success() => {
                let bytes = res.bytes().await.map_err(|e| format!("Failed reading bytes: {}", e))?;
                return Ok(bytes.to_vec());
            }
            Ok(res) => {
                last_err = format!("HTTP {}", res.status());
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
    }

    Err(format!("Failed to fetch from Arweave gateways: {}", last_err))
}

/// Open a URL in the user's default external web browser.
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        std_command("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL via xdg-open: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std_command("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std_command("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedPhotoResult {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub format: String,
}

/// Headlessly compress a photo to WebP (< 88 KB) using ffmpeg on the system.
/// Guaranteed to qualify for Arweave Turbo free tier (<= 105 KiB).
#[tauri::command]
pub async fn compress_photo_vault(file_path: String) -> Result<CompressedPhotoResult, String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }

    let steps: &[(u32, u32)] = &[
        (1600, 78),
        (1400, 72),
        (1280, 68),
        (1024, 62),
        (800, 55),
        (640, 48),
    ];

    for &(max_dim, quality) in steps {
        let scale_filter = format!(
            "scale='if(gt(iw,ih),min({max_dim},iw),-1)':'if(gt(iw,ih),-1,min({max_dim},ih))'"
        );
        let output = std_command("ffmpeg")
            .args([
                "-y",
                "-i",
                &file_path,
                "-vf",
                &scale_filter,
                "-q:v",
                &quality.to_string(),
                "-c:v",
                "libwebp",
                "-f",
                "webp",
                "pipe:1",
            ])
            .output();

        if let Ok(out) = output {
            if out.status.success() && !out.stdout.is_empty() {
                let mut bytes = out.stdout;
                // Fix non-seekable pipe RIFF header size at offset 4..8
                if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
                    let riff_size = (bytes.len() - 8) as u32;
                    bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
                }

                if bytes.len() <= 88_000 {
                    return Ok(CompressedPhotoResult {
                        bytes,
                        width: max_dim,
                        height: max_dim,
                        format: "webp".into(),
                    });
                }
            }
        }
    }

    // Final aggressive fallback pass
    let aggressive = std_command("ffmpeg")
        .args([
            "-y",
            "-i",
            &file_path,
            "-vf",
            "scale='if(gt(iw,ih),min(640,iw),-1)':'if(gt(iw,ih),-1,min(640,ih))'",
            "-q:v",
            "40",
            "-c:v",
            "libwebp",
            "-f",
            "webp",
            "pipe:1",
        ])
        .output();

    if let Ok(out) = aggressive {
        if out.status.success() && !out.stdout.is_empty() {
            let mut bytes = out.stdout;
            if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
                let riff_size = (bytes.len() - 8) as u32;
                bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
            }

            return Ok(CompressedPhotoResult {
                bytes,
                width: 640,
                height: 640,
                format: "webp".into(),
            });
        }
    }

    Err("Failed to compress photo with ffmpeg".into())
}

#[cfg(test)]
mod tests {
    use super::{gunzip, gzip};

    #[test]
    fn round_trips_through_gzip() {
        let original = r#"{"items":[1,2,3],"note":"café"}"#;
        let packed = gzip(original).unwrap();
        assert_eq!(gunzip(&packed).unwrap(), original);
    }

    #[test]
    fn compresses_repetitive_json_well() {
        // Backups are highly repetitive, which is the whole reason to gzip.
        let big = r#"{"id":"x","libraryId":"lib1","title":"Track"},"#.repeat(500);
        let packed = gzip(&big).unwrap();
        assert!(
            packed.len() < big.len() / 5,
            "expected >5x compression, got {} from {}",
            packed.len(),
            big.len()
        );
    }

    #[test]
    fn gzip_output_has_the_magic_header() {
        let packed = gzip("hello").unwrap();
        assert_eq!(&packed[..2], &[0x1f, 0x8b]);
    }
}
