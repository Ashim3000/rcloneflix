use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::copy_bidirectional;
use tokio::net::TcpStream as TokioTcpStream;

static CAST_RELAY: OnceLock<Mutex<Option<u16>>> = OnceLock::new();

/// Starts a 0.0.0.0-bound TCP relay that forwards raw bytes to a loopback port,
/// so Chromecast devices on the LAN can reach streams served on 127.0.0.1.
fn ensure_cast_relay(local_port: u16) -> Result<u16, String> {
    let lock = CAST_RELAY.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().map_err(|e| e.to_string())?;
    let std_listener = std::net::TcpListener::bind("0.0.0.0:0")
        .map_err(|e| format!("Cast relay bind failed: {e}"))?;
    std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let relay_port = std_listener.local_addr().map_err(|e| e.to_string())?.port();

    tauri::async_runtime::spawn(async move {
        if let Ok(listener) = tokio::net::TcpListener::from_std(std_listener) {
            loop {
                match listener.accept().await {
                    Ok((mut inbound, _)) => {
                        tokio::spawn(async move {
                            if let Ok(mut outbound) = TokioTcpStream::connect(("127.0.0.1", local_port)).await {
                                let _ = copy_bidirectional(&mut inbound, &mut outbound).await;
                            }
                        });
                    }
                    Err(_) => break,
                }
            }
        }
    });
    *guard = Some(relay_port);
    Ok(relay_port)
}

