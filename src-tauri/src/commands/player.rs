use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use vlc::MediaPlayerAudioEx;

// ── VLC thread command ────────────────────────────────────────────────────────

enum VlcCmd {
    Open { url: String, start_ms: i64 },
    Play,
    Pause,
    Stop,
    Seek(i64),      // ms
    SetVolume(i32), // 0-100
    #[cfg(target_os = "linux")]
    SetWindow(u32), // X11 drawable XID
    Shutdown,
}

// ── Managed state ─────────────────────────────────────────────────────────────

pub struct VlcManager {
    cmd_tx: Mutex<mpsc::SyncSender<VlcCmd>>,
    /// rclone serve http child process, present only when FUSE mount wasn't found
    serve_child: Mutex<Option<Child>>,
}

impl VlcManager {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::sync_channel::<VlcCmd>(64);
        thread::spawn(move || vlc_thread(rx, app));
        VlcManager {
            cmd_tx: Mutex::new(tx),
            serve_child: Mutex::new(None),
        }
    }

    fn send(&self, cmd: VlcCmd) {
        if let Ok(tx) = self.cmd_tx.lock() {
            let _ = tx.send(cmd);
        }
    }
}

impl Drop for VlcManager {
    fn drop(&mut self) {
        if let Ok(tx) = self.cmd_tx.lock() {
            let _ = tx.send(VlcCmd::Shutdown);
        }
        if let Ok(mut guard) = self.serve_child.lock() {
            if let Some(mut c) = guard.take() {
                let _ = c.kill();
            }
        }
    }
}

// ── VLC background thread ─────────────────────────────────────────────────────

