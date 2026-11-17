use regex::Regex;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use std::sync::Mutex;
use crate::process_ext::tokio_command;
use log::{info, warn};

static SPORTS_CACHE: Mutex<Option<(Instant, serde_json::Value)>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebStreamInfo {
    pub original_url: String,
    pub direct_stream_url: Option<String>,
    pub raw_title: String,
    pub clean_title: String,
    pub description: Option<String>,
    pub poster_url: Option<String>,
    pub provider: String,
    pub is_direct_media: bool,
    pub media_type: String,
    pub year: Option<u32>,
    pub format: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredRelease {
    pub title: String,
    pub post_url: String,
    pub thumbnail: Option<String>,
    pub date: Option<String>,
    pub site_domain: String,
    pub media_type: String,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteDiscoveryFeed {
    pub site_url: String,
    pub site_title: String,
    pub releases: Vec<DiscoveredRelease>,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

/// Follow 302/301 redirects using HEAD requests without downloading multi-gigabyte video bodies.
async fn resolve_redirect_head(url: &str, referer: Option<&str>) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
        .ok()?;

    let mut req = client.head(url);
    if let Some(r) = referer {
        req = req.header("Referer", r);
    }
    if let Ok(resp) = req.send().await {
        let final_url = resp.url().to_string();
        if resp.status().is_success() || resp.status().is_redirection() {
            return Some(final_url);
        }
    }
    None
}

/// Decode common HTML entities in scraped titles and attributes
pub fn decode_html_entities(input: &str) -> String {
    let mut out = input.to_string();
    let entities = [
        ("&amp;", "&"),
        ("&quot;", "\""),
        ("&apos;", "'"),
        ("&#39;", "'"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&#8211;", "–"),
        ("&#8212;", "—"),
        ("&#8216;", "'"),
        ("&#8217;", "'"),
        ("&#8220;", "\""),
        ("&#8221;", "\""),
        ("&#038;", "&"),
        ("&nbsp;", " "),
    ];
    for (k, v) in &entities {
        out = out.replace(k, v);
    }
    out
}

/// Detect season and episode numbering from a media title or URL.
pub fn detect_season_episode(raw: &str) -> (Option<u32>, Option<u32>) {
    // 1. S01E05 or S1E5
    let se_re = Regex::new(r"(?i)\b[Ss](\d{1,2})[Ee](\d{1,3})\b").unwrap();
    if let Some(c) = se_re.captures(raw) {
        let s = c.get(1).and_then(|m| m.as_str().parse().ok());
        let e = c.get(2).and_then(|m| m.as_str().parse().ok());
        return (s, e);
    }

    // 2. Season 1 Episode 5 or Chapter 2 Episode 18
    let long_re = Regex::new(r"(?i)\b(?:season|chapter|series)\s*(\d{1,2})[^\w\n]+(?:episode|ep)\s*(\d{1,3})\b").unwrap();
    if let Some(c) = long_re.captures(raw) {
        let s = c.get(1).and_then(|m| m.as_str().parse().ok());
        let e = c.get(2).and_then(|m| m.as_str().parse().ok());
        return (s, e);
    }

    // 3. Just Episode 5 (defaults to season 1)
    let ep_re = Regex::new(r"(?i)\b(?:episode|ep)\s*(\d{1,3})\b").unwrap();
    if let Some(c) = ep_re.captures(raw) {
        let e = c.get(1).and_then(|m| m.as_str().parse().ok());
        return (Some(1), e);
    }

    // 4. Reunion Part 2 or Part 3 (defaults to season 1)
    let part_re = Regex::new(r"(?i)\b(?:reunion\s+part|part|pt)\s*(\d{1,3})\b").unwrap();
    if let Some(c) = part_re.captures(raw) {
        let e = c.get(1).and_then(|m| m.as_str().parse().ok());
        return (Some(1), e);
    }

    (None, None)
}

/// Clean up scraped title: remove bracketed tags, release scene codes, site watermarks,
/// and strip episode tags so the title is a pure show/movie name for TMDB/Cinemeta queries.
pub fn clean_scraped_title(raw: &str) -> (String, Option<u32>) {
    let mut title = raw.trim().to_string();

    // 1. Remove file extension at end first
    let ext_re = Regex::new(r"(?i)\.(mp4|mkv|avi|webm|mov|flv|ts|m4v|epub|pdf|cbr|cbz|zip|rar|7z|mp3|flac|m4a|m4b|jpg|jpeg|png)$").unwrap();
    title = ext_re.replace(&title, "").to_string();

    // 2. Strip site watermarks like "Watch <Title> Online Free | SiteName"
    if let Some(idx) = title.find(" | ") {
        title = title[..idx].trim().to_string();
    }
    if let Some(idx) = title.find(" — ") {
        title = title[..idx].trim().to_string();
    }

    // Strip leading "Watch "
    if title.to_lowercase().starts_with("watch ") {
        title = title[6..].trim().to_string();
    }

    // 3. Replace dots/underscores if used as separators
    let dot_count = title.matches('.').count();
    let space_count = title.matches(' ').count();
    if dot_count > 1 || space_count <= 1 {
        title = title.replace('.', " ");
    }
    title = title.replace('_', " ");

    // 4. Extract year and remove it from title
    let year_re = Regex::new(r"[\(\[\s](19\d{2}|20\d{2})[\)\]\s]?").unwrap();
    let mut year = None;
    if let Some(cap) = year_re.captures(&title) {
        if let Some(m) = cap.get(1) {
            year = m.as_str().parse::<u32>().ok();
        }
    }
    if year.is_some() {
        let year_strip_re = Regex::new(r"[\(\[]?(19\d{2}|20\d{2})[\)\]]?").unwrap();
        title = year_strip_re.replace_all(&title, " ").to_string();
    }

    // 5. Strip TV Season / Episode tags from the title string for clean TMDB catalog search
    let season_ep_strip = Regex::new(r"(?i)\b(?:season|chapter|series)\s*\d+[^\w\n]+(?:episode|ep)\s*\d+\b").unwrap();
    title = season_ep_strip.replace_all(&title, " ").to_string();

    let se_strip = Regex::new(r"(?i)\b[Ss]\d{1,2}[Ee]\d{1,3}\b").unwrap();
    title = se_strip.replace_all(&title, " ").to_string();

    let ep_strip = Regex::new(r"(?i)\b(?:episode|ep)\s*\d+\b").unwrap();
    title = ep_strip.replace_all(&title, " ").to_string();

    // 6. Strip common release tags and watermarks
    let junk_patterns = [
        r"(?i)\b(1080p|720p|480p|2160p|4k|uhd)\b",
        r"(?i)\b(bluray|blu-ray|bdrip|brrip|web-dl|webrip|web|hdrip|dvdrip|hdtv)\b",
        r"(?i)\b(x264|x265|h264|h265|hevc|av1|xvid|divx)\b",
        r"(?i)\b(aac|ac3|eac3|dts|dts-hd|truehd|atmos|mp3|dd5\.1|ddp5\.1)\b",
        r"(?i)\b(remux|repack|proper|unrated|extended|directors cut)\b",
        r"(?i)\b(rarbg|yify|yts|eztv|ettv|tgx|galaxyrg|psa|qxr|sparks)\b",
        r"(?i)\b(moviebite|miruro|streamtape|doodstream|clicknupload|baddieseast|brokensilenze)\b",
        r"(?i)\b(tubitv|tubi|baddieshub|readcomicsonline|mangadex|miruro|yomi)\b",
        r"(?i)\b[a-z0-9-]{3,}\.(?:com|net|org|cc|to|ru|io|tv|me|sh)\b",
        r"(?i)\b(online free|free stream|full movie)\b",
        r"\[.*?\]",
        r"\(.*?\)",
    ];

    for pat in &junk_patterns {
        if let Ok(re) = Regex::new(pat) {
            title = re.replace_all(&title, " ").to_string();
        }
    }

    // 7. Clean up trailing or orphaned punctuation/delimiters like "-", "–", ":"
    let punct_re = Regex::new(r"[\s\-_–|:]+$").unwrap();
    title = punct_re.replace(&title, "").to_string();

    let prefix_re = Regex::new(r"^[\s\-_–|:]+").unwrap();
    title = prefix_re.replace(&title, "").to_string();

    // 8. Collapse multiple spaces
    let space_re = Regex::new(r"\s+").unwrap();
    let cleaned = space_re.replace_all(&title, " ").trim().to_string();

    (if cleaned.is_empty() { raw.to_string() } else { cleaned }, year)
}

fn detect_media_type(title: &str, url: &str, content_type: &str) -> String {
    let lower_title = title.to_lowercase();
    let lower_url = url.to_lowercase();
    let lower_ct = content_type.to_lowercase();

    // 1. Adult tokens check first - explicit videos
    let adult_tokens = ["adult", "xxx", "porn", "hentai", "jav", "erotic", "nsfw", "sxyprn", "cloudbate", "showcamrips"];
    if adult_tokens.iter().any(|&tok| lower_title.contains(tok) || lower_url.contains(tok)) {
        return "adult".to_string();
    }

    // 2. TV / Series check
    let tv_re = Regex::new(r"(?i)\b(s\d{1,2}e\d{1,2}|season\s*\d+|episode\s*\d+)\b").unwrap();
    if tv_re.is_match(&lower_title) || tv_re.is_match(&lower_url) || lower_url.contains("/watch/tv/") || lower_url.contains("gogoanime") || lower_url.contains("-episode-") {
        return "tv".to_string();
    }

    // 3. Books / Documents
    let book_exts = [".epub", ".pdf", ".mobi", ".azw3", ".cbr", ".cbz", ".djvu", ".txt"];
    if book_exts.iter().any(|&e| lower_url.ends_with(e) || lower_title.ends_with(e)) {
        return "books".to_string();
    }

    // 4. Archives
    let archive_exts = [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".iso"];
    if archive_exts.iter().any(|&e| lower_url.ends_with(e) || lower_title.ends_with(e)) {
        return "archive".to_string();
    }

    // 5. Photos / Images
    let photo_exts = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg", ".tiff", ".avif"];
    if photo_exts.iter().any(|&e| lower_url.ends_with(e) || lower_title.ends_with(e)) {
        return "photos".to_string();
    }

    // 5. Audio / Music
    if lower_ct.starts_with("audio/")
        || lower_url.ends_with(".mp3")
        || lower_url.ends_with(".flac")
        || lower_url.ends_with(".m4a")
        || lower_url.ends_with(".m4b")
        || lower_url.ends_with(".aac")
        || lower_url.ends_with(".ogg")
        || lower_url.ends_with(".opus")
        || lower_url.ends_with(".wav")
        || lower_url.contains("iheart.com")
        || lower_url.contains("ihrhls.com")
        || lower_url.contains("revma.ihrhls.com")
        || lower_url.contains("jiosaavn.com")
        || lower_url.contains("saavn.com")
        || lower_url.contains("squid.wtf")
    {
        return "music".to_string();
    }

    "movies".to_string()
}

fn is_direct_media_url(url: &str) -> bool {
    let clean = url.split('?').next().unwrap_or(url).to_lowercase();

    // Authenticated direct download URLs from Easynews or Debrid providers
    if (clean.contains("easynews.com/dl/") || clean.contains("easynews.com:443/dl/") || clean.contains("easynews.com:444/dl/"))
        || clean.contains("pixeldrain.com/api/file/")
        || clean.contains("pixeldrain.com/u/")
        || clean.contains("pixeldrain.com/file/")
        || clean.contains("real-debrid.com/d/")
        || (clean.contains("premiumize.me") && (clean.contains("/transfer/") || clean.contains("/file/")))
        || (clean.contains("offcloud.com") && clean.contains("/cloud/"))
    {
        return true;
    }

    // Webpage URLs from video hosts / streaming portals must NOT be treated as raw media files,
    // even if the webpage URL includes a filename like "/v/123/movie.mp4"
    if clean.contains("streamtape.")
        || clean.contains("streamta.pe")
        || clean.contains("dood.")
        || clean.contains("doodstream.")
        || clean.contains("dooood.")
        || clean.contains("mixdrop.")
        || clean.contains("voe.")
        || clean.contains("johnfullwonder.")
        || clean.contains("filemoon.")
        || clean.contains("bysesayeveum.")
        || clean.contains("byse.")
        || clean.contains("vidmoly.")
        || clean.contains("vkspeed.")
        || clean.contains("lulustream.")
        || clean.contains("luluvdo.")
        || clean.contains("showcamrips.")
        || clean.contains("pornhub.com")
        || clean.contains("sxyprn.com")
        || clean.contains("gogoanime")
        || clean.contains("gogoanimes")
        || clean.contains("yomi.to")
        || clean.contains("youtube.com")
        || clean.contains("youtu.be")
        || clean.contains("moviebite.org")
        || clean.contains("baddieseast.")
        || clean.contains("brokensilenze.")
        || clean.contains("archive.org/details/")
        || clean.contains("filester.")
    {
        return false;
    }

    // Video formats
    clean.ends_with(".mp4")
        || clean.ends_with(".mkv")
        || clean.ends_with(".webm")
        || clean.ends_with(".m3u8")
        || clean.ends_with(".mpd")
        || clean.ends_with(".avi")
        || clean.ends_with(".mov")
        || clean.ends_with(".flv")
        || clean.ends_with(".ts")
        || clean.ends_with(".m2ts")
        || clean.ends_with(".wmv")
        || clean.ends_with(".vob")
        || clean.ends_with(".iso")
        // Audio formats
        || clean.ends_with(".mp3")
        || clean.ends_with(".m4a")
        || clean.ends_with(".m4b")
        || clean.ends_with(".aac")
        || clean.ends_with(".flac")
        || clean.ends_with(".wav")
        || clean.ends_with(".ogg")
        || clean.ends_with(".opus")
        // Document / Book formats
        || clean.ends_with(".epub")
        || clean.ends_with(".pdf")
        || clean.ends_with(".mobi")
        || clean.ends_with(".cbr")
        || clean.ends_with(".cbz")
        || clean.ends_with(".txt")
        // Archive formats
        || clean.ends_with(".zip")
        || clean.ends_with(".rar")
        || clean.ends_with(".7z")
        || clean.ends_with(".tar")
        || clean.ends_with(".gz")
        // Photo formats
        || clean.ends_with(".jpg")
        || clean.ends_with(".jpeg")
        || clean.ends_with(".png")
        || clean.ends_with(".webp")
        || clean.ends_with(".gif")
}

// ─────────────────────────────────────────────────────────────────────────────
// Host Extractors Ported from DirectPlay Extension
// ─────────────────────────────────────────────────────────────────────────────

/// MovieBite (`moviebite.org`): Extracts 1080p HLS playlists via verified internal API.
async fn extract_moviebite(url: &str, client: &reqwest::Client) -> Result<WebStreamInfo, String> {
    let movie_re = Regex::new(r"(?i)moviebite\.org/watch/(movie|tv)/(\d+)").unwrap();
    let (media_type, tmdb_id) = if let Some(cap) = movie_re.captures(url) {
        (cap[1].to_lowercase(), cap[2].to_string())
    } else {
        return Err("Not a supported MovieBite watch link".to_string());
    };

    let (detected_s, detected_e) = detect_season_episode(url);
    let mut season = detected_s.unwrap_or(1).to_string();
    let mut episode = detected_e.unwrap_or(1).to_string();

    if let Ok(parsed_url) = reqwest::Url::parse(url) {
        for (k, v) in parsed_url.query_pairs() {
            if k == "ep" || k == "episode" || k == "e" {
                episode = v.to_string();
            }
            if k == "season" || k == "s" {
                season = v.to_string();
            }
        }
    }

    let api_url = format!(
        "https://moviebite.org/api/watch?id={}&tmdbId={}&type={}&mediaType={}&season={}&s={}&episode={}&ep={}&mode=fast&expand=0",
        tmdb_id, tmdb_id, media_type, media_type, season, season, episode, episode
    );

    let resp = client
        .get(&api_url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .header("Accept", "application/json")
        .header("X-MovieBite-Client", "1")
        .header("Referer", url)
        .send()
        .await
        .map_err(|e| format!("MovieBite API request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("MovieBite API returned status {}", resp.status()));
    }

    let text = resp.text().await.map_err(|e| format!("Failed reading MovieBite response: {}", e))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Failed parsing MovieBite JSON: {}", e))?;
    let streams = json["results"]["streams"].as_array().ok_or("No streams found in MovieBite response")?;
    if streams.is_empty() {
        return Err("No playable streams available on MovieBite for this title".to_string());
    }

    #[derive(Debug, Clone)]
    struct MirrorCandidate {
        direct_url: String,
        server_name: String,
        quality: String,
        score: i32,
    }

    let mut candidates: Vec<MirrorCandidate> = Vec::new();

    // Iterate through all server mirrors (Saturn, Jupiter, Uranus, Titan, Lyra, etc.)
    for stream in streams {
        let stream_url_raw = stream["url"].as_str().unwrap_or("").trim();
        if stream_url_raw.is_empty() {
            continue;
        }

        let mut direct_url = if stream_url_raw.starts_with("/stream-embed/") {
            format!("https://moviebite.org{}", stream_url_raw)
        } else {
            stream_url_raw.to_string()
        };

        // If MovieBite embeds a base64 JWT token containing direct m3u8 or cloudUrl, decode it
        if let Some(token_part) = stream_url_raw.split('/').last() {
            let payload = token_part.split('.').nth(1).unwrap_or(token_part.split('.').next().unwrap_or(token_part));
            use base64::Engine;
            if let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload)
                .or_else(|_| base64::engine::general_purpose::STANDARD.decode(payload))
                .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
            {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    if let Some(target) = v["m3u8"].as_str().or_else(|| v["cloudUrl"].as_str()) {
                        if target.starts_with("http") {
                            direct_url = target.to_string();
                        }
                    }
                }
            }
        }

        let server_name = stream["server"]
            .as_str()
            .or_else(|| stream["name"].as_str())
            .unwrap_or("Mirror")
            .to_string();

        let quality = stream["quality"].as_str().unwrap_or("1080p HD").to_string();

        // Calculate mirror reliability and quality score
        let mut score = 0;
        let lower_url = direct_url.to_lowercase();
        let lower_srv = server_name.to_lowercase();
        let lower_q = quality.to_lowercase();

        // 1. Reliability & CDN Architecture
        if lower_url.contains("workers.dev") || lower_url.contains("tnmr.org") || lower_url.contains("bx5") {
            score += 250; // Proven high-speed Cloudflare Worker edge stream
        } else if lower_url.contains("dragonballzfans") || lower_srv.contains("titan") {
            score += 180;
        } else if lower_url.contains(".m3u8") && !lower_url.contains("cdn-proxy") && !lower_url.contains("dexter.pw") {
            score += 150;
        } else if lower_url.contains("dexter.pw") {
            score += 70; // Working but can experience cross-domain hops
        } else if lower_url.contains("cdn-proxy") {
            score -= 60; // Frequently throws 427 or Cloudflare challenges
        }

        // 2. Resolution bonus
        if lower_q.contains("1080") {
            score += 100;
        } else if lower_q.contains("2160") || lower_q.contains("4k") {
            score += 80;
        } else if lower_q.contains("720") {
            score += 50;
        } else if lower_q.contains("480") {
            score += 20;
        }

        // 3. Known fast server names
        if lower_srv.contains("uranus") || lower_srv.contains("jupiter") {
            score += 30;
        }

        candidates.push(MirrorCandidate {
            direct_url,
            server_name,
            quality,
            score,
        });
    }

    // Sort descending by priority score
    candidates.sort_by(|a, b| b.score.cmp(&a.score));

    let mut selected_direct_url: Option<String> = None;
    let mut selected_quality = "1080p HD".to_string();
    let mut selected_server = "Saturn".to_string();

    // Probe mirrors in priority order to guarantee live video packets
    for cand in &candidates {
        if let Ok(check_resp) = client
            .get(&cand.direct_url)
            .header("Range", "bytes=0-512")
            .header("Referer", "https://moviebite.org/")
            .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
            .send()
            .await
        {
            let status = check_resp.status();
            // Never accept 403 Forbidden, 404, 427, or 5xx server errors
            if status.is_success() || status.as_u16() == 206 || status.as_u16() == 302 || status.as_u16() == 301 {
                // If body bytes returned, verify it's not a Cloudflare HTML challenge or error page
                if let Ok(bytes) = check_resp.bytes().await {
                    let head_str = String::from_utf8_lossy(&bytes[..std::cmp::min(bytes.len(), 256)]).to_lowercase();
                    if head_str.contains("<!doctype") || head_str.contains("<html") || head_str.contains("captcha") || head_str.contains("forbidden") {
                        continue;
                    }
                }
                selected_direct_url = Some(cand.direct_url.clone());
                selected_quality = cand.quality.clone();
                selected_server = cand.server_name.clone();
                break;
            }
        }
    }

    // Fallback to highest ranked candidate that isn't a known dead proxy
    if selected_direct_url.is_none() {
        if let Some(best) = candidates.iter().find(|c| !c.direct_url.contains("cdn-proxy")) {
            selected_direct_url = Some(best.direct_url.clone());
            selected_quality = best.quality.clone();
            selected_server = best.server_name.clone();
        }
    }

    let direct_url = selected_direct_url.ok_or_else(|| "No working server mirrors found on MovieBite".to_string())?;
    let provider_name = format!("MovieBite {} ({})", selected_server, selected_quality);

    let title_raw = json["results"]["source"].as_str()
        .or_else(|| json["results"]["media"]["title"].as_str())
        .unwrap_or("Movie");
    let (clean_title, year) = clean_scraped_title(title_raw);
    let (s_detected, e_detected) = detect_season_episode(url);
    let ep_num = e_detected.or_else(|| episode.parse().ok());
    let season_num = s_detected.or(if media_type == "tv" { Some(1) } else { None });

    Ok(WebStreamInfo {
        original_url: url.to_string(),
        direct_stream_url: Some(direct_url),
        raw_title: title_raw.to_string(),
        clean_title,
        description: None,
        poster_url: None,
        provider: provider_name,
        is_direct_media: false,
        media_type: if media_type == "tv" { "tv".into() } else { "movies".into() },
        year,
        format: Some("m3u8".into()),
        season: season_num,
        episode: ep_num,
    })
}

/// Resolve Yomi.to / CineXtream anime stream using WebAssembly decryptor (English Dub preferred, fallback to Sub)
async fn resolve_cinextream(ani_id: &str, ep: &str) -> Result<(String, String), String> {
    let script = r#"
const crypto = require("crypto");
const fs = require("fs");

async function resolve(anilistId, episode) {
  const _SALT = "c1n3t4r-0bf5c4t10n-s4lt-v1-2024-09";
  const hash = crypto.createHash("sha256").update(anilistId + _SALT).digest();
  const key = new Uint8Array(hash);

  const cachePath = require("path").join(require("os").tmpdir(), "cinextream_decrypt.wasm");
  let wasmBuf;
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 10000) {
    wasmBuf = fs.readFileSync(cachePath);
  } else {
    const res = await fetch("https://cinextream.cc/decrypt.wasm");
    wasmBuf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(cachePath, wasmBuf);
  }

  const { instance } = await WebAssembly.instantiate(wasmBuf, { env: { abort: () => {} } });
  const { memory, allocBuffer, freeBuffer, normalizeBuffer } = instance.exports;

  // 1. Try English Dub first
  let categoryUsed = "dub";
  let apiUrl = `https://cinextream.cc/api/anime-stream?anilistId=${anilistId}&episode=${episode}&category=dub`;
  let apiRes = await fetch(apiUrl, {
    headers: { "Referer": `https://cinextream.cc/api/embed/anime/dub/${anilistId}/${episode}` }
  });
  let raw = await apiRes.json().catch(() => null);

  // 2. Fallback to Subtitles if Dub is unavailable
  if (!raw || !raw.enc) {
    categoryUsed = "sub";
    apiUrl = `https://cinextream.cc/api/anime-stream?anilistId=${anilistId}&episode=${episode}&category=sub`;
    apiRes = await fetch(apiUrl, {
      headers: { "Referer": `https://cinextream.cc/api/embed/anime/sub/${anilistId}/${episode}` }
    });
    raw = await apiRes.json().catch(() => null);
  }

  if (!raw || !raw.enc) {
    throw new Error("No encrypted stream payload returned for dub or sub");
  }

  const binary = Buffer.from(raw.enc, "base64");
  const encBytes = new Uint8Array(binary);
  const encPtr = allocBuffer(encBytes.length);
  const keyPtr = allocBuffer(32);
  const outPtr = allocBuffer(encBytes.length);

  let view = new Uint8Array(memory.buffer);
  view.set(encBytes, encPtr);
  view.set(key, keyPtr);
  const len = normalizeBuffer(encPtr, encBytes.length, keyPtr, outPtr);
  view = new Uint8Array(memory.buffer);
  const out = view.slice(outPtr, outPtr + len);
  freeBuffer(encPtr); freeBuffer(keyPtr); freeBuffer(outPtr);

  const decrypted = JSON.parse(new TextDecoder().decode(out));
  if (!decrypted || !decrypted.stream_url) {
    throw new Error("Missing stream_url in decrypted output");
  }
  decrypted.category = categoryUsed;
  process.stdout.write(JSON.stringify(decrypted));
}

const id = process.argv[1];
const ep = process.argv[2];
resolve(id, ep).catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
"#;

    let output = tokio_command("node")
        .arg("-e")
        .arg(script)
        .arg(ani_id)
        .arg(ep)
        .output()
        .await
        .map_err(|e| format!("Failed to execute node decryptor: {}", e))?;

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        return Err(format!("CineXtream decryptor failed: {}", err_msg.trim()));
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let val: serde_json::Value = serde_json::from_str(&stdout_str)
        .map_err(|e| format!("Failed to parse CineXtream JSON: {}", e))?;

    if let Some(stream_url) = val["stream_url"].as_str() {
        if !stream_url.is_empty() {
            let cat = val["category"].as_str().unwrap_or("dub").to_string();
            return Ok((stream_url.to_string(), cat));
        }
    }

    Err("No stream_url in CineXtream response".to_string())
}

/// Fetches the raw CineXtream encrypted payload and decrypt.wasm bytes so the frontend
/// can decrypt in-browser via WebAssembly without requiring a local Node.js binary.
#[tauri::command]
pub async fn get_cinextream_payload(anilist_id: String, episode: String) -> Result<serde_json::Value, String> {
    let client = build_client()?;

    // 1. Try English Dub first
    let mut category_used = "dub";
    let mut api_url = format!("https://cinextream.cc/api/anime-stream?anilistId={}&episode={}&category=dub", anilist_id, episode);
    let mut referer = format!("https://cinextream.cc/api/embed/anime/dub/{}/{}", anilist_id, episode);

    let resp = client.get(&api_url).header("Referer", &referer).send().await;
    let mut json_val: Option<serde_json::Value> = None;
    if let Ok(r) = resp {
        if let Ok(t) = r.text().await {
            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&t) {
                if j.get("enc").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
                    json_val = Some(j);
                }
            }
        }
    }

    // 2. Fallback to Subtitles if Dub is unavailable
    if json_val.is_none() {
        category_used = "sub";
        api_url = format!("https://cinextream.cc/api/anime-stream?anilistId={}&episode={}&category=sub", anilist_id, episode);
        referer = format!("https://cinextream.cc/api/embed/anime/sub/{}/{}", anilist_id, episode);
        let resp_sub = client.get(&api_url).header("Referer", &referer).send().await;
        if let Ok(r) = resp_sub {
            if let Ok(t) = r.text().await {
                if let Ok(j) = serde_json::from_str::<serde_json::Value>(&t) {
                    if j.get("enc").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
                        json_val = Some(j);
                    }
                }
            }
        }
    }

    let payload = json_val.ok_or_else(|| "No encrypted stream payload returned from CineXtream for dub or sub".to_string())?;
    let enc_str = payload["enc"].as_str().ok_or_else(|| "Missing enc in CineXtream response".to_string())?;

    // 3. Fetch decrypt.wasm bytes (cached in temp dir)
    let temp_wasm = std::env::temp_dir().join("cinextream_decrypt.wasm");
    let wasm_bytes = if temp_wasm.exists() && std::fs::metadata(&temp_wasm).map(|m| m.len() > 10000).unwrap_or(false) {
        std::fs::read(&temp_wasm).map_err(|e| format!("Failed reading cached wasm: {}", e))?
    } else {
        let wasm_resp = client.get("https://cinextream.cc/decrypt.wasm").send().await
            .map_err(|e| format!("Failed to download decrypt.wasm: {}", e))?;
        if !wasm_resp.status().is_success() {
            return Err(format!("decrypt.wasm download returned status {}", wasm_resp.status()));
        }
        let bytes = wasm_resp.bytes().await.map_err(|e| format!("Failed reading wasm bytes: {}", e))?;
        if !bytes.starts_with(b"\0asm") {
            return Err("Downloaded decrypt.wasm is corrupted or not a valid WASM binary".to_string());
        }
        let _ = std::fs::write(&temp_wasm, &bytes);
        bytes.to_vec()
    };

    use base64::Engine;
    let wasm_base64 = base64::engine::general_purpose::STANDARD.encode(&wasm_bytes);

    Ok(serde_json::json!({
        "enc": enc_str,
        "wasm_base64": wasm_base64,
        "category": category_used,
        "anilist_id": anilist_id,
        "episode": episode
    }))
}

