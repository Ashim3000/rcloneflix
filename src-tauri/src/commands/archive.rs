use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use crate::process_ext::{std_command, tokio_command};

/// Extracts an archive (.zip, .rar, .tar, .tar.gz) into destination_dir
#[tauri::command]
pub async fn extract_archive(
    archive_path: String,
    destination_dir: String,
) -> Result<String, String> {
    let archive = Path::new(&archive_path);
    if !archive.exists() {
        return Err(format!("Archive file not found: {}", archive_path));
    }

    let dest = Path::new(&destination_dir);
    if !dest.exists() {
        std::fs::create_dir_all(dest)
            .map_err(|e| format!("Failed to create destination dir: {}", e))?;
    }

    let lower = archive_path.to_lowercase();

    if lower.ends_with(".zip") {
        // Try unzip first
        let unzip_status = std_command("unzip")
            .args(["-o", "-q", &archive_path, "-d", &destination_dir])
            .status();

        if let Ok(status) = unzip_status {
            if status.success() {
                return Ok(format!("Successfully extracted ZIP to {}", destination_dir));
            }
        }

        // Try tar -xf (Windows 10/11 built-in and Unix bsdtar)
        if let Ok(s) = std_command("tar").args(["-xf", &archive_path, "-C", &destination_dir]).status() {
            if s.success() {
                return Ok(format!("Successfully extracted ZIP via tar to {}", destination_dir));
            }
        }

        // Fallback to python3 / python
        let py_script = format!(
            "import zipfile; zipfile.ZipFile(r'''{}''').extractall(r'''{}''')",
            archive_path, destination_dir
        );
        for py in ["python3", "python"] {
            if let Ok(out) = std_command(py).args(["-c", &py_script]).output() {
                if out.status.success() {
                    return Ok(format!("Successfully extracted ZIP via {} to {}", py, destination_dir));
                }
            }
        }

        // Fallback to 7z
        let z_res = std_command("7z")
            .args(["x", "-y", &archive_path, &format!("-o{}", destination_dir)])
            .output();
        if let Ok(out) = z_res {
            if out.status.success() {
                return Ok(format!("Successfully extracted ZIP via 7z to {}", destination_dir));
            }
        }

        return Err("Failed to extract ZIP archive: no working extraction utility found (unzip, tar, python, 7z)".into());
    } else if lower.ends_with(".tar") || lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        let status = std_command("tar")
            .args(["-xf", &archive_path, "-C", &destination_dir])
            .status();
        if let Ok(status) = status {
            if status.success() {
                return Ok(format!("Successfully extracted TAR archive to {}", destination_dir));
            }
        }
        return Err("Failed to extract TAR archive".into());
    } else if lower.ends_with(".rar") {
        // Try unrar first
        let unrar_res = std_command("unrar")
            .args(["x", "-o+", "-y", &archive_path, &format!("{}/", destination_dir)])
            .output();
        if let Ok(out) = unrar_res {
            if out.status.success() {
                return Ok(format!("Successfully extracted RAR to {}", destination_dir));
            }
        }

        // Try 7z
        let z_res = std_command("7z")
            .args(["x", "-y", &archive_path, &format!("-o{}", destination_dir)])
            .output();
        if let Ok(out) = z_res {
            if out.status.success() {
                return Ok(format!("Successfully extracted RAR via 7z to {}", destination_dir));
            }
        }

        return Err("Failed to extract RAR: please ensure unrar or 7z is installed".into());
    }

    Err(format!("Unsupported archive format: {}", archive_path))
}

fn collect_images_recursively(dir: &Path, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                collect_images_recursively(&p, out);
            } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                let lower = ext.to_lowercase();
                if matches!(lower.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "avif" | "bmp") {
                    out.push(p.to_string_lossy().into_owned());
                }
            }
        }
    }
}