fn vlc_thread(rx: mpsc::Receiver<VlcCmd>, app: AppHandle) {
    let instance = match vlc::Instance::new() {
        Some(i) => i,
        None => {
            let _ = app.emit(
                "vlc:error",
                serde_json::json!({ "message": "Failed to initialize libvlc. Is VLC installed?" }),
            );
            return;
        }
    };

    let player = match vlc::MediaPlayer::new(&instance) {
        Some(p) => p,
        None => {
            let _ = app.emit(
                "vlc:error",
                serde_json::json!({ "message": "Failed to create VLC media player" }),
            );
            return;
        }
    };

    let mut pending_seek_ms: Option<i64> = None;
    let mut last_emitted_playing = false;
    let mut last_emitted_buffering = false;
    // Emit time updates at ~1 Hz to minimise WebKitGTK repaints (which cause flicker).
    // The poll loop itself stays at 100 ms so commands feel responsive.
    let mut time_tick: u8 = 0;

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(VlcCmd::Open { url, start_ms }) => {
                player.stop();
                pending_seek_ms = None;

                let media = if url.starts_with("http://") || url.starts_with("https://") {
                    vlc::Media::new_location(&instance, &url)
                } else {
                    vlc::Media::new_path(&instance, &url)
                };

                match media {
                    Some(m) => {
                        player.set_media(&m);
                        if let Err(_) = player.play() {
                            let _ = app.emit(
                                "vlc:error",
                                serde_json::json!({ "message": "Failed to start playback" }),
                            );
                        }
                        if start_ms > 5000 {
                            pending_seek_ms = Some(start_ms);
                        }
                    }
                    None => {
                        let _ = app.emit(
                            "vlc:error",
                            serde_json::json!({ "message": "Failed to open media source" }),
                        );
                    }
                }
            }

            Ok(VlcCmd::Play) => {
                let _ = player.play();
            }
            Ok(VlcCmd::Pause) => {
                player.set_pause(true);
            }
            Ok(VlcCmd::Stop) => {
                player.stop();
                pending_seek_ms = None;
            }
            Ok(VlcCmd::Seek(ms)) => {
                player.set_time(ms);
            }
            Ok(VlcCmd::SetVolume(vol)) => {
                let _ = player.set_volume(vol);
            }

            #[cfg(target_os = "linux")]
            Ok(VlcCmd::SetWindow(xid)) => {
                player.set_xwindow(xid);
            }

            Ok(VlcCmd::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        // Seek to resume position once VLC has started playing
        if let Some(seek_ms) = pending_seek_ms {
            if player.state() == vlc::State::Playing {
                player.set_time(seek_ms);
                pending_seek_ms = None;
            }
        }

        // Emit state events
        let state = player.state();
        let is_playing = state == vlc::State::Playing;
        let is_buffering = matches!(state, vlc::State::Opening | vlc::State::Buffering);
        let is_ended = state == vlc::State::Ended;
        let is_error = state == vlc::State::Error;

        if is_error {
            let _ = app.emit(
                "vlc:error",
                serde_json::json!({ "message": "VLC playback error" }),
            );
        }

        // Only emit state when it actually changes — avoids redundant repaints
        if is_ended {
            let _ = app.emit(
                "vlc:state",
                serde_json::json!({ "playing": false, "buffering": false, "ended": true }),
            );
            last_emitted_playing = false;
            last_emitted_buffering = false;
        } else if is_playing != last_emitted_playing || is_buffering != last_emitted_buffering {
            let _ = app.emit(
                "vlc:state",
                serde_json::json!({
                    "playing": is_playing,
                    "buffering": is_buffering,
                    "ended": false,
                }),
            );
            last_emitted_playing = is_playing;
            last_emitted_buffering = is_buffering;
        }

        // Emit time once per second (every 10th poll at 100 ms cadence).
        // Keeping this at 1 Hz prevents constant WebKitGTK repaints that cause video flicker.
        if is_playing {
            time_tick = time_tick.wrapping_add(1);
            if time_tick >= 10 {
                time_tick = 0;
                let time_ms = player.get_time().unwrap_or(0);
                let duration_ms = player
                    .get_media()
                    .and_then(|m| m.duration())
                    .unwrap_or(0);
                let _ = app.emit(
                    "vlc:time",
                    serde_json::json!({ "time_ms": time_ms, "duration_ms": duration_ms }),
                );
            }
        } else {
            time_tick = 0;
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn rclone_binary(app: &AppHandle) -> PathBuf {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let s = resource_dir.join("rclone");
    if s.exists() { s } else { PathBuf::from("rclone") }
}

/// Parse "remote:/sub/path" into ("remote", "/sub/path").
fn parse_remote_root(remote_root: &str) -> (&str, &str) {
    if let Some(pos) = remote_root.find(':') {
        let name = &remote_root[..pos];
        let path = &remote_root[pos + 1..];
        (name, if path.is_empty() { "/" } else { path })
    } else {
        (remote_root, "/")
    }
}

/// Percent-encode a relative file path, encoding each segment but preserving '/'.
fn percent_encode_path(path: &str) -> String {
    path.split('/')
        .map(|seg| {
            let mut out = String::with_capacity(seg.len());
            for byte in seg.bytes() {
                match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
                    | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
                    _ => out.push_str(&format!("%{:02X}", byte)),
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Check /proc/mounts for an active rclone FUSE mount matching the remote name.
/// If found and the file exists locally, returns the local path.
#[cfg(target_os = "linux")]
fn find_fuse_local_path(remote_name: &str, relative_path: &str) -> Option<PathBuf> {
    let mounts = std::fs::read_to_string("/proc/mounts").ok()?;
    for line in mounts.lines() {
        let mut parts = line.split_whitespace();
        let device = parts.next()?;
        let mount_point = parts.next()?;
        let fs_type = parts.next()?;

        // rclone FUSE mounts appear as fuse.rclone (or just fuse on older kernels)
        if !fs_type.contains("fuse") {
            continue;
        }

        // Device field is typically "remote_name:" for rclone mounts
        let device_name = device.trim_end_matches(':');
        if !device_name.eq_ignore_ascii_case(remote_name) {
            continue;
        }

        let local = PathBuf::from(mount_point).join(relative_path.trim_start_matches('/'));
        if local.exists() {
            return Some(local);
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn find_fuse_local_path(_remote_name: &str, _relative_path: &str) -> Option<PathBuf> {
    None
}

/// Poll until the TCP port is accepting connections (rclone serve http is ready).
async fn wait_for_port(port: u16) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!(
        "Timed out waiting for rclone serve on port {}",
        port
    ))
}

/// Extract the X11 window XID from the Tauri main window (Linux only).
#[cfg(target_os = "linux")]
fn get_window_xid(app: &AppHandle) -> Option<u32> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let window = app.get_webview_window("main")?;
    let handle = window.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::Xlib(h) => Some(h.window as u32),
        RawWindowHandle::Xcb(h) => Some(h.window.get()),
        _ => None,
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Resolve stream source (FUSE mount → local path, or rclone serve http → URL)
/// then start VLC playback.
#[tauri::command]
pub async fn open_media(
    app: AppHandle,
    vlc: State<'_, VlcManager>,
    config_path: String,
    remote_root: String, // e.g. "gdrive:/Movies"
    file_path: String,   // relative path within remote_root
    start_ms: i64,       // resume position in milliseconds
) -> Result<(), String> {
    // Kill any existing rclone serve process first
    {
        let mut guard = vlc.serve_child.lock().unwrap();
        if let Some(mut c) = guard.take() {
            let _ = c.kill();
        }
    }

    // Get window XID before any async work (borrows are short-lived)
    #[cfg(target_os = "linux")]
    let xid = get_window_xid(&app);

    // Build the full relative path from remote root + file path
    let (remote_name, root_sub_path) = parse_remote_root(&remote_root);
    let full_relative = format!(
        "{}/{}",
        root_sub_path.trim_matches('/'),
        file_path.trim_start_matches('/')
    );
    let full_relative = full_relative.trim_start_matches('/').to_string();

    // 1. Try FUSE mount (zero-overhead, full seeking support)
    let url = if let Some(local_path) = find_fuse_local_path(remote_name, &full_relative) {
        local_path.to_string_lossy().into_owned()
    } else {
        // 2. Fall back to rclone serve http
        let port = portpicker::pick_unused_port().ok_or("No available port")?;
        let rclone = rclone_binary(&app);

        let child = Command::new(&rclone)
            .args([
                "serve",
                "http",
                "--config",
                &config_path,
                "--addr",
                &format!("127.0.0.1:{}", port),
                "--read-only",
                "--no-checksum",
                &remote_root,
            ])
            .spawn()
            .map_err(|e| format!("Failed to start rclone serve: {}", e))?;

        // Wait until rclone's HTTP server is accepting connections
        wait_for_port(port).await?;

        {
            let mut guard = vlc.serve_child.lock().unwrap();
            *guard = Some(child);
        }

        let encoded = percent_encode_path(&full_relative);
        format!("http://127.0.0.1:{}/{}", port, encoded)
    };

    // Tell VLC which X11 window to render into (must be sent before Open)
    #[cfg(target_os = "linux")]
    if let Some(xid) = xid {
        vlc.send(VlcCmd::SetWindow(xid));
    }

    vlc.send(VlcCmd::Open { url, start_ms });
    Ok(())
}

#[tauri::command]
pub async fn player_play(vlc: State<'_, VlcManager>) -> Result<(), String> {
    vlc.send(VlcCmd::Play);
    Ok(())
}

#[tauri::command]
pub async fn player_pause(vlc: State<'_, VlcManager>) -> Result<(), String> {
    vlc.send(VlcCmd::Pause);
    Ok(())
}

#[tauri::command]
pub async fn player_seek(vlc: State<'_, VlcManager>, ms: i64) -> Result<(), String> {
    vlc.send(VlcCmd::Seek(ms));
    Ok(())
}

/// vol is 0-100 (maps to VLC's 0-100 normal range)
#[tauri::command]
pub async fn player_set_volume(vlc: State<'_, VlcManager>, vol: i32) -> Result<(), String> {
    vlc.send(VlcCmd::SetVolume(vol.clamp(0, 100)));
    Ok(())
}

#[tauri::command]
pub async fn player_stop(vlc: State<'_, VlcManager>) -> Result<(), String> {
    vlc.send(VlcCmd::Stop);
    let mut guard = vlc.serve_child.lock().unwrap();
    if let Some(mut c) = guard.take() {
        let _ = c.kill();
    }
    Ok(())
}

/// Kept as alias so any callers using the old name still compile.
#[tauri::command]
pub async fn stop_stream_session(vlc: State<'_, VlcManager>) -> Result<(), String> {
    player_stop(vlc).await
}

#[tauri::command]
pub async fn stop_all_sessions(vlc: State<'_, VlcManager>) -> Result<(), String> {
    player_stop(vlc).await
}

// ── Legacy media info (ffprobe) ───────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct SubtitleTrack {
    pub index: u32,
    pub language: Option<String>,
    pub title: Option<String>,
}

#[tauri::command]
pub async fn get_media_info(file_url: String) -> Result<serde_json::Value, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            &file_url,
        ])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            serde_json::from_str(&stdout)
                .map_err(|e| format!("Failed to parse ffprobe output: {}", e))
        }
        _ => Ok(serde_json::json!({ "streams": [] })),
    }
}
