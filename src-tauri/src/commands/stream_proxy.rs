use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::OnceCell;

static PROXY_PORT: AtomicU16 = AtomicU16::new(0);
static PROXY_INIT: OnceCell<u16> = OnceCell::const_new();

/// Infers the required Referer header for CDNs that restrict playback by referrer domain.
pub fn infer_referer(target_url: &str) -> String {
    let lower = target_url.to_lowercase();
    if lower.contains("vidmoly") || lower.contains("vmpx.online") {
        "https://vidmoly.biz/".to_string()
    } else if lower.contains("saturn.") || lower.contains("jupiter.") || lower.contains("moviebite") || lower.contains("tnmr.org") || lower.contains("hakunaymatata") || lower.contains("bright67") {
        "https://moviebite.org/".to_string()
    } else if lower.contains("pornhub") || lower.contains("phncdn") {
        "https://www.pornhub.com/".to_string()
    } else if lower.contains("cinextream") || lower.contains("workers.dev") || lower.contains("dramahot") || lower.contains("drama1") {
        "https://cinextream.cc/".to_string()
    } else if lower.contains("vidara.to") || lower.contains("gosbagotui.com") {
        "https://vidara.to/".to_string()
    } else if lower.contains("ok.ru") || lower.contains("vkuser.net") || lower.contains("okcdn.ru") {
        "https://ok.ru/".to_string()
    } else if lower.contains("vk.com") || lower.contains("vk.ru") || lower.contains("vkvideo.ru") {
        "https://vk.com/".to_string()
    } else if lower.contains("dailymotion") || lower.contains("dmcdn.net") {
        "https://www.dailymotion.com/".to_string()
    } else if lower.contains("bitchute") {
        "https://www.bitchute.com/".to_string()
    } else if lower.contains("odysee") || lower.contains("lbry") {
        "https://odysee.com/".to_string()
    } else if lower.contains("tubi") || lower.contains("adrise.io") {
        "https://tubitv.com/".to_string()
    } else if let Ok(parsed) = reqwest::Url::parse(target_url) {
        if let Some(host) = parsed.host_str() {
            let scheme = parsed.scheme();
            format!("{}://{}/", scheme, host)
        } else {
            "https://google.com/".to_string()
        }
    } else {
        "https://google.com/".to_string()
    }
}

/// Infers the matching Origin header (without trailing slash) for CDNs enforcing origin protection.
pub fn infer_origin(referer_or_url: &str) -> String {
    let lower = referer_or_url.to_lowercase();
    if lower.contains("vidmoly") || lower.contains("vmpx.online") {
        "https://vidmoly.biz".to_string()
    } else if lower.contains("saturn.") || lower.contains("jupiter.") || lower.contains("moviebite") || lower.contains("tnmr.org") || lower.contains("hakunaymatata") || lower.contains("bright67") {
        "https://moviebite.org".to_string()
    } else if lower.contains("pornhub") || lower.contains("phncdn") {
        "https://www.pornhub.com".to_string()
    } else if lower.contains("cinextream") || lower.contains("workers.dev") || lower.contains("dramahot") || lower.contains("drama1") {
        "https://cinextream.cc".to_string()
    } else if lower.contains("vidara.to") || lower.contains("gosbagotui.com") {
        "https://vidara.to".to_string()
    } else if lower.contains("ok.ru") || lower.contains("vkuser.net") || lower.contains("okcdn.ru") {
        "https://ok.ru".to_string()
    } else if lower.contains("vk.com") || lower.contains("vk.ru") || lower.contains("vkvideo.ru") {
        "https://vk.com".to_string()
    } else if lower.contains("dailymotion") || lower.contains("dmcdn.net") {
        "https://www.dailymotion.com".to_string()
    } else if lower.contains("bitchute") {
        "https://www.bitchute.com".to_string()
    } else if lower.contains("odysee") || lower.contains("lbry") {
        "https://odysee.com".to_string()
    } else if lower.contains("tubi") || lower.contains("adrise.io") {
        "https://tubitv.com".to_string()
    } else if let Ok(parsed) = reqwest::Url::parse(referer_or_url) {
        if let Some(host) = parsed.host_str() {
            let scheme = parsed.scheme();
            if let Some(port) = parsed.port() {
                format!("{}://{}:{}", scheme, host, port)
            } else {
                format!("{}://{}", scheme, host)
            }
        } else {
            referer_or_url.trim_end_matches('/').to_string()
        }
    } else {
        referer_or_url.trim_end_matches('/').to_string()
    }
}

