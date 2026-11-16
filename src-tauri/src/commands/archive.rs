use std::path::Path;
use crate::process_ext::std_command;

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
        if let Ok(s) = std_command("unzip").args(["-o", "-q", &archive_path, "-d", &dest_str]).status() {
            if s.success() {
                extracted = true;
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

        const CHUNK: u64 = 4 * 1024 * 1024;
        const EXTRACT_EVERY: u64 = 8 * 1024 * 1024;
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

            let end = offset + CHUNK - 1;
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

            if finished || offset.saturating_sub(last_extract_at) >= EXTRACT_EVERY {
                last_extract_at = offset;
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
    pub compression_method: u16,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_header_offset: u64,
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

/// Fetches only the ZIP Central Directory via HTTP Range requests against `stream_url`
/// (such as `rclone serve http` on 127.0.0.1 or a remote HTTPS .cbz URL) and returns
/// naturally sorted image entries in milliseconds without downloading the full archive.
#[tauri::command]
pub async fn fetch_remote_comic_manifest(
    stream_url: String,
) -> Result<Vec<RemoteZipPageEntry>, String> {
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
                        if is_comic_image_entry(&entry.name) {
                            if !entry.stored {
                                return Err("CBR archive contains compressed RAR streams; falling back to full download".to_string());
                            }
                            let packed_len = entry.data.end.saturating_sub(entry.data.start);
                            entries.push(RemoteZipPageEntry {
                                name: entry.name,
                                compression_method: 99, // 99 indicates stored RAR entry
                                compressed_size: packed_len,
                                uncompressed_size: entry.size.unwrap_or(packed_len),
                                local_header_offset: entry.data.start,
                            });
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
            });
        }
    }

    if entries.is_empty() {
        return Err("No valid image pages found in ZIP Central Directory".to_string());
    }

    entries.sort_by(|a, b| natord_cmp(&a.name, &b.name));
    Ok(entries)
}

/// Streams and decompresses a single comic page on demand via an HTTP Range request,
/// returning a ready-to-render `data:image/...;base64,...` data URI.
#[tauri::command]
pub async fn fetch_remote_comic_page(
    stream_url: String,
    entry: RemoteZipPageEntry,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

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

    let mime = mime_for_image_name(&entry.name);
    let b64 = BASE64_STANDARD.encode(&raw_image_bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
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
            match fetch_remote_comic_manifest(url.clone()).await {
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
                        match fetch_remote_comic_page(url.clone(), e).await {
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
