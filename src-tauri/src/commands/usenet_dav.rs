use infinidysk_archive::rar;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, OwnedSemaphorePermit, RwLock, Semaphore};

pub trait NntpIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> NntpIo for T {}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsenetServerConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub use_tls: bool,
    pub connections_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexerHealth {
    pub name: String,
    pub active: bool,
    pub hits: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsenetSearchResult {
    pub indexer: String,
    pub id: String,
    pub title: String,
    pub size_bytes: u64,
    pub published_at: String,
    pub nzb_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsenetSearchResponse {
    pub results: Vec<UsenetSearchResult>,
    pub indexers: Vec<IndexerHealth>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NzbSegment {
    pub number: u32,
    pub bytes: u64,
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Volume {
    pub name: String,
    pub segments: Vec<NzbSegment>,
    pub size: u64,
    pub seg_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Part {
    pub volume: usize,
    pub vol_offset: u64,
    pub len: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirtualFile {
    pub name: String,
    pub size: u64,
    pub volumes: Vec<Volume>,
    pub parts: Vec<Part>,
    /// Category folder path like "TV Shows/Show Name/Season 1/file.mkv". `None` for
    /// mounts made before hierarchy support (they list at the /dav/ root, as before).
    #[serde(default)]
    pub virtual_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayableFile {
    pub name: String,
    pub size: u64,
    pub kind: String,
    pub warning: Option<String>,
    #[serde(default)]
    pub virtual_path: Option<String>,
}

const SEGMENT_CACHE_CAPACITY: usize = 32; // ≈ 24 MB of decoded 768 KB segments
const POOL_MAX_IDLE: usize = 6;

type NntpConn = BufReader<Box<dyn NntpIo>>;

pub struct UsenetEngineState {
    pub config: RwLock<Option<UsenetServerConfig>>,
    pub files: RwLock<HashMap<String, VirtualFile>>,
    pub config_path: PathBuf,
    pub mounts_path: PathBuf,
    /// Idle, authenticated NNTP connections (never contains a connection that errored).
    pub conn_pool: Mutex<Vec<NntpConn>>,
    /// Caps simultaneously *in-use* NNTP connections to the provider limit.
    pub conn_sem: std::sync::RwLock<Arc<Semaphore>>,
    /// Bumped whenever config changes; sockets from an older epoch are never pooled.
    pub pool_epoch: AtomicU64,
    /// FIFO cache of decoded yEnc segments: message_id (no <>) -> bytes.
    pub seg_cache: Mutex<VecDeque<(String, Arc<Vec<u8>>)>>,
}

static USENET_ENGINE: OnceLock<Arc<UsenetEngineState>> = OnceLock::new();

/// Decodes XML entities in a single pass: &quot; &apos; &amp; &lt; &gt; and any
/// numeric reference (&#34; &#x22; …). Unknown entities are left untouched.
pub fn xml_unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        if let Some(semi) = tail.find(';').filter(|&p| p > 1 && p <= 10) {
            let ent = &tail[1..semi];
            let rep: Option<char> = match ent {
                "quot" => Some('"'),
                "apos" => Some('\''),
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                    u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32)
                }
                _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
                _ => None,
            };
            if let Some(c) = rep {
                out.push(c);
                rest = &tail[semi + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &tail[1..];
    }
    out.push_str(rest);
    out
}

/// Clean filename from an NZB `<file subject="…">` value (entities decoded first).
/// `"Name.mkv" yEnc (1/1444)` -> `Name.mkv`; unquoted subjects get the trailing
/// ` yEnc (n/m)` and a leading `[n/m] - ` stripped. Never returns path separators.
pub fn extract_clean_subject_filename(raw_subject: &str) -> String {
    let decoded = xml_unescape(raw_subject);
    let subject = decoded.trim();
    if let Some(q1) = subject.find('"') {
        if let Some(q2) = subject[q1 + 1..].find('"') {
            let cand = subject[q1 + 1..q1 + 1 + q2].trim();
            if !cand.is_empty() {
                return cand.rsplit(['/', '\\']).next().unwrap_or(cand).to_string();
            }
        }
    }
    let mut s = subject;
    if let Some(i) = s.to_ascii_lowercase().rfind(" yenc") {
        s = s[..i].trim();
    }
    if s.starts_with('[') {
        if let Some(i) = s.find("] - ") {
            s = s[i + 4..].trim();
        }
    }
    let s = s.trim_matches('"').trim();
    s.rsplit(['/', '\\']).next().unwrap_or(s).to_string()
}

fn name_needs_heal(n: &str) -> bool {
    n.contains("&quot;") || n.contains("&#") || n.to_ascii_lowercase().contains(" yenc")
}

/// Repairs persisted mounts whose names were saved with raw subject text such as
/// `&quot;Show.S01E01.mkv&quot; yEnc (1/1444)`. Clean names are never touched.
fn heal_persisted_mounts(raw: HashMap<String, VirtualFile>) -> (HashMap<String, VirtualFile>, bool) {
    let mut healed = HashMap::with_capacity(raw.len());
    let mut changed = false;
    for (old_key, mut vf) in raw {
        if name_needs_heal(&vf.name) {
            let clean = extract_clean_subject_filename(&vf.name);
            if !clean.is_empty() && clean != vf.name {
                // Legacy mounts may have virtual_path == None; their folder prefix then lives in the key.
                let vp = vf.virtual_path.clone().unwrap_or_else(|| old_key.clone());
                let prefix = vp
                    .strip_suffix(vf.name.as_str())
                    .unwrap_or_else(|| parent_of(&vp))
                    .trim_end_matches('/')
                    .to_string();
                vf.virtual_path = if prefix.is_empty() && vf.virtual_path.is_none() {
                    None
                } else if prefix.is_empty() {
                    Some(clean.clone())
                } else {
                    Some(format!("{prefix}/{clean}"))
                };
                vf.name = clean;
                changed = true;
            }
        }
        let new_key = vf.virtual_path.clone().unwrap_or_else(|| vf.name.clone());
        if new_key != old_key {
            changed = true;
        }
        healed.insert(new_key, vf);
    }
    (healed, changed)
}

pub fn get_usenet_engine() -> Arc<UsenetEngineState> {
    USENET_ENGINE
        .get_or_init(|| {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            let base = PathBuf::from(home).join(".local/share/com.rcloneflix.desktop");
            let _ = std::fs::create_dir_all(&base);
            let config_path = base.join("usenet_config.json");
            let mounts_path = base.join("usenet_mounts.json");

            let initial_conf = std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| serde_json::from_str::<UsenetServerConfig>(&s).ok());

            let loaded: HashMap<String, VirtualFile> = std::fs::read_to_string(&mounts_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let (initial_files, healed) = heal_persisted_mounts(loaded);
            if healed {
                if let Ok(json) = serde_json::to_string(&initial_files) {
                    let _ = std::fs::write(&mounts_path, json);
                }
                log::info!(target: "usenet", "Auto-healed XML-escaped names in persisted NZB mounts");
            }
            if !initial_files.is_empty() {
                log::info!(target: "usenet", "Restored {} persisted NZB virtual files", initial_files.len());
            }

            let cap = initial_conf
                .as_ref()
                .and_then(|c| c.connections_limit)
                .unwrap_or(10)
                .clamp(2, 20);

            let state = Arc::new(UsenetEngineState {
                config: RwLock::new(initial_conf),
                files: RwLock::new(initial_files),
                config_path,
                mounts_path,
                conn_pool: Mutex::new(Vec::new()),
                conn_sem: std::sync::RwLock::new(Arc::new(Semaphore::new(cap))),
                pool_epoch: AtomicU64::new(0),
                seg_cache: Mutex::new(VecDeque::with_capacity(SEGMENT_CACHE_CAPACITY)),
            });

            start_infinidysk_webdav_server(Arc::clone(&state));
            state
        })
        .clone()
}

impl UsenetEngineState {
    pub fn epoch(&self) -> u64 {
        self.pool_epoch.load(Ordering::SeqCst)
    }

    /// Wait (bounded) for a connection slot. Permit is owned, so it can live across awaits/tasks.
    pub async fn acquire_slot(&self, wait_secs: u64) -> Option<OwnedSemaphorePermit> {
        let sem = self.conn_sem.read().ok()?.clone();
        match tokio::time::timeout(std::time::Duration::from_secs(wait_secs), sem.acquire_owned()).await {
            Ok(Ok(p)) => Some(p),
            _ => None,
        }
    }

    pub async fn get_cached_segment(&self, message_id: &str) -> Option<Arc<Vec<u8>>> {
        let id = message_id.trim_matches(|c| c == '<' || c == '>');
        let cache = self.seg_cache.lock().await;
        cache.iter().find(|(k, _)| k.as_str() == id).map(|(_, v)| Arc::clone(v))
    }

    pub async fn put_cached_segment(&self, message_id: &str, data: Arc<Vec<u8>>) {
        let id = message_id.trim_matches(|c| c == '<' || c == '>').to_string();
        let mut cache = self.seg_cache.lock().await;
        if let Some(pos) = cache.iter().position(|(k, _)| k == &id) {
            cache.remove(pos);
        }
        while cache.len() >= SEGMENT_CACHE_CAPACITY {
            cache.pop_front();
        }
        cache.push_back((id, data));
    }

    /// Pops an idle pooled connection or opens a new one. The caller must already
    /// hold a `conn_sem` permit.
    pub async fn acquire_conn(&self, cfg: &UsenetServerConfig) -> Result<NntpConn, String> {
        let pooled = self.conn_pool.lock().await.pop();
        if let Some(c) = pooled {
            return Ok(c);
        }
        nntp_connect(cfg).await
    }

    /// Returns a HEALTHY connection to the idle pool (QUITs it if the pool is full).
    pub async fn release_conn(&self, conn: NntpConn) {
        let overflow = {
            let mut pool = self.conn_pool.lock().await;
            if pool.len() < POOL_MAX_IDLE {
                pool.push(conn);
                None
            } else {
                Some(conn)
            }
        };
        if let Some(mut c) = overflow {
            nntp_quit_quietly(&mut c).await;
        }
    }

    /// Like `release_conn`, but drops (QUITs) the socket if the config changed since it was acquired.
    pub async fn release_conn_at(&self, conn: NntpConn, epoch: u64) {
        if epoch != self.epoch() {
            let mut c = conn;
            nntp_quit_quietly(&mut c).await;
        } else {
            self.release_conn(conn).await;
        }
    }

    pub async fn clear_pool(&self) {
        let conns: Vec<NntpConn> = self.conn_pool.lock().await.drain(..).collect();
        for mut c in conns {
            nntp_quit_quietly(&mut c).await;
        }
    }
}

async fn nntp_quit_quietly(conn: &mut NntpConn) {
    let _ = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        let _ = conn.get_mut().write_all(b"QUIT\r\n").await;
        let _ = conn.get_mut().flush().await;
    })
    .await;
}

async fn nntp_connect(cfg: &UsenetServerConfig) -> Result<BufReader<Box<dyn NntpIo>>, String> {
    let host = cfg.host.trim().to_string();
    if host.is_empty() {
        return Err("Usenet host is not configured".to_string());
    }

    // Rustls 0.23 ships with BOTH ring and aws-lc-rs features in this build;
    // install ring explicitly to resolve the provider ambiguity (safe to call repeatedly:
    // install_default() returns Err after the first call, which we intentionally ignore).
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();

    let tcp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        TcpStream::connect((host.as_str(), cfg.port)),
    )
    .await
    .map_err(|_| format!("Connection to {}:{} timed out after 10s", host, cfg.port))?
    .map_err(|e| format!("NNTP connect error to {}:{}: {e}", host, cfg.port))?;

    let io: Box<dyn NntpIo> = if cfg.use_tls {
        let mut roots = tokio_rustls::rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

        let tls_cfg = tokio_rustls::rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();

        let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_cfg));
        let name = tokio_rustls::rustls::pki_types::ServerName::try_from(host.clone())
            .map_err(|e| format!("Bad TLS host '{host}': {e}"))?;

        let tls_stream = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            connector.connect(name, tcp),
        )
        .await
        .map_err(|_| format!("TLS handshake with {host}:{} timed out after 10s", cfg.port))?
        .map_err(|e| format!("TLS handshake error with {host}:{}: {e}", cfg.port))?;

        Box::new(tls_stream)
    } else {
        Box::new(tcp)
    };

    let mut r = BufReader::new(io);
    let mut line = String::new();

    tokio::time::timeout(std::time::Duration::from_secs(8), r.read_line(&mut line))
        .await
        .map_err(|_| "Timed out waiting for NNTP greeting banner".to_string())?
        .map_err(|e| format!("Failed to read NNTP banner: {e}"))?;

    if !line.starts_with("200") && !line.starts_with("201") {
        return Err(format!("NNTP banner error: {}", line.trim()));
    }

    if !cfg.username.trim().is_empty() {
        r.get_mut()
            .write_all(format!("AUTHINFO USER {}\r\n", cfg.username.trim()).as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        r.get_mut().flush().await.map_err(|e| e.to_string())?;

        line.clear();
        tokio::time::timeout(std::time::Duration::from_secs(8), r.read_line(&mut line))
            .await
            .map_err(|_| "Timed out waiting for AUTHINFO USER response".to_string())?
            .map_err(|e| e.to_string())?;

        // 381 = password required; 281 = accepted without password
        if line.starts_with("381") {
            r.get_mut()
                .write_all(format!("AUTHINFO PASS {}\r\n", cfg.password.trim()).as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            r.get_mut().flush().await.map_err(|e| e.to_string())?;

            line.clear();
            tokio::time::timeout(std::time::Duration::from_secs(8), r.read_line(&mut line))
                .await
                .map_err(|_| "Timed out waiting for AUTHINFO PASS response".to_string())?
                .map_err(|e| e.to_string())?;
        }

        if !line.starts_with("281") {
            return Err(format!("NNTP authentication failed: {}", line.trim()));
        }
    }

    Ok(r)
}

pub fn decode_yenc_article(raw_lines: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut in_data = false;
    for line in raw_lines {
        if line.starts_with(b"=ybegin") {
            in_data = false;
            continue;
        }
        if line.starts_with(b"=ypart") {
            in_data = true;
            continue;
        }
        if line.starts_with(b"=yend") {
            break;
        }
        if !in_data {
            in_data = true;
        }
        let mut i = 0;
        while i < line.len() {
            let b = line[i];
            if b == b'\r' || b == b'\n' {
                i += 1;
                continue;
            }
            if b == b'=' {
                i += 1;
                if i < line.len() {
                    let esc = line[i];
                    out.push(esc.wrapping_sub(64).wrapping_sub(42));
                }
            } else {
                out.push(b.wrapping_sub(42));
            }
            i += 1;
        }
    }
    out
}

async fn nntp_body(
    r: &mut NntpConn,
    message_id: &str,
) -> Result<(Vec<u8>, Option<u64>, Option<u64>), String> {
    let id = message_id.trim_matches(|c| c == '<' || c == '>');
    let fut = async {
        r.get_mut()
            .write_all(format!("BODY <{id}>\r\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        r.get_mut().flush().await.map_err(|e| e.to_string())?;
        let mut line = String::new();
        let n_hdr = r.read_line(&mut line).await.map_err(|e| e.to_string())?;
        if n_hdr == 0 {
            return Err("NNTP connection closed by server (EOF)".to_string());
        }
        if !line.starts_with("222") {
            return Err(format!("NNTP BODY failed: {}", line.trim()));
        }
        let mut raw: Vec<Vec<u8>> = Vec::new();
        loop {
            let mut buf = Vec::new();
            let n = r.read_until(b'\n', &mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("Unexpected EOF while reading NNTP article body".to_string());
            }
            if buf == b".\r\n" || buf == b".\n" {
                break;
            }
            if buf.starts_with(b"..") {
                buf.remove(0);
            }
            raw.push(buf);
        }
        let total = raw.iter().find(|l| l.starts_with(b"=ybegin")).and_then(|l| {
            let s = String::from_utf8_lossy(l);
            s.split_whitespace().find_map(|t| t.strip_prefix("size=")?.parse::<u64>().ok())
        });
        let part_begin = raw.iter().find(|l| l.starts_with(b"=ypart")).and_then(|l| {
            let s = String::from_utf8_lossy(l);
            s.split_whitespace().find_map(|t| t.strip_prefix("begin=")?.parse::<u64>().ok())
        });
        Ok::<_, String>((decode_yenc_article(&raw), total, part_begin))
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), fut)
        .await
        .map_err(|_| format!("NNTP BODY <{id}> timed out after 30s"))?
}

/// Returns the decoded article. Cache first; on failure the connection is DROPPED
/// (never reused/pooled) unless the server cleanly answered 430/423 (article missing),
/// then retried once on a brand-new connection.
/// `populate_cache`: true for playback reads, false for RAR header scanning
/// (scanning would otherwise evict the segments playback needs).
async fn fetch_segment(
    engine: &UsenetEngineState,
    cfg: &UsenetServerConfig,
    conn: &mut Option<NntpConn>,
    seg: &NzbSegment,
    populate_cache: bool,
) -> Result<Arc<Vec<u8>>, String> {
    if let Some(c) = engine.get_cached_segment(&seg.message_id).await {
        return Ok(c);
    }
    let mut last_err = String::new();
    for attempt in 0..2 {
        if conn.is_none() {
            *conn = Some(if attempt == 0 {
                engine.acquire_conn(cfg).await?
            } else {
                nntp_connect(cfg).await?
            });
        }
        match nntp_body(conn.as_mut().unwrap(), &seg.message_id).await {
            Ok((d, _, _)) => {
                let arc = Arc::new(d);
                if populate_cache {
                    engine.put_cached_segment(&seg.message_id, Arc::clone(&arc)).await;
                }
                return Ok(arc);
            }
            Err(e) => {
                let missing = e.starts_with("NNTP BODY failed:") && (e.contains(" 430") || e.contains(" 423"));
                log::warn!(target: "usenet", "BODY <{}> attempt {} failed: {}", seg.message_id, attempt + 1, e);
                last_err = e;
                if missing {
                    break; // clean reply: socket still in sync, retrying cannot help
                }
                *conn = None; // possibly desynchronised: never reuse or pool it
            }
        }
    }
    Err(last_err)
}

/// Reads `offset..offset+len` of a volume and returns the bytes from `offset` to the END
/// of the last fetched segment, so successive `rar::Step::Need` requests inside the same
/// segment are served from memory instead of re-downloading it.
async fn read_volume_generous(
    engine: &UsenetEngineState,
    cfg: &UsenetServerConfig,
    conn: &mut Option<NntpConn>,
    vol: &Volume,
    offset: u64,
    len: u64,
) -> Result<Vec<u8>, String> {
    let min_end = offset.saturating_add(len).min(vol.size);
    let mut out = Vec::new();
    let mut v_off = offset;
    while v_off < min_end {
        let idx = (v_off / vol.seg_size) as usize;
        let seg = vol.segments.get(idx).ok_or("Segment index out of range")?;
        let data = fetch_segment(engine, cfg, conn, seg, false)
            .await
            .map_err(|e| format!("Missing article <{}> while scanning {}: {}", seg.message_id, vol.name, e))?;
        let seg_start = idx as u64 * vol.seg_size;
        let a = (v_off - seg_start) as usize;
        if a >= data.len() {
            break;
        }
        out.extend_from_slice(&data[a..]);
        v_off = seg_start + data.len() as u64;
    }
    Ok(out)
}

/// 0-based volume number inferred from conventional RAR names; `None` for obfuscated names.
fn infer_rar_volume_number(name: &str) -> Option<u32> {
    let l = name.to_ascii_lowercase();
    if let Some(p) = l.rfind(".part") {
        let digits: String = l[p + 5..].chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u32>() {
            return Some(n.saturating_sub(1));
        }
    }
    if l.ends_with(".rar") {
        return Some(0);
    }
    if regex_rnn(&l) {
        return l[l.len() - 2..].parse::<u32>().ok().map(|n| n + 1);
    }
    None
}

/// Parses RAR headers of one volume starting from its already-downloaded first segment.
/// Verified safe to skip the tail segment when the last entry's data already reaches the
/// end of the volume AND the volume number is known (RAR5 header or filename): entry
/// flags (`split_before/after`) come from the file header, not the end block.
async fn scan_rar_volume_fast(
    engine: &UsenetEngineState,
    cfg: &UsenetServerConfig,
    conn: &mut Option<NntpConn>,
    vol: &Volume,
    first_segment: Vec<u8>,
    password: Option<&str>,
) -> Result<(rar::Volume, Vec<rar::Entry>), String> {
    let mut scanner = rar::Scanner::new();
    let mut entries = Vec::new();
    let (mut at, mut buf) = (0u64, first_segment);
    let inferred = infer_rar_volume_number(&vol.name);
    loop {
        match scanner.next(at, &buf).map_err(|e| format!("{}: {e}", vol.name))? {
            rar::Step::Need { offset, len } => {
                if offset >= vol.size {
                    break;
                }
                if !entries.is_empty()
                    && offset + 64 >= vol.size
                    && (scanner.volume().number.is_some() || inferred.is_some())
                {
                    break;
                }
                let have = buf.len() as u64;
                if offset == at && (have >= len || at + have >= vol.size) {
                    return Err(format!("{}: RAR headers run past the end of the volume", vol.name));
                }
                buf = read_volume_generous(engine, cfg, conn, vol, offset, len).await?;
                at = offset;
            }
            rar::Step::Entry(e) => entries.push(e),
            rar::Step::Key(_) => {
                return Err(format!(
                    "{}: archive is password-protected{}",
                    vol.name,
                    if password.is_some() {
                        " (encrypted archives not supported)"
                    } else {
                        "; no password provided"
                    }
                ));
            }
            rar::Step::End { .. } => break,
        }
    }
    let mut v = scanner.volume().clone();
    if v.number.is_none() {
        v.number = inferred;
    }
    Ok((v, entries))
}

fn is_video_name(n: &str) -> bool {
    let l = n.to_ascii_lowercase();
    ["mkv", "mp4", "avi", "m4v", "ts", "webm", "mov", "wmv", "mpg", "mpeg"].iter().any(|e| l.ends_with(&format!(".{e}")))
}

/// Known non-media companions in Usenet releases. These are never playable and never RAR
/// volumes, so probing their first segments only burns bandwidth — and a single missing
/// .par2 article used to abort the whole mount.
fn is_junk_name(n: &str) -> bool {
    let l = n.to_ascii_lowercase();
    const JUNK_EXT: &[&str] = &[
        ".par2", ".nfo", ".sfv", ".srr", ".srs", ".nzb", ".txt", ".diz", ".url", ".exe",
        ".jpg", ".jpeg", ".png", ".gif", ".srt", ".vtt", ".sub", ".idx", ".m3u",
    ];
    if JUNK_EXT.iter().any(|e| l.ends_with(e)) {
        return true;
    }
    // Sample clips: tiny teaser videos that would otherwise win the "is a video" check.
    if is_video_name(&l)
        && (l.starts_with("sample") || l.contains(".sample.") || l.contains("-sample") || l.contains("_sample"))
    {
        return true;
    }
    false
}

fn rar_name(n: &str) -> bool {
    let l = n.to_ascii_lowercase();
    l.ends_with(".rar") || l.contains(".part") || regex_rnn(&l)
}

/// Old-style split volumes: .r00 .r01 … .r99
fn regex_rnn(l: &str) -> bool {
    let b = l.as_bytes();
    b.len() > 4
        && b[b.len() - 4] == b'.'
        && b[b.len() - 3] == b'r'
        && b[b.len() - 2].is_ascii_digit()
        && b[b.len() - 1].is_ascii_digit()
}

fn magic_is_rar(m: &[u8]) -> bool {
    m.starts_with(b"Rar!\x1A\x07")
}

/// Container sniff for obfuscated releases whose subjects are random hashes without
/// an extension: MKV (EBML), MP4 (ftyp at offset 4), AVI (RIFF….AVI).
fn magic_is_video(m: &[u8]) -> bool {
    m.starts_with(&[0x1A, 0x45, 0xDF, 0xA3])
        || (m.len() >= 8 && &m[4..8] == b"ftyp")
        || (m.len() >= 12 && m.starts_with(b"RIFF") && &m[8..12] == b"AVI ")
}

fn basename_of(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

fn parent_of(p: &str) -> &str {
    match p.rfind('/') {
        Some(i) => &p[..i],
        None => "",
    }
}

fn mime_for_media_name(n: &str) -> &'static str {
    let l = n.to_ascii_lowercase();
    match () {
        _ if l.ends_with(".mkv") => "video/x-matroska",
        _ if l.ends_with(".mp4") || l.ends_with(".m4v") => "video/mp4",
        _ if l.ends_with(".avi") => "video/x-msvideo",
        _ if l.ends_with(".ts") => "video/mp2t",
        _ if l.ends_with(".webm") => "video/webm",
        _ if l.ends_with(".mov") => "video/quicktime",
        _ if l.ends_with(".wmv") => "video/x-ms-wmv",
        _ if l.ends_with(".mpg") || l.ends_with(".mpeg") => "video/mpeg",
        _ if l.ends_with(".mp3") => "audio/mpeg",
        _ if l.ends_with(".flac") => "audio/flac",
        _ if l.ends_with(".m4a") || l.ends_with(".m4b") => "audio/mp4",
        _ if l.ends_with(".ogg") || l.ends_with(".opus") => "audio/ogg",
        _ if l.ends_with(".wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Percent-encode a virtual path per segment, keeping the '/' separators.
fn encode_dav_href(path: &str) -> String {
    path.split('/')
        .map(|seg| crate::commands::player::percent_encode_path(seg))
        .collect::<Vec<_>>()
        .join("/")
}

/// Sanitize a frontend-supplied category directory: strip traversal, back/leading
/// slashes and empty segments. Returns None if nothing usable remains.
fn sanitize_virtual_dir(dir: &str) -> Option<String> {
    let cleaned: Vec<String> = dir
        .replace('\\', "/")
        .split('/')
        .map(|s| s.trim().trim_matches('.').trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.join("/"))
    }
}

fn rar_members_to_virtual(mut scans: Vec<(Volume, rar::Volume, Vec<rar::Entry>)>) -> Result<Vec<VirtualFile>, String> {
    if scans.iter().all(|(_, v, _)| v.number.is_some()) {
        scans.sort_by_key(|(_, v, _)| v.number);
    }
    struct M {
        name: String,
        size: Option<u64>,
        stored: bool,
        encrypted: bool,
        open: bool,
        headless: bool,
        parts: Vec<(usize, std::ops::Range<u64>)>,
    }
    let mut members: Vec<M> = Vec::new();
    for (vi, (_, _, entries)) in scans.iter().enumerate() {
        for e in entries {
            let opened = members.iter().rposition(|m| e.split_before && m.open && m.name == e.name);
            let m = if let Some(i) = opened {
                &mut members[i]
            } else {
                members.push(M {
                    name: e.name.clone(),
                    size: e.size,
                    stored: true,
                    encrypted: false,
                    open: false,
                    headless: e.split_before,
                    parts: Vec::new(),
                });
                members.last_mut().unwrap()
            };
            m.parts.push((vi, e.data.clone()));
            m.stored &= e.stored;
            m.encrypted |= e.encrypted;
            m.open = e.split_after;
            m.size = e.size.or(m.size);
        }
    }
    let volumes: Vec<Volume> = scans.into_iter().map(|(v, _, _)| v).collect();
    let mut out = Vec::new();
    for m in members {
        if !is_video_name(&m.name) {
            continue;
        }
        if m.open || m.headless {
            return Err(format!("{}: RAR volumes are missing", m.name));
        }
        if !m.stored {
            return Err(format!("{}: compressed RAR archives cannot be streamed; only stored (uncompressed) contents are supported.", m.name));
        }
        if m.encrypted {
            return Err(format!("{}: encrypted RAR archives are not supported", m.name));
        }
        let len: u64 = m.parts.iter().map(|(_, r)| r.end - r.start).sum();
        if m.size.is_some_and(|s| s != len) {
            return Err(format!("{}: RAR volumes are missing or inconsistent", m.name));
        }
        out.push(VirtualFile {
            name: m.name.rsplit(['/', '\\']).next().unwrap_or(&m.name).to_string(),
            size: len,
            volumes: volumes.clone(),
            parts: m.parts.into_iter().map(|(vi, r)| Part { volume: vi, vol_offset: r.start, len: r.end - r.start }).collect(),
            virtual_path: None,
        });
    }
    Ok(out)
}

async fn stream_virtual_range(
    socket: &mut TcpStream,
    engine: &UsenetEngineState,
    cfg: &UsenetServerConfig,
    conn: &mut Option<NntpConn>,
    vf: &VirtualFile,
    start: u64,
    end: u64,
) -> Result<(), String> {
    let mut virt_pos = 0u64;
    for part in &vf.parts {
        let part_end = virt_pos + part.len;
        if part_end <= start {
            virt_pos = part_end;
            continue;
        }
        if virt_pos > end {
            break;
        }
        let lo = start.max(virt_pos) - virt_pos;
        let hi = (end + 1).min(part_end) - virt_pos;
        let vol = vf.volumes.get(part.volume).ok_or("Volume index out of range")?;
        let (mut v_off, v_stop) = (part.vol_offset + lo, part.vol_offset + hi);
        while v_off < v_stop {
            let seg_idx = (v_off / vol.seg_size) as usize;
            let seg = vol.segments.get(seg_idx).ok_or("Segment index out of range")?;
            let seg_start = seg_idx as u64 * vol.seg_size;
            let expected = vol.size.saturating_sub(seg_start).min(vol.seg_size) as usize;

            let data = match fetch_segment(engine, cfg, conn, seg, true).await {
                Ok(d) => d,
                Err(e) => {
                    log::error!(target: "usenet", "Article <{}> unrecoverable, zero-filling {} bytes: {}", seg.message_id, expected, e);
                    Arc::new(vec![0u8; expected.max(1)])
                }
            };

            let a = (v_off - seg_start) as usize;
            // Never stop short because an article decoded a few bytes smaller than the
            // nominal segment size: pad with zeros to keep byte offsets aligned.
            let limit = ((v_stop - seg_start) as usize).min(expected.max(data.len()));
            if a >= limit {
                return Err("Offset beyond decoded article".into());
            }
            let real_end = data.len().min(limit);
            if a < real_end && socket.write_all(&data[a..real_end]).await.is_err() {
                return Ok(()); // client went away
            }
            let pad_from = a.max(real_end);
            if limit > pad_from {
                log::warn!(target: "usenet", "Short article <{}>: padding {} byte(s)", seg.message_id, limit - pad_from);
                if socket.write_all(&vec![0u8; limit - pad_from]).await.is_err() {
                    return Ok(());
                }
            }
            v_off = seg_start + limit as u64;
        }
        virt_pos = part_end;
    }
    Ok(())
}

fn start_infinidysk_webdav_server(state: Arc<UsenetEngineState>) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind("127.0.0.1:8553").await {
            Ok(l) => {
                log::info!(target: "usenet", "InfiniDysk WebDAV Server listening on 127.0.0.1:8553");
                l
            }
            Err(e) => {
                log::warn!(target: "usenet", "Port 8553 unavailable for InfiniDysk: {}", e);
                return;
            }
        };

        loop {
            if let Ok((mut socket, _)) = listener.accept().await {
                let st = Arc::clone(&state);
                tauri::async_runtime::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = match socket.read(&mut buf).await {
                        Ok(n) if n > 0 => n,
                        _ => return,
                    };

                    let req_str = String::from_utf8_lossy(&buf[..n]);
                    let mut lines = req_str.lines();
                    let first_line = lines.next().unwrap_or_default();
                    let parts: Vec<&str> = first_line.split_whitespace().collect();
                    if parts.len() < 2 {
                        return;
                    }
                    let method = parts[0];
                    let path = parts[1];

                    // Anti-rebinding check
                    let host_hdr = lines.clone().find_map(|l| l.to_ascii_lowercase().strip_prefix("host:").map(|s| s.trim().to_string()));
                    if let Some(host) = host_hdr {
                        if !host.starts_with("127.0.0.1:8553") && !host.starts_with("localhost:8553") {
                            let _ = socket.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\nConnection: close\r\n\r\nForbidden").await;
                            return;
                        }
                    }

                    if method.eq_ignore_ascii_case("OPTIONS") {
                        let resp = "HTTP/1.1 200 OK\r\nDAV: 1, 2\r\nAllow: OPTIONS, GET, HEAD, PROPFIND\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        let _ = socket.write_all(resp.as_bytes()).await;
                        return;
                    }

                    if method.eq_ignore_ascii_case("PROPFIND") {
                        // Hierarchical listing: category directories ("/TV Shows/<Show>/Season N",
                        // "/Movies", …) are synthesized from each mount's virtual_path so rclone
                        // and RcloneFlix libraries can be pointed at usenet-drive:/TV Shows etc.
                        // Legacy mounts without a virtual_path keep listing flat at the root.
                        let raw_req = path.trim_start_matches("/dav").trim_matches('/');
                        let req = percent_encoding::percent_decode_str(raw_req).decode_utf8_lossy().trim_matches('/').to_string();
                        let depth = lines
                            .clone()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("depth:").map(|s| s.trim().to_string()))
                            .unwrap_or_else(|| "1".to_string());
                        let list_children = depth != "0";

                        let (file_paths, dirs) = {
                            let files = st.files.read().await;
                            let mut file_paths: Vec<(String, u64)> = Vec::new();
                            let mut dirs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
                            for (key, vf) in files.iter() {
                                let full = vf.virtual_path.clone().unwrap_or_else(|| key.clone());
                                let mut anc = parent_of(&full);
                                while !anc.is_empty() {
                                    dirs.insert(anc.to_string());
                                    anc = parent_of(anc);
                                }
                                file_paths.push((full, vf.size));
                            }
                            (file_paths, dirs)
                        };

                        let dir_entry = |xml: &mut String, p: &str| {
                            let href = if p.is_empty() { "/dav/".to_string() } else { format!("/dav/{}/", xml_escape(&encode_dav_href(p))) };
                            let name = if p.is_empty() { "usenet-drive" } else { basename_of(p) };
                            xml.push_str(&format!(
                                "<D:response>\n<D:href>{href}</D:href>\n<D:propstat>\n<D:prop>\n<D:displayname>{}</D:displayname>\n<D:resourcetype><D:collection/></D:resourcetype>\n</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>\n</D:response>\n",
                                xml_escape(name)
                            ));
                        };
                        let file_entry = |xml: &mut String, p: &str, size: u64| {
                            xml.push_str(&format!(
                                "<D:response>\n<D:href>/dav/{}</D:href>\n<D:propstat>\n<D:prop>\n<D:displayname>{}</D:displayname>\n<D:getcontentlength>{size}</D:getcontentlength>\n<D:getcontenttype>{}</D:getcontenttype>\n<D:resourcetype/>\n</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>\n</D:response>\n",
                                xml_escape(&encode_dav_href(p)),
                                xml_escape(basename_of(p)),
                                mime_for_media_name(p)
                            ));
                        };

                        let mut xml = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<D:multistatus xmlns:D=\"DAV:\">\n");
                        if let Some((fp, size)) = file_paths.iter().find(|(fp, _)| *fp == req) {
                            file_entry(&mut xml, fp, *size);
                        } else if req.is_empty() || dirs.contains(&req) {
                            dir_entry(&mut xml, &req);
                            if list_children {
                                for d in dirs.iter().filter(|d| parent_of(d) == req) {
                                    dir_entry(&mut xml, d);
                                }
                                for (fp, size) in file_paths.iter().filter(|(fp, _)| parent_of(fp) == req) {
                                    file_entry(&mut xml, fp, *size);
                                }
                            }
                        } else {
                            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found").await;
                            return;
                        }
                        xml.push_str("</D:multistatus>");
                        let resp = format!(
                            "HTTP/1.1 207 Multi-Status\r\nContent-Type: application/xml; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            xml.len(), xml
                        );
                        let _ = socket.write_all(resp.as_bytes()).await;
                        return;
                    }

                    // GET / HEAD
                    let raw_file = path.trim_start_matches("/dav/").trim_start_matches('/');
                    let decoded_file = percent_encoding::percent_decode_str(raw_file).decode_utf8_lossy().trim_matches('/').to_string();

                    let maybe_file = {
                        let files = st.files.read().await;
                        files.get(&decoded_file).cloned().or_else(|| {
                            // Back-compat: a legacy flat URL (/dav/<name>) for a file now mounted
                            // under a category folder, or vice versa — match by basename.
                            let want = basename_of(&decoded_file).to_string();
                            files.values().find(|vf| vf.name == want).cloned()
                        })
                    };

                    let Some(vf) = maybe_file else {
                        let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found").await;
                        return;
                    };

                    let server_cfg = {
                        let cfg = st.config.read().await;
                        cfg.clone()
                    };

                    let Some(cfg) = server_cfg else {
                        let _ = socket.write_all(b"HTTP/1.1 500 Usenet Server Not Configured\r\nContent-Length: 29\r\nConnection: close\r\n\r\nUsenet Server Not Configured").await;
                        return;
                    };

                    let range_hdr = lines.find_map(|l| l.to_ascii_lowercase().strip_prefix("range:").map(|s| s.trim().to_string()));
                    let real_size = vf.size;
                    let (start, end) = match range_hdr.as_deref().and_then(|r| r.strip_prefix("bytes=")) {
                        Some(spec) => {
                            let (a, b) = spec.split_once('-').unwrap_or((spec, ""));
                            if a.trim().is_empty() {
                                // Suffix range "bytes=-N": the LAST N bytes.
                                // Players use this to read MP4 moov / MKV cues.
                                let n = b.trim().parse::<u64>().unwrap_or(0).min(real_size);
                                (real_size.saturating_sub(n), real_size.saturating_sub(1))
                            } else {
                                let s = a.trim().parse::<u64>().unwrap_or(0);
                                let e = if b.trim().is_empty() {
                                    real_size.saturating_sub(1)
                                } else {
                                    b.trim().parse::<u64>().unwrap_or(real_size.saturating_sub(1))
                                        .min(real_size.saturating_sub(1))
                                };
                                (s, e)
                            }
                        }
                        None => (0, real_size.saturating_sub(1)),
                    };

                    if start > end || start >= real_size {
                        let _ = socket.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{real_size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await;
                        return;
                    }

                    let is_range = range_hdr.is_some();
                    let head = format!(
                        "HTTP/1.1 {}\r\nContent-Type: {mime}\r\nAccept-Ranges: bytes\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n",
                        if is_range { "206 Partial Content" } else { "200 OK" },
                        if is_range { format!("Content-Range: bytes {start}-{end}/{real_size}\r\n") } else { String::new() },
                        end - start + 1,
                        mime = mime_for_media_name(&vf.name)
                    );
                    if method.eq_ignore_ascii_case("HEAD") {
                        let _ = socket.write_all(head.as_bytes()).await;
                        return;
                    }

                    // Get a connection slot + a live NNTP connection BEFORE promising 206:
                    // on failure the client receives a real 5xx instead of an empty 206.
                    let Some(_permit) = st.acquire_slot(12).await else {
                        log::warn!(target: "usenet", "Timed out waiting for a free NNTP connection slot");
                        let _ = socket
                            .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 19\r\nConnection: close\r\n\r\nNNTP pool saturated")
                            .await;
                        return;
                    };
                    let epoch = st.epoch();
                    let first = match st.acquire_conn(&cfg).await {
                        Ok(c) => c,
                        Err(e) => {
                            log::error!(target: "usenet", "WebDAV stream NNTP connect failed: {}", e);
                            let _ = socket
                                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 19\r\nConnection: close\r\n\r\nNNTP Connect Failed")
                                .await;
                            return;
                        }
                    };
                    let mut conn: Option<NntpConn> = Some(first);

                    if socket.write_all(head.as_bytes()).await.is_err() {
                        if let Some(c) = conn.take() {
                            st.release_conn_at(c, epoch).await;
                        }
                        return;
                    }

                    let _ = stream_virtual_range(&mut socket, &st, &cfg, &mut conn, &vf, start, end).await;
                    if let Some(c) = conn.take() {
                        st.release_conn_at(c, epoch).await; // only healthy connections remain in `conn`
                    }
                });
            }
        }
    });
}