/// Extracts a .cbz (ZIP) or .cbr (RAR/ZIP) comic archive into a temp session folder
/// and returns naturally sorted absolute paths to each image page.
#[tauri::command]
pub async fn extract_comic_pages(
    archive_path: String,
    session_id: String,
) -> Result<Vec<String>, String> {
    let archive = Path::new(&archive_path);
    if !archive.exists() {
        return Err(format!("Comic file not found: {}", archive_path));
    }

    let safe_sid: String = session_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let dest_dir = std::env::temp_dir()
        .join("rcloneflix-books")
        .join(if safe_sid.is_empty() { "comic" } else { &safe_sid })
        .join("pages");

    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create comic temp dir: {}", e))?;

    let dest_str = dest_dir.to_string_lossy().into_owned();

    // Inspect magic bytes first (many .cbr files are actually ZIP archives with PK\x03\x04)
    let header = std::fs::read(&archive_path)
        .map(|b| b.into_iter().take(8).collect::<Vec<u8>>())
        .unwrap_or_default();
    let is_zip_magic = header.starts_with(b"PK\x03\x04");
    let lower = archive_path.to_lowercase();

    let mut extracted = false;

    if is_zip_magic || lower.ends_with(".cbz") || lower.ends_with(".zip") {
        // In-process first (no subprocess spawn; works without unzip/python —
        // notably on Windows), external tools as fallback.
        let in_process: Result<(), String> = (|| {
            let f = std::fs::File::open(&archive_path).map_err(|e| e.to_string())?;
            let mut zip = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
            for i in 0..zip.len() {
                let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
                if !entry.is_file() {
                    continue;
                }
                let name = entry.name().to_string();
                if name.contains("__MACOSX") || !is_comic_image_entry(&name) {
                    continue;
                }
                // Flatten subdirs but keep the full path in the name so the
                // natural sort below still orders pages correctly.
                let mut flat = name.replace(['/', '\\'], "_");
                flat.truncate(180);
                let out_path = dest_dir.join(flat);
                let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if in_process.is_ok() {
            let mut check = Vec::new();
            collect_images_recursively(&dest_dir, &mut check);
            extracted = !check.is_empty();
        }
        if !extracted {
            if let Ok(s) = std_command("unzip").args(["-o", "-q", &archive_path, "-d", &dest_str]).status() {
                if s.success() {
                    extracted = true;
                }
            }
        }
        if !extracted {
            let _ = std_command("tar").args(["-xf", &archive_path, "-C", &dest_str]).status();
        }
        if !extracted {
            let py_script = format!(
                "import zipfile; zipfile.ZipFile(r'''{}''').extractall(r'''{}''')",
                archive_path, dest_str
            );
            for py in ["python3", "python"] {
                if let Ok(out) = std_command(py).args(["-c", &py_script]).output() {
                    if out.status.success() {
                        extracted = true;
                        break;
                    }
                }
            }
        }
        if !extracted {
            if let Ok(out) = std_command("7z").args(["x", "-y", &archive_path, &format!("-o{}", dest_str)]).output() {
                if out.status.success() {
                    extracted = true;
                }
            }
        }
    }

    if !extracted {
        // Try RAR / universal extractors (unrar, 7z, bsdtar/tar, unar)
        if let Ok(out) = std_command("unrar").args(["x", "-o+", "-y", &archive_path, &format!("{}/", dest_str)]).output() {
            if out.status.success() {
                extracted = true;
            }
        }
        if !extracted {
            if let Ok(out) = std_command("7z").args(["x", "-y", &archive_path, &format!("-o{}", dest_str)]).output() {
                if out.status.success() {
                    extracted = true;
                }
            }
        }
        if !extracted {
            if let Ok(out) = std_command("unar").args(["-f", "-o", &dest_str, &archive_path]).output() {
                if out.status.success() {
                    extracted = true;
                }
            }
        }
        if !extracted {
            let _ = std_command("tar").args(["-xf", &archive_path, "-C", &dest_str]).status();
        }
    }

    let mut images = Vec::new();
    collect_images_recursively(&dest_dir, &mut images);

    if images.is_empty() {
        return Err("Could not extract comic pages. For RAR (.cbr) archives on desktop, ensure 'unrar' or '7z' is installed.".into());
    }

    // Natural sort so page2.jpg comes before page10.jpg
    images.sort_by(|a, b| natord_cmp(a, b));
    Ok(images)
}

// ─── Progressive comic download ──────────────────────────────────────────────
// For archives that cannot be range-streamed (compressed RAR .cbr — the common
// case for scene-released comics), downloading the whole file before showing
// anything means minutes of blank screen on slow remotes. Instead: stream the
// archive to temp in sequential 4 MB ranged chunks, run a tolerant partial
// extraction every ~8 MB (unrar skips already-extracted entries and deletes
// incomplete ones), and expose the growing page list through a poll command so
// the reader can show page 1 after the first few MB.

#[derive(Clone, Default)]
struct ProgressiveComicState {
    downloaded: u64,
    total: Option<u64>,
    done: bool,
    error: Option<String>,
    pages: Vec<String>,
    cancelled: bool,
}

#[derive(serde::Serialize)]
pub struct ProgressiveComicStatus {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub done: bool,
    pub error: Option<String>,
    pub pages: Vec<String>,
}

static PROGRESSIVE_COMICS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, ProgressiveComicState>>> =
    std::sync::OnceLock::new();

fn progressive_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, ProgressiveComicState>> {
    PROGRESSIVE_COMICS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn sanitize_session_id(session_id: &str) -> String {
    let s: String = session_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if s.is_empty() { "comic".to_string() } else { s }
}

/// Tolerant extraction of a possibly-truncated archive. Complete entries are
/// extracted, already-extracted ones skipped, incomplete ones dropped (unrar's
/// default removes broken output, so a half-written page is retried next round).
fn partial_extract_pages(archive_path: &Path, dest_dir: &Path) -> Vec<String> {
    let _ = std::fs::create_dir_all(dest_dir);
    let dest_str = dest_dir.to_string_lossy().into_owned();
    let arch_str = archive_path.to_string_lossy().into_owned();

    let magic = std::fs::File::open(archive_path)
        .and_then(|mut f| {
            use std::io::Read;
            let mut b = [0u8; 4];
            f.read_exact(&mut b).map(|_| b)
        })
        .unwrap_or_default();

    if magic.starts_with(b"PK\x03\x04") {
        // Truncated ZIP: unzip extracts what exists and errors at the end — ignore status.
        let _ = std_command("unzip").args(["-o", "-q", &arch_str, "-d", &dest_str]).output();
    } else {
        // RAR: -o- skips entries already extracted in a previous round; broken
        // (truncated) outputs are removed by default and retried next round.
        // 7z (-aos = skip existing) only when the unrar binary itself is absent.
        if std_command("unrar").args(["x", "-o-", "-y", &arch_str, &format!("{}/", dest_str)]).output().is_err() {
            let _ = std_command("7z").args(["x", "-aos", "-y", &arch_str, &format!("-o{}", dest_str)]).output();
        }
    }

    let mut images = Vec::new();
    collect_images_recursively(dest_dir, &mut images);
    images.sort_by(|a, b| natord_cmp(a, b));
    images
}

#[tauri::command]
pub async fn start_progressive_comic_download(
    stream_url: String,
    session_id: String,
) -> Result<(), String> {
    let sid = sanitize_session_id(&session_id);
    let base = std::env::temp_dir().join("rcloneflix-books").join(&sid);
    std::fs::create_dir_all(&base).map_err(|e| format!("temp dir: {e}"))?;
    let archive_path = base.join("archive.part");
    let dest_dir = base.join("pages");
    let _ = std::fs::remove_file(&archive_path);

    progressive_map().lock().unwrap().insert(sid.clone(), ProgressiveComicState::default());

    // tokio::spawn, not tauri::async_runtime::spawn: commands already execute on the
    // app's tokio runtime, and this also runs under a plain tokio runtime in tests.
    tokio::spawn(async move {
        let set_err = |msg: String| {
            if let Ok(mut m) = progressive_map().lock() {
                if let Some(st) = m.get_mut(&sid) {
                    st.error = Some(msg);
                    st.done = true;
                }
            }
        };

        let client = match reqwest::Client::builder().build() {
            Ok(c) => c,
            Err(e) => return set_err(format!("HTTP client error: {e}")),
        };

        // First chunk + first extraction are small so page 1 appears after ~2 MB;
        // the rescan cadence then doubles up to 16 MB to keep repeated tolerant
        // extractions cheap on big archives.
        const CHUNK: u64 = 4 * 1024 * 1024;
        const FIRST_CHUNK: u64 = 2 * 1024 * 1024;
        const MAX_EXTRACT_INTERVAL: u64 = 16 * 1024 * 1024;
        let mut extract_interval: u64 = FIRST_CHUNK;
        let mut offset: u64 = 0;
        let mut total: Option<u64> = None;
        let mut last_extract_at: u64 = 0;

        let mut file = match std::fs::OpenOptions::new().create(true).append(true).open(&archive_path) {
            Ok(f) => f,
            Err(e) => return set_err(format!("temp file: {e}")),
        };

        loop {
            // Cancellation check between chunks
            if progressive_map().lock().map(|m| m.get(&sid).map(|s| s.cancelled).unwrap_or(true)).unwrap_or(true) {
                return;
            }
            if let Some(t) = total {
                if offset >= t {
                    break;
                }
            }

            let end = offset + (if offset == 0 { FIRST_CHUNK } else { CHUNK }) - 1;
            let resp = match client
                .get(&stream_url)
                .header("Range", format!("bytes={offset}-{end}"))
                .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => return set_err(format!("download failed at {offset}: {e}")),
            };
            let status = resp.status().as_u16();
            if status == 416 {
                break; // ran past EOF (total unknown)
            }
            if status != 206 && status != 200 {
                return set_err(format!("download failed: HTTP {status}"));
            }
            if total.is_none() {
                total = resp
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|cr| cr.rsplit('/').next().and_then(|s| s.trim().parse::<u64>().ok()));
                if let Ok(mut m) = progressive_map().lock() {
                    if let Some(st) = m.get_mut(&sid) {
                        st.total = total;
                    }
                }
            }
            let bytes = match resp.bytes().await {
                Ok(b) => b,
                Err(e) => return set_err(format!("read failed at {offset}: {e}")),
            };
            if bytes.is_empty() {
                break;
            }
            {
                use std::io::Write;
                if let Err(e) = file.write_all(&bytes) {
                    return set_err(format!("write failed: {e}"));
                }
                let _ = file.flush();
            }
            offset += bytes.len() as u64;
            let finished = total.is_some_and(|t| offset >= t) || (status == 200 && total.is_none());
            if let Ok(mut m) = progressive_map().lock() {
                if let Some(st) = m.get_mut(&sid) {
                    st.downloaded = offset;
                }
            }

            if finished || offset.saturating_sub(last_extract_at) >= extract_interval {
                last_extract_at = offset;
                extract_interval = (extract_interval * 2).min(MAX_EXTRACT_INTERVAL);
                let ap = archive_path.clone();
                let dd = dest_dir.clone();
                let pages = tokio::task::spawn_blocking(move || partial_extract_pages(&ap, &dd))
                    .await
                    .unwrap_or_default();
                if let Ok(mut m) = progressive_map().lock() {
                    if let Some(st) = m.get_mut(&sid) {
                        if st.cancelled {
                            return;
                        }
                        st.pages = pages;
                    }
                }
            }
            if finished {
                break;
            }
        }

        // Final pass + completion flag
        let ap = archive_path.clone();
        let dd = dest_dir.clone();
        let pages = tokio::task::spawn_blocking(move || partial_extract_pages(&ap, &dd))
            .await
            .unwrap_or_default();
        if let Ok(mut m) = progressive_map().lock() {
            if let Some(st) = m.get_mut(&sid) {
                if pages.is_empty() && st.error.is_none() {
                    st.error = Some("No comic pages could be extracted from this archive (is unrar installed?)".to_string());
                } else {
                    st.pages = pages;
                }
                st.done = true;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn comic_progressive_status(session_id: String) -> Result<ProgressiveComicStatus, String> {
    let sid = sanitize_session_id(&session_id);
    let m = progressive_map().lock().map_err(|_| "state lock poisoned".to_string())?;
    let st = m.get(&sid).ok_or("No progressive session")?;
    Ok(ProgressiveComicStatus {
        downloaded: st.downloaded,
        total: st.total,
        done: st.done,
        error: st.error.clone(),
        pages: st.pages.clone(),
    })
}

#[tauri::command]
pub async fn cancel_progressive_comic(session_id: String) -> Result<(), String> {
    let sid = sanitize_session_id(&session_id);
    if let Ok(mut m) = progressive_map().lock() {
        if let Some(st) = m.get_mut(&sid) {
            st.cancelled = true;
        }
    }
    Ok(())
}

fn natord_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut ia = a.chars().peekable();
    let mut ib = b.chars().peekable();
    loop {
        match (ia.peek(), ib.peek()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(&ca), Some(&cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let mut na = String::new();
                    let mut nb = String::new();
                    while let Some(&d) = ia.peek() {
                        if d.is_ascii_digit() {
                            na.push(d);
                            ia.next();
                        } else {
                            break;
                        }
                    }
                    while let Some(&d) = ib.peek() {
                        if d.is_ascii_digit() {
                            nb.push(d);
                            ib.next();
                        } else {
                            break;
                        }
                    }
                    let va = na.parse::<u64>().unwrap_or(0);
                    let vb = nb.parse::<u64>().unwrap_or(0);
                    match va.cmp(&vb) {
                        std::cmp::Ordering::Equal => continue,
                        ord => return ord,
                    }
                } else {
                    let la = ca.to_ascii_lowercase();
                    let lb = cb.to_ascii_lowercase();
                    match la.cmp(&lb) {
                        std::cmp::Ordering::Equal => {
                            ia.next();
                            ib.next();
                        }
                        ord => return ord,
                    }
                }
            }
        }
    }
}

use std::io::Read;
use base64::prelude::*;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct RemoteZipPageEntry {
    pub name: String,
    /// 0 = ZIP stored, 8 = ZIP deflate, 99 = stored RAR entry (raw image bytes
    /// at local_header_offset), 100 = compressed non-solid RAR entry
    /// (local_header_offset = entry HEADER start; compressed_size = the whole
    /// header+data span; archive_prefix_len bytes from offset 0 must be
    /// prepended to form a valid single-entry archive).
    pub compression_method: u16,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_header_offset: u64,
    /// Only used by method 100. serde(default) keeps old persisted manifests valid.
    #[serde(default)]
    pub archive_prefix_len: u64,
}

fn is_comic_image_entry(name: &str) -> bool {
    if name.ends_with('/') || name.contains("__MACOSX") {
        return false;
    }
    if let Some(base) = name.rsplit('/').next() {
        if base.starts_with('.') {
            return false;
        }
    }
    let lower = name.to_lowercase();
    lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".png")
        || lower.ends_with(".webp")
        || lower.ends_with(".gif")
        || lower.ends_with(".avif")
        || lower.ends_with(".bmp")
}

fn mime_for_image_name(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".avif") {
        "image/avif"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else {
        "image/jpeg"
    }
}

fn read_u16_le(buf: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([buf[offset], buf[offset + 1]])
}

fn read_u32_le(buf: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]])
}

const COMIC_CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const COMIC_CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn comic_cache_root() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return std::path::PathBuf::from(local_app_data)
            .join("rcloneflix")
            .join("cache")
            .join("comics");
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(xdg) = std::env::var_os("XDG_CACHE_HOME") {
            if !xdg.is_empty() {
                return std::path::PathBuf::from(xdg).join("rcloneflix").join("comics");
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            if !home.is_empty() {
                return std::path::PathBuf::from(home)
                    .join(".cache")
                    .join("rcloneflix")
                    .join("comics");
            }
        }
    }
    std::env::temp_dir().join("rcloneflix-comic-cache")
}

