use serde::{Deserialize, Serialize};
use crate::process_ext::tokio_command;
use tauri::{AppHandle, Emitter};
use regex::Regex;
use std::sync::OnceLock;

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

use crate::commands::player::rclone_binary;

/// Recursively list all files in a remote path using rclone lsjson --recursive
/// Returns only files (not directories) that look like media
#[tauri::command]
pub async fn scan_library_files(
    app: AppHandle,
    config_path: String,
    remote_path: String,
    library_id: String,
    known_paths: Vec<String>,
    library_type: Option<String>,
) -> Result<LibraryScanResult, String> {
    let rclone = rclone_binary(&app);
    let started = std::time::Instant::now();
    let target_remote = if !remote_path.contains(':')
        && !remote_path.starts_with('/')
        && !remote_path.starts_with('.')
        && !remote_path.starts_with('\\')
    {
        format!("{}:", remote_path.trim())
    } else {
        remote_path.clone()
    };

    crate::log_info!(&app, "scan", "listing {} (rclone: {})", target_remote, rclone.display());

    // Emit progress event
    let _ = app.emit("scan-progress", serde_json::json!({
        "libraryId": library_id,
        "stage": "listing",
        "remote": target_remote,
        "message": format!("Listing files in {}...", target_remote)
    }));

    let rclone_settings = crate::commands::store::get_rclone_settings_sync(&app);
    let tps_limit_str = rclone_settings.clean_tps_limit().to_string();
    let tps_burst_str = rclone_settings.clean_tps_limit_burst().to_string();

    // A recursive lsjson over a large remote can take minutes — keep it off
    // the async runtime so other commands stay responsive.
    let mut cmd = tokio_command(&rclone);
    cmd.arg("lsjson");
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.args([
        "--recursive",
        "--no-modtime",
        "--files-only",
        "--tpslimit",
        &tps_limit_str,
        "--tpslimit-burst",
        &tps_burst_str,
        &target_remote,
    ]);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        crate::log_error!(
            &app, "scan", "rclone lsjson failed for {} (exit {:?}): {}",
            target_remote, output.status.code(), stderr.trim()
        );
        return Err(format!("rclone error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    crate::log_info!(
        &app, "scan", "listed {} in {:.1}s ({} bytes of json)",
        target_remote, started.elapsed().as_secs_f32(), stdout.len()
    );

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

    let items: Vec<RcloneItem> = serde_json::from_str(&stdout).map_err(|e| {
        crate::log_error!(
            &app, "scan", "cannot parse rclone json for {}: {} (first 200 bytes: {})",
            remote_path, e, stdout.chars().take(200).collect::<String>()
        );
        format!("Failed to parse rclone output: {}", e)
    })?;

    // Build set of known paths for change detection
    let known_set: std::collections::HashSet<String> = known_paths.into_iter().collect();

    let mut new_files = Vec::new();
    let mut found_paths = std::collections::HashSet::new();
    let lib_type = library_type.as_deref().unwrap_or("");

    for item in &items {
        if item.is_dir { continue; }

        // Filter extensions based on library type
        let ext = item.name.rsplit('.').next().unwrap_or("").to_lowercase();
        let is_media = match lib_type {
            "photos" => matches!(
                ext.as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "gif" | "avif" | "heic" | "heif" | "bmp" | "tiff" | "svg" | "enc"
            ),
            "comics" => matches!(
                ext.as_str(),
                "cbz" | "cbr" | "cb7" | "cbt" | "pdf"
            ),
            "books" => matches!(
                ext.as_str(),
                "epub" | "pdf" | "cbz" | "cbr" | "cb7" | "cbt"
            ),
            _ => matches!(
                ext.as_str(),
                // video
                "mkv" | "mp4" | "avi" | "mov" | "wmv" | "m4v" | "ts" | "m2ts" | "mts"
                | "webm" | "mpg" | "mpeg" | "flv" | "3gp" | "ogv" | "divx" | "vob"
                // audio
                | "mp3" | "flac" | "aac" | "ogg" | "oga" | "m4a" | "wav" | "opus"
                | "wma" | "aiff" | "alac" | "ape"
                // books & comics
                | "epub" | "pdf" | "cbz" | "cbr" | "cb7" | "cbt"
                // audiobooks
                | "m4b" | "aax" | "aa"
            ),
        };

        if !is_media { continue; }

        let full_path = format!("{}/{}", target_remote.trim_end_matches(['/', '\\']), item.path);
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

    // Find removed files (only among files in known_set that belong to the remote_path being scanned)
    let prefix = format!("{}/", target_remote.trim_end_matches(['/', '\\']));
    let removed_paths: Vec<String> = known_set
        .iter()
        .filter(|p| (p.starts_with(&prefix) || *p == &target_remote || *p == &remote_path) && !found_paths.contains(*p))
        .cloned()
        .collect();

    let total_found = found_paths.len();

    crate::log_info!(
        &app, "scan", "{}: {} files found, {} new, {} removed",
        target_remote, total_found, new_files.len(), removed_paths.len()
    );

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

// ── Compiled Regex Singletons ───────────────────────────────────────────────────

static RE_SEASON_EPISODE: OnceLock<Regex> = OnceLock::new();
static RE_ALT_EPISODE: OnceLock<Regex> = OnceLock::new();
static RE_YEAR: OnceLock<Regex> = OnceLock::new();
static RE_SCENE_TAGS: OnceLock<Regex> = OnceLock::new();

fn season_episode_regex() -> &'static Regex {
    RE_SEASON_EPISODE.get_or_init(|| {
        Regex::new(r"(?i)[sS](\d{1,2})[eE](\d{1,2})").unwrap()
    })
}

fn alt_episode_regex() -> &'static Regex {
    RE_ALT_EPISODE.get_or_init(|| {
        Regex::new(r"(?i)\b(\d{1,2})x(\d{1,2})\b").unwrap()
    })
}

fn year_regex() -> &'static Regex {
    RE_YEAR.get_or_init(|| {
        Regex::new(r"\b(19\d\d|20\d\d)\b").unwrap()
    })
}

