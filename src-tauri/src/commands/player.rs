use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Child;
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use vlc::MediaPlayerAudioEx;
use crate::process_ext::{std_command, tokio_command};

/// Track descriptions surfaced to the UI. `id` is a libVLC track id, not an
/// ffprobe stream index — libVLC ids are what `libvlc_audio_set_track` and
/// `libvlc_video_set_spu` expect, and `-1` always means "disabled".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VlcTrack {
    pub id: i32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VlcTrackList {
    pub audio: Vec<VlcTrack>,
    pub subtitle: Vec<VlcTrack>,
    pub current_audio: i32,
    pub current_subtitle: i32,
}

/// Enumerate a libVLC track description linked list.
///
/// vlc-rs's own `get_audio_track_description` walks with `while !p_next.is_null()`,
/// which silently drops the final entry, so we walk the list ourselves.
unsafe fn collect_track_descriptions(
    head: *mut vlc::sys::libvlc_track_description_t,
) -> Vec<VlcTrack> {
    let mut out = Vec::new();
    let mut p = head;
    while !p.is_null() {
        let name = if (*p).psz_name.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr((*p).psz_name)
                .to_string_lossy()
                .into_owned()
        };
        out.push(VlcTrack { id: (*p).i_id, name });
        p = (*p).p_next;
    }
    if !head.is_null() {
        vlc::sys::libvlc_track_description_list_release(head);
    }
    out
}

// ── VLC thread command ────────────────────────────────────────────────────────

enum VlcCmd {
    Open { url: String, start_ms: i64 },
    Play,
    Pause,
    Stop,
    Seek(i64),      // ms
    SetVolume(i32), // 0-100
    SetAudioTrack(i32),
    SetSubtitleTrack(i32),
    /// Ask the VLC thread for the current track lists; reply on the channel.
    QueryTracks(mpsc::Sender<VlcTrackList>),
    #[cfg(target_os = "linux")]
    SetWindow(u32), // X11 drawable XID
    #[cfg(target_os = "windows")]
    SetWindow(isize), // Win32 HWND
    Shutdown,
}

// ── Managed state ─────────────────────────────────────────────────────────────

pub struct DaemonSession {
    pub port: u16,
    pub child: Child,
}

pub struct VlcManager {
    cmd_tx: Mutex<mpsc::SyncSender<VlcCmd>>,
    /// Shared daemon pool for rclone serve http, keyed by remote_root
    serve_daemons: Mutex<HashMap<String, DaemonSession>>,
    /// rclone serve http processes for epub/pdf readers, keyed by session id
    book_sessions: Mutex<HashMap<String, Child>>,
    /// Serialises daemon startup so two concurrent plays of the same remote
    /// cannot both spawn an rclone process and leak the loser.
    spawn_lock: tokio::sync::Mutex<()>,
}

impl VlcManager {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::sync_channel::<VlcCmd>(64);
        thread::spawn(move || vlc_thread(rx, app));
        VlcManager {
            cmd_tx: Mutex::new(tx),
            serve_daemons: Mutex::new(HashMap::new()),
            book_sessions: Mutex::new(HashMap::new()),
            spawn_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn send(&self, cmd: VlcCmd) -> bool {
        self.cmd_tx
            .lock()
            .map(|tx| tx.send(cmd).is_ok())
            .unwrap_or(false)
    }

    pub async fn get_or_start_serve(
        &self,
        app: &AppHandle,
        config_path: &str,
        remote_root: &str,
    ) -> Result<u16, String> {
        let clean_remote_root = remote_root.trim_end_matches('/');
        // Hold the spawn lock across the whole check-then-spawn sequence so
        // concurrent callers reuse one daemon instead of racing to create two.
        let _guard = self.spawn_lock.lock().await;

        // 1. Check if an active server process exists for remote_root.
        //    The liveness probe must happen with the std mutex released,
        //    otherwise its guard would be held across an await point.
        let existing_port = {
            let daemons = self.serve_daemons.lock().unwrap();
            daemons.get(clean_remote_root).map(|s| s.port)
        };

        if let Some(port) = existing_port {
            if is_port_open(port).await {
                return Ok(port);
            }
            let mut daemons = self.serve_daemons.lock().unwrap();
            if let Some(mut session) = daemons.remove(clean_remote_root) {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
        }

        // 2. Spawn a new server process for this remote_root
        let port = portpicker::pick_unused_port().ok_or("No available port")?;
        let rclone = rclone_binary(app);

        let is_win_drive = clean_remote_root.len() >= 2
            && clean_remote_root.as_bytes()[0].is_ascii_alphabetic()
            && clean_remote_root.as_bytes()[1] == b':';
        let is_local_dir = clean_remote_root.starts_with('/')
            || clean_remote_root.starts_with('\\')
            || is_win_drive
            || !clean_remote_root.contains(':');
        let msg = if is_local_dir {
            "Preparing local media stream…"
        } else {
            "Connecting to remote…"
        };
        let _ = app.emit(
            "rclone:status",
            serde_json::json!({ "state": "starting", "message": msg }),
        );

        let mut cmd = std_command(&rclone);
        cmd.arg("serve").arg("http");
        if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(config_path) {
            if !cfg.trim().is_empty() {
                cmd.args(["--config", &cfg]);
            }
        }
        cmd.args([
            "--addr",
            &format!("127.0.0.1:{}", port),
            "--read-only",
            "--no-checksum",
            "--no-modtime",
            "--copy-links",
            "--allow-origin",
            "*",
            "--dir-cache-time",
            "72h",
        ]);

        // Direct in-memory streaming (KNOWN_BUGS_AND_FIXES.md #92 — do NOT
        // re-add --vfs-cache-mode full: it blocks first-byte delivery behind
        // 16-64MB disk-cache chunk downloads on rate-limited remotes).
        // Small initial chunk => fast TTFB; the limit lets rclone grow the
        // request size for sustained sequential throughput.
        cmd.args(["--buffer-size", "4M"]);
        if clean_remote_root.contains(':') && !clean_remote_root.starts_with('/') {
            cmd.args([
                "--vfs-read-chunk-size", "2M",
                "--vfs-read-chunk-size-limit", "64M",
            ]);
        }

        cmd.arg(clean_remote_root);
        cmd.stderr(std::process::Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start rclone serve: {}", e))?;

        if let Err(err) = wait_for_port_with_child(port, &mut child).await {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }

        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                use std::io::{BufRead, BufReader};
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        log::debug!(target: "rclone-serve", "{}", l);
                    }
                }
            });
        }

        let _ = app.emit(
            "rclone:status",
            serde_json::json!({ "state": "ready", "message": "Stream ready" }),
        );

        {
            let mut daemons = self.serve_daemons.lock().unwrap();
            daemons.insert(clean_remote_root.to_string(), DaemonSession { port, child });
        }

        Ok(port)
    }
}

