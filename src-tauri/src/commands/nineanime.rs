//! 9anime.co.ke resolver — replacement for the dead yomi.to / cinextream path.
//!
//! Verified live on 2026-11-26 (see plan §8d "Spike findings"):
//!   watch page  -> `<button class="server-btn" data-token="B64URL({"u":embed,"e":exp,"s":sig})">`
//!   embed (A)   -> Dean-Edwards packed JWPlayer page whose `file` is a direct MP4 (no Referer needed)
//!   embed (B)   -> wrapper page with an <iframe> to MegaPlay -> `stream/getSources?id=<data-id>`
//!                  -> JSON `{enc: B64URL(AES-256-CBC)}` -> `{"file": ".../master.m3u8"}` (needs Referer = MegaPlay origin)
//! Tokens expire after ~10 minutes, so everything is resolved at play time and nothing is persisted.

use base64::Engine;
use regex::Regex;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use super::stream_ingest::{DiscoveredRelease, SiteDiscoveryFeed, WebStreamInfo};

const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const DEFAULT_ORIGIN: &str = "https://9anime.co.ke";
/// Defaults taken from megaplay's `e1-player.min.js`. They are re-read from the live player JS if decryption fails.
const MEGAPLAY_KEY_DEFAULT: &str = "i?LMTAx0Q6,:}50U";
const MEGAPLAY_IV_DEFAULT: &str = "W0;27ToaUpl_P%'c";

// ───────────────────────── referer registry (used by stream_proxy::infer_referer) ─────────────────────────

static STREAM_REFERERS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn register_referer(stream_url: &str, referer: &str) {
    if let Ok(u) = reqwest::Url::parse(stream_url) {
        if let Some(h) = u.host_str() {
            let m = STREAM_REFERERS.get_or_init(|| Mutex::new(HashMap::new()));
            if let Ok(mut g) = m.lock() {
                g.insert(h.to_lowercase(), referer.to_string());
            }
        }
    }
}

/// Referer that must accompany `url` (set when a 9anime/MegaPlay stream was resolved this session).
pub fn referer_for(url: &str) -> Option<String> {
    let host = reqwest::Url::parse(url).ok()?.host_str()?.to_lowercase();
    STREAM_REFERERS.get()?.lock().ok()?.get(&host).cloned()
}

// ───────────────────────── small helpers ─────────────────────────

pub fn is_nineanime_url(u: &str) -> bool {
    u.to_lowercase().contains("9anime.")
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent(UA)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

fn origin_of(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{}://{}:{}", u.scheme(), h, p),
            (Some(h), None) => format!("{}://{}", u.scheme(), h),
            _ => DEFAULT_ORIGIN.to_string(),
        },
        Err(_) => DEFAULT_ORIGIN.to_string(),
    }
}

async fn get_text(
    client: &reqwest::Client,
    url: &str,
    referer: Option<&str>,
    extra: &[(&str, &str)],
) -> Result<(String, String), String> {
    let mut req = client.get(url);
    if let Some(r) = referer {
        req = req.header("Referer", r);
    }
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    let resp = req.send().await.map_err(|e| format!("request failed ({url}): {e}"))?;
    let final_url = resp.url().to_string();
    if !resp.status().is_success() {
        return Err(format!("HTTP {} for {}", resp.status(), url));
    }
    let body = resp.text().await.map_err(|e| format!("read failed ({url}): {e}"))?;
    Ok((body, final_url))
}