/// Yomi.to Anime Watch URL Extractor:
/// Resolves /watch/{slug}-{anilist_id}/{episode} via CineXtream HLS resolver (with 4Animo fallback) to get direct master.m3u8 playlist.
async fn extract_yomi(url: &str, _client: &reqwest::Client) -> Result<WebStreamInfo, String> {
    let watch_re = Regex::new(r"(?i)yomi\.to/watch/([^/?#]+)-(\d+)/(\d+)").unwrap();
    let (slug, ani_id, ep) = if let Some(cap) = watch_re.captures(url) {
        (cap[1].to_string(), cap[2].to_string(), cap[3].to_string())
    } else {
        return Err("Invalid Yomi.to watch URL format".to_string());
    };

    let clean_title = slug.replace('-', " ");
    let ep_num: Option<u32> = ep.parse().ok();

    // 1. Primary: CineXtream clean unencrypted HLS stream (prefer English Dub)
    if let Ok((direct_m3u8, cat)) = resolve_cinextream(&ani_id, &ep).await {
        let provider_label = if cat == "dub" {
            "Yomi.to (English Dub)".to_string()
        } else {
            "Yomi.to (Subtitled)".to_string()
        };
        let title_formatted = if cat == "dub" {
            format!("{} Episode {} [Dub]", clean_title, ep)
        } else {
            format!("{} Episode {}", clean_title, ep)
        };
        info!(target: "stream", "Successfully resolved clean Yomi stream via CineXtream ({}): {}", cat, direct_m3u8);
        return Ok(WebStreamInfo {
            original_url: url.to_string(),
            direct_stream_url: Some(direct_m3u8),
            raw_title: title_formatted.clone(),
            clean_title: title_formatted,
            description: None,
            poster_url: None,
            provider: provider_label,
            is_direct_media: false,
            media_type: "tv".to_string(),
            year: None,
            format: Some("m3u8".to_string()),
            season: Some(1),
            episode: ep_num,
        });
    }

    // 2. Fallback when local Node.js is unavailable (e.g. standard Windows installations):
    // Delegate to in-browser WebAssembly decryptor using get_cinextream_payload
    let title_formatted = format!("{} Episode {} [Dub]", clean_title, ep);
    info!(target: "stream", "Node decryptor not available; delegating CineXtream stream resolution to frontend WebAssembly: ani_id={}, ep={}", ani_id, ep);
    Ok(WebStreamInfo {
        original_url: url.to_string(),
        direct_stream_url: Some(format!("cinextream://{}/{}", ani_id, ep)),
        raw_title: title_formatted.clone(),
        clean_title: title_formatted,
        description: None,
        poster_url: None,
        provider: "Yomi.to (English Dub)".to_string(),
        is_direct_media: false,
        media_type: "tv".to_string(),
        year: None,
        format: Some("m3u8".to_string()),
        season: Some(1),
        episode: ep_num,
    })
}