impl VlcManager {
    /// Stop playback and reap every child process. Safe to call more than once.
    pub fn shutdown_all(&self) {
        let _ = self.send(VlcCmd::Stop);
        if let Ok(mut map) = self.serve_daemons.lock() {
            for (_, mut session) in map.drain() {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
        }
        if let Ok(mut map) = self.book_sessions.lock() {
            for (_, mut c) in map.drain() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}

impl Drop for VlcManager {
    fn drop(&mut self) {
        self.shutdown_all();
        if let Ok(tx) = self.cmd_tx.lock() {
            let _ = tx.send(VlcCmd::Shutdown);
        }
    }
}

// ── VLC background thread ─────────────────────────────────────────────────────

fn vlc_thread(rx: mpsc::Receiver<VlcCmd>, app: AppHandle) {
    let instance = match vlc::Instance::new() {
        Some(i) => i,
        None => {
            let plugin_path = std::env::var("VLC_PLUGIN_PATH")
                .unwrap_or_else(|_| "<not set>".into());
            let _ = app.emit(
                "vlc:error",
                serde_json::json!({
                    "message": format!(
                        "Failed to initialize libvlc (VLC_PLUGIN_PATH={plugin_path}). \
                         On Debian/Ubuntu: sudo apt install libvlc5 vlc-plugin-base"
                    )
                }),
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

    // Allow libVLC to auto-select audio output on Linux (PulseAudio, PipeWire, ALSA)
    player.set_mute(false);
    let _ = player.set_volume(100);

    // libVLC grabs keyboard and mouse on its video window by default. Because we
    // render into the Tauri window's own X11 drawable, that grab swallows every
    // click and keypress meant for the React overlay — the back button and
    // Escape stop working and the only way out is the webview context menu.
    {
        use vlc::MediaPlayerVideoEx;
        player.set_key_input(false);
        player.set_mouse_input(false);
    }

    let mut pending_seek_ms: Option<i64> = None;
    let mut last_emitted_playing = false;
    let mut last_emitted_buffering = false;
    // Emit time updates at ~1 Hz to minimise WebKitGTK repaints (which cause flicker).
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
                        let lower_url = url.to_lowercase();
                        unsafe {
                            if lower_url.contains("phncdn.com") || lower_url.contains("pornhub.com") {
                                if let Ok(opt1) = std::ffi::CString::new(":http-referrer=https://www.pornhub.com/") {
                                    vlc::sys::libvlc_media_add_option(m.raw(), opt1.as_ptr());
                                }
                                if let Ok(opt2) = std::ffi::CString::new(":http-user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36") {
                                    vlc::sys::libvlc_media_add_option(m.raw(), opt2.as_ptr());
                                }
                            } else if lower_url.contains("trafficdeposit.com") || lower_url.contains("sxyprn.com") {
                                if let Ok(opt1) = std::ffi::CString::new(":http-referrer=https://www.sxyprn.com/") {
                                    vlc::sys::libvlc_media_add_option(m.raw(), opt1.as_ptr());
                                }
                            } else if lower_url.contains("vidmoly.") {
                                if let Ok(opt1) = std::ffi::CString::new(":http-referrer=https://vidmoly.biz/") {
                                    vlc::sys::libvlc_media_add_option(m.raw(), opt1.as_ptr());
                                }
                            }

                            if lower_url.contains(".m3u8") || lower_url.starts_with("http://") || lower_url.starts_with("https://") {
                                let caching_val = if lower_url.starts_with("http://127.0.0.1:") || lower_url.starts_with("http://localhost:") {
                                    ":network-caching=1500"
                                } else {
                                    ":network-caching=1000"
                                };
                                if let Ok(opt) = std::ffi::CString::new(caching_val) {
                                    vlc::sys::libvlc_media_add_option(m.raw(), opt.as_ptr());
                                }
                                if let Ok(opt) = std::ffi::CString::new(":http-user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36") {
                                    vlc::sys::libvlc_media_add_option(m.raw(), opt.as_ptr());
                                }
                            }
                        }

                        player.set_media(&m);
                        player.set_mute(false);
                        let _ = player.set_volume(100);
                        {
                            use vlc::MediaPlayerVideoEx;
                            player.set_key_input(false);
                            player.set_mouse_input(false);
                        }
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

            Ok(VlcCmd::SetAudioTrack(id)) => {
                // libVLC applies this to the playing media immediately.
                unsafe { vlc::sys::libvlc_audio_set_track(player.raw(), id) };
            }
            Ok(VlcCmd::SetSubtitleTrack(id)) => {
                // -1 disables subtitles.
                unsafe { vlc::sys::libvlc_video_set_spu(player.raw(), id) };
            }
            Ok(VlcCmd::QueryTracks(reply)) => {
                let mut current_audio = unsafe { vlc::sys::libvlc_audio_get_track(player.raw()) };
                let audio = unsafe {
                    collect_track_descriptions(
                        vlc::sys::libvlc_audio_get_track_description(player.raw()),
                    )
                };
                if current_audio <= 0 {
                    if let Some(first) = audio.iter().find(|t| t.id > 0) {
                        unsafe { vlc::sys::libvlc_audio_set_track(player.raw(), first.id) };
                        current_audio = first.id;
                    }
                }
                let tracks = unsafe {
                    VlcTrackList {
                        audio,
                        subtitle: collect_track_descriptions(
                            vlc::sys::libvlc_video_get_spu_description(player.raw()),
                        ),
                        current_audio,
                        current_subtitle: vlc::sys::libvlc_video_get_spu(player.raw()),
                    }
                };
                let _ = reply.send(tracks);
            }
            #[cfg(target_os = "linux")]
            Ok(VlcCmd::SetWindow(xid)) => {
                player.set_xwindow(xid);
            }
            #[cfg(target_os = "windows")]
            Ok(VlcCmd::SetWindow(hwnd)) => {
                player.set_hwnd(hwnd as *mut std::ffi::c_void);
                use vlc::MediaPlayerVideoEx;
                player.set_key_input(false);
                player.set_mouse_input(false);
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

        if is_playing && !last_emitted_playing {
            player.set_mute(false);
            if player.get_volume() <= 0 {
                let _ = player.set_volume(100);
            }
            unsafe {
                let current_audio = vlc::sys::libvlc_audio_get_track(player.raw());
                if current_audio <= 0 {
                    let desc = vlc::sys::libvlc_audio_get_track_description(player.raw());
                    let tracks = collect_track_descriptions(desc);
                    if let Some(first) = tracks.iter().find(|t| t.id > 0) {
                        vlc::sys::libvlc_audio_set_track(player.raw(), first.id);
                    }
                }
            }
        }

        if is_error {
            let _ = app.emit(
                "vlc:error",
                serde_json::json!({ "message": "VLC playback error" }),
            );
        }

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

pub fn rclone_binary(app: &AppHandle) -> PathBuf {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let bin_name = if cfg!(target_os = "windows") {
        "rclone.exe"
    } else {
        "rclone"
    };

    let sidecar = resource_dir.join(bin_name);
    if sidecar.exists() {
        return sidecar;
    }

    let flatpak_bin = PathBuf::from(format!("/app/bin/{}", bin_name));
    if flatpak_bin.exists() {
        return flatpak_bin;
    }

    if let Ok(exe_dir) = app.path().executable_dir() {
        let exe_sidecar = exe_dir.join(bin_name);
        if exe_sidecar.exists() {
            return exe_sidecar;
        }
    }

    PathBuf::from(bin_name)
}

/// Parse "remote:/sub/path" into ("remote", "/sub/path").
pub fn parse_remote_root(remote_root: &str) -> (&str, &str) {
    // On Windows, drive letters like "C:\" or "C:/" should not be split as remote name "C"
    if remote_root.len() >= 2
        && remote_root.chars().next().unwrap_or(' ').is_ascii_alphabetic()
        && remote_root.chars().nth(1) == Some(':')
        && (remote_root.len() == 2 || remote_root.chars().nth(2) == Some('/') || remote_root.chars().nth(2) == Some('\\'))
    {
        return (remote_root, "/");
    }
    if let Some(pos) = remote_root.find(':') {
        let name = &remote_root[..pos];
        let path = &remote_root[pos + 1..];
        (name, if path.is_empty() { "/" } else { path })
    } else {
        (remote_root, "/")
    }
}

/// Percent-encode a relative file path, encoding each segment but preserving '/'.
pub fn percent_encode_path(path: &str) -> String {
    const UNRESERVED: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
    
    let normalized = path.replace('\\', "/");
    normalized
        .split('/')
        .map(|seg| {
            let mut out = String::with_capacity(seg.len() * 3);
            for ch in seg.chars() {
                if ch.is_ascii() && UNRESERVED.contains(&(ch as u8)) {
                    out.push(ch);
                } else {
                    for byte in ch.encode_utf8(&mut [0; 4]).as_bytes() {
                        out.push_str(&format!("%{:02X}", byte));
                    }
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Check /proc/mounts for an active rclone FUSE mount matching the remote name.
#[cfg(target_os = "linux")]
fn find_fuse_local_path(remote_name: &str, relative_path: &str) -> Option<PathBuf> {
    let mounts = std::fs::read_to_string("/proc/mounts").ok()?;
    for line in mounts.lines() {
        let mut parts = line.split_whitespace();
        let device = parts.next()?;
        let mount_point = parts.next()?;
        let fs_type = parts.next()?;

        if !fs_type.contains("fuse") {
            continue;
        }

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

/// Non-blocking liveness probe for a loopback port.
pub async fn is_port_open(port: u16) -> bool {
    tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok()
}

/// Poll until the TCP port is accepting connections (rclone serve http is ready).
#[allow(dead_code)]
pub async fn wait_for_port(port: u16) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(25);
    while std::time::Instant::now() < deadline {
        if is_port_open(port).await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!(
        "Timed out waiting for rclone serve on port {}",
        port
    ))
}

/// Poll until the TCP port is accepting connections or child process exits.
pub async fn wait_for_port_with_child(port: u16, child: &mut Child) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(25);
    while std::time::Instant::now() < deadline {
        if is_port_open(port).await {
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            let mut err_msg = String::new();
            if let Some(mut err_reader) = child.stderr.take() {
                use std::io::Read;
                let _ = err_reader.read_to_string(&mut err_msg);
            }
            let trimmed_err = err_msg.trim();
            return Err(if trimmed_err.is_empty() {
                format!(
                    "rclone serve process exited prematurely with status: {:?}",
                    status
                )
            } else {
                format!("rclone serve error: {}", trimmed_err)
            });
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

/// Extract the Win32 window HWND from the Tauri main window (Windows only).
#[cfg(target_os = "windows")]
fn get_window_hwnd(app: &AppHandle) -> Option<isize> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let window = app.get_webview_window("main")?;
    let handle = window.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::Win32(h) => Some(h.hwnd.get()),
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
    // Get window ID before any async work
    #[cfg(target_os = "linux")]
    let window_id = get_window_xid(&app);
    #[cfg(target_os = "windows")]
    let window_id = get_window_hwnd(&app);

    // Build full relative path from remote root + file path
    let (remote_name, root_sub_path) = parse_remote_root(&remote_root);
    let full_relative = format!(
        "{}/{}",
        root_sub_path.trim_matches('/'),
        file_path.trim_start_matches('/')
    );
    let full_relative = full_relative.trim_start_matches(['/', '\\']).to_string();

    let clean_rm = remote_name.trim().trim_end_matches(':').to_lowercase();
    let url = if clean_rm == "tg-native" {
        let port = crate::commands::stream_proxy::get_or_start_proxy_server().await?;
        let encoded = percent_encode_path(&full_relative);
        format!("http://127.0.0.1:{}/webdav/{}", port, encoded)
    } else if clean_rm == "telegram-drive" || clean_rm == "telegram" {
        let reachable = tokio::time::timeout(
            std::time::Duration::from_millis(800),
            tokio::net::TcpStream::connect("127.0.0.1:8551")
        ).await.map(|r| r.is_ok()).unwrap_or(false);

        let resolved_config = crate::commands::rclone_sync::resolve_config_arg(&config_path)
            .unwrap_or_else(|| config_path.clone());
        let mut base_url = "http://127.0.0.1:8551/dav/".to_string();
        let mut found_conf_url = false;
        if let Ok(conf_text) = std::fs::read_to_string(&resolved_config) {
            let mut in_section = false;
            for line in conf_text.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('[') && trimmed.ends_with(']') {
                    in_section = trimmed.trim_matches(['[', ']']).eq_ignore_ascii_case("telegram-drive");
                } else if in_section && trimmed.starts_with("url") {
                    if let Some((_, val)) = trimmed.split_once('=') {
                        let parsed_url = val.trim().to_string();
                        if !parsed_url.is_empty() {
                            base_url = parsed_url;
                            found_conf_url = true;
                            break;
                        }
                    }
                }
            }
        }
        if !reachable || (!found_conf_url && !base_url.contains("/dav/")) {
            // Official Telegram Drive app is not running or unconfigured: fail over to RcloneFlix's
            // in-process native Telegram WebDAV proxy (same one `tg-native:` uses).
            let port = crate::commands::stream_proxy::get_or_start_proxy_server().await?;
            base_url = format!("http://127.0.0.1:{}/webdav", port);
        }
        let clean_base = base_url.trim_end_matches('/');
        let encoded = percent_encode_path(&full_relative);
        format!("{}/{}", clean_base, encoded)
    } else if clean_rm == "usenet-drive" {
        let encoded = percent_encode_path(file_path.trim_start_matches(['/', '\\']));
        format!("http://127.0.0.1:8553/dav/{}", encoded)
    } else if let Some(local_path) = find_fuse_local_path(remote_name, &full_relative) {
        local_path.to_string_lossy().into_owned()
    } else {
        // 2. Use shared daemon pool for rclone serve http
        let port = vlc.get_or_start_serve(&app, &config_path, &remote_root).await?;
        let encoded = percent_encode_path(file_path.trim_start_matches(['/', '\\']));
        format!("http://127.0.0.1:{}/{}", port, encoded)
    };

    // Tell VLC which window to render into
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    if let Some(id) = window_id {
        let _ = vlc.send(VlcCmd::SetWindow(id));
    }

    if !vlc.send(VlcCmd::Open { url, start_ms }) {
        return Err(
            "VLC is not available. Make sure libvlc5 is installed (sudo apt install libvlc5)."
                .to_string(),
        );
    }
    Ok(())
}

/// Open a local file directly in VLC without setting up an rclone HTTP stream.
#[tauri::command]
pub async fn open_local_media(
    app: AppHandle,
    vlc: State<'_, VlcManager>,
    file_path: String,
    start_ms: i64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let window_id = get_window_xid(&app);
    #[cfg(target_os = "windows")]
    let window_id = get_window_hwnd(&app);

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    if let Some(id) = window_id {
        let _ = vlc.send(VlcCmd::SetWindow(id));
    }

    if !vlc.send(VlcCmd::Open {
        url: file_path,
        start_ms,
    }) {
        return Err(
            "VLC is not available. Make sure libvlc5 is installed (sudo apt install libvlc5)."
                .to_string(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn player_play(vlc: State<'_, VlcManager>) -> Result<(), String> {
    let _ = vlc.send(VlcCmd::Play);
    Ok(())
}

#[tauri::command]
pub async fn player_pause(vlc: State<'_, VlcManager>) -> Result<(), String> {
    let _ = vlc.send(VlcCmd::Pause);
    Ok(())
}

#[tauri::command]
pub async fn player_seek(vlc: State<'_, VlcManager>, ms: i64) -> Result<(), String> {
    let _ = vlc.send(VlcCmd::Seek(ms));
    Ok(())
}

#[tauri::command]
pub async fn player_set_volume(vlc: State<'_, VlcManager>, vol: i32) -> Result<(), String> {
    let _ = vlc.send(VlcCmd::SetVolume(vol.clamp(0, 100)));
    Ok(())
}

#[tauri::command]
pub async fn player_stop(vlc: State<'_, VlcManager>) -> Result<(), String> {
    let _ = vlc.send(VlcCmd::Stop);
    Ok(())
}

#[tauri::command]
pub async fn player_set_audio_track(vlc: State<'_, VlcManager>, track_id: i32) -> Result<(), String> {
    if !vlc.send(VlcCmd::SetAudioTrack(track_id)) {
        return Err("VLC player is not available".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn player_set_subtitle_track(vlc: State<'_, VlcManager>, track_id: i32) -> Result<(), String> {
    if !vlc.send(VlcCmd::SetSubtitleTrack(track_id)) {
        return Err("VLC player is not available".to_string());
    }
    Ok(())
}

/// Ask libVLC which audio/subtitle tracks the currently playing media exposes.
/// Only meaningful while the native VLC path is in use.
#[tauri::command]
pub async fn player_get_tracks(vlc: State<'_, VlcManager>) -> Result<VlcTrackList, String> {
    let (tx, rx) = mpsc::channel();
    if !vlc.send(VlcCmd::QueryTracks(tx)) {
        return Err("VLC player is not available".to_string());
    }
    rx.recv_timeout(Duration::from_millis(2000))
        .map_err(|_| "Timed out querying VLC tracks".to_string())
}

/// Check if a remote path is currently accessible via an existing local FUSE mount.
#[tauri::command]
pub fn check_fuse_path(remote_root: String, file_path: String) -> Option<String> {
    let (remote_name, root_sub_path) = parse_remote_root(&remote_root);
    let full_relative = format!(
        "{}/{}",
        root_sub_path.trim_matches('/'),
        file_path.trim_start_matches('/')
    );
    let full_relative = full_relative.trim_start_matches('/').to_string();
    find_fuse_local_path(remote_name, &full_relative).map(|p| p.to_string_lossy().into_owned())
}

/// Start an rclone HTTP server for media streaming and return its URL.
/// Prioritizes local FUSE mount paths when available to avoid redundant cloud network overhead.
#[tauri::command]
pub async fn start_stream_session(
    app: AppHandle,
    vlc: State<'_, VlcManager>,
    config_path: String,
    remote_root: String,
    file_path: String,
    _session_id: String,
) -> Result<serde_json::Value, String> {
    // 1. Check if the file is directly available via a local FUSE mount
    let (remote_name, root_sub_path) = parse_remote_root(&remote_root);
    let full_relative = format!(
        "{}/{}",
        root_sub_path.trim_matches('/'),
        file_path.trim_start_matches('/')
    );
    let full_relative = full_relative.trim_start_matches(['/', '\\']).to_string();

    let clean_rm = remote_name.trim().trim_end_matches(':').to_lowercase();
    if clean_rm == "tg-native" {
        let port = crate::commands::stream_proxy::get_or_start_proxy_server().await?;
        let encoded = percent_encode_path(&full_relative);
        return Ok(serde_json::json!({
            "file_url": format!("http://127.0.0.1:{}/webdav/{}", port, encoded),
            "local_path": null
        }));
    } else if clean_rm == "telegram-drive" || clean_rm == "telegram" {
        let reachable = tokio::time::timeout(
            std::time::Duration::from_millis(800),
            tokio::net::TcpStream::connect("127.0.0.1:8551")
        ).await.map(|r| r.is_ok()).unwrap_or(false);

        let resolved_config = crate::commands::rclone_sync::resolve_config_arg(&config_path)
            .unwrap_or_else(|| config_path.clone());
        let mut base_url = "http://127.0.0.1:8551/dav/".to_string();
        let mut found_conf_url = false;
        if let Ok(conf_text) = std::fs::read_to_string(&resolved_config) {
            let mut in_section = false;
            for line in conf_text.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('[') && trimmed.ends_with(']') {
                    in_section = trimmed.trim_matches(['[', ']']).eq_ignore_ascii_case("telegram-drive");
                } else if in_section && trimmed.starts_with("url") {
                    if let Some((_, val)) = trimmed.split_once('=') {
                        let parsed_url = val.trim().to_string();
                        if !parsed_url.is_empty() {
                            base_url = parsed_url;
                            found_conf_url = true;
                            break;
                        }
                    }
                }
            }
        }
        if !reachable || (!found_conf_url && !base_url.contains("/dav/")) {
            // Official Telegram Drive app is not running or unconfigured: fail over to RcloneFlix's
            // in-process native Telegram WebDAV proxy (same one `tg-native:` uses).
            let port = crate::commands::stream_proxy::get_or_start_proxy_server().await?;
            base_url = format!("http://127.0.0.1:{}/webdav", port);
        }
        let clean_base = base_url.trim_end_matches('/');
        let encoded = percent_encode_path(&full_relative);
        return Ok(serde_json::json!({
            "file_url": format!("{}/{}", clean_base, encoded),
            "local_path": null
        }));
    } else if clean_rm == "usenet-drive" {
        let encoded = percent_encode_path(&full_relative);
        return Ok(serde_json::json!({
            "file_url": format!("http://127.0.0.1:8553/dav/{}", encoded),
            "local_path": null
        }));
    }

    if let Some(local_path) = find_fuse_local_path(remote_name, &full_relative) {
        if let Some(parent) = local_path.parent() {
            let parent_dir = parent.to_string_lossy().into_owned();
            let filename = local_path
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !filename.is_empty() {
                let port = vlc.get_or_start_serve(&app, "", &parent_dir).await?;
                let encoded = percent_encode_path(&filename);
                let file_url = format!("http://127.0.0.1:{}/{}", port, encoded);
                return Ok(serde_json::json!({
                    "file_url": file_url,
                    "local_path": local_path.to_string_lossy()
                }));
            }
        }
    }

    // 2. Fallback to shared daemon pool for rclone serve http on remote
    let port = vlc.get_or_start_serve(&app, &config_path, &remote_root).await?;
    let encoded = percent_encode_path(file_path.trim_start_matches(['/', '\\']));
    let file_url = format!("http://127.0.0.1:{}/{}", port, encoded);
    Ok(serde_json::json!({ "file_url": file_url, "local_path": null }))
}

/// Start an HTTP stream server for a local file so WebKitGTK / HTML5 player
/// can stream it with HTTP Range support.
#[tauri::command]
pub async fn start_local_file_stream(
    app: AppHandle,
    vlc: State<'_, VlcManager>,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(format!("Local file does not exist: {}", file_path));
    }

    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent_dir = canonical
        .parent()
        .ok_or_else(|| "No parent directory for file".to_string())?
        .to_string_lossy()
        .into_owned();
    #[cfg(target_os = "windows")]
    let parent_dir = parent_dir
        .strip_prefix(r"\\?\")
        .unwrap_or(&parent_dir)
        .to_string();

    let filename = canonical
        .file_name()
        .ok_or_else(|| "No filename".to_string())?
        .to_string_lossy()
        .into_owned();

    let port = vlc.get_or_start_serve(&app, "", &parent_dir).await?;
    let encoded_file = percent_encode_path(&filename);
    let file_url = format!("http://127.0.0.1:{}/{}", port, encoded_file);

    Ok(serde_json::json!({ "file_url": file_url }))
}

/// Stop a book (epub/pdf) stream session by its session id.
#[tauri::command]
pub async fn stop_stream_session(
    vlc: State<'_, VlcManager>,
    session_id: Option<String>,
) -> Result<(), String> {
    if let Some(sid) = session_id {
        let mut map = vlc.book_sessions.lock().unwrap();
        if let Some(mut child) = map.remove(&sid) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_all_sessions(vlc: State<'_, VlcManager>) -> Result<(), String> {
    let _ = vlc.send(VlcCmd::Stop);
    if let Ok(mut daemons) = vlc.serve_daemons.lock() {
        for (_, mut session) in daemons.drain() {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }
    if let Ok(mut map) = vlc.book_sessions.lock() {
        for (_, mut c) in map.drain() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
    Ok(())
}

// ── Book download (epub / pdf) ────────────────────────────────────────────────

/// Strip anything that could escape the temp directory. Returns None when the
/// input has no usable characters left.
fn sanitize_path_component(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ' | ',' | '(' | ')' | '[' | ']'))
        .collect();
    let cleaned = cleaned.trim_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Strictly sanitize session_id to alphanumeric characters, hyphens, and underscores.
fn sanitize_session_id(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Read a local file directly into memory as a binary IPC response.
#[tauri::command]
pub async fn read_binary_file(file_path: String) -> Result<tauri::ipc::Response, String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("Failed to read file {}: {}", file_path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn download_book_to_temp(
    app: AppHandle,
    config_path: String,
    remote_path: String,
    session_id: String,
) -> Result<String, String> {
    let raw_filename = remote_path
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty() && !s.ends_with(':'))
        .unwrap_or("book");
    let filename = sanitize_path_component(raw_filename).unwrap_or_else(|| "book".to_string());
    let session_dir = sanitize_session_id(&session_id)
        .ok_or_else(|| "Invalid session id".to_string())?;

    let temp_dir = std::env::temp_dir()
        .join("rcloneflix-books")
        .join(&session_dir);
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let local_path = temp_dir.join(&filename);
    if local_path.exists() && local_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(local_path.to_string_lossy().into_owned());
    }

    if remote_path.starts_with("http://") || remote_path.starts_with("https://") {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(90))
            .redirect(reqwest::redirect::Policy::limited(10))
            .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;
        let resp = client.get(&remote_path)
            .send()
            .await
            .map_err(|e| format!("Failed to download book from URL: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("Book download failed with HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("Failed to read book bytes: {}", e))?;
        std::fs::write(&local_path, &bytes).map_err(|e| format!("Failed to write book file: {}", e))?;
        return Ok(local_path.to_string_lossy().into_owned());
    }

    let rclone = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone);
    cmd.arg("copyto");
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.args([
        &remote_path,
        local_path.to_str().unwrap_or(""),
    ]);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("rclone copyto failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rclone copyto error: {}", stderr));
    }

    Ok(local_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn cleanup_book_temp(session_id: String) {
    let Some(clean_id) = sanitize_session_id(&session_id) else {
        return;
    };
    let temp_dir = std::env::temp_dir()
        .join("rcloneflix-books")
        .join(&clean_id);
    if temp_dir.exists() {
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}

// ── Media info (ffprobe) ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_media_info(file_url: String) -> Result<serde_json::Value, String> {
    // ffprobe against a remote stream can stall indefinitely — cap probe window to 1800ms
    // and limit analyzeduration/probesize to keep stream inspection instantaneous.
    let probe_future = tokio_command("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-probesize",
            "5000000",
            "-analyzeduration",
            "3000000",
            &file_url,
        ])
        .output();

    let output = match tokio::time::timeout(Duration::from_millis(1800), probe_future).await {
        Ok(res) => res,
        Err(_) => {
            // Probe timed out: immediately fallback to empty so playback never blocks
            return Ok(serde_json::json!({ "streams": [], "timed_out": true }));
        }
    };

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            serde_json::from_str(&stdout)
                .map_err(|e| format!("Failed to parse ffprobe output: {}", e))
        }
        _ => Ok(serde_json::json!({ "streams": [] })),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioChapter {
    pub id: i64,
    pub start: f64,
    pub end: f64,
    pub title: String,
}

#[tauri::command]
pub async fn get_audio_chapters(file_url: String) -> Result<Vec<AudioChapter>, String> {
    let probe_future = tokio_command("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_chapters",
            "-probesize",
            "1000000",
            "-analyzeduration",
            "1000000",
            &file_url,
        ])
        .output();

    let output = match tokio::time::timeout(Duration::from_millis(2500), probe_future).await {
        Ok(res) => res,
        Err(_) => return Ok(Vec::new()),
    };

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let val: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_default();
            let mut chapters = Vec::new();

            if let Some(list) = val.get("chapters").and_then(|v| v.as_array()) {
                for (idx, ch) in list.iter().enumerate() {
                    let id = ch.get("id").and_then(|v| v.as_i64()).unwrap_or(idx as i64);
                    let start = ch
                        .get("start_time")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse::<f64>().ok())
                        .or_else(|| ch.get("start").and_then(|v| v.as_f64()))
                        .unwrap_or(0.0);
                    let end = ch
                        .get("end_time")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse::<f64>().ok())
                        .or_else(|| ch.get("end").and_then(|v| v.as_f64()))
                        .unwrap_or(0.0);

                    let title = ch
                        .get("tags")
                        .and_then(|t| t.get("title"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(&format!("Chapter {}", idx + 1))
                        .to_string();

                    chapters.push(AudioChapter {
                        id,
                        start,
                        end,
                        title,
                    });
                }
            }
            Ok(chapters)
        }
        _ => Ok(Vec::new()),
    }
}

#[tauri::command]
pub async fn detect_audio_silences(
    file_url: String,
    min_duration_sec: Option<f64>,
    noise_db: Option<f64>,
) -> Result<Vec<f64>, String> {
    let dur = min_duration_sec.unwrap_or(1.5);
    let db = noise_db.unwrap_or(-30.0);
    let filter = format!("silencedetect=noise={}dB:d={}", db, dur);

    let child = tokio_command("ffmpeg")
        .args([
            "-i",
            &file_url,
            "-af",
            &filter,
            "-f",
            "null",
            "-",
        ])
        .output();

    let output = match tokio::time::timeout(Duration::from_secs(60), child).await {
        Ok(res) => res.map_err(|e| format!("Failed to run ffmpeg: {}", e))?,
        Err(_) => return Err("Silence detection timed out".to_string()),
    };

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut silences = Vec::new();
    let re = regex::Regex::new(r"silence_end:\s*([0-9.]+)").map_err(|e| e.to_string())?;

    for cap in re.captures_iter(&stderr) {
        if let Some(m) = cap.get(1) {
            if let Ok(sec) = m.as_str().parse::<f64>() {
                silences.push(sec);
            }
        }
    }

    Ok(silences)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChapterInput {
    pub start: f64,
    pub end: f64,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalAudiobookConvertRequest {
    pub input_files: Vec<String>,
    pub chapters: Vec<ChapterInput>,
    pub output_path: String,
    pub title: String,
    pub author: Option<String>,
    pub cover_image: Option<String>,
    pub bitrate: Option<String>,
}

#[tauri::command]
pub async fn convert_audiobook_m4b_local(
    req: LocalAudiobookConvertRequest,
) -> Result<String, String> {
    if req.input_files.is_empty() {
        return Err("No input files provided".to_string());
    }

    let temp_dir = std::env::temp_dir().join(format!("rcloneflix_m4b_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()));
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // 1. Generate FFMETADATA file
    let mut metadata_content = String::from(";FFMETADATA1\n");
    metadata_content.push_str(&format!("title={}\n", req.title));
    metadata_content.push_str(&format!("album={}\n", req.title));
    if let Some(auth) = &req.author {
        metadata_content.push_str(&format!("artist={}\n", auth));
        metadata_content.push_str(&format!("album_artist={}\n", auth));
    }

    for ch in &req.chapters {
        let start_ms = (ch.start * 1000.0).round() as i64;
        let end_ms = (ch.end * 1000.0).round() as i64;
        metadata_content.push_str("\n[CHAPTER]\nTIMEBASE=1/1000\n");
        metadata_content.push_str(&format!("START={}\n", start_ms));
        metadata_content.push_str(&format!("END={}\n", end_ms));
        metadata_content.push_str(&format!("title={}\n", ch.title));
    }

    let metadata_path = temp_dir.join("metadata.txt");
    std::fs::write(&metadata_path, metadata_content)
        .map_err(|e| format!("Failed to write metadata file: {}", e))?;

    let mut args: Vec<String> = Vec::new();
    args.extend(["-protocol_whitelist".into(), "file,http,https,tcp,tls,crypto,data".into()]);

    // 2. Concat list or single input
    let concat_file = temp_dir.join("concat.txt");
    if req.input_files.len() > 1 {
        let mut concat_content = String::new();
        for file in &req.input_files {
            let escaped = file.replace('\'', "'\\''");
            concat_content.push_str(&format!("file '{}'\n", escaped));
        }
        std::fs::write(&concat_file, concat_content)
            .map_err(|e| format!("Failed to write concat file: {}", e))?;

        args.extend(["-f".into(), "concat".into(), "-safe".into(), "0".into(), "-i".into(), concat_file.to_string_lossy().into()]);
    } else {
        args.extend(["-i".into(), req.input_files[0].clone()]);
    }

    args.extend(["-i".into(), metadata_path.to_string_lossy().into()]);

    let br = req.bitrate.as_deref().unwrap_or("64k");
    let has_cover = req.cover_image.as_ref().map(|c| !c.trim().is_empty()).unwrap_or(false);
    if has_cover {
        args.extend(["-i".into(), req.cover_image.clone().unwrap()]);
        args.extend([
            "-map".into(), "0:a".into(),
            "-map".into(), "2:v".into(),
            "-map_metadata".into(), "1".into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), br.into(),
            "-c:v".into(), "copy".into(),
            "-disposition:v:0".into(), "attached_pic".into(),
        ]);
    } else {
        args.extend([
            "-map".into(), "0:a".into(),
            "-map_metadata".into(), "1".into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), br.into(),
        ]);
    }

    // Ensure output ends with .m4b
    let mut out_path = req.output_path.clone();
    if !out_path.to_lowercase().ends_with(".m4b") {
        out_path = format!("{}.m4b", out_path);
    }

    if let Some(parent) = std::path::Path::new(&out_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    args.extend(["-f".into(), "ipod".into(), "-y".into(), out_path.clone()]);

    let output = tokio_command("ffmpeg")
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("Failed to launch ffmpeg: {}", e))?;

    let _ = std::fs::remove_dir_all(&temp_dir);

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg failed: {}", err));
    }

    Ok(out_path)
}

/// Check if ffmpeg is available on the local host
#[tauri::command]
pub async fn check_ffmpeg_installed() -> Result<bool, String> {
    let output = tokio_command("ffmpeg")
        .arg("-version")
        .output()
        .await;
    Ok(output.map(|o| o.status.success()).unwrap_or(false))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalTranscodeRequest {
    pub input_path: String,
    pub output_path: String,
    pub codec: Option<String>,
    pub crf: Option<u32>,
    pub preset: Option<u32>,
    pub max_height: Option<u32>,
}

/// Transcode a local video file headlessly using local FFmpeg
#[tauri::command]
pub async fn local_transcode_video(
    _app: AppHandle,
    req: LocalTranscodeRequest,
) -> Result<String, String> {
    if let Some(parent) = std::path::Path::new(&req.output_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut cmd = tokio_command("ffmpeg");
    cmd.args(["-y", "-i", &req.input_path]);

    if let Some(h) = req.max_height {
        cmd.args(["-vf", &format!("scale=-2:'min({},ih)'", h)]);
    }

    let codec = req.codec.as_deref().unwrap_or("libx264");
    cmd.args(["-c:v", codec]);

    if let Some(crf) = req.crf {
        cmd.args(["-crf", &crf.to_string()]);
    }
    if let Some(preset) = req.preset {
        cmd.args(["-preset", &preset.to_string()]);
    }

    cmd.args(["-c:a", "aac", "-b:a", "192k", &req.output_path]);

    let output = cmd.output().await.map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg failed: {}", err.lines().last().unwrap_or("Unknown error")));
    }
    Ok(req.output_path)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_remote_and_path() {
        assert_eq!(parse_remote_root("gdrive:/Movies"), ("gdrive", "/Movies"));
        assert_eq!(parse_remote_root("gdrive:"), ("gdrive", "/"));
        assert_eq!(parse_remote_root("gdrive:Movies/Sub"), ("gdrive", "Movies/Sub"));
        assert_eq!(parse_remote_root("nocolon"), ("nocolon", "/"));
    }

    #[test]
    fn percent_encodes_segments_but_keeps_separators() {
        assert_eq!(percent_encode_path("a/b.mkv"), "a/b.mkv");
        assert_eq!(percent_encode_path("The Guardians.m4b"), "The%20Guardians.m4b");
        assert_eq!(percent_encode_path("Show/S01 E02.mkv"), "Show/S01%20E02.mkv");
        // Non-ASCII must round-trip as UTF-8 bytes.
        assert_eq!(percent_encode_path("Amélie.mkv"), "Am%C3%A9lie.mkv");
        // '#' and '?' would otherwise truncate the URL.
        assert_eq!(percent_encode_path("a#b?c.mkv"), "a%23b%3Fc.mkv");
    }

    #[test]
    fn sanitises_path_components() {
        assert_eq!(sanitize_path_component("epub-1234"), Some("epub-1234".into()));
        // Traversal attempts must not survive.
        assert_eq!(sanitize_path_component("../../etc"), Some("etc".into()));
        assert_eq!(sanitize_path_component("..").is_none(), true);
        assert_eq!(sanitize_path_component("/"), None);
        assert_eq!(sanitize_path_component(""), None);
        let cleaned = sanitize_path_component("a/../../b").unwrap();
        assert!(!cleaned.contains('/'), "separators must be stripped: {cleaned}");
    }
}
