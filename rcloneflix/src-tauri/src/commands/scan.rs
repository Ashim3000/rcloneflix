use serde::{Deserialize, Serialize};
use std::process::Command;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tauri::Manager;

/// A discovered file from a remote path
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiscoveredFile {
    pub remote_path: String,
    pub filename: String,
    pub size: i64,
    pub is_dir: bool,
    pub mime_type: Option<String>,
}

/// Result of scanning a single library
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LibraryScanResult {
    pub library_id: String,
    pub new_files: Vec<DiscoveredFile>,
    pub removed_paths: Vec<String>,
    pub total_found: usize,
    pub errors: Vec<String>,
}

/// Parsed title info extracted from a filename
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParsedTitle {
    pub title: String,
    pub year: Option<u32>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub is_episode: bool,
}

fn rclone_binary(app: &AppHandle) -> PathBuf {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let sidecar = resource_dir.join("rclone");
    if sidecar.exists() { sidecar } else { PathBuf::from("rclone") }
}

/// Recursively list all files in a remote path using rclone lsjson --recursive
/// Returns only files (not directories) that look like media
#[tauri::command]
pub async fn scan_library_files(
    app: AppHandle,
    config_path: String,
    remote_path: String,
    library_id: String,
    known_paths: Vec<String>,
) -> Result<LibraryScanResult, String> {
    let rclone = rclone_binary(&app);

    // Emit progress event
    let _ = app.emit("scan-progress", serde_json::json!({
        "libraryId": library_id,
        "stage": "listing",
        "message": format!("Listing files in {}...", remote_path)
    }));

    let output = Command::new(&rclone)
        .args([
            "lsjson",
            "--config", &config_path,
            "--recursive",
            "--no-modtime",
            "--files-only",
            &remote_path,
        ])
        .output()
        .map_err(|e| format!("Failed to run rclone: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rclone error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    #[derive(Deserialize)]
    struct RcloneItem {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "Path")]
        path: String,
        #[serde(rename = "IsDir")]
        is_dir: bool,
        #[serde(rename = "Size")]
        size: i64,
        #[serde(rename = "MimeType")]
        mime_type: Option<String>,
    }

    let items: Vec<RcloneItem> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse rclone output: {}", e))?;

    // Build set of known paths for change detection
    let known_set: std::collections::HashSet<String> = known_paths.into_iter().collect();

    let mut new_files = Vec::new();
    let mut found_paths = std::collections::HashSet::new();

    for item in &items {
        if item.is_dir { continue; }

        // Only include media file extensions
        let ext = item.name.rsplit('.').next().unwrap_or("").to_lowercase();
        let is_media = matches!(
            ext.as_str(),
            "mkv" | "mp4" | "avi" | "mov" | "wmv" | "m4v" | "ts" | "webm" |  // video
            "mp3" | "flac" | "aac" | "ogg" | "m4a" | "wav" | "opus" |          // audio
            "epub" | "pdf" |                                                       // books
            "m4b" | "aax"                                                          // audiobooks
        );

        if !is_media { continue; }

        let full_path = format!("{}/{}", remote_path.trim_end_matches('/'), item.path);
        found_paths.insert(full_path.clone());

        if !known_set.contains(&full_path) {
            new_files.push(DiscoveredFile {
                remote_path: full_path,
                filename: item.name.clone(),
                size: item.size,
                is_dir: false,
                mime_type: item.mime_type.clone(),
            });
        }
    }

    // Find removed files (in known but not in current scan)
    let removed_paths: Vec<String> = known_set
        .difference(&found_paths)
        .cloned()
        .collect();

    let total_found = found_paths.len();

    let _ = app.emit("scan-progress", serde_json::json!({
        "libraryId": library_id,
        "stage": "complete",
        "newFiles": new_files.len(),
        "removedFiles": removed_paths.len(),
        "totalFound": total_found
    }));

    Ok(LibraryScanResult {
        library_id,
        new_files,
        removed_paths,
        total_found,
        errors: vec![],
    })
}

