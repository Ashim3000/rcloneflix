use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use crate::process_ext::{std_command, tokio_command};

use crate::commands::player::rclone_binary;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadItem {
    pub remote_path: String,
    pub filename: String,
    pub subfolder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgressEvent {
    pub download_id: String,
    pub total_files: usize,
    pub completed_files: usize,
    pub current_file: String,
    pub destination_path: String,
    pub status: String, // "downloading" | "completed" | "error"
    pub error: Option<String>,
}

/// Sanitize individual path segments to prevent directory traversal or invalid characters.
pub fn sanitize_path_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    let mut s = if trimmed.is_empty() {
        "media".to_string()
    } else {
        trimmed.to_string()
    };
    if s.len() > 180 {
        let mut end = 180;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s = s.trim_end_matches([' ', '.', '_']).to_string();
    }
    if s.is_empty() {
        "media".to_string()
    } else {
        s
    }
}

/// Default download folder: ~/Downloads/RcloneFlix
pub fn default_download_dir(app: &AppHandle) -> PathBuf {
    let base = app.path().download_dir().unwrap_or_else(|_| {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|h| h.join("Downloads"))
            .unwrap_or_else(std::env::temp_dir)
    });
    base.join("RcloneFlix")
}

/// Resolves the destination directory for a download job.
pub fn resolve_destination(
    app: &AppHandle,
    destination_dir: Option<String>,
    subfolder: Option<&str>,
) -> PathBuf {
    let mut base = if let Some(custom) = destination_dir {
        if !custom.trim().is_empty() {
            PathBuf::from(custom)
        } else {
            default_download_dir(app)
        }
    } else {
        default_download_dir(app)
    };

    if let Some(sub) = subfolder {
        for segment in sub.split(['/', '\\']) {
            let seg = segment.trim();
            if !seg.is_empty() && seg != "." && seg != ".." {
                base.push(sanitize_path_segment(seg));
            }
        }
    }

    base
}

/// Returns the default download directory path as a string.
#[tauri::command]
pub fn get_default_download_dir(app: AppHandle) -> Result<String, String> {
    Ok(default_download_dir(&app).to_string_lossy().into_owned())
}