pub fn url_encode(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len() * 3);
    for b in input.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(b as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", b));
            }
        }
    }
    encoded
}

/// Starts the local HTTP stream proxy server if it is not already running.
pub async fn get_or_start_proxy_server() -> Result<u16, String> {
    let port = *PROXY_INIT
        .get_or_init(|| async {
            let listener = match TcpListener::bind("127.0.0.1:8552").await {
                Ok(l) => l,
                Err(_) => match TcpListener::bind("127.0.0.1:0").await {
                    Ok(l) => l,
                    Err(e) => {
                        log::error!(target: "stream_proxy", "Failed to bind proxy listener: {}", e);
                        return 0;
                    }
                },
            };
            let local_port = match listener.local_addr() {
                Ok(addr) => addr.port(),
                Err(e) => {
                    log::error!(target: "stream_proxy", "Failed to get proxy local addr: {}", e);
                    return 0;
                }
            };
            PROXY_PORT.store(local_port, Ordering::SeqCst);
            log::info!(target: "stream_proxy", "Started DirectPlay WebStream Proxy on 127.0.0.1:{}", local_port);

            let http_client = Arc::new(
                reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::limited(10))
                    .danger_accept_invalid_certs(true)
                    .build()
                    .unwrap_or_default(),
            );

            tokio::spawn(async move {
                loop {
                    match listener.accept().await {
                        Ok((mut socket, _)) => {
                            let client = Arc::clone(&http_client);
                            let port_num = local_port;
                            tokio::spawn(async move {
                                let _ = handle_proxy_connection(&mut socket, client, port_num).await;
                            });
                        }
                        Err(e) => {
                            log::warn!(target: "stream_proxy", "Proxy listener accept error: {}", e);
                        }
                    }
                }
            });

            local_port
        })
        .await;

    if port == 0 {
        Err("Failed to initialize WebStream proxy server".to_string())
    } else {
        Ok(port)
    }
}