/// Parse a filename into title, year, season, episode
/// Handles common naming conventions:
///   "The.Dark.Knight.2008.mkv"
///   "Breaking.Bad.S03E07.mkv"
///   "The Wire - 1x01 - The Target.mkv"
#[tauri::command]
pub fn parse_media_filename(filename: String) -> ParsedTitle {
    let stem = filename
        .rsplit('.')
        .skip(1)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(".");

    // Try to detect TV episode: S01E01 or 1x01 patterns
    let season_episode_re = [
        // SxxExx
        (r"[Ss](\d{1,2})[Ee](\d{1,2})", true),
        // NxNN
        (r"(\d{1,2})[xX](\d{1,2})", true),
    ];

    for (pattern, _) in &season_episode_re {
        if let Some(caps) = simple_regex_match(&stem, pattern) {
            let before_match = &stem[..caps.start];
            let title = clean_title(before_match);
            return ParsedTitle {
                title,
                year: None,
                season: caps.group1.parse().ok(),
                episode: caps.group2.parse().ok(),
                is_episode: true,
            };
        }
    }

    // Try to extract year: 4-digit number between 1900-2099
    if let Some(year_match) = find_year(&stem) {
        let before_year = &stem[..year_match.start];
        let title = clean_title(before_year);
        return ParsedTitle {
            title,
            year: Some(year_match.year),
            season: None,
            episode: None,
            is_episode: false,
        };
    }

    // Fallback: just clean the whole stem
    ParsedTitle {
        title: clean_title(&stem),
        year: None,
        season: None,
        episode: None,
        is_episode: false,
    }
}

// ── Simple regex helpers (no regex crate dependency) ──────────────────────────

struct RegexMatch {
    start: usize,
    group1: String,
    group2: String,
}

fn simple_regex_match(text: &str, pattern: &str) -> Option<RegexMatch> {
    // Minimal pattern matching for S01E01 and 1x01 without regex crate
    let bytes = text.as_bytes();

    if pattern.contains("[Ss]") {
        // SxxExx pattern
        for i in 0..bytes.len().saturating_sub(5) {
            if bytes[i] == b'S' || bytes[i] == b's' {
                let rest = &text[i+1..];
                let mut s_end = 0;
                while s_end < rest.len() && rest.as_bytes()[s_end].is_ascii_digit() { s_end += 1; }
                if s_end == 0 || s_end > 2 { continue; }
                let season_str = &rest[..s_end];
                let rest2 = &rest[s_end..];
                if rest2.len() < 3 { continue; }
                if rest2.as_bytes()[0] != b'E' && rest2.as_bytes()[0] != b'e' { continue; }
                let rest3 = &rest2[1..];
                let mut e_end = 0;
                while e_end < rest3.len() && rest3.as_bytes()[e_end].is_ascii_digit() { e_end += 1; }
                if e_end == 0 || e_end > 2 { continue; }
                let episode_str = &rest3[..e_end];
                return Some(RegexMatch {
                    start: i,
                    group1: season_str.to_string(),
                    group2: episode_str.to_string(),
                });
            }
        }
    } else {
        // NxNN pattern
        for i in 0..bytes.len().saturating_sub(3) {
            if bytes[i].is_ascii_digit() {
                let mut s_end = i;
                while s_end < bytes.len() && bytes[s_end].is_ascii_digit() { s_end += 1; }
                if s_end - i > 2 { continue; }
                if s_end >= bytes.len() { continue; }
                if bytes[s_end] != b'x' && bytes[s_end] != b'X' { continue; }
                let e_start = s_end + 1;
                let mut e_end = e_start;
                while e_end < bytes.len() && bytes[e_end].is_ascii_digit() { e_end += 1; }
                if e_end == e_start || e_end - e_start > 2 { continue; }
                return Some(RegexMatch {
                    start: i,
                    group1: text[i..s_end].to_string(),
                    group2: text[e_start..e_end].to_string(),
                });
            }
        }
    }
    None
}

struct YearMatch {
    start: usize,
    year: u32,
}

fn find_year(text: &str) -> Option<YearMatch> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        if bytes[i..i+4].iter().all(|b| b.is_ascii_digit()) {
            let year: u32 = text[i..i+4].parse().unwrap_or(0);
            if year >= 1900 && year <= 2099 {
                // Make sure it's surrounded by non-digit chars or boundaries
                let before_ok = i == 0 || !bytes[i-1].is_ascii_digit();
                let after_ok = i + 4 >= bytes.len() || !bytes[i+4].is_ascii_digit();
                if before_ok && after_ok {
                    return Some(YearMatch { start: i, year });
                }
            }
        }
        i += 1;
    }
    None
}

fn clean_title(raw: &str) -> String {
    raw
        .replace('.', " ")
        .replace('_', " ")
        .replace('-', " ")
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().to_string() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// Generate a stable ID for a media item from its remote path
#[tauri::command]
pub fn hash_remote_path(remote_path: String) -> String {
    // Simple djb2-style hash, no extra crate needed
    let mut hash: u64 = 5381;
    for byte in remote_path.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(byte as u64);
    }
    format!("{:016x}", hash)
}
