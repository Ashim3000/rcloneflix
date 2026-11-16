#!/usr/bin/env python3
"""
RcloneFlix Cloud Worker: 2160p (4K UHD) AV1 Transcoder
Max Resolution: 2160p (Preserves 4K UHD media in pristine 4K, downscaling only 8K+).
Encodes with modern SVT-AV1 (10-bit yuv420p10le) for high fidelity HDR/SDR compression.

Supports:
- Direct Web URLs (HTTP/HTTPS) and Rclone Remotes (e.g., 'gdrive:/Movies/Inception.mkv')
- Direct Cloud Offload destinations: Rclone remotes, Telegram MTProto (up to 2 GB), and Streamtape
- Smart dual-audio and subtitle track preservation with English prioritization
- Origin directory safeguard and batch directory expansion
- Kaggle GPU/CPU and GitHub Actions workflow execution
"""

import os
import re
import sys
import shutil
import subprocess
import json
import time
import argparse
from typing import Optional, List, Dict
from collections import deque
from urllib.parse import unquote, urlparse

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

VIDEO_EXTS = (".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".ts", ".m2ts", ".flv", ".wmv")


def setup_rclone_config(snippet: str):
    """Installs ephemeral rclone configuration if provided."""
    if not snippet.strip():
        return
    conf_dir = os.path.expanduser("~/.config/rclone")
    os.makedirs(conf_dir, exist_ok=True)
    conf_path = os.path.join(conf_dir, "rclone.conf")
    with open(conf_path, "w", encoding="utf-8") as f:
        f.write(snippet.strip())
    print("🔑 Rclone ephemeral configuration installed.")


def ensure_dependencies():
    """Installs rclone and modern ffmpeg with SVT-AV1 if missing."""
    if not shutil.which("rclone"):
        print("⚙️ Installing Rclone binary...")
        subprocess.run(
            "curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rclone.zip && "
            "unzip -q -o /tmp/rclone.zip -d /tmp/rclone_unz && "
            "cp /tmp/rclone_unz/rclone-*-linux-amd64/rclone /usr/local/bin/rclone && "
            "chmod 755 /usr/local/bin/rclone && rm -rf /tmp/rclone.zip /tmp/rclone_unz",
            shell=True,
            check=True
        )
        print("✅ Rclone ready!\n")

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe") or "libsvtav1" not in subprocess.getoutput("ffmpeg -encoders"):
        print("⚙️ Installing modern FFmpeg with SVT-AV1 (BtbN static master build)...")
        install_cmd = (
            "wget -q https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz && "
            "tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz && "
            "cp ffmpeg-master-latest-linux64-gpl/bin/ffmpeg ffmpeg-master-latest-linux64-gpl/bin/ffprobe /usr/local/bin/ && "
            "rm -rf ffmpeg-master-latest-linux64-gpl*"
        )
        subprocess.run(install_cmd, shell=True, check=True)
        print("✅ Modern FFmpeg with SVT-AV1 ready!\n")


def get_configured_remotes() -> set:
    conf_path = os.path.expanduser("~/.config/rclone/rclone.conf")
    if os.path.exists(conf_path):
        with open(conf_path, "r", encoding="utf-8") as f:
            return set(re.findall(r"^\[([^\]]+)\]", f.read(), re.MULTILINE))
    return set()


def resolve_origin_folder(source_str: str) -> Optional[str]:
    if ":" not in source_str or source_str.startswith("http://") or source_str.startswith("https://"):
        return None
    rem, rest = source_str.split(":", 1)
    if "/" in rest.rstrip("/"):
        parent = rest.rstrip("/").rsplit("/", 1)[0]
        return f"{rem}:{parent}/"
    return f"{rem}:/"


def resolve_safe_dest_folder(raw_dest: str, source_str: str, configured_remotes: set) -> str:
    cand = (raw_dest or "").strip()
    c_lower = cand.lower()
    if c_lower.startswith("telegram:") or c_lower.startswith("streamtape:") or c_lower.startswith("telegram-drive:") or c_lower.startswith("tg-native:"):
        return cand

    origin_folder = resolve_origin_folder(source_str)
    if ":" in cand and not cand.startswith("/"):
        rem_name, sub_path = cand.split(":", 1)
        rem_name = rem_name.strip()
        if rem_name.lower() in ("streamtape", "telegram", "telegram-drive", "tg-native"):
            return f"{rem_name}:"
        if rem_name in configured_remotes:
            clean_sub = sub_path.strip("/")
            return f"{rem_name}:/{clean_sub}/" if clean_sub else f"{rem_name}:/"
        print(f"⚠️ Safeguard: Destination remote '{rem_name}' not found in rclone.conf!")
    else:
        print(f"⚠️ Safeguard: Destination '{cand}' is missing a valid 'remote:' prefix!")

    if origin_folder:
        print(f"🛡️ Falling back to source origin folder: {origin_folder}")
        return origin_folder
    if "odrivecrypt" in configured_remotes:
        return "odrivecrypt:/Converted_Videos/"
    if configured_remotes:
        first_rem = sorted(list(configured_remotes))[0]
        return f"{first_rem}:/Converted_Videos/"
    return "/tmp/Converted_Videos/"


def resolve_smart_audio_and_subs(ffmpeg_input: str, is_output_mkv: bool = False):
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
        tags = s.get("tags") or {}
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
            title = ((s.get("tags") or {}).get("title") or "").lower()
            if "commentary" not in title:
                eng_audio_idx = idx
                break
            elif eng_audio_idx is None:
                eng_audio_idx = idx

    audio_flags = []
    if audio_streams:
        if eng_audio_idx is not None and eng_audio_idx > 0:
            eng_s_idx = audio_streams[eng_audio_idx].get("index", eng_audio_idx)
            print(f"🎙️ Dual Audio: Promoting English audio track (stream {eng_s_idx}) to primary default track")
            ordered_audio = [audio_streams[eng_audio_idx]] + [s for i, s in enumerate(audio_streams) if i != eng_audio_idx]
        else:
            ordered_audio = audio_streams
            if eng_audio_idx == 0:
                print("🎙️ English audio is already primary track 0")

        for out_idx, s in enumerate(ordered_audio):
            s_idx = s.get("index", out_idx)
            audio_flags.extend(["-map", f"0:{s_idx}"])
            codec = s.get("codec_name", "").lower()
            if codec in compatible_audio_codecs:
                audio_flags.extend([f"-c:a:{out_idx}", "copy"])
            else:
                audio_flags.extend([f"-c:a:{out_idx}", "aac", f"-b:a:{out_idx}", "384k"])

            if out_idx == 0:
                audio_flags.extend([f"-disposition:a:{out_idx}", "default"])
            else:
                audio_flags.extend([f"-disposition:a:{out_idx}", "0"])

            lang = ((s.get("tags") or {}).get("language") or "").strip()
            if lang:
                audio_flags.extend([f"-metadata:s:a:{out_idx}", f"language={lang}"])
            title = ((s.get("tags") or {}).get("title") or "").strip()
            if title:
                audio_flags.extend([f"-metadata:s:a:{out_idx}", f"title={title}"])
    else:
        audio_flags = ["-map", "0:a?"]

    sub_flags = []
    text_sub_codecs = ["mov_text", "subrip", "srt", "ass", "webvtt", "text"]
    compatible_subs = sub_streams if is_output_mkv else [s for s in sub_streams if s.get("codec_name", "").lower() in text_sub_codecs]

    if compatible_subs:
        eng_sub_idx = None
        for idx, s in enumerate(compatible_subs):
            if is_english(s):
                title = ((s.get("tags") or {}).get("title") or "").lower()
                disp = s.get("disposition") or {}
                is_forced = disp.get("forced") == 1
                is_signs = "signs" in title or "songs" in title
                if not is_signs and not is_forced:
                    eng_sub_idx = idx
                    break
                elif eng_sub_idx is None:
                    eng_sub_idx = idx

        if eng_sub_idx is not None:
            eng_s_sub_idx = compatible_subs[eng_sub_idx].get("index", eng_sub_idx)
            print(f"💬 Subtitle: Promoting English subtitles (stream {eng_s_sub_idx}) to default")
            ordered_subs = [compatible_subs[eng_sub_idx]] + [s for i, s in enumerate(compatible_subs) if i != eng_sub_idx]
        else:
            ordered_subs = compatible_subs

        for out_s_idx, s in enumerate(ordered_subs):
            s_idx = s.get("index", out_s_idx)
            sub_flags.extend(["-map", f"0:{s_idx}"])
            if is_output_mkv:
                sub_flags.extend([f"-c:s:{out_s_idx}", "copy"])
            else:
                sub_flags.extend([f"-c:s:{out_s_idx}", "mov_text"])

            if out_s_idx == 0 and eng_sub_idx is not None:
                sub_flags.extend([f"-disposition:s:{out_s_idx}", "default"])
            else:
                sub_flags.extend([f"-disposition:s:{out_s_idx}", "0"])

            lang = ((s.get("tags") or {}).get("language") or "").strip()
            if lang:
                sub_flags.extend([f"-metadata:s:s:{out_s_idx}", f"language={lang}"])
            title = ((s.get("tags") or {}).get("title") or "").strip()
            if title:
                sub_flags.extend([f"-metadata:s:s:{out_s_idx}", f"title={title}"])

    return audio_flags, sub_flags


def upload_to_telegram(local_file: str, output_filename: str, target_chat: str, bot_token: str, api_id: str, api_hash: str) -> bool:
    print(f"📲 Uploading 4K video {output_filename} to Telegram -> Chat ID: {target_chat}")
    use_mtproto = bool(api_id and api_hash and bot_token)

    if use_mtproto:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "telethon", "cryptg"], check=True)
        from telethon.sync import TelegramClient
        from telethon.tl.types import DocumentAttributeFilename

        try:
            client = TelegramClient("/tmp/rflix_2160p_tg", int(api_id), api_hash)
            client.start(bot_token=bot_token)

            last_up = [0]
            def tg_progress(cur, tot):
                now = time.time()
                if now - last_up[0] >= 3.0 or cur == tot:
                    pct = round((cur / tot) * 100, 1)
                    mb_c = round(cur / (1024 * 1024), 1)
                    mb_t = round(tot / (1024 * 1024), 1)
                    print(f"   [Telegram MTProto 4K] {pct}% ({mb_c} / {mb_t} MB)")
                    last_up[0] = now

            target_entity = int(target_chat) if target_chat.lstrip("-").isdigit() else target_chat
            client.send_file(
                target_entity,
                local_file,
                caption=f"🎬 {output_filename} (4K 2160p AV1 10-bit)",
                force_document=True,
                attributes=[DocumentAttributeFilename(file_name=output_filename)],
                progress_callback=tg_progress
            )
            client.disconnect()
            print("✅ Telegram MTProto 4K upload successful!")
            return True
        except Exception as e:
            print(f"❌ Telegram MTProto upload error: {e}")
            return False
    else:
        # Standard Bot API (50 MB limit)
        import urllib.request
        print("⚠️ Bot API limited to 50 MB. Using multipart HTTP...")
        # Fallback handled via curl or report
        return False