async fn handle_proxy_connection(
    socket: &mut tokio::net::TcpStream,
    client: Arc<reqwest::Client>,
    proxy_port: u16,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buf = vec![0u8; 8192];
    let n = socket.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }

    let request_str = String::from_utf8_lossy(&buf[..n]);
    let mut lines = request_str.lines();
    let request_line = match lines.next() {
        Some(l) => l,
        None => return Ok(()),
    };

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(());
    }
    let method = parts[0];
    let path = parts[1];

    if path.starts_with("/tg-stream/")
        || path.starts_with("/webdav")
        || path.starts_with("/dav/")
        || path == "/dav"
        || path.starts_with("/manifest")
        || path.starts_with("/rebuild-index")
        || path.starts_with("/register-entry")
    {
        return crate::commands::telegram::handle_telegram_http(
            socket,
            method,
            path,
            &request_str,
            &buf[..n],
        )
        .await;
    }

    // Handle CORS preflight OPTIONS requests immediately
    if method.eq_ignore_ascii_case("OPTIONS") {
        let resp = "HTTP/1.1 204 No Content\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
Access-Control-Allow-Headers: *\r\n\
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\n\
Access-Control-Max-Age: 86400\r\n\
Connection: close\r\n\r\n";
        socket.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    // Extract headers (e.g. Range) from client request
    let mut client_range = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let lower = line.to_lowercase();
        if lower.starts_with("range:") {
            if let Some(val) = line.split(':').nth(1) {
                client_range = Some(val.trim().to_string());
            }
        }
    }

    // Parse query params from /stream?url=...&referer=...
    let (target_url, custom_referer) = parse_proxy_query(path);
    let target_url = match target_url {
        Some(u) => u,
        None => {
            let not_found = "HTTP/1.1 400 Bad Request\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
Access-Control-Allow-Headers: *\r\n\
Content-Type: text/plain\r\n\
Connection: close\r\n\r\n\
Missing url parameter";
            socket.write_all(not_found.as_bytes()).await?;
            return Ok(());
        }
    };

    let referer = custom_referer.unwrap_or_else(|| infer_referer(&target_url));
    let origin = infer_origin(&referer);

    // Extract embedded username:password@ from URL (e.g. Easynews https://user:pass@members.easynews.com/dl/...)
    // so reqwest sends an explicit Authorization: Basic header on all hops.
    let mut clean_target_url = target_url.clone();
    let mut embedded_auth: Option<(String, Option<String>)> = None;
    if let Ok(mut parsed_url) = reqwest::Url::parse(&target_url) {
        if !parsed_url.username().is_empty() {
            let user = percent_encoding::percent_decode_str(parsed_url.username())
                .decode_utf8_lossy()
                .to_string();
            let pass = parsed_url.password().map(|p| {
                percent_encoding::percent_decode_str(p)
                    .decode_utf8_lossy()
                    .to_string()
            });
            embedded_auth = Some((user, pass));
            let _ = parsed_url.set_username("");
            let _ = parsed_url.set_password(None);
            clean_target_url = parsed_url.to_string();
        }
    }

    let is_m3u8_hint = clean_target_url.to_lowercase().contains(".m3u8") || path.starts_with("/playlist.m3u8");
    let mut req_builder = if method.eq_ignore_ascii_case("HEAD") && !is_m3u8_hint {
        client.head(&clean_target_url)
    } else {
        client.get(&clean_target_url)
    };

    if let Some((user, pass)) = embedded_auth {
        req_builder = req_builder.basic_auth(user, pass);
    }

    req_builder = req_builder
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        )
        .header("Referer", &referer)
        .header("Origin", &origin)
        .header("Accept", "*/*");

    if let Some(range) = client_range {
        req_builder = req_builder.header("Range", range);
    }

    let mut upstream_resp = match req_builder.send().await {
        Ok(resp) => resp,
        Err(e) => {
            log::warn!(target: "stream_proxy", "Upstream request failed for {}: {}", target_url, e);
            let err_resp = format!(
                "HTTP/1.1 502 Bad Gateway\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
Access-Control-Allow-Headers: *\r\n\
Content-Type: text/plain\r\n\
Connection: close\r\n\r\n\
Upstream error: {}",
                e
            );
            socket.write_all(err_resp.as_bytes()).await?;
            return Ok(());
        }
    };

    let status = upstream_resp.status();
    let headers = upstream_resp.headers().clone();

    let mut content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let is_m3u8 = target_url.contains(".m3u8")
        || path.contains(".m3u8")
        || content_type.contains("mpegurl")
        || content_type.contains("application/x-mpegurl")
        || content_type.contains("application/vnd.apple.mpegurl");

    if is_m3u8 && status.is_success() {
        // Read full playlist text and rewrite all segment and sub-playlist links to route through proxy
        let body = upstream_resp.text().await.unwrap_or_default();
        let rewritten = rewrite_m3u8_playlist(&body, &target_url, &referer, proxy_port);

        let header_str = format!(
            "HTTP/1.1 200 OK\r\n\
Content-Type: application/vnd.apple.mpegurl\r\n\
Content-Length: {}\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
Access-Control-Allow-Headers: *\r\n\
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\n\
Connection: close\r\n\r\n",
            rewritten.len()
        );

        socket.write_all(header_str.as_bytes()).await?;
        socket.write_all(rewritten.as_bytes()).await?;
    } else {
        // Stream media chunk / video bytes
        let lower_target = target_url.to_lowercase();
        let target_path = lower_target.split('?').next().unwrap_or(&lower_target);
        let lower_path = path.to_lowercase();
        if lower_path.contains("segment.ts")
            || target_path.ends_with(".ts")
            || target_path.contains(".ts.")
            || target_path.contains(".ts.jpg")
            || target_path.contains(".ts.png")
            || content_type.contains("video/mp2t")
            || content_type.contains("image/")
        {
            content_type = "video/mp2t".to_string();
        } else if lower_path.contains("segment.mp4")
            || target_path.contains(".mp4")
            || target_path.contains(".m4s")
            || content_type.contains("video/mp4")
        {
            content_type = "video/mp4".to_string();
        }

        let mut header_str = format!(
            "HTTP/1.1 {} {}\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
Access-Control-Allow-Headers: *\r\n\
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\n\
Accept-Ranges: bytes\r\n\
Content-Type: {}\r\n",
            status.as_u16(),
            status.canonical_reason().unwrap_or("OK"),
            content_type
        );

        if let Some(cl) = headers.get("content-length").and_then(|v| v.to_str().ok()) {
            header_str.push_str(&format!("Content-Length: {}\r\n", cl));
        }
        if let Some(cr) = headers.get("content-range").and_then(|v| v.to_str().ok()) {
            header_str.push_str(&format!("Content-Range: {}\r\n", cr));
        }

        header_str.push_str("Connection: close\r\n\r\n");
        socket.write_all(header_str.as_bytes()).await?;

        // Stream body chunks directly into socket
        while let Ok(Some(chunk)) = upstream_resp.chunk().await {
            if socket.write_all(&chunk).await.is_err() {
                break;
            }
        }
    }

    let _ = socket.flush().await;
    Ok(())
}