/// Starts an asynchronous download batch using rclone copyto.
/// Emits "download-progress" events on the Tauri app handle.
#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    config_path: String,
    download_id: String,
    items: Vec<DownloadItem>,
    destination_dir: Option<String>,
) -> Result<String, String> {
    if items.is_empty() {
        return Err("No items provided for download".to_string());
    }

    let first_sub = items.first().and_then(|i| i.subfolder.as_deref());
    let dest_dir = resolve_destination(&app, destination_dir.clone(), first_sub);
    let dest_dir_str = dest_dir.to_string_lossy().into_owned();

    crate::log_info!(
        &app,
        "download",
        "Starting download job {} ({} files) into {}",
        download_id,
        items.len(),
        dest_dir_str
    );

    let app_clone = app.clone();
    let download_id_clone = download_id.clone();
    let dest_dir_clone = dest_dir_str.clone();

    // Spawn async download worker
    tokio::spawn(async move {
        let total_files = items.len();
        let mut completed_files = 0;
        let rclone = rclone_binary(&app_clone);

        for item in items {
            let item_dest_dir = resolve_destination(
                &app_clone,
                destination_dir.clone(),
                item.subfolder.as_deref(),
            );

            if let Err(e) = tokio::fs::create_dir_all(&item_dest_dir).await {
                let err_msg = format!("Failed to create destination directory: {}", e);
                crate::log_error!(&app_clone, "download", "{}", err_msg);
                let _ = app_clone.emit(
                    "download-progress",
                    DownloadProgressEvent {
                        download_id: download_id_clone.clone(),
                        total_files,
                        completed_files,
                        current_file: item.filename.clone(),
                        destination_path: dest_dir_clone.clone(),
                        status: "error".to_string(),
                        error: Some(err_msg),
                    },
                );
                return;
            }

            let clean_filename = sanitize_path_segment(&item.filename);
            let is_stream = item.remote_path.starts_with("http://") || item.remote_path.starts_with("https://");
            let mut local_dest_path = item_dest_dir.join(&clean_filename);
            if is_stream {
                let lower = clean_filename.to_lowercase();
                if !lower.ends_with(".mp4") && !lower.ends_with(".mkv") && !lower.ends_with(".m4a") && !lower.ends_with(".mp3") {
                    local_dest_path.set_extension("mp4");
                }
            }

            // Notify downloading current file
            let _ = app_clone.emit(
                "download-progress",
                DownloadProgressEvent {
                    download_id: download_id_clone.clone(),
                    total_files,
                    completed_files,
                    current_file: item.filename.clone(),
                    destination_path: dest_dir_clone.clone(),
                    status: "downloading".to_string(),
                    error: None,
                },
            );

            let output = if is_stream {
                if let Some(yt_dlp) = find_yt_dlp_binary() {
                    let mut stream_target = item.remote_path.clone();
                    if let Ok(resolved) = crate::commands::stream_ingest::resolve_web_stream_url(stream_target.clone()).await {
                        if !resolved.is_empty() {
                            stream_target = resolved;
                        }
                    }

                    crate::log_info!(
                        &app_clone,
                        "download",
                        "Downloading stream via yt-dlp: {} -> {}",
                        stream_target,
                        local_dest_path.display()
                    );

                    tokio_command(&yt_dlp)
                        .arg("--no-playlist")
                        .arg("--merge-output-format")
                        .arg("mp4")
                        .arg("-o")
                        .arg(local_dest_path.to_str().unwrap_or(""))
                        .arg(&stream_target)
                        .output()
                        .await
                } else {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "yt-dlp is required to download web streams and HLS playlists but was not found.",
                    ))
                }
            } else {
                let mut cmd = tokio_command(&rclone);
                cmd.arg("copyto");
                if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
                    cmd.args(["--config", &cfg]);
                }
                cmd.args([
                    &item.remote_path,
                    local_dest_path.to_str().unwrap_or(""),
                ]);
                cmd.output().await
            };

            match output {
                Ok(out) if out.status.success() => {
                    completed_files += 1;
                    crate::log_info!(
                        &app_clone,
                        "download",
                        "Downloaded ({}/{}): {}",
                        completed_files,
                        total_files,
                        clean_filename
                    );
                    let _ = app_clone.emit(
                        "download-progress",
                        DownloadProgressEvent {
                            download_id: download_id_clone.clone(),
                            total_files,
                            completed_files,
                            current_file: item.filename.clone(),
                            destination_path: dest_dir_clone.clone(),
                            status: if completed_files == total_files {
                                "completed".to_string()
                            } else {
                                "downloading".to_string()
                            },
                            error: None,
                        },
                    );
                }
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    let err_msg = if is_stream {
                        format!("Stream download failed for {}: {}", item.filename, stderr.trim())
                    } else {
                        format!("rclone error downloading {}: {}", item.filename, stderr.trim())
                    };
                    crate::log_error!(&app_clone, "download", "{}", err_msg);
                    let _ = app_clone.emit(
                        "download-progress",
                        DownloadProgressEvent {
                            download_id: download_id_clone.clone(),
                            total_files,
                            completed_files,
                            current_file: item.filename.clone(),
                            destination_path: dest_dir_clone.clone(),
                            status: "error".to_string(),
                            error: Some(err_msg),
                        },
                    );
                    return;
                }
                Err(e) => {
                    let err_msg = if is_stream {
                        format!("Failed to run stream downloader for {}: {}", item.filename, e)
                    } else {
                        format!("Failed to run rclone for {}: {}", item.filename, e)
                    };
                    crate::log_error!(&app_clone, "download", "{}", err_msg);
                    let _ = app_clone.emit(
                        "download-progress",
                        DownloadProgressEvent {
                            download_id: download_id_clone.clone(),
                            total_files,
                            completed_files,
                            current_file: item.filename.clone(),
                            destination_path: dest_dir_clone.clone(),
                            status: "error".to_string(),
                            error: Some(err_msg),
                        },
                    );
                    return;
                }
            }
        }
    });

    Ok(dest_dir_str)
}

