use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use log::info;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IptvItem {
    pub id: String,
    pub name: String,
    pub group: String,
    pub logo: Option<String>,
    pub stream_url: String,
    pub epg_id: Option<String>,
    pub imdb_id: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub year: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IptvPlaylist {
    pub items: Vec<IptvItem>,
    pub categories: Vec<String>,
    pub total_count: usize,
}

fn cache_path_for_url(url: &str) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&url, &mut hasher);
    let hash = std::hash::Hasher::finish(&hasher);
    std::env::temp_dir().join(format!("rcloneflix_iptv_{:x}.m3u", hash))
}

#[tauri::command]
pub async fn fetch_iptv_playlist(url: String, force_refresh: bool) -> Result<IptvPlaylist, String> {
    let trimmed = url.trim().to_string();
    if trimmed.is_empty() {
        return Err("Playlist URL is empty".to_string());
    }

    let cache_file = cache_path_for_url(&trimmed);

    // If cache exists and is fresh (< 4 hours) and not forced, read from disk
    let content = if !force_refresh && cache_file.exists() {
        if let Ok(metadata) = fs::metadata(&cache_file) {
            if let Ok(modified) = metadata.modified() {
                if let Ok(elapsed) = SystemTime::now().duration_since(modified) {
                    if elapsed < Duration::from_secs(4 * 3600) {
                        info!(target: "iptv", "Loading playlist from cache: {:?}", cache_file);
                        fs::read_to_string(&cache_file).ok()
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    let body = match content {
        Some(text) => text,
        None => {
            info!(target: "iptv", "Fetching remote playlist: {}", trimmed);
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

            let resp = client
                .get(&trimmed)
                .header("User-Agent", "TiviMate/4.7.0 (Linux; Android 11)")
                .send()
                .await
                .map_err(|e| format!("Network request failed: {}", e))?;

            if !resp.status().is_success() {
                return Err(format!("Server returned HTTP {}", resp.status()));
            }

            let text = resp.text().await.map_err(|e| format!("Failed to read response: {}", e))?;
            // Cache to disk
            let _ = fs::write(&cache_file, &text);
            text
        }
    };

    let parsed = parse_m3u_text(&body);
    Ok(parsed)
}

fn parse_m3u_text(content: &str) -> IptvPlaylist {
    let mut items = Vec::new();
    let mut category_set = HashSet::new();

    let tvg_id_re = Regex::new(r#"tvg-id="([^"]*)""#).unwrap();
    let tvg_name_re = Regex::new(r#"tvg-name="([^"]*)""#).unwrap();
    let tvg_logo_re = Regex::new(r#"tvg-logo="([^"]*)""#).unwrap();
    let group_re = Regex::new(r#"group-title="([^"]*)""#).unwrap();
    let imdb_re = Regex::new(r"(tt\d{7,8})").unwrap();
    let season_ep_re = Regex::new(r"(?i)s(\d{1,2})\s*e(\d{1,2})").unwrap();
    let season_ep_path_re = Regex::new(r"/(?:tvshow|series)/[^/]+/(\d+)/(\d+)").unwrap();
    let year_re = Regex::new(r"\b(19\d\d|20\d\d)\b").unwrap();

    let lines: Vec<&str> = content.lines().collect();
    let mut i = 0;
    let mut item_counter: u64 = 0;

    while i < lines.len() {
        let line = lines[i].trim();
        if line.starts_with("#EXTINF:") {
            let info_line = line;
            let title = info_line.split(',').last().unwrap_or("Untitled").trim().to_string();

            let epg_id = tvg_id_re.captures(info_line).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string()).filter(|s| !s.is_empty());
            let name_attr = tvg_name_re.captures(info_line).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string()).filter(|s| !s.is_empty());
            let logo = tvg_logo_re.captures(info_line).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string()).filter(|s| !s.is_empty());
            let mut group = group_re.captures(info_line).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "General".to_string());

            if group.is_empty() {
                group = "General".to_string();
            }
            category_set.insert(group.clone());

            let mut stream_url = String::new();
            while i + 1 < lines.len() {
                i += 1;
                let next_line = lines[i].trim();
                if next_line.starts_with('#') {
                    continue;
                } else if !next_line.is_empty() {
                    stream_url = next_line.to_string();
                    break;
                }
            }

            if !stream_url.is_empty() {
                item_counter += 1;
                let display_name = if !title.is_empty() && title != "Untitled" {
                    title.clone()
                } else {
                    name_attr.clone().unwrap_or_else(|| format!("Channel {}", item_counter))
                };

                let imdb_id = epg_id.as_deref()
                    .and_then(|id| imdb_re.captures(id))
                    .or_else(|| imdb_re.captures(&stream_url))
                    .and_then(|c| c.get(1))
                    .map(|m| m.as_str().to_string());

                let (season, episode) = if let Some(cap) = season_ep_path_re.captures(&stream_url) {
                    (cap[1].parse::<u32>().ok(), cap[2].parse::<u32>().ok())
                } else if let Some(cap) = season_ep_re.captures(&display_name) {
                    (cap[1].parse::<u32>().ok(), cap[2].parse::<u32>().ok())
                } else {
                    (None, None)
                };

                let year = year_re.captures(&display_name).and_then(|c| c.get(1)).and_then(|m| m.as_str().parse::<u32>().ok());

                let id = format!("iptv-{}", item_counter);

                items.push(IptvItem {
                    id,
                    name: display_name,
                    group,
                    logo,
                    stream_url,
                    epg_id,
                    imdb_id,
                    season,
                    episode,
                    year,
                });
            }
        }
        i += 1;
    }

    let mut categories: Vec<String> = category_set.into_iter().collect();
    categories.sort();

    let total_count = items.len();
    IptvPlaylist {
        items,
        categories,
        total_count,
    }
}

/// Check Xtream Codes account info and connection status via player_api.php
#[tauri::command]
pub async fn check_xtream_account(
    server_url: String,
    username: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let mut clean_server = server_url.trim().trim_end_matches('/').to_string();
    if !clean_server.starts_with("http://") && !clean_server.starts_with("https://") {
        clean_server = format!("http://{}", clean_server);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let api_url = format!("{}/player_api.php", clean_server);

    let resp = client
        .get(&api_url)
        .query(&[("username", &username), ("password", &password)])
        .header("User-Agent", "TiviMate/4.7.0 (Linux; Android 11)")
        .send()
        .await
        .map_err(|e| format!("Network request failed: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response from Xtream Codes server: {}", e))?;

    let val: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid JSON response from Xtream Codes server: {}", e))?;

    Ok(val)
}
