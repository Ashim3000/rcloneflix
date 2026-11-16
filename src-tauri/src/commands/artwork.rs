//! Poster / artwork cache.
//!
//! Posters used to be fetched straight from the provider CDN on every render.
//! With a library in the tens of thousands that means thousands of live
//! requests, nothing works offline, and scrolling is at the mercy of the
//! network. Images are cached to disk once and served from there afterwards.
//!
//! Files are named by a hash of the source URL, so the same poster is stored
//! once no matter how many items reference it.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use crate::process_ext::tokio_command;

use crate::commands::player::rclone_binary;

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("No cache dir: {}", e))?
        .join("artwork");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create artwork dir: {}", e))?;
    Ok(dir)
}

fn photo_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("No cache dir: {}", e))?
        .join("photos");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create photos cache dir: {}", e))?;
    Ok(dir)
}

/// Enforce LRU cache cap on a directory. If total size exceeds max_bytes,
/// evict oldest files until usage is within 85% of max_bytes.
fn enforce_lru_cap(dir: &Path, max_bytes: u64) {
    if max_bytes == 0 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total_bytes: u64 = 0;

    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                let size = meta.len();
                let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                files.push((entry.path(), size, modified));
                total_bytes += size;
            }
        }
    }

    if total_bytes > max_bytes {
        files.sort_by_key(|f| f.2); // oldest first
        let target_bytes = max_bytes.saturating_mul(85) / 100;
        for (path, size, _) in files {
            if total_bytes <= target_bytes {
                break;
            }
            if let Ok(()) = std::fs::remove_file(&path) {
                total_bytes = total_bytes.saturating_sub(size);
            }
        }
    }
}

/// Stable filename for a URL. djb2 is plenty here — a collision only costs a
/// wrong thumbnail, and the extension keeps the file recognisable.
fn cache_name(url: &str) -> String {
    let mut hash: u64 = 5381;
    for b in url.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(b as u64);
    }
    let ext = url
        .rsplit('/')
        .next()
        .and_then(|seg| seg.rsplit_once('.'))
        .map(|(_, e)| e.split(['?', '#']).next().unwrap_or("jpg"))
        .filter(|e| e.len() <= 4 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("jpg");
    format!("{:016x}.{}", hash, ext)
}