fn sanitize_cache_key(raw: &str) -> Option<String> {
    let clean: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(120)
        .collect();
    if clean.is_empty() { None } else { Some(clean) }
}

fn is_cache_fresh(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    let Ok(age) = std::time::SystemTime::now().duration_since(modified) else {
        return true;
    };
    age.as_secs() < COMIC_CACHE_TTL_SECS
}

fn dir_size_bytes(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            total = total.saturating_add(dir_size_bytes(&p));
        } else if let Ok(m) = entry.metadata() {
            total = total.saturating_add(m.len());
        }
    }
    total
}

fn prune_comic_cache(root: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    let now = std::time::SystemTime::now();
    let mut active: Vec<(std::time::SystemTime, u64, std::path::PathBuf)> = Vec::new();
    let mut total_bytes = 0u64;

    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let expired = now
            .duration_since(mtime)
            .map(|d| d.as_secs() >= COMIC_CACHE_TTL_SECS)
            .unwrap_or(false);
        if expired {
            let _ = std::fs::remove_dir_all(&p);
            continue;
        }
        let sz = dir_size_bytes(&p);
        total_bytes = total_bytes.saturating_add(sz);
        active.push((mtime, sz, p));
    }

    if total_bytes > COMIC_CACHE_MAX_BYTES {
        active.sort_by_key(|(mtime, _, _)| *mtime);
        for (_, sz, p) in active {
            if total_bytes <= COMIC_CACHE_MAX_BYTES {
                break;
            }
            let _ = std::fs::remove_dir_all(&p);
            total_bytes = total_bytes.saturating_sub(sz);
        }
    }
}