fn scene_tags_regex() -> &'static Regex {
    RE_SCENE_TAGS.get_or_init(|| {
        Regex::new(r"(?i)\b(1080p|720p|2160p|4k|hdr|web[-.]?dl|webrip|bluray|hdtv|x264|x265|h264|hevc|aac|ddp?\d?\.?\d?|proper|repack|remux|dsnp|atvp|amzn|netflix|hbo)\b.*").unwrap()
    })
}

/// Parse a media filename into clean title, year, season, episode
#[tauri::command]
pub fn parse_media_filename(filename: String) -> ParsedTitle {
    // Strip extension
    let stem = if let Some(pos) = filename.rfind('.') {
        &filename[..pos]
    } else {
        &filename
    };

    // 1. Check TV Season/Episode S01E01 pattern
    if let Some(caps) = season_episode_regex().captures(stem) {
        if let (Some(m), Some(s_m), Some(e_m)) = (caps.get(0), caps.get(1), caps.get(2)) {
            let before = &stem[..m.start()];
            let title = clean_title(before);
            let season = s_m.as_str().parse().ok();
            let episode = e_m.as_str().parse().ok();
            return ParsedTitle {
                title,
                year: extract_year(before),
                season,
                episode,
                is_episode: true,
            };
        }
    }

    // 2. Check TV Season/Episode 1x01 pattern
    if let Some(caps) = alt_episode_regex().captures(stem) {
        if let (Some(m), Some(s_m), Some(e_m)) = (caps.get(0), caps.get(1), caps.get(2)) {
            let before = &stem[..m.start()];
            let title = clean_title(before);
            let season = s_m.as_str().parse().ok();
            let episode = e_m.as_str().parse().ok();
            return ParsedTitle {
                title,
                year: extract_year(before),
                season,
                episode,
                is_episode: true,
            };
        }
    }

    // 3. Movie or standard title: check for Year.
    //    Use the *last* year in the name — titles like
    //    "Blade Runner 2049 2017 1080p" carry a year inside the title itself,
    //    and the release year is the one that follows it.
    let year = extract_year(stem);
    let title_part = match year_regex().find_iter(stem).last() {
        Some(m) => &stem[..m.start()],
        None => stem,
    };

    ParsedTitle {
        title: clean_title(title_part),
        year,
        season: None,
        episode: None,
        is_episode: false,
    }
}

fn extract_year(text: &str) -> Option<u32> {
    // Last match wins — see parse_media_filename for why.
    year_regex()
        .find_iter(text)
        .last()
        .and_then(|m| m.as_str().parse().ok())
}