/// Return a local path for `url`, downloading it if it isn't cached yet.
/// Can optionally mirror downloaded artwork to `{remote_mirror}:.artwork/{name}`
/// or restore from there if the CDN 404s.
#[tauri::command]
pub async fn cache_artwork(
    app: AppHandle,
    url: String,
    remote_mirror: Option<String>,
    config_path: Option<String>,
    max_cache_mb: Option<u64>,
) -> Result<Option<String>, String> {
    if url.is_empty() || !url.starts_with("http") {
        return Ok(None);
    }

    let dir = cache_dir(&app)?;
    let name = cache_name(&url);
    let path = dir.join(&name);

    if path.exists() {
        return Ok(Some(path.to_string_lossy().into_owned()));
    }

    // 1. Try CDN
    let mut fetched_bytes: Option<Vec<u8>> = None;
    if let Ok(resp) = reqwest::get(&url).await {
        if resp.status().is_success() {
            if let Ok(b) = resp.bytes().await {
                fetched_bytes = Some(b.to_vec());
            }
        } else {
            crate::log_warn!(&app, "artwork", "{} returned {}", url, resp.status());
        }
    }

    // 2. If CDN failed, check remote mirror fallback: {remote}:.artwork/{name}
    if fetched_bytes.is_none() {
        if let (Some(remote), Some(cfg)) = (&remote_mirror, &config_path) {
            let remote_path = format!("{}:.artwork/{}", remote, name);
            let rclone = rclone_binary(&app);
            let mut cmd = tokio_command(&rclone);
            cmd.arg("cat");
            if let Some(c) = crate::commands::rclone_sync::resolve_config_arg(cfg) {
                cmd.args(["--config", &c]);
            }
            cmd.arg(&remote_path);
            if let Ok(out) = cmd.output().await {
                if out.status.success() && !out.stdout.is_empty() {
                    crate::log_info!(&app, "artwork", "Restored {} from remote mirror {}", name, remote_path);
                    fetched_bytes = Some(out.stdout);
                }
            }
        }
    }

    let bytes = match fetched_bytes {
        Some(b) => b,
        None => return Ok(None),
    };

    // Write to a temp name first so a partial download can never be served.
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Cannot write artwork: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Cannot finalise artwork: {}", e))?;

    // Asynchronously mirror to remote if configured
    if let (Some(remote), Some(cfg)) = (remote_mirror, config_path) {
        let app_bg = app.clone();
        let path_bg = path.clone();
        let remote_path = format!("{}:.artwork/{}", remote, name);
        tokio::spawn(async move {
            let rclone = rclone_binary(&app_bg);
            let mut cmd = tokio_command(&rclone);
            cmd.arg("copyto");
            if let Some(c) = crate::commands::rclone_sync::resolve_config_arg(&cfg) {
                cmd.args(["--config", &c]);
            }
            cmd.args([path_bg.to_string_lossy().as_ref(), remote_path.as_str()]);
            let _ = cmd.output().await;
        });
    }

    // Enforce LRU cache cap (default 200 MB)
    let cap_bytes = max_cache_mb.unwrap_or(200).max(10) * 1024 * 1024;
    enforce_lru_cap(&dir, cap_bytes);

    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Look up a cached path without downloading. Used on render so the UI can
/// show a cached poster immediately and only queue a fetch when it's missing.
#[tauri::command]
pub fn cached_artwork_path(app: AppHandle, url: String) -> Result<Option<String>, String> {
    if url.is_empty() {
        return Ok(None);
    }
    let path = cache_dir(&app)?.join(cache_name(&url));
    Ok(if path.exists() {
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    })
}

#[derive(serde::Serialize)]
pub struct CacheStats {
    pub files: usize,
    pub bytes: u64,
}

#[tauri::command]
pub fn artwork_cache_stats(app: AppHandle) -> Result<CacheStats, String> {
    let dir = cache_dir(&app)?;
    let mut files = 0;
    let mut bytes = 0;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    files += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    Ok(CacheStats { files, bytes })
}

#[tauri::command]
pub fn clear_artwork_cache(app: AppHandle) -> Result<(), String> {
    let dir = cache_dir(&app)?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot recreate artwork dir: {}", e))?;
    Ok(())
}

// ── Photo Vault Local Disk Cache ──────────────────────────────────────────────

#[tauri::command]
pub fn get_cached_vault_photo(app: AppHandle, photo_id: String) -> Result<Option<Vec<u8>>, String> {
    if photo_id.is_empty() {
        return Ok(None);
    }
    let dir = photo_cache_dir(&app)?;
    let safe_id: String = photo_id.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
    let path = dir.join(format!("{}.bin", safe_id));
    if path.exists() {
        let bytes = std::fs::read(&path).map_err(|e| format!("Failed reading cached photo: {}", e))?;
        Ok(Some(bytes))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn save_cached_vault_photo(
    app: AppHandle,
    photo_id: String,
    bytes: Vec<u8>,
    max_cache_mb: Option<u64>,
) -> Result<(), String> {
    if photo_id.is_empty() || bytes.is_empty() {
        return Ok(());
    }
    let dir = photo_cache_dir(&app)?;
    let safe_id: String = photo_id.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
    let path = dir.join(format!("{}.bin", safe_id));
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Cannot write cached photo: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Cannot finalise cached photo: {}", e))?;

    let cap_bytes = max_cache_mb.unwrap_or(200).max(10) * 1024 * 1024;
    enforce_lru_cap(&dir, cap_bytes);
    Ok(())
}

#[tauri::command]
pub fn clear_vault_photo_cache(app: AppHandle) -> Result<(), String> {
    let dir = photo_cache_dir(&app)?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot recreate photos cache dir: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn vault_photo_cache_stats(app: AppHandle) -> Result<CacheStats, String> {
    let dir = photo_cache_dir(&app)?;
    let mut files = 0;
    let mut bytes = 0;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    files += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    Ok(CacheStats { files, bytes })
}

#[tauri::command]
pub async fn generate_screencap(
    app: AppHandle,
    input: String,
    offset_secs: Option<u64>,
) -> Result<String, String> {
    if input.is_empty() {
        return Err("Input path or URL is empty".to_string());
    }

    let dir = cache_dir(&app)?.join("screencaps");
    let _ = std::fs::create_dir_all(&dir);

    let name = format!("cap_{}.jpg", cache_name(&input));
    let out_path = dir.join(&name);

    if out_path.exists() && std::fs::metadata(&out_path).map(|m| m.len() > 1000).unwrap_or(false) {
        return Ok(out_path.to_string_lossy().to_string());
    }

    let offset = offset_secs.unwrap_or(10);
    let mut cmd = tokio_command("ffmpeg");
    cmd.arg("-ss")
        .arg(offset.to_string())
        .arg("-i")
        .arg(&input)
        .arg("-vframes")
        .arg("1")
        .arg("-q:v")
        .arg("3")
        .arg("-vf")
        .arg("scale=480:-1")
        .arg("-y")
        .arg(&out_path);

    let output = cmd.output().await.map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;
    if !output.status.success() || !out_path.exists() {
        // Fallback: try offset 2s in case video is very short
        let mut retry_cmd = tokio_command("ffmpeg");
        retry_cmd.arg("-ss")
            .arg("2")
            .arg("-i")
            .arg(&input)
            .arg("-vframes")
            .arg("1")
            .arg("-q:v")
            .arg("3")
            .arg("-vf")
            .arg("scale=480:-1")
            .arg("-y")
            .arg(&out_path);

        let _ = retry_cmd.output().await;
    }

    if out_path.exists() && std::fs::metadata(&out_path).map(|m| m.len() > 1000).unwrap_or(false) {
        Ok(out_path.to_string_lossy().to_string())
    } else {
        Err("Failed to generate screencap thumbnail with ffmpeg".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::cache_name;

    #[test]
    fn names_are_stable_and_keep_the_extension() {
        let a = cache_name("https://image.tmdb.org/t/p/w342/abc.jpg");
        assert_eq!(a, cache_name("https://image.tmdb.org/t/p/w342/abc.jpg"));
        assert!(a.ends_with(".jpg"));
    }

    #[test]
    fn different_urls_get_different_names() {
        assert_ne!(
            cache_name("https://image.tmdb.org/t/p/w342/a.jpg"),
            cache_name("https://image.tmdb.org/t/p/w342/b.jpg")
        );
    }

    #[test]
    fn odd_urls_fall_back_to_jpg() {
        assert!(cache_name("https://example.com/poster").ends_with(".jpg"));
        assert!(cache_name("https://example.com/a.verylongext").ends_with(".jpg"));
    }
}