fn save_manifest_cache(cache_key: &Option<String>, entries: &[RemoteZipPageEntry]) {
    let Some(key) = cache_key.as_deref().and_then(sanitize_cache_key) else {
        return;
    };
    let root = comic_cache_root();
    let book_dir = root.join(&key);
    if std::fs::create_dir_all(&book_dir).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_vec(entries) {
        let tmp = book_dir.join("manifest.json.tmp");
        let dst = book_dir.join("manifest.json");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &dst);
        }
    }
    prune_comic_cache(&root);
}

/// Fetches only the ZIP Central Directory via HTTP Range requests against `stream_url`
/// (such as `rclone serve http` on 127.0.0.1 or a remote HTTPS .cbz URL) and returns
/// naturally sorted image entries in milliseconds without downloading the full archive.
#[tauri::command]
pub async fn fetch_remote_comic_manifest(
    stream_url: String,
    cache_key: Option<String>,
) -> Result<Vec<RemoteZipPageEntry>, String> {
    if let Some(key) = cache_key.as_deref().and_then(sanitize_cache_key) {
        let manifest_path = comic_cache_root().join(&key).join("manifest.json");
        if is_cache_fresh(&manifest_path) {
            if let Ok(bytes) = std::fs::read(&manifest_path) {
                if let Ok(entries) = serde_json::from_slice::<Vec<RemoteZipPageEntry>>(&bytes) {
                    if !entries.is_empty() {
                        return Ok(entries);
                    }
                }
            }
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // 1. Probe first 16 bytes to identify the archive and extract total file size from
    // Content-Range. 16 bytes covers ZIP (PK\x03\x04, 4 bytes) AND the RAR4/RAR5
    // signatures (7/8 bytes) that infinidysk_archive::detect() matches with starts_with —
    // a 4-byte probe can never satisfy an 8-byte signature, which silently sent every
    // .cbr to the full-download path.
    let probe_resp = client
        .get(&stream_url)
        .header("Range", "bytes=0-15")
        .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
        .send()
        .await
        .map_err(|e| format!("Failed to probe comic stream: {}", e))?;

    let status = probe_resp.status();
    if !status.is_success() && status.as_u16() != 206 {
        return Err(format!("Comic stream returned HTTP {}", status));
    }

    if status.as_u16() == 200
        && probe_resp.headers().get(reqwest::header::CONTENT_RANGE).is_none()
    {
        // Server ignored our Range header. Reading the body here would pull
        // the entire archive into memory; bail to the full-extractor path.
        return Err("Server does not honor HTTP Range requests; falling back to full extractor".to_string());
    }

    let total_size: u64 = if let Some(cr) = probe_resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
    {
        // e.g. "bytes 0-3/154829102"
        cr.rsplit('/')
            .next()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .ok_or_else(|| format!("Invalid Content-Range header: {}", cr))?
    } else {
        // Fallback to HEAD Content-Length
        let head_resp = client
            .head(&stream_url)
            .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
            .send()
            .await
            .map_err(|e| format!("HEAD request failed: {}", e))?;
        head_resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .ok_or_else(|| "Server does not expose Content-Range or Content-Length".to_string())?
    };

    let magic = probe_resp
        .bytes()
        .await
        .map_err(|e| format!("Failed reading probe bytes: {}", e))?;

    // Check if archive is a RAR/CBR archive
    if let Some(format) = infinidysk_archive::detect(&magic) {
        if format == infinidysk_archive::Format::Rar4 || format == infinidysk_archive::Format::Rar5 {
            let mut scanner = infinidysk_archive::rar::Scanner::new();
            let mut current_offset: u64 = 0;
            let mut entries = Vec::new();
            let mut archive_prefix_len: u64 = 0;

            loop {
                let fetch_len: u64 = 65_536.min(total_size.saturating_sub(current_offset));
                if fetch_len == 0 {
                    break;
                }
                let resp = client
                    .get(&stream_url)
                    .header("Range", format!("bytes={}-{}", current_offset, current_offset + fetch_len - 1))
                    .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
                    .send()
                    .await
                    .map_err(|e| format!("Failed fetching RAR header chunk: {}", e))?;
                let chunk_bytes = resp.bytes().await.map_err(|e| format!("Reading RAR chunk failed: {}", e))?;

                match scanner.next(current_offset, &chunk_bytes) {
                    Ok(infinidysk_archive::rar::Step::Need { offset, .. }) => {
                        current_offset = offset;
                    }
                    Ok(infinidysk_archive::rar::Step::Entry(entry)) => {
                        // Everything before the first entry header (signature, main
                        // header, service blocks) is the reusable archive prefix.
                        if archive_prefix_len == 0 {
                            archive_prefix_len = entry.header_start;
                        }
                        if is_comic_image_entry(&entry.name) {
                            if entry.encrypted || entry.split_before || entry.split_after {
                                return Err("CBR entry is encrypted or spans volumes; falling back to full extractor".to_string());
                            }
                            if entry.solid || scanner.volume().solid {
                                // Solid streams need every prior entry decompressed first —
                                // only the progressive sequential path can serve these.
                                return Err("CBR archive uses solid compression; falling back to progressive download".to_string());
                            }
                            let packed_len = entry.data.end.saturating_sub(entry.data.start);
                            if entry.stored {
                                entries.push(RemoteZipPageEntry {
                                    name: entry.name,
                                    compression_method: 99, // stored RAR entry: raw image bytes
                                    compressed_size: packed_len,
                                    uncompressed_size: entry.size.unwrap_or(packed_len),
                                    local_header_offset: entry.data.start,
                                    archive_prefix_len: 0,
                                });
                            } else {
                                // Non-solid compressed entry: YACReader-style random access.
                                // Span = header..data_end, self-contained once the prefix
                                // is prepended (extracted by Item C).
                                entries.push(RemoteZipPageEntry {
                                    name: entry.name,
                                    compression_method: 100,
                                    compressed_size: entry.data.end.saturating_sub(entry.header_start),
                                    uncompressed_size: entry.size.unwrap_or(packed_len),
                                    local_header_offset: entry.header_start,
                                    archive_prefix_len,
                                });
                            }
                        }
                        current_offset = entry.data.end;
                    }
                    Ok(infinidysk_archive::rar::Step::End { .. }) => break,
                    Ok(infinidysk_archive::rar::Step::Key(_)) => {
                        return Err("Password-protected CBR archive; falling back to full extractor".to_string());
                    }
                    Err(err) => {
                        return Err(format!("RAR header scanner failed: {}; falling back", err));
                    }
                }
            }

            if entries.is_empty() {
                return Err("No comic image entries found in CBR archive; falling back".to_string());
            }
            entries.sort_by(|a, b| natord_cmp(&a.name, &b.name));
            save_manifest_cache(&cache_key, &entries);
            return Ok(entries);
        }
    }

    if magic.len() < 4 || &magic[0..4] != b"PK\x03\x04" {
        return Err("Archive is not a standard ZIP/CBZ (may be RAR/CBR); falling back to full extractor".to_string());
    }

    // 2. Fetch the last 65,557 bytes to locate the End of Central Directory (EOCD) record
    let tail_len: u64 = 65_557.min(total_size);
    let tail_start: u64 = total_size.saturating_sub(tail_len);

    let tail_resp = client
        .get(&stream_url)
        .header("Range", format!("bytes={}-{}", tail_start, total_size - 1))
        .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch ZIP tail: {}", e))?;

    if tail_resp.status().as_u16() != 206 {
        return Err("ZIP tail fetch was not ranged (HTTP != 206); falling back".to_string());
    }

    let tail_bytes = tail_resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read ZIP tail bytes: {}", e))?;

    if tail_bytes.len() < 22 {
        return Err("ZIP tail too small to contain EOCD".to_string());
    }

    let mut eocd_pos: Option<usize> = None;
    for i in (0..=tail_bytes.len() - 22).rev() {
        if read_u32_le(&tail_bytes, i) == 0x06054b50 {
            eocd_pos = Some(i);
            break;
        }
    }

    let eocd = eocd_pos.ok_or_else(|| "ZIP End of Central Directory (EOCD) not found".to_string())?;
    let total_entries = read_u16_le(&tail_bytes, eocd + 10) as usize;
    let cd_size = read_u32_le(&tail_bytes, eocd + 12) as u64;
    let cd_offset = read_u32_le(&tail_bytes, eocd + 16) as u64;
    if total_entries == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
        return Err("ZIP64 archive detected; falling back to full extractor".to_string());
    }

    // 3. Obtain Central Directory buffer (reuse tail_bytes if already contained within it!)
    let cd_vec: Vec<u8> = if cd_offset >= tail_start && (cd_offset + cd_size) <= total_size {
        let rel_start = (cd_offset - tail_start) as usize;
        let rel_end = (rel_start + cd_size as usize).min(tail_bytes.len());
        tail_bytes[rel_start..rel_end].to_vec()
    } else {
        let cd_resp = client
            .get(&stream_url)
            .header("Range", format!("bytes={}-{}", cd_offset, cd_offset + cd_size - 1))
            .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to fetch Central Directory: {}", e))?;
        cd_resp
            .bytes()
            .await
            .map_err(|e| format!("Failed reading Central Directory: {}", e))?
            .to_vec()
    };

    // 4. Parse Central Directory entries
    let mut entries = Vec::new();
    let mut ptr: usize = 0;

    for _ in 0..total_entries {
        if ptr + 46 > cd_vec.len() {
            break;
        }
        if read_u32_le(&cd_vec, ptr) != 0x02014b50 {
            break;
        }
        let compression_method = read_u16_le(&cd_vec, ptr + 10);
        let compressed_size = read_u32_le(&cd_vec, ptr + 20) as u64;
        let uncompressed_size = read_u32_le(&cd_vec, ptr + 24) as u64;
        let name_len = read_u16_le(&cd_vec, ptr + 28) as usize;
        let extra_len = read_u16_le(&cd_vec, ptr + 30) as usize;
        let comment_len = read_u16_le(&cd_vec, ptr + 32) as usize;
        let local_header_offset = read_u32_le(&cd_vec, ptr + 42) as u64;

        if ptr + 46 + name_len > cd_vec.len() {
            break;
        }
        let name = String::from_utf8_lossy(&cd_vec[ptr + 46..ptr + 46 + name_len]).into_owned();
        ptr += 46 + name_len + extra_len + comment_len;

        if is_comic_image_entry(&name) && (compression_method == 0 || compression_method == 8) {
            entries.push(RemoteZipPageEntry {
                name,
                compression_method,
                compressed_size,
                uncompressed_size,
                local_header_offset,
                archive_prefix_len: 0,
            });
        }
    }

    if entries.is_empty() {
        return Err("No valid image pages found in ZIP Central Directory".to_string());
    }

    entries.sort_by(|a, b| natord_cmp(&a.name, &b.name));
    save_manifest_cache(&cache_key, &entries);
    Ok(entries)
}

/// Streams and decompresses a single comic page on demand via an HTTP Range request,
/// returning a ready-to-render `data:image/...;base64,...` data URI.
#[tauri::command]
pub async fn fetch_remote_comic_page(
    stream_url: String,
    entry: RemoteZipPageEntry,
    cache_key: Option<String>,
) -> Result<String, String> {
    let page_cache_file = cache_key
        .as_deref()
        .and_then(sanitize_cache_key)
        .map(|key| {
            comic_cache_root()
                .join(&key)
                .join("pages")
                .join(format!("{}_{}.bin", entry.local_header_offset, entry.compressed_size))
        });

    if let Some(ref p) = page_cache_file {
        if is_cache_fresh(p) {
            if let Ok(cached_bytes) = std::fs::read(p) {
                if !cached_bytes.is_empty() {
                    let mime = mime_for_image_name(&entry.name);
                    return Ok(format!(
                        "data:{};base64,{}",
                        mime,
                        BASE64_STANDARD.encode(&cached_bytes)
                    ));
                }
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // Compressed non-solid RAR entries (method 100): synthesize a minimal
    // single-entry archive (prefix + header/data span) and decompress just this
    // page — no full-archive download (YACReader-style selective extraction).
    if entry.compression_method == 100 {
        if entry.archive_prefix_len == 0 || entry.archive_prefix_len > 4 * 1024 * 1024 {
            return Err("Invalid CBR archive prefix length for page extraction".to_string());
        }
        let prefix_resp = client
            .get(&stream_url)
            .header("Range", format!("bytes=0-{}", entry.archive_prefix_len - 1))
            .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to fetch CBR archive prefix: {}", e))?;
        let prefix_bytes = prefix_resp.bytes().await.map_err(|e| format!("Reading CBR prefix failed: {}", e))?;

        let span_start = entry.local_header_offset;
        let span_end = span_start + entry.compressed_size.saturating_sub(1);
        let span_resp = client
            .get(&stream_url)
            .header("Range", format!("bytes={}-{}", span_start, span_end))
            .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to fetch CBR page span: {}", e))?;
        let span_bytes = span_resp.bytes().await.map_err(|e| format!("Reading CBR page span failed: {}", e))?;

        // Unique temp area per (stream, entry) so concurrent prefetches never collide.
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        stream_url.hash(&mut h);
        entry.local_header_offset.hash(&mut h);
        let base = std::env::temp_dir()
            .join("rcloneflix-books")
            .join("rar-pages")
            .join(format!("{:016x}", h.finish()));
        let out_dir = base.join("out");
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("temp dir: {}", e))?;
        let rar_path = base.join("page.rar");
        std::fs::write(&rar_path, [prefix_bytes.as_ref(), span_bytes.as_ref()].concat())
            .map_err(|e| format!("temp write: {}", e))?;

        let rar_str = rar_path.to_string_lossy().into_owned();
        let out_str = out_dir.to_string_lossy().into_owned();
        // Exit status intentionally ignored: the missing end-of-archive block is
        // reported as an error even though the entry extracts fine.
        let _ = std_command("unrar").args(["x", "-y", "-inul", &rar_str, &format!("{}/", out_str)]).output();
        let mut images = Vec::new();
        collect_images_recursively(&out_dir, &mut images);
        if images.is_empty() {
            let _ = std_command("7z").args(["x", "-y", &rar_str, &format!("-o{}", out_str)]).output();
            collect_images_recursively(&out_dir, &mut images);
        }

        let extracted = if let Some(img) = images.first() {
            std::fs::read(img).map_err(|e| format!("Failed reading extracted page: {}", e))
        } else {
            Err("Could not extract compressed CBR page (is unrar or 7z installed?)".to_string())
        };
        let _ = std::fs::remove_dir_all(&base);
        let raw_image_bytes = extracted?;
        if let Some(ref p) = page_cache_file {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(p, &raw_image_bytes);
        }
        let mime = mime_for_image_name(&entry.name);
        return Ok(format!(
            "data:{};base64,{}",
            mime,
            BASE64_STANDARD.encode(&raw_image_bytes)
        ));
    }

    // Stored RAR entries (method 99) directly contain the raw image bytes at local_header_offset
    if entry.compression_method == 99 {
        let range_start = entry.local_header_offset;
        let range_end = range_start + entry.compressed_size.saturating_sub(1);
        let resp = client
            .get(&stream_url)
            .header("Range", format!("bytes={}-{}", range_start, range_end))
            .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to fetch CBR page byte range: {}", e))?;

        let raw_bytes = resp.bytes().await.map_err(|e| format!("Reading CBR page bytes failed: {}", e))?;
        let mime = mime_for_image_name(&entry.name);
        let b64 = BASE64_STANDARD.encode(&raw_bytes);
        return Ok(format!("data:{};base64,{}", mime, b64));
    }

    // Local file header is 30 bytes + variable filename + variable extra field.
    // Requesting 30 + 1024 + compressed_size guarantees we capture the header and payload in 1 roundtrip.
    let range_start = entry.local_header_offset;
    let range_end = range_start + 30 + 1024 + entry.compressed_size;

    let resp = client
        .get(&stream_url)
        .header("Range", format!("bytes={}-{}", range_start, range_end))
        .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch page byte range: {}", e))?;

    let buf = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed reading page bytes: {}", e))?;

    if buf.len() < 30 || read_u32_le(&buf, 0) != 0x04034b50 {
        return Err("Invalid ZIP local file header at page offset".to_string());
    }

    let local_name_len = read_u16_le(&buf, 26) as usize;
    let local_extra_len = read_u16_le(&buf, 28) as usize;
    let data_start = 30 + local_name_len + local_extra_len;
    let data_end = data_start + (entry.compressed_size as usize);

    // If the extra field was unusually large (>1024 bytes), fetch the exact payload slice
    let compressed_slice: Vec<u8> = if data_end <= buf.len() {
        buf[data_start..data_end].to_vec()
    } else {
        let exact_start = entry.local_header_offset + (data_start as u64);
        let exact_end = exact_start + entry.compressed_size - 1;
        let exact_resp = client
            .get(&stream_url)
            .header("Range", format!("bytes={}-{}", exact_start, exact_end))
            .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to fetch exact page payload: {}", e))?;
        exact_resp
            .bytes()
            .await
            .map_err(|e| format!("Failed reading exact page payload: {}", e))?
            .to_vec()
    };

    let raw_image_bytes: Vec<u8> = if entry.compression_method == 0 {
        compressed_slice
    } else if entry.compression_method == 8 {
        let mut decoder = flate2::read::DeflateDecoder::new(&compressed_slice[..]);
        let mut out = Vec::with_capacity(entry.uncompressed_size as usize);
        decoder
            .read_to_end(&mut out)
            .map_err(|e| format!("Deflate decompression failed: {}", e))?;
        out
    } else {
        return Err(format!("Unsupported compression method: {}", entry.compression_method));
    };

    if let Some(ref p) = page_cache_file {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, &raw_image_bytes);
    }

    let mime = mime_for_image_name(&entry.name);
    let b64 = BASE64_STANDARD.encode(&raw_image_bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// First page only, for library/card thumbnails — never downloads the archive.
/// (YACReaderLibrary-style cover fast path.)
#[tauri::command]
pub async fn fetch_remote_comic_cover(stream_url: String) -> Result<String, String> {
    let entries = fetch_remote_comic_manifest(stream_url.clone(), None).await?;
    let first = entries
        .into_iter()
        .next()
        .ok_or_else(|| "No pages found in comic".to_string())?;
    fetch_remote_comic_page(stream_url, first, None).await
}

const MAX_EXTRACT_BYTES: u64 = 10 * 1024 * 1024 * 1024; // 10 GiB extracted
const MAX_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024 * 1024; // 20 GiB source archive

struct DirGuard(PathBuf);
impl Drop for DirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn archive_stem(filename: &str) -> String {
    let lower = filename.to_lowercase();
    for suf in [".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".zip", ".rar", ".7z", ".tar"] {
        if lower.ends_with(suf) {
            return filename[..filename.len() - suf.len()].trim().to_string();
        }
    }
    filename
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(filename)
        .trim()
        .to_string()
}

fn dir_size(p: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                total = total.saturating_add(dir_size(&e.path()));
            } else {
                total = total.saturating_add(md.len());
            }
        }
    }
    total
}

/// Extracts a ZIP in-process. Returns Ok(true) if extracted, Ok(false) if the file is not a ZIP.
fn extract_zip_safely(archive: &Path, out_dir: &Path) -> Result<bool, String> {
    let mut f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 4];
    let n = f.read(&mut magic).map_err(|e| e.to_string())?;
    let looks_zip = n == 4 && &magic == b"PK\x03\x04";
    let name_zip = archive
        .to_string_lossy()
        .to_lowercase()
        .ends_with(".zip");
    if !looks_zip && !name_zip {
        return Ok(false);
    }
    let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("Invalid ZIP archive: {}", e))?;
    let mut total_written = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let Some(rel_path) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue; // blocks Zip-Slip traversal
        };
        if rel_path.to_string_lossy().contains("__MACOSX") {
            continue;
        }
        let target = out_dir.join(rel_path);
        if let Some(p) = target.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut out_f = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        // Count bytes ACTUALLY written; never trust the declared entry size.
        let remaining = MAX_EXTRACT_BYTES.saturating_sub(total_written);
        let mut limited = (&mut entry).take(remaining.saturating_add(1));
        let written = std::io::copy(&mut limited, &mut out_f).map_err(|e| e.to_string())?;
        out_f.flush().ok();
        total_written = total_written.saturating_add(written);
        if total_written > MAX_EXTRACT_BYTES {
            return Err("Archive exceeds the 10 GB extraction safety limit.".to_string());
        }
    }
    Ok(true)
}

