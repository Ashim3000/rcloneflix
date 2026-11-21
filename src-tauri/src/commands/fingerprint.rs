use std::num::Wrapping;

const OSHASH_CHUNK: u64 = 65_536;

fn sum_u64_le_chunks(bytes: &[u8]) -> Wrapping<u64> {
    let mut acc = Wrapping(0u64);
    for chunk in bytes.chunks_exact(8) {
        let val = u64::from_le_bytes(chunk.try_into().unwrap_or([0; 8]));
        acc += Wrapping(val);
    }
    acc
}

/// Computes the 64-bit OpenSubtitles hash (OSHASH) over HTTP Range requests (first 64 KiB + last 64 KiB + file size).
#[tauri::command]
pub async fn compute_remote_oshash(stream_url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    // 1. Fetch first 64 KiB
    let head_resp = client
        .get(&stream_url)
        .header("Range", format!("bytes=0-{}", OSHASH_CHUNK - 1))
        .send()
        .await
        .map_err(|e| format!("OSHASH head request failed: {}", e))?;

    let status = head_resp.status().as_u16();
    let total_size: u64 = if status == 206 {
        head_resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.rsplit('/').next())
            .and_then(|n| n.parse::<u64>().ok())
            .ok_or_else(|| "Missing Content-Range total size".to_string())?
    } else {
        return Err("Server does not support HTTP Range requests for OSHASH".to_string());
    };

    if total_size < OSHASH_CHUNK {
        return Err("File is smaller than 64 KB minimum for OSHASH".to_string());
    }

    let head_bytes = head_resp.bytes().await.map_err(|e| e.to_string())?;
    if head_bytes.len() < OSHASH_CHUNK as usize {
        return Err("Short read on OSHASH head chunk".to_string());
    }

    // 2. Fetch last 64 KiB
    let tail_start = total_size - OSHASH_CHUNK;
    let tail_resp = client
        .get(&stream_url)
        .header("Range", format!("bytes={}-{}", tail_start, total_size - 1))
        .send()
        .await
        .map_err(|e| format!("OSHASH tail request failed: {}", e))?;
    if tail_resp.status().as_u16() != 206 {
        return Err("Server rejected tail Range request for OSHASH".to_string());
    }
    let tail_bytes = tail_resp.bytes().await.map_err(|e| e.to_string())?;
    if tail_bytes.len() < OSHASH_CHUNK as usize {
        return Err("Short read on OSHASH tail chunk".to_string());
    }

    let hash = Wrapping(total_size)
        + sum_u64_le_chunks(&head_bytes[..OSHASH_CHUNK as usize])
        + sum_u64_le_chunks(&tail_bytes[..OSHASH_CHUNK as usize]);

    Ok(format!("{:016x}", hash.0))
}

/// Probes the first video stream's pixel dimensions.
async fn probe_video_dims(stream_url: &str) -> Result<(u32, u32), String> {
    let out = crate::process_ext::tokio_command("ffprobe")
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0",
            stream_url,
        ])
        .output()
        .await
        .map_err(|e| format!("ffprobe failed: {}", e))?;
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    let mut it = s.trim().split(',');
    let w = it.next().and_then(|v| v.trim().parse::<u32>().ok());
    let h = it.next().and_then(|v| v.trim().parse::<u32>().ok());
    match (w, h) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Ok((w, h)),
        _ => Err("Could not probe video dimensions for pHash".to_string()),
    }
}