/// Starts an asynchronous download of an entire remote folder using `rclone copy`.
/// Emits "download-progress" events on the Tauri app handle.
#[tauri::command]
pub async fn start_folder_download(
    app: AppHandle,
    config_path: String,
    download_id: String,
    remote_folder_path: String,
    folder_name: String,
    destination_dir: Option<String>,
) -> Result<String, String> {
    let clean_name = sanitize_path_segment(&folder_name);
    let dest_dir = resolve_destination(&app, destination_dir, Some(&clean_name));
    let dest_dir_str = dest_dir.to_string_lossy().into_owned();

    crate::log_info!(
        &app,
        "download",
        "Starting folder download {} for {} into {}",
        download_id,
        remote_folder_path,
        dest_dir_str
    );

    let app_clone = app.clone();
    let download_id_clone = download_id.clone();
    let dest_dir_clone = dest_dir_str.clone();

    tokio::spawn(async move {
        if let Err(e) = tokio::fs::create_dir_all(&dest_dir).await {
            let err_msg = format!("Failed to create destination directory: {}", e);
            crate::log_error!(&app_clone, "download", "{}", err_msg);
            let _ = app_clone.emit(
                "download-progress",
                DownloadProgressEvent {
                    download_id: download_id_clone,
                    total_files: 1,
                    completed_files: 0,
                    current_file: folder_name,
                    destination_path: dest_dir_clone,
                    status: "error".to_string(),
                    error: Some(err_msg),
                },
            );
            return;
        }

        let _ = app_clone.emit(
            "download-progress",
            DownloadProgressEvent {
                download_id: download_id_clone.clone(),
                total_files: 1,
                completed_files: 0,
                current_file: folder_name.clone(),
                destination_path: dest_dir_clone.clone(),
                status: "downloading".to_string(),
                error: None,
            },
        );

        let rclone = rclone_binary(&app_clone);
        let mut cmd = tokio_command(&rclone);
        cmd.arg("copy");
        if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
            cmd.args(["--config", &cfg]);
        }
        cmd.args([
            &remote_folder_path,
            &dest_dir_clone,
            "--transfers",
            "4",
            "--checkers",
            "8",
        ]);
        let output = cmd.output().await;

        match output {
            Ok(out) if out.status.success() => {
                crate::log_info!(&app_clone, "download", "Completed folder download {}", folder_name);
                let _ = app_clone.emit(
                    "download-progress",
                    DownloadProgressEvent {
                        download_id: download_id_clone,
                        total_files: 1,
                        completed_files: 1,
                        current_file: folder_name,
                        destination_path: dest_dir_clone,
                        status: "completed".to_string(),
                        error: None,
                    },
                );
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let err_msg = format!("rclone error downloading folder {}: {}", folder_name, stderr.trim());
                crate::log_error!(&app_clone, "download", "{}", err_msg);
                let _ = app_clone.emit(
                    "download-progress",
                    DownloadProgressEvent {
                        download_id: download_id_clone,
                        total_files: 1,
                        completed_files: 0,
                        current_file: folder_name,
                        destination_path: dest_dir_clone,
                        status: "error".to_string(),
                        error: Some(err_msg),
                    },
                );
            }
            Err(e) => {
                let err_msg = format!("Failed running rclone copy for folder: {}", e);
                crate::log_error!(&app_clone, "download", "{}", err_msg);
                let _ = app_clone.emit(
                    "download-progress",
                    DownloadProgressEvent {
                        download_id: download_id_clone,
                        total_files: 1,
                        completed_files: 0,
                        current_file: folder_name,
                        destination_path: dest_dir_clone,
                        status: "error".to_string(),
                        error: Some(err_msg),
                    },
                );
            }
        }
    });

    Ok(dest_dir_str)
}