fn parse_proxy_query(path: &str) -> (Option<String>, Option<String>) {
    let dummy_url = format!("http://127.0.0.1{}", path);
    let parsed = match reqwest::Url::parse(&dummy_url) {
        Ok(u) => u,
        Err(_) => return (None, None),
    };

    let mut target_url = None;
    let mut custom_referer = None;

    for (k, v) in parsed.query_pairs() {
        if k == "url" {
            target_url = Some(v.into_owned());
        } else if k == "referer" {
            custom_referer = Some(v.into_owned());
        }
    }

    (target_url, custom_referer)
}

/// Rewrites an HLS M3U8 playlist so that every relative/absolute chunk, key, and initialization
/// segment passes through the local proxy with the matching Referer header.
fn rewrite_m3u8_playlist(
    content: &str,
    base_url: &str,
    referer: &str,
    proxy_port: u16,
) -> String {
    let base = match reqwest::Url::parse(base_url) {
        Ok(u) => u,
        Err(_) => return content.to_string(),
    };

    let mut out = String::with_capacity(content.len() + 1024);
    let mut last_was_stream_inf = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }

        if trimmed.starts_with("#EXT-X-KEY:")
            || trimmed.starts_with("#EXT-X-MAP:")
            || trimmed.starts_with("#EXT-X-MEDIA:")
            || trimmed.starts_with("#EXT-X-I-FRAME-STREAM-INF:")
        {
            // Rewrite URI="something" inside tag
            let mut rewritten_tag = trimmed.to_string();
            if let Some(uri_start) = trimmed.find("URI=\"") {
                let after = &trimmed[uri_start + 5..];
                if let Some(uri_end) = after.find('"') {
                    let raw_uri = &after[..uri_end];
                    if let Ok(resolved) = base.join(raw_uri) {
                        let endpoint = if resolved.as_str().to_lowercase().contains(".m3u8")
                            || trimmed.starts_with("#EXT-X-MEDIA:")
                            || trimmed.starts_with("#EXT-X-I-FRAME-STREAM-INF:")
                        {
                            "playlist.m3u8"
                        } else if resolved.as_str().contains(".m4s") || resolved.as_str().contains(".mp4") {
                            "segment.mp4"
                        } else {
                            "segment.ts"
                        };
                        let proxied = format!(
                            "http://127.0.0.1:{}/{}?url={}&referer={}",
                            proxy_port,
                            endpoint,
                            url_encode(resolved.as_str()),
                            url_encode(referer)
                        );
                        rewritten_tag = format!(
                            "{}URI=\"{}\"{}",
                            &trimmed[..uri_start],
                            proxied,
                            &after[uri_end + 1..]
                        );
                    }
                }
            }
            out.push_str(&rewritten_tag);
            out.push('\n');
        } else if trimmed.starts_with('#') {
            if trimmed.starts_with("#EXT-X-STREAM-INF:") {
                last_was_stream_inf = true;
            }
            out.push_str(trimmed);
            out.push('\n');
        } else {
            // Line is a media segment URL or child playlist URL
            if let Ok(resolved) = base.join(trimmed) {
                let resolved_str = resolved.as_str();
                let lower_resolved = resolved_str.to_lowercase();
                let endpoint = if last_was_stream_inf || lower_resolved.contains(".m3u8") {
                    "playlist.m3u8"
                } else if lower_resolved.contains(".mp4") || lower_resolved.contains(".m4s") {
                    "segment.mp4"
                } else {
                    "segment.ts"
                };
                last_was_stream_inf = false;
                let proxied_url = format!(
                    "http://127.0.0.1:{}/{}?url={}&referer={}",
                    proxy_port,
                    endpoint,
                    url_encode(resolved_str),
                    url_encode(referer)
                );
                out.push_str(&proxied_url);
                out.push('\n');
            } else {
                out.push_str(trimmed);
                out.push('\n');
            }
        }
    }

    out
}