#[derive(Serialize)]
pub struct UsenetStatus {
    pub configured: bool,
    pub host: String,
    pub port: u16,
    pub mounted_remote: String,
    pub port_8553_active: bool,
    pub files_count: usize,
}

#[tauri::command]
pub async fn usenet_get_status() -> Result<UsenetStatus, String> {
    let engine = get_usenet_engine();
    let cfg = engine.config.read().await;
    let files_count = engine.files.read().await.len();
    let (configured, host, port) = match &*cfg {
        Some(c) => (!c.host.trim().is_empty(), c.host.clone(), c.port),
        None => (false, String::new(), 563),
    };
    let port_active = TcpStream::connect("127.0.0.1:8553").await.is_ok();
    Ok(UsenetStatus {
        configured,
        host,
        port,
        mounted_remote: "usenet-drive".to_string(),
        port_8553_active: port_active,
        files_count,
    })
}

#[tauri::command]
pub async fn usenet_get_config() -> Result<Option<UsenetServerConfig>, String> {
    let engine = get_usenet_engine();
    let cfg = engine.config.read().await;
    Ok(cfg.clone())
}

#[tauri::command]
pub async fn usenet_save_config(config: UsenetServerConfig) -> Result<(), String> {
    let engine = get_usenet_engine();
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&engine.config_path, json).map_err(|e| e.to_string())?;
    let new_cap = config.connections_limit.unwrap_or(10).clamp(2, 20);
    *engine.config.write().await = Some(config);
    engine.pool_epoch.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut g) = engine.conn_sem.write() {
        // New semaphore = new limit applies immediately (up OR down). Permits held by in-flight
        // requests belong to the old semaphore; their stale sockets are dropped via release_conn_at.
        *g = Arc::new(Semaphore::new(new_cap));
    }
    engine.clear_pool().await;
    Ok(())
}

