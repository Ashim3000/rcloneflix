use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;
use base64::prelude::*;

const STORE_PATH: &str = "rcloneflix-keys.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KaggleCredentials {
    pub username: String,
    pub key: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KaggleConnectionStatus {
    pub ok: bool,
    pub username: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KaggleTranscodeRequest {
    pub job_id: String,
    pub source_input: String,
    pub source_items: Option<Vec<String>>,
    pub dest_remote_folder: String,
    pub delete_original: bool,
    pub output_filename: Option<String>,
    pub crf: Option<u32>,
    pub preset: Option<u32>,
    pub max_height: Option<u32>,
    pub rclone_config_snippet: Option<String>,
    pub telegram_bot_token: Option<String>,
    pub telegram_chat_id: Option<String>,
    pub telegram_api_id: Option<String>,
    pub telegram_api_hash: Option<String>,
    pub streamtape_api_login: Option<String>,
    pub streamtape_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KaggleTransferRequest {
    pub job_id: String,
    pub operation: String, // "copy" | "move" | "sync"
    pub source: String,
    pub destination: String,
    pub batch_items: Option<Vec<String>>,
    pub transfers: Option<u32>,
    pub checkers: Option<u32>,
    pub drive_server_side_copy: Option<bool>,
    pub dry_run: Option<bool>,
    pub rclone_config_snippet: Option<String>,
    pub telegram_bot_token: Option<String>,
    pub telegram_chat_id: Option<String>,
    pub telegram_api_id: Option<String>,
    pub telegram_api_hash: Option<String>,
    pub streamtape_api_login: Option<String>,
    pub streamtape_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KaggleRdSeedRequest {
    pub job_id: String,
    pub source_input: String,
    pub rd_api_key: String,
    pub title: String,
    pub filename: String,
    pub rclone_config_snippet: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KaggleDispatchResult {
    pub job_id: String,
    pub kernel_slug: String,
    pub kernel_ref: String,
    pub url: String,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KaggleKernelStatus {
    pub status: String, // "queued" | "running" | "complete" | "error"
    pub failure_message: Option<String>,
}

/// Look for kaggle.json in user's home folder or ~/.kaggle/
pub fn find_kaggle_json(app: &AppHandle) -> Option<(String, String)> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(home) = app.path().home_dir() {
        candidates.push(home.join("kaggle.json"));
        candidates.push(home.join(".kaggle").join("kaggle.json"));
    }
    if let Some(home_var) = std::env::var_os("HOME") {
        let home = PathBuf::from(home_var);
        candidates.push(home.join("kaggle.json"));
        candidates.push(home.join(".kaggle").join("kaggle.json"));
    }
    candidates.push(PathBuf::from("/home/ashim3000/kaggle.json"));

    for path in candidates {
        if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    let u = val.get("username").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                    let k = val.get("key").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                    if !u.is_empty() && !k.is_empty() {
                        log::info!("[kaggle] Auto-detected credentials for @{} from {}", u, path.display());
                        return Some((u, k));
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn save_kaggle_credentials(
    app: AppHandle,
    credentials: KaggleCredentials,
) -> Result<(), String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("Failed to open keys store: {}", e))?;

    store.set("kaggle_username", serde_json::json!(credentials.username.trim()));
    store.set("kaggle_key", serde_json::json!(credentials.key.trim()));
    store
        .save()
        .map_err(|e| format!("Failed to save keys store: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn load_kaggle_credentials(app: AppHandle) -> Result<KaggleCredentials, String> {
    let store = app
        .store(STORE_PATH)
        .map_err(|e| format!("Failed to open keys store: {}", e))?;

    let mut username = store
        .get("kaggle_username")
        .and_then(|v| v.as_str().map(|s| s.trim().to_string()))
        .unwrap_or_default();

    let mut key = store
        .get("kaggle_key")
        .and_then(|v| v.as_str().map(|s| s.trim().to_string()))
        .unwrap_or_default();

    // If store credentials are empty, auto-detect from ~/kaggle.json
    if username.is_empty() || key.is_empty() {
        if let Some((u, k)) = find_kaggle_json(&app) {
            username = u.clone();
            key = k.clone();
            store.set("kaggle_username", serde_json::json!(&u));
            store.set("kaggle_key", serde_json::json!(&k));
            let _ = store.save();
        }
    }

    Ok(KaggleCredentials { username, key })
}

#[tauri::command]
pub async fn import_kaggle_json(app: AppHandle) -> Result<KaggleCredentials, String> {
    if let Some((u, k)) = find_kaggle_json(&app) {
        let store = app
            .store(STORE_PATH)
            .map_err(|e| format!("Failed to open keys store: {}", e))?;
        store.set("kaggle_username", serde_json::json!(&u));
        store.set("kaggle_key", serde_json::json!(&k));
        let _ = store.save();
        Ok(KaggleCredentials { username: u, key: k })
    } else {
        Err("No kaggle.json found in ~/kaggle.json or ~/.kaggle/kaggle.json".to_string())
    }
}

#[tauri::command]
pub async fn test_kaggle_connection(
    app: AppHandle,
    username: Option<String>,
    key: Option<String>,
) -> Result<KaggleConnectionStatus, String> {
    // If username/key passed explicitly, test those; otherwise test stored credentials
    let (u, k) = match (username, key) {
        (Some(u), Some(k)) if !u.trim().is_empty() && !k.trim().is_empty() => {
            (u.trim().to_string(), k.trim().to_string())
        }
        _ => {
            let creds = load_kaggle_credentials(app).await?;
            if creds.username.is_empty() || creds.key.is_empty() {
                return Ok(KaggleConnectionStatus {
                    ok: false,
                    username: "".to_string(),
                    message: "No Kaggle credentials configured. Please enter your username and API key, or place kaggle.json in your home folder.".to_string(),
                });
            }
            (creds.username, creds.key)
        }
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let test_url = format!("https://www.kaggle.com/api/v1/kernels/list?user={}&pageSize=1", u);
    let res = client
        .get(&test_url)
        .basic_auth(&u, Some(&k))
        .header("User-Agent", "RcloneFlix-Desktop/0.6")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Kaggle API: {}", e))?;

    let status = res.status();
    if status.is_success() {
        Ok(KaggleConnectionStatus {
            ok: true,
            username: u.clone(),
            message: format!("Successfully connected to Kaggle as @{}!", u),
        })
    } else if status.as_u16() == 401 {
        Ok(KaggleConnectionStatus {
            ok: false,
            username: u,
            message: "Authentication failed (401). Invalid Kaggle username or API token.".to_string(),
        })
    } else if status.as_u16() == 403 {
        Ok(KaggleConnectionStatus {
            ok: false,
            username: u,
            message: "Access forbidden (403). Phone verification may be required at kaggle.com/settings.".to_string(),
        })
    } else {
        let err_text = res.text().await.unwrap_or_default();
        Ok(KaggleConnectionStatus {
            ok: false,
            username: u,
            message: format!("Kaggle API returned status {}: {}", status, err_text),
        })
    }
}

/// Short unique job hash: seed (job_id/title) + dispatch-time millis.
/// Uniqueness matters, determinism does not — the caller stores the returned slug.
fn short_job_hash(seed: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    seed.hash(&mut h);
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().hash(&mut h))
        .ok();
    format!("{:016x}", h.finish())
}

fn sanitize_slug(input: &str) -> String {
    let mut slug = String::new();
    for c in input.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if c == '-' || c == '_' || c == ' ' {
            if !slug.ends_with('-') {
                slug.push('-');
            }
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        format!("transcode-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
    } else if trimmed.len() > 50 {
        trimmed[..50].trim_matches('-').to_string()
    } else {
        trimmed
    }
}

fn sanitize_title(input: &str) -> String {
    let mut title = String::new();
    for c in input.chars() {
        if c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' {
            title.push(c);
        }
    }
    let trimmed = title.trim();
    if trimmed.is_empty() {
        format!(
            "Job {}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                % 100000
        )
    } else {
        trimmed.chars().take(32).collect::<String>().trim().to_string()
    }
}

/// Safely extracts `(username, kernel_slug)` from any Kaggle ref or slug format:
/// e.g. `"/code/terencewhitmore/my-slug"`, `"code/terencewhitmore/my-slug"`,
/// `"https://www.kaggle.com/code/terencewhitmore/my-slug"`, `"terencewhitmore/my-slug"`, or `"my-slug"`.
pub fn parse_kaggle_user_and_slug(input: &str, default_user: &str) -> (String, String) {
    let parts: Vec<&str> = input
        .trim()
        .split('/')
        .map(|s| s.trim())
        .filter(|s| {
            !s.is_empty()
                && *s != "http:"
                && *s != "https:"
                && *s != "www.kaggle.com"
                && *s != "kaggle.com"
                && *s != "code"
        })
        .collect();

    if parts.len() >= 2 {
        (
            parts[parts.len() - 2].to_string(),
            parts[parts.len() - 1].to_string(),
        )
    } else if parts.len() == 1 {
        (default_user.trim().to_string(), parts[0].to_string())
    } else {
        (
            default_user.trim().to_string(),
            input.trim().trim_matches('/').to_string(),
        )
    }
}

fn generate_transcode_script(
    req: &KaggleTranscodeRequest,
    rclone_conf: &str,
) -> String {
    let crf = req.crf.unwrap_or(27);
    let preset = req.preset.unwrap_or(9);
    let max_height = req.max_height.unwrap_or(1080);
    let delete_original = if req.delete_original { "True" } else { "False" };
    let output_name_override = match &req.output_filename {
        Some(s) if !s.trim().is_empty() => format!("\"{}\"", s.trim().replace('"', "\\\"")),
        _ => "None".to_string(),
    };
    let source_items_json = serde_json::to_string(
        &req.source_items.clone().unwrap_or_else(|| vec![req.source_input.trim().to_string()])
    ).unwrap_or_else(|_| "[]".to_string());

    let tg_bot_token = req.telegram_bot_token.as_deref().unwrap_or("");
    let mut tg_chat_id = req.telegram_chat_id.as_deref().unwrap_or("").to_string();
    let dest_lower = req.dest_remote_folder.trim().to_lowercase();
    if tg_chat_id.is_empty() && dest_lower.starts_with("telegram:") {
        tg_chat_id = req.dest_remote_folder.trim()[9..].trim().to_string();
    }
    let tg_api_id = req.telegram_api_id.as_deref().unwrap_or("");
    let tg_api_hash = req.telegram_api_hash.as_deref().unwrap_or("");

    let st_login = req.streamtape_api_login.as_deref().unwrap_or("");
    let st_key = req.streamtape_api_key.as_deref().unwrap_or("");

    format!(
r#"# Auto-generated RcloneFlix Cloud Transcode Worker (Single + Batch + Origin Safeguard)
import os
import re
import sys
import shutil
import subprocess
import json
import time
from collections import deque
from urllib.parse import unquote, urlparse

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

print("=" * 65)
print("🚀 RCLONEFLIX KAGGLE CLOUD TRANSCODER INITIALIZING")
print("=" * 65)

# 1. SETUP RCLONE CONFIG & PARSE CONFIGURED REMOTES
RCLONE_CONFIG_DIR = os.path.expanduser("~/.config/rclone")
os.makedirs(RCLONE_CONFIG_DIR, exist_ok=True)
rclone_conf_path = os.path.join(RCLONE_CONFIG_DIR, "rclone.conf")

RCLONE_CONFIG_DATA = """{rclone_conf}"""
with open(rclone_conf_path, "w", encoding="utf-8") as f:
    f.write(RCLONE_CONFIG_DATA.strip())

CONFIGURED_REMOTES = set(re.findall(r"^\[([^\]]+)\]", RCLONE_CONFIG_DATA, re.MULTILINE))
print(f"🔑 Configured Rclone Remotes: {{sorted(list(CONFIGURED_REMOTES))}}")

if not shutil.which("rclone"):
    print("⚙️ Installing Rclone binary (skipping manpage db rebuild)...")
    subprocess.run(
        "curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rclone.zip && "
        "unzip -q -o /tmp/rclone.zip -d /tmp/rclone_unz && "
        "cp /tmp/rclone_unz/rclone-*-linux-amd64/rclone /usr/local/bin/rclone && "
        "chmod 755 /usr/local/bin/rclone && rm -rf /tmp/rclone.zip /tmp/rclone_unz",
        shell=True,
        check=True
    )
    print("✅ Rclone ready!\n")

# 2. SETUP MODERN FFMPEG WITH SVT-AV1
if not shutil.which("ffmpeg") or not shutil.which("ffprobe") or "libsvtav1" not in subprocess.getoutput("ffmpeg -encoders"):
    print("⚙️ Installing modern FFmpeg with SVT-AV1...")
    install_cmd = "wget -q https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz && tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz && cp ffmpeg-master-latest-linux64-gpl/bin/ffmpeg ffmpeg-master-latest-linux64-gpl/bin/ffprobe /usr/local/bin/ && rm -rf ffmpeg-master-latest-linux64-gpl*"
    subprocess.run(install_cmd, shell=True, check=True)
    print("✅ Modern FFmpeg ready!\n")

# 3. SETTINGS & SAFE DESTINATION RESOLVER
SOURCE_INPUT = r"""{source_input}"""
RAW_ITEMS = json.loads(r'''{source_items_json}''')
DEST_REMOTE_FOLDER = r"""{dest_remote_folder}"""
DELETE_ORIGINAL_ON_SUCCESS = {delete_original}
OUTPUT_NAME_OVERRIDE = {output_name_override}
CRF = {crf}
PRESET = {preset}
MAX_HEIGHT = {max_height}

TG_BOT_TOKEN = "{tg_bot_token}"
TG_CHAT_ID = "{tg_chat_id}"
TG_API_ID = "{tg_api_id}"
TG_API_HASH = "{tg_api_hash}"
ST_LOGIN = "{st_login}"
ST_KEY = "{st_key}"

def resolve_origin_folder(source_str):
    if ":" not in source_str or source_str.startswith("http://") or source_str.startswith("https://"):
        return None
    rem, rest = source_str.split(":", 1)
    if "/" in rest.rstrip("/"):
        parent = rest.rstrip("/").rsplit("/", 1)[0]
        return f"{{rem}}:{{parent}}/"
    return f"{{rem}}:/"

def resolve_safe_dest_folder(raw_dest, source_str):
    cand = (raw_dest or "").strip()
    c_lower = cand.lower()
    if c_lower.startswith("telegram:") or c_lower.startswith("streamtape:") or c_lower.startswith("telegram-drive:") or c_lower.startswith("tg-native:"):
        return cand
    origin_folder = resolve_origin_folder(source_str)
    if ":" in cand and not cand.startswith("/"):
        rem_name, sub_path = cand.split(":", 1)
        rem_name = rem_name.strip()
        if rem_name.lower() in ("streamtape", "telegram", "telegram-drive", "tg-native"):
            return f"{{rem_name}}:"
        if rem_name in CONFIGURED_REMOTES:
            clean_sub = sub_path.strip("/")
            return f"{{rem_name}}:/{{clean_sub}}/" if clean_sub else f"{{rem_name}}:/"
        print(f"⚠️ Safeguard: Destination remote '{{rem_name}}' not found in rclone.conf!")
    else:
        print(f"⚠️ Safeguard: Destination '{{cand}}' is missing a valid 'remote:' prefix!")

    if origin_folder:
        print(f"🛡️ Falling back to source origin folder: {{origin_folder}}")
        return origin_folder
    if "odrivecrypt" in CONFIGURED_REMOTES:
        return "odrivecrypt:/Converted_Videos/"
    if CONFIGURED_REMOTES:
        first_rem = sorted(list(CONFIGURED_REMOTES))[0]
        return f"{{first_rem}}:/Converted_Videos/"
    raise RuntimeError("No valid destination remote or origin remote found in rclone.conf! Aborting to prevent data loss.")

def resolve_smart_audio_and_subs(ffmpeg_input, is_output_mkv=False):
    probe_res = subprocess.run([
        "ffprobe", "-v", "error",
        "-show_entries", "stream=index,codec_name,codec_type,tags,disposition",
        "-of", "json", ffmpeg_input
    ], capture_output=True, text=True)
    
    streams = []
    try:
        data = json.loads(probe_res.stdout)
        streams = data.get("streams", [])
    except Exception:
        pass

    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    sub_streams = [s for s in streams if s.get("codec_type") == "subtitle"]

    compatible_audio_codecs = ["aac", "mp3", "opus", "flac"] if not is_output_mkv else ["aac", "mp3", "opus", "flac", "ac3", "eac3", "dts", "truehd"]

    def is_english(s):
        tags = s.get("tags") or {{}}
        lang = (tags.get("language") or "").lower()
        title = (tags.get("title") or "").lower()
        return (
            lang in ["eng", "en", "en-us", "en-gb", "english"] or
            "eng" in lang or
            "english" in title or
            "eng" in title.split() or
            "dub" in title
        )

    eng_audio_idx = None
    for idx, s in enumerate(audio_streams):
        if is_english(s):
            title = ((s.get("tags") or {{}}).get("title") or "").lower()
            if "commentary" not in title:
                eng_audio_idx = idx
                break
            elif eng_audio_idx is None:
                eng_audio_idx = idx

    audio_flags = []
    if audio_streams:
        if eng_audio_idx is not None and eng_audio_idx > 0:
            eng_s_idx = audio_streams[eng_audio_idx].get("index", eng_audio_idx)
            print(f"🎙️ Dual Audio: Promoting English audio track (stream {{eng_s_idx}}) to primary default track")
            ordered_audio = [audio_streams[eng_audio_idx]] + [s for i, s in enumerate(audio_streams) if i != eng_audio_idx]
        else:
            ordered_audio = audio_streams
            if eng_audio_idx == 0:
                print("🎙️ English audio is already primary track 0")

        for out_idx, s in enumerate(ordered_audio):
            s_idx = s.get("index", out_idx)
            audio_flags.extend(["-map", f"0:{{s_idx}}"])
            codec = s.get("codec_name", "").lower()
            if codec in compatible_audio_codecs:
                audio_flags.extend([f"-c:a:{{out_idx}}", "copy"])
            else:
                audio_flags.extend([f"-c:a:{{out_idx}}", "aac", f"-b:a:{{out_idx}}", "256k"])
            
            if out_idx == 0:
                audio_flags.extend([f"-disposition:a:{{out_idx}}", "default"])
            else:
                audio_flags.extend([f"-disposition:a:{{out_idx}}", "0"])
            
            lang = ((s.get("tags") or {{}}).get("language") or "").strip()
            if lang:
                audio_flags.extend([f"-metadata:s:a:{{out_idx}}", f"language={{lang}}"])
            title = ((s.get("tags") or {{}}).get("title") or "").strip()
            if title:
                audio_flags.extend([f"-metadata:s:a:{{out_idx}}", f"title={{title}}"])
    else:
        audio_flags = ["-map", "0:a?"]

    sub_flags = []
    text_sub_codecs = ["mov_text", "subrip", "srt", "ass", "webvtt", "text"]
    compatible_subs = sub_streams if is_output_mkv else [s for s in sub_streams if s.get("codec_name", "").lower() in text_sub_codecs]

    if compatible_subs:
        eng_sub_idx = None
        for idx, s in enumerate(compatible_subs):
            if is_english(s):
                title = ((s.get("tags") or {{}}).get("title") or "").lower()
                disp = s.get("disposition") or {{}}
                is_forced = disp.get("forced") == 1
                is_signs = "signs" in title or "songs" in title
                if not is_signs and not is_forced:
                    eng_sub_idx = idx
                    break
                elif eng_sub_idx is None:
                    eng_sub_idx = idx

        if eng_sub_idx is not None:
            eng_s_sub_idx = compatible_subs[eng_sub_idx].get("index", eng_sub_idx)
            print(f"💬 Subtitle Detected: Promoting English subtitles (stream {{eng_s_sub_idx}}) to default")
            ordered_subs = [compatible_subs[eng_sub_idx]] + [s for i, s in enumerate(compatible_subs) if i != eng_sub_idx]
        else:
            ordered_subs = compatible_subs

        for out_s_idx, s in enumerate(ordered_subs):
            s_idx = s.get("index", out_s_idx)
            sub_flags.extend(["-map", f"0:{{s_idx}}"])
            if is_output_mkv:
                sub_flags.extend([f"-c:s:{{out_s_idx}}", "copy"])
            else:
                sub_flags.extend([f"-c:s:{{out_s_idx}}", "mov_text"])
            
            if out_s_idx == 0 and eng_sub_idx is not None:
                sub_flags.extend([f"-disposition:s:{{out_s_idx}}", "default"])
            else:
                sub_flags.extend([f"-disposition:s:{{out_s_idx}}", "0"])
            
            lang = ((s.get("tags") or {{}}).get("language") or "").strip()
            if lang:
                sub_flags.extend([f"-metadata:s:s:{{out_s_idx}}", f"language={{lang}}"])
            title = ((s.get("tags") or {{}}).get("title") or "").strip()
            if title:
                sub_flags.extend([f"-metadata:s:s:{{out_s_idx}}", f"title={{title}}"])

    return audio_flags, sub_flags

# Expand any directory items into video files
VIDEO_EXTS = (".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".ts", ".m2ts", ".flv", ".wmv")
expanded_queue = []
for raw_it in (RAW_ITEMS if RAW_ITEMS else [SOURCE_INPUT]):
    it = raw_it.strip()
    if not it:
        continue
    is_remote = ":" in it and not (it.startswith("http://") or it.startswith("https://"))
    if is_remote and not it.lower().endswith(VIDEO_EXTS):
        lsf_res = subprocess.run(["rclone", "lsf", "-R", "--files-only", it], capture_output=True, text=True)
        if lsf_res.returncode == 0 and lsf_res.stdout.strip():
            base_dir = it.rstrip("/")
            for rel in lsf_res.stdout.splitlines():
                rel = rel.strip()
                if rel.lower().endswith(VIDEO_EXTS) and not rel.lower().endswith("_av1.mp4"):
                    expanded_queue.append(f"{{base_dir}}/{{rel}}")
            continue
    expanded_queue.append(it)

work_dir = "/kaggle/working" if os.path.exists("/kaggle/working") else "/tmp"
is_batch = len(expanded_queue) > 1
failures = 0

for idx, source_str in enumerate(expanded_queue, 1):
    print("=" * 65)
    print(f"🎬 Processing Item [{{idx}}/{{len(expanded_queue)}}]: {{source_str}}")
    print("=" * 65)

    is_cloud_remote_source = ":" in source_str and not (source_str.startswith("http://") or source_str.startswith("https://"))
    safe_dest_folder = resolve_safe_dest_folder(DEST_REMOTE_FOLDER, source_str)

    if is_cloud_remote_source:
        source_basename = os.path.basename(source_str.rstrip("/"))
        name, ext = os.path.splitext(source_basename)
        if name.endswith("_AV1"):
            output_filename = f"{{name}}.mp4"
        else:
            output_filename = (OUTPUT_NAME_OVERRIDE if (OUTPUT_NAME_OVERRIDE and not is_batch) else f"{{name}}_AV1.mp4")
        if not output_filename.lower().endswith(".mp4"):
            output_filename = f"{{output_filename}}_AV1.mp4"
        output_filename = output_filename.replace(":", " -").replace("  ", " ")[:180]
        local_temp_input = os.path.join(work_dir, f"temp_input_{{idx}}{{ext}}")
        local_temp_output = os.path.join(work_dir, f"out_{{idx}}.mp4")

        print(f"☁️ Remote Source:      {{source_str}}")
        print(f"🔒 Safe Destination:   {{safe_dest_folder}}{{output_filename}}")
        pull_res = subprocess.run(["rclone", "copyto", source_str, local_temp_input, "-P", "--timeout", "120s"])
        if pull_res.returncode != 0:
            print(f"❌ Failed to download source file (code {{pull_res.returncode}})")
            failures += 1
            continue
        ffmpeg_input = local_temp_input
        ffmpeg_reconnect_flags = []
    else:
        path = urlparse(source_str).path
        raw_filename = os.path.basename(unquote(path))
        if not raw_filename or "." not in raw_filename:
            raw_filename = f"video_output_{{idx}}.mp4"
        name, _ = os.path.splitext(raw_filename)
        output_filename = (OUTPUT_NAME_OVERRIDE if (OUTPUT_NAME_OVERRIDE and not is_batch) else f"{{name}}_AV1.mp4")
        if not output_filename.lower().endswith(".mp4"):
            output_filename = f"{{output_filename}}_AV1.mp4"
        output_filename = output_filename.replace(":", " -").replace("  ", " ")[:180]
        local_temp_input = None
        local_temp_output = os.path.join(work_dir, f"out_{{idx}}.mp4")
        ffmpeg_input = source_str
        ffmpeg_reconnect_flags = ["-reconnect", "1", "-reconnect_at_eof", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]

    audio_flags, sub_flags = resolve_smart_audio_and_subs(ffmpeg_input, output_filename.lower().endswith(".mkv"))
    scale_filter = f"scale=-2:'trunc(min({{MAX_HEIGHT}},ih)/2)*2'"

    cmd = ["ffmpeg", "-y"] + ffmpeg_reconnect_flags + [
        "-i", ffmpeg_input, "-map", "0:v:0?"
    ] + audio_flags + sub_flags + [
        "-vf", scale_filter, "-c:v", "libsvtav1", "-preset", str(PRESET), "-crf", str(CRF),
        "-movflags", "+faststart", local_temp_output
    ]

    process = subprocess.Popen(cmd, stderr=subprocess.PIPE, universal_newlines=True)
    err_log = deque(maxlen=30)
    for line in process.stderr:
        err_log.append(line)
        if "frame=" in line or "time=" in line or "speed=" in line:
            print(line.strip())
    process.wait()

    if local_temp_input and os.path.exists(local_temp_input):
        os.remove(local_temp_input)

    if process.returncode != 0:
        print(f"❌ Transcode failed with return code {{process.returncode}}\n" + "".join(err_log))
        failures += 1
        continue

    target_remote_file = f"{{safe_dest_folder}}{{output_filename}}" if safe_dest_folder.endswith(":") else f"{{safe_dest_folder.rstrip('/')}}/{{output_filename}}"
    is_dest_telegram = safe_dest_folder.lower().startswith("telegram:") or safe_dest_folder.lower().startswith("telegram-drive:") or safe_dest_folder.lower().startswith("tg-native:")
    is_dest_streamtape = safe_dest_folder.lower().startswith("streamtape:")
    upload_successful = False

    if is_dest_telegram:
        target_chat = ""
        if ":" in safe_dest_folder:
            dest_chat = safe_dest_folder.split(":", 1)[1].strip("/")
            if dest_chat and not dest_chat.endswith(VIDEO_EXTS):
                target_chat = dest_chat
        if not target_chat:
            target_chat = TG_CHAT_ID
        if not target_chat:
            raise RuntimeError("Destination is telegram: but no target chat ID was provided")

        print(f"📲 Uploading transcoded video {{output_filename}} to Telegram -> Chat ID: {{target_chat}}")
        fsize = os.path.getsize(local_temp_output)
        use_mtproto = bool(TG_API_ID and TG_API_HASH and TG_BOT_TOKEN)

        if use_mtproto:
            print("🚀 Installing Telethon + Cryptg for 2 GB MTProto upload...")
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "telethon", "cryptg"], check=True)
            from telethon.sync import TelegramClient
            from telethon.tl.types import DocumentAttributeFilename, DocumentAttributeVideo

            try:
                client = TelegramClient("/tmp/rflix_kaggle_tg_transcode", int(TG_API_ID), TG_API_HASH)
                client.start(bot_token=TG_BOT_TOKEN)

                last_up = [0]
                def tg_progress(cur, tot):
                    now = time.time()
                    if now - last_up[0] >= 3.0 or cur == tot:
                        pct = round((cur / tot) * 100, 1)
                        mb_c = round(cur / (1024 * 1024), 1)
                        mb_t = round(tot / (1024 * 1024), 1)
                        print(f"   [Telegram MTProto] {{pct}}% ({{mb_c}} / {{mb_t}} MB)")
                        last_up[0] = now

                target_entity = int(target_chat) if target_chat.lstrip("-").isdigit() else target_chat
                video_exts = (".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".ts")
                attrs = [DocumentAttributeFilename(file_name=output_filename)]
                is_vid = output_filename.lower().endswith(video_exts)
                if is_vid:
                    dur, vw, vh = 0, 1280, 720
                    try:
                        pr = subprocess.run([
                            "ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=width,height",
                            "-show_entries", "format=duration",
                            "-of", "json", local_temp_output
                        ], capture_output=True, text=True, timeout=15)
                        if pr.returncode == 0:
                            pdata = json.loads(pr.stdout)
                            streams = pdata.get("streams") or []
                            if streams:
                                vw = int(streams[0].get("width") or vw)
                                vh = int(streams[0].get("height") or vh)
                            fmt_dur = (pdata.get("format") or {{}}).get("duration")
                            if fmt_dur:
                                dur = int(float(fmt_dur))
                    except Exception:
                        pass
                    attrs.insert(0, DocumentAttributeVideo(duration=dur, w=vw, h=vh, supports_streaming=True))
                sent_msg = client.send_file(
                    target_entity,
                    local_temp_output,
                    caption=f"🎬 {{output_filename}}",
                    force_document=not is_vid,
                    supports_streaming=is_vid,
                    attributes=attrs,
                    progress_callback=tg_progress
                )
                msg_id = getattr(sent_msg, "id", 0)
                folder = safe_dest_folder.split(":", 1)[1].strip("/").split("/")[0] if ":" in safe_dest_folder else ""
                if not folder:
                    folder = "TV Shows - TD" if "s0" in output_filename.lower() or "season" in output_filename.lower() else "Movies TD"
                rel_path = f"{{folder}}/{{output_filename}}" if folder else output_filename
                entry_data = {{
                    "msgId": msg_id,
                    "chatId": str(target_chat),
                    "name": output_filename,
                    "size": fsize,
                    "folder": folder,
                    "remote": "telegram-drive",
                    "remotePath": f"telegram-drive:{{rel_path}}",
                    "path": "/" + rel_path,
                    "mtime": int(time.time())
                }}
                print(f"RCLONEFLIX_TG_OFFLOAD_RESULT:{{json.dumps(entry_data)}}")
                print(f"🎉 Successfully uploaded {{output_filename}} to Telegram via MTProto (msg_id={{msg_id}})")
                upload_successful = True
                client.disconnect()
            except Exception as tg_err:
                print(f"❌ Telegram MTProto upload failed: {{tg_err}}")
                failures += 1
        else:
            if fsize > 50 * 1024 * 1024:
                raise RuntimeError(f"File {{output_filename}} ({{fsize / (1024*1024):.1f}} MB) exceeds 50MB Bot API limit. Please supply api_id/api_hash for MTProto upload.")
            import requests
            print(f"Uploading {{output_filename}} via Bot HTTP API...")
            with open(local_temp_output, "rb") as fobj:
                r = requests.post(
                    f"https://api.telegram.org/bot{{TG_BOT_TOKEN}}/sendDocument",
                    data={{"chat_id": str(target_chat), "caption": f"🎬 {{output_filename}}"}},
                    files={{"document": (output_filename, fobj)}},
                    timeout=900
                )
            if not r.ok:
                raise RuntimeError(f"Telegram Bot API error ({{r.status_code}}): {{r.text}}")
            resp_json = r.json()
            msg_id = (resp_json.get("result") or {{}}).get("message_id", 0)
            folder = safe_dest_folder.split(":", 1)[1].strip("/").split("/")[0] if ":" in safe_dest_folder else ""
            if not folder:
                folder = "TV Shows - TD" if "s0" in output_filename.lower() or "season" in output_filename.lower() else "Movies TD"
            rel_path = f"{{folder}}/{{output_filename}}" if folder else output_filename
            entry_data = {{
                "msgId": msg_id,
                "chatId": str(target_chat),
                "name": output_filename,
                "size": fsize,
                "folder": folder,
                "remote": "telegram-drive",
                "remotePath": f"telegram-drive:{{rel_path}}",
                "path": "/" + rel_path,
                "mtime": int(time.time())
            }}
            print(f"RCLONEFLIX_TG_OFFLOAD_RESULT:{{json.dumps(entry_data)}}")
            print(f"🎉 Successfully uploaded {{output_filename}} to Telegram via Bot API (msg_id={{msg_id}})")
            upload_successful = True

        if os.path.exists(local_temp_output):
            os.remove(local_temp_output)

    elif is_dest_streamtape:
        if not ST_LOGIN or not ST_KEY:
            raise RuntimeError("Streamtape API Login or Key missing in transcode payload!")
        import requests
        st_folder = safe_dest_folder.split(":", 1)[1].strip() if ":" in safe_dest_folder else ""
        ul_url = f"https://api.streamtape.com/file/ul?login={{ST_LOGIN}}&key={{ST_KEY}}"
        if st_folder:
            ul_url += f"&folder={{st_folder}}"
        ul_info = requests.get(ul_url, timeout=30).json()
        if ul_info.get("status") != 200 or "result" not in ul_info:
            raise RuntimeError(f"Streamtape ul init failed: {{ul_info}}")
        target_post_url = ul_info["result"]["url"]
        print(f"📼 Uploading transcoded video {{output_filename}} to Streamtape...")
        with open(local_temp_output, "rb") as fobj:
            up_res = requests.post(target_post_url, files={{"file1": (output_filename, fobj)}}, timeout=1800)
        if not up_res.ok:
            raise RuntimeError(f"Streamtape upload failed ({{up_res.status_code}}): {{up_res.text}}")
        up_json = up_res.json()
        linkid = (up_json.get("result") or {{}}).get("id") or ""
        link = (up_json.get("result") or {{}}).get("url") or f"https://streamtape.com/v/{{linkid}}"
        st_data = {{
            "name": output_filename,
            "size": os.path.getsize(local_temp_output) if os.path.exists(local_temp_output) else 0,
            "linkid": linkid,
            "shareUrl": link,
            "remotePath": f"streamtape:{{st_folder.rstrip('/')}}/{{output_filename}}" if st_folder else f"streamtape:{{output_filename}}"
        }}
        print(f"RCLONEFLIX_STREAMTAPE_OFFLOAD_RESULT:{{json.dumps(st_data)}}")
        print(f"🎉 Uploaded {{output_filename}} to Streamtape: {{link}}")
        upload_successful = True
        if os.path.exists(local_temp_output):
            os.remove(local_temp_output)

    else:
        print(f"🔒 Uploading to {{target_remote_file}} via Rclone...")
        # moveto, not move: local staging name is out_{{idx}}.mp4, so the final
        # filename must be reasserted by targeting the full destination path
        upload_res = subprocess.run([
            "rclone", "moveto", local_temp_output, target_remote_file,
            "-P", "--retries", "5", "--low-level-retries", "10", "--timeout", "120s"
        ])

        if upload_res.returncode == 0:
            dest_rem_prefix = safe_dest_folder.split(":", 1)[0].strip() if ":" in safe_dest_folder else ""
            verify_res = subprocess.run(["rclone", "lsf", target_remote_file], capture_output=True, text=True)
            upload_successful = (dest_rem_prefix in CONFIGURED_REMOTES) and (verify_res.returncode == 0) and (output_filename in verify_res.stdout)
            if upload_successful:
                print(f"🎉 Verified upload on cloud remote: {{target_remote_file}}")
            else:
                print(f"⚠️ Safeguard: Could not verify {{target_remote_file}} on remote; keeping original source file intact!")
        else:
            print(f"❌ Rclone upload failed with code {{upload_res.returncode}}")
            failures += 1

    if upload_successful and is_cloud_remote_source and DELETE_ORIGINAL_ON_SUCCESS:
        if is_dest_telegram or is_dest_streamtape or source_str.rstrip("/") != target_remote_file.rstrip("/"):
            print(f"🗑️ Deleting verified source original: {{source_str}}...")
            subprocess.run(["rclone", "deletefile", source_str])

if failures > 0:
    sys.exit(1)
"#,
        rclone_conf = rclone_conf.trim(),
        source_input = req.source_input.trim(),
        source_items_json = source_items_json,
        dest_remote_folder = req.dest_remote_folder.trim(),
        delete_original = delete_original,
        output_name_override = output_name_override,
        crf = crf,
        preset = preset,
        max_height = max_height,
        tg_bot_token = tg_bot_token,
        tg_chat_id = tg_chat_id,
        tg_api_id = tg_api_id,
        tg_api_hash = tg_api_hash,
        st_login = st_login,
        st_key = st_key
    )
}

pub fn resolve_rclone_config_content(app: &AppHandle, snippet: Option<&str>) -> Result<String, String> {
    // Check custom or default rclone.conf path on disk first (e.g. ~/rclone (2).conf) so newly mounted remotes like udrop are always included
    if let Some(cfg_path) = crate::commands::rclone_sync::resolve_config_arg("") {
        if let Ok(content) = std::fs::read_to_string(&cfg_path) {
            if !content.trim().is_empty() {
                return Ok(content);
            }
        }
    }
    if let Some(s) = snippet {
        if !s.trim().is_empty() {
            return Ok(s.trim().to_string());
        }
    }
    // Fall back to stored content in rcloneflix-keys.json
    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    Ok(store
        .get("rclone_config_content")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default())
}

#[tauri::command]
pub async fn dispatch_kaggle_transcode(
    app: AppHandle,
    req: KaggleTranscodeRequest,
) -> Result<KaggleDispatchResult, String> {
    let creds = load_kaggle_credentials(app.clone()).await?;
    if creds.username.is_empty() || creds.key.is_empty() {
        return Err("Kaggle credentials not configured. Please set them in Settings -> Cloud Transcoder.".to_string());
    }

    let rclone_conf = resolve_rclone_config_content(&app, req.rclone_config_snippet.as_deref())?;

    let slug_suffix = sanitize_slug(&req.job_id);
    let title_source = req.output_filename.as_deref().unwrap_or(&slug_suffix);
    let jh = short_job_hash(&req.job_id);
    let new_title: String = format!("RFX T{} {}", &jh[..6], sanitize_title(title_source))
        .chars()
        .take(48)
        .collect();
    let derived_slug = sanitize_slug(&new_title);
    let kernel_slug = derived_slug.clone();
    let kernel_id = format!("{}/{}", creds.username, kernel_slug);

    let python_code = generate_transcode_script(&req, &rclone_conf);

    let payload = serde_json::json!({
        "slug": kernel_id,
        "newTitle": new_title,
        "text": python_code,
        "language": "python",
        "kernelType": "script",
        "isPrivate": true,
        "enableGpu": false,
        "enableInternet": true
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let payload_str = serde_json::to_string(&payload).map_err(|e| e.to_string())?;

    let res = client
        .post("https://www.kaggle.com/api/v1/kernels/push")
        .basic_auth(&creds.username, Some(&creds.key))
        .header("User-Agent", "RcloneFlix-Desktop/0.6")
        .header("Content-Type", "application/json")
        .body(payload_str)
        .send()
        .await
        .map_err(|e| format!("Failed to push kernel to Kaggle: {}", e))?;

    let status = res.status();
    let resp_text = res.text().await.unwrap_or_default();

    if status.is_success() {
        let mut final_slug = kernel_slug.clone();
        let mut final_ref = kernel_id.clone();
        let mut final_url = format!("https://www.kaggle.com/code/{}/{}", creds.username, kernel_slug);

        if let Ok(body) = serde_json::from_str::<serde_json::Value>(&resp_text) {
            if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
                if !err.is_empty() {
                    return Err(format!("Kaggle rejected kernel push: {}", err));
                }
            }
            if let Some(r) = body.get("ref").and_then(|v| v.as_str()) {
                if !r.trim().is_empty() {
                    final_ref = r.trim().to_string();
                    let (_, clean_slug) = parse_kaggle_user_and_slug(r, &creds.username);
                    final_slug = clean_slug;
                }
            }
            if let Some(u) = body.get("url").and_then(|v| v.as_str()) {
                if !u.trim().is_empty() {
                    final_url = u.trim().to_string();
                }
            }
        }

        log::info!(
            "[kaggle] Successfully dispatched kernel: ref={}, slug={}, url={}",
            final_ref, final_slug, final_url
        );

        Ok(KaggleDispatchResult {
            job_id: req.job_id,
            kernel_slug: final_slug,
            kernel_ref: final_ref,
            url: final_url,
            status: "queued".to_string(),
        })
    } else {
        Err(format!("Kaggle push failed ({}): {}", status, resp_text))
    }
}

fn generate_transfer_script(
    req: &KaggleTransferRequest,
    rclone_conf: &str,
) -> String {
    let b64_conf = BASE64_STANDARD.encode(rclone_conf.trim().as_bytes());

    let operation = match req.operation.to_lowercase().trim() {
        "move" => "move",
        "sync" => "sync",
        _ => "copy",
    };

    let transfers = req.transfers.unwrap_or(4);
    let checkers = req.checkers.unwrap_or(8);
    let drive_server_side = if req.drive_server_side_copy.unwrap_or(true) { "True" } else { "False" };
    let dry_run = if req.dry_run.unwrap_or(false) { "True" } else { "False" };

    let dest_lower = req.destination.trim().to_lowercase();
    let is_dest_telegram = if dest_lower.starts_with("telegram") { "True" } else { "False" };
    let is_dest_streamtape = if dest_lower.starts_with("streamtape") { "True" } else { "False" };
    let src_trim = req.source.trim();
    let is_source_url = if src_trim.starts_with("http://") || src_trim.starts_with("https://") { "True" } else { "False" };

    let tg_bot_token = req.telegram_bot_token.as_deref().unwrap_or("");
    let mut tg_chat_id = req.telegram_chat_id.as_deref().unwrap_or("").to_string();
    if tg_chat_id.is_empty() && dest_lower.starts_with("telegram:") {
        tg_chat_id = req.destination.trim()[9..].trim().to_string();
    }
    let tg_api_id = req.telegram_api_id.as_deref().unwrap_or("");
    let tg_api_hash = req.telegram_api_hash.as_deref().unwrap_or("");

    let st_login = req.streamtape_api_login.as_deref().unwrap_or("");
    let st_key = req.streamtape_api_key.as_deref().unwrap_or("");
    let st_folder = String::new();

    // Format filter rules if batch items provided
    let (filter_setup, has_batch_filter) = if let Some(items) = &req.batch_items {
        if !items.is_empty() {
            let mut filter_text = String::new();
            let src_folder = req.source.trim().split(':').nth(1).unwrap_or("").trim_matches('/');
            let folder_basename = src_folder.split('/').last().unwrap_or("");

            for item in items {
                let mut trimmed = item.trim();
                // Strip redundant folder prefix if item includes source folder name
                if !folder_basename.is_empty() {
                    let prefix_slash = format!("{}/", folder_basename);
                    if trimmed.starts_with(&prefix_slash) {
                        trimmed = &trimmed[prefix_slash.len()..];
                    }
                }
                let clean = trimmed.trim_matches('/');
                if !clean.is_empty() {
                    // Escape rclone filter glob meta-characters: [ ] * ? { }
                    let mut escaped = String::with_capacity(clean.len() * 2);
                    for c in clean.chars() {
                        match c {
                            '[' | ']' | '*' | '?' | '{' | '}' => {
                                escaped.push('\\');
                                escaped.push(c);
                            }
                            _ => escaped.push(c),
                        }
                    }
                    filter_text.push_str(&format!("+ /{escaped}\n+ /{escaped}/**\n"));
                }
            }
            filter_text.push_str("- **\n");
            let b64_filter = BASE64_STANDARD.encode(filter_text.as_bytes());
            (
                format!(
                    r#"    filter_path = os.path.expanduser("~/transfer_filter.txt")
    FILTER_DATA = base64.b64decode("""{b64_filter}""").decode("utf-8")
    with open(filter_path, "w", encoding="utf-8") as f:
        f.write(FILTER_DATA)
    cmd.extend(["--filter-from", filter_path])
    print(f"📋 Applying batch filter with {count} item rules from {{filter_path}}")"#,
                    b64_filter = b64_filter,
                    count = items.len()
                ),
                true,
            )
        } else {
            ("    pass".to_string(), false)
        }
    } else {
        ("    pass".to_string(), false)
    };

    format!(
r#"# Auto-generated RcloneFlix Cloud Offload & Transfer Worker
import os
import sys
import json
import shutil
import subprocess
import time
import base64
import urllib.request

# Force line-buffering so stdout arrives in Kaggle execution logs in real time
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

print("=" * 65)
print("🚀 RCLONEFLIX CLOUD TRANSFER WORKER INITIALIZING")
print("=" * 65)

# 1. SETUP RCLONE CONFIG
RCLONE_CONFIG_DIR = os.path.expanduser("~/.config/rclone")
os.makedirs(RCLONE_CONFIG_DIR, exist_ok=True)
rclone_conf_path = os.path.join(RCLONE_CONFIG_DIR, "rclone.conf")

RCLONE_CONFIG_DATA = base64.b64decode("""{b64_conf}""").decode("utf-8")
with open(rclone_conf_path, "w", encoding="utf-8") as f:
    f.write(RCLONE_CONFIG_DATA.strip())

# 2. SETUP PARAMETERS
SOURCE = r"""{source}"""
DESTINATION = r"""{destination}"""
OPERATION = "{operation}"
TRANSFERS = {transfers}
CHECKERS = {checkers}
DRIVE_SERVER_SIDE = {drive_server_side}
DRY_RUN = {dry_run}

IS_DEST_TELEGRAM = {is_dest_telegram}
IS_DEST_STREAMTAPE = {is_dest_streamtape}
IS_SOURCE_URL = {is_source_url}
HAS_BATCH_FILTER = {has_batch_filter}

TG_BOT_TOKEN = "{tg_bot_token}"
TG_CHAT_ID = "{tg_chat_id}"
TG_API_ID = "{tg_api_id}"
TG_API_HASH = "{tg_api_hash}"

ST_LOGIN = "{st_login}"
ST_KEY = "{st_key}"
ST_FOLDER = "{st_folder}"

STAGE_DIR = os.path.expanduser("~/stage_transfers")
os.makedirs(STAGE_DIR, exist_ok=True)

print(f"📦 SOURCE:          {{SOURCE}}")
print(f"🎯 DESTINATION:     {{DESTINATION}}")
print(f"⚙️ OPERATION:       {{OPERATION.upper()}}")
print(f"🌐 URL SOURCE:      {{IS_SOURCE_URL}}")
print(f"✈️ TELEGRAM TARGET: {{IS_DEST_TELEGRAM}}")
print(f"📼 STREAMTAPE:      {{IS_DEST_STREAMTAPE}}")
print("=" * 65 + "\n")

def ensure_rclone():
    if not shutil.which("rclone"):
        print("⚙️ Installing Rclone binary (fast direct extract)...")
        subprocess.run(
            "curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rclone.zip && "
            "unzip -q -o /tmp/rclone.zip -d /tmp/rclone_unz && "
            "cp /tmp/rclone_unz/rclone-*-linux-amd64/rclone /usr/local/bin/rclone && "
            "chmod 755 /usr/local/bin/rclone && rm -rf /tmp/rclone.zip /tmp/rclone_unz",
            shell=True,
            check=True
        )
        print("✅ Rclone ready!\n")
    else:
        print("✅ Rclone already available.\n")

def download_url_to_stage(url, dest_folder):
    os.makedirs(dest_folder, exist_ok=True)
    print(f"🌐 Fetching direct Web URL: {{url}}")
    from urllib.parse import urlparse, unquote
    parsed_u = urlparse(url)
    origin_ref = f"{{parsed_u.scheme}}://{{parsed_u.netloc}}/" if parsed_u.scheme and parsed_u.netloc else url
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    fn = os.path.basename(unquote(parsed_u.path))
    if not fn or len(fn) < 3 or "." not in fn:
        fn = f"cloud_transfer_{{int(time.time())}}.mp4"
    dest_path = os.path.join(dest_folder, fn)

    try:
        req = urllib.request.Request(url, headers={{
            "User-Agent": ua,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": origin_ref,
        }})
        with urllib.request.urlopen(req, timeout=120) as resp:
            total_size = int(resp.headers.get("Content-Length", 0))
            total_mb = round(total_size / (1024 * 1024), 2) if total_size > 0 else 0
            print(f"📥 Downloading: {{fn}} ({{total_mb}} MB)...")
            dl = 0
            last_p = [0]
            with open(dest_path, "wb") as f_out:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f_out.write(chunk)
                    dl += len(chunk)
                    now = time.time()
                    if now - last_p[0] >= 3.0 or (total_size > 0 and dl >= total_size):
                        pct = round((dl / total_size) * 100, 1) if total_size > 0 else 0
                        mb_cur = round(dl / (1024 * 1024), 1)
                        print(f"   [Download Progress] {{pct}}% ({{mb_cur}} / {{total_mb}} MB)")
                        last_p[0] = now
            print(f"✅ Download complete: {{dest_path}}\n")
            return dest_path
    except Exception as urllib_err:
        print(f"⚠️ urllib download returned {{urllib_err}}; retrying with curl -L...")
        subprocess.run([
            "curl", "-L", "--fail", "--retry", "3",
            "-A", ua, "-e", origin_ref,
            "-o", dest_path, url
        ], check=True)
        print(f"✅ Download complete via curl: {{dest_path}}\n")
        return dest_path

def apply_batch_filter(cmd):
{filter_setup}

# ─────────────────────────────────────────────────────────────────────────────
# BRANCH 1: TELEGRAM CLOUD DESTINATION
# ─────────────────────────────────────────────────────────────────────────────
if IS_DEST_TELEGRAM:
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        print("❌ Telegram Bot Token or Chat ID missing! Please configure them in Settings -> Telegram.")
        sys.exit(1)

    staged_files = []
    if IS_SOURCE_URL:
        staged_files.append(download_url_to_stage(SOURCE, STAGE_DIR))
    else:
        ensure_rclone()
        print(f"📥 Staging files from remote '{{SOURCE}}' to cloud SSD...")
        cmd = ["rclone", "copy", SOURCE, STAGE_DIR, "-P", "--transfers", "8", "--checkers", "8"]
        apply_batch_filter(cmd)
        subprocess.run(cmd, check=True)
        for root, _, files in os.walk(STAGE_DIR):
            for f in files:
                staged_files.append(os.path.join(root, f))

    if HAS_BATCH_FILTER and len(staged_files) == 0:
        print("\n❌ Cloud Transfer Failed: 0 files were staged from source (0 files matched filter rules)!")
        sys.exit(1)

    print(f"\n📋 Total items to upload to Telegram: {{len(staged_files)}}")
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "telethon", "requests"], check=False)
    import requests

    def get_dest_folder(fname):
        dest_clean = DESTINATION.strip()
        if ":" in dest_clean:
            f = dest_clean.split(":", 1)[1].strip("/").split("/")[0]
            if f and not f.endswith((".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm")):
                return f
        return "TV Shows - TD" if "s0" in fname.lower() or "season" in fname.lower() else "Movies TD"

    def upload_via_bot_api(file_path, peer_id, token):
        fn = os.path.basename(file_path)
        url = f"https://api.telegram.org/bot{{token}}/sendDocument"
        print(f"✈️ Sending via Telegram Bot HTTP API: {{fn}}...")
        try:
            with open(file_path, "rb") as f:
                resp = requests.post(
                    url,
                    data={{"chat_id": str(peer_id), "caption": f"🎬 {{fn}}"}},
                    files={{"document": (fn, f)}},
                    timeout=600
                )
            if resp.ok:
                try:
                    resp_json = resp.json()
                    bot_msg_id = (resp_json.get("result") or {{}}).get("message_id", 0)
                    folder = get_dest_folder(fn)
                    rel_path = f"{{folder}}/{{fn}}" if folder else fn
                    entry_data = {{
                        "path": f"/{{rel_path}}",
                        "name": fn,
                        "size": os.path.getsize(file_path),
                        "msgId": bot_msg_id,
                        "chatId": str(peer_id),
                        "folder": folder,
                        "remote": "telegram-drive",
                        "remotePath": f"telegram-drive:{{rel_path}}",
                        "mimeType": "video/x-matroska" if fn.lower().endswith(".mkv") else "video/mp4",
                        "mtime": int(time.time())
                    }}
                    print(f"RCLONEFLIX_TG_OFFLOAD_RESULT:{{json.dumps(entry_data)}}")
                except Exception:
                    pass
                print(f"🎉 Successfully sent to Telegram via Bot API: {{fn}}")
                return True
            else:
                print(f"❌ Telegram Bot API error: {{resp.status_code}} {{resp.text}}")
                return False
        except Exception as err:
            print(f"❌ Failed HTTP upload: {{err}}")
            return False

    target_peer = TG_CHAT_ID
    if target_peer.startswith("-") or target_peer.lstrip("+").isdigit() or target_peer.isdigit():
        try:
            target_peer = int(target_peer)
        except:
            pass

    has_custom_api = bool(TG_API_ID and TG_API_ID.strip() and TG_API_ID.strip().isdigit() and TG_API_HASH and len(TG_API_HASH.strip()) > 5)

    client = None
    if has_custom_api:
        try:
            from telethon.sync import TelegramClient
            api_id_val = int(TG_API_ID.strip())
            api_hash_val = TG_API_HASH.strip()
            print("⚙️ Connecting to Telegram MTProto with configured api_id/api_hash...")
            client = TelegramClient("tg_cloud_worker", api_id_val, api_hash_val)
            client.start(bot_token=TG_BOT_TOKEN)
            print("✅ Telethon MTProto client authenticated!")
        except Exception as e:
            print(f"⚠️ Telethon MTProto authentication failed: {{e}}")
            print("👉 Check your api_id and api_hash from https://my.telegram.org in Settings -> Telegram.")
            client = None

    index_entries = []
    index_msg_id = None
    if client is not None:
        try:
            for m in client.iter_messages(target_peer, search=".rflix_tg_index.json", limit=5):
                if m and m.document:
                    raw_idx = client.download_media(m, bytes)
                    if raw_idx:
                        parsed_idx = json.loads(raw_idx.decode("utf-8"))
                        index_entries = parsed_idx.get("entries", [])
                        index_msg_id = m.id
                        break
        except Exception as idx_err:
            print(f"⚠️ Could not load existing .rflix_tg_index.json: {{idx_err}}")

    for fp in staged_files:
        fn = os.path.basename(fp)
        sz_bytes = os.path.getsize(fp)
        sz_mb = round(sz_bytes / (1024 * 1024), 2)
        print(f"\n✈️ Preparing upload for [{{target_peer}}]: {{fn}} ({{sz_mb}} MB)...")

        uploaded = False
        sent_msg_obj = None
        if client is not None:
            try:
                last_up = [0]
                def tg_progress(cur, tot):
                    now = time.time()
                    if now - last_up[0] >= 3.0 or cur == tot:
                        pct = round((cur / tot) * 100, 1)
                        mb_c = round(cur / (1024 * 1024), 1)
                        mb_t = round(tot / (1024 * 1024), 1)
                        print(f"   [Telegram MTProto] {{pct}}% ({{mb_c}} / {{mb_t}} MB)")
                        last_up[0] = now

                sent_msg_obj = client.send_file(
                    target_peer,
                    fp,
                    caption=f"🎬 {{fn}}",
                    supports_streaming=True,
                    progress_callback=tg_progress
                )
                print(f"🎉 Successfully sent to Telegram via MTProto: {{fn}} (msg_id={{sent_msg_obj.id}})")
                uploaded = True

                folder = get_dest_folder(fn)
                rel_path = f"{{folder}}/{{fn}}" if folder else fn
                virt_path = f"/{{rel_path}}"
                index_entries = [e for e in index_entries if e.get("path") != virt_path]
                entry_data = {{
                    "path": virt_path,
                    "name": fn,
                    "size": sz_bytes,
                    "msgId": sent_msg_obj.id,
                    "chatId": str(target_peer),
                    "folder": folder,
                    "remote": "telegram-drive",
                    "remotePath": f"telegram-drive:{{rel_path}}",
                    "mimeType": "video/x-matroska" if fn.lower().endswith(".mkv") else "video/mp4",
                    "mtime": int(time.time())
                }}
                index_entries.append(entry_data)
                print(f"RCLONEFLIX_TG_OFFLOAD_RESULT:{{json.dumps(entry_data)}}")
            except Exception as e:
                print(f"⚠️ Telethon upload failed: {{e}}")

        if not uploaded:
            if sz_bytes <= 50 * 1024 * 1024:
                uploaded = upload_via_bot_api(fp, target_peer, TG_BOT_TOKEN)
            else:
                print(f"\n❌ File is {{sz_mb}} MB. Standard Telegram Bot API caps uploads at 50 MB.")
                print("💡 To upload files larger than 50MB (up to 2,000 MB / 2 GB), Telegram requires your own free API ID and API Hash from https://my.telegram.org.")
                print("👉 Please log into https://my.telegram.org, create an app, and enter your api_id and api_hash in RcloneFlix -> Settings -> Telegram.")

        if uploaded:
            try:
                os.remove(fp)
            except:
                pass

    if client and index_entries:
        try:
            idx_path = os.path.join(STAGE_DIR, ".rflix_tg_index.json")
            with open(idx_path, "w", encoding="utf-8") as idxf:
                json.dump({{
                    "version": 1,
                    "updatedAt": int(time.time()),
                    "entries": index_entries
                }}, idxf, indent=2)
            new_idx_msg = client.send_file(
                target_peer,
                idx_path,
                caption="🗂 .rflix_tg_index.json (RcloneFlix Serverless WebDAV Index)"
            )
            if index_msg_id:
                try:
                    client.delete_messages(target_peer, [index_msg_id])
                except Exception:
                    pass
            print(f"🗂 Updated .rflix_tg_index.json in Telegram channel (msg_id={{new_idx_msg.id}})")
        except Exception as idx_up_err:
            print(f"⚠️ Non-fatal: failed to update .rflix_tg_index.json: {{idx_up_err}}")

    if client:
        try:
            client.disconnect()
        except:
            pass

    if OPERATION == "move" and not IS_SOURCE_URL and not DRY_RUN:
        print(f"🗑️ Move operation requested: removing transferred source files from '{{SOURCE}}'...")
        del_cmd = ["rclone", "delete", SOURCE, "-v"]
        apply_batch_filter(del_cmd)
        subprocess.run(del_cmd, check=False)

    print("\n🎉 Cloud-to-Telegram Transfer Completed Successfully!")
    sys.exit(0)

# ─────────────────────────────────────────────────────────────────────────────
# BRANCH 2: STREAMTAPE CLOUD DESTINATION
# ─────────────────────────────────────────────────────────────────────────────
elif IS_DEST_STREAMTAPE:
    if not ST_LOGIN or not ST_KEY:
        print("❌ Streamtape API login or key missing! Please configure them in Settings -> Streamtape.")
        sys.exit(1)

    staged_files = []
    if IS_SOURCE_URL:
        staged_files.append(download_url_to_stage(SOURCE, STAGE_DIR))
    else:
        ensure_rclone()
        print(f"📥 Staging files from remote '{{SOURCE}}' to cloud SSD...")
        cmd = ["rclone", "copy", SOURCE, STAGE_DIR, "-P", "--transfers", "8", "--checkers", "8"]
        apply_batch_filter(cmd)
        subprocess.run(cmd, check=True)
        for root, _, files in os.walk(STAGE_DIR):
            for f in files:
                staged_files.append(os.path.join(root, f))

    if HAS_BATCH_FILTER and len(staged_files) == 0:
        print("\n❌ Cloud Transfer Failed: 0 files were staged from source (0 files matched filter rules)!")
        sys.exit(1)

    print(f"\n📋 Total items staged for Streamtape: {{len(staged_files)}}")
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "requests", "urllib3"], check=False)
    import requests
    import socket
    import urllib3.util.connection as urllib3_conn

    # Force IPv4 routing on Kaggle containers to prevent [Errno 101] Network is unreachable on dual-stack CDN endpoints
    try:
        def allowed_gai_family():
            return socket.AF_INET
        urllib3_conn.allowed_gai_family = allowed_gai_family
    except Exception as e:
        print(f"⚠️ Failed to force IPv4: {{e}}")

    VIDEO_EXTS = {{".mp4", ".mkv", ".avi", ".mov", ".webm", ".ts", ".m4v", ".flv", ".wmv"}}
    video_files = [fp for fp in staged_files if os.path.splitext(fp)[1].lower() in VIDEO_EXTS]
    skipped_count = len(staged_files) - len(video_files)
    if skipped_count > 0:
        print(f"ℹ️ Skipping {{skipped_count}} non-video metadata files (.nfo, subtitles, artwork) for Streamtape.")

    for fp in video_files:
        fn = os.path.basename(fp)
        sz_mb = round(os.path.getsize(fp) / (1024 * 1024), 2)
        print(f"\n📼 Requesting Streamtape upload ticket for {{fn}} ({{sz_mb}} MB)...")

        upload_success = False
        for attempt in range(1, 4):
            try:
                st_ticket_url = f"https://api.streamtape.com/file/ul?login={{ST_LOGIN}}&key={{ST_KEY}}"
                if ST_FOLDER:
                    st_ticket_url += f"&folder={{ST_FOLDER}}"
                ul_res = requests.get(st_ticket_url, timeout=30).json()
                if ul_res.get("status") != 200 or "result" not in ul_res:
                    print(f"⚠️ Ticket acquisition attempt {{attempt}}/3 error: {{ul_res}}")
                    time.sleep(3)
                    continue

                upload_url = ul_res["result"]["url"]
                print(f"🚀 Uploading {{fn}} to Streamtape cloud edge (attempt {{attempt}}/3)...")

                with open(fp, "rb") as f_data:
                    post_res = requests.post(upload_url, files={{"file": (fn, f_data)}}, timeout=600)

                resp_json = post_res.json()
                if resp_json.get("status") == 200 and "result" in resp_json:
                    res_data = resp_json["result"]
                    v_url = res_data.get("url") or f"https://streamtape.com/v/{{res_data.get('id')}}"
                    print(f"🎉 Streamtape Upload Success! Watch Link: {{v_url}}")
                    upload_success = True
                    break
                else:
                    print(f"⚠️ Streamtape API response warning: {{resp_json}}")
            except Exception as up_err:
                print(f"⚠️ Streamtape upload attempt {{attempt}}/3 error: {{up_err}}")
                time.sleep(4)

        if not upload_success:
            print(f"❌ Failed uploading {{fn}} after 3 attempts. Continuing remaining files...")

        try:
            os.remove(fp)
        except:
            pass

    if OPERATION == "move" and not IS_SOURCE_URL and not DRY_RUN:
        print(f"🗑️ Move operation requested: removing transferred source files from '{{SOURCE}}'...")
        del_cmd = ["rclone", "delete", SOURCE, "-v"]
        apply_batch_filter(del_cmd)
        subprocess.run(del_cmd, check=False)

    print("\n🎉 Cloud-to-Streamtape Transfer Pipeline Completed!")
    sys.exit(0)

# ─────────────────────────────────────────────────────────────────────────────
# BRANCH 3: WEB URL SOURCE TO REGULAR RCLONE REMOTE
# ─────────────────────────────────────────────────────────────────────────────
elif IS_SOURCE_URL:
    download_url_to_stage(SOURCE, STAGE_DIR)
    ensure_rclone()
    print(f"🚀 Uploading staged URL files to remote destination '{{DESTINATION}}'...")
    subprocess.run(["rclone", "copy", STAGE_DIR, DESTINATION, "-P", "--transfers", "4"], check=True)
    shutil.rmtree(STAGE_DIR, ignore_errors=True)
    print("\n🎉 Cloud URL-to-Remote Transfer Completed Successfully!")
    sys.exit(0)

# ─────────────────────────────────────────────────────────────────────────────
# BRANCH 4: STANDARD RCLONE-TO-RCLONE TRANSFER
# ─────────────────────────────────────────────────────────────────────────────
else:
    ensure_rclone()

    cmd = [
        "rclone", OPERATION,
        SOURCE,
        DESTINATION,
        "-P",
        "--stats", "5s",
        "--transfers", str(TRANSFERS),
        "--checkers", str(CHECKERS),
        "--buffer-size", "64M",
        "--retries", "3",
        "--low-level-retries", "10",
    ]

    if DRIVE_SERVER_SIDE:
        cmd.append("--server-side-across-configs")

    if DRY_RUN:
        cmd.append("--dry-run")

    apply_batch_filter(cmd)

    print("▶️ Executing Rclone command:")
    print(" ".join(f'\"{{c}}\"' if " " in c else c for c in cmd) + "\n")

    def run_rclone(active_cmd):
        p = subprocess.Popen(
            active_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        lines = []
        for line in p.stdout:
            print(line, end="", flush=True)
            lines.append(line)
        p.wait()
        return p.returncode, "".join(lines)

    start_t = time.time()
    rc, full_output = run_rclone(cmd)

    # Server-side copy across different providers (e.g. two crypt/WebDAV remotes on
    # different hosts) fails HARD inside rclone ("copy call failed ... 409 Conflict")
    # instead of falling back to a streamed copy. Retry once as a normal
    # download+upload through this worker.
    if rc != 0 and "--server-side-across-configs" in cmd:
        print("\n⚠️ Server-side transfer failed — retrying as a streamed transfer (without --server-side-across-configs)...\n")
        cmd = [c for c in cmd if c != "--server-side-across-configs"]
        rc, full_output = run_rclone(cmd)

    elapsed = round(time.time() - start_t, 1)

    import re
    checks_done = 0
    checks_m = re.findall(r"Checks:\s+(\d+)\s*/\s*(\d+)", full_output)
    if checks_m:
        checks_done = int(checks_m[-1][0])

    files_transferred = 0
    files_m = re.findall(r"Transferred:\s+(\d+)\s*/\s*(\d+)", full_output)
    if files_m:
        files_transferred = int(files_m[-1][0])

    bytes_transferred = 0
    bytes_m = re.findall(r"Transferred:\s+([0-9.]+)\s*([kKMGTPE]?i?B)\s*/", full_output)
    if bytes_m:
        val, unit = bytes_m[-1]
        mults = {{'B': 1, 'KIB': 1024, 'KB': 1000, 'MIB': 1024**2, 'MB': 1000**2,
                 'GIB': 1024**3, 'GB': 1000**3, 'TIB': 1024**4, 'TB': 1000**4}}
        bytes_transferred = int(float(val) * mults.get(unit.upper(), 1))

    if rc != 0:
        print(f"\n❌ Cloud Transfer exited with code {{rc}} after {{elapsed}}s")
        sys.exit(rc)

    if not DRY_RUN and HAS_BATCH_FILTER and bytes_transferred == 0 and checks_done == 0 and files_transferred == 0:
        print(f"\n❌ Cloud Transfer Failed: 0 files matched the filter rules! (Transferred: 0 B, Checks: 0/0). Nothing was copied.")
        sys.exit(1)

    print(f"\n🎉 Cloud Transfer completed successfully in {{elapsed}}s! (Transferred: {{bytes_transferred}} B, Files: {{files_transferred}}, Checks: {{checks_done}})")
    sys.exit(0)
"#,
        has_batch_filter = if has_batch_filter { "True" } else { "False" },
        b64_conf = b64_conf,
        operation = operation,
        source = req.source.trim(),
        destination = req.destination.trim(),
        transfers = transfers,
        checkers = checkers,
        drive_server_side = drive_server_side,
        dry_run = dry_run,
        is_dest_telegram = is_dest_telegram,
        is_dest_streamtape = is_dest_streamtape,
        is_source_url = is_source_url,
        tg_bot_token = tg_bot_token,
        tg_chat_id = tg_chat_id,
        tg_api_id = tg_api_id,
        tg_api_hash = tg_api_hash,
        st_login = st_login,
        st_key = st_key,
        st_folder = st_folder,
        filter_setup = filter_setup,
    )
}

#[tauri::command]
pub async fn dispatch_kaggle_transfer(
    app: AppHandle,
    req: KaggleTransferRequest,
) -> Result<KaggleDispatchResult, String> {
    let creds = load_kaggle_credentials(app.clone()).await?;
    if creds.username.is_empty() || creds.key.is_empty() {
        return Err("Kaggle credentials not configured. Please set them in Settings -> Cloud Transcoder / Transfers.".to_string());
    }

    let rclone_conf = resolve_rclone_config_content(&app, req.rclone_config_snippet.as_deref())?;
    if rclone_conf.trim().is_empty() {
        return Err("No active rclone configuration found. Please verify your rclone.conf in Settings.".to_string());
    }

    let slug_suffix = sanitize_slug(&req.job_id);
    let op_upper = req.operation.to_uppercase();
    let jh = short_job_hash(&req.job_id);
    let new_title: String = format!("RFX X{} Cloud {} {}", &jh[..6], op_upper, sanitize_title(&slug_suffix))
        .chars().take(48).collect();
    let derived_slug = sanitize_slug(&new_title);
    let kernel_slug = derived_slug.clone();
    let kernel_id = format!("{}/{}", creds.username, kernel_slug);

    let python_code = generate_transfer_script(&req, &rclone_conf);

    let payload = serde_json::json!({
        "slug": kernel_id,
        "newTitle": new_title,
        "text": python_code,
        "language": "python",
        "kernelType": "script",
        "isPrivate": true,
        "enableGpu": false,
        "enableInternet": true
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let payload_str = serde_json::to_string(&payload).map_err(|e| e.to_string())?;

    let res = client
        .post("https://www.kaggle.com/api/v1/kernels/push")
        .basic_auth(&creds.username, Some(&creds.key))
        .header("User-Agent", "RcloneFlix-Desktop/0.8")
        .header("Content-Type", "application/json")
        .body(payload_str)
        .send()
        .await
        .map_err(|e| format!("Failed to push transfer kernel to Kaggle: {}", e))?;

    let status = res.status();
    let resp_text = res.text().await.unwrap_or_default();

    if status.is_success() {
        let mut final_slug = kernel_slug.clone();
        let mut final_ref = kernel_id.clone();
        let mut final_url = format!("https://www.kaggle.com/code/{}/{}", creds.username, kernel_slug);

        if let Ok(body) = serde_json::from_str::<serde_json::Value>(&resp_text) {
            if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
                if !err.is_empty() {
                    return Err(format!("Kaggle rejected transfer kernel push: {}", err));
                }
            }
            if let Some(r) = body.get("ref").and_then(|v| v.as_str()) {
                if !r.trim().is_empty() {
                    final_ref = r.trim().to_string();
                    let (_, clean_slug) = parse_kaggle_user_and_slug(r, &creds.username);
                    final_slug = clean_slug;
                }
            }
            if let Some(u) = body.get("url").and_then(|v| v.as_str()) {
                if !u.trim().is_empty() {
                    final_url = u.trim().to_string();
                }
            }
        }

        log::info!(
            "[kaggle] Successfully dispatched transfer kernel: ref={}, slug={}, url={}",
            final_ref, final_slug, final_url
        );

        Ok(KaggleDispatchResult {
            job_id: req.job_id,
            kernel_slug: final_slug,
            kernel_ref: final_ref,
            url: final_url,
            status: "queued".to_string(),
        })
    } else {
        Err(format!("Kaggle transfer push failed ({}): {}", status, resp_text))
    }
}

#[tauri::command]
pub async fn get_kaggle_transcode_status(
    app: AppHandle,
    kernel_slug: String,
) -> Result<KaggleKernelStatus, String> {
    let creds = load_kaggle_credentials(app).await?;
    if creds.username.is_empty() || creds.key.is_empty() {
        return Err("Kaggle credentials not configured.".to_string());
    }

    let (user, slug) = parse_kaggle_user_and_slug(&kernel_slug, &creds.username);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let url = format!(
        "https://www.kaggle.com/api/v1/kernels/status?userName={}&kernelSlug={}",
        user, slug
    );
    let res = client
        .get(&url)
        .basic_auth(&creds.username, Some(&creds.key))
        .header("User-Agent", "RcloneFlix-Desktop/0.6")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch kernel status: {}", e))?;

    let status_code = res.status();
    if !status_code.is_success() {
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Kaggle status error ({}): {}", status_code, err_text));
    }

    let resp_text = res
        .text()
        .await
        .map_err(|e| format!("Failed to read status response text: {}", e))?;

    let body: serde_json::Value = serde_json::from_str(&resp_text)
        .map_err(|e| format!("Failed to parse status response JSON: {}", e))?;

    let raw_status = body
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_lowercase();

    let failure_message = body
        .get("failureMessage")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(KaggleKernelStatus {
        status: raw_status,
        failure_message,
    })
}

#[tauri::command]
pub async fn get_kaggle_transcode_output(
    app: AppHandle,
    kernel_slug: String,
) -> Result<String, String> {
    let creds = load_kaggle_credentials(app).await?;
    if creds.username.is_empty() || creds.key.is_empty() {
        return Err("Kaggle credentials not configured.".to_string());
    }

    let (user, slug) = parse_kaggle_user_and_slug(&kernel_slug, &creds.username);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let url = format!(
        "https://www.kaggle.com/api/v1/kernels/output?userName={}&kernelSlug={}",
        user, slug
    );
    let res = client
        .get(&url)
        .basic_auth(&creds.username, Some(&creds.key))
        .header("User-Agent", "RcloneFlix-Desktop/0.6")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch kernel output: {}", e))?;

    let status_code = res.status();
    if !status_code.is_success() {
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Kaggle output error ({}): {}", status_code, err_text));
    }

    let resp_text = res
        .text()
        .await
        .map_err(|e| format!("Failed to read output response text: {}", e))?;

    let body: serde_json::Value = serde_json::from_str(&resp_text)
        .map_err(|e| format!("Failed to parse output response JSON: {}", e))?;

    let log = body
        .get("log")
        .or_else(|| body.get("logNullable"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(log)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KaggleAlignRequest {
    pub job_id: String,
    pub title: String,
    pub epub_remote_path: String,
    pub audio_remote_path: String,
    pub output_remote_path: String,
    pub whisper_model: Option<String>,
    pub rclone_config_snippet: Option<String>,
}

fn generate_align_script(req: &KaggleAlignRequest, rclone_conf: &str) -> String {
    let whisper_model = req.whisper_model.as_deref().unwrap_or("small");
    let safe_conf = rclone_conf.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    let epub_remote = req.epub_remote_path.replace('"', "\\\"");
    let audio_remote = req.audio_remote_path.replace('"', "\\\"");
    let output_remote = req.output_remote_path.replace('"', "\\\"");

    format!(
r###"#!/usr/bin/env python3
import os
import sys
import subprocess
import json
import shutil
import glob
import re

print("=== RcloneFlix Cloud Whisper SMIL Alignment Worker ===")
print("Allocating Free Kaggle GPU Environment...")

# 1. Install prerequisites
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "av>=12.0.0,<19.0.0", "faster-whisper", "beautifulsoup4", "nvidia-cublas-cu12", "nvidia-cudnn-cu12"], check=True)

# Pre-load NVIDIA CUDA 12 shared libraries if present in site-packages
import ctypes
import site
for p in site.getsitepackages():
    for cublas_so in glob.glob(os.path.join(p, "nvidia", "**", "*.so*"), recursive=True):
        try:
            ctypes.CDLL(cublas_so, mode=ctypes.RTLD_GLOBAL)
        except Exception:
            pass

def ensure_rclone():
    if not shutil.which("rclone"):
        print("⚙️ Installing Rclone binary on Kaggle container...")
        subprocess.run(
            "curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rclone.zip && "
            "unzip -q -o /tmp/rclone.zip -d /tmp/rclone_unz && "
            "cp /tmp/rclone_unz/rclone-*-linux-amd64/rclone /usr/local/bin/rclone && "
            "chmod 755 /usr/local/bin/rclone && rm -rf /tmp/rclone.zip /tmp/rclone_unz",
            shell=True,
            check=True
        )
        print("✅ Rclone installed successfully!")
    else:
        print("✅ Rclone already available.")

ensure_rclone()

# 2. Configure Rclone
os.makedirs("/root/.config/rclone", exist_ok=True)
with open("/root/.config/rclone/rclone.conf", "w") as f:
    f.write("""{safe_conf}""")

# 3. Create workspace
work_dir = "/tmp/align_workspace"
os.makedirs(work_dir, exist_ok=True)
epub_in = os.path.join(work_dir, "input.epub")
audio_in = os.path.join(work_dir, "input_audio.m4b")
aligned_epub = os.path.join(work_dir, "aligned_book.epub")

print("Downloading EPUB from remote: {epub_remote}")
subprocess.run(["rclone", "copyto", "{epub_remote}", epub_in], check=True)

print("Downloading Audio from remote: {audio_remote}")
subprocess.run(["rclone", "copyto", "{audio_remote}", audio_in], check=True)

# 4. Transcribe using GPU-accelerated faster-whisper
import torch

# Patch PyAV if container environment lacks metadata_errors support in av.open
try:
    import av
    _orig_av_open = av.open
    def _safe_av_open(*args, **kwargs):
        try:
            return _orig_av_open(*args, **kwargs)
        except TypeError as err:
            if "metadata_errors" in str(err):
                kwargs.pop("metadata_errors", None)
                return _orig_av_open(*args, **kwargs)
            raise
    av.open = _safe_av_open
    if hasattr(av, "container") and hasattr(av.container, "open"):
        av.container.open = _safe_av_open
    if hasattr(av, "container") and hasattr(av.container, "core") and hasattr(av.container.core, "open"):
        av.container.core.open = _safe_av_open
except Exception as e:
    print(f"Notice on av patching: {{e}}")

from faster_whisper import WhisperModel

device = "cuda" if torch.cuda.is_available() else "cpu"
compute_type = "float16" if device == "cuda" else "int8"
print(f"Loading faster-whisper model '{whisper_model}' on {{device}} ({{compute_type}})...")
try:
    model = WhisperModel("{whisper_model}", device=device, compute_type=compute_type)
except Exception as e:
    if device == "cuda":
        print(f"⚠️ CUDA model load failed ({{e}}), falling back to CPU...")
        device = "cpu"
        compute_type = "int8"
        model = WhisperModel("{whisper_model}", device=device, compute_type=compute_type)
    else:
        raise

print("Transcribing audiobook track with word-level timing precision...")
segments, info = model.transcribe(audio_in, word_timestamps=True, vad_filter=True)

all_words = []
for segment in segments:
    if segment.words:
        for w in segment.words:
            clean_w = re.sub(r'[^\w]', '', w.word.lower())
            if clean_w:
                all_words.append(dict(word=clean_w, start=w.start, end=w.end))

print("Captured %d aligned word timestamps from audio." % len(all_words))

# 5. Unpack EPUB and inject SMIL Media Overlays
import zipfile
from bs4 import BeautifulSoup
import xml.etree.ElementTree as ET

unpacked_dir = os.path.join(work_dir, "unpacked")
os.makedirs(unpacked_dir, exist_ok=True)
with zipfile.ZipFile(epub_in, 'r') as zip_ref:
    zip_ref.extractall(unpacked_dir)

# ---- Spine-ordered chapter discovery (replaces alphabetical glob) ----
def spine_ordered_html(unpacked_dir):
    try:
        ctree = ET.parse(os.path.join(unpacked_dir, "META-INF", "container.xml"))
        rf = ctree.find(".//{{urn:oasis:names:tc:opendocument:xmlns:container}}rootfile")
        opf_path = os.path.join(unpacked_dir, rf.get("full-path"))
        ns = {{"opf": "http://www.idpf.org/2007/opf"}}
        otree = ET.parse(opf_path)
        manifest = {{i.get("id"): i.get("href") for i in otree.findall(".//opf:manifest/opf:item", ns)}}
        opf_dir = os.path.dirname(opf_path)
        out = []
        for iref in otree.findall(".//opf:spine/opf:itemref", ns):
            href = manifest.get(iref.get("idref")) or ""
            if href.lower().split("#")[0].endswith((".xhtml", ".html", ".htm")):
                p = os.path.normpath(os.path.join(opf_dir, href.split("#")[0]))
                if os.path.exists(p) and p not in out:
                    out.append(p)
        if out:
            return out
    except Exception as e:
        print(f"OPF spine parse failed ({{e}}); falling back to glob order")
    return sorted(glob.glob(os.path.join(unpacked_dir, "**", "*.xhtml"), recursive=True) +
                  glob.glob(os.path.join(unpacked_dir, "**", "*.html"), recursive=True))

html_files = spine_ordered_html(unpacked_dir)
print("Found %d chapter files in EPUB (spine order)." % len(html_files))

# ---- Anchored fuzzy alignment (replaces blind linear cursor walk) ----
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "rapidfuzz"], check=True)
from rapidfuzz import fuzz

transcript_tokens = [w["word"] for w in all_words]
PROBE_LEN = 12          # words of paragraph text used as the anchor probe
SEARCH_AHEAD = 5000     # transcript words to search forward of the cursor
SEARCH_BACK = 300       # small backward window for overshoot correction
MIN_SCORE = 72          # fuzz.ratio threshold to accept an anchor

def find_anchor(p_words, cursor):
    probe = " ".join(p_words[:PROBE_LEN])
    if len(probe) < 8:
        return None
    lo = max(0, cursor - SEARCH_BACK)
    hi = min(max(total_words - PROBE_LEN, 0), cursor + SEARCH_AHEAD)
    best_pos, best_score = None, 0
    step = max(1, PROBE_LEN // 3)
    for pos in range(lo, hi, step):
        cand = " ".join(transcript_tokens[pos:pos + PROBE_LEN])
        score = fuzz.ratio(probe, cand)
        if score > best_score:
            best_score, best_pos = score, pos
            if score >= 95:
                break
    return best_pos if best_score >= MIN_SCORE else None

smil_entries = []
word_cursor = 0
total_words = len(all_words)
matched_pars = 0
skipped_pars = 0

for h_idx, h_path in enumerate(html_files):
    base_name = os.path.basename(h_path).lower()
    if base_name.startswith(("nav.", "toc.", "cover.")):
        continue
    with open(h_path, "r", encoding="utf-8", errors="ignore") as f:
        soup = BeautifulSoup(f.read(), "html.parser")

    paragraphs = soup.find_all(["p", "h1", "h2", "h3", "li", "blockquote"])
    if not paragraphs:
        continue

    smil_pars = []
    rel_html = os.path.relpath(h_path, unpacked_dir)
    smil_fn = os.path.splitext(os.path.basename(h_path))[0] + ".smil"
    smil_path = os.path.join(os.path.dirname(h_path), smil_fn)

    for p_idx, p in enumerate(paragraphs):
        p_text = p.get_text()
        p_words = [re.sub(r'[^\w]', '', w.lower()) for w in p_text.split() if re.sub(r'[^\w]', '', w.lower())]
        if not p_words or total_words == 0:
            continue

        p_id = p.get("id")
        if not p_id:
            p_id = "rf_s_%d_%d" % (h_idx, p_idx)
            p["id"] = p_id

        anchor = find_anchor(p_words, word_cursor)
        if anchor is None:
            # Paragraph not found in narration (front matter, footnote, credits):
            # emit a zero-length clip at the current position and DO NOT advance
            # the cursor, so unnarrated text cannot cause drift.
            skipped_pars += 1
            t = all_words[min(word_cursor, total_words - 1)]["start"]
            start_time, end_time = t, t
        else:
            matched_pars += 1
            word_cursor = anchor
            start_time = all_words[min(word_cursor, total_words - 1)]["start"]
            end_idx = min(word_cursor + len(p_words), total_words) - 1
            end_time = all_words[end_idx]["end"] if end_idx >= 0 else start_time + 5.0
            word_cursor = min(word_cursor + len(p_words), total_words)

        base_h = os.path.basename(h_path)
        smil_pars.append(
            '    <par id="par_%s">\\n      <text src="%s#%s"/>\\n      <audio src="audio.m4b" clipBegin="%.3fs" clipEnd="%.3fs"/>\\n    </par>'
            % (p_id, base_h, p_id, start_time, end_time)
        )

    if smil_pars:
        # Write modified XHTML with injected IDs
        with open(h_path, "w", encoding="utf-8") as f:
            f.write(str(soup))

        # Write SMIL file
        header = '<?xml version="1.0" encoding="utf-8"?>\\n<smil xmlns="http://www.w3.org/ns/SMIL" xmlns:epub="http://www.idpf.org/2007/ops" version="3.0">\\n  <body>\\n'
        footer = '\\n  </body>\\n</smil>'
        smil_content = header + "\\n".join(smil_pars) + footer
        with open(smil_path, "w", encoding="utf-8") as f:
            f.write(smil_content)
        smil_entries.append((smil_fn, rel_html))

print("Alignment coverage: %d matched, %d skipped (unnarrated) paragraphs." % (matched_pars, skipped_pars))
if matched_pars == 0:
    print("❌ No paragraphs could be anchored to the transcript — refusing to upload a useless EPUB.")
    sys.exit(1)

# 6. Re-pack EPUB
with zipfile.ZipFile(aligned_epub, 'w') as zip_out:
    mt = os.path.join(unpacked_dir, "mimetype")
    if os.path.exists(mt):
        zip_out.write(mt, "mimetype", compress_type=zipfile.ZIP_STORED)
    for foldername, subfolders, filenames in os.walk(unpacked_dir):
        for filename in filenames:
            filepath = os.path.join(foldername, filename)
            arcname = os.path.relpath(filepath, unpacked_dir)
            if arcname == "mimetype":
                continue
            zip_out.write(filepath, arcname, compress_type=zipfile.ZIP_DEFLATED)

# 7. Upload to destination remote
print("Uploading aligned EPUB back to: {output_remote}")
subprocess.run(["rclone", "copyto", aligned_epub, "{output_remote}"], check=True)
print("=== Kaggle Whisper Alignment Succeeded! ===")
"###
    )
}

#[tauri::command]
pub async fn dispatch_kaggle_align(
    app: AppHandle,
    req: KaggleAlignRequest,
) -> Result<KaggleDispatchResult, String> {
    let creds = load_kaggle_credentials(app.clone()).await?;
    if creds.username.is_empty() || creds.key.is_empty() {
        return Err("Kaggle credentials not configured. Please set them in Settings -> Cloud Transcoder / Transfers.".to_string());
    }

    let rclone_conf = resolve_rclone_config_content(&app, req.rclone_config_snippet.as_deref())?;
    if rclone_conf.trim().is_empty() {
        return Err("No active rclone configuration found. Please verify your rclone.conf in Settings.".to_string());
    }

    let _slug_suffix = sanitize_slug(&req.job_id);
    let jh = short_job_hash(&req.title);
    let new_title: String = format!("RFX A{} Align {}", &jh[..6], sanitize_title(&req.title))
        .chars().take(48).collect();
    let derived_slug = sanitize_slug(&new_title);
    let kernel_slug = derived_slug.clone();
    let kernel_id = format!("{}/{}", creds.username, kernel_slug);

    let python_code = generate_align_script(&req, &rclone_conf);

    let payload = serde_json::json!({
        "slug": kernel_id,
        "newTitle": new_title,
        "text": python_code,
        "language": "python",
        "kernelType": "script",
        "isPrivate": true,
        "enableGpu": true,
        "enableInternet": true
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let payload_str = serde_json::to_string(&payload).map_err(|e| e.to_string())?;

    let res = client
        .post("https://www.kaggle.com/api/v1/kernels/push")
        .basic_auth(&creds.username, Some(&creds.key))
        .header("User-Agent", "RcloneFlix-Desktop/0.9")
        .header("Content-Type", "application/json")
        .body(payload_str)
        .send()
        .await
        .map_err(|e| format!("Failed to push alignment kernel to Kaggle: {}", e))?;

    let status = res.status();
    let resp_text = res.text().await.unwrap_or_default();

    if status.is_success() {
        let mut final_slug = kernel_slug.clone();
        let mut final_ref = kernel_id.clone();
        let mut final_url = format!("https://www.kaggle.com/code/{}/{}", creds.username, kernel_slug);

        if let Ok(body) = serde_json::from_str::<serde_json::Value>(&resp_text) {
            if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
                if !err.is_empty() {
                    return Err(format!("Kaggle rejected alignment kernel push: {}", err));
                }
            }
            if let Some(r) = body.get("ref").and_then(|v| v.as_str()) {
                if !r.trim().is_empty() {
                    final_ref = r.trim().to_string();
                    let (_, clean_slug) = parse_kaggle_user_and_slug(r, &creds.username);
                    final_slug = clean_slug;
                }
            }
            if let Some(u) = body.get("url").and_then(|v| v.as_str()) {
                if !u.trim().is_empty() {
                    final_url = u.trim().to_string();
                    let (_, clean_slug) = parse_kaggle_user_and_slug(u, &creds.username);
                    final_slug = clean_slug;
                }
            }
        }

        Ok(KaggleDispatchResult {
            job_id: req.job_id,
            kernel_slug: final_slug,
            kernel_ref: final_ref,
            url: final_url,
            status: "queued".to_string(),
        })
    } else {
        Err(format!("Kaggle push failed (HTTP {}): {}", status, resp_text))
    }
}

fn generate_rd_seed_script(req: &KaggleRdSeedRequest, rclone_conf: &str) -> String {
    let safe_conf = rclone_conf.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    let safe_source = req.source_input.replace('"', "\\\"");
    let safe_key = req.rd_api_key.replace('"', "\\\"");
    let safe_filename = req.filename.replace('"', "\\\"");
    let _safe_title = req.title.replace('"', "\\\"");

    format!(
r#"#!/usr/bin/env python3
import os
import sys
import subprocess
import json
import time
import shutil

print("=== RcloneFlix Cloud Real-Debrid Torrent Seeder ===")
print("Allocating Free Headless Cloud Seeding Environment...")

# 1. Install prerequisites
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "requests"], check=True)
subprocess.run("apt-get update -qq && apt-get install -y aria2 mktorrent", shell=True)

# 2. Configure Rclone
def ensure_rclone():
    if not shutil.which("rclone"):
        print("⚙️ Installing Rclone binary on container...")
        subprocess.run("curl -fsSL https://rclone.org/install.sh | bash", shell=True, check=True)
        print("✅ Rclone installed successfully!")
    else:
        print("✅ Rclone already available.")

ensure_rclone()

os.makedirs("/root/.config/rclone", exist_ok=True)
with open("/root/.config/rclone/rclone.conf", "w") as f:
    f.write("{safe_conf}")

# 3. Create workspace
work_dir = "/tmp/rd_workspace"
os.makedirs(work_dir, exist_ok=True)
target_file = os.path.join(work_dir, "{safe_filename}")
torrent_file = os.path.join(work_dir, "payload.torrent")

# 4. Fetch media file from remote or URL
source_in = "{safe_source}"
if source_in.startswith("http://") or source_in.startswith("https://"):
    print("Downloading source video via HTTP...")
    subprocess.run(["aria2c", "-s", "8", "-x", "8", "-o", "{safe_filename}", "--dir", work_dir, source_in], check=True)
else:
    print("Downloading source video from cloud remote: " + source_in)
    subprocess.run(["rclone", "copyto", source_in, target_file, "-v", "--stats", "10s"], check=True)

# 5. Create .torrent file
print("Generating BitTorrent metadata with open trackers...")
trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://tracker.torrent.eu.org:451/announce"
]
mkt_cmd = ["mktorrent"]
for trk in trackers:
    mkt_cmd.extend(["-a", trk])
mkt_cmd.extend(["-l", "22", "-o", torrent_file, target_file])

mkt_res = subprocess.run(mkt_cmd)
if mkt_res.returncode != 0:
    print("mktorrent fallback: generating torrent file in Python...")
    import hashlib
    piece_len = 4 * 1024 * 1024
    file_size = os.path.getsize(target_file)
    pieces = []
    with open(target_file, "rb") as f:
        while True:
            chunk = f.read(piece_len)
            if not chunk: break
            pieces.append(hashlib.sha1(chunk).digest())

    def bencode(obj):
        if isinstance(obj, int): return f"i{{obj}}e".encode()
        elif isinstance(obj, str): return f"{{len(obj.encode())}}:{{obj}}".encode()
        elif isinstance(obj, bytes): return f"{{len(obj)}}:".encode() + obj
        elif isinstance(obj, list): return b"l" + b"".join(bencode(x) for x in obj) + b"e"
        elif isinstance(obj, dict):
            res = b"d"
            for k in sorted(obj.keys()):
                res += bencode(k) + bencode(obj[k])
            return res + b"e"
        raise TypeError(type(obj))

    torrent_data = {{
        "announce": trackers[0],
        "announce-list": [[t] for t in trackers],
        "info": {{
            "name": "{safe_filename}",
            "piece length": piece_len,
            "pieces": b"".join(pieces),
            "length": file_size
        }}
    }}
    with open(torrent_file, "wb") as f:
        f.write(bencode(torrent_data))

print(f"Torrent file generated: {{os.path.getsize(torrent_file)}} bytes")

# 6. Push torrent to Real-Debrid
import requests

rd_key = "{safe_key}".strip()
headers = {{"Authorization": f"Bearer {{rd_key}}"}}

print("Uploading torrent metadata to Real-Debrid API...")
with open(torrent_file, "rb") as tf:
    upload_res = requests.post(
        "https://api.real-debrid.com/rest/1.0/torrents/addTorrent",
        headers=headers,
        files={{"file": tf}},
        timeout=30
    )

if upload_res.status_code not in (200, 201):
    print(f"Real-Debrid addTorrent error (HTTP {{upload_res.status_code}}): {{upload_res.text}}")
    sys.exit(1)

torrent_id = upload_res.json().get("id")
print(f"Real-Debrid Torrent Registered: {{torrent_id}}")

# Select all files in torrent
sel_res = requests.post(
    f"https://api.real-debrid.com/rest/1.0/torrents/selectFiles/{{torrent_id}}",
    headers=headers,
    data={{"files": "all"}},
    timeout=30
)
print("Real-Debrid files selected.")

# 7. Start local high-speed seeder via aria2c
print("Starting high-speed aria2c BitTorrent seeder...")
seeder_proc = subprocess.Popen([
    "aria2c",
    "--enable-dht=true",
    "--dht-listen-port=6881",
    "--listen-port=6881",
    "--seed-ratio=1.0",
    "--summary-interval=5",
    "--dir=" + work_dir,
    torrent_file
])

# 8. Poll Real-Debrid until status is downloaded (100% cached)
print("Waiting for Real-Debrid to pull from seeder and cache file...")
poll_start = time.time()
completed_info = None

while time.time() - poll_start < 1200:
    time.sleep(5)
    try:
        info_res = requests.get(
            f"https://api.real-debrid.com/rest/1.0/torrents/info/{{torrent_id}}",
            headers=headers,
            timeout=15
        )
        if info_res.status_code == 200:
            info = info_res.json()
            status = info.get("status")
            progress = info.get("progress", 0)
            seeders = info.get("seeders", 0)
            speed = info.get("speed", 0)
            print(f"RD Status: {{status}} | Progress: {{progress}}% | Speed: {{speed/1024/1024:.2f}} MB/s | Seeders: {{seeders}}")
            if status == "downloaded":
                completed_info = info
                break
            if status in ("error", "dead", "magnet_error"):
                print(f"Real-Debrid torrent entered error state: {{status}}")
                break
    except Exception as poll_err:
        print(f"Poll check warning: {{poll_err}}")

try:
    seeder_proc.terminate()
    seeder_proc.wait(timeout=5)
except Exception:
    pass

if not completed_info:
    print("Real-Debrid did not complete caching within the time limit.")
    sys.exit(1)

# 9. Unrestrict the cached link
links = completed_info.get("links", [])
if not links:
    print("Real-Debrid returned no links for completed torrent.")
    sys.exit(1)

print(f"Unrestricting direct streaming CDN link from RD link: {{links[0]}}...")
unrestrict_res = requests.post(
    "https://api.real-debrid.com/rest/1.0/unrestrict/link",
    headers=headers,
    data={{"link": links[0]}},
    timeout=30
)

if unrestrict_res.status_code != 200:
    print(f"Failed to unrestrict link: {{unrestrict_res.text}}")
    sys.exit(1)

unrestrict_data = unrestrict_res.json()
stream_url = unrestrict_data.get("download") or unrestrict_data.get("link")
print(f"=== REAL_DEBRID_STREAM_URL_START ===")
print(json.dumps({{
    "status": "complete",
    "stream_url": stream_url,
    "filename": unrestrict_data.get("filename", "{safe_filename}"),
    "filesize": unrestrict_data.get("filesize", 0),
    "torrent_id": torrent_id
}}))
print(f"=== REAL_DEBRID_STREAM_URL_END ===")

# 10. Clean up workspace
shutil.rmtree(work_dir, ignore_errors=True)
print("✅ Cleaned up local workspace. Real-Debrid seeding pipeline finished successfully!")
"#)
}

#[tauri::command]
pub async fn dispatch_kaggle_rd_seed(
    app: AppHandle,
    req: KaggleRdSeedRequest,
) -> Result<KaggleDispatchResult, String> {
    let creds = load_kaggle_credentials(app.clone()).await?;
    if creds.username.is_empty() || creds.key.is_empty() {
        return Err("Kaggle credentials not configured. Please set them in Settings -> Cloud Transcoder.".to_string());
    }

    let rclone_conf = resolve_rclone_config_content(&app, req.rclone_config_snippet.as_deref())?;

    let slug_suffix = sanitize_slug(&req.job_id);
    let jh = short_job_hash(&req.title);
    let new_title: String = format!("RFX S{} Seed {}", &jh[..6], sanitize_title(&req.title))
        .chars().take(48).collect();
    let derived_slug = sanitize_slug(&new_title);
    let kernel_slug = if derived_slug.is_empty() { format!("seed-rd-{}", slug_suffix) } else { derived_slug };
    let kernel_id = format!("{}/{}", creds.username, kernel_slug);

    let python_code = generate_rd_seed_script(&req, &rclone_conf);

    let payload = serde_json::json!({
        "slug": kernel_id,
        "newTitle": new_title,
        "text": python_code,
        "language": "python",
        "kernelType": "script",
        "isPrivate": true,
        "enableGpu": false,
        "enableInternet": true
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let payload_str = serde_json::to_string(&payload).map_err(|e| e.to_string())?;

    let res = client
        .post("https://www.kaggle.com/api/v1/kernels/push")
        .basic_auth(&creds.username, Some(&creds.key))
        .header("User-Agent", "RcloneFlix-Desktop/0.9")
        .header("Content-Type", "application/json")
        .body(payload_str)
        .send()
        .await
        .map_err(|e| format!("Failed to push RD seeding kernel to Kaggle: {}", e))?;

    let status = res.status();
    let resp_text = res.text().await.unwrap_or_default();

    if status.is_success() {
        let mut final_slug = kernel_slug.clone();
        let mut final_ref = kernel_id.clone();
        let mut final_url = format!("https://www.kaggle.com/code/{}/{}", creds.username, kernel_slug);

        if let Ok(body) = serde_json::from_str::<serde_json::Value>(&resp_text) {
            if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
                if !err.is_empty() {
                    return Err(format!("Kaggle rejected RD seeding kernel push: {}", err));
                }
            }
            if let Some(r) = body.get("ref").and_then(|v| v.as_str()) {
                if !r.trim().is_empty() {
                    final_ref = r.trim().to_string();
                    let (_, clean_slug) = parse_kaggle_user_and_slug(r, &creds.username);
                    final_slug = clean_slug;
                }
            }
            if let Some(u) = body.get("url").and_then(|v| v.as_str()) {
                if !u.trim().is_empty() {
                    final_url = u.trim().to_string();
                    let (_, clean_slug) = parse_kaggle_user_and_slug(u, &creds.username);
                    final_slug = clean_slug;
                }
            }
        }

        Ok(KaggleDispatchResult {
            job_id: req.job_id,
            kernel_slug: final_slug,
            kernel_ref: final_ref,
            url: final_url,
            status: "queued".to_string(),
        })
    } else {
        Err(format!("Kaggle RD seed push failed (HTTP {}): {}", status, resp_text))
    }
}