/// Extracts direct MP4/HLS stream URL for PornHub video URLs.
async fn extract_pornhub(url: &str, client: &reqwest::Client) -> Result<WebStreamInfo, String> {
    let (clean_title, year) = clean_scraped_title(url);

    // 1. Try yt-dlp first if available (fastest and most resilient)
    if let Some(bin) = crate::commands::download::find_yt_dlp_binary() {
        if let Ok(output) = tokio_command(&bin)
            .arg("-g")
            .arg("-f")
            .arg("best[ext=mp4]/best")
            .arg(url)
            .output()
            .await
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let direct = first_line.trim().to_string();
                    if direct.starts_with("http") {
                        return Ok(WebStreamInfo {
                            original_url: url.to_string(),
                            direct_stream_url: Some(direct),
                            raw_title: clean_title.clone(),
                            clean_title,
                            description: Some("PornHub Direct Stream".into()),
                            poster_url: None,
                            provider: "PornHub".into(),
                            is_direct_media: true,
                            media_type: "adult".into(),
                            year,
                            format: Some("mp4".into()),
                            season: None,
                            episode: None,
                        });
                    }
                }
            }
        }
    }

    // 2. Fallback: Parse HTML and extract mediaDefinitions
    let resp = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .header("Cookie", "age_verified=1; platform=pc")
        .send()
        .await
        .map_err(|e| format!("Failed to load PornHub video page: {}", e))?;

    let body = resp.text().await.map_err(|e| format!("Failed to read PornHub response: {}", e))?;
    let media_def_re = Regex::new(r#""mediaDefinitions"\s*:\s*(\[\s*\{.*?\}\s*\])"#).unwrap();
    let mut direct_url: Option<String> = None;

    if let Some(cap) = media_def_re.captures(&body) {
        if let Some(json_arr) = cap.get(1) {
            if let Ok(defs) = serde_json::from_str::<Vec<serde_json::Value>>(json_arr.as_str()) {
                let mut best_url = None;
                for def in &defs {
                    if let Some(v_url) = def["videoUrl"].as_str() {
                        if !v_url.is_empty() {
                            let clean = v_url.replace("\\/", "/");
                            if def["format"].as_str() == Some("hls") || clean.contains(".m3u8") {
                                best_url = Some(clean);
                                break;
                            }
                            if best_url.is_none() {
                                best_url = Some(clean);
                            }
                        }
                    }
                }
                direct_url = best_url;
            }
        }
    }

    if direct_url.is_none() {
        let direct_re = Regex::new(r#""videoUrl"\s*:\s*"(https?:[\\/]+[^"]+)""#).unwrap();
        if let Some(cap) = direct_re.captures(&body) {
            direct_url = Some(cap[1].replace("\\/", "/"));
        }
    }

    let poster_re = Regex::new(r#"(?i)<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']"#).unwrap();
    let poster_url = poster_re.captures(&body).and_then(|c| c.get(1)).map(|m| m.as_str().to_string());

    let og_title_re = Regex::new(r#"(?i)<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']"#).unwrap();
    let resolved_title = og_title_re.captures(&body).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string()).unwrap_or(clean_title);

    Ok(WebStreamInfo {
        original_url: url.to_string(),
        direct_stream_url: direct_url,
        raw_title: resolved_title.clone(),
        clean_title: resolved_title,
        description: Some("PornHub Stream".into()),
        poster_url,
        provider: "PornHub".into(),
        is_direct_media: true,
        media_type: "adult".into(),
        year,
        format: Some("mp4".into()),
        season: None,
        episode: None,
    })
}

fn base_encode(mut n: usize, radix: u32) -> String {
    const CHARS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if n == 0 {
        return "0".to_string();
    }
    let mut digits = Vec::new();
    let r = (radix as usize).min(CHARS.len());
    while n > 0 {
        digits.push(CHARS[n % r] as char);
        n /= r;
    }
    digits.into_iter().rev().collect()
}

pub fn unpack_packed_js(packed: &str) -> Option<String> {
    let re = Regex::new(r#"}\s*\(\s*['"]((?:\\'|[^'])*)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]((?:\\'|[^'])*)['"]\.split\(['"]\|['"]\)"#).ok()?;
    let cap = re.captures(packed)?;
    let p = cap.get(1)?.as_str();
    let a: u32 = cap.get(2)?.as_str().parse().ok()?;
    let c: usize = cap.get(3)?.as_str().parse().ok()?;
    let words: Vec<&str> = cap.get(4)?.as_str().split('|').collect();

    let mut result = p.to_string();
    for i in (0..c).rev() {
        let key = base_encode(i, a);
        if let Some(replacement) = words.get(i) {
            if !replacement.is_empty() {
                if let Ok(token_re) = Regex::new(&format!(r"\b{}\b", regex::escape(&key))) {
                    result = token_re.replace_all(&result, *replacement).to_string();
                }
            }
        }
    }
    Some(result)
}

/// Vidmoly (`vidmoly.to`, `vidmoly.me`, `vidmoly.org`):
/// Extracts master.m3u8 playlist directly from embed page.
async fn extract_vidmoly(url: &str, client: &reqwest::Client, referer: Option<&str>) -> Option<String> {
    let mut req = client.get(url);
    if let Some(r) = referer {
        req = req.header("Referer", r);
    }
    let resp = req.send().await.ok()?;
    let body = resp.text().await.ok()?;

    let sources_re = Regex::new(r#"sources:\s*\[\s*\{\s*file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]"#).ok()?;
    if let Some(c) = sources_re.captures(&body) {
        return Some(c.get(1)?.as_str().to_string());
    }

    let m3u8_re = Regex::new(r#"['"](https?://[^'"]+\.m3u8(?:\?[^'"]*)?)['"]"#).ok()?;
    if let Some(c) = m3u8_re.captures(&body) {
        return Some(c.get(1)?.as_str().to_string());
    }
    None
}

/// VOE (`voe.sx`, `johnfullwonder.com`):
/// Follows window.location.href redirects and extracts HLS stream.
async fn extract_voe(url: &str, client: &reqwest::Client, referer: Option<&str>) -> Option<String> {
    let mut req = client.get(url);
    if let Some(r) = referer {
        req = req.header("Referer", r);
    }
    let resp = req.send().await.ok()?;
    let body = resp.text().await.ok()?;

    let redirect_re = Regex::new(r#"window\.location\.href\s*=\s*['"]([^'"]+)['"]"#).ok()?;
    let target_url = if let Some(c) = redirect_re.captures(&body) {
        c.get(1)?.as_str().to_string()
    } else {
        url.to_string()
    };

    let page_body = if target_url != url {
        let resp2 = client.get(&target_url).header("Referer", url).send().await.ok()?;
        resp2.text().await.ok()?
    } else {
        body
    };

    let m3u8_re = Regex::new(r#"['"](https?://[^'"]+\.m3u8(?:\?[^'"]*)?)['"]"#).ok()?;
    if let Some(c) = m3u8_re.captures(&page_body) {
        return Some(c.get(1)?.as_str().to_string());
    }

    let hls_re = Regex::new(r#"(?:'hls'|"hls")\s*:\s*['"]([^'"]+)['"]"#).ok()?;
    if let Some(c) = hls_re.captures(&page_body) {
        return Some(c.get(1)?.as_str().to_string());
    }

    None
}

/// VKSpeed (`vkspeed.com`):
/// Unpacks Dean Edwards packed JS to extract 720p/360p direct mp4 stream.
async fn extract_vkspeed(url: &str, client: &reqwest::Client, referer: Option<&str>) -> Option<String> {
    let mut req = client.get(url);
    if let Some(r) = referer {
        req = req.header("Referer", r);
    }
    let resp = req.send().await.ok()?;
    let body = resp.text().await.ok()?;

    let text_to_search = if let Some(unpacked) = unpack_packed_js(&body) {
        unpacked
    } else {
        body
    };

    let mp4_re = Regex::new(r#"(https?://[^"'\s\\]+\.vkcdn\d*\.com/[^"'\s\\]+/v\.mp4)"#).ok()?;
    if let Some(c) = mp4_re.captures(&text_to_search) {
        return Some(c.get(1)?.as_str().to_string());
    }

    let generic_mp4 = Regex::new(r#"['"](https?://[^"']+\.mp4(?:\?[^"']*)?)['"]"#).ok()?;
    if let Some(c) = generic_mp4.captures(&text_to_search) {
        return Some(c.get(1)?.as_str().to_string());
    }

    None
}

/// OK.ru / Odnoklassniki: Extracts direct MP4 (or HLS manifest) from embedded video player or video page.
async fn extract_ok_ru(url: &str, client: &reqwest::Client, referer: Option<&str>) -> Option<String> {
    let mut clean_url = if url.starts_with("//") {
        format!("https:{}", url)
    } else {
        url.to_string()
    };
    clean_url = clean_url.replace("&#038;", "&").replace("&amp;", "&");
    if clean_url.contains("ok.ru/video/") && !clean_url.contains("ok.ru/videoembed/") {
        clean_url = clean_url.replace("ok.ru/video/", "ok.ru/videoembed/");
    }

    let mut req = client.get(&clean_url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
    if let Some(ref_val) = referer {
        req = req.header("Referer", ref_val);
    }
    let resp = req.send().await.ok()?;
    let bytes = resp.bytes().await.ok()?;
    let body = String::from_utf8_lossy(&bytes);

    let opt_re = Regex::new(r#"data-options=["']([^"']+)["']"#).ok()?;
    if let Some(cap) = opt_re.captures(&body) {
        let raw_options = cap.get(1)?.as_str();
        let decoded = decode_html_entities(raw_options);
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&decoded) {
            let fv = &json["flashvars"];
            let meta_val = if fv["metadata"].is_object() {
                Some(fv["metadata"].clone())
            } else if let Some(meta_str) = fv["metadata"].as_str() {
                serde_json::from_str::<serde_json::Value>(meta_str).ok()
            } else {
                None
            };

            let target = meta_val.as_ref().unwrap_or(fv);

            // 1. Direct MP4 videos array (preferred: unthrottled and reliable)
            if let Some(videos) = target["videos"].as_array() {
                for quality in ["full", "1080", "hd", "sd", "low", "lowest", "mobile"] {
                    for v in videos {
                        if v["name"].as_str() == Some(quality) {
                            if let Some(u) = v["url"].as_str() {
                                if !u.is_empty() {
                                    // Verify stream is alive and not IP-blocked/400 Bad Request
                                    if let Ok(resp) = client.head(u).header("Referer", "https://ok.ru/").send().await {
                                        if resp.status().is_success() || resp.status().as_u16() == 206 {
                                            return Some(u.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 2. HLS manifest fallback
            if let Some(hls) = target["hlsManifestUrl"].as_str() {
                if !hls.is_empty() {
                    if let Ok(resp) = client.head(hls).header("Referer", "https://ok.ru/").send().await {
                        if resp.status().is_success() || resp.status().as_u16() == 206 {
                            return Some(hls.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// VK (vk.com / vk.ru / vkvideo.ru): Extracts direct MP4 or HLS stream from VK video page or embed.
async fn extract_vk(url: &str, client: &reqwest::Client, referer: Option<&str>) -> Option<String> {
    // 1. Try yt-dlp first if available
    if let Some(bin) = crate::commands::download::find_yt_dlp_binary() {
        if let Ok(output) = tokio_command(&bin)
            .arg("-g")
            .arg("-f")
            .arg("best[ext=mp4]/best")
            .arg(url)
            .output()
            .await
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let s = first_line.trim().to_string();
                    if s.starts_with("http") {
                        return Some(s);
                    }
                }
            }
        }
    }

    // 2. Direct HTML scraping fallback
    let mut req = client.get(url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
    if let Some(r) = referer {
        req = req.header("Referer", r);
    }
    let resp = req.send().await.ok()?;
    let body = resp.text().await.ok()?;

    for q in ["url1080", "url720", "url480", "url360", "url240"] {
        if let Ok(q_re) = Regex::new(&format!(r#"(?i)["']{}["']\s*:\s*["'](https?:[\\/]+[^"']+)["']"#, q)) {
            if let Some(cap) = q_re.captures(&body) {
                if let Some(u) = cap.get(1) {
                    return Some(u.as_str().replace("\\/", "/"));
                }
            }
        }
    }

    if let Ok(hls_re) = Regex::new(r#"(?i)["']hls["']\s*:\s*["'](https?:[\\/]+[^"']+)["']"#) {
        if let Some(cap) = hls_re.captures(&body) {
            if let Some(u) = cap.get(1) {
                return Some(u.as_str().replace("\\/", "/"));
            }
        }
    }

    None
}

/// Dailymotion (`dailymotion.com`, `dai.ly`): Extracts HLS or direct stream via metadata API.
async fn extract_dailymotion(url: &str, client: &reqwest::Client) -> Option<String> {
    let id_re = Regex::new(r#"(?i)(?:video\/|dai\.ly\/)([a-zA-Z0-9]+)"#).ok()?;
    let video_id = id_re.captures(url).and_then(|c| c.get(1)).map(|m| m.as_str())?;

    let meta_url = format!("https://www.dailymotion.com/player/metadata/video/{}", video_id);
    if let Ok(resp) = client.get(&meta_url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .send()
        .await
    {
        if let Ok(text) = resp.text().await {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(arr) = json["qualities"]["auto"].as_array() {
                    if let Some(first) = arr.first() {
                        if let Some(hls) = first["url"].as_str() {
                            if !hls.is_empty() {
                                return Some(hls.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some(bin) = crate::commands::download::find_yt_dlp_binary() {
        if let Ok(output) = tokio_command(&bin).arg("-g").arg(url).output().await {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let s = first_line.trim().to_string();
                    if s.starts_with("http") {
                        return Some(s);
                    }
                }
            }
        }
    }

    None
}

/// BitChute (`bitchute.com`): Extracts MP4 stream from page metadata or HTML5 source.
async fn extract_bitchute(url: &str, client: &reqwest::Client) -> Option<String> {
    let resp = client.get(url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .send()
        .await
        .ok()?;
    let body = resp.text().await.ok()?;

    let og_vid_re = Regex::new(r#"(?i)<meta\s+property=["']og:video(?::secure_url)?["']\s+content=["']([^"']+\.mp4[^"']*)["']"#).ok()?;
    if let Some(c) = og_vid_re.captures(&body) {
        return Some(c.get(1)?.as_str().to_string());
    }

    let src_re = Regex::new(r#"(?i)<source\s+[^>]*src=["'](https?://[^"']+\.mp4[^"']*)["']"#).ok()?;
    if let Some(c) = src_re.captures(&body) {
        return Some(c.get(1)?.as_str().to_string());
    }

    let seed_re = Regex::new(r#"(?i)['"](https?://[^'"]*seed[^'"]*\.mp4[^'"]*)['"]"#).ok()?;
    if let Some(c) = seed_re.captures(&body) {
        return Some(c.get(1)?.as_str().to_string());
    }

    None
}

/// Odysee / LBRY (`odysee.com`): Extracts direct stream using yt-dlp or OpenGraph video metadata.
async fn extract_odysee(url: &str, client: &reqwest::Client) -> Option<String> {
    if let Some(bin) = crate::commands::download::find_yt_dlp_binary() {
        if let Ok(output) = tokio_command(&bin).arg("-g").arg(url).output().await {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let s = first_line.trim().to_string();
                    if s.starts_with("http") {
                        return Some(s);
                    }
                }
            }
        }
    }

    let resp = client.get(url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .send()
        .await
        .ok()?;
    let body = resp.text().await.ok()?;

    let og_vid_re = Regex::new(r#"(?i)<meta\s+property=["']og:video(?::secure_url)?["']\s+content=["'](https?://[^"']+)["']"#).ok()?;
    if let Some(c) = og_vid_re.captures(&body) {
        let stream = c.get(1)?.as_str();
        if stream.contains(".mp4") || stream.contains(".m3u8") {
            return Some(stream.to_string());
        }
    }

    None
}

/// PeerTube: Extracts direct HLS playlist or MP4 from the PeerTube REST API or instance page.
async fn extract_peertube(url: &str, client: &reqwest::Client) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let path = parsed.path();

    let uuid_re = Regex::new(r#"(?i)\/(?:w|videos\/watch)\/([a-zA-Z0-9_-]+)"#).ok()?;
    let uuid = uuid_re.captures(path).and_then(|c| c.get(1)).map(|m| m.as_str())?;

    let api_url = format!("https://{}/api/v1/videos/{}", host, uuid);
    if let Ok(resp) = client.get(&api_url).send().await {
        if let Ok(text) = resp.text().await {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(playlists) = json["streamingPlaylists"].as_array() {
                    for pl in playlists {
                        if let Some(pl_url) = pl["playlistUrl"].as_str() {
                            if !pl_url.is_empty() {
                                return Some(pl_url.to_string());
                            }
                        }
                    }
                }
                if let Some(files) = json["files"].as_array() {
                    for f in files {
                        if let Some(f_url) = f["fileUrl"].as_str() {
                            if !f_url.is_empty() {
                                return Some(f_url.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

/// Streamtape (`streamtape.com`, `streamtape.to`, `streamtape.net`, `streamtape.xyz`):
/// Normalizes endpoint and captures 302 redirect via HEAD request to tapecontent.net.
async fn extract_streamtape(url: &str, body: &str) -> Option<String> {
    let mut normalized_url: Option<String> = None;

    // 1. Modern Streamtape captchalink / norobotlink / ideoooolink pattern with chained .substring()
    // e.g. document.getElementById('norobotlink').innerHTML = '//streamtape.com/get_video?id=x' + ('xcd...').substring(1).substring(2);
    // e.g. document.getElementById('captchalink').innerHTML = '//streamtape.com/get_video?id=x'+ ('defg...').substring(4);
    let modern_st_re = Regex::new(
        r#"(?is)document\.getElementById\(['"]([a-zA-Z0-9_-]+)['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*(?:\+\s*['"][^'"]*['"]\s*)*\+\s*\(['"]([^'"]+)['"]\)((\.substring\(\d+\))+)"#
    ).ok()?;

    let sub_num_re = Regex::new(r#"\.substring\((\d+)\)"#).ok()?;

    for c in modern_st_re.captures_iter(body) {
        let elem_id = c.get(1).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
        let prefix = c.get(2).map(|m| m.as_str()).unwrap_or("");
        let token = c.get(3).map(|m| m.as_str()).unwrap_or("");
        let sub_chain = c.get(4).map(|m| m.as_str()).unwrap_or("");

        // Skip decoy honeypot elements if norobotlink / captchalink is available
        if elem_id.contains("ideo") && (body.contains("norobotlink") || body.contains("captchalink")) {
            continue;
        }

        let mut skip_total = 0;
        for sub_cap in sub_num_re.captures_iter(sub_chain) {
            if let Some(n) = sub_cap.get(1).and_then(|m| m.as_str().parse::<usize>().ok()) {
                skip_total += n;
            }
        }

        if token.len() >= skip_total {
            let mut link = format!("{}{}", prefix, &token[skip_total..]);
            if link.starts_with("//") {
                link = format!("https:{}", link);
            } else if !link.starts_with("http") {
                link = format!("https://{}", link.trim_start_matches('/'));
            }
            link = link.replace(".dcom/", ".com/").replace("streadmtape.com", "streamtape.com");
            normalized_url = Some(link);
            break;
        }
    }

    // 2. Legacy robotlink / ideoolink pattern
    if normalized_url.is_none() {
        let robotlink_re = Regex::new(r#"document\.getElementById\(['"](?:robotlink|ideoolink|ideoooolink)['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*\(['"]([^'"]+)['"]\)\.substring\((\d+)\)"#).ok()?;
        if let Some(c) = robotlink_re.captures(body) {
            if let (Some(base), Some(token), Some(sub)) = (c.get(1), c.get(2), c.get(3)) {
                if let Ok(skip) = sub.as_str().parse::<usize>() {
                    let tok_str = token.as_str();
                    if tok_str.len() >= skip {
                        let mut link = format!("https:{}{}", base.as_str(), &tok_str[skip..]);
                        if !link.starts_with("http") {
                            link = format!("https://{}", link.trim_start_matches('/'));
                        }
                        normalized_url = Some(link);
                    }
                }
            }
        }
    }

    // 3. Regex for token parameters: id=...&expires=...&ip=...&token=...
    if normalized_url.is_none() {
        let token_re = Regex::new(r"id=([a-zA-Z0-9_-]+)&expires=(\d+)&ip=([a-zA-Z0-9_-]+)&token=([a-zA-Z0-9_-]+)").ok()?;
        if let Some(m) = token_re.captures(body) {
            normalized_url = Some(format!(
                "https://streamtape.com/get_video?id={}&expires={}&ip={}&token={}",
                &m[1], &m[2], &m[3], &m[4]
            ));
        }
    }

    // 4. Normalize endpoint & append &stream=1
    if let Some(mut stream_url) = normalized_url {
        if let Ok(parsed) = reqwest::Url::parse(&stream_url) {
            if let Some(qs) = parsed.query() {
                if qs.contains("id=") && qs.contains("token=") {
                    stream_url = format!("https://streamtape.com/get_video?{}", qs);
                }
            }
        }
        if !stream_url.contains("stream=1") {
            if stream_url.contains('?') {
                stream_url.push_str("&stream=1");
            } else {
                stream_url.push_str("?stream=1");
            }
        }

        // Follow 302 redirect via HEAD request to capture direct tapecontent.net URL
        if let Some(final_url) = resolve_redirect_head(&stream_url, Some(url)).await {
            return Some(final_url);
        }
        return Some(stream_url);
    }
    None
}

/// Doodstream (`dood.watch`, `dood.to`, `doodstream.com`, `dooood.com`, etc.):
/// Fetches /pass_md5/{hash} with Referer and appends data token + expiry.
async fn extract_doodstream(url: &str, body: &str, client: &reqwest::Client) -> Option<String> {
    let parsed_url = reqwest::Url::parse(url).ok()?;
    let origin = format!("{}://{}", parsed_url.scheme(), parsed_url.host_str()?);

    let hash_re = Regex::new(r"/pass_md5/([\w]+)").ok()?;
    let hash = hash_re.captures(body)?.get(1)?.as_str().to_string();

    let token_re = Regex::new(r#"data\s*\+\s*["']([a-zA-Z0-9]{10,20})["']"#).ok()?;
    let token = token_re.captures(body)?.get(1)?.as_str().to_string();

    let expiry_re = Regex::new(r#"expiry\s*[=:]\s*["']?(\d{10,13})["']?"#).ok()?;
    let expiry = if let Some(m) = expiry_re.captures(body) {
        m.get(1)?.as_str().to_string()
    } else {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
        (now + 3600).to_string()
    };

    let pass_url = format!("{}/pass_md5/{}", origin, hash);
    let resp = client
        .get(&pass_url)
        .header("Referer", format!("{}/", origin))
        .send()
        .await
        .ok()?;

    if let Ok(cdn_base) = resp.text().await {
        let base = cdn_base.trim();
        if base.starts_with("http") {
            return Some(format!("{}{}?token={}&expiry={}", base, token, token, expiry));
        }
    }
    None
}

/// Mixdrop (`mixdrop.ag`, `mixdrop.co`, `mixdrop.to`, `mixdrop.sx`, `mixdrop.bz`):
/// Unpacks MDCore.wurl or (url|src) matching .mp4/.webm.
fn extract_mixdrop(body: &str) -> Option<String> {
    let wurl_re = Regex::new(r#"(?:MDCore\.)?wurl\s*=\s*["']([^"']+)["']"#).ok()?;
    if let Some(c) = wurl_re.captures(body) {
        let url = c.get(1)?.as_str();
        return Some(if url.starts_with("//") { format!("https:{}", url) } else { url.to_string() });
    }
    let src_re = Regex::new(r#""(?:url|src)"\s*:\s*"(https?:[^"]+\.(?:mp4|webm)[^"]*)""#).ok()?;
    if let Some(c) = src_re.captures(body) {
        return Some(c.get(1)?.as_str().to_string());
    }
    None
}

/// Filemoon (`filemoon.sx`, `filemoon.in`, `filemoon.to`, `filemoon.pk`, `bysesayeveum.com`, `byse`):
/// Extracts JWPlayer config or master .m3u8 playlist, unpacking JS if packed.
fn extract_filemoon(body: &str) -> Option<String> {
    let text = if let Some(unpacked) = unpack_packed_js(body) {
        unpacked
    } else {
        body.to_string()
    };
    let m3u8_re = Regex::new(r#"["'](?:file|sources|src)["']\s*:\s*["'](https?:[^"']+\.m3u8[^"']*)["']"#).ok()?;
    if let Some(c) = m3u8_re.captures(&text) {
        return Some(c.get(1)?.as_str().to_string());
    }
    let generic_m3u8 = Regex::new(r#"['"](https?://[^"']+\.m3u8(?:\?[^"']*)?)['"]"#).ok()?;
    if let Some(c) = generic_m3u8.captures(&text) {
        return Some(c.get(1)?.as_str().to_string());
    }
    None
}

/// Bunkr (`bunkr.pk`, `bunkrr.su`, `bunkr.si`, `bunkr.cr`, etc.):
/// Extracts jsCDN + signUrl and calls sign API for authenticated CDN stream.
async fn extract_bunkr(_url: &str, body: &str, client: &reqwest::Client) -> Option<String> {
    let cdn_re = Regex::new(r#"var\s+jsCDN\s*=\s*["']([^"']+)["']"#).ok()?;
    let sign_re = Regex::new(r#"var\s+signUrl\s*=\s*["']([^"']+)["']"#).ok()?;

    let raw_js_cdn = cdn_re.captures(body)?.get(1)?.as_str().to_string();
    let js_cdn = raw_js_cdn.replace(r"\/", "/").replace('\\', "");
    let raw_sign_url = sign_re.captures(body).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "https://glb-apisign.cdn.cr/sign".to_string());
    let sign_url = raw_sign_url.replace(r"\/", "/").replace('\\', "");

    let full_cdn = if js_cdn.starts_with("//") {
        format!("https:{}", js_cdn)
    } else {
        js_cdn
    };

    let mut cdn_url = reqwest::Url::parse(&full_cdn).ok()?;
    let path = cdn_url.path().to_string();

    let sign_req_url = format!("{}?path={}", sign_url, &path);
    let resp = client.get(&sign_req_url).send().await.ok()?;
    let text = resp.text().await.ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;

    let token = json["token"].as_str()?;
    let ex = json["ex"].to_string();

    cdn_url.query_pairs_mut().append_pair("token", token).append_pair("ex", &ex);
    Some(cdn_url.to_string())
}

/// Filester (`filester.sh`, `filester.me`, `filester.si`, `filester.gg`):
/// POSTs file slug to /v2/api/public/view for short-lived stream token.
async fn extract_filester(url: &str, client: &reqwest::Client) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let origin = format!("{}://{}", parsed.scheme(), parsed.host_str()?);
    let slug = parsed.path().trim_end_matches('/').split('/').last()?;

    let api_url = format!("{}/v2/api/public/view", origin);
    let payload = serde_json::json!({ "file_slug": slug }).to_string();
    let resp = client.post(&api_url)
        .header("Content-Type", "application/json")
        .body(payload)
        .send()
        .await
        .ok()?;
    let text = resp.text().await.ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;

    if json["success"].as_bool() == Some(true) {
        let server = json["server"].as_str().unwrap_or("https://cn1.filester.me");
        let file = json["file"].as_str()?;
        let token = json["token"].as_str()?;
        return Some(format!("{}/v2/{}?token={}", server, file, token));
    }
    None
}

/// Sxyprn (`sxyprn.com`, `sxyprn.net`):
/// Decodes data-vnfo using ssut51 + boo Base64 algorithm and captures redirect.
async fn extract_sxyprn(url: &str, body: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?;

    let vnfo_re = Regex::new(r#"data-vnfo=(?:'([^']+)'|"([^"]+)")"#).ok()?;
    let caps = vnfo_re.captures(body)?;
    let raw_str = caps.get(1).or_else(|| caps.get(2))?.as_str();
    let vnfo_raw = raw_str.replace("&quot;", "\"");
    let vnfo_json: serde_json::Value = serde_json::from_str(&vnfo_raw).ok()?;

    let raw_val = vnfo_json.as_object()?.values().next()?.as_str()?;
    let mut tmp: Vec<String> = raw_val.split('/').map(|s| s.to_string()).collect();
    if tmp.len() < 8 {
        return None;
    }

    let ssut51 = |s: &str| -> i64 {
        s.chars().filter_map(|c| c.to_digit(10)).map(|d| d as i64).sum()
    };
    let boo = |ss: i64, host_str: &str, es: i64| -> String {
        use base64::prelude::*;
        let s = format!("{}-{}-{}", ss, host_str, es);
        BASE64_STANDARD.encode(s).replace('+', "-").replace('/', "_").replace('=', ".")
    };

    let s6 = ssut51(&tmp[6]);
    let s7 = ssut51(&tmp[7]);
    tmp[1] = format!("{}8/{}", tmp[1], boo(s6, host, s7));
    if let Ok(val5) = tmp[5].parse::<i64>() {
        tmp[5] = (val5 - s6 - s7).to_string();
    }

    let decoded_url = format!("https://{}/{}", host, tmp.join("/"));
    if let Some(final_url) = resolve_redirect_head(&decoded_url, Some(url)).await {
        return Some(final_url);
    }
    Some(decoded_url)
}

/// Archive.org: Queries metadata API for highest quality video and poster.
async fn extract_archive_org(url: &str, client: &reqwest::Client) -> Result<WebStreamInfo, String> {
    let identifier = url
        .split("archive.org/details/")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");

    if identifier.is_empty() {
        return Err("Invalid Archive.org URL".to_string());
    }

    let meta_url = format!("https://archive.org/metadata/{}", identifier);
    let resp = client.get(&meta_url).send().await.map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let meta_json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    let title = meta_json["metadata"]["title"]
        .as_str()
        .unwrap_or(identifier)
        .to_string();
    let description = meta_json["metadata"]["description"]
        .as_str()
        .map(|s| s.to_string());
    let (clean_title, year) = clean_scraped_title(&title);
    let year = year.or_else(|| {
        meta_json["metadata"]["year"]
            .as_str()
            .and_then(|y| y.parse::<u32>().ok())
    });

    let mut best_file: Option<String> = None;
    if let Some(files) = meta_json["files"].as_array() {
        for f in files {
            if let Some(name) = f.get("name").and_then(|v| v.as_str()) {
                let lower = name.to_lowercase();
                if lower.ends_with(".mp4") || lower.ends_with(".mkv") {
                    best_file = Some(name.to_string());
                    if !lower.contains("_512kb") {
                        break;
                    }
                }
            }
        }
    }

    let direct_stream_url = best_file.map(|f| {
        format!("https://archive.org/download/{}/{}", identifier, f)
    });
    let poster_url = format!("https://archive.org/services/img/{}", identifier);
    let (season, episode) = detect_season_episode(&title);
    let media_type = if season.is_some() || episode.is_some() { "tv".to_string() } else { detect_media_type(&clean_title, url, "") };

    Ok(WebStreamInfo {
        original_url: url.to_string(),
        direct_stream_url,
        raw_title: title,
        clean_title,
        description,
        poster_url: Some(poster_url),
        provider: "Archive.org".into(),
        is_direct_media: false,
        media_type,
        year,
        format: Some("mp4".into()),
        season,
        episode,
    })
}

/// Fetch web stream info and metadata from any video link, streaming page, or tube URL.
#[tauri::command]
pub async fn fetch_web_stream_info(url: String) -> Result<WebStreamInfo, String> {
    let trimmed = url.trim().to_string();
    if trimmed.is_empty() {
        return Err("URL is empty".to_string());
    }
    info!(target: "stream", "fetch_web_stream_info inspecting: {}", trimmed);
    let client = build_client()?;

    // 0a. Pixeldrain Direct Single File Resolution
    if trimmed.contains("pixeldrain.com/u/") || trimmed.contains("pixeldrain.com/file/") || trimmed.contains("pixeldrain.com/api/file/") {
        let file_id = trimmed.split("/u/").nth(1)
            .or_else(|| trimmed.split("/file/").nth(1))
            .or_else(|| trimmed.split("/api/file/").nth(1))
            .and_then(|s| s.split(&['?', '#', '/'][..]).next())
            .unwrap_or("");
        if !file_id.is_empty() {
            let info_url = format!("https://pixeldrain.com/api/file/{}/info", file_id);
            let mut filename = format!("Pixeldrain_{}.mp4", file_id);
            if let Ok(info_resp) = client.get(&info_url).send().await {
                if let Ok(text) = info_resp.text().await {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(fn_val) = json["name"].as_str() {
                            filename = fn_val.to_string();
                        }
                    }
                }
            }
            let stream_url = format!("https://pixeldrain.com/api/file/{}", file_id);
            let (clean_title, year) = clean_scraped_title(&filename);
            let (season, episode) = detect_season_episode(&filename);
            let ext = filename.split('.').last().unwrap_or("mp4").to_lowercase();
            let media_type = if season.is_some() || episode.is_some() {
                "tv".to_string()
            } else {
                detect_media_type(&clean_title, &stream_url, "")
            };
            return Ok(WebStreamInfo {
                original_url: trimmed.clone(),
                direct_stream_url: Some(stream_url),
                raw_title: filename,
                clean_title,
                description: Some("Pixeldrain Direct Media File".into()),
                poster_url: Some(format!("https://pixeldrain.com/api/file/{}/thumbnail", file_id)),
                provider: "Pixeldrain".into(),
                is_direct_media: true,
                media_type,
                year,
                format: Some(ext),
                season,
                episode,
            });
        }
    }

    // 1. Direct Media Link Check (.mp4, .mkv, .m3u8, etc.)
    if is_direct_media_url(&trimmed) {
        info!(target: "stream", "Identified as direct media URL: {}", trimmed);
        let filename = trimmed
            .split('?')
            .next()
            .unwrap_or(&trimmed)
            .split('/')
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or("Stream")
            .to_string();

        let ext = filename.split('.').last().unwrap_or("mp4").to_lowercase();
        let (clean_title, year) = clean_scraped_title(&filename);
        let (season, episode) = detect_season_episode(&filename);
        let media_type = if season.is_some() || episode.is_some() {
            "tv".to_string()
        } else {
            detect_media_type(&clean_title, &trimmed, "")
        };

        return Ok(WebStreamInfo {
            original_url: trimmed.clone(),
            direct_stream_url: Some(trimmed),
            raw_title: filename,
            clean_title,
            description: None,
            poster_url: None,
            provider: if ext == "m3u8" { "HLS Stream".into() } else { "Direct Stream".into() },
            is_direct_media: true,
            media_type,
            year,
            format: Some(ext),
            season,
            episode,
        });
    }

    // 1b. YouTube Extraction via yt-dlp
    if trimmed.contains("youtube.com") || trimmed.contains("youtu.be") {
        let (clean_title, year) = clean_scraped_title(&trimmed);
        let mut direct_url = None;
        if let Some(bin) = crate::commands::download::find_yt_dlp_binary() {
            if let Ok(output) = tokio_command(&bin)
                .arg("-g")
                .arg("-f")
                .arg("best[ext=mp4]/best")
                .arg(&trimmed)
                .output()
                .await
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(first_line) = stdout.lines().next() {
                        let stream = first_line.trim().to_string();
                        if stream.starts_with("http") {
                            direct_url = Some(stream);
                        }
                    }
                }
            }
        }
        return Ok(WebStreamInfo {
            original_url: trimmed.clone(),
            direct_stream_url: direct_url,
            raw_title: clean_title.clone(),
            clean_title,
            description: Some("YouTube Direct Video Stream".into()),
            poster_url: None,
            provider: "YouTube".into(),
            is_direct_media: true,
            media_type: "youtube".into(),
            year,
            format: Some("mp4".into()),
            season: None,
            episode: None,
        });
    }

    // 1c. Streamed.pk & Embed.st Live Sports Embed Handler
    if trimmed.contains("embed.st") || trimmed.contains("streamed.pk") {
        info!(target: "stream", "Streamed.pk / embed.st sports embed detected: {}", trimmed);
        let raw_slug = if trimmed.contains("streamed.pk/watch/") {
            trimmed.split("/watch/").last().unwrap_or("Live Sports Event")
        } else {
            trimmed.split('/').rev().nth(1).unwrap_or("Live Sports Event")
        };
        let mut clean_title = raw_slug.replace('-', " ");
        let mut direct_url = trimmed.clone();
        let mut poster_url = None;

        // If it's a streamed.pk/watch/{id} URL, resolve directly to embed.st embed player
        if trimmed.contains("streamed.pk/watch/") {
            let id = trimmed.split("/watch/").last().unwrap_or("").trim();
            if !id.is_empty() {
                let cached_val = if let Ok(guard) = SPORTS_CACHE.lock() {
                    guard.as_ref().map(|(_, val)| val.clone())
                } else {
                    None
                };

                let matches_val = if let Some(val) = cached_val {
                    Some(val)
                } else if let Ok(resp) = client.get("https://streamed.pk/api/matches/all").send().await {
                    if let Ok(text) = resp.text().await {
                        serde_json::from_str::<serde_json::Value>(&text).ok()
                    } else {
                        None
                    }
                } else {
                    None
                };

                if let Some(matches) = matches_val {
                    if let Some(list) = matches.as_array() {
                        if let Some(m) = list.iter().find(|m| m["id"].as_str() == Some(id)) {
                            if let Some(t) = m["title"].as_str() {
                                let cat = m["category"].as_str().unwrap_or("SPORTS").to_uppercase();
                                clean_title = format!("{} ({})", t, cat);
                            }
                            poster_url = m["poster"].as_str().map(|p| {
                                if p.starts_with("http") { p.to_string() } else { format!("https://streamed.pk{}", p) }
                            });
                            if let Some(sources) = m["sources"].as_array() {
                                if let Some(first_source) = sources.first() {
                                    if let (Some(s_name), Some(s_id)) = (first_source["source"].as_str(), first_source["id"].as_str()) {
                                        direct_url = format!("https://embed.st/embed/{}/{}/1", s_name, s_id);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        return Ok(WebStreamInfo {
            original_url: trimmed.clone(),
            direct_stream_url: Some(direct_url),
            raw_title: clean_title.clone(),
            clean_title,
            description: Some("Live Sports & PPV Stream (WebKit Sandbox Player)".into()),
            poster_url,
            provider: "Streamed.pk (Live Sports)".into(),
            is_direct_media: false,
            media_type: "sports".into(),
            year: None,
            format: Some("embed".into()),
            season: None,
            episode: None,
        });
    }

    // 2. MovieBite API Extraction
    if trimmed.contains("moviebite.org/watch/") {
        if let Ok(info) = extract_moviebite(&trimmed, &client).await {
            return Ok(info);
        }
    }

    // 2b. PornHub Extraction
    if trimmed.contains("pornhub.com/view_video.php") {
        if let Ok(info) = extract_pornhub(&trimmed, &client).await {
            return Ok(info);
        }
    }

    // 3. Archive.org Metadata Check
    if trimmed.contains("archive.org/details/") {
        if let Ok(info) = extract_archive_org(&trimmed, &client).await {
            return Ok(info);
        }
    }

    // 4. Filester Check
    if trimmed.contains("filester.") && trimmed.contains("/d/") {
        if let Some(direct) = extract_filester(&trimmed, &client).await {
            let (clean_title, year) = clean_scraped_title(&trimmed);
            let (season, episode) = detect_season_episode(&trimmed);
            return Ok(WebStreamInfo {
                original_url: trimmed.clone(),
                direct_stream_url: Some(direct),
                raw_title: clean_title.clone(),
                clean_title,
                description: None,
                poster_url: None,
                provider: "Filester".into(),
                is_direct_media: false,
                media_type: if season.is_some() || episode.is_some() { "tv".into() } else { "movies".into() },
                year,
                format: Some("mp4".into()),
                season,
                episode,
            });
        }
    }

    // 4b. GogoAnime Category Series Auto-Resolver (Resolve Episode 1)
    if (trimmed.contains("gogoanime") || trimmed.contains("gogoanimes")) && trimmed.contains("/category/") {
        info!(target: "stream", "GogoAnime series category URL detected, resolving Episode 1 for: {}", trimmed);
        let ep1_url = trimmed.replace("/category/", "/").trim_end_matches('/').to_string() + "-episode-1";
        if let Ok(ep_info) = Box::pin(fetch_web_stream_info(ep1_url)).await {
            return Ok(ep_info);
        }
    }

    // 4c. Yomi.to Watch & Series Auto-Resolver
    if trimmed.contains("yomi.to") {
        if trimmed.contains("/watch/") {
            if let Ok(ep_info) = extract_yomi(&trimmed, &client).await {
                return Ok(ep_info);
            }
        } else if trimmed.contains("/anime/") || trimmed.contains("/category/") || trimmed.contains("/series/") {
            let base = trimmed.split('?').next().unwrap_or(&trimmed);
            let anime_re = Regex::new(r"(?i)yomi\.to/(?:anime|category|series)/([^/?#]+)-(\d+)").unwrap();
            if let Some(cap) = anime_re.captures(base) {
                let ep1_url = format!("https://yomi.to/watch/{}-{}/1", &cap[1], &cap[2]);
                info!(target: "stream", "Yomi.to anime series page detected, resolving Episode 1 for: {}", ep1_url);
                if let Ok(ep_info) = Box::pin(fetch_web_stream_info(ep1_url)).await {
                    return Ok(ep_info);
                }
            }
        }
    }

    // 5. General Webpage / Streaming Site Scraping
    let resp = client
        .get(&trimmed)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,video/*,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("Network request failed: {}", e))?;

    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Check if redirect ended up at a direct media file
    if content_type.starts_with("video/") || content_type.contains("mpegurl") || is_direct_media_url(&final_url) {
        let filename = final_url
            .split('?')
            .next()
            .unwrap_or(&final_url)
            .split('/')
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or("Stream")
            .to_string();

        let (clean_title, year) = clean_scraped_title(&filename);
        let (season, episode) = detect_season_episode(&filename);
        let media_type = if season.is_some() || episode.is_some() {
            "tv".to_string()
        } else {
            detect_media_type(&clean_title, &final_url, &content_type)
        };

        return Ok(WebStreamInfo {
            original_url: trimmed,
            direct_stream_url: Some(final_url),
            raw_title: filename,
            clean_title,
            description: None,
            poster_url: None,
            provider: "Direct Stream".into(),
            is_direct_media: true,
            media_type,
            year,
            format: Some("mp4".into()),
            season,
            episode,
        });
    }

    // Read HTML body
    let body = match resp.bytes().await {
        Ok(b) => String::from_utf8_lossy(&b).to_string(),
        Err(e) => {
            warn!(target: "stream", "Failed reading response body bytes for {}: {}", trimmed, e);
            String::new()
        }
    };

    // OpenGraph & metadata tags
    let og_title_re = Regex::new(r#"(?i)<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']"#).unwrap();
    let og_title_alt = Regex::new(r#"(?i)<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:title["']"#).unwrap();
    let title_tag_re = Regex::new(r#"(?i)<title[^>]*>([^<]+)</title>"#).unwrap();
    let og_desc_re = Regex::new(r#"(?i)<meta\s+(?:property|name)=["']og:description["']\s+content=["']([^"']+)["']"#).unwrap();
    let og_image_re = Regex::new(r#"(?i)<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']"#).unwrap();
    let og_image_alt = Regex::new(r#"(?i)<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:image["']"#).unwrap();
    let twitter_img_re = Regex::new(r#"(?i)<meta\s+(?:name|property)=["']twitter:image(?::src)?["']\s+content=["']([^"']+)["']"#).unwrap();
    let twitter_img_alt = Regex::new(r#"(?i)<meta\s+content=["']([^"']+)["']\s+(?:name|property)=["']twitter:image(?::src)?["']"#).unwrap();
    let link_img_re = Regex::new(r#"(?i)<link\s+rel=["']image_src["']\s+href=["']([^"']+)["']"#).unwrap();
    let wp_img_re = Regex::new(r#"(?i)<img\b[^>]*class=["'][^"']*wp-post-image[^"']*["'][^>]*src=["']([^"']+)["']"#).unwrap();
    let tile_img_re = Regex::new(r#"(?i)<meta\s+name=["']msapplication-TileImage["']\s+content=["']([^"']+)["']"#).unwrap();

    let mut raw_title = og_title_re
        .captures(&body)
        .or_else(|| og_title_alt.captures(&body))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .or_else(|| {
            title_tag_re
                .captures(&body)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_string())
        })
        .unwrap_or_else(|| {
            trimmed
                .split('/')
                .filter(|s| !s.is_empty())
                .last()
                .unwrap_or("Web Stream")
                .to_string()
        });

    raw_title = raw_title
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">");

    let (clean_title, year) = clean_scraped_title(&raw_title);

    let description = og_desc_re
        .captures(&body)
        .and_then(|c| c.get(1))
        .map(|m| {
            m.as_str()
                .replace("&amp;", "&")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
        });

    let poster_url = og_image_re
        .captures(&body)
        .or_else(|| og_image_alt.captures(&body))
        .or_else(|| twitter_img_re.captures(&body))
        .or_else(|| twitter_img_alt.captures(&body))
        .or_else(|| link_img_re.captures(&body))
        .or_else(|| wp_img_re.captures(&body))
        .or_else(|| tile_img_re.captures(&body))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());

    let (detected_s, detected_e) = detect_season_episode(&raw_title);
    let (season, episode) = if detected_s.is_some() || detected_e.is_some() {
        (detected_s, detected_e)
    } else {
        detect_season_episode(&trimmed)
    };

    let mut direct_stream_url: Option<String> = None;
    let mut provider = "Web Stream".to_string();

    // 6. Host-Specific Resolvers on current page URL
    let lower_url = trimmed.to_lowercase();
    if lower_url.contains("streamtape.") || lower_url.contains("tapecontent.net") {
        provider = "Streamtape".to_string();
        direct_stream_url = extract_streamtape(&trimmed, &body).await;
    } else if lower_url.contains("dood.") || lower_url.contains("doodstream.") || lower_url.contains("dooood.") || lower_url.contains("doods.") {
        provider = "Doodstream".to_string();
        direct_stream_url = extract_doodstream(&trimmed, &body, &client).await;
    } else if lower_url.contains("mixdrop.") {
        provider = "Mixdrop".to_string();
        direct_stream_url = extract_mixdrop(&body);
    } else if lower_url.contains("filemoon.") {
        provider = "Filemoon".to_string();
        direct_stream_url = extract_filemoon(&body);
    } else if lower_url.contains("bunkr.") || lower_url.contains("bunkrr.") {
        provider = "Bunkr".to_string();
        direct_stream_url = extract_bunkr(&trimmed, &body, &client).await;
    } else if lower_url.contains("sxyprn.") {
        provider = "Sxyprn".to_string();
        direct_stream_url = extract_sxyprn(&trimmed, &body).await;
    } else if lower_url.contains("vidmoly.") {
        provider = "Vidmoly".to_string();
        direct_stream_url = extract_vidmoly(&trimmed, &client, Some(&trimmed)).await;
    } else if lower_url.contains("voe.") || lower_url.contains("johnfullwonder.") {
        provider = "VOE".to_string();
        direct_stream_url = extract_voe(&trimmed, &client, Some(&trimmed)).await;
    } else if lower_url.contains("vkspeed.") {
        provider = "VKSpeed".to_string();
        direct_stream_url = extract_vkspeed(&trimmed, &client, Some(&trimmed)).await;
    } else if lower_url.contains("my.1anime.site") {
        provider = "1Anime".to_string();
        let source_re = Regex::new(r#"<source[^>]+src=["'](/stream/[^"']+)["']"#).unwrap();
        if let Some(c) = source_re.captures(&body) {
            let stream_path = c.get(1).unwrap().as_str();
            let stream_url = format!("https://my.1anime.site{}", stream_path);
            direct_stream_url = resolve_redirect_head(&stream_url, Some(&trimmed)).await;
        }
    } else if lower_url.contains("cloudbate.") {
        provider = "Cloudbate".to_string();
        let cloud_re = Regex::new(r#"video_url\s*:\s*['"]([^'"]+\.mp4/\?v-acctoken=[^'"]+)['"]"#).unwrap();
        if let Some(c) = cloud_re.captures(&body) {
            direct_stream_url = Some(c.get(1).unwrap().as_str().to_string());
        }
    } else if lower_url.contains("lulustream.") || lower_url.contains("luluvdo.") || lower_url.contains("lulu.st") {
        provider = "Lulustream".to_string();
        direct_stream_url = extract_filemoon(&body);
        if direct_stream_url.is_none() {
            let vid_re = Regex::new(r#"(?i)<video[^>]+src=["']([^"']+)["']"#).unwrap();
            if let Some(c) = vid_re.captures(&body) {
                direct_stream_url = Some(c.get(1).unwrap().as_str().to_string());
            }
        }
    } else if lower_url.contains("showcamrips.com") {
        provider = "Showcamrips".to_string();
        if lower_url.contains("loading_video.php") {
            let idd = reqwest::Url::parse(&trimmed).ok().and_then(|u| {
                u.query_pairs().find(|(k, _)| k == "idd").map(|(_, v)| v.to_string())
            });
            let vv = reqwest::Url::parse(&trimmed).ok().and_then(|u| {
                u.query_pairs().find(|(k, _)| k == "vv").map(|(_, v)| v.to_string())
            });
            if let (Some(i), Some(v)) = (idd, vv) {
                let play_url = format!("https://showcamrips.com/play.php?idd={}&vv={}", i, v);
                if let Ok(play_resp) = client.get(&play_url).header("Referer", &trimmed).send().await {
                    if let Ok(play_html) = play_resp.text().await {
                        let v_re = Regex::new(r#"(?i)<video[^>]+src=["']([^"']+)["']"#).unwrap();
                        if let Some(c) = v_re.captures(&play_html) {
                            direct_stream_url = Some(c.get(1).unwrap().as_str().to_string());
                        }
                    }
                }
            }
        }
    } else if lower_url.contains("fileditchfiles.") {
        provider = "Fileditch".to_string();
        let fd_re = Regex::new(r#"(?i)<a[^>]+href=["'](https?://[^"']*\.(?:mp4|webm|mkv|mov|avi)[^"']*)["']"#).unwrap();
        if let Some(c) = fd_re.captures(&body) {
            direct_stream_url = Some(c.get(1).unwrap().as_str().to_string());
        }
    } else if lower_url.contains("ok.ru/") {
        provider = "OK.ru".to_string();
        direct_stream_url = extract_ok_ru(&trimmed, &client, Some(&trimmed)).await;
    } else if lower_url.contains("vk.com") || lower_url.contains("vk.ru") || lower_url.contains("vkvideo.ru") {
        provider = "VK".to_string();
        direct_stream_url = extract_vk(&trimmed, &client, Some(&trimmed)).await;
    } else if lower_url.contains("dailymotion.com") || lower_url.contains("dai.ly") {
        provider = "Dailymotion".to_string();
        direct_stream_url = extract_dailymotion(&trimmed, &client).await;
    } else if lower_url.contains("bitchute.com") {
        provider = "BitChute".to_string();
        direct_stream_url = extract_bitchute(&trimmed, &client).await;
    } else if lower_url.contains("odysee.com") {
        provider = "Odysee".to_string();
        direct_stream_url = extract_odysee(&trimmed, &client).await;
    } else if lower_url.contains("peertube") || body.contains("peertube") {
        provider = "PeerTube".to_string();
        direct_stream_url = extract_peertube(&trimmed, &client).await;
    }

    // 6b. Generic OpenGraph video tag extraction (high-confidence fallback for video portals)
    if direct_stream_url.is_none() {
        let og_vid_re = Regex::new(r#"(?i)<meta\s+property=["']og:video(?::(?:url|secure_url))?["']\s+content=["']([^"']+)["']"#).unwrap();
        for cap in og_vid_re.captures_iter(&body) {
            let vid_cand = cap.get(1).unwrap().as_str().trim();
            if vid_cand.starts_with("http") && (vid_cand.contains(".mp4") || vid_cand.contains(".m3u8") || vid_cand.contains(".webm")) {
                direct_stream_url = Some(vid_cand.to_string());
                break;
            }
        }
    }

    // 7. Embedded Cyberlocker Iframes in Webpage (e.g. baddieseast, release blogs, streaming sites)
    if direct_stream_url.is_none() {
        let iframe_re = Regex::new(r#"(?i)<iframe[^>]+src=["']([^"']+)["']"#).unwrap();
        let mut candidates: Vec<String> = Vec::new();
        for cap in iframe_re.captures_iter(&body) {
            let mut src = cap.get(1).unwrap().as_str().trim().to_string();
            if src.starts_with("//") {
                src = format!("https:{}", src);
            }
            if src.starts_with("http") {
                candidates.push(src);
            }
        }

        let data_video_re = Regex::new(r#"(?i)data-video=["']([^"']+)["']"#).unwrap();
        for cap in data_video_re.captures_iter(&body) {
            let mut src = cap.get(1).unwrap().as_str().trim().to_string();
            if src.starts_with("//") {
                src = format!("https:{}", src);
            }
            if src.starts_with("http") {
                candidates.push(src);
            }
        }

        let link_re = Regex::new(r#"(?i)<a[^>]+href=["'](https?://[^"']*(?:vidmoly|voe|vkspeed|streamtape|advtpe|strtape|ok\.ru|vk\.com|vk\.ru|dailymotion|dai\.ly|bitchute|odysee|peertube|dood|mixdrop|filemoon|bunkr|lulustream|luluvdo|lulu|sxyprn|showcamrips|cloudbate|fileditch|1anime|pornhub|bysesayeveum|byse)[^"']*)["']"#).unwrap();
        for cap in link_re.captures_iter(&body) {
            candidates.push(cap.get(1).unwrap().as_str().to_string());
        }

        // Prioritize reliable cyberlockers (Vidmoly, VOE, VKSpeed, Streamtape) over IP-sensitive embeds (OK.ru)
        candidates.sort_by_key(|c| {
            let lower = c.to_lowercase();
            if lower.contains("vidmoly.") { 0 }
            else if lower.contains("voe.") || lower.contains("johnfullwonder.") { 1 }
            else if lower.contains("streamtape.") || lower.contains("strtape.") || lower.contains("advtpe.") { 2 }
            else if lower.contains("vkspeed.") { 3 }
            else if lower.contains("dood.") || lower.contains("doodstream.") || lower.contains("dooood.") { 4 }
            else if lower.contains("ok.ru/") { 5 }
            else { 6 }
        });

        for cand in candidates {
            let cand_lower = cand.to_lowercase();
            if cand_lower.contains("vidmoly.") {
                if let Some(stream) = extract_vidmoly(&cand, &client, Some(&trimmed)).await {
                    direct_stream_url = Some(stream);
                    provider = "Vidmoly".to_string();
                    break;
                }
            } else if cand_lower.contains("vkspeed.") {
                if let Some(stream) = extract_vkspeed(&cand, &client, Some(&trimmed)).await {
                    direct_stream_url = Some(stream);
                    provider = "VKSpeed".to_string();
                    break;
                }
            } else if cand_lower.contains("ok.ru/") {
                if let Some(stream) = extract_ok_ru(&cand, &client, Some(&trimmed)).await {
                    direct_stream_url = Some(stream);
                    provider = "OK.ru".to_string();
                    break;
                }
            } else if cand_lower.contains("vk.com") || cand_lower.contains("vk.ru") || cand_lower.contains("vkvideo.ru") {
                if let Some(stream) = extract_vk(&cand, &client, Some(&trimmed)).await {
                    direct_stream_url = Some(stream);
                    provider = "VK".to_string();
                    break;
                }
            } else if cand_lower.contains("dailymotion.com") || cand_lower.contains("dai.ly") {
                if let Some(stream) = extract_dailymotion(&cand, &client).await {
                    direct_stream_url = Some(stream);
                    provider = "Dailymotion".to_string();
                    break;
                }
            } else if cand_lower.contains("bitchute.com") {
                if let Some(stream) = extract_bitchute(&cand, &client).await {
                    direct_stream_url = Some(stream);
                    provider = "BitChute".to_string();
                    break;
                }
            } else if cand_lower.contains("odysee.com") {
                if let Some(stream) = extract_odysee(&cand, &client).await {
                    direct_stream_url = Some(stream);
                    provider = "Odysee".to_string();
                    break;
                }
            } else if cand_lower.contains("peertube") {
                if let Some(stream) = extract_peertube(&cand, &client).await {
                    direct_stream_url = Some(stream);
                    provider = "PeerTube".to_string();
                    break;
                }
            } else if cand_lower.contains("voe.") || cand_lower.contains("johnfullwonder.") {
                if let Some(stream) = extract_voe(&cand, &client, Some(&trimmed)).await {
                    direct_stream_url = Some(stream);
                    provider = "VOE".to_string();
                    break;
                }
            } else if cand_lower.contains("streamtape.") || cand_lower.contains("tapecontent.net") || cand_lower.contains("advtpe.") || cand_lower.contains("strtape.") || cand_lower.contains("streamta.pe") {
                if let Ok(resp_iframe) = client.get(&cand).header("Referer", &trimmed).send().await {
                    if let Ok(ibody) = resp_iframe.text().await {
                        if let Some(stream) = extract_streamtape(&cand, &ibody).await {
                            direct_stream_url = Some(stream);
                            provider = "Streamtape".to_string();
                            break;
                        }
                    }
                }
            } else if cand_lower.contains("dood.") || cand_lower.contains("dooood.") || cand_lower.contains("doodstream.") {
                if let Ok(resp_iframe) = client.get(&cand).header("Referer", &trimmed).send().await {
                    if let Ok(ibody) = resp_iframe.text().await {
                        if let Some(stream) = extract_doodstream(&cand, &ibody, &client).await {
                            direct_stream_url = Some(stream);
                            provider = "Doodstream".to_string();
                            break;
                        }
                    }
                }
            } else if cand_lower.contains("mixdrop.") {
                if let Ok(resp_iframe) = client.get(&cand).header("Referer", &trimmed).send().await {
                    if let Ok(ibody) = resp_iframe.text().await {
                        if let Some(stream) = extract_mixdrop(&ibody) {
                            direct_stream_url = Some(stream);
                            provider = "Mixdrop".to_string();
                            break;
                        }
                    }
                }
            } else if cand_lower.contains("filemoon.") || cand_lower.contains("bysesayeveum.") || cand_lower.contains("byse.") {
                if let Ok(resp_iframe) = client.get(&cand).header("Referer", &trimmed).send().await {
                    if let Ok(ibody) = resp_iframe.text().await {
                        if let Some(stream) = extract_filemoon(&ibody) {
                            direct_stream_url = Some(stream);
                            provider = "Filemoon".to_string();
                            break;
                        }
                    }
                }
            } else if cand_lower.contains("bunkr.") {
                if let Ok(resp_iframe) = client.get(&cand).header("Referer", &trimmed).send().await {
                    if let Ok(ibody) = resp_iframe.text().await {
                        if let Some(stream) = extract_bunkr(&cand, &ibody, &client).await {
                            direct_stream_url = Some(stream);
                            provider = "Bunkr".to_string();
                            break;
                        }
                    }
                }
            } else if cand_lower.contains("lulustream.") || cand_lower.contains("luluvdo.") || cand_lower.contains("lulu.st") {
                if let Ok(resp_iframe) = client.get(&cand).header("Referer", &trimmed).send().await {
                    if let Ok(ibody) = resp_iframe.text().await {
                        if let Some(stream) = extract_filemoon(&ibody) {
                            direct_stream_url = Some(stream);
                            provider = "Lulustream".to_string();
                            break;
                        }
                    }
                }
            } else if cand_lower.contains("sxyprn.") {
                if let Ok(resp_iframe) = client.get(&cand).header("Referer", &trimmed).send().await {
                    if let Ok(ibody) = resp_iframe.text().await {
                        if let Some(stream) = extract_sxyprn(&cand, &ibody).await {
                            direct_stream_url = Some(stream);
                            provider = "Sxyprn".to_string();
                            break;
                        }
                    }
                }
            } else if cand_lower.contains("showcamrips.") {
                if cand_lower.contains("loading_video.php") {
                    let idd = reqwest::Url::parse(&cand).ok().and_then(|u| {
                        u.query_pairs().find(|(k, _)| k == "idd").map(|(_, v)| v.to_string())
                    });
                    let vv = reqwest::Url::parse(&cand).ok().and_then(|u| {
                        u.query_pairs().find(|(k, _)| k == "vv").map(|(_, v)| v.to_string())
                    });
                    if let (Some(i), Some(v)) = (idd, vv) {
                        let play_url = format!("https://showcamrips.com/play.php?idd={}&vv={}", i, v);
                        if let Ok(play_resp) = client.get(&play_url).header("Referer", &cand).send().await {
                            if let Ok(play_html) = play_resp.text().await {
                                let v_re = Regex::new(r#"(?i)<video[^>]+src=["']([^"']+)["']"#).unwrap();
                                if let Some(c) = v_re.captures(&play_html) {
                                    direct_stream_url = Some(c.get(1).unwrap().as_str().to_string());
                                    provider = "Showcamrips".to_string();
                                    break;
                                }
                            }
                        }
                    }
                }
            } else if cand_lower.contains("cloudbate.") {
                if let Ok(resp_iframe) = client.get(&cand).header("Referer", &trimmed).send().await {
                    if let Ok(ibody) = resp_iframe.text().await {
                        let cloud_re = Regex::new(r#"video_url\s*:\s*['"]([^'"]+\.mp4/\?v-acctoken=[^'"]+)['"]"#).unwrap();
                        if let Some(c) = cloud_re.captures(&ibody) {
                            direct_stream_url = Some(c.get(1).unwrap().as_str().to_string());
                            provider = "Cloudbate".to_string();
                            break;
                        }
                    }
                }
            } else if cand_lower.contains("fileditchfiles.") {
                if let Ok(resp_iframe) = client.get(&cand).header("Referer", &trimmed).send().await {
                    if let Ok(ibody) = resp_iframe.text().await {
                        let fd_re = Regex::new(r#"(?i)<a[^>]+href=["'](https?://[^"']*\.(?:mp4|webm|mkv|mov|avi)[^"']*)["']"#).unwrap();
                        if let Some(c) = fd_re.captures(&ibody) {
                            direct_stream_url = Some(c.get(1).unwrap().as_str().to_string());
                            provider = "Fileditch".to_string();
                            break;
                        }
                    }
                }
            } else if cand_lower.contains("my.1anime.site") {
                if let Ok(resp_iframe) = client.get(&cand).header("Referer", &trimmed).send().await {
                    if let Ok(ibody) = resp_iframe.text().await {
                        let source_re = Regex::new(r#"<source[^>]+src=["'](/stream/[^"']+)["']"#).unwrap();
                        if let Some(c) = source_re.captures(&ibody) {
                            let stream_path = c.get(1).unwrap().as_str();
                            let stream_url = format!("https://my.1anime.site{}", stream_path);
                            if let Some(final_url) = resolve_redirect_head(&stream_url, Some(&cand)).await {
                                direct_stream_url = Some(final_url);
                                provider = "1Anime".to_string();
                                break;
                            }
                        }
                    }
                }
            } else if cand_lower.contains("pornhub.com") {
                if let Ok(info) = extract_pornhub(&cand, &client).await {
                    if let Some(stream) = info.direct_stream_url {
                        direct_stream_url = Some(stream);
                        provider = "PornHub".to_string();
                        break;
                    }
                }
            } else if cand_lower.contains("newplayer.php") || cand_lower.contains("gogoanime") {
                if let Ok(resp_iframe) = client.get(&cand).header("Referer", &trimmed).send().await {
                    if let Ok(ibody) = resp_iframe.text().await {
                        let inner_iframe_re = Regex::new(r#"(?i)<iframe[^>]+src=["']([^"']+)["']"#).unwrap();
                        for icap in inner_iframe_re.captures_iter(&ibody) {
                            let isrc = icap.get(1).unwrap().as_str().trim().to_string();
                            let isrc_full = if isrc.starts_with("//") { format!("https:{}", isrc) } else { isrc };
                            if let Ok(n_resp) = client.get(&isrc_full).header("Referer", &cand).send().await {
                                if let Ok(n_body) = n_resp.text().await {
                                    if let Some(s) = extract_filemoon(&n_body) {
                                        direct_stream_url = Some(s);
                                        provider = "GogoAnime".to_string();
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 8. Generic Fallback: HTML5 Video & HLS Links
    if direct_stream_url.is_none() {
        let m3u8_re = Regex::new(r#"(?i)["'](https?://[^"']+\.m3u8(?:[^"']*)?)["']"#).unwrap();
        let og_video_re = Regex::new(r#"(?i)<meta\s+(?:property|name)=["'](?:og:video|og:video:url|og:video:secure_url)["']\s+content=["']([^"']+)["']"#).unwrap();
        let video_src_re = Regex::new(r#"(?i)<(?:video|source)[^>]+src=["']([^"']+)["']"#).unwrap();
        let mp4_re = Regex::new(r#"(?i)["'](https?://[^"']+\.mp4(?:[^"']*)?)["']"#).unwrap();

        if let Some(c) = m3u8_re.captures(&body) {
            direct_stream_url = Some(c.get(1).unwrap().as_str().to_string());
        } else if let Some(c) = og_video_re.captures(&body) {
            let v = c.get(1).unwrap().as_str();
            if is_direct_media_url(v) {
                direct_stream_url = Some(v.to_string());
            }
        } else if let Some(c) = video_src_re.captures(&body) {
            let v = c.get(1).unwrap().as_str();
            if is_direct_media_url(v) {
                if v.starts_with("//") {
                    direct_stream_url = Some(format!("https:{}", v));
                } else if v.starts_with("http") {
                    direct_stream_url = Some(v.to_string());
                }
            }
        } else if let Some(c) = mp4_re.captures(&body) {
            direct_stream_url = Some(c.get(1).unwrap().as_str().to_string());
        }
    }

    let mut media_type = detect_media_type(&clean_title, &trimmed, &content_type);
    if season.is_some() || episode.is_some() {
        media_type = "tv".to_string();
    }
    info!(
        target: "stream",
        "fetch_web_stream_info completed for '{}': provider='{}', is_direct_media={}, direct_stream={:?}",
        clean_title,
        provider,
        direct_stream_url.is_some(),
        direct_stream_url
    );

    Ok(WebStreamInfo {
        original_url: trimmed,
        direct_stream_url,
        raw_title,
        clean_title,
        description,
        poster_url,
        provider,
        is_direct_media: false,
        media_type,
        year,
        format: Some("mp4".into()),
        season,
        episode,
    })
}

fn clean_xml_cdata(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("<![CDATA[") && trimmed.ends_with("]]>") {
        trimmed[9..trimmed.len() - 3].trim().to_string()
    } else {
        trimmed
            .replace("&amp;", "&")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
    }
}

fn parse_rss_feed(xml: &str, site_url: &str, domain: &str) -> Option<SiteDiscoveryFeed> {
    let site_title_re = Regex::new(r#"(?s)<channel>.*?<title>(.*?)</title>"#).ok()?;
    let raw_site_title = site_title_re
        .captures(xml)
        .and_then(|c| c.get(1))
        .map(|m| clean_xml_cdata(m.as_str()))
        .unwrap_or_else(|| domain.to_string());

    let item_re = Regex::new(r#"(?s)<item>(.*?)</item>"#).ok()?;
    let title_re = Regex::new(r#"(?s)<title>(.*?)</title>"#).ok()?;
    let link_re = Regex::new(r#"(?s)<link>(.*?)</link>"#).ok()?;
    let date_re = Regex::new(r#"(?s)<pubDate>(.*?)</pubDate>"#).ok()?;
    let desc_re = Regex::new(r#"(?s)<description>(.*?)</description>"#).ok()?;
    let content_re = Regex::new(r#"(?s)<content:encoded>(.*?)</content:encoded>"#).ok()?;
    let media_re = Regex::new(r#"(?i)<(?:media:content|media:thumbnail)[^>]+url=["']([^"']+)["']"#).ok()?;
    let img_re = Regex::new(r#"(?i)<img[^>]+(?:data-src|data-lazy-src|src)=["']([^"']+)["']"#).ok()?;
    let enclosure_re = Regex::new(r#"(?i)<enclosure[^>]+url=["']([^"']+)["']"#).ok()?;

    let mut releases = Vec::new();

    for cap in item_re.captures_iter(xml) {
        let item_xml = &cap[1];

        let raw_title = match title_re.captures(item_xml) {
            Some(c) => clean_xml_cdata(c.get(1)?.as_str()),
            None => continue,
        };
        let title = decode_html_entities(&raw_title);

        let link = match link_re.captures(item_xml) {
            Some(c) => clean_xml_cdata(c.get(1)?.as_str()),
            None => continue,
        };

        let date = date_re.captures(item_xml).map(|c| clean_xml_cdata(c.get(1).unwrap().as_str()));

        let thumbnail = enclosure_re
            .captures(item_xml)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .or_else(|| {
                media_re.captures(item_xml).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
            })
            .or_else(|| {
                desc_re.captures(item_xml).and_then(|dc| {
                    let desc = dc.get(1)?.as_str();
                    img_re.captures(desc).and_then(|ic| ic.get(1)).map(|m| m.as_str().to_string())
                })
            })
            .or_else(|| {
                content_re.captures(item_xml).and_then(|cc| {
                    let content = cc.get(1)?.as_str();
                    img_re.captures(content).and_then(|ic| ic.get(1)).map(|m| m.as_str().to_string())
                })
            });

        let (season, episode) = detect_season_episode(&title);
        let media_type = if season.is_some() || episode.is_some() {
            "tv".to_string()
        } else {
            "movies".to_string()
        };

        releases.push(DiscoveredRelease {
            title,
            post_url: link,
            thumbnail,
            date,
            site_domain: domain.to_string(),
            media_type,
            season,
            episode,
        });
    }

    if releases.is_empty() {
        None
    } else {
        Some(SiteDiscoveryFeed {
            site_url: site_url.to_string(),
            site_title: raw_site_title,
            releases,
        })
    }
}

fn parse_html_releases(html: &str, site_url: &str, domain: &str) -> Vec<DiscoveredRelease> {
    let mut releases = Vec::new();
    let mut seen_urls = std::collections::HashSet::new();

    let base_origin = reqwest::Url::parse(site_url)
        .ok()
        .map(|u| format!("{}://{}", u.scheme(), u.host_str().unwrap_or("")))
        .unwrap_or_else(|| site_url.to_string());

    let article_re = Regex::new(r#"(?is)<(?:article|div|li)\b[^>]*(?:class=["'][^"']*(?:post|item|entry|card|col-)[^"']*["'])[^>]*>(.*?)</(?:article|div|li)>"#).unwrap();
    let heading_link_re = Regex::new(r#"(?is)<(?:h[1-4]|div|a)\b[^>]*\b(?:class=["'][^"']*(?:title|entry-title|heading)[^"']*["'])?[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)</a>"#).unwrap();
    let plain_heading_re = Regex::new(r#"(?is)<h[1-4][^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)</a>"#).unwrap();
    let img_re = Regex::new(r#"(?i)<img[^>]+(?:data-src|data-lazy-src|src)=["']([^"']+)["']"#).unwrap();
    let strip_tag_re = Regex::new(r#"<[^>]+>"#).unwrap();

    for cap in article_re.captures_iter(html) {
        let block = &cap[1];
        let hcap_opt = plain_heading_re.captures(block)
            .or_else(|| heading_link_re.captures(block));

        if let Some(hcap) = hcap_opt {
            let mut post_url = hcap.get(1).unwrap().as_str().trim().to_string();
            if post_url.starts_with('/') {
                post_url = format!("{}/{}", base_origin.trim_end_matches('/'), post_url.trim_start_matches('/'));
            }
            if !post_url.starts_with("http") {
                continue;
            }
            if seen_urls.contains(&post_url) {
                continue;
            }

            let raw_h_title = hcap.get(2).unwrap().as_str();
            let mut title = strip_tag_re.replace_all(raw_h_title, "").trim().to_string();
            if title.is_empty() || title.len() < 3 {
                let a_title_re = Regex::new(r#"(?i)<a[^>]+title=["']([^"']+)["']"#).unwrap();
                if let Some(acap) = a_title_re.captures(block) {
                    title = acap.get(1).unwrap().as_str().trim().to_string();
                }
            }
            if title.is_empty() || title.len() < 3 {
                continue;
            }

            title = decode_html_entities(&title);
            seen_urls.insert(post_url.clone());

            let thumbnail = img_re.captures(block).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
                .filter(|u| !u.contains("avatar") && !u.contains("logo") && !u.contains("icon") && !u.contains("1x1") && !u.contains("emoji"));
            let (season, episode) = detect_season_episode(&title);
            let media_type = if season.is_some() || episode.is_some() { "tv".into() } else { "movies".into() };

            releases.push(DiscoveredRelease {
                title,
                post_url,
                thumbnail,
                date: None,
                site_domain: domain.to_string(),
                media_type,
                season,
                episode,
            });
        }
    }

    // 1b. Gogoanime / Anime Portal Item Pattern (<li ...><div class="img"><a href="..." title="..."><img src="..." ...>)
    let gogo_li_re = Regex::new(r#"(?is)<li[^>]*>\s*<div\s+class=["']img["']>\s*<a\s+href=["']([^"']+)["']\s+title=["']([^"']+)["'][^>]*>\s*<img\s+(?:data-src|src)=["']([^"']+)["']"#).unwrap();
    for cap in gogo_li_re.captures_iter(html) {
        let mut post_url = cap.get(1).unwrap().as_str().trim().to_string();
        if post_url.starts_with('/') {
            post_url = format!("{}/{}", base_origin.trim_end_matches('/'), post_url.trim_start_matches('/'));
        }
        if !post_url.starts_with("http") || seen_urls.contains(&post_url) {
            continue;
        }
        seen_urls.insert(post_url.clone());

        let raw_title = cap.get(2).unwrap().as_str().trim();
        let (season, mut episode) = detect_season_episode(raw_title);
        if episode.is_none() {
            if let Ok(ep_re) = Regex::new(r#"-episode-(\d+)"#) {
                if let Some(c) = ep_re.captures(&post_url) {
                    episode = c.get(1).and_then(|m| m.as_str().parse().ok());
                }
            }
        }
        let title = if let Some(ep) = episode {
            if !raw_title.to_lowercase().contains("episode") {
                format!("{} - Episode {}", raw_title, ep)
            } else {
                raw_title.to_string()
            }
        } else {
            raw_title.to_string()
        };

        let mut thumb = cap.get(3).unwrap().as_str().trim().to_string();
        if thumb.starts_with('/') {
            thumb = format!("{}/{}", base_origin.trim_end_matches('/'), thumb.trim_start_matches('/'));
        }

        releases.push(DiscoveredRelease {
            title,
            post_url,
            thumbnail: Some(thumb),
            date: None,
            site_domain: domain.to_string(),
            media_type: "tv".to_string(),
            season: season.or(Some(1)),
            episode,
        });
    }

    // 1b-2. Gogoanime Series Page Pattern (<ul id="episode_related"><li><a href="/...-episode-1">...<div class="name"><span>EP</span> 1</div>...</a></li>)
    if (domain.contains("gogoanime") || domain.contains("gogoanimes") || domain.contains("anitaku")) && html.contains("episode_related") {
        let ul_re = Regex::new(r#"(?is)<ul\s+id=["']episode_related["'][^>]*>(.*?)</ul>"#).unwrap();
        let ep_html = ul_re.captures(html).and_then(|c| c.get(1)).map(|m| m.as_str()).unwrap_or(html);

        let ep_link_re = Regex::new(r#"(?is)<a\s+href=["'](/[^"']+-episode-(\d+))["'][^>]*>(.*?)</a>"#).unwrap();
        let show_title_re = Regex::new(r#"(?i)<div\s+class=["']anime_info_body_bg["'][^>]*>\s*<h1[^>]*>([^<]+)</h1>"#).unwrap();
        let mut show_title = show_title_re.captures(html).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string())
            .or_else(|| {
                let og_t = Regex::new(r#"(?i)<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']"#).unwrap();
                og_t.captures(html).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string())
            })
            .unwrap_or_else(|| "Anime Episode".to_string());

        for postfix in &[" at Gogoanime", " at GogoAnime", " - Gogoanime", " - GogoAnime"] {
            show_title = show_title.replace(postfix, "");
        }
        show_title = show_title.trim().to_string();

        let show_img_re = Regex::new(r#"(?i)<div\s+class=["']anime_info_body_bg["'][^>]*>.*?<img\s+src=["']([^"']+)["']"#).unwrap();
        let mut show_thumb = show_img_re.captures(html).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string());
        if let Some(ref t) = show_thumb {
            if t.starts_with('/') {
                show_thumb = Some(format!("{}/{}", base_origin.trim_end_matches('/'), t.trim_start_matches('/')));
            }
        }

        let mut gogo_episodes: Vec<DiscoveredRelease> = Vec::new();
        for cap in ep_link_re.captures_iter(ep_html) {
            let ep_path = cap.get(1).unwrap().as_str();
            let full_ep_url = format!("{}/{}", base_origin.trim_end_matches('/'), ep_path.trim_start_matches('/'));
            if seen_urls.contains(&full_ep_url) {
                continue;
            }
            seen_urls.insert(full_ep_url.clone());
            let ep_num: Option<u32> = cap.get(2).and_then(|m| m.as_str().parse().ok());
            let title = if let Some(n) = ep_num {
                format!("{} - Episode {}", show_title, n)
            } else {
                format!("{} - Episode", show_title)
            };

            gogo_episodes.push(DiscoveredRelease {
                title,
                post_url: full_ep_url,
                thumbnail: show_thumb.clone(),
                date: None,
                site_domain: domain.to_string(),
                media_type: "tv".to_string(),
                season: Some(1),
                episode: ep_num,
            });
        }

        // Sort episodes ascending (Episode 1, 2, 3...)
        gogo_episodes.sort_by_key(|e| e.episode.unwrap_or(0));
        releases.extend(gogo_episodes);
    }

    // 1b-3. Yomi.to Anime Cards Pattern (<a class="anime-card group" href="/anime/{slug}-{id}">...<img alt="{title}" src="{thumb}"...</a>)
    if domain.contains("yomi") {
        let yomi_card_re = Regex::new(r#"(?is)<a[^>]+href=["'](/anime/[^"']+)["'][^>]*>.*?<img[^>]+alt=["']([^"']+)["'][^>]+src=["']([^"']+)["']"#).unwrap();
        for cap in yomi_card_re.captures_iter(html) {
            let path = cap.get(1).unwrap().as_str();
            let full_url = format!("{}/{}", base_origin.trim_end_matches('/'), path.trim_start_matches('/'));
            if seen_urls.contains(&full_url) {
                continue;
            }
            seen_urls.insert(full_url.clone());
            let title = cap.get(2).unwrap().as_str().trim().to_string();
            let thumb = cap.get(3).unwrap().as_str().trim().to_string();

            releases.push(DiscoveredRelease {
                title,
                post_url: full_url,
                thumbnail: Some(thumb),
                date: None,
                site_domain: "yomi.to".to_string(),
                media_type: "tv".to_string(),
                season: Some(1),
                episode: Some(1),
            });
        }
    }

    // 1c. Sxyprn Post Pattern
    if domain.contains("sxyprn") {
        let sxy_re = Regex::new(r#"(?is)<a[^>]+href=["'](/post/[^"']+\.html(?:[^"']*)?)["'][^>]*title=["']([^"']+)["'][^>]*>.*?<img[^>]+(?:data-src|src)=["']([^"']+)["']"#).unwrap();
        for cap in sxy_re.captures_iter(html) {
            let p_url = cap.get(1).unwrap().as_str();
            let full_post_url = format!("https://www.sxyprn.com{}", p_url);
            if seen_urls.contains(&full_post_url) {
                continue;
            }
            seen_urls.insert(full_post_url.clone());
            let title = cap.get(2).unwrap().as_str().trim().to_string();
            let mut thumb = cap.get(3).unwrap().as_str().trim().to_string();
            if thumb.starts_with("//") {
                thumb = format!("https:{}", thumb);
            }
            releases.push(DiscoveredRelease {
                title,
                post_url: full_post_url,
                thumbnail: Some(thumb),
                date: None,
                site_domain: domain.to_string(),
                media_type: "adult".to_string(),
                season: None,
                episode: None,
            });
        }
    }

    // 1d. Pornhub Video Pattern
    if domain.contains("pornhub") {
        let ph_re = Regex::new(r#"(?is)<a\s+href=["'](/view_video\.php\?viewkey=[^"']+)["'][^>]*title=["']([^"']+)["'][^>]*>.*?<img[^>]+(?:data-thumb_url|data-src|src)=["']([^"']+)["']"#).unwrap();
        for cap in ph_re.captures_iter(html) {
            let p_url = cap.get(1).unwrap().as_str();
            let full_url = format!("https://www.pornhub.com{}", p_url);
            if seen_urls.contains(&full_url) {
                continue;
            }
            seen_urls.insert(full_url.clone());
            let title = cap.get(2).unwrap().as_str().trim().to_string();
            let mut thumb = cap.get(3).unwrap().as_str().trim().to_string();
            if thumb.starts_with("//") {
                thumb = format!("https:{}", thumb);
            }
            releases.push(DiscoveredRelease {
                title,
                post_url: full_url,
                thumbnail: Some(thumb),
                date: None,
                site_domain: "pornhub.com".to_string(),
                media_type: "adult".to_string(),
                season: None,
                episode: None,
            });
        }
    }

    if releases.is_empty() {
        for hcap in plain_heading_re.captures_iter(html) {
            let mut post_url = hcap.get(1).unwrap().as_str().trim().to_string();
            if post_url.starts_with('/') {
                post_url = format!("{}/{}", base_origin.trim_end_matches('/'), post_url.trim_start_matches('/'));
            }
            if !post_url.starts_with("http") {
                continue;
            }
            if post_url == site_url || post_url == format!("{}/", site_url) {
                continue;
            }
            if seen_urls.contains(&post_url) {
                continue;
            }
            seen_urls.insert(post_url.clone());

            let raw_h_title = hcap.get(2).unwrap().as_str();
            let title = strip_tag_re.replace_all(raw_h_title, "").trim().to_string();
            if title.is_empty() || title.len() < 3 {
                continue;
            }

            let start = hcap.get(0).unwrap().start();
            let end = hcap.get(0).unwrap().end();
            let preceding = &html[start.saturating_sub(600)..start];
            let following_end = std::cmp::min(html.len(), end.saturating_add(800));
            let following = &html[end..following_end];
            let thumbnail = img_re.captures(preceding)
                .or_else(|| img_re.captures(following))
                .and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
                .filter(|u| !u.contains("avatar") && !u.contains("logo") && !u.contains("icon") && !u.contains("1x1") && !u.contains("emoji"));

            let (season, episode) = detect_season_episode(&title);
            let media_type = if season.is_some() || episode.is_some() { "tv".into() } else { "movies".into() };

            releases.push(DiscoveredRelease {
                title,
                post_url,
                thumbnail,
                date: None,
                site_domain: domain.to_string(),
                media_type,
                season,
                episode,
            });
        }
    }

    // 1e. Direct Media Link Extraction (Open directories, media index pages, file tables)
    let direct_link_re = Regex::new(r#"(?is)<a\b[^>]*href=["']([^"']+\.(?:mp4|mkv|webm|avi|mov|flv|ts|m4v|mp3|m4a|flac|ogg|wav|epub|pdf|cbz|cbr)(?:\?[^"']*)?)["'][^>]*>(.*?)</a>"#).unwrap();
    for cap in direct_link_re.captures_iter(html) {
        let raw_link = cap.get(1).unwrap().as_str().trim();
        let post_url = if raw_link.starts_with('/') {
            format!("{}/{}", base_origin.trim_end_matches('/'), raw_link.trim_start_matches('/'))
        } else if !raw_link.starts_with("http") {
            format!("{}/{}", site_url.trim_end_matches('/'), raw_link.trim_start_matches('/'))
        } else {
            raw_link.to_string()
        };

        if seen_urls.contains(&post_url) {
            continue;
        }
        seen_urls.insert(post_url.clone());

        let raw_text = cap.get(2).unwrap().as_str();
        let mut title = strip_tag_re.replace_all(raw_text, "").trim().to_string();
        if title.is_empty() || title.len() < 2 || title.to_lowercase().contains("download") {
            let file_part = post_url.split('?').next().unwrap_or(&post_url);
            let filename = file_part.split('/').last().unwrap_or("Media File");
            title = filename.replace("%20", " ").replace('_', " ");
        }
        title = decode_html_entities(&title);

        let lower = post_url.to_lowercase();
        let media_type = if lower.contains(".epub") || lower.contains(".pdf") || lower.contains(".cbz") || lower.contains(".cbr") {
            "books".to_string()
        } else if lower.contains(".mp3") || lower.contains(".m4a") || lower.contains(".flac") || lower.contains(".ogg") || lower.contains(".wav") {
            "music".to_string()
        } else {
            let (s, e) = detect_season_episode(&title);
            if s.is_some() || e.is_some() { "tv".to_string() } else { "movies".to_string() }
        };

        let (season, episode) = if media_type == "tv" {
            detect_season_episode(&title)
        } else {
            (None, None)
        };

        releases.push(DiscoveredRelease {
            title,
            post_url,
            thumbnail: None,
            date: None,
            site_domain: domain.to_string(),
            media_type,
            season,
            episode,
        });
    }

    // Prioritize English Dubs for Gogoanime search / catalog feeds
    if domain.contains("gogoanime") || domain.contains("gogoanimes") || domain.contains("anitaku") {
        if !html.contains("episode_related") {
            releases.sort_by_key(|r| {
                let is_dub = r.title.contains("(Dub)") || r.post_url.contains("-dub");
                if is_dub { 0 } else { 1 }
            });
        }
    }

    releases
}

/// Query AniList GraphQL and produce a structured release feed for Yomi series or search queries.
async fn crawl_yomi_feed(url: &str, parsed_url: &reqwest::Url, client: &reqwest::Client) -> Result<SiteDiscoveryFeed, String> {
    let anime_re = Regex::new(r"(?i)yomi\.to/(?:anime|category|series)/([^/?#]+)-(\d+)").unwrap();
    let watch_re = Regex::new(r"(?i)yomi\.to/watch/([^/?#]+)-(\d+)(?:/(\d+))?").unwrap();

    // 1. Series Page: yomi.to/anime/{slug}-{anilist_id} -> Enumerate ALL episodes!
    if let Some(cap) = anime_re.captures(url) {
        let slug = cap[1].to_string();
        let anilist_id: i64 = cap[2].parse().unwrap_or(0);
        return fetch_yomi_series_episodes(&slug, anilist_id, client, url).await;
    }

    // 2. Watch Page: yomi.to/watch/{slug}-{anilist_id}/{ep}
    if let Some(cap) = watch_re.captures(url) {
        let slug = cap[1].to_string();
        let anilist_id: i64 = cap[2].parse().unwrap_or(0);
        return fetch_yomi_series_episodes(&slug, anilist_id, client, url).await;
    }

    // 3. Search or Browse Page: yomi.to/browse?query=... or yomi.to/search?q=...
    let query_opt = parsed_url.query_pairs()
        .find(|(k, _)| k == "query" || k == "q" || k == "keyword")
        .map(|(_, v)| v.trim().to_string())
        .filter(|q| !q.is_empty());

    fetch_yomi_search_catalog(query_opt.as_deref(), client, url).await
}

async fn fetch_yomi_series_episodes(
    slug: &str,
    anilist_id: i64,
    client: &reqwest::Client,
    original_url: &str,
) -> Result<SiteDiscoveryFeed, String> {
    let gql = r#"
        query($id: Int) {
            Media(id: $id, type: ANIME) {
                id
                title { english romaji }
                coverImage { extraLarge large }
                bannerImage
                episodes
                nextAiringEpisode { episode }
                format
                status
            }
        }
    "#;

    let body = serde_json::json!({
        "query": gql,
        "variables": { "id": anilist_id }
    });
    let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    let resp = client.post("https://graphql.anilist.co")
        .header("Content-Type", "application/json")
        .body(body_str)
        .send()
        .await
        .map_err(|e| format!("Failed to contact AniList for Yomi series: {}", e))?;

    let resp_text = resp.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&resp_text)
        .map_err(|e| format!("Failed to parse AniList response: {}", e))?;

    let media = &json["data"]["Media"];
    if media.is_null() {
        return Err(format!("No anime metadata found on AniList for ID {}", anilist_id));
    }

    let title = media["title"]["english"].as_str()
        .or_else(|| media["title"]["romaji"].as_str())
        .unwrap_or(slug);

    let thumb = media["coverImage"]["extraLarge"].as_str()
        .or_else(|| media["coverImage"]["large"].as_str())
        .map(String::from);

    let format_str = media["format"].as_str().unwrap_or("TV");
    let total_episodes = media["episodes"].as_u64()
        .or_else(|| media["nextAiringEpisode"]["episode"].as_u64().map(|e: u64| e.saturating_sub(1)))
        .unwrap_or(1);

    let mut releases = Vec::new();

    if format_str == "MOVIE" || total_episodes <= 1 {
        releases.push(DiscoveredRelease {
            title: title.to_string(),
            post_url: format!("https://yomi.to/watch/{}-{}/1", slug, anilist_id),
            thumbnail: thumb.clone(),
            date: None,
            site_domain: "yomi.to".to_string(),
            media_type: "movies".to_string(),
            season: None,
            episode: None,
        });
    } else {
        for ep in 1..=total_episodes {
            releases.push(DiscoveredRelease {
                title: format!("{} - Episode {}", title, ep),
                post_url: format!("https://yomi.to/watch/{}-{}/{}", slug, anilist_id, ep),
                thumbnail: thumb.clone(),
                date: None,
                site_domain: "yomi.to".to_string(),
                media_type: "tv".to_string(),
                season: Some(1),
                episode: Some(ep as u32),
            });
        }
    }

    Ok(SiteDiscoveryFeed {
        site_url: original_url.to_string(),
        site_title: format!("Yomi - {}", title),
        releases,
    })
}

async fn fetch_yomi_search_catalog(
    search_query: Option<&str>,
    client: &reqwest::Client,
    original_url: &str,
) -> Result<SiteDiscoveryFeed, String> {
    let (query_str, variables) = if let Some(q) = search_query {
        let gql = r#"
            query($search: String) {
                Page(page: 1, perPage: 25) {
                    media(search: $search, type: ANIME, isAdult: false, sort: SEARCH_MATCH) {
                        id
                        title { english romaji }
                        coverImage { extraLarge large }
                        episodes
                        nextAiringEpisode { episode }
                        format
                        status
                    }
                }
            }
        "#;
        (gql, serde_json::json!({ "search": q }))
    } else {
        let gql = r#"
            query {
                Page(page: 1, perPage: 25) {
                    media(type: ANIME, isAdult: false, sort: TRENDING_DESC) {
                        id
                        title { english romaji }
                        coverImage { extraLarge large }
                        episodes
                        nextAiringEpisode { episode }
                        format
                        status
                    }
                }
            }
        "#;
        (gql, serde_json::json!({}))
    };

    let body = serde_json::json!({
        "query": query_str,
        "variables": variables
    });
    let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    let resp = client.post("https://graphql.anilist.co")
        .header("Content-Type", "application/json")
        .body(body_str)
        .send()
        .await
        .map_err(|e| format!("Failed to search AniList for Yomi: {}", e))?;

    let resp_text = resp.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&resp_text)
        .map_err(|e| format!("Failed to parse AniList search response: {}", e))?;

    let mut releases = Vec::new();
    if let Some(items) = json["data"]["Page"]["media"].as_array() {
        for m in items {
            let id = match m["id"].as_i64() {
                Some(id) => id,
                None => continue,
            };

            let title = m["title"]["english"].as_str()
                .or_else(|| m["title"]["romaji"].as_str())
                .unwrap_or("Untitled Anime")
                .to_string();

            let thumb = m["coverImage"]["extraLarge"].as_str()
                .or_else(|| m["coverImage"]["large"].as_str())
                .map(String::from);

            let format_str = m["format"].as_str().unwrap_or("TV");
            let eps = m["episodes"].as_u64()
                .or_else(|| m["nextAiringEpisode"]["episode"].as_u64().map(|e: u64| e.saturating_sub(1)))
                .unwrap_or(1);

            let slug = title.to_lowercase()
                .chars()
                .map(|c: char| if c.is_alphanumeric() { c } else { '-' })
                .collect::<String>();
            let clean_slug = slug.split('-').filter(|s: &&str| !s.is_empty()).collect::<Vec<_>>().join("-");

            let is_movie = format_str == "MOVIE" || eps <= 1;
            let (post_url, media_type, episode) = if is_movie {
                (format!("https://yomi.to/watch/{}-{}/1", clean_slug, id), "movies".to_string(), None)
            } else {
                (format!("https://yomi.to/anime/{}-{}", clean_slug, id), "tv".to_string(), None)
            };

            releases.push(DiscoveredRelease {
                title,
                post_url,
                thumbnail: thumb,
                date: None,
                site_domain: "yomi.to".to_string(),
                media_type,
                season: if is_movie { None } else { Some(1) },
                episode,
            });
        }
    }

    let site_title = match search_query {
        Some(q) => format!("Yomi Search: {}", q),
        None => "Yomi Trending Anime".to_string(),
    };

    Ok(SiteDiscoveryFeed {
        site_url: original_url.to_string(),
        site_title,
        releases,
    })
}

async fn crawl_balbums(url: &str, client: &reqwest::Client) -> Result<SiteDiscoveryFeed, String> {
    let resp = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Balbums page: {}", e))?;

    let html = resp.text().await.map_err(|e| format!("Failed to read Balbums response: {}", e))?;

    let card_re = Regex::new(r#"(?s)<a\s+href="([^"]*bunkr[^"]*/a/[^"]*)"[^>]*class="[^"]*card[^"]*"[^>]*>(.*?)</a>"#)
        .map_err(|e| e.to_string())?;
    let img_re = Regex::new(r#"<img[^>]+src="([^"]+)""#).map_err(|e| e.to_string())?;
    let alt_re = Regex::new(r#"alt="([^"]+)""#).map_err(|e| e.to_string())?;
    let title_re = Regex::new(r#"<h3[^>]*>([^<]+)</h3>"#).map_err(|e| e.to_string())?;
    let count_re = Regex::new(r#"<span[^>]*>([0-9]+\s*files?)</span>"#).map_err(|e| e.to_string())?;

    let mut releases = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for cap in card_re.captures_iter(&html) {
        let post_url = cap[1].trim().to_string();
        if seen.contains(&post_url) {
            continue;
        }
        seen.insert(post_url.clone());
        let inner = &cap[2];

        let title_raw = title_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string())
            .or_else(|| {
                alt_re
                    .captures(inner)
                    .and_then(|c| c.get(1))
                    .map(|m| m.as_str().trim().to_string())
            })
            .unwrap_or_else(|| "Bunkr Album".to_string());

        let file_count = count_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| format!(" ({})", m.as_str().trim()))
            .unwrap_or_default();

        let thumbnail = img_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string());

        releases.push(DiscoveredRelease {
            title: format!("{}{}", title_raw, file_count),
            post_url,
            thumbnail,
            date: None,
            site_domain: "balbums.st".to_string(),
            media_type: "adult".to_string(),
            season: None,
            episode: None,
        });
    }

    Ok(SiteDiscoveryFeed {
        site_url: url.to_string(),
        site_title: "Balbums (Bunkr Albums)".to_string(),
        releases,
    })
}

async fn crawl_bunkr_album(url: &str, client: &reqwest::Client) -> Result<SiteDiscoveryFeed, String> {
    let resp = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36")
        .header("Referer", "https://balbums.st/")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Bunkr album: {}", e))?;

    let parsed_url = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    let origin = format!("{}://{}", parsed_url.scheme(), parsed_url.host_str().unwrap_or("bunkr.cr"));
    let html = resp.text().await.map_err(|e| format!("Failed to read Bunkr album: {}", e))?;

    let album_title_re = Regex::new(r#"<h1[^>]*>([^<]+)</h1>"#).unwrap();
    let album_title = album_title_re
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_else(|| "Bunkr Album".to_string());

    let file_item_re = Regex::new(r#"(?s)<div[^>]*class="[^"]*theItem[^"]*"[^>]*title="([^"]*)"[^>]*>(.*?)href="(/[fvd]/[a-zA-Z0-9]+)""#).unwrap();
    let img_re = Regex::new(r#"<img[^>]+src="([^"]+)""#).unwrap();
    let size_re = Regex::new(r#"<p[^>]*class="[^"]*theSize[^"]*"[^>]*>([^<]+)</p>"#).unwrap();

    let mut releases = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for cap in file_item_re.captures_iter(&html) {
        let file_title = cap[1].trim().to_string();
        let inner = &cap[2];
        let rel_href = &cap[3];
        let full_url = format!("{}{}", origin, rel_href);

        if seen.contains(&full_url) {
            continue;
        }
        seen.insert(full_url.clone());

        let size_str = size_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| format!(" [{}]", m.as_str().trim()))
            .unwrap_or_default();

        let thumbnail = img_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| {
                let s = m.as_str().trim();
                if s.starts_with('/') {
                    format!("{}{}", origin, s)
                } else {
                    s.to_string()
                }
            });

        releases.push(DiscoveredRelease {
            title: format!("{}{}", if file_title.is_empty() { "Media File" } else { &file_title }, size_str),
            post_url: full_url,
            thumbnail,
            date: None,
            site_domain: parsed_url.host_str().unwrap_or("bunkr.cr").to_string(),
            media_type: "adult".to_string(),
            season: None,
            episode: None,
        });
    }

    Ok(SiteDiscoveryFeed {
        site_url: url.to_string(),
        site_title: album_title,
        releases,
    })
}

async fn crawl_pixeldrain_list(url: &str, client: &reqwest::Client) -> Result<SiteDiscoveryFeed, String> {
    let list_id = url
        .split("/l/")
        .nth(1)
        .and_then(|s| s.split(&['?', '#', '/'][..]).next())
        .unwrap_or("");

    if list_id.is_empty() {
        return Err("Invalid Pixeldrain list URL".to_string());
    }

    let api_url = format!("https://pixeldrain.com/api/list/{}", list_id);
    let resp = client
        .get(&api_url)
        .send()
        .await
        .map_err(|e| format!("Failed to query Pixeldrain list API: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read Pixeldrain list response: {}", e))?;

    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse Pixeldrain list response: {}", e))?;

    let list_title = json["title"].as_str().unwrap_or("Pixeldrain Album").to_string();
    let mut releases = Vec::new();
    if let Some(arr) = json["files"].as_array() {
        for f in arr {
            let fid = f["id"].as_str().unwrap_or("");
            let name = f["name"].as_str().unwrap_or("").trim();
            if fid.is_empty() || name.is_empty() {
                continue;
            }

            let (clean_title, _) = clean_scraped_title(name);
            let (season, episode) = detect_season_episode(name);
            let post_url = format!("https://pixeldrain.com/api/file/{}", fid);
            let media_type = if season.is_some() || episode.is_some() {
                "tv".to_string()
            } else {
                detect_media_type(&clean_title, &post_url, "")
            };

            releases.push(DiscoveredRelease {
                title: if let (Some(s), Some(e)) = (season, episode) {
                    format!("{} - S{:02}E{:02}", clean_title, s, e)
                } else {
                    name.to_string()
                },
                post_url,
                thumbnail: Some(format!("https://pixeldrain.com/api/file/{}/thumbnail", fid)),
                date: None,
                site_domain: "pixeldrain.com".to_string(),
                media_type,
                season,
                episode,
            });
        }
    }

    Ok(SiteDiscoveryFeed {
        site_url: url.to_string(),
        site_title: list_title,
        releases,
    })
}

async fn crawl_archive_org(url: &str, client: &reqwest::Client) -> Result<SiteDiscoveryFeed, String> {
    let re = Regex::new(r"(?i)archive\.org/(?:details|metadata|download|embed)/([^/?#]+)").unwrap();
    let identifier = if let Some(cap) = re.captures(url) {
        cap[1].to_string()
    } else {
        let path = reqwest::Url::parse(url).ok().and_then(|u| {
            u.path_segments().and_then(|mut s| s.next_back().map(|seg| seg.to_string()))
        }).unwrap_or_default();
        if path.is_empty() {
            return Err("Could not extract Archive.org item identifier".to_string());
        }
        path
    };

    let meta_url = format!("https://archive.org/metadata/{}", identifier);
    info!(target: "stream", "Fetching Archive.org metadata from: {}", meta_url);

    let resp = client
        .get(&meta_url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| format!("Archive.org API request failed: {}", e))?;

    let text = resp.text().await.map_err(|e| format!("Failed to read Archive.org response: {}", e))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Archive.org returned invalid JSON: {}", e))?;

    let meta = &json["metadata"];
    let raw_title = meta["title"].as_str().unwrap_or(&identifier);
    let collection_title = format!("Archive.org: {}", raw_title);
    let poster = format!("https://archive.org/services/img/{}", identifier);

    let mut releases = Vec::new();

    if let Some(files) = json["files"].as_array() {
        for file in files {
            let name = file["name"].as_str().unwrap_or("");
            if name.is_empty() || name.starts_with('_') || name.ends_with(".xml") || name.ends_with(".sqlite") || name.ends_with(".torrent") {
                continue;
            }

            let lower = name.to_lowercase();
            let is_video = lower.ends_with(".mp4") || lower.ends_with(".mkv") || lower.ends_with(".webm") || lower.ends_with(".avi") || lower.ends_with(".mov") || lower.ends_with(".flv") || lower.ends_with(".ts") || lower.ends_with(".m4v");
            let is_audio = lower.ends_with(".mp3") || lower.ends_with(".m4a") || lower.ends_with(".flac") || lower.ends_with(".ogg") || lower.ends_with(".wav") || lower.ends_with(".opus");
            let is_comic = lower.ends_with(".cbz") || lower.ends_with(".cbr") || lower.ends_with(".cb7") || lower.ends_with(".cbt");
            let is_book = lower.ends_with(".epub") || lower.ends_with(".pdf") || is_comic;

            if !is_video && !is_audio && !is_book {
                continue;
            }

            let media_type = if is_comic {
                "comics".to_string()
            } else if is_book {
                "books".to_string()
            } else if is_audio {
                "music".to_string()
            } else {
                let (s, e) = detect_season_episode(name);
                if s.is_some() || e.is_some() { "tv".to_string() } else { "movies".to_string() }
            };

            let (season, episode) = if media_type == "tv" {
                detect_season_episode(name)
            } else {
                (None, None)
            };

            let item_title = file["title"].as_str().map(|t| t.to_string()).unwrap_or_else(|| {
                let clean = name.rsplit_once('.').map(|(n, _)| n).unwrap_or(name);
                clean.replace('_', " ").replace("%20", " ")
            });

            let mut dl_url = reqwest::Url::parse("https://archive.org").unwrap();
            if let Ok(mut segs) = dl_url.path_segments_mut() {
                segs.push("download").push(&identifier).push(name);
            }
            let post_url = dl_url.to_string();

            releases.push(DiscoveredRelease {
                title: item_title,
                post_url,
                thumbnail: Some(poster.clone()),
                date: file["mtime"].as_str().map(|d| d.to_string()),
                site_domain: "archive.org".to_string(),
                media_type,
                season,
                episode,
            });
        }
    }

    Ok(SiteDiscoveryFeed {
        site_url: format!("https://archive.org/details/{}", identifier),
        site_title: collection_title,
        releases,
    })
}

async fn crawl_tubi_tv_channels(client: &reqwest::Client) -> Result<SiteDiscoveryFeed, String> {
    let url = "https://raw.githubusercontent.com/BuddyChewChew/tubi-scraper/refs/heads/main/tubi_playlist.m3u";
    let resp = client.get(url).send().await.map_err(|e| format!("Failed to fetch Tubi TV playlist: {}", e))?;
    let text = resp.text().await.map_err(|e| format!("Failed to read Tubi TV playlist: {}", e))?;

    let mut releases = Vec::new();
    let mut current_title = String::new();
    let mut current_logo: Option<String> = None;

    let title_logo_re = Regex::new(r#"(?i)#EXTINF:-1[^>]*tvg-logo=["']([^"']+)["'][^,]*,(.+)$"#).unwrap();
    let title_only_re = Regex::new(r#"(?i)#EXTINF:-1[^,]*,(.+)$"#).unwrap();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("#EXTINF:") {
            if let Some(c) = title_logo_re.captures(trimmed) {
                current_logo = Some(c.get(1).unwrap().as_str().to_string());
                current_title = c.get(2).unwrap().as_str().trim().to_string();
            } else if let Some(c) = title_only_re.captures(trimmed) {
                current_logo = None;
                current_title = c.get(1).unwrap().as_str().trim().to_string();
            }
        } else if trimmed.starts_with("http") && !current_title.is_empty() {
            releases.push(DiscoveredRelease {
                title: current_title.clone(),
                post_url: trimmed.to_string(),
                thumbnail: current_logo.clone(),
                date: None,
                site_domain: "tubitv.com".to_string(),
                media_type: "tv".to_string(),
                season: None,
                episode: None,
            });
            current_title.clear();
            current_logo = None;
        }
    }

    Ok(SiteDiscoveryFeed {
        site_url: "https://tubitv.com".to_string(),
        site_title: "Tubi TV Live Channels".to_string(),
        releases,
    })
}

/// Crawl any website or cyberlocker domain for playable releases.
/// Returns a release feed with post titles, URLs, thumbnails, and TV season/episode metadata.
#[tauri::command]
pub async fn crawl_website_releases(url: String) -> Result<SiteDiscoveryFeed, String> {
    let mut trimmed = url.trim().to_string();
    if trimmed.is_empty() {
        return Err("URL or site domain cannot be empty".to_string());
    }

    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        trimmed = format!("https://{}", trimmed);
    }

    let parsed_url = reqwest::Url::parse(&trimmed).map_err(|e| format!("Invalid URL: {}", e))?;
    let host = parsed_url.host_str().unwrap_or("").to_lowercase();
    let client = build_client()?;

    // 0a. Direct Media Stream Guard (e.g. .mkv, .mp4, .webm, .m3u8, .avi directly supplied)
    if is_direct_media_url(&trimmed) {
        let filename = parsed_url.path_segments().and_then(|mut s| s.next_back()).unwrap_or("Direct Stream");
        let decoded_name = filename.replace("%20", " ");
        let (clean_title, _) = clean_scraped_title(&decoded_name);
        let (season, episode) = detect_season_episode(&decoded_name);
        let media_type = if season.is_some() || episode.is_some() { "tv".to_string() } else { "movies".to_string() };

        return Ok(SiteDiscoveryFeed {
            site_url: trimmed.clone(),
            site_title: clean_title.clone(),
            releases: vec![DiscoveredRelease {
                title: if let (Some(s), Some(e)) = (season, episode) {
                    format!("{} - S{:02}E{:02}", clean_title, s, e)
                } else {
                    clean_title
                },
                post_url: trimmed,
                thumbnail: None,
                date: None,
                site_domain: host,
                media_type,
                season,
                episode,
            }],
        });
    }

    // 0b-comics. ReadComicsOnline / MangaDex / Archive Comics Discovery
    if host.contains("readcomicsonline") || host.contains("mangadex.org") || trimmed.starts_with("mangadex://") {
        return crawl_comics_portal(&trimmed, &client).await;
    }

    // 0b. Yomi.to Dedicated Discovery & Series Hierarchy Crawler
    if host.contains("yomi.to") {
        return crawl_yomi_feed(&trimmed, &parsed_url, &client).await;
    }

    // 0d. Tubi TV Live Channels Discovery
    if host.contains("tubitv") || host.contains("tubi.tv") || host.contains("tubi") || trimmed.contains("tubi") {
        return crawl_tubi_tv_channels(&client).await;
    }

    // 0e. Pixeldrain List / Album Deep Crawler
    if host.contains("pixeldrain.com") && trimmed.contains("/l/") {
        return crawl_pixeldrain_list(&trimmed, &client).await;
    }

    // 0e-balbums. Balbums Search & Bunkr Album Crawler
    if host.contains("balbums") {
        return crawl_balbums(&trimmed, &client).await;
    }

    if (host.contains("bunkr") || host.contains("bunkrr")) && trimmed.contains("/a/") {
        return crawl_bunkr_album(&trimmed, &client).await;
    }

    // 0f. Archive.org Collection & Details Crawler
    if host.contains("archive.org") {
        return crawl_archive_org(&trimmed, &client).await;
    }

    // 1. Moviebite Dedicated Discovery
    if host.contains("moviebite") {
        // TV show drill-down: moviebite.org/watch/tv/{tmdb_id} (no episode param yet)
        if let Some(cap) = Regex::new(r"(?i)moviebite\.org/watch/tv/(\d+)")
            .unwrap()
            .captures(&trimmed)
        {
            if !trimmed.contains("episode=") {
                let tmdb_id = &cap[1];
                let addon_url = format!("https://tmdb.elfhosted.com/meta/series/tmdb:{tmdb_id}.json");
                if let Ok(resp) = client.get(&addon_url).send().await {
                    if let Ok(text) = resp.text().await {
                        if let Ok(meta_json) = serde_json::from_str::<serde_json::Value>(&text) {
                            let meta = &meta_json["meta"];
                            let show_name = meta["name"].as_str().unwrap_or("TV Show").to_string();
                            let show_poster = meta["poster"].as_str().map(|s: &str| s.to_string());
                            let mut releases = Vec::new();
                            if let Some(videos) = meta["videos"].as_array() {
                                for v in videos {
                                    let s = v["season"].as_u64().unwrap_or(1) as u32;
                                    let ep = v["episode"].as_u64().or_else(|| v["number"].as_u64()).unwrap_or(1) as u32;
                                    let ep_name = v["name"].as_str().unwrap_or("");
                                    let title = if ep_name.is_empty() {
                                        format!("{show_name} S{s:02}E{ep:02}")
                                    } else {
                                        format!("{show_name} S{s:02}E{ep:02} - {ep_name}")
                                    };
                                    let thumb = v["thumbnail"].as_str().map(|s: &str| s.to_string()).or_else(|| show_poster.clone());
                                    releases.push(DiscoveredRelease {
                                        title,
                                        post_url: format!("https://moviebite.org/watch/tv/{tmdb_id}?season={s}&episode={ep}"),
                                        thumbnail: thumb,
                                        date: v["released"].as_str().map(|d: &str| d[..10.min(d.len())].to_string()),
                                        site_domain: "moviebite.org".to_string(),
                                        media_type: "tv".to_string(),
                                        season: Some(s),
                                        episode: Some(ep),
                                    });
                                }
                            }
                            if !releases.is_empty() {
                                return Ok(SiteDiscoveryFeed {
                                    site_title: show_name,
                                    site_url: trimmed.clone(),
                                    releases,
                                });
                            }
                        }
                    }
                }
            }
        }

        // Desktop search lands here as moviebite.org/?s=<query> (DirectPlayPage generic
        // fallback). MovieBite requires X-MovieBite-Client on /api/* or it returns
        // 403 {"success":false,"error":"Forbidden"} — which previously parsed into an
        // empty feed with no error surfaced.
        let mb_query: Option<String> = parsed_url
            .query_pairs()
            .find(|(k, _)| k == "s" || k == "q" || k == "query")
            .map(|(_, v)| v.trim().to_string())
            .filter(|s| !s.is_empty());

        let api_url = match &mb_query {
            Some(q) => format!(
                "https://moviebite.org/api/search?q={}",
                percent_encoding::utf8_percent_encode(q, percent_encoding::NON_ALPHANUMERIC)
            ),
            None => "https://moviebite.org/api/trending".to_string(),
        };

        let resp = client
            .get(&api_url)
            .header("Accept", "application/json")
            .header("X-MovieBite-Client", "1")
            .header("Origin", "https://moviebite.org")
            .header("Referer", "https://moviebite.org/")
            .send()
            .await
            .map_err(|e| format!("Failed to contact MovieBite: {}", e))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read MovieBite response: {}", e))?;
        if !status.is_success() {
            return Err(format!(
                "MovieBite API returned HTTP {}: {}",
                status,
                text.chars().take(200).collect::<String>()
            ));
        }
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid MovieBite JSON: {}", e))?;
        if json["success"].as_bool() == Some(false) || json["error"].is_string() {
            return Err(format!(
                "MovieBite API error: {}",
                json["error"].as_str().unwrap_or("unknown upstream error")
            ));
        }

        let mut releases = Vec::new();
        if let Some(results) = json["results"].as_array() {
            for item in results {
                let id = item["id"].as_i64().or_else(|| item["tmdbId"].as_i64());
                let media_type = item["mediaType"].as_str().unwrap_or("movie").to_string();
                let title = item["title"]
                    .as_str()
                    .or_else(|| item["name"].as_str())
                    .unwrap_or("Untitled")
                    .to_string();

                let poster_path: Option<&str> = item["posterPath"].as_str().or_else(|| item["backdropPath"].as_str());
                let thumbnail = poster_path.map(|p: &str| {
                    if p.starts_with("http") {
                        p.to_string()
                    } else {
                        format!("https://image.tmdb.org/t/p/w500{}", p)
                    }
                });

                let date: Option<String> = item["releaseDate"]
                    .as_str()
                    .or_else(|| item["firstAirDate"].as_str())
                    .map(|d: &str| d.to_string());

                if let Some(item_id) = id {
                    let post_url = format!("https://moviebite.org/watch/{}/{}", media_type, item_id);
                    let (s, e) = detect_season_episode(&title);
                    releases.push(DiscoveredRelease {
                        title,
                        post_url,
                        thumbnail,
                        date,
                        site_domain: "moviebite.org".to_string(),
                        media_type,
                        season: s,
                        episode: e,
                    });
                }
            }
        }

        if releases.is_empty() && !json["results"].is_array() {
            return Err("MovieBite returned no results array (API may have changed)".to_string());
        }
        return Ok(SiteDiscoveryFeed {
            site_url: trimmed,
            site_title: match &mb_query {
                Some(q) => format!("MovieBite: \"{}\"", q),
                None => "MovieBite Trending Releases".to_string(),
            },
            releases,
        });
    }

    // 2. RSS / Atom Feed Discovery (Standard WordPress, release blogs like rlsbb, eztv, etc.)
    let feed_urls = vec![
        format!("{}/feed/", trimmed.trim_end_matches('/')),
        format!("{}/feed", trimmed.trim_end_matches('/')),
        format!("{}/rss", trimmed.trim_end_matches('/')),
    ];

    for f_url in &feed_urls {
        if let Ok(resp) = client.get(f_url).send().await {
            if resp.status().is_success() {
                if let Ok(body) = resp.text().await {
                    if body.contains("<rss") || body.contains("<feed") || body.contains("<item") {
                        if let Some(feed) = parse_rss_feed(&body, &trimmed, &host) {
                            if !feed.releases.is_empty() {
                                return Ok(feed);
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback to HTML Scraping
    let resp = client
        .get(&trimmed)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch site: {}", e))?;

    let body = resp.text().await.map_err(|e| format!("Failed to read site HTML: {}", e))?;

    let rss_link_re = Regex::new(r#"(?i)<link[^>]+type=["']application/rss\+xml["'][^>]+href=["']([^"']+)["']"#).unwrap();
    if let Some(cap) = rss_link_re.captures(&body) {
        if let Some(m) = cap.get(1) {
            let discovered_feed_url = m.as_str();
            if let Ok(f_resp) = client.get(discovered_feed_url).send().await {
                if f_resp.status().is_success() {
                    if let Ok(f_body) = f_resp.text().await {
                        if let Some(feed) = parse_rss_feed(&f_body, &trimmed, &host) {
                            if !feed.releases.is_empty() {
                                return Ok(feed);
                            }
                        }
                    }
                }
            }
        }
    }

    let releases = parse_html_releases(&body, &trimmed, &host);

    // Fallback: If BaddiesEast search yields no items, gracefully fallback to BrokenSilenze search
    if releases.is_empty() && host.contains("baddieseast") {
        if let Some(q) = trimmed.split("/search/").nth(1).or_else(|| trimmed.split("?s=").nth(1)) {
            let clean_q = q.trim_matches('/').split('?').next().unwrap_or(q);
            if !clean_q.is_empty() {
                let bs_url = format!("https://brokensilenze.net/?s={}", clean_q);
                if let Ok(bs_feed) = Box::pin(crawl_website_releases(bs_url)).await {
                    if !bs_feed.releases.is_empty() {
                        return Ok(bs_feed);
                    }
                }
            }
        }
    }

    let title_re = Regex::new(r#"(?i)<title[^>]*>([^<]+)</title>"#).unwrap();
    let mut site_title = title_re
        .captures(&body)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_else(|| host.clone());

    for postfix in &[" at Gogoanime", " at GogoAnime", " - Gogoanime", " - GogoAnime"] {
        site_title = site_title.replace(postfix, "");
    }
    site_title = site_title.trim().to_string();

    Ok(SiteDiscoveryFeed {
        site_url: trimmed,
        site_title,
        releases,
    })
}

/// Just-In-Time stream URL resolver for playback.
#[tauri::command]
pub async fn resolve_web_stream_url(url: String) -> Result<String, String> {
    let trimmed = url.trim().to_string();
    info!(target: "stream", "resolve_web_stream_url requested for: {}", trimmed);

    // 1. YouTube direct stream resolution via local yt-dlp
    if trimmed.contains("youtube.com") || trimmed.contains("youtu.be") {
        info!(target: "stream", "Resolving YouTube watch URL via yt-dlp: {}", trimmed);
        if let Some(bin) = crate::commands::download::find_yt_dlp_binary() {
            if let Ok(output) = tokio_command(&bin)
                .arg("-g")
                .arg("-f")
                .arg("best[ext=mp4]/best")
                .arg(&trimmed)
                .output()
                .await
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(first_line) = stdout.lines().next() {
                        let stream = first_line.trim().to_string();
                        if stream.starts_with("http") {
                            info!(target: "stream", "YouTube resolved to direct stream: {}", stream);
                            return Ok(stream);
                        }
                    }
                } else {
                    warn!(target: "stream", "yt-dlp exited with non-zero status for YouTube URL: {}", trimmed);
                }
            }
        }
    }

    if is_direct_media_url(&trimmed) && !trimmed.contains("streamtape") && !trimmed.contains("moviebite") && !trimmed.contains("pornhub") {
        let lower = trimmed.to_lowercase();
        if !trimmed.starts_with("http://127.0.0.1") && (lower.contains("vidmoly") || lower.contains("saturn.") || lower.contains("jupiter.") || lower.contains("phncdn") || lower.contains(".m3u8")) {
            let referer = crate::commands::stream_proxy::infer_referer(&trimmed);
            if let Ok(proxied) = crate::commands::stream_proxy::get_stream_proxy_url(trimmed.clone(), Some(referer), None).await {
                return Ok(proxied);
            }
        }
        info!(target: "stream", "URL is already a direct media file: {}", trimmed);
        return Ok(trimmed);
    }

    // Fetch fresh info to bypass token expiration
    let info = fetch_web_stream_info(trimmed.clone()).await?;
    if let Some(stream) = info.direct_stream_url {
        info!(target: "stream", "Successfully resolved direct stream via provider '{}': {}", info.provider, stream);
        let lower = stream.to_lowercase();
        let orig_lower = trimmed.to_lowercase();
        if (stream.starts_with("http://") || stream.starts_with("https://"))
            && !stream.starts_with("http://127.0.0.1")
            && !stream.starts_with("cinextream://")
            && (
            lower.contains(".m3u8")
                || lower.contains("vidmoly")
                || lower.contains("saturn.")
                || lower.contains("jupiter.")
                || lower.contains("moviebite")
                || lower.contains("pornhub")
                || lower.contains("phncdn")
                || lower.contains("workers.dev")
                || lower.contains("dramahot")
                || lower.contains("bright")
                || lower.contains("nebula")
                || lower.contains("gogoanime")
                || lower.contains("ok.ru")
                || lower.contains("vkuser.net")
                || lower.contains("vk.com")
                || lower.contains("vk.ru")
                || lower.contains("vkvideo.ru")
                || lower.contains("dailymotion")
                || lower.contains("dmcdn.net")
                || lower.contains("bitchute")
                || lower.contains("odysee")
                || lower.contains("peertube")
                || lower.contains("tubi")
                || lower.contains("adrise.io")
                || orig_lower.contains("vidmoly")
                || orig_lower.contains("moviebite")
                || orig_lower.contains("baddieseast")
                || orig_lower.contains("brokensilenze")
                || orig_lower.contains("gogoanime")
                || orig_lower.contains("pornhub")
                || orig_lower.contains("yomi.to")
                || orig_lower.contains("ok.ru")
                || orig_lower.contains("vk.com")
                || orig_lower.contains("vk.ru")
                || orig_lower.contains("dailymotion")
                || orig_lower.contains("bitchute")
                || orig_lower.contains("odysee")
                || orig_lower.contains("peertube")
        ) {
            let referer = crate::commands::stream_proxy::infer_referer(&stream);
            if let Ok(proxied) = crate::commands::stream_proxy::get_stream_proxy_url(stream.clone(), Some(referer), None).await {
                info!(target: "stream", "Wrapped CDN stream in local stream proxy: {}", proxied);
                return Ok(proxied);
            }
        }
        Ok(stream)
    } else {
        warn!(target: "stream", "No direct stream extracted for {}; fallback to original URL", trimmed);
        Ok(trimmed)
    }
}

/// Search or browse live US radio stations via iHeartRadio
#[tauri::command]
pub async fn search_iheart_radio(query: Option<String>) -> Result<SiteDiscoveryFeed, String> {
    let client = build_client()?;
    let trimmed_q = query.as_deref().unwrap_or("").trim();
    let url = if !trimmed_q.is_empty() {
        format!("https://api.iheart.com/api/v2/content/liveStations?q={}&limit=30", trimmed_q)
    } else {
        "https://api.iheart.com/api/v2/content/liveStations?countryCode=US&limit=30".to_string()
    };

    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| format!("iHeart request failed: {}", e))?;

    let text = resp.text().await.map_err(|e| format!("Failed reading iHeart response: {}", e))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("iHeart JSON parsing failed: {}", e))?;
    let mut releases = Vec::new();
    if let Some(hits) = json["hits"].as_array() {
        for hit in hits {
            let name = hit["name"].as_str().unwrap_or("Station").to_string();
            let desc = hit["description"].as_str().unwrap_or("").to_string();
            let title = if desc.is_empty() { name } else { format!("{} · {}", name, desc) };
            let logo = hit["logo"].as_str().map(|s: &str| s.to_string());
            let stream_url = hit["streams"]["secure_shoutcast_stream"].as_str()
                .or_else(|| hit["streams"]["shoutcast_stream"].as_str())
                .or_else(|| hit["streams"]["secure_hls_stream"].as_str())
                .or_else(|| hit["streams"]["hls_stream"].as_str());

            if let Some(s_url) = stream_url {
                releases.push(DiscoveredRelease {
                    title,
                    post_url: s_url.to_string(),
                    thumbnail: logo,
                    date: None,
                    site_domain: "iheart.com".to_string(),
                    media_type: "music".to_string(),
                    season: None,
                    episode: None,
                });
            }
        }
    }

    Ok(SiteDiscoveryFeed {
        site_url: "https://www.iheart.com".to_string(),
        site_title: if !trimmed_q.is_empty() { format!("iHeartRadio: \"{}\"", trimmed_q) } else { "iHeartRadio Live Stations".to_string() },
        releases,
    })
}


/// Search songs and albums on JioSaavn
#[tauri::command]
pub async fn search_jiosaavn_streams(query: String) -> Result<SiteDiscoveryFeed, String> {
    let mut q = query.trim().to_string();
    if q.is_empty() {
        q = "trending".to_string();
    }

    let client = build_client()?;
    let resp = client
        .get("https://www.jiosaavn.com/api.php")
        .query(&[
            ("__call", "autocomplete.get"),
            ("_format", "json"),
            ("_marker", "0"),
            ("cc", "in"),
            ("includeMetaTags", "1"),
            ("query", &q),
        ])
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| format!("JioSaavn request failed: {}", e))?;

    let text = resp.text().await.map_err(|e| format!("Failed reading JioSaavn response: {}", e))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Failed parsing JioSaavn response: {}", e))?;
    let mut releases = Vec::new();

    // 1. Add Songs
    if let Some(songs) = json["songs"]["data"].as_array() {
        for s in songs {
            let title = s["title"].as_str().unwrap_or("Song").to_string();
            let desc = s["description"].as_str().unwrap_or("").to_string();
            let song_url = s["url"].as_str().unwrap_or("").to_string();
            if song_url.is_empty() { continue; }
            let img = s["image"].as_str().map(|img_url: &str| img_url.replace("50x50", "500x500"));

            releases.push(DiscoveredRelease {
                title: if desc.is_empty() { title } else { format!("{} · {}", title, desc) },
                post_url: song_url,
                thumbnail: img,
                date: None,
                site_domain: "jiosaavn.com".to_string(),
                media_type: "music".to_string(),
                season: None,
                episode: None,
            });
        }
    }

    // 2. Add Albums
    if let Some(albums) = json["albums"]["data"].as_array() {
        for a in albums {
            let title = a["title"].as_str().unwrap_or("Album").to_string();
            let desc = a["description"].as_str().unwrap_or("").to_string();
            let album_url = a["url"].as_str().unwrap_or("").to_string();
            if album_url.is_empty() { continue; }
            let img = a["image"].as_str().map(|img_url: &str| img_url.replace("50x50", "500x500"));

            releases.push(DiscoveredRelease {
                title: format!("💿 Album: {} ({})", title, desc),
                post_url: album_url,
                thumbnail: img,
                date: None,
                site_domain: "jiosaavn.com".to_string(),
                media_type: "music".to_string(),
                season: None,
                episode: None,
            });
        }
    }

    Ok(SiteDiscoveryFeed {
        site_url: "https://www.jiosaavn.com".to_string(),
        site_title: if q == "trending" { "JioSaavn: Trending Songs & Albums".to_string() } else { format!("JioSaavn: \"{}\"", q) },
        releases,
    })
}

fn parse_streamed_matches(matches: &serde_json::Value, q_lower: &str) -> SiteDiscoveryFeed {
    let mut releases = Vec::new();

    if let Some(list) = matches.as_array() {
        for m in list {
            let title = m["title"].as_str().unwrap_or("Live Event").to_string();
            let category = m["category"].as_str().unwrap_or("sports").to_string();
            let id = m["id"].as_str().unwrap_or("");

            if !q_lower.is_empty() {
                if !title.to_lowercase().contains(q_lower) && !category.to_lowercase().contains(q_lower) {
                    continue;
                }
            }

            let poster = m["poster"].as_str().map(|p| {
                if p.starts_with("http") { p.to_string() } else { format!("https://streamed.pk{}", p) }
            });

            // Primary embed/watch URL
            let mut post_url = format!("https://streamed.pk/watch/{}", id);
            if let Some(sources) = m["sources"].as_array() {
                if let Some(first_source) = sources.first() {
                    if let (Some(s_name), Some(s_id)) = (first_source["source"].as_str(), first_source["id"].as_str()) {
                        post_url = format!("https://embed.st/embed/{}/{}/1", s_name, s_id);
                    }
                }
            }

            let date_str = m["date"].as_i64().map(|ms| ms.to_string());

            releases.push(DiscoveredRelease {
                title: format!("🏆 {} ({})", title, category.to_uppercase()),
                post_url,
                thumbnail: poster,
                date: date_str,
                site_domain: "streamed.pk".to_string(),
                media_type: "sports".to_string(),
                season: None,
                episode: None,
            });
        }
    }

    SiteDiscoveryFeed {
        site_url: "https://streamed.pk".to_string(),
        site_title: if !q_lower.is_empty() { format!("Streamed.pk: \"{}\"", q_lower) } else { "Streamed.pk Live Sports & PPV".to_string() },
        releases,
    }
}

/// Search or browse live sports events and PPV via streamed.pk API
#[tauri::command]
pub async fn search_streamed_sports(query: Option<String>) -> Result<SiteDiscoveryFeed, String> {
    let q_lower = query.as_deref().unwrap_or("").trim().to_lowercase();

    // 1. Check in-memory cache (< 5 minutes old)
    {
        if let Ok(guard) = SPORTS_CACHE.lock() {
            if let Some((ts, ref data)) = *guard {
                if ts.elapsed() < Duration::from_secs(300) {
                    info!(target: "stream", "Serving streamed.pk matches from memory cache (age: {:?})", ts.elapsed());
                    return Ok(parse_streamed_matches(data, &q_lower));
                }
            }
        }
    }

    // 2. Fetch fresh matches from API with 45s timeout to handle DDoS-Guard delays
    let sports_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Failed to create sports client: {}", e))?;

    let fetch_result = async {
        let resp = sports_client
            .get("https://streamed.pk/api/matches/all")
            .send()
            .await
            .map_err(|e| format!("Network error contacting sports API: {}", e))?;

        let text = resp.text().await.map_err(|e| format!("Failed reading sports response: {}", e))?;
        let matches: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Invalid sports JSON: {}", e))?;
        Ok::<serde_json::Value, String>(matches)
    }.await;

    match fetch_result {
        Ok(matches) => {
            if let Ok(mut guard) = SPORTS_CACHE.lock() {
                *guard = Some((Instant::now(), matches.clone()));
            }
            Ok(parse_streamed_matches(&matches, &q_lower))
        }
        Err(err) => {
            // If API failed or timed out, check if we have an existing cache to fall back to
            if let Ok(guard) = SPORTS_CACHE.lock() {
                if let Some((_, ref data)) = *guard {
                    warn!(target: "stream", "Sports API failed ({}), falling back to cached matches", err);
                    return Ok(parse_streamed_matches(data, &q_lower));
                }
            }
            Err(err)
        }
    }
}

/// Search shadow library books on LibGen (epubs, pdfs, mobi)
#[tauri::command]
pub async fn search_libgen_books(query: String) -> Result<SiteDiscoveryFeed, String> {
    let mut q = query.trim().to_string();
    if q.is_empty() {
        q = "bestseller".to_string();
    }

    let client = build_client()?;
    let url = format!(
        "https://libgen.is/search.php?req={}&lg_topic=libgen&open=0&view=simple&res=50&phrase=1&column=def",
        q.replace(' ', "+")
    );

    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| format!("Failed to contact LibGen: {}", e))?;

    let html = resp.text().await.map_err(|e| format!("Failed to read LibGen response: {}", e))?;
    let mut releases = Vec::new();

    let tr_re = Regex::new(r#"(?is)<tr\s+valign=["']top["'][^>]*>(.*?)</tr>"#).unwrap();
    let td_re = Regex::new(r#"(?is)<td[^>]*>(.*?)</td>"#).unwrap();
    let strip_tag_re = Regex::new(r#"<[^>]+>"#).unwrap();
    let link_re = Regex::new(r#"(?i)href=["']([^"']+)["']"#).unwrap();

    for tr_cap in tr_re.captures_iter(&html) {
        let tr_html = &tr_cap[1];
        let tds: Vec<&str> = td_re.captures_iter(tr_html).map(|c| c.get(1).unwrap().as_str()).collect();
        if tds.len() >= 10 {
            let author = strip_tag_re.replace_all(tds[1], "").trim().to_string();
            let raw_title = strip_tag_re.replace_all(tds[2], "").trim().to_string();
            let year = strip_tag_re.replace_all(tds[4], "").trim().to_string();
            let size = strip_tag_re.replace_all(tds[7], "").trim().to_string();
            let ext = strip_tag_re.replace_all(tds[8], "").trim().to_string().to_uppercase();

            let mirror_url = if let Some(m_cap) = link_re.captures(tds[9]) {
                m_cap.get(1).unwrap().as_str().to_string()
            } else {
                continue;
            };

            let title = format!("📖 {} - {} [{}] ({})", author, raw_title, ext, size);
            releases.push(DiscoveredRelease {
                title,
                post_url: mirror_url,
                thumbnail: None,
                date: if !year.is_empty() { Some(year) } else { None },
                site_domain: "libgen.is".to_string(),
                media_type: "books".to_string(),
                season: None,
                episode: None,
            });
        }
    }

    Ok(SiteDiscoveryFeed {
        site_url: "https://libgen.is".to_string(),
        site_title: if q == "bestseller" { "LibGen: Popular & Bestselling Books".to_string() } else { format!("LibGen: \"{}\"", q) },
        releases,
    })
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ComicIssuePagesPayload {
    pub title: String,
    pub series_title: Option<String>,
    pub issue_number: Option<u32>,
    pub pages: Vec<String>,
    pub next_issue_url: Option<String>,
    pub prev_issue_url: Option<String>,
}

async fn crawl_comics_portal(
    url_or_query: &str,
    client: &reqwest::Client,
) -> Result<SiteDiscoveryFeed, String> {
    // 1. If URL is a specific ReadComicsOnline series page (e.g. https://readcomicsonline.ru/comic/wolverine-2024)
    if url_or_query.contains("readcomicsonline") && (url_or_query.contains("/comic/") || url_or_query.contains("/manga/")) {
        if let Ok(resp) = client
            .get(url_or_query)
            .header("Referer", "https://readcomicsonline.ru/")
            .send()
            .await
        {
            if let Ok(body) = resp.text().await {
                if !body.contains("Just a moment...") && !body.contains("cf_chl_opt") {
                    let mut releases = Vec::new();
                    let title_re = Regex::new(r#"(?i)<title[^>]*>([^<]+)</title>"#).unwrap();
                    let series_title = title_re
                        .captures(&body)
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str().replace("Read ", "").replace(" Online", "").trim().to_string())
                        .unwrap_or_else(|| "Comic Series".to_string());

                    let cover_re = Regex::new(r#"(?i)<img[^>]+src=["']([^"']+/uploads/manga/[^"']+/cover/[^"']+)["']"#).unwrap();
                    let thumb = cover_re.captures(&body).and_then(|c| c.get(1)).map(|m| {
                        let s = m.as_str();
                        if s.starts_with("//") {
                            format!("https:{}", s)
                        } else if s.starts_with('/') {
                            format!("https://readcomicsonline.ru{}", s)
                        } else {
                            s.to_string()
                        }
                    });

                    let ch_re = Regex::new(
                        r#"(?is)<h5[^>]*class=["'][^"']*chapter-title-rtl[^"']*["'][^>]*>\s*<a[^>]+href=["'](https?://[^"']+/comic/[^"']+/(\d+(?:\.\d+)?))["'][^>]*>([^<]+)</a>"#,
                    )
                    .unwrap();

                    for cap in ch_re.captures_iter(&body) {
                        let post_url = cap.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
                        let ep_num = cap.get(2).and_then(|m| m.as_str().split('.').next()).and_then(|s| s.parse::<u32>().ok());
                        let ch_title = cap.get(3).map(|m| m.as_str().trim().to_string()).unwrap_or_else(|| series_title.clone());
                        if !post_url.is_empty() {
                            releases.push(DiscoveredRelease {
                                title: ch_title,
                                post_url,
                                thumbnail: thumb.clone(),
                                date: None,
                                site_domain: "readcomicsonline.ru".to_string(),
                                media_type: "comics".to_string(),
                                season: Some(1),
                                episode: ep_num,
                            });
                        }
                    }

                    if !releases.is_empty() {
                        releases.reverse(); // Issue #1 first
                        return Ok(SiteDiscoveryFeed {
                            site_url: url_or_query.to_string(),
                            site_title: series_title,
                            releases,
                        });
                    }
                }
            }
        }
    }

    // 2. If URL is a MangaDex series drilldown: mangadex://manga/{id} or https://mangadex.org/title/{id}
    if url_or_query.starts_with("mangadex://manga/") || url_or_query.contains("mangadex.org/title/") {
        let manga_id = url_or_query
            .trim_start_matches("mangadex://manga/")
            .split("mangadex.org/title/")
            .last()
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("")
            .trim();
        if !manga_id.is_empty() {
            let feed_url = format!(
                "https://api.mangadex.org/manga/{}/feed?translatedLanguage[]=en&order[chapter]=asc&limit=100",
                manga_id
            );
            let resp = client
                .get(&feed_url)
                .header("User-Agent", "RcloneFlix/1.0")
                .send()
                .await
                .map_err(|e| format!("MangaDex feed error: {}", e))?;
            let text = resp
                .text()
                .await
                .map_err(|e| format!("MangaDex feed error: {}", e))?;
            let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("MangaDex JSON error: {}", e))?;
            let mut releases = Vec::new();
            if let Some(arr) = json["data"].as_array() {
                for ch in arr {
                    let ch_id = ch["id"].as_str().unwrap_or_default();
                    let attrs = &ch["attributes"];
                    // Skip external-only chapters with 0 hosted pages
                    if attrs["pages"].as_u64().unwrap_or(0) == 0 {
                        continue;
                    }
                    let ch_num_str = attrs["chapter"].as_str().unwrap_or("1");
                    let ch_num = ch_num_str.split('.').next().and_then(|s| s.parse::<u32>().ok());
                    let ch_title = attrs["title"].as_str().unwrap_or("").trim();
                    let label = if ch_title.is_empty() {
                        format!("Issue #{}", ch_num_str)
                    } else {
                        format!("Issue #{} - {}", ch_num_str, ch_title)
                    };
                    releases.push(DiscoveredRelease {
                        title: label,
                        post_url: format!("https://mangadex.org/chapter/{}", ch_id),
                        thumbnail: None,
                        date: attrs["publishAt"].as_str().map(|s| s.chars().take(10).collect()),
                        site_domain: "mangadex.org".to_string(),
                        media_type: "comics".to_string(),
                        season: Some(1),
                        episode: ch_num,
                    });
                }
            }
            return Ok(SiteDiscoveryFeed {
                site_url: url_or_query.to_string(),
                site_title: "Comic Issues & Chapters".to_string(),
                releases,
            });
        }
    }

    // Extract search query if present in URL, otherwise browse popular comics
    let extracted_q = if let Some(idx) = url_or_query.find("query=") {
        Some(url_or_query[idx + 6..].split('&').next().unwrap_or("").replace('+', " "))
    } else if let Some(idx) = url_or_query.find("?s=") {
        Some(url_or_query[idx + 3..].split('&').next().unwrap_or("").replace('+', " "))
    } else {
        None
    };

    search_comics_portal(extracted_q).await
}

/// Searches across ReadComicsOnline (when accessible), Archive.org Comic Book Streams (.cbz),
/// and MangaDex Public API so the Comics Portal always returns rich, immediately streamable comics.
#[tauri::command]
pub async fn search_comics_portal(query: Option<String>) -> Result<SiteDiscoveryFeed, String> {
    let client = build_client()?;
    let clean_q = query.unwrap_or_default().trim().to_string();
    let mut releases = Vec::new();

    // 1. Try ReadComicsOnline JSON autocomplete search (`https://readcomicsonline.ru/search?query=...`)
    if !clean_q.is_empty() {
        let enc_q = percent_encoding::utf8_percent_encode(&clean_q, percent_encoding::NON_ALPHANUMERIC).to_string();
        let rco_url = format!(
            "https://readcomicsonline.ru/search?query={}",
            enc_q
        );
        if let Ok(resp) = client
            .get(&rco_url)
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Referer", "https://readcomicsonline.ru/")
            .send()
            .await
        {
            if let Ok(text) = resp.text().await {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(suggestions) = json["suggestions"].as_array() {
                        for item in suggestions {
                            let title = item["value"].as_str().unwrap_or_default().trim().to_string();
                            let slug = item["data"].as_str().unwrap_or_default().trim();
                            if !title.is_empty() && !slug.is_empty() {
                                releases.push(DiscoveredRelease {
                                    title,
                                    post_url: format!("https://readcomicsonline.ru/comic/{}", slug),
                                    thumbnail: Some(format!(
                                        "https://readcomicsonline.ru/uploads/manga/{}/cover/cover_250x350.jpg",
                                        slug
                                    )),
                                    date: None,
                                    site_domain: "readcomicsonline.ru".to_string(),
                                    media_type: "comic_series".to_string(),
                                    season: None,
                                    episode: None,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Query Internet Archive Direct CBZ Comics (Marvel, DC, Indie, Manga, Golden Age)
    let ia_term = if clean_q.is_empty() {
        "subject:(comics OR \"comic book\" OR marvel OR dc) AND format:(Comic Book ZIP)"
            .to_string()
    } else {
        format!(
            "title:({}) AND mediatype:texts AND (format:\"Comic Book ZIP\" OR subject:comics)",
            clean_q
        )
    };
    let enc_ia = percent_encoding::utf8_percent_encode(&ia_term, percent_encoding::NON_ALPHANUMERIC).to_string();
    let ia_sort = if clean_q.is_empty() { "publicdate+desc" } else { "downloads+desc" };
    let ia_url = format!(
        "https://archive.org/advancedsearch.php?q={}&fl[]=identifier,title,year&sort[]={}&rows=24&output=json",
        enc_ia, ia_sort
    );

    if let Ok(resp) = client.get(&ia_url).send().await {
        if let Ok(text) = resp.text().await {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(docs) = json["response"]["docs"].as_array() {
                    for doc in docs {
                        let id = doc["identifier"].as_str().unwrap_or_default();
                        let title = doc["title"]
                            .as_str()
                            .or_else(|| doc["title"].as_array().and_then(|a| a.first()).and_then(|v| v.as_str()))
                            .unwrap_or(id)
                            .to_string();
                        let year = doc["year"]
                            .as_u64()
                            .map(|y| y.to_string())
                            .or_else(|| doc["year"].as_str().map(|s| s.to_string()));
                        if !id.is_empty() {
                            releases.push(DiscoveredRelease {
                                title,
                                post_url: format!("https://archive.org/details/{}", id),
                                thumbnail: Some(format!("https://archive.org/services/img/{}", id)),
                                date: year,
                                site_domain: "archive.org".to_string(),
                                media_type: "comic_series".to_string(),
                                season: None,
                                episode: None,
                            });
                        }
                    }
                }
            }
        }
    }

    // 3. Query MangaDex Public API for Comics & Manga series
    let enc_md_q = percent_encoding::utf8_percent_encode(&clean_q, percent_encoding::NON_ALPHANUMERIC).to_string();
    let md_url = if clean_q.is_empty() {
        "https://api.mangadex.org/manga?limit=20&includes[]=cover_art&order[latestUploadedChapter]=desc&contentRating[]=safe&contentRating[]=suggestive".to_string()
    } else {
        format!(
            "https://api.mangadex.org/manga?title={}&limit=20&includes[]=cover_art&order[relevance]=desc",
            enc_md_q
        )
    };

    if let Ok(resp) = client
        .get(&md_url)
        .header("User-Agent", "RcloneFlix/1.0")
        .send()
        .await
    {
        if let Ok(text) = resp.text().await {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(data) = json["data"].as_array() {
                    for item in data {
                        let id = item["id"].as_str().unwrap_or_default();
                        let title_obj = &item["attributes"]["title"];
                        let title = title_obj["en"]
                            .as_str()
                            .or_else(|| title_obj.as_object().and_then(|o| o.values().next()).and_then(|v| v.as_str()))
                            .unwrap_or("Untitled Comic")
                            .to_string();
                        let year = item["attributes"]["year"].as_u64().map(|y| y.to_string());

                        let mut cover_file: Option<String> = None;
                        if let Some(rels) = item["relationships"].as_array() {
                            for rel in rels {
                                if rel["type"].as_str() == Some("cover_art") {
                                    cover_file = rel["attributes"]["fileName"].as_str().map(|s| s.to_string());
                                    break;
                                }
                            }
                        }
                        let thumbnail = cover_file.map(|cf| {
                            format!("https://uploads.mangadex.org/covers/{}/{}.256.jpg", id, cf)
                        });

                        if !id.is_empty() {
                            releases.push(DiscoveredRelease {
                                title,
                                post_url: format!("https://mangadex.org/title/{}", id),
                                thumbnail,
                                date: year,
                                site_domain: "mangadex.org".to_string(),
                                media_type: "comic_series".to_string(),
                                season: None,
                                episode: None,
                            });
                        }
                    }
                }
            }
        }
    }

    let site_title = if clean_q.is_empty() {
        "Comics Portal — Popular Series & Issues".to_string()
    } else {
        format!("Comics Portal — Results for \"{}\"", clean_q)
    };

    Ok(SiteDiscoveryFeed {
        site_url: "https://readcomicsonline.ru".to_string(),
        site_title,
        releases,
    })
}

/// Resolves direct page image URLs for an online comic issue (ReadComicsOnline or MangaDex)
/// so `ComicReaderPage` can stream every page immediately with zero archive download.
#[tauri::command]
pub async fn extract_comic_issue_pages(url: String) -> Result<ComicIssuePagesPayload, String> {
    let client = build_client()?;
    let trimmed = url.trim();

    // 1. MangaDex Chapter URL: https://mangadex.org/chapter/{chapterId}
    if trimmed.contains("mangadex.org/chapter/") || trimmed.starts_with("mangadex://chapter/") {
        let chapter_id = trimmed
            .trim_start_matches("mangadex://chapter/")
            .split("mangadex.org/chapter/")
            .last()
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("")
            .trim();
        let at_home_url = format!("https://api.mangadex.org/at-home/server/{}", chapter_id);
        let resp = client
            .get(&at_home_url)
            .header("User-Agent", "RcloneFlix/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed contacting MangaDex server: {}", e))?;
        let text = resp
            .text()
            .await
            .map_err(|e| format!("Invalid MangaDex text response: {}", e))?;
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid MangaDex response: {}", e))?;

        let base_url = json["baseUrl"].as_str().unwrap_or("https://uploads.mangadex.org");
        let hash = json["chapter"]["hash"].as_str().unwrap_or_default();
        let mut pages = Vec::new();
        if let Some(arr) = json["chapter"]["data"].as_array() {
            for f in arr {
                if let Some(fname) = f.as_str() {
                    pages.push(format!("{}/data/{}/{}", base_url, hash, fname));
                }
            }
        }
        if pages.is_empty() {
            return Err("No pages returned for MangaDex chapter".to_string());
        }
        return Ok(ComicIssuePagesPayload {
            title: "Comic Issue".to_string(),
            series_title: None,
            issue_number: None,
            pages,
            next_issue_url: None,
            prev_issue_url: None,
        });
    }

    // 2. ReadComicsOnline Issue URL: https://readcomicsonline.ru/comic/{slug}/{issue}
    let resp = client
        .get(trimmed)
        .header("Referer", "https://readcomicsonline.ru/")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch comic issue page: {}", e))?;

    let body = resp.text().await.map_err(|e| format!("Failed reading issue HTML: {}", e))?;
    if body.contains("Just a moment...") || body.contains("cf_chl_opt") {
        return Err("ReadComicsOnline is currently behind a Cloudflare challenge on this connection. Try selecting an Archive.org or MangaDex stream in the Comics Portal.".to_string());
    }

    let img_re = Regex::new(
        r#"(?i)<img[^>]+class=["'][^"']*img-responsive[^"']*["'][^>]+(?:data-src|src)=["']\s*([^"'\s]+)\s*["']"#,
    )
    .unwrap();

    let mut pages = Vec::new();
    for cap in img_re.captures_iter(&body) {
        if let Some(m) = cap.get(1) {
            let mut img_url = m.as_str().trim().to_string();
            if img_url.starts_with("//") {
                img_url = format!("https:{}", img_url);
            } else if img_url.starts_with('/') {
                img_url = format!("https://readcomicsonline.ru{}", img_url);
            }
            if img_url.starts_with("http") && !pages.contains(&img_url) {
                pages.push(img_url);
            }
        }
    }

    if pages.is_empty() {
        return Err("No comic page images found on page".to_string());
    }

    let title_re = Regex::new(r#"(?i)<title[^>]*>([^<]+)</title>"#).unwrap();
    let title = title_re
        .captures(&body)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_else(|| "Comic Issue".to_string());

    Ok(ComicIssuePagesPayload {
        title,
        series_title: None,
        issue_number: None,
        pages,
        next_issue_url: None,
        prev_issue_url: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_scraped_title_removes_release_tags() {
        let (title, year) = clean_scraped_title("Inception.2010.1080p.BluRay.x264.DTS-Moviebite.mp4");
        assert_eq!(title, "Inception");
        assert_eq!(year, Some(2010));

        let (title2, year2) = clean_scraped_title("Watch Oppenheimer (2023) Online Free | Streamtape");
        assert_eq!(title2, "Oppenheimer");
        assert_eq!(year2, Some(2023));
    }

    #[test]
    fn test_is_direct_media_url() {
        assert!(is_direct_media_url("https://example.com/video.mp4"));
        assert!(is_direct_media_url("https://example.com/live/master.m3u8?token=xyz"));
        assert!(!is_direct_media_url("https://streamtape.com/v/123456"));
    }

    #[test]
    fn test_detect_season_episode() {
        assert_eq!(detect_season_episode("Big Brother UK Season 4 Episode 2"), (Some(4), Some(2)));
        assert_eq!(detect_season_episode("Baddies USA Chapter 2 Episode 18"), (Some(2), Some(18)));
        assert_eq!(detect_season_episode("Severance.S02E05.1080p.mkv"), (Some(2), Some(5)));
        assert_eq!(detect_season_episode("Anime Title Ep 12"), (Some(1), Some(12)));
    }

    #[test]
    fn test_unpack_packed_js() {
        // Sample Dean Edwards packed JS: eval(function(p,a,c,k,e,d)...)
        let packed = r#"eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\b'+c.toString(a)+'\\b','g'),k[c]);return p}('0 1="2";',3,3,'var|stream|https'.split('|')))"#;
        let unpacked = unpack_packed_js(packed);
        assert!(unpacked.is_some());
        assert_eq!(unpacked.unwrap(), r#"var stream="https";"#);
    }

    #[test]
    fn test_parse_rss_feed() {
        let sample_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Sample Feed</title>
    <item>
      <title>Sample Show Season 1 Episode 3</title>
      <link>https://example.com/show-s1-e3/</link>
      <pubDate>Mon, 15 Sep 2026 00:00:00 GMT</pubDate>
      <description><![CDATA[<p>Watch Sample Show</p>]]></description>
    </item>
  </channel>
</rss>"#;
        let feed = parse_rss_feed(sample_xml, "https://example.com", "example.com");
        assert!(feed.is_some());
        let f = feed.unwrap();
        assert_eq!(f.releases.len(), 1);
        assert_eq!(f.releases[0].title, "Sample Show Season 1 Episode 3");
        assert_eq!(f.releases[0].season, Some(1));
        assert_eq!(f.releases[0].episode, Some(3));
        assert_eq!(f.releases[0].media_type, "tv");
    }

    #[tokio::test]
    async fn test_extract_yomi_resolves_clean_stream() {
        let client = build_client().unwrap();
        let res = extract_yomi("https://yomi.to/watch/from-old-country-bumpkin-to-master-swordsman-ii-194829/1", &client).await;
        assert!(res.is_ok(), "Failed to extract Yomi stream: {:?}", res.err());
        let info = res.unwrap();
        assert!(info.direct_stream_url.is_some());
        let stream = info.direct_stream_url.unwrap();
        assert!(
            stream.contains(".m3u8")
                || stream.contains("workers.dev")
                || stream.starts_with("cinextream://")
                || info.format.as_deref() == Some("m3u8")
        );
        assert_eq!(info.episode, Some(1));
    }

    #[tokio::test]
    async fn test_crawl_yomi_series_episodes() {
        let feed = crawl_website_releases("https://yomi.to/anime/that-time-i-got-reincarnated-as-a-slime-season-4-182205".to_string()).await;
        assert!(feed.is_ok(), "Failed to crawl Yomi series feed: {:?}", feed.err());
        let feed = feed.unwrap();
        assert!(!feed.releases.is_empty(), "Expected releases to not be empty");
        assert_eq!(feed.releases[0].media_type, "tv");
        assert_eq!(feed.releases[0].episode, Some(1));
        assert!(feed.releases.len() > 1, "Expected series to contain multiple episodes, got {}", feed.releases.len());
    }

    #[tokio::test]
    async fn test_crawl_gogoanime_category() {
        let feed = crawl_website_releases("https://www.gogoanime.is/category/attack-on-titan-final-season".to_string()).await;
        assert!(feed.is_ok(), "Failed to crawl GogoAnime feed: {:?}", feed.err());
        let feed = feed.unwrap();
        println!("Gogo feed title: {}, releases count: {}", feed.site_title, feed.releases.len());
        for r in feed.releases.iter().take(5) {
            println!("Release: title='{}', url='{}', ep={:?}", r.title, r.post_url, r.episode);
        }
        assert!(!feed.releases.is_empty());
        assert_eq!(feed.releases.len(), 16);
        assert_eq!(feed.releases[0].episode, Some(1));
        assert_eq!(feed.releases[0].post_url, "https://www.gogoanime.is/attack-on-titan-final-season-episode-1");
        assert!(!feed.releases[0].title.contains("at Gogoanime"));
        assert_eq!(feed.site_title, "Attack on Titan: Final Season");
    }

    #[tokio::test]
    async fn test_crawl_gogoanime_dub_category() {
        let feed = crawl_website_releases("https://www.gogoanime.is/category/attack-on-titan-dub".to_string()).await;
        assert!(feed.is_ok(), "Failed to crawl GogoAnime dub feed: {:?}", feed.err());
        let feed = feed.unwrap();
        assert_eq!(feed.releases.len(), 25);
        assert_eq!(feed.releases[0].episode, Some(1));
        assert_eq!(feed.releases[0].post_url, "https://www.gogoanime.is/attack-on-titan-dub-episode-1");
        assert!(feed.releases[0].title.contains("(Dub)"));
        assert!(!feed.releases[0].title.contains("at Gogoanime"));
    }

    #[tokio::test]
    async fn test_crawl_baddieseast_search() {
        let feed = crawl_website_releases("https://baddieseast.com.co/search/midwest".to_string()).await;
        match feed {
            Ok(feed) => {
                assert!(!feed.releases.is_empty(), "Expected BaddiesEast releases");
                let first = &feed.releases[0];
                assert!(first.post_url.starts_with("https://baddieseast.com.co"));
                assert!(!first.title.is_empty());
                assert!(first.thumbnail.is_some());
            }
            Err(e) => {
                eprintln!("BaddiesEast site unavailable during test run (skipping live assertion): {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_crawl_brokensilenze_search() {
        let feed = crawl_website_releases("https://brokensilenze.net/?s=baddies".to_string()).await;
        assert!(feed.is_ok(), "Failed to crawl BrokenSilenze search: {:?}", feed.err());
        let feed = feed.unwrap();
        assert!(!feed.releases.is_empty(), "Expected BrokenSilenze releases");
        let first = &feed.releases[0];
        assert!(first.post_url.starts_with("https://www.brokensilenze.net") || first.post_url.starts_with("https://brokensilenze.net"));
        assert!(!first.title.is_empty());
        assert!(!first.title.contains("&#8211;"));
        assert!(!first.title.contains("&#038;"));
        assert_eq!(first.media_type, "tv");
    }

    #[tokio::test]
    async fn test_crawl_direct_media_url() {
        let url = "https://2-cdn2-ovh-fra.energycdn.com/cdn3sto/gentlefox-sto/6535142a256340.93204596/488232756/1789669824/e53df4d9b0980cf3b5061c0d4c211faa385fc31b/85293736e86348ec00cddd19651775c309136bd3ed6a74c08c2ee393d84060cb/Sword%20Art%20Online%20-%20S01E01%20-%20The%20World%20Of%20Swords.mkv";
        let feed = crawl_website_releases(url.to_string()).await;
        assert!(feed.is_ok(), "Failed direct media crawl: {:?}", feed.err());
        let feed = feed.unwrap();
        assert_eq!(feed.releases.len(), 1);
        let first = &feed.releases[0];
        assert_eq!(first.post_url, url);
        assert_eq!(first.season, Some(1));
        assert_eq!(first.episode, Some(1));
        assert_eq!(first.media_type, "tv");
        assert!(first.title.contains("Sword Art Online"));
    }

    #[tokio::test]
    async fn test_search_iheart_radio() {
        let feed = search_iheart_radio(None).await;
        match feed {
            Ok(feed) => {
                assert!(!feed.releases.is_empty(), "Expected iHeart releases");
                let first = &feed.releases[0];
                assert!(!first.title.is_empty());
                assert!(first.post_url.starts_with("http"));
                assert_eq!(first.media_type, "music");
                assert_eq!(first.site_domain, "iheart.com");
            }
            Err(e) => {
                eprintln!("iHeart API error during test run: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_resolve_moviebite_stream() {
        let res = fetch_web_stream_info("https://moviebite.org/watch/movie/550".to_string()).await;
        match res {
            Ok(info) => {
                assert!(info.direct_stream_url.is_some(), "Expected direct stream URL from MovieBite");
                let stream_url = info.direct_stream_url.unwrap();
                assert!(!stream_url.contains("cdn-proxy"), "Mirror selection must reject broken cdn-proxy");
                assert!(stream_url.starts_with("http"));
                assert!(info.provider.starts_with("MovieBite"));
            }
            Err(e) => {
                eprintln!("MovieBite live API unavailable or rate limited: {}", e);
            }
        }
    }
}