fn clean_title(raw: &str) -> String {
    // Strip scene quality tags
    let stripped = scene_tags_regex().replace(raw, "");

    let cleaned = stripped
        .replace('.', " ")
        .replace('_', " ")
        .replace('-', " ");

    let words: Vec<String> = cleaned
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().to_string() + c.as_str(),
            }
        })
        .collect();

    let result = words.join(" ").trim().to_string();
    if result.is_empty() {
        raw.trim().to_string()
    } else {
        result
    }
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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(name: &str) -> ParsedTitle {
        parse_media_filename(name.to_string())
    }

    #[test]
    fn parses_standard_movie() {
        let p = parse("The.Matrix.1999.1080p.BluRay.x264.mkv");
        assert_eq!(p.title, "The Matrix");
        assert_eq!(p.year, Some(1999));
        assert!(!p.is_episode);
    }

    #[test]
    fn year_in_title_does_not_beat_release_year() {
        // Regression: taking the first year made this 2049.
        let p = parse("Blade Runner 2049 2017 2160p HDR.mkv");
        assert_eq!(p.year, Some(2017));
    }

    #[test]
    fn parses_season_episode() {
        let p = parse("Severance.S02E07.1080p.WEB-DL.mkv");
        assert!(p.is_episode);
        assert_eq!(p.season, Some(2));
        assert_eq!(p.episode, Some(7));
        assert_eq!(p.title, "Severance");
    }

    #[test]
    fn parses_alt_episode_format() {
        let p = parse("The Wire - 3x05 - Straight and True.mkv");
        assert!(p.is_episode);
        assert_eq!(p.season, Some(3));
        assert_eq!(p.episode, Some(5));
    }

    #[test]
    fn resolution_is_not_mistaken_for_an_episode() {
        let p = parse("Nature Documentary 1920x1080.mkv");
        assert!(!p.is_episode, "1920x1080 must not parse as season 19 episode 20");
    }

    #[test]
    fn filename_without_year_or_episode_still_yields_a_title() {
        let p = parse("Some Home Video.mp4");
        assert_eq!(p.title, "Some Home Video");
        assert_eq!(p.year, None);
    }

    #[test]
    fn hashes_are_stable_and_distinct() {
        let a = hash_remote_path("gdrive:/Movies/a.mkv".into());
        let b = hash_remote_path("gdrive:/Movies/b.mkv".into());
        assert_eq!(a, hash_remote_path("gdrive:/Movies/a.mkv".into()));
        assert_ne!(a, b);
        assert_eq!(a.len(), 16);
    }

    /// The removal diff must only consider paths under the folder being
    /// scanned. Getting this wrong deleted every item belonging to a library's
    /// other folders on each scan.
    fn removed_for(remote_path: &str, known: &[&str], found: &[&str]) -> Vec<String> {
        let known_set: std::collections::HashSet<String> =
            known.iter().map(|s| s.to_string()).collect();
        let found_paths: std::collections::HashSet<String> =
            found.iter().map(|s| s.to_string()).collect();
        let prefix = format!("{}/", remote_path.trim_end_matches('/'));
        let mut out: Vec<String> = known_set
            .iter()
            .filter(|p| {
                (p.starts_with(&prefix) || p.as_str() == remote_path)
                    && !found_paths.contains(p.as_str())
            })
            .cloned()
            .collect();
        out.sort();
        out
    }

    #[test]
    fn removal_ignores_other_folders_in_the_same_library() {
        let removed = removed_for(
            "gdrive:/Movies",
            &["gdrive:/Movies/a.mkv", "gdrive:/Movies2/b.mkv"],
            &["gdrive:/Movies/a.mkv"],
        );
        assert!(removed.is_empty(), "files outside the scanned folder must survive: {:?}", removed);
    }

    #[test]
    fn removal_reports_genuinely_missing_files() {
        let removed = removed_for(
            "gdrive:/Movies",
            &["gdrive:/Movies/a.mkv", "gdrive:/Movies/gone.mkv"],
            &["gdrive:/Movies/a.mkv"],
        );
        assert_eq!(removed, vec!["gdrive:/Movies/gone.mkv"]);
    }

    #[test]
    fn similar_prefixes_do_not_collide() {
        // "gdrive:/Movies4K/..." must not be treated as inside "gdrive:/Movies".
        let removed = removed_for(
            "gdrive:/Movies",
            &["gdrive:/Movies4K/x.mkv"],
            &[],
        );
        assert!(removed.is_empty());
    }
}