/// Tauri command to construct a local proxy URL for any stream requiring CDN Referer headers
/// or CORS bypass.
#[tauri::command]
pub async fn get_stream_proxy_url(
    url: String,
    referer: Option<String>,
    is_hls: Option<bool>,
) -> Result<String, String> {
    let port = get_or_start_proxy_server().await?;
    let ref_str = referer.unwrap_or_else(|| infer_referer(&url));
    let endpoint = if is_hls.unwrap_or(false) { "playlist.m3u8" } else { "stream" };
    Ok(format!(
        "http://127.0.0.1:{}/{}?url={}&referer={}",
        port,
        endpoint,
        url_encode(&url),
        url_encode(&ref_str)
    ))
}

/// Authenticates against DropMB (Pingvin Share) and extracts the session JWT token from Set-Cookie or body.
#[tauri::command]
pub async fn dropmb_sign_in(email: String, password: String) -> Result<serde_json::Value, String> {
    static DROPMB_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = DROPMB_CLIENT.get_or_init(reqwest::Client::new);

    let payload = serde_json::json!({
        "email": email.trim(),
        "password": password
    });
    let payload_str = serde_json::to_string(&payload).map_err(|e| e.to_string())?;

    let res = client
        .post("https://dropmb.com/api/auth/signIn")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .body(payload_str)
        .send()
        .await
        .map_err(|e| format!("Failed to reach DropMB: {}", e))?;

    let status = res.status().as_u16();
    let mut token = String::new();

    for val in res.headers().get_all(reqwest::header::SET_COOKIE) {
        if let Ok(cookie_str) = val.to_str() {
            for part in cookie_str.split(';') {
                let part = part.trim();
                if let Some(t) = part.strip_prefix("access_token=") {
                    token = t.to_string();
                    break;
                }
            }
        }
        if !token.is_empty() {
            break;
        }
    }

    let body_text = res.text().await.unwrap_or_default();
    if status >= 200 && status < 300 {
        let user_json: serde_json::Value = serde_json::from_str(&body_text)
            .unwrap_or_else(|_| serde_json::json!({}));
        if token.is_empty() {
            if let Some(t) = user_json.get("accessToken").and_then(|v| v.as_str()) {
                token = t.to_string();
            } else if let Some(t) = user_json.get("token").and_then(|v| v.as_str()) {
                token = t.to_string();
            } else if let Some(t) = user_json.get("access_token").and_then(|v| v.as_str()) {
                token = t.to_string();
            }
        }
        Ok(serde_json::json!({
            "ok": true,
            "status": status,
            "token": token,
            "user": user_json
        }))
    } else {
        Err(format!("DropMB authentication failed (HTTP {}): {}", status, body_text))
    }
}