#[tauri::command]
pub async fn usenet_test_connection(config: UsenetServerConfig) -> Result<String, String> {
    let test_fut = async {
        let mut conn = nntp_connect(&config).await?;
        let _ = conn.get_mut().write_all(b"QUIT\r\n").await;
        let _ = conn.get_mut().flush().await;
        Ok::<String, String>(format!(
            "Connected and authenticated successfully! Host: {}",
            config.host
        ))
    };

    tokio::time::timeout(std::time::Duration::from_secs(15), test_fut)
        .await
        .map_err(|_| format!("Connection test to {} timed out after 15 seconds.", config.host))?
}

#[tauri::command]
pub async fn usenet_mount_remote(app: AppHandle, config_path: String) -> Result<String, String> {
    let _ = get_usenet_engine();
    let _ = crate::commands::rclone::rclone_create_webdav_remote(
        app,
        config_path,
        "usenet-drive".to_string(),
        "http://127.0.0.1:8553/dav/".to_string(),
        Some("other".to_string()),
        None,
        None,
    )
    .await?;
    Ok("usenet-drive mounted successfully".to_string())
}

#[tauri::command]
pub async fn search_usenet_indexers(
    query: String,
    omg_user: Option<String>,
    omg_api_key: Option<String>,
    enable_nzbindex: Option<bool>,
) -> Result<UsenetSearchResponse, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) RcloneFlix/2.0")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    let mut indexers = Vec::new();
    let encoded_q = crate::commands::stream_proxy::url_encode(query.trim());

    if let (Some(u), Some(k)) = (omg_user, omg_api_key) {
        if !u.trim().is_empty() && !k.trim().is_empty() {
            let url = format!(
                "https://api.omgwtfnzbs.org/json/?search={}&user={}&api={}",
                encoded_q,
                crate::commands::stream_proxy::url_encode(u.trim()),
                crate::commands::stream_proxy::url_encode(k.trim())
            );
            match client.get(&url).send().await {
                Ok(resp) => {
                    let text = resp.text().await.unwrap_or_default();
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(arr) = json.as_array() {
                            let mut count = 0;
                            for item in arr {
                                let id = item.get("nzbid").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let title = item.get("release").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let size_bytes = item.get("sizebytes").and_then(|v| v.as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| v.as_u64())).unwrap_or(0);
                                let nzb_url = item.get("getnzb").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| {
                                    format!("https://api.omgwtfnzbs.org/nzb/?id={}&user={}&api={}", id, u.trim(), k.trim())
                                });
                                if !title.is_empty() {
                                    count += 1;
                                    results.push(UsenetSearchResult {
                                        indexer: "omgwtfnzbs".to_string(),
                                        id,
                                        title,
                                        size_bytes,
                                        published_at: item.get("usenetage").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                        nzb_url,
                                    });
                                }
                            }
                            indexers.push(IndexerHealth {
                                name: "OMGWTFNZBs".to_string(),
                                active: true,
                                hits: count,
                                error: None,
                            });
                        } else if let Some(err_obj) = json.as_object() {
                            let err_msg = err_obj.get("notice").or_else(|| err_obj.get("error")).and_then(|v| v.as_str()).unwrap_or("API Error");
                            indexers.push(IndexerHealth {
                                name: "OMGWTFNZBs".to_string(),
                                active: false,
                                hits: 0,
                                error: Some(err_msg.to_string()),
                            });
                        }
                    } else {
                        indexers.push(IndexerHealth {
                            name: "OMGWTFNZBs".to_string(),
                            active: false,
                            hits: 0,
                            error: Some("Invalid JSON response".to_string()),
                        });
                    }
                }
                Err(e) => {
                    indexers.push(IndexerHealth {
                        name: "OMGWTFNZBs".to_string(),
                        active: false,
                        hits: 0,
                        error: Some(e.to_string()),
                    });
                }
            }
        }
    }

    if enable_nzbindex.unwrap_or(true) {
        let rss_url = format!("https://nzbindex.nl/rss/?q={}&nzblink=1&max=40&sort=agedesc", encoded_q);
        match client.get(&rss_url).send().await {
            Ok(resp) => {
                let xml = resp.text().await.unwrap_or_default();
                let mut count = 0;
                for item_block in xml.split("<item>").skip(1) {
                    let end_idx = item_block.find("</item>").unwrap_or(item_block.len());
                    let block = &item_block[..end_idx];
                    let title = extract_xml_tag(block, "title").unwrap_or_default();
                    let pub_date = extract_xml_tag(block, "pubDate").unwrap_or_default();
                    let (enclosure_url, length_bytes) = extract_enclosure(block);
                    let nzb_url = enclosure_url.or_else(|| extract_xml_tag(block, "link")).unwrap_or_default();
                    if !title.is_empty() && nzb_url.starts_with("http") {
                        count += 1;
                        results.push(UsenetSearchResult {
                            indexer: "nzbindex".to_string(),
                            id: format!("nzbindex-{}", count),
                            title,
                            size_bytes: length_bytes,
                            published_at: pub_date,
                            nzb_url,
                        });
                    }
                }
                indexers.push(IndexerHealth {
                    name: "NZBIndex.nl".to_string(),
                    active: true,
                    hits: count,
                    error: None,
                });
            }
            Err(e) => {
                indexers.push(IndexerHealth {
                    name: "NZBIndex.nl".to_string(),
                    active: false,
                    hits: 0,
                    error: Some(e.to_string()),
                });
            }
        }
    }

    Ok(UsenetSearchResponse { results, indexers })
}