/// Separable triangle-filter downscale (the kernel used by nfnt/resize "Bilinear", which goimagehash uses).
/// `src` is row-major `sw x sh`; returns row-major `dw x dh`.
fn resize_triangle(src: &[f64], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<f64> {
    fn taps(in_len: usize, out_len: usize) -> Vec<Vec<(usize, f64)>> {
        let ratio = in_len as f64 / out_len as f64;
        let scale = ratio.max(1.0);
        (0..out_len)
            .map(|o| {
                let center = ratio * (o as f64 + 0.5) - 0.5;
                let lo = (center - scale).floor() as i64;
                let hi = (center + scale).ceil() as i64;
                let mut v: Vec<(usize, f64)> = Vec::new();
                let mut sum = 0.0;
                for i in lo..=hi {
                    let d = ((i as f64) - center).abs() / scale;
                    if d < 1.0 {
                        let w = 1.0 - d;
                        let idx = i.clamp(0, in_len as i64 - 1) as usize;
                        v.push((idx, w));
                        sum += w;
                    }
                }
                for t in v.iter_mut() {
                    t.1 /= sum;
                }
                v
            })
            .collect()
    }
    let xt = taps(sw, dw);
    let yt = taps(sh, dh);
    let mut tmp = vec![0.0f64; dw * sh];
    for y in 0..sh {
        for (ox, t) in xt.iter().enumerate() {
            tmp[y * dw + ox] = t.iter().map(|(i, w)| src[y * sw + i] * w).sum();
        }
    }
    let mut out = vec![0.0f64; dw * dh];
    for (oy, t) in yt.iter().enumerate() {
        for x in 0..dw {
            out[oy * dw + x] = t.iter().map(|(i, w)| tmp[i * dw + x] * w).sum();
        }
    }
    out
}

/// On-demand Stash-style 64-bit video perceptual hash (EXPERIMENTAL until validated):
/// 25 frames at offset = 5% duration, step = 90% duration / 25, each scaled to 160 px WIDTH with the
/// source aspect ratio preserved, tiled 5x5 row-major into one montage, triangle-filter resized to
/// 64x64, plain (unnormalised) 2D DCT-II, top-left 8x8 coefficients, median threshold, MSB-first.
#[tauri::command]
pub async fn compute_remote_phash(
    stream_url: String,
    duration_secs: Option<f64>,
) -> Result<String, String> {
    let dur = match duration_secs.filter(|d| *d > 1.0) {
        Some(d) => d,
        None => {
            let out = crate::process_ext::tokio_command("ffprobe")
                .args([
                    "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    &stream_url,
                ])
                .output()
                .await
                .map_err(|e| format!("ffprobe failed: {}", e))?;
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse::<f64>()
                .map_err(|_| "Could not probe video duration for pHash".to_string())?
        }
    };

    let (src_w, src_h) = probe_video_dims(&stream_url).await?;
    const FW: usize = 160;
    let fh: usize = ((((FW as f64) * (src_h as f64) / (src_w as f64)) / 2.0).round() as usize * 2).max(2);

    let offset = dur * 0.05;
    let step = (dur * 0.90) / 25.0;
    let mw = FW * 5;
    let mh = fh * 5;
    let mut grid = vec![0u8; mw * mh];

    for idx in 0..25usize {
        let ts = offset + (idx as f64) * step;
        let out = crate::process_ext::tokio_command("ffmpeg")
            .args([
                "-v", "error",
                "-ss", &format!("{:.3}", ts),
                "-i", &stream_url,
                "-frames:v", "1",
                "-vf", &format!("scale={}:{},format=gray", FW, fh),
                "-f", "rawvideo",
                "pipe:1",
            ])
            .output()
            .await
            .map_err(|e| format!("ffmpeg frame sample failed: {}", e))?;
        if out.stdout.len() != FW * fh {
            return Err(format!(
                "pHash frame {} at {:.1}s could not be extracted (got {} bytes, expected {}).",
                idx, ts, out.stdout.len(), FW * fh
            ));
        }
        let gx = (idx % 5) * FW;
        let gy = (idx / 5) * fh;
        for y in 0..fh {
            let src_row = &out.stdout[y * FW..(y + 1) * FW];
            let dst_off = (gy + y) * mw + gx;
            grid[dst_off..dst_off + FW].copy_from_slice(src_row);
        }
    }

    let montage: Vec<f64> = grid.iter().map(|&b| b as f64).collect();
    let img64 = resize_triangle(&montage, mw, mh, 64, 64);

    let pi = std::f64::consts::PI;
    let mut dct8 = [0.0f64; 64];
    for u in 0..8 {
        for v in 0..8 {
            let mut sum = 0.0;
            for y in 0..64 {
                let cos_y = (pi * (y as f64 + 0.5) * (u as f64) / 64.0).cos();
                for x in 0..64 {
                    let cos_x = (pi * (x as f64 + 0.5) * (v as f64) / 64.0).cos();
                    sum += img64[y * 64 + x] * cos_y * cos_x;
                }
            }
            dct8[u * 8 + v] = sum;
        }
    }

    let mut sorted = dct8;
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = (sorted[31] + sorted[32]) * 0.5;

    let mut hash: u64 = 0;
    for (i, &val) in dct8.iter().enumerate() {
        if val > median {
            hash |= 1u64 << (63 - i);
        }
    }
    Ok(format!("{:016x}", hash))
}

#[cfg(test)]
mod phash_tests {
    #[tokio::test]
    #[ignore]
    async fn phash_matches_known_stash_hash() {
        let file = std::env::var("RCLONEFLIX_PHASH_FILE").expect("set RCLONEFLIX_PHASH_FILE");
        let expect = std::env::var("RCLONEFLIX_PHASH_EXPECT").expect("set RCLONEFLIX_PHASH_EXPECT");
        let got = super::compute_remote_phash(file, None).await.unwrap();
        assert_eq!(got, expect.to_lowercase(), "pHash differs from Stash's");
    }
}