/// Open the download folder in the system file manager.
#[tauri::command]
pub fn open_download_folder(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let folder = if let Some(p) = path {
        if !p.trim().is_empty() {
            PathBuf::from(p)
        } else {
            default_download_dir(&app)
        }
    } else {
        default_download_dir(&app)
    };

    // Ensure the folder exists before attempting to open
    if !folder.exists() {
        let _ = std::fs::create_dir_all(&folder);
    }

    #[cfg(target_os = "linux")]
    {
        std_command("xdg-open")
            .arg(&folder)
            .spawn()
            .map_err(|e| format!("Failed to open directory: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std_command("open")
            .arg(&folder)
            .spawn()
            .map_err(|e| format!("Failed to open directory: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std_command("explorer")
            .arg(&folder)
            .spawn()
            .map_err(|e| format!("Failed to open directory: {}", e))?;
    }

    Ok(())
}

/// Quickly check if a downloaded copy of the file already exists locally.
/// Returns Some(absolute_path) if the file exists and has size > 0.
#[tauri::command]
pub fn find_downloaded_file(
    app: AppHandle,
    subfolder: Option<String>,
    filename: String,
) -> Result<Option<String>, String> {
    let dest_dir = resolve_destination(&app, None, subfolder.as_deref());
    let clean_filename = sanitize_path_segment(&filename);
    let target = dest_dir.join(&clean_filename);
    if target.is_file() {
        if let Ok(meta) = std::fs::metadata(&target) {
            if meta.len() > 0 {
                return Ok(Some(target.to_string_lossy().into_owned()));
            }
        }
    }
    Ok(None)
}

/// Locate yt-dlp binary on the host system (checking current exe dir, winget, local app data, ~/.local/bin, /usr/local/bin, /usr/bin, or PATH)
pub fn find_yt_dlp_binary() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("yt-dlp.exe"));
            candidates.push(dir.join("yt-dlp"));
        }
    }
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        let h = PathBuf::from(&home);
        candidates.push(h.join(".local/bin/yt-dlp"));
        candidates.push(h.join(".local/bin/yt-dlp.exe"));
        candidates.push(h.join("AppData/Local/Microsoft/WinGet/Links/yt-dlp.exe"));
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let lad = PathBuf::from(&local_app_data);
        candidates.push(lad.join("Microsoft/WinGet/Links/yt-dlp.exe"));
        candidates.push(lad.join("Programs/yt-dlp/yt-dlp.exe"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/yt-dlp"));
    candidates.push(PathBuf::from("/usr/bin/yt-dlp"));

    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }

    #[cfg(target_os = "windows")]
    let lookup_cmd = "where";
    #[cfg(not(target_os = "windows"))]
    let lookup_cmd = "which";

    if let Ok(output) = std_command(lookup_cmd).arg("yt-dlp").output() {
        if output.status.success() {
            if let Some(first_line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                let p = first_line.trim();
                if !p.is_empty() {
                    let pb = PathBuf::from(p);
                    if pb.is_file() {
                        return Some(pb);
                    }
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebStreamDownloadRequest {
    pub download_id: String,
    pub stream_url: String,
    pub original_url: Option<String>,
    pub filename: String,
    pub destination_dir: Option<String>,
    pub remote_upload_path: Option<String>,
    pub config_path: Option<String>,
}

/// Downloads any web stream or HLS playlist and stitches it into a clean .mp4 using yt-dlp.
/// Optionally uploads the rebuilt .mp4 to an rclone cloud remote.
#[tauri::command]
pub async fn download_web_stream(
    app: AppHandle,
    req: WebStreamDownloadRequest,
) -> Result<String, String> {
    let yt_dlp = find_yt_dlp_binary().ok_or_else(|| {
        "yt-dlp is required for stream downloads but was not found on the system. Please install yt-dlp.".to_string()
    })?;

    let clean_name = sanitize_path_segment(&req.filename);
    let ext = clean_name.rsplit('.').next().map(|e| e.to_lowercase()).unwrap_or_default();
    let is_video = [
        "mp4", "mkv", "avi", "mov", "webm", "m4v", "ts", "m2ts", "flv", "wmv", "vob"
    ].contains(&ext.as_str());

    let mut final_name = clean_name.clone();
    if is_video && !final_name.to_lowercase().ends_with(".mp4") {
        if let Some(idx) = final_name.rfind('.') {
            final_name.truncate(idx);
        }
        final_name.push_str(".mp4");
    }

    let is_remote_upload = req.remote_upload_path.is_some();
    let local_dest_dir = if is_remote_upload {
        std::env::temp_dir().join(format!("rcloneflix_staging_{}", req.download_id))
    } else {
        resolve_destination(&app, req.destination_dir.clone(), None)
    };

    tokio::fs::create_dir_all(&local_dest_dir)
        .await
        .map_err(|e| format!("Failed to create destination folder: {}", e))?;

    let local_target_file = local_dest_dir.join(&final_name);
    let dest_dir_str = local_dest_dir.to_string_lossy().into_owned();

    let app_clone = app.clone();
    let download_id = req.download_id.clone();
    let stream_url = req.stream_url.clone();
    let original_url = req.original_url.clone();
    let remote_upload_path = req.remote_upload_path.clone();
    let config_path = req.config_path.unwrap_or_default();

    crate::log_info!(
        &app,
        "download",
        "Starting yt-dlp stream download {} ({} -> {})",
        download_id,
        stream_url,
        local_target_file.display()
    );

    let dest_dir_clone = dest_dir_str.clone();

    tokio::spawn(async move {
        // 1. Emit downloading event
        let _ = app_clone.emit(
            "download-progress",
            DownloadProgressEvent {
                download_id: download_id.clone(),
                total_files: 1,
                completed_files: 0,
                current_file: final_name.clone(),
                destination_path: dest_dir_clone.clone(),
                status: "downloading".to_string(),
                error: None,
            },
        );

        let mut download_success = false;
        let mut download_err: Option<String> = None;

        if !is_video && stream_url.starts_with("http") {
            // Direct streaming download for non-video files (books, audio, archives, photos)
            let client = reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .build()
                .unwrap_or_default();
            match client.get(&stream_url).send().await {
                Ok(mut resp) => {
                    if resp.status().is_success() {
                        match tokio::fs::File::create(&local_target_file).await {
                            Ok(mut file) => {
                                use tokio::io::AsyncWriteExt;
                                let mut ok = true;
                                while let Ok(Some(chunk)) = resp.chunk().await {
                                    if file.write_all(&chunk).await.is_err() {
                                        ok = false;
                                        break;
                                    }
                                }
                                if ok && file.flush().await.is_ok() {
                                    download_success = true;
                                } else {
                                    download_err = Some("Failed writing file chunks to disk".to_string());
                                }
                            }
                            Err(e) => {
                                download_err = Some(format!("Failed creating destination file: {}", e));
                            }
                        }
                    } else {
                        download_err = Some(format!("Server returned HTTP {}", resp.status()));
                    }
                }
                Err(e) => {
                    download_err = Some(format!("HTTP request failed: {}", e));
                }
            }
        } else {
            let mut cmd = tokio_command(&yt_dlp);
            cmd.args([
                "--no-warnings",
                "--no-playlist",
                "-o", local_target_file.to_str().unwrap_or(""),
            ]);
            if is_video {
                cmd.args([
                    "--remux-video", "mp4",
                    "--merge-output-format", "mp4",
                ]);
            }

            // Add headers if needed
            let mut referer = None;
            if let Some(ref orig) = original_url {
                if orig.contains("moviebite.org") {
                    referer = Some("https://moviebite.org/".to_string());
                } else if orig.contains("dood") {
                    referer = Some(orig.clone());
                } else if orig.contains("streamtape") {
                    referer = Some("https://streamtape.com/".to_string());
                }
            }
            if let Some(ref r) = referer {
                cmd.args(["--add-header", &format!("Referer: {}", r)]);
            }
            cmd.args([
                "--add-header",
                "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            ]);
            cmd.arg(&stream_url);

            let output = cmd.output().await;

            match output {
                Ok(out) => {
                    if out.status.success() {
                        download_success = true;
                    } else {
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        let stdout = String::from_utf8_lossy(&out.stdout);
                        download_err = Some(format!("Download failed: {} {}", stderr.trim(), stdout.trim()));
                    }
                }
                Err(e) => {
                    download_err = Some(format!("Failed to spawn download process: {}", e));
                }
            }
        }

        if download_success {
            {
                crate::log_info!(
                    &app_clone,
                    "download",
                    "Stream/file download completed successfully for {}",
                    final_name
                );

                // If remote upload is requested:
                if let Some(remote_dir) = remote_upload_path {
                    let rclone = rclone_binary(&app_clone);
                    let remote_target = format!("{}/{}", remote_dir.trim_end_matches('/'), final_name);

                    crate::log_info!(
                        &app_clone,
                        "download",
                        "Uploading rebuilt stream .mp4 to remote: {} -> {}",
                        local_target_file.display(),
                        remote_target
                    );

                    let mut cmd = tokio_command(&rclone);
                    cmd.arg("copyto");
                    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
                        cmd.args(["--config", &cfg]);
                    }
                    cmd.args([
                        local_target_file.to_str().unwrap_or(""),
                        &remote_target,
                    ]);
                    let upload_out = cmd.output().await;

                    // Clean up staging directory
                    let _ = tokio::fs::remove_dir_all(&local_dest_dir).await;

                    match upload_out {
                        Ok(up_res) if up_res.status.success() => {
                            let _ = app_clone.emit(
                                "download-progress",
                                DownloadProgressEvent {
                                    download_id: download_id.clone(),
                                    total_files: 1,
                                    completed_files: 1,
                                    current_file: final_name.clone(),
                                    destination_path: remote_target,
                                    status: "completed".to_string(),
                                    error: None,
                                },
                            );
                        }
                        Ok(up_res) => {
                            let stderr = String::from_utf8_lossy(&up_res.stderr);
                            let err_msg = format!("Failed to upload stream to remote: {}", stderr);
                            crate::log_error!(&app_clone, "download", "{}", err_msg);
                            let _ = app_clone.emit(
                                "download-progress",
                                DownloadProgressEvent {
                                    download_id: download_id.clone(),
                                    total_files: 1,
                                    completed_files: 0,
                                    current_file: final_name.clone(),
                                    destination_path: dest_dir_clone.clone(),
                                    status: "error".to_string(),
                                    error: Some(err_msg),
                                },
                            );
                        }
                        Err(e) => {
                            let err_msg = format!("Failed to spawn rclone upload: {}", e);
                            crate::log_error!(&app_clone, "download", "{}", err_msg);
                            let _ = app_clone.emit(
                                "download-progress",
                                DownloadProgressEvent {
                                    download_id: download_id.clone(),
                                    total_files: 1,
                                    completed_files: 0,
                                    current_file: final_name.clone(),
                                    destination_path: dest_dir_clone.clone(),
                                    status: "error".to_string(),
                                    error: Some(err_msg),
                                },
                            );
                        }
                    }
                } else {
                    // Local download complete
                    let _ = app_clone.emit(
                        "download-progress",
                        DownloadProgressEvent {
                            download_id: download_id.clone(),
                            total_files: 1,
                            completed_files: 1,
                            current_file: final_name.clone(),
                            destination_path: dest_dir_clone.clone(),
                            status: "completed".to_string(),
                            error: None,
                        },
                    );
                }
            }
        } else {
            let err_msg = download_err.unwrap_or_else(|| "Download failed: connection error or file not found".to_string());
            crate::log_error!(&app_clone, "download", "{}", err_msg);
            let _ = app_clone.emit(
                "download-progress",
                DownloadProgressEvent {
                    download_id: download_id.clone(),
                    total_files: 1,
                    completed_files: 0,
                    current_file: final_name.clone(),
                    destination_path: dest_dir_clone.clone(),
                    status: "error".to_string(),
                    error: Some(err_msg),
                },
            );
        }
    });

    Ok(dest_dir_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_path_segment() {
        assert_eq!(sanitize_path_segment("Breaking Bad: Season 1"), "Breaking Bad_ Season 1");
        assert_eq!(sanitize_path_segment("../dangerous/path"), "_dangerous_path");
        assert_eq!(sanitize_path_segment("  Valid Title  "), "Valid Title");
        assert_eq!(sanitize_path_segment("..."), "media");
    }

    #[test]
    fn test_find_yt_dlp_binary() {
        let bin = find_yt_dlp_binary();
        assert!(bin.is_some(), "yt-dlp binary should be found on the test environment");
    }
}