use rust_cast::CastDevice as RustCastDevice;
use rust_cast::channels::receiver::{CastDeviceApp, Volume};
use rust_cast::channels::media::{
    GenericMediaMetadata, Image, LoadOptions, Media, Metadata, PlayerState, StreamType,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastDevice {
    pub id: String,
    pub name: String,
    pub model: String,
    pub ip: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastStatus {
    pub connected: bool,
    pub device_name: Option<String>,
    pub device_ip: Option<String>,
    pub player_state: String, // "IDLE" | "PLAYING" | "PAUSED" | "BUFFERING"
    pub current_time: f64,
    pub duration: f64,
    pub volume: f32,
    pub title: Option<String>,
}

impl Default for CastStatus {
    fn default() -> Self {
        Self {
            connected: false,
            device_name: None,
            device_ip: None,
            player_state: "IDLE".to_string(),
            current_time: 0.0,
            duration: 0.0,
            volume: 1.0,
            title: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastMediaRequest {
    pub stream_url: String,
    pub title: String,
    pub content_type: Option<String>,
    pub poster_url: Option<String>,
    pub current_time: Option<f64>,
}

enum CastCommand {
    Connect {
        ip: String,
        port: u16,
        name: Option<String>,
        reply: std::sync::mpsc::Sender<Result<CastStatus, String>>,
    },
    Disconnect {
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    Load {
        req: CastMediaRequest,
        reply: std::sync::mpsc::Sender<Result<CastStatus, String>>,
    },
    Play {
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    Pause {
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    Seek {
        time_sec: f64,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    Stop {
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    SetVolume {
        level: f32,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    GetStatus {
        reply: std::sync::mpsc::Sender<CastStatus>,
    },
}

pub struct CastManager {
    sender: std::sync::mpsc::Sender<CastCommand>,
    _cached_status: Arc<Mutex<CastStatus>>,
}

impl CastManager {
    pub fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<CastCommand>();
        let cached_status = Arc::new(Mutex::new(CastStatus::default()));
        let cached_status_clone = Arc::clone(&cached_status);

        // Spawn a background thread to manage the blocking TLS connection to the Chromecast
        thread::spawn(move || {
            let mut active_device: Option<RustCastDevice<'static>> = None;
            let mut current_status = CastStatus::default();
            let mut transport_id: Option<String> = None;
            let mut _session_id: Option<String> = None;
            let mut media_session_id: Option<i32> = None;

            loop {
                // Heartbeat ping interval: 5 seconds
                match rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(cmd) => match cmd {
                        CastCommand::Connect { ip, port, name, reply } => {
                            log::info!("[cast] Connecting to Cast device at {}:{}...", ip, port);
                            match RustCastDevice::connect_without_host_verification(ip.clone(), port) {
                                Ok(device) => {
                                    // Connect connection channel
                                    if let Err(e) = device.connection.connect("receiver-0") {
                                        log::warn!("[cast] Connection channel handshake warning: {:?}", e);
                                    }

                                    active_device = Some(device);
                                    current_status.connected = true;
                                    current_status.device_ip = Some(ip.clone());
                                    current_status.device_name = name.or(Some(format!("Chromecast ({})", ip)));
                                    current_status.player_state = "IDLE".to_string();

                                    if let Ok(mut c) = cached_status_clone.lock() {
                                        *c = current_status.clone();
                                    }
                                    let _ = reply.send(Ok(current_status.clone()));
                                }
                                Err(e) => {
                                    let err_msg = format!("Failed to connect to Cast device: {:?}", e);
                                    log::error!("[cast] {}", err_msg);
                                    let _ = reply.send(Err(err_msg));
                                }
                            }
                        }
                        CastCommand::Disconnect { reply } => {
                            if let Some(ref device) = active_device {
                                let _ = device.connection.disconnect("receiver-0");
                            }
                            active_device = None;
                            transport_id = None;
                            _session_id = None;
                            media_session_id = None;
                            current_status = CastStatus::default();

                            if let Ok(mut c) = cached_status_clone.lock() {
                                *c = current_status.clone();
                            }
                            let _ = reply.send(Ok(()));
                        }
                        CastCommand::Load { req, reply } => {
                            if let Some(ref device) = active_device {
                                log::info!("[cast] Launching DefaultMediaReceiver for: {}", req.title);

                                // 1. Launch default media receiver
                                match device.receiver.launch_app(&CastDeviceApp::DefaultMediaReceiver) {
                                    Ok(app) => {
                                        transport_id = Some(app.transport_id.clone());
                                        _session_id = Some(app.session_id.clone());

                                        // Connect to launched app's transport
                                        if let Err(e) = device.connection.connect(&app.transport_id) {
                                            log::warn!("[cast] Transport connect warning: {:?}", e);
                                        }

                                        let effective_stream_url = if req.stream_url.contains("127.0.0.1") || req.stream_url.contains("localhost") {
                                            if let Some(ref dev_ip) = current_status.device_ip {
                                                if let Some(local_ip) = get_local_ip_for(dev_ip) {
                                                    // Local servers bind loopback only — bridge via a LAN relay.
                                                    let local_port = reqwest::Url::parse(&req.stream_url)
                                                        .ok()
                                                        .and_then(|u| u.port())
                                                        .unwrap_or(80);
                                                    match ensure_cast_relay(local_port) {
                                                        Ok(relay_port) => {
                                                            let url = reqwest::Url::parse(&req.stream_url).ok();
                                                            match url {
                                                                Some(mut u) => {
                                                                    let _ = u.set_host(Some(&local_ip));
                                                                    let _ = u.set_port(Some(relay_port));
                                                                    u.to_string()
                                                                }
                                                                None => req.stream_url.clone(),
                                                            }
                                                        }
                                                        Err(e) => {
                                                            log::warn!("[cast] Relay start failed ({}); falling back to raw URL", e);
                                                            req.stream_url.replace("127.0.0.1", &local_ip).replace("localhost", &local_ip)
                                                        }
                                                    }
                                                } else {
                                                    req.stream_url.clone()
                                                }
                                            } else {
                                                req.stream_url.clone()
                                            }
                                        } else {
                                            req.stream_url.clone()
                                        };

                                        log::info!("[cast] Media stream URL for Chromecast: {}", effective_stream_url);

                                        let content_type = req.content_type.unwrap_or_else(|| {
                                            if effective_stream_url.contains(".m3u8") {
                                                "application/x-mpegURL".to_string()
                                            } else if effective_stream_url.contains(".mp3") || effective_stream_url.contains(".m4a") {
                                                "audio/mp3".to_string()
                                            } else {
                                                "video/mp4".to_string()
                                            }
                                        });

                                        let mut images = Vec::new();
                                        if let Some(poster) = req.poster_url {
                                            if !poster.trim().is_empty() {
                                                images.push(Image::new(poster));
                                            }
                                        }

                                        let media = Media {
                                            content_id: effective_stream_url,
                                            stream_type: StreamType::Buffered,
                                            content_type,
                                            metadata: Some(Metadata::Generic(GenericMediaMetadata {
                                                title: Some(req.title.clone()),
                                                subtitle: None,
                                                images,
                                                release_date: None,
                                            })),
                                            duration: None,
                                        };

                                        let start_time = req.current_time.unwrap_or(0.0);
                                        let load_opts = LoadOptions {
                                            current_time: start_time,
                                            autoplay: true,
                                        };

                                        match device.media.load_with_opts(
                                            &app.transport_id,
                                            &app.session_id,
                                            &media,
                                            load_opts,
                                        ) {
                                            Ok(media_status) => {
                                                if let Some(entry) = media_status.entries.first() {
                                                    media_session_id = Some(entry.media_session_id);
                                                    current_status.current_time = entry.current_time.map(|t| t as f64).unwrap_or(start_time);
                                                    current_status.duration = entry.media.as_ref().and_then(|m| m.duration).map(|d| d as f64).unwrap_or(0.0);
                                                    current_status.player_state = match entry.player_state {
                                                        PlayerState::Playing => "PLAYING".to_string(),
                                                        PlayerState::Paused => "PAUSED".to_string(),
                                                        PlayerState::Buffering => "BUFFERING".to_string(),
                                                        _ => "PLAYING".to_string(),
                                                    };
                                                } else {
                                                    current_status.player_state = "PLAYING".to_string();
                                                }

                                                current_status.title = Some(req.title);
                                                if let Ok(mut c) = cached_status_clone.lock() {
                                                    *c = current_status.clone();
                                                }
                                                let _ = reply.send(Ok(current_status.clone()));
                                            }
                                            Err(e) => {
                                                let err_msg = format!("Failed to load media on Cast device: {:?}", e);
                                                log::error!("[cast] {}", err_msg);
                                                let _ = reply.send(Err(err_msg));
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        let err_msg = format!("Failed to launch Default Media Receiver: {:?}", e);
                                        log::error!("[cast] {}", err_msg);
                                        let _ = reply.send(Err(err_msg));
                                    }
                                }
                            } else {
                                let _ = reply.send(Err("No Cast device currently connected".to_string()));
                            }
                        }
                        CastCommand::Play { reply } => {
                            if let (Some(ref device), Some(ref tid), Some(msid)) = (&active_device, &transport_id, media_session_id) {
                                match device.media.play(tid, msid) {
                                    Ok(_) => {
                                        current_status.player_state = "PLAYING".to_string();
                                        if let Ok(mut c) = cached_status_clone.lock() {
                                            *c = current_status.clone();
                                        }
                                        let _ = reply.send(Ok(()));
                                    }
                                    Err(e) => {
                                        let _ = reply.send(Err(format!("Play failed: {:?}", e)));
                                    }
                                }
                            } else {
                                let _ = reply.send(Err("No active media session".to_string()));
                            }
                        }
                        CastCommand::Pause { reply } => {
                            if let (Some(ref device), Some(ref tid), Some(msid)) = (&active_device, &transport_id, media_session_id) {
                                match device.media.pause(tid, msid) {
                                    Ok(_) => {
                                        current_status.player_state = "PAUSED".to_string();
                                        if let Ok(mut c) = cached_status_clone.lock() {
                                            *c = current_status.clone();
                                        }
                                        let _ = reply.send(Ok(()));
                                    }
                                    Err(e) => {
                                        let _ = reply.send(Err(format!("Pause failed: {:?}", e)));
                                    }
                                }
                            } else {
                                let _ = reply.send(Err("No active media session".to_string()));
                            }
                        }
                        CastCommand::Seek { time_sec, reply } => {
                            if let (Some(ref device), Some(ref tid), Some(msid)) = (&active_device, &transport_id, media_session_id) {
                                match device.media.seek(tid, msid, Some(time_sec as f32), None) {
                                    Ok(_) => {
                                        current_status.current_time = time_sec;
                                        if let Ok(mut c) = cached_status_clone.lock() {
                                            *c = current_status.clone();
                                        }
                                        let _ = reply.send(Ok(()));
                                    }
                                    Err(e) => {
                                        let _ = reply.send(Err(format!("Seek failed: {:?}", e)));
                                    }
                                }
                            } else {
                                let _ = reply.send(Err("No active media session".to_string()));
                            }
                        }
                        CastCommand::Stop { reply } => {
                            if let (Some(ref device), Some(ref tid), Some(msid)) = (&active_device, &transport_id, media_session_id) {
                                let _ = device.media.stop(tid, msid);
                                current_status.player_state = "IDLE".to_string();
                                current_status.title = None;
                                media_session_id = None;
                                if let Ok(mut c) = cached_status_clone.lock() {
                                    *c = current_status.clone();
                                }
                                let _ = reply.send(Ok(()));
                            } else {
                                let _ = reply.send(Ok(()));
                            }
                        }
                        CastCommand::SetVolume { level, reply } => {
                            if let Some(ref device) = active_device {
                                let clamped = level.clamp(0.0, 1.0);
                                match device.receiver.set_volume(Volume::from(clamped)) {
                                    Ok(_) => {
                                        current_status.volume = clamped;
                                        if let Ok(mut c) = cached_status_clone.lock() {
                                            *c = current_status.clone();
                                        }
                                        let _ = reply.send(Ok(()));
                                    }
                                    Err(e) => {
                                        let _ = reply.send(Err(format!("Volume change failed: {:?}", e)));
                                    }
                                }
                        } else {
                            let _ = reply.send(Err("No Cast device connected".to_string()));
                        }
                    }
                    CastCommand::GetStatus { reply } => {
                        let _ = reply.send(current_status.clone());
                    }
                },
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // Send periodic heartbeat ping to keep connection alive
                    if let Some(ref device) = active_device {
                        if let Err(e) = device.heartbeat.ping() {
                            log::warn!("[cast] Heartbeat ping failed, connection dropped: {:?}", e);
                            active_device = None;
                            current_status.connected = false;
                            if let Ok(mut c) = cached_status_clone.lock() {
                                *c = current_status.clone();
                            }
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    log::info!("[cast] Worker channel disconnected, exiting loop");
                    break;
                }
            }
        }
    });

        Self {
            sender: tx,
            _cached_status: cached_status,
        }
    }
}

/// Discovers the local host's IP address that routes to target_ip
fn get_local_ip_for(target_ip: &str) -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect(format!("{}:8009", target_ip)).ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

/// Discovers Google Cast / Chromecast devices on the local network using avahi-browse (mDNS)
#[tauri::command]
pub async fn discover_cast_devices() -> Result<Vec<CastDevice>, String> {
    let mut devices: Vec<CastDevice> = Vec::new();

    // 1. Try mDNS discovery via avahi-browse on Linux
    if let Ok(output) = tokio::process::Command::new("avahi-browse")
        .args(["-r", "-t", "-p", "_googlecast._tcp"])
        .output()
        .await
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            // Parsable lines start with '=':
            // =;eth0;IPv4;Living\032Room\032TV;_googlecast._tcp;local;hostname.local;192.168.1.50;8009;"fn=Living Room TV" "md=Chromecast"
            if line.starts_with('=') {
                let parts: Vec<&str> = line.split(';').collect();
                if parts.len() >= 9 {
                    let raw_name = parts[3];
                    let clean_name = raw_name.replace(r"\032", " ");
                    let ip = parts[7].trim().to_string();
                    let port = parts[8].trim().parse::<u16>().unwrap_or(8009);

                    // Extract model and friendly name from TXT record if present
                    let mut friendly_name = clean_name.clone();
                    let mut model = "Chromecast".to_string();

                    if parts.len() >= 10 {
                        let txt = parts[9];
                        for item in txt.split('"') {
                            if let Some(val) = item.strip_prefix("fn=") {
                                friendly_name = val.to_string();
                            } else if let Some(val) = item.strip_prefix("md=") {
                                model = val.to_string();
                            }
                        }
                    }

                    if !ip.is_empty() && !devices.iter().any(|d| d.ip == ip && d.port == port) {
                        let id = format!("{}:{}", ip, port);
                        devices.push(CastDevice {
                            id,
                            name: friendly_name,
                            model,
                            ip,
                            port,
                        });
                    }
                }
            }
        }
    }

    // Fallback: pure-Rust mDNS discovery via mdns-sd if avahi found nothing
    if devices.is_empty() {
        let found = tokio::task::spawn_blocking(|| {
            let mut out: Vec<CastDevice> = Vec::new();
            if let Ok(mdns) = mdns_sd::ServiceDaemon::new() {
                if let Ok(receiver) = mdns.browse("_googlecast._tcp.local.") {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
                    while std::time::Instant::now() < deadline {
                        if let Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) =
                            receiver.recv_timeout(std::time::Duration::from_millis(600))
                        {
                            let ip = info
                                .get_addresses()
                                .iter()
                                .find(|a| a.is_ipv4())
                                .map(|a| a.to_string());
                            if let Some(ip) = ip {
                                let name = info
                                    .get_property_val_str("fn")
                                    .unwrap_or_else(|| info.get_fullname())
                                    .to_string();
                                let model = info
                                    .get_property_val_str("md")
                                    .unwrap_or("Chromecast")
                                    .to_string();
                                let port = info.get_port();
                                if !out.iter().any(|d| d.ip == ip && d.port == port) {
                                    out.push(CastDevice {
                                        id: format!("{}:{}", ip, port),
                                        name,
                                        model,
                                        ip,
                                        port,
                                    });
                                }
                            }
                        }
                    }
                }
                let _ = mdns.shutdown();
            }
            out
        })
        .await
        .unwrap_or_default();
        devices.extend(found);
    }

    log::info!("[cast] Discovered {} Google Cast devices on network", devices.len());
    Ok(devices)
}

/// Connects to a Google Cast device
#[tauri::command]
pub async fn connect_cast_device(
    manager: State<'_, CastManager>,
    ip: String,
    port: Option<u16>,
    name: Option<String>,
) -> Result<CastStatus, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let port_num = port.unwrap_or(8009);

    manager
        .sender
        .send(CastCommand::Connect {
            ip,
            port: port_num,
            name,
            reply: tx,
        })
        .map_err(|e| format!("Cast worker thread error: {}", e))?;

    rx.recv().map_err(|e| format!("Channel receive error: {}", e))?
}

/// Disconnects from current Cast device
#[tauri::command]
pub async fn disconnect_cast_device(manager: State<'_, CastManager>) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    manager
        .sender
        .send(CastCommand::Disconnect { reply: tx })
        .map_err(|e| format!("Cast worker error: {}", e))?;

    rx.recv().map_err(|e| format!("Channel receive error: {}", e))?
}

/// Casts a media item to the connected Cast device
#[tauri::command]
pub async fn cast_load_media(
    manager: State<'_, CastManager>,
    req: CastMediaRequest,
) -> Result<CastStatus, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    manager
        .sender
        .send(CastCommand::Load { req, reply: tx })
        .map_err(|e| format!("Cast worker error: {}", e))?;

    rx.recv().map_err(|e| format!("Channel receive error: {}", e))?
}

/// Controls playback (play, pause, stop, seek, volume) on active Cast device
#[tauri::command]
pub async fn cast_control(
    manager: State<'_, CastManager>,
    action: String,
    value: Option<f64>,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();

    let cmd = match action.to_lowercase().trim() {
        "play" => CastCommand::Play { reply: tx },
        "pause" => CastCommand::Pause { reply: tx },
        "stop" => CastCommand::Stop { reply: tx },
        "seek" => CastCommand::Seek {
            time_sec: value.unwrap_or(0.0),
            reply: tx,
        },
        "volume" => CastCommand::SetVolume {
            level: value.unwrap_or(1.0) as f32,
            reply: tx,
        },
        other => return Err(format!("Unknown cast action: {}", other)),
    };

    manager
        .sender
        .send(cmd)
        .map_err(|e| format!("Cast worker error: {}", e))?;

    rx.recv().map_err(|e| format!("Channel receive error: {}", e))?
}

/// Gets current status of Cast device
#[tauri::command]
pub async fn get_cast_status(manager: State<'_, CastManager>) -> Result<CastStatus, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    manager
        .sender
        .send(CastCommand::GetStatus { reply: tx })
        .map_err(|e| format!("Cast worker error: {}", e))?;

    Ok(rx.recv().unwrap_or_default())
}