fn b64url_decode(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s.trim().trim_end_matches('='))
        .map_err(|e| format!("base64url decode failed: {e}"))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn title_from_slug(slug: &str) -> String {
    let s = slug.trim_end_matches("-dub");
    s.split('-')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ───────────────────────── parsing (pure, unit-tested) ─────────────────────────

fn packer_encode(mut n: usize, radix: usize) -> String {
    let mut parts: Vec<char> = Vec::new();
    loop {
        let d = n % radix;
        parts.push(if d > 35 {
            char::from_u32((d + 29) as u32).unwrap_or('?')
        } else {
            std::char::from_digit(d as u32, 36).unwrap_or('?')
        });
        if n < radix {
            break;
        }
        n /= radix;
    }
    parts.iter().rev().collect()
}

/// Un-packs Dean Edwards "p,a,c,k,e,d" JavaScript (used by the 9anime JWPlayer embed).
pub fn unpack_packer(html: &str) -> Option<String> {
    let re = Regex::new(r"(?s)\}\('(.*)',(\d+),(\d+),'([^']*)'\.split\('\|'\)").ok()?;
    let cap = re.captures(html)?;
    let payload = cap.get(1)?.as_str();
    let radix: usize = cap.get(2)?.as_str().parse().ok()?;
    let count: usize = cap.get(3)?.as_str().parse().ok()?;
    if radix < 2 {
        return None;
    }
    let words: Vec<&str> = cap.get(4)?.as_str().split('|').collect();
    let mut dict: HashMap<String, String> = HashMap::with_capacity(count);
    for i in 0..count {
        let key = packer_encode(i, radix);
        let val = match words.get(i) {
            Some(w) if !w.is_empty() => (*w).to_string(),
            _ => key.clone(),
        };
        dict.insert(key, val);
    }
    let word_re = Regex::new(r"\b\w+\b").ok()?;
    let out = word_re.replace_all(payload, |c: &regex::Captures| {
        dict.get(&c[0]).cloned().unwrap_or_else(|| c[0].to_string())
    });
    Some(out.replace("\\/", "/").replace("\\'", "'"))
}

/// All `<button class="server-btn …" data-token="…">` tokens as `(locked, token)`.
pub fn parse_server_tokens(html: &str) -> Vec<(bool, String)> {
    let tag_re = Regex::new(r#"(?is)<button\b[^>]*>"#).unwrap();
    let class_re = Regex::new(r#"(?is)\bclass\s*=\s*"([^"]*)""#).unwrap();
    let tok_re = Regex::new(r#"(?is)\bdata-token\s*=\s*"([^"]+)""#).unwrap();
    let mut out = Vec::new();
    for m in tag_re.find_iter(html) {
        let tag = m.as_str();
        let class = class_re.captures(tag).map(|c| c[1].to_string()).unwrap_or_default();
        if !class.contains("server-btn") {
            continue;
        }
        if let Some(t) = tok_re.captures(tag) {
            out.push((class.contains("locked"), t[1].to_string()));
        }
    }
    out
}

/// `(embed_url, expiry_epoch_secs)` from a server token.
pub fn decode_embed_token(token: &str) -> Option<(String, i64)> {
    let bytes = b64url_decode(token).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let u = v.get("u")?.as_str()?.to_string();
    let e = v.get("e").and_then(|x| x.as_i64()).unwrap_or(0);
    Some((u, e))
}

/// First plausible media URL in (un-packed) player JS: `file: "https://…"`, skipping subtitles/thumbnails.
pub fn find_player_file(js: &str) -> Option<String> {
    let re = Regex::new(r#"(?i)['"]?file['"]?\s*:\s*['"](https?://[^'"\s\\]+)['"]"#).ok()?;
    for c in re.captures_iter(js) {
        let u = c[1].to_string();
        let l = u.to_lowercase();
        if [".vtt", ".srt", ".ass", ".jpg", ".jpeg", ".png", ".webp"].iter().any(|x| l.contains(x)) {
            continue;
        }
        return Some(u);
    }
    let any = Regex::new(r#"(?i)https?://[^'"\s\\<>]+\.(?:m3u8|mp4)[^'"\s\\<>]*"#).ok()?;
    any.find(js).map(|m| m.as_str().to_string())
}

fn find_iframe_src(html: &str, base: &str) -> Option<String> {
    let re = Regex::new(r#"(?is)<iframe[^>]+src=["']([^"']+)["']"#).ok()?;
    let raw = re.captures(html)?[1].to_string();
    let base = reqwest::Url::parse(base).ok()?;
    base.join(&raw).ok().map(|u| u.to_string())
}

fn pad_bytes(s: &str, n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    let b = s.as_bytes();
    let k = b.len().min(n);
    v[..k].copy_from_slice(&b[..k]);
    v
}

/// Decrypts MegaPlay's `enc` payload (AES-256-CBC, zero-padded key/iv from the player JS) and returns `file`.
pub fn megaplay_decrypt(enc: &str, key: &str, iv: &str) -> Result<String, String> {
    use aes::cipher::{generic_array::GenericArray, BlockDecrypt, KeyInit};
    let raw = b64url_decode(enc)?;
    if raw.is_empty() || raw.len() % 16 != 0 {
        return Err("MegaPlay ciphertext length is not a multiple of 16".into());
    }
    let key_bytes = pad_bytes(key, 32);
    let iv_bytes = pad_bytes(iv, 16);
    let cipher = aes::Aes256::new(GenericArray::from_slice(&key_bytes));
    let mut prev = [0u8; 16];
    prev.copy_from_slice(&iv_bytes);
    let mut plain = Vec::with_capacity(raw.len());
    for chunk in raw.chunks_exact(16) {
        let mut block = GenericArray::clone_from_slice(chunk);
        cipher.decrypt_block(&mut block);
        for i in 0..16 {
            plain.push(block[i] ^ prev[i]);
        }
        prev.copy_from_slice(chunk);
    }
    let pad = *plain.last().ok_or("empty plaintext")? as usize;
    if pad == 0 || pad > 16 || plain.len() < pad || !plain[plain.len() - pad..].iter().all(|&b| b as usize == pad) {
        return Err("MegaPlay decrypt: bad padding (key/iv rotated?)".into());
    }
    plain.truncate(plain.len() - pad);
    let v: serde_json::Value =
        serde_json::from_slice(&plain).map_err(|e| format!("MegaPlay decrypt: payload is not JSON ({e})"))?;
    v.get("file")
        .and_then(|f| f.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "MegaPlay decrypt: no `file` in payload".to_string())
}

/// `(key, iv)` literals from MegaPlay's player script.
pub fn megaplay_keys_from_js(js: &str) -> Option<(String, String)> {
    let k = Regex::new(r#"SOURCE_ENC_KEY\s*=\s*"([^"]*)""#).ok()?.captures(js)?[1].to_string();
    let i = Regex::new(r#"SOURCE_ENC_IV\s*=\s*"([^"]*)""#).ok()?.captures(js)?[1].to_string();
    Some((k, i))
}

fn strip_season_suffix(s: &str) -> String {
    let a = Regex::new(r"(?i)\s+(?:season|part|cour)\s+\d+.*$").unwrap();
    let b = Regex::new(r"(?i)\s+\d+(?:st|nd|rd|th)\s+season.*$").unwrap();
    b.replace(&a.replace(s, ""), "").trim().to_string()
}

fn tokens_of(s: &str) -> HashSet<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_string())
        .collect()
}

/// Jaccard overlap between two titles (0.0 – 1.0).
pub fn title_overlap(a: &str, b: &str) -> f32 {
    let (ta, tb) = (tokens_of(a), tokens_of(b));
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    ta.intersection(&tb).count() as f32 / ta.union(&tb).count() as f32
}

// ───────────────────────── network: search ─────────────────────────

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub title: String,
    pub slug: String,
    pub kind: String,
    pub cover: Option<String>,
}

/// Returns the hits plus the origin that actually answered (follows 9anime domain-rotation redirects).
async fn search_titles(client: &reqwest::Client, origin: &str, q: &str) -> Result<(Vec<SearchHit>, String), String> {
    let mut u = reqwest::Url::parse(&format!("{origin}/api/search")).map_err(|e| e.to_string())?;
    u.query_pairs_mut().append_pair("q", q);
    let (body, final_url) = get_text(client, u.as_str(), Some(origin), &[("Accept", "application/json")]).await?;
    let active_origin = origin_of(&final_url);
    let origin = active_origin.as_str();
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("search JSON: {e}"))?;
    let mut out = Vec::new();
    if let Some(arr) = v.get("results").and_then(|r| r.as_array()) {
        for r in arr {
            let slug = r.get("slug").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if slug.is_empty() {
                continue;
            }
            out.push(SearchHit {
                title: r.get("title").and_then(|x| x.as_str()).unwrap_or(&slug).to_string(),
                slug,
                kind: r.get("type").and_then(|x| x.as_str()).unwrap_or("TV").to_string(),
                cover: r
                    .get("cover_image")
                    .and_then(|x| x.as_str())
                    .map(|c| if c.starts_with("http") { c.to_string() } else { format!("{origin}{c}") }),
            });
        }
    }
    Ok((out, active_origin.clone()))
}

// ───────────────────────── network: resolve one watch URL ─────────────────────────

struct Resolved {
    file: String,
    referer: Option<String>,
}

async fn resolve_megaplay(client: &reqwest::Client, iframe: &str, referer: &str) -> Result<Resolved, String> {
    let (html, _) = get_text(client, iframe, Some(referer), &[]).await?;
    let id = Regex::new(r#"data-id="(\d+)""#)
        .unwrap()
        .captures(&html)
        .map(|c| c[1].to_string())
        .ok_or("MegaPlay: no data-id on player page")?;
    let origin = origin_of(iframe);
    let api = format!("{origin}/stream/getSources?id={id}");
    let (body, _) = get_text(
        client,
        &api,
        Some(iframe),
        &[("X-Requested-With", "XMLHttpRequest"), ("Accept", "application/json")],
    )
    .await?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("MegaPlay JSON: {e}"))?;

    let file = if let Some(enc) = v.get("enc").and_then(|e| e.as_str()) {
        match megaplay_decrypt(enc, MEGAPLAY_KEY_DEFAULT, MEGAPLAY_IV_DEFAULT) {
            Ok(f) => f,
            Err(first) => {
                // Key rotated? Re-read it from the live player script and retry once.
                let js_url = Regex::new(r#"src="([^"]*e1-player[^"]*\.js[^"]*)""#)
                    .unwrap()
                    .captures(&html)
                    .and_then(|c| reqwest::Url::parse(iframe).ok()?.join(&c[1]).ok())
                    .map(|u| u.to_string())
                    .ok_or(first.clone())?;
                let (js, _) = get_text(client, &js_url, Some(iframe), &[]).await?;
                let (k, i) = megaplay_keys_from_js(&js).ok_or(first)?;
                megaplay_decrypt(enc, &k, &i)?
            }
        }
    } else if let Some(f) = v.pointer("/sources/file").and_then(|f| f.as_str()) {
        f.to_string()
    } else if let Some(f) = v.pointer("/sources/0/file").and_then(|f| f.as_str()) {
        f.to_string()
    } else {
        return Err(format!(
            "MegaPlay: no sources ({})",
            v.get("message").and_then(|m| m.as_str()).unwrap_or("unknown")
        ));
    };
    Ok(Resolved { file, referer: Some(format!("{origin}/")) })
}

async fn resolve_server(client: &reqwest::Client, watch_url: &str, token: &str) -> Result<Resolved, String> {
    let (embed_url, exp) = decode_embed_token(token).ok_or("undecodable server token")?;
    if exp > 0 && exp < now_secs() + 5 {
        return Err("server token expired".into());
    }
    let (body, embed_final) = get_text(client, &embed_url, Some(watch_url), &[]).await?;

    // (A) packed JWPlayer page → direct file
    let unpacked = if body.contains("p,a,c,k,e,d") { unpack_packer(&body).unwrap_or_default() } else { String::new() };
    if let Some(f) = find_player_file(&unpacked).or_else(|| find_player_file(&body)) {
        let referer = if f.to_lowercase().contains(".m3u8") { Some(format!("{}/", origin_of(&embed_final))) } else { None };
        return Ok(Resolved { file: f, referer });
    }
    // (B) wrapper → MegaPlay iframe
    if let Some(iframe) = find_iframe_src(&body, &embed_final) {
        if iframe.to_lowercase().contains("megaplay") {
            return resolve_megaplay(client, &iframe, &embed_final).await;
        }
    }
    Err("unknown embed layout".into())
}

/// Resolves `https://9anime.*/watch/<slug>-episode-<n>` to a playable stream URL.
pub async fn extract_nineanime(url: &str) -> Result<WebStreamInfo, String> {
    let cap = Regex::new(r"(?i)/watch/([^/?#]+?)-episode-(\d+)")
        .unwrap()
        .captures(url)
        .map(|c| (c[1].to_string(), c[2].parse::<u32>().unwrap_or(1)))
        .ok_or("Not a 9anime watch URL")?;
    let (slug, ep) = cap;
    let client = build_client()?;
    let (html, final_url) = get_text(&client, url, None, &[]).await?; // follows domain-rotation redirects

    let tokens: Vec<String> = parse_server_tokens(&html).into_iter().filter(|(locked, _)| !*locked).map(|(_, t)| t).collect();
    if tokens.is_empty() {
        return Err("9anime: no playable (non-VIP) server on this page".into());
    }
    let mut last_err = String::new();
    for tok in &tokens {
        match resolve_server(&client, &final_url, tok).await {
            Ok(r) => {
                if let Some(rf) = &r.referer {
                    register_referer(&r.file, rf);
                }
                let dub = slug.ends_with("-dub");
                let title = format!("{} Episode {}{}", title_from_slug(&slug), ep, if dub { " [Dub]" } else { "" });
                let is_hls = r.file.to_lowercase().contains(".m3u8");
                log::info!(target: "stream", "9anime resolved {} -> {}", url, r.file);
                return Ok(WebStreamInfo {
                    original_url: url.to_string(),
                    direct_stream_url: Some(r.file),
                    raw_title: title.clone(),
                    clean_title: title,
                    description: None,
                    poster_url: None,
                    provider: if dub { "9anime (English Dub)".into() } else { "9anime (Subtitled)".into() },
                    is_direct_media: false,
                    media_type: "tv".into(),
                    year: None,
                    format: Some(if is_hls { "m3u8" } else { "mp4" }.into()),
                    season: Some(1),
                    episode: Some(ep),
                });
            }
            Err(e) => {
                log::warn!(target: "stream", "9anime server failed: {e}");
                last_err = e;
            }
        }
    }
    Err(format!("9anime: all servers failed ({last_err})"))
}

/// Series page (`/anime/<slug>`) or search-style URL → episode-1 watch URL.
pub fn watch_url_for_series(url: &str) -> Option<String> {
    let slug = Regex::new(r"(?i)/anime/([^/?#]+)").unwrap().captures(url)?[1].to_string();
    Some(format!("{}/watch/{}-episode-1", origin_of(url), slug))
}

/// Used by `extract_yomi` when yomi.to / cinextream are unreachable: find the same show on 9anime.
pub async fn search_and_resolve_for_yomi(yomi_slug: &str, ep: u32, prefer_dub: bool) -> Result<WebStreamInfo, String> {
    let client = build_client()?;
    let words = yomi_slug.replace('-', " ");
    let mut queries = vec![words.clone()];
    let stripped = strip_season_suffix(&words);
    if !stripped.is_empty() && stripped != words {
        queries.push(stripped);
    }
    for q in queries {
        let (hits, origin) = match search_titles(&client, DEFAULT_ORIGIN, &q).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        let best = hits
            .iter()
            .filter(|h| !h.slug.ends_with("-dub"))
            .map(|h| (title_overlap(&words, &h.title), h))
            .filter(|(s, _)| *s >= 0.6)
            .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(_, h)| h.clone());
        let Some(best) = best else { continue };
        let dub_slug = format!("{}-dub", best.slug);
        let has_dub = hits.iter().any(|h| h.slug == dub_slug);
        let mut order: Vec<String> = Vec::new();
        if prefer_dub && has_dub {
            order.push(dub_slug.clone());
        }
        order.push(best.slug.clone());
        if !prefer_dub && has_dub {
            order.push(dub_slug);
        }
        let ep = if best.kind.eq_ignore_ascii_case("movie") { 1 } else { ep };
        for slug in order {
            let url = format!("{origin}/watch/{slug}-episode-{ep}");
            if let Ok(info) = extract_nineanime(&url).await {
                return Ok(info);
            }
        }
    }
    Err("9anime: no matching title found".into())
}

// ───────────────────────── discovery / crawl ─────────────────────────

fn release(origin: &str, title: String, post_url: String, thumb: Option<String>, media_type: &str, ep: Option<u32>) -> DiscoveredRelease {
    DiscoveredRelease {
        title,
        post_url,
        thumbnail: thumb,
        date: None,
        site_domain: reqwest::Url::parse(origin).ok().and_then(|u| u.host_str().map(|h| h.to_string())).unwrap_or_else(|| "9anime.co.ke".into()),
        media_type: media_type.to_string(),
        season: if ep.is_some() { Some(1) } else { None },
        episode: ep,
    }
}

pub async fn crawl_nineanime_feed(url: &str) -> Result<SiteDiscoveryFeed, String> {
    let client = build_client()?;
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
    let origin = origin_of(url);
    let path = parsed.path().to_string();

    // 1) Series or episode page → list every episode.
    let series_slug = Regex::new(r"(?i)/watch/([^/?#]+?)-episode-\d+")
        .unwrap()
        .captures(&path)
        .map(|c| c[1].to_string())
        .or_else(|| Regex::new(r"(?i)^/anime/([^/?#]+)").unwrap().captures(&path).map(|c| c[1].to_string()));
    if let Some(slug) = series_slug {
        let (html, final_url) = get_text(&client, url, None, &[]).await?;
        let origin = origin_of(&final_url);
        let link_re = Regex::new(&format!(r"/watch/{}-episode-(\d+)", regex::escape(&slug))).unwrap();
        let mut eps: BTreeSet<u32> = link_re.captures_iter(&html).filter_map(|c| c[1].parse().ok()).collect();
        if eps.is_empty() {
            eps.insert(1);
        }
        let title = title_from_slug(&slug);
        let releases = eps
            .iter()
            .map(|n| {
                release(
                    &origin,
                    format!("{title} - Episode {n}"),
                    format!("{origin}/watch/{slug}-episode-{n}"),
                    None,
                    "tv",
                    Some(*n),
                )
            })
            .collect();
        return Ok(SiteDiscoveryFeed { site_url: url.to_string(), site_title: title, releases });
    }

    // 2) Search (`?keyword=` / `?q=` / `?query=` / `?s=` or `/search/<q>`)
    let q = parsed
        .query_pairs()
        .find(|(k, _)| matches!(k.as_ref(), "keyword" | "q" | "query" | "s"))
        .map(|(_, v)| v.to_string())
        .or_else(|| path.strip_prefix("/search/").map(|s| s.to_string()))
        .unwrap_or_default();
    if !q.trim().is_empty() {
        let (hits, origin) = search_titles(&client, &origin, q.trim()).await?;
        let releases = hits
            .into_iter()
            .map(|h| {
                if h.kind.eq_ignore_ascii_case("movie") {
                    release(&origin, h.title, format!("{origin}/watch/{}-episode-1", h.slug), h.cover, "movies", None)
                } else {
                    release(&origin, h.title, format!("{origin}/anime/{}", h.slug), h.cover, "tv", None)
                }
            })
            .collect();
        return Ok(SiteDiscoveryFeed { site_url: url.to_string(), site_title: format!("9anime: \"{}\"", q.trim()), releases });
    }

    // 3) Home / browse → latest series as cards.
    let (html, final_url) = get_text(&client, url, None, &[]).await?;
    let origin = origin_of(&final_url);
    let re = Regex::new(r#"/watch/([a-z0-9][a-z0-9-]*?)-episode-\d+"#).unwrap();
    let mut seen = HashSet::new();
    let mut releases = Vec::new();
    for c in re.captures_iter(&html) {
        let slug = c[1].to_string();
        if seen.insert(slug.clone()) {
            releases.push(release(&origin, title_from_slug(&slug), format!("{origin}/anime/{slug}"), None, "tv", None));
        }
    }
    Ok(SiteDiscoveryFeed { site_url: url.to_string(), site_title: "9anime Latest".into(), releases })
}

// ───────────────────────── tests ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Real packed player page captured 2026-11-26 (trimmed to the <script> that matters).
    const PACKED: &str = r#"<script>eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c])}}return p}('1.2({3:[{4:[{\'5\':\'6\',\'7\':\'8\\/9\',\'a\':\'b://c.d.e/f/g.h-i\'}],"j":[{"k":"\\/l\\/m.n","o":"p"}]}]});',26,26,'|player|setup|playlist|sources|label|360p|type|video|mp4|file|https|dry|workers|dev|media|v1|4uNQ|key|tracks|kind|uploads|subs|vtt|default|true'.split('|'),0,{}))</script>"#;

    #[test]
    fn unpack_and_find_file() {
        let js = unpack_packer(PACKED).expect("unpack");
        let f = find_player_file(&js).expect("file");
        assert_eq!(f, "https://dry.workers.dev/media/v1.4uNQ-key");
    }

    #[test]
    fn find_file_skips_subtitles() {
        let js = r#"tracks:[{"file":"https://x.test/a.vtt"}],sources:[{'file':'https://y.test/v.mp4'}]"#;
        assert_eq!(find_player_file(js).as_deref(), Some("https://y.test/v.mp4"));
    }

    #[test]
    fn server_tokens_and_embed_token() {
        let tok = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"u":"https:\/\/secure.9anime.cx\/videos\/abc","e":1795720970,"s":"x"}"#);
        let html = format!(
            r#"<button class="server-btn active "
                data-token="{tok}" onclick="x">HD-1</button><button class="server-btn server-btn-locked" data-token="LOCKED">VIP</button><button class="other" data-token="no">"#
        );
        let t = parse_server_tokens(&html);
        assert_eq!(t.len(), 2);
        assert!(!t[0].0 && t[1].0);
        let (u, e) = decode_embed_token(&t[0].1).unwrap();
        assert_eq!(u, "https://secure.9anime.cx/videos/abc");
        assert_eq!(e, 1795720970);
    }

    // enc captured from megaplay.buzz getSources on 2026-11-26.
    const ENC: &str = include_str!("../../testdata/megaplay_enc.txt");

    #[test]
    fn megaplay_decrypts_real_payload() {
        let f = megaplay_decrypt(ENC.trim(), MEGAPLAY_KEY_DEFAULT, MEGAPLAY_IV_DEFAULT).unwrap();
        assert!(f.ends_with("/master.m3u8"), "{f}");
        assert!(megaplay_decrypt(ENC.trim(), "wrong-key", MEGAPLAY_IV_DEFAULT).is_err());
    }

    #[test]
    fn keys_from_js() {
        let js = r#"const SOURCE_ENC_KEY="i?LMTAx0Q6,:}50U",SOURCE_ENC_IV="W0;27ToaUpl_P%'c",CDN=1;"#;
        assert_eq!(
            megaplay_keys_from_js(js),
            Some((MEGAPLAY_KEY_DEFAULT.to_string(), MEGAPLAY_IV_DEFAULT.to_string()))
        );
    }

    #[test]
    fn title_matching() {
        assert_eq!(strip_season_suffix("that time i got reincarnated as a slime season 4"), "that time i got reincarnated as a slime");
        assert!(title_overlap("black clover season 2", "Black Clover Season 2") > 0.99);
        assert!(title_overlap("one piece", "One Piece Film Red") < 0.6);
        assert_eq!(title_from_slug("one-piece-dub"), "One Piece");
    }

    // ── live tests (network): cargo test -- --ignored nineanime ──
    #[tokio::test]
    #[ignore]
    async fn live_nineanime_mp4_path() {
        let info = extract_nineanime("https://9anime.co.ke/watch/black-clover-season-2-episode-9").await.unwrap();
        let u = info.direct_stream_url.unwrap();
        assert!(u.starts_with("https://"), "{u}");
    }

    #[tokio::test]
    #[ignore]
    async fn live_nineanime_megaplay_path() {
        let info = extract_nineanime("https://9anime.co.ke/watch/one-piece-dub-episode-1").await.unwrap();
        let u = info.direct_stream_url.unwrap();
        assert!(u.contains(".m3u8"), "{u}");
        assert_eq!(referer_for(&u).as_deref(), Some("https://megaplay.buzz/"));
    }

    #[tokio::test]
    #[ignore]
    async fn live_yomi_fallback_and_crawl() {
        let info = search_and_resolve_for_yomi("black-clover-season-2", 9, false).await.unwrap();
        assert!(info.direct_stream_url.is_some());
        let feed = crawl_nineanime_feed("https://9anime.co.ke/search?keyword=black%20clover").await.unwrap();
        assert!(!feed.releases.is_empty());
        let eps = crawl_nineanime_feed("https://9anime.co.ke/anime/black-clover-season-2").await.unwrap();
        assert!(eps.releases.len() >= 9, "{}", eps.releases.len());
        let home = crawl_nineanime_feed("https://9anime.co.ke/").await.unwrap();
        assert!(!home.releases.is_empty());
    }
}