def upload_to_streamtape(local_file: str, st_login: str, st_key: str) -> bool:
    import urllib.request
    print(f"📼 Uploading 4K file to Streamtape via API...")
    try:
        req = urllib.request.urlopen(f"https://api.streamtape.com/file/ul?login={st_login}&key={st_key}", timeout=15)
        res_data = json.loads(req.read().decode())
        upload_url = res_data.get("result", {}).get("url")
        if not upload_url:
            print(f"❌ Failed to get Streamtape upload URL: {res_data}")
            return False

        up_res = subprocess.run(["curl", "-f", "-sS", "-F", f"file1=@{local_file}", upload_url],
                                capture_output=True, text=True)
        if up_res.returncode == 0:
            try:
                body = json.loads(up_res.stdout)
                if int(body.get("status", 0)) == 200:
                    print(f"✅ Streamtape upload verified: {body.get('result', {}).get('url', '')}")
                    return True
                print(f"❌ Streamtape rejected upload: {body}")
                return False
            except Exception:
                print(f"⚠️ Streamtape response not JSON: {up_res.stdout[:200]}")
                return False
        return False
    except Exception as e:
        print(f"❌ Streamtape upload error: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="RcloneFlix 2160p (4K UHD) AV1 Cloud Transcoder")
    parser.add_argument("--source", type=str, help="Source video URL or Rclone remote path")
    parser.add_argument("--dest", type=str, default="", help="Destination Rclone folder, telegram:<chat_id>, or streamtape:")
    parser.add_argument("--crf", type=int, default=26, help="AV1 Constant Rate Factor for 4K (default: 26, range 22-30)")
    parser.add_argument("--preset", type=int, default=9, help="SVT-AV1 speed preset (default: 9, range 6-10)")
    parser.add_argument("--max-height", type=int, default=2160, help="Max vertical resolution limit (default: 2160)")
    parser.add_argument("--delete-original", action="store_true", help="Delete source file upon successful transcode")
    parser.add_argument("--output-filename", type=str, default=None, help="Explicit output filename override")
    parser.add_argument("--rclone-conf", type=str, default=None, help="Path to rclone.conf or raw config string")
    parser.add_argument("--payload", type=str, help="JSON or Base64 payload string for Kaggle/GHA worker mode")

    args = parser.parse_args()

    # Defaults
    source_input = args.source or ""
    dest_folder = args.dest
    crf = args.crf
    preset = args.preset
    max_height = args.max_height
    delete_original = args.delete_original
    output_override = args.output_filename
    rclone_conf_raw = args.rclone_conf or ""

    tg_bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    tg_chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    tg_api_id = os.environ.get("TELEGRAM_API_ID", "")
    tg_api_hash = os.environ.get("TELEGRAM_API_HASH", "")
    st_login = os.environ.get("STREAMTAPE_API_LOGIN", "")
    st_key = os.environ.get("STREAMTAPE_API_KEY", "")

    # Parse Payload if present
    payload_raw = args.payload or os.environ.get("PAYLOAD", "")
    if payload_raw:
        try:
            cfg = json.loads(payload_raw)
        except Exception:
            try:
                import base64
                cfg = json.loads(base64.b64decode(payload_raw).decode("utf-8"))
            except Exception:
                cfg = {}

        source_input = cfg.get("source_input") or cfg.get("source") or source_input
        dest_folder = cfg.get("dest_remote_folder") or cfg.get("dest") or dest_folder
        crf = int(cfg.get("crf", crf))
        preset = int(cfg.get("preset", preset))
        max_height = int(cfg.get("max_height", 2160))
        delete_original = bool(cfg.get("delete_original", delete_original))
        output_override = cfg.get("output_filename") or output_override
        if "rclone_config_snippet" in cfg:
            rclone_conf_raw = cfg["rclone_config_snippet"]

        tg_bot_token = cfg.get("telegram_bot_token", tg_bot_token)
        tg_chat_id = cfg.get("telegram_chat_id", tg_chat_id)
        tg_api_id = cfg.get("telegram_api_id", tg_api_id)
        tg_api_hash = cfg.get("telegram_api_hash", tg_api_hash)
        st_login = cfg.get("streamtape_api_login", st_login)
        st_key = cfg.get("streamtape_api_key", st_key)

    print("=" * 65)
    print("🚀 RCLONEFLIX 2160p (4K UHD) AV1 TRANSCODER INITIALIZING")
    print(f"Max Resolution: {max_height}p (Preserving 4K Native Media)")
    print(f"Encoding:       SVT-AV1 10-bit (yuv420p10le) · Preset {preset} · CRF {crf}")
    print("=" * 65)

    if rclone_conf_raw:
        setup_rclone_config(rclone_conf_raw)
    ensure_dependencies()

    configured_remotes = get_configured_remotes()
    print(f"🔑 Configured Rclone Remotes: {sorted(list(configured_remotes))}")

    # Expand any directory sources
    expanded_queue = []
    is_remote = ":" in source_input and not (source_input.startswith("http://") or source_input.startswith("https://"))
    if is_remote and not source_input.lower().endswith(VIDEO_EXTS):
        print(f"📂 Scanning remote directory for video items: {source_input}")
        lsf_res = subprocess.run(["rclone", "lsf", "-R", "--files-only", source_input], capture_output=True, text=True)
        if lsf_res.returncode == 0 and lsf_res.stdout.strip():
            base_dir = source_input.rstrip("/")
            for rel in lsf_res.stdout.splitlines():
                rel = rel.strip()
                if rel.lower().endswith(VIDEO_EXTS) and not rel.lower().endswith("_av1.mp4"):
                    expanded_queue.append(f"{base_dir}/{rel}")
    if not expanded_queue:
        expanded_queue = [source_input]

    work_dir = "/kaggle/working" if os.path.exists("/kaggle/working") else "/tmp"
    is_batch = len(expanded_queue) > 1
    failures = 0

    for idx, source_str in enumerate(expanded_queue, 1):
        print("\n" + "=" * 65)
        print(f"🎬 Processing 4K Item [{idx}/{len(expanded_queue)}]: {source_str}")
        print("=" * 65)

        is_cloud_source = ":" in source_str and not (source_str.startswith("http://") or source_str.startswith("https://"))
        safe_dest = resolve_safe_dest_folder(dest_folder, source_str, configured_remotes)

        if is_cloud_source:
            source_basename = os.path.basename(source_str.rstrip("/"))
            name, ext = os.path.splitext(source_basename)
            if name.endswith("_AV1"):
                output_filename = f"{name}.mp4"
            else:
                output_filename = (output_override if (output_override and not is_batch) else f"{name}_AV1.mp4")
            if not output_filename.lower().endswith(".mp4"):
                output_filename = f"{output_filename}_AV1.mp4"
            output_filename = output_filename.replace(":", " -").replace("  ", " ")[:180]

            local_input = os.path.join(work_dir, f"temp_4k_in_{idx}{ext}")
            local_output = os.path.join(work_dir, f"out_{idx}.mp4")

            print(f"☁️ Remote Source:    {source_str}")
            print(f"🔒 Destination:      {safe_dest}{output_filename}")
            print("⬇️ Fetching source video...")
            pull_res = subprocess.run(["rclone", "copyto", source_str, local_input, "-P", "--timeout", "180s"])
            if pull_res.returncode != 0:
                print(f"❌ Failed to download source (code {pull_res.returncode})")
                failures += 1
                continue
            ffmpeg_input = local_input
            ffmpeg_reconnect = []
        else:
            path = urlparse(source_str).path
            raw_filename = os.path.basename(unquote(path))
            if not raw_filename or "." not in raw_filename:
                raw_filename = f"video_4k_{idx}.mp4"
            name, _ = os.path.splitext(raw_filename)
            output_filename = (output_override if (output_override and not is_batch) else f"{name}_AV1.mp4")
            if not output_filename.lower().endswith(".mp4"):
                output_filename = f"{output_filename}_AV1.mp4"
            output_filename = output_filename.replace(":", " -").replace("  ", " ")[:180]
            local_input = None
            local_output = os.path.join(work_dir, f"out_{idx}.mp4")
            ffmpeg_input = source_str
            ffmpeg_reconnect = ["-reconnect", "1", "-reconnect_at_eof", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]

        audio_flags, sub_flags = resolve_smart_audio_and_subs(ffmpeg_input, output_filename.lower().endswith(".mkv"))

        # 4K Max Height Scaling Filter: keeps 2160p (4K UHD) untouched, downscales 8K+, preserves 1080p
        scale_filter = f"scale=-2:'trunc(min({max_height},ih)/2)*2'"

        # SVT-AV1 10-bit command
        cmd = ["ffmpeg", "-y"] + ffmpeg_reconnect + [
            "-i", ffmpeg_input, "-map", "0:v:0?"
        ] + audio_flags + sub_flags + [
            "-vf", scale_filter,
            "-c:v", "libsvtav1",
            "-pix_fmt", "yuv420p10le",
            "-preset", str(preset),
            "-crf", str(crf),
            "-movflags", "+faststart",
            local_output
        ]

        print(f"⚡ Transcoding 4K AV1 (CRF {crf}, Preset {preset}, Max Height {max_height})...")
        process = subprocess.Popen(cmd, stderr=subprocess.PIPE, universal_newlines=True)
        err_log = deque(maxlen=30)
        for line in process.stderr:
            err_log.append(line)
            if "frame=" in line or "time=" in line or "speed=" in line:
                print(line.strip())
        process.wait()

        if local_input and os.path.exists(local_input):
            os.remove(local_input)

        if process.returncode != 0:
            print(f"❌ Transcode failed with return code {process.returncode}\n" + "".join(err_log))
            failures += 1
            continue

        out_size_mb = round(os.path.getsize(local_output) / (1024 * 1024), 2)
        print(f"✅ 4K AV1 Transcode complete! Size: {out_size_mb} MB")

        # Offload logic
        is_dest_telegram = safe_dest.lower().startswith(("telegram:", "telegram-drive:", "tg-native:"))
        is_dest_streamtape = safe_dest.lower().startswith("streamtape:")
        upload_successful = False

        if is_dest_telegram:
            target_chat = safe_dest.split(":", 1)[1].strip("/") if ":" in safe_dest else tg_chat_id
            if not target_chat:
                target_chat = tg_chat_id
            upload_successful = upload_to_telegram(local_output, output_filename, target_chat, tg_bot_token, tg_api_id, tg_api_hash)
        elif is_dest_streamtape:
            upload_successful = upload_to_streamtape(local_output, st_login, st_key)
        else:
            target_remote_file = f"{safe_dest}{output_filename}" if safe_dest.endswith(":") else f"{safe_dest.rstrip('/')}/{output_filename}"
            print(f"📤 Uploading 4K video to Rclone destination: {target_remote_file}")
            up_res = subprocess.run(["rclone", "copyto", local_output, target_remote_file, "-P"])
            upload_successful = (up_res.returncode == 0)

        if upload_successful and os.path.exists(local_output):
            os.remove(local_output)

        if upload_successful and delete_original and is_cloud_source:
            print(f"🗑️ Deleting original file: {source_str}")
            subprocess.run(["rclone", "deletefile", source_str])

    print("\n" + "=" * 65)
    print(f"🏁 2160p (4K UHD) TRANSCODE COMPLETE. Failures: {failures}/{len(expanded_queue)}")
    print("=" * 65)

    if failures:
        print(f"❌ {failures} item(s) failed — reporting non-zero exit for job pollers.")
        sys.exit(1)


if __name__ == "__main__":
    main()