/// Downloads a remote archive (.zip, .rar, .7z, .tar, .tar.gz, .tgz) into the app cache dir,
/// extracts it safely and uploads the extracted folder back to `dest_remote_dir`.
#[tauri::command]
pub async fn extract_remote_archive_to_remote(
    app: AppHandle,
    config_path: String,
    source_remote_path: String,
    dest_remote_dir: String,
) -> Result<String, String> {
    if source_remote_path.starts_with("shared_") || dest_remote_dir.starts_with("shared_") {
        return Err("Guest pass remotes are read-only.".to_string());
    }
    let filename = source_remote_path
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("archive.zip")
        .to_string();
    let lower = filename.to_lowercase();
    let stem = archive_stem(&filename);

    if lower.ends_with(".rar") || lower.ends_with(".7z") {
        let has_unrar = std_command("unrar").arg("-v").output().is_ok();
        let has_7z = std_command("7z").arg("i").output().is_ok();
        if !has_unrar && !has_7z {
            return Err(
                "Extracting .rar or .7z archives requires '7z' or 'unrar' to be installed on your system. (.zip archives are extracted natively.)"
                    .to_string(),
            );
        }
    }

    let rclone = crate::commands::player::rclone_binary(&app);
    let cfg_opt = crate::commands::rclone_sync::resolve_config_arg(&config_path);

    // 0. Refuse oversized sources BEFORE downloading anything.
    let mut size_cmd = tokio_command(&rclone);
    if let Some(ref cfg) = cfg_opt {
        size_cmd.args(["--config", cfg]);
    }
    size_cmd.args(["size", "--json", &source_remote_path]);
    if let Ok(o) = size_cmd.output().await {
        if o.status.success() {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
                if v.get("bytes").and_then(|b| b.as_u64()).unwrap_or(0) > MAX_ARCHIVE_BYTES {
                    return Err("Archive is larger than the 20 GB limit for in-app extraction.".to_string());
                }
            }
        }
    }

    let work_id = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("No app cache dir: {}", e))?
        .join("extract");
    let work_dir = cache_root.join(&work_id);
    let local_archive = work_dir.join(&filename);
    let out_dir = work_dir.join("out");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Failed creating work dir: {}", e))?;
    let _guard = DirGuard(work_dir.clone()); // removes work_dir on every exit path

    // 1. Download archive from remote
    let mut dl_cmd = tokio_command(&rclone);
    if let Some(ref cfg) = cfg_opt {
        dl_cmd.args(["--config", cfg]);
    }
    dl_cmd.args(["copyto", &source_remote_path, &local_archive.to_string_lossy()]);
    let dl_out = dl_cmd
        .output()
        .await
        .map_err(|e| format!("rclone download failed: {}", e))?;
    if !dl_out.status.success() {
        return Err(format!(
            "Failed downloading archive: {}",
            String::from_utf8_lossy(&dl_out.stderr)
        ));
    }

    // 2. Extract: native ZIP first; everything else via the existing extract_archive (7z/unrar/tar)
    let archive_clone = local_archive.clone();
    let out_clone = out_dir.clone();
    let zip_done = tokio::task::spawn_blocking(move || extract_zip_safely(&archive_clone, &out_clone))
        .await
        .map_err(|e| e.to_string())??;

    if !zip_done {
        extract_archive(
            local_archive.to_string_lossy().to_string(),
            out_dir.to_string_lossy().to_string(),
        )
        .await?;
    }
    let _ = std::fs::remove_file(&local_archive);

    // Post-extraction cap (covers the external-tool paths that bypass the in-process counter)
    let out_for_size = out_dir.clone();
    let extracted = tokio::task::spawn_blocking(move || dir_size(&out_for_size))
        .await
        .map_err(|e| e.to_string())?;
    if extracted > MAX_EXTRACT_BYTES {
        return Err("Extracted content exceeds the 10 GB safety limit; nothing was uploaded.".to_string());
    }

    // 3. Avoid nested <stem>/<stem> if the archive already had a single root folder
    let mut upload_src = out_dir.clone();
    if let Ok(rd) = std::fs::read_dir(&out_dir) {
        let entries: Vec<_> = rd.flatten().collect();
        if entries.len() == 1 && entries[0].path().is_dir() {
            upload_src = entries[0].path();
        }
    }

    let target_remote = format!("{}/{}", dest_remote_dir.trim_end_matches('/'), stem);
    let mut up_cmd = tokio_command(&rclone);
    if let Some(ref cfg) = cfg_opt {
        up_cmd.args(["--config", cfg]);
    }
    up_cmd.args(["copy", &upload_src.to_string_lossy(), &target_remote]);
    let up_out = up_cmd
        .output()
        .await
        .map_err(|e| format!("rclone upload failed: {}", e))?;
    if !up_out.status.success() {
        return Err(format!(
            "Failed uploading extracted files: {}",
            String::from_utf8_lossy(&up_out.stderr)
        ));
    }
    crate::commands::rclone::spawn_best_effort_vfs_refresh(&app, &target_remote);
    Ok(target_remote)
}