#[tauri::command]
pub async fn dropmb_create_share(
    id: String,
    name: String,
    expiration: String,
    token: String,
) -> Result<serde_json::Value, String> {
    static DROPMB_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = DROPMB_CLIENT.get_or_init(reqwest::Client::new);

    let payload = serde_json::json!({
        "id": id,
        "name": name,
        "expiration": expiration,
        "recipients": []
    });
    let payload_str = serde_json::to_string(&payload).map_err(|e| e.to_string())?;

    let mut req = client
        .post("https://dropmb.com/api/shares")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .header("Accept", "application/json")
        .header("Content-Type", "application/json");

    let trimmed_token = token.trim();
    if !trimmed_token.is_empty() {
        req = req
            .header("Cookie", format!("access_token={}", trimmed_token))
            .header("Authorization", format!("Bearer {}", trimmed_token));
    }

    let res = req
        .body(payload_str)
        .send()
        .await
        .map_err(|e| format!("Failed to reach DropMB: {}", e))?;

    let status = res.status().as_u16();
    let body_text = res.text().await.unwrap_or_default();
    let json_val: serde_json::Value = serde_json::from_str(&body_text)
        .unwrap_or_else(|_| serde_json::json!({ "raw": body_text }));

    Ok(serde_json::json!({
        "ok": (200..300).contains(&status),
        "status": status,
        "data": json_val,
        "body": body_text
    }))
}

#[tauri::command]
pub async fn dropmb_upload_chunk(
    share_id: String,
    file_name: String,
    chunk_index: usize,
    total_chunks: usize,
    file_id: Option<String>,
    token: String,
    chunk_base64: String,
) -> Result<serde_json::Value, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = STANDARD
        .decode(chunk_base64.trim())
        .map_err(|e| format!("Invalid chunk base64: {}", e))?;

    static DROPMB_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = DROPMB_CLIENT.get_or_init(reqwest::Client::new);

    let mut url = reqwest::Url::parse(&format!(
        "https://dropmb.com/api/shares/{}/files",
        share_id
    ))
    .map_err(|e| e.to_string())?;
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("name", &file_name);
        qp.append_pair("chunkIndex", &chunk_index.to_string());
        qp.append_pair("totalChunks", &total_chunks.to_string());
        if let Some(fid) = file_id.as_ref().filter(|s| !s.is_empty()) {
            qp.append_pair("id", fid);
        }
    }

    let mut req = client
        .post(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .header("Accept", "application/json")
        .header("Content-Type", "application/octet-stream");

    let trimmed_token = token.trim();
    if !trimmed_token.is_empty() {
        req = req
            .header("Cookie", format!("access_token={}", trimmed_token))
            .header("Authorization", format!("Bearer {}", trimmed_token));
    }

    let res = req
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("DropMB chunk upload request failed: {}", e))?;

    let status = res.status().as_u16();
    let body_text = res.text().await.unwrap_or_default();
    let json_val: serde_json::Value = serde_json::from_str(&body_text)
        .unwrap_or_else(|_| serde_json::json!({ "raw": body_text }));

    Ok(serde_json::json!({
        "ok": (200..300).contains(&status),
        "status": status,
        "data": json_val,
        "body": body_text
    }))
}

#[tauri::command]
pub async fn dropmb_complete_share(
    share_id: String,
    token: String,
) -> Result<serde_json::Value, String> {
    static DROPMB_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = DROPMB_CLIENT.get_or_init(reqwest::Client::new);

    let url = format!("https://dropmb.com/api/shares/{}/complete", share_id);
    let mut req = client
        .post(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .header("Accept", "application/json")
        .header("Content-Length", "0");

    let trimmed_token = token.trim();
    if !trimmed_token.is_empty() {
        req = req
            .header("Cookie", format!("access_token={}", trimmed_token))
            .header("Authorization", format!("Bearer {}", trimmed_token));
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("DropMB complete share request failed: {}", e))?;

    let status = res.status().as_u16();
    let body_text = res.text().await.unwrap_or_default();

    Ok(serde_json::json!({
        "ok": (200..300).contains(&status),
        "status": status,
        "body": body_text
    }))
}