fn extract_xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim().to_string())
}

fn extract_enclosure(xml: &str) -> (Option<String>, u64) {
    if let Some(start) = xml.find("<enclosure") {
        if let Some(end) = xml[start..].find("/>") {
            let tag = &xml[start..start + end + 2];
            let url = extract_attr(tag, "url");
            let len = extract_attr(tag, "length").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            return (url, len);
        }
    }
    (None, 0)
}

fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let pattern = format!("{attr}=\"");
    let start = tag.find(&pattern)? + pattern.len();
    let end = tag[start..].find('"')? + start;
    Some(tag[start..end].to_string())
}

fn probe_workers(limit: usize) -> usize {
    limit.saturating_sub(2).clamp(1, 6)
}

#[tauri::command]
pub async fn parse_nzb_media_files(
    nzb_xml: Option<String>,
    nzb_url: Option<String>,
    password: Option<String>,
    virtual_dir: Option<String>,
) -> Result<Vec<PlayableFile>, String> {
    let engine = get_usenet_engine();
    let cfg = engine
        .config
        .read()
        .await
        .clone()
        .ok_or("Usenet provider is not configured. Please configure it in Settings first.")?;

    let nzb_content = match nzb_xml {
        Some(x) if !x.trim().is_empty() => x,
        _ => {
            let u = nzb_url.ok_or("Neither nzb_xml nor nzb_url was provided")?;
            let client = reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (X11; Linux x86_64) RcloneFlix/2.0")
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?;
            client
                .get(&u)
                .send()
                .await
                .map_err(|e| e.to_string())?
                .text()
                .await
                .map_err(|e| e.to_string())?
        }
    };

    let mut raw_files = Vec::new();
    for file_block in nzb_content.split("<file ").skip(1) {
        let end_file = file_block.find("</file>").unwrap_or(file_block.len());
        let block = &file_block[..end_file];
        let raw_subject = extract_attr(block, "subject").unwrap_or_default();
        let mut filename = extract_clean_subject_filename(&raw_subject);
        if filename.is_empty() {
            filename = xml_unescape(&raw_subject);
        }

        let mut segments = Vec::new();
        for seg_block in block.split("<segment ").skip(1) {
            let end_seg = seg_block.find("</segment>").unwrap_or(seg_block.len());
            let seg_str = &seg_block[..end_seg];
            let bytes = extract_attr(seg_str, "bytes").and_then(|b| b.parse::<u64>().ok()).unwrap_or(0);
            let number = extract_attr(seg_str, "number").and_then(|n| n.parse::<u32>().ok()).unwrap_or(0);
            let msg_id = match seg_str.find('>') {
                Some(start) => xml_unescape(seg_str[start + 1..].trim()),
                None => String::new(),
            };
            if !msg_id.is_empty() {
                segments.push(NzbSegment { number, bytes, message_id: msg_id });
            }
        }
        segments.sort_by_key(|s| s.number);
        if !segments.is_empty() {
            raw_files.push((filename, segments));
        }
    }

    if raw_files.is_empty() {
        return Err("No usable segments found in NZB".to_string());
    }

    // Junk (.par2/.nfo/.sfv/samples…) is dropped BEFORE touching the news server.
    let media_files: Vec<(String, Vec<NzbSegment>)> =
        raw_files.into_iter().filter(|(name, _)| !is_junk_name(name)).collect();
    if media_files.is_empty() {
        return Err("Release contains only repair/metadata files (no media members)".to_string());
    }

    let total_conns = cfg.connections_limit.unwrap_or(6).clamp(1, 50);
    let worker_count = probe_workers(total_conns).min(media_files.len());
    let queue = Arc::new(Mutex::new(
        media_files.into_iter().enumerate().collect::<VecDeque<_>>(),
    ));

    type RarScan = Result<(rar::Volume, Vec<rar::Entry>), String>;
    type Probed = (usize, Volume, Vec<u8>, Option<RarScan>);

    let mut handles = Vec::new();
    for _ in 0..worker_count {
        let queue = Arc::clone(&queue);
        let cfg = cfg.clone();
        let eng = Arc::clone(&engine);
        let pw = password.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let mut out: Vec<Probed> = Vec::new();
            let Some(_permit) = eng.acquire_slot(20).await else {
                log::warn!(target: "usenet", "NZB probe worker: no free NNTP slot within 20s");
                return out;
            };
            let epoch = eng.epoch();
            let mut conn: Option<NntpConn> = match eng.acquire_conn(&cfg).await {
                Ok(c) => Some(c),
                Err(e) => {
                    log::warn!(target: "usenet", "NZB probe worker could not connect: {e}");
                    return out;
                }
            };
            loop {
                let item = { queue.lock().await.pop_front() };
                let Some((idx, (name, segments))) = item else { break };
                let first_id = segments[0].message_id.clone();

                // First article: gives exact size (=ybegin size=) and decoded segment size.
                let mut got = None;
                for attempt in 0..2 {
                    if conn.is_none() {
                        conn = if attempt == 0 {
                            eng.acquire_conn(&cfg).await.ok()
                        } else {
                            nntp_connect(&cfg).await.ok()
                        };
                    }
                    let Some(c) = conn.as_mut() else { break };
                    match nntp_body(c, &first_id).await {
                        Ok(v) => {
                            got = Some(v);
                            break;
                        }
                        Err(e) => {
                            log::warn!(target: "usenet", "Probe of {name} attempt {} failed: {e}", attempt + 1);
                            let missing = e.starts_with("NNTP BODY failed:")
                                && (e.contains(" 430") || e.contains(" 423"));
                            if missing {
                                break; // socket still valid
                            }
                            conn = None; // desynchronised: drop, reconnect on next attempt
                        }
                    }
                }
                if conn.is_none() && got.is_none() {
                    break; // cannot connect at all: let the other workers carry on
                }
                let Some((first_data, total_size, _)) = got else {
                    log::warn!(target: "usenet", "Skipping unreadable member {name}");
                    continue;
                };

                let seg_size = first_data.len() as u64;
                if seg_size == 0 {
                    log::warn!(target: "usenet", "Empty first segment for {name}; skipping member");
                    continue;
                }
                // Only the first/video member's opening segment is worth keeping resident:
                // it is exactly what the player requests first.
                if idx == 0 || is_video_name(&name) {
                    eng.put_cached_segment(&first_id, Arc::new(first_data.clone())).await;
                }

                let total_bytes = total_size.unwrap_or(seg_size * segments.len() as u64);
                let magic = first_data[..first_data.len().min(16)].to_vec();
                let vol = Volume { name, segments, size: total_bytes, seg_size };

                let rar_scan = if rar_name(&vol.name) || magic_is_rar(&magic) {
                    Some(scan_rar_volume_fast(&eng, &cfg, &mut conn, &vol, first_data, pw.as_deref()).await)
                } else {
                    None
                };
                out.push((idx, vol, magic, rar_scan));
            }
            if let Some(c) = conn.take() {
                eng.release_conn_at(c, epoch).await;
            }
            out
        }));
    }

    let mut probed: Vec<Probed> = Vec::new();
    for h in handles {
        if let Ok(part) = h.await {
            probed.extend(part);
        }
    }
    if probed.is_empty() {
        return Err("Could not read any media member of this release from the news server".to_string());
    }
    probed.sort_by_key(|p| p.0);

    let mut scans = Vec::new();
    let mut rar_errors: Vec<String> = Vec::new();
    for (_, vol, _, scan) in &probed {
        match scan {
            Some(Ok((header, entries))) => scans.push((vol.clone(), header.clone(), entries.clone())),
            Some(Err(e)) => rar_errors.push(e.clone()),
            None => {}
        }
    }

    let mut virtual_files = Vec::new();
    if !scans.is_empty() {
        match rar_members_to_virtual(scans) {
            Ok(vfs) => virtual_files.extend(vfs),
            Err(e) => {
                log::warn!(target: "usenet", "RAR assembly: {e}");
                rar_errors.push(e);
            }
        }
    }

    if virtual_files.is_empty() {
        for (_, vol, magic, _) in probed {
            if is_video_name(&vol.name) || magic_is_video(&magic) {
                let size = vol.size;
                let mut name = vol.name.clone();
                if !is_video_name(&name) {
                    // obfuscated release: give the mount a playable extension from the magic bytes
                    let ext = if magic.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
                        "mkv"
                    } else if magic.starts_with(b"RIFF") {
                        "avi"
                    } else {
                        "mp4"
                    };
                    name = format!("{name}.{ext}");
                }
                virtual_files.push(VirtualFile {
                    name,
                    size,
                    volumes: vec![vol],
                    parts: vec![Part { volume: 0, vol_offset: 0, len: size }],
                    virtual_path: None,
                });
            }
        }
    }

    let vdir = virtual_dir.as_deref().and_then(sanitize_virtual_dir);
    let mut playables = Vec::new();
    let mut files_lock = engine.files.write().await;
    for mut vf in virtual_files {
        let vp = vdir.as_ref().map(|d| format!("{d}/{}", vf.name));
        vf.virtual_path = vp.clone();
        playables.push(PlayableFile {
            name: vf.name.clone(),
            size: vf.size,
            kind: "video".to_string(),
            warning: None,
            virtual_path: vp.clone(),
        });
        let key = vp.unwrap_or_else(|| vf.name.clone());
        files_lock.insert(key, vf);
    }
    if playables.is_empty() {
        drop(files_lock);
        return Err(rar_errors
            .into_iter()
            .next()
            .unwrap_or_else(|| "No playable video members found in release".to_string()));
    }
    if let Ok(json) = serde_json::to_string(&*files_lock) {
        let _ = std::fs::write(&engine.mounts_path, json);
    }
    drop(files_lock);

    log::info!(
        target: "usenet",
        "Mounted {} playable virtual file(s): {}",
        playables.len(),
        playables.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")
    );
    Ok(playables)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescape_entities() {
        assert_eq!(xml_unescape("&quot;a&quot; &amp; &#34;b&#34; &#x41; &lt;&gt; &bogus;"), "\"a\" & \"b\" A <> &bogus;");
        assert_eq!(xml_unescape("&amp;quot;"), "&quot;"); // no double-decode
    }

    #[test]
    fn subject_filename() {
        assert_eq!(
            extract_clean_subject_filename("TV Shows/X/&quot;Scrubs.S02E08.mkv&quot; yEnc (1/1444)"),
            "Scrubs.S02E08.mkv"
        );
        assert_eq!(extract_clean_subject_filename("[7/7] - &quot;Abbott.mkv&quot; yEnc (1/1480)"), "Abbott.mkv");
        assert_eq!(extract_clean_subject_filename("Some.Release.part01.rar yEnc (1/50)"), "Some.Release.part01.rar");
    }

    #[test]
    fn heal_only_dirty_names() {
        let mk = |name: &str, vp: Option<&str>| VirtualFile {
            name: name.to_string(),
            size: 1,
            volumes: vec![],
            parts: vec![],
            virtual_path: vp.map(|s| s.to_string()),
        };
        let dirty = "&quot;A.mkv&quot; yEnc (1/9)";
        let mut m = HashMap::new();
        m.insert(format!("TV Shows/{dirty}"), mk(dirty, Some(&format!("TV Shows/{dirty}"))));
        m.insert("Movies/Show \"Q\" 1.mkv".to_string(), mk("Show \"Q\" 1.mkv", Some("Movies/Show \"Q\" 1.mkv")));
        let (h, changed) = heal_persisted_mounts(m);
        assert!(changed);
        assert!(h.contains_key("TV Shows/A.mkv"));
        assert!(h.contains_key("Movies/Show \"Q\" 1.mkv")); // untouched
    }

    #[test]
    fn rar_numbers() {
        assert_eq!(infer_rar_volume_number("x.part01.rar"), Some(0));
        assert_eq!(infer_rar_volume_number("x.part12.rar"), Some(11));
        assert_eq!(infer_rar_volume_number("x.rar"), Some(0));
        assert_eq!(infer_rar_volume_number("x.r00"), Some(1));
        assert_eq!(infer_rar_volume_number("a1b2c3"), None);
    }

    #[test]
    fn probe_workers_reserves_slots() {
        assert_eq!(probe_workers(4), 2);
        assert_eq!(probe_workers(2), 1);
        assert_eq!(probe_workers(1), 1);
        assert_eq!(probe_workers(20), 6);
    }
}