#[cfg(test)]
mod comic_stream_tests {
    use super::*;

    /// Empirical probe against real comic files served over rclone serve http.
    /// Run with:
    ///   COMIC_BASE="http://127.0.0.1:18599" COMIC_FILES="a.cbr|b.cbz" \
    ///   cargo test comic_stream_probe -- --nocapture --ignored
    #[tokio::test]
    #[ignore]
    async fn comic_stream_probe() {
        let base = std::env::var("COMIC_BASE").expect("COMIC_BASE not set");
        let files = std::env::var("COMIC_FILES").expect("COMIC_FILES not set");
        for fname in files.split('|').filter(|s| !s.trim().is_empty()) {
            let enc: String = fname
                .split('/')
                .map(|seg| crate::commands::player::percent_encode_path(seg))
                .collect::<Vec<_>>()
                .join("/");
            let url = format!("{}/{}", base.trim_end_matches('/'), enc);
            println!("\n=== {} ===", fname);
            let t0 = std::time::Instant::now();
            match fetch_remote_comic_manifest(url.clone(), None).await {
                Err(e) => println!("MANIFEST ERR ({:?}): {}", t0.elapsed(), e),
                Ok(entries) => {
                    println!(
                        "MANIFEST OK ({:?}): {} pages, first='{}' method={} off={} csize={}",
                        t0.elapsed(),
                        entries.len(),
                        entries[0].name,
                        entries[0].compression_method,
                        entries[0].local_header_offset,
                        entries[0].compressed_size
                    );
                    for idx in [0usize, entries.len() / 2] {
                        let e = entries[idx].clone();
                        let name = e.name.clone();
                        let t1 = std::time::Instant::now();
                        match fetch_remote_comic_page(url.clone(), e, None).await {
                            Err(err) => println!("  PAGE {} ('{}') ERR ({:?}): {}", idx, name, t1.elapsed(), err),
                            Ok(data_uri) => {
                                let head = &data_uri[..data_uri.len().min(40)];
                                // decode a few bytes to check image magic
                                let b64 = data_uri.splitn(2, ",").nth(1).unwrap_or("");
                                let decoded = BASE64_STANDARD.decode(b64).unwrap_or_default();
                                let magic = decoded.get(..4).map(|m| format!("{:02X?}", m)).unwrap_or_default();
                                let ok = decoded.starts_with(&[0xFF, 0xD8])
                                    || decoded.starts_with(b"\x89PNG")
                                    || decoded.starts_with(b"GIF8")
                                    || decoded.get(..4) == Some(b"RIFF");
                                println!(
                                    "  PAGE {} ('{}') {} ({:?}): {} bytes, magic={} uri[..40]={}",
                                    idx, name,
                                    if ok { "OK" } else { "BAD-MAGIC" },
                                    t1.elapsed(), decoded.len(), magic, head
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod progressive_comic_tests {
    use super::*;

    /// COMIC_URL="http://127.0.0.1:18599/file.cbr" cargo test progressive_comic_probe -- --nocapture --ignored
    #[tokio::test]
    #[ignore]
    async fn progressive_comic_probe() {
        let url = std::env::var("COMIC_URL").expect("COMIC_URL not set");
        let sid = format!("test-prog-{}", std::process::id());
        start_progressive_comic_download(url, sid.clone()).await.expect("start failed");
        let t0 = std::time::Instant::now();
        let mut first_pages_at: Option<std::time::Duration> = None;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
            let st = comic_progressive_status(sid.clone()).await.expect("status failed");
            if !st.pages.is_empty() && first_pages_at.is_none() {
                first_pages_at = Some(t0.elapsed());
                println!("FIRST PAGES after {:?}: {} pages, first='{}'", t0.elapsed(), st.pages.len(), st.pages[0]);
            }
            println!(
                "poll: {}/{} bytes, {} pages, done={}, err={:?}",
                st.downloaded,
                st.total.map(|t| t.to_string()).unwrap_or_else(|| "?".into()),
                st.pages.len(),
                st.done,
                st.error
            );
            if st.done || st.error.is_some() {
                assert!(st.error.is_none(), "progressive failed: {:?}", st.error);
                assert!(!st.pages.is_empty(), "no pages extracted");
                // Verify the first page is a real image
                let bytes = std::fs::read(&st.pages[0]).expect("read first page");
                assert!(
                    bytes.starts_with(&[0xFF, 0xD8]) || bytes.starts_with(b"\x89PNG"),
                    "first page is not an image"
                );
                println!(
                    "DONE in {:?}; first pages at {:?}; total {} pages; first page {} bytes (valid image)",
                    t0.elapsed(), first_pages_at.unwrap_or_default(), st.pages.len(), bytes.len()
                );
                // cleanup
                let _ = std::fs::remove_dir_all(std::env::temp_dir().join("rcloneflix-books").join(sanitize_session_id(&sid)));
                break;
            }
            if t0.elapsed().as_secs() > 240 {
                panic!("timed out");
            }
        }
    }
}
