#!/usr/bin/env python3
"""
RcloneFlix Cloud Worker: FileBot-Style Mass Renamer (TV & Movies)
Standardizes naming conventions for video media in local directories or Rclone remotes.
Appends '_AV1' suffix to standardized titles for pre-transcoded / externally transcoded media.

Key Features:
- Intelligent parsing for TV Shows (e.g., 'Show Name - S01E02 - Episode Title_AV1.mp4')
- Intelligent parsing for Movies (e.g., 'Movie Title (2024)_AV1.mp4')
- Strips scene release tags, codec noise, audio badges, and release group names
- Zero-bandwidth server-side renaming for Rclone cloud remotes ('rclone moveto')
- Safe dry-run mode enabled by default; use --execute or payload {"dry_run": false} to apply
- Avoids duplicate '_AV1_AV1' suffixes and normalizes extensions
"""

import os
import re
import sys
import json
import shutil
import argparse
import subprocess
from typing import Optional, Tuple, List, Dict

VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".ts", ".m2ts", ".flv", ".wmv"}

# Common scene tags and noise tokens to strip
NOISE_PATTERNS = [
    r"\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|8k)\b",
    r"\b(bluray|blu-ray|bdrip|brrip|remux)\b",
    r"\b(web-dl|webdl|webrip|web-rip|hdtv|hdrip|dvdrip|dvd|tvrip)\b",
    r"\b(x264|x265|h264|h265|h\.264|h\.265|hevc|av1|xvid|divx|avc|vc1)\b",
    r"\b(10bit|8bit|hdr10\+|hdr10|hdr|dovi|dv|sdr)\b",
    r"\b(truehd|atmos|dts-hd\.ma|dts-hd|dts|ddp5\.1|dd5\.1|ddp|eac3|ac3|aac2\.0|aac|opus|flac|mp3)\b",
    r"\b(proper|repack|rerip|extended|unrated|directors\.cut|criterion|limited|internal)\b",
    r"\b(multi|dual-audio|dubbed|subbed|esub|ita|fre|ger|rus|spa|hindi)\b",
    r"\[[^\]]*\]",  # Bracketed release groups e.g. [Erai-raws], [YTS.MX]
    r"\([^\)]*(?:1080p|720p|2160p|bluray|x264|x265|hevc)[^\)]*\)",
]


def clean_title_string(text: str) -> str:
    """Cleans punctuation, replaces dots/underscores with spaces, and strips release noise."""
    res = text
    # Strip trailing release group if preceded by dash e.g. -SPARKS, -NTb, -DEMAND
    res = re.sub(r"-[A-Za-z0-9_]+$", "", res.strip())
    for pat in NOISE_PATTERNS:
        res = re.sub(pat, " ", res, flags=re.IGNORECASE)
    res = res.replace(".", " ").replace("_", " ").replace("-", " ")
    res = re.sub(r"\s+", " ", res).strip()
    words = res.split()
    capitalized = []
    for w in words:
        if w.upper() in {"USA", "UK", "FBI", "CIA", "SWAT", "NASA", "WWII", "WWI", "II", "III", "IV", "V", "VI"}:
            capitalized.append(w.upper())
        elif len(w) > 1 and w[0].islower():
            capitalized.append(w.capitalize())
        else:
            capitalized.append(w)
    return " ".join(capitalized)


def parse_tv_episode(stem_clean: str) -> Optional[Tuple[str, str]]:
    """Tries parsing TV episode naming patterns."""
    # Pattern 1: S01E02 or S01E02-E03 or S01E02E03
    m1 = re.match(r"^(.*?)[.\s_-]+[sS](\d{1,2})[eE](\d{1,2})(?:[-_.]?[eE](\d{1,2}))?[.\s_-]*(.*)$", stem_clean)
    if m1:
        show = clean_title_string(m1.group(1)) or "Series"
        s_num = int(m1.group(2))
        e1 = int(m1.group(3))
        e2 = int(m1.group(4)) if m1.group(4) else None
        rest = m1.group(5)
        ep_code = f"S{s_num:02d}E{e1:02d}-E{e2:02d}" if e2 else f"S{s_num:02d}E{e1:02d}"
        ep_title = clean_title_string(rest)
        if ep_title and len(ep_title) > 1 and not re.match(r"^\d+$", ep_title):
            return f"{show} - {ep_code} - {ep_title}", "tv"
        return f"{show} - {ep_code}", "tv"

    # Pattern 2: 1x02
    m2 = re.match(r"^(.*?)[.\s_-]+(\d{1,2})x(\d{1,2})[.\s_-]*(.*)$", stem_clean)
    if m2:
        show = clean_title_string(m2.group(1)) or "Series"
        s_num = int(m2.group(2))
        e_num = int(m2.group(3))
        rest = m2.group(4)
        ep_code = f"S{s_num:02d}E{e_num:02d}"
        ep_title = clean_title_string(rest)
        if ep_title and len(ep_title) > 1 and not re.match(r"^\d+$", ep_title):
            return f"{show} - {ep_code} - {ep_title}", "tv"
        return f"{show} - {ep_code}", "tv"

    # Pattern 3: Season 1 Episode 2
    m3 = re.match(r"^(.*?)[.\s_-]+[sS]eason[.\s_-]*(\d{1,2})[.\s_-]*[eE]pisode[.\s_-]*(\d{1,2})[.\s_-]*(.*)$", stem_clean)
    if m3:
        show = clean_title_string(m3.group(1)) or "Series"
        s_num = int(m3.group(2))
        e_num = int(m3.group(3))
        rest = m3.group(4)
        ep_code = f"S{s_num:02d}E{e_num:02d}"
        ep_title = clean_title_string(rest)
        if ep_title and len(ep_title) > 1 and not re.match(r"^\d+$", ep_title):
            return f"{show} - {ep_code} - {ep_title}", "tv"
        return f"{show} - {ep_code}", "tv"

    return None


def parse_standard_filename(raw_filename: str, forced_type: str = "auto", suffix: str = "_AV1") -> Tuple[str, str]:
    """
    Parses a raw video filename and returns (standardized_filename, detected_type).
    """
    stem, ext = os.path.splitext(raw_filename)
    if ext.lower() not in VIDEO_EXTS:
        return raw_filename, "non_video"

    # Check if already normalized with _AV1
    has_av1 = bool(re.search(r"(?:_av1|_AV1)$", stem, flags=re.IGNORECASE))
    stem_clean = re.sub(r"(?:_av1|_AV1)+$", "", stem, flags=re.IGNORECASE).strip()

    # 1. Check TV show patterns
    if forced_type in ("auto", "tv"):
        tv_match = parse_tv_episode(stem_clean)
        if tv_match:
            formatted_base, kind = tv_match
            new_name = f"{formatted_base}{suffix}{ext}"
            return new_name, kind

    # 2. Check Movie pattern with year (e.g. Inception 2010 or Dune Part Two (2024))
    if forced_type in ("auto", "movie"):
        m_movie = re.match(r"^(.*?)[.\s_(\[]+(19\d\d|20\d\d)[.\s_)\]]*(.*)$", stem_clean)
        if m_movie:
            title = clean_title_string(m_movie.group(1))
            year = m_movie.group(2)
            if title:
                new_name = f"{title} ({year}){suffix}{ext}"
                return new_name, "movie"

    # 3. Fallback: Clean title string directly
    cleaned = clean_title_string(stem_clean)
    if not cleaned:
        cleaned = stem_clean
    new_name = f"{cleaned}{suffix}{ext}"
    return new_name, "generic"


def rename_local_folder(folder_path: str, media_type: str, suffix: str, dry_run: bool, recursive: bool) -> List[Dict]:
    results = []
    print(f"📁 Scanning local directory: {folder_path} (recursive={recursive})")
    for root, dirs, files in os.walk(folder_path):
        for f in sorted(files):
            _, ext = os.path.splitext(f)
            if ext.lower() not in VIDEO_EXTS:
                continue

            new_name, detected_type = parse_standard_filename(f, media_type, suffix)
            old_full = os.path.join(root, f)
            new_full = os.path.join(root, new_name)

            item = {
                "old_name": f,
                "new_name": new_name,
                "type": detected_type,
                "folder": root,
                "status": "unchanged" if f == new_name else ("preview" if dry_run else "renamed")
            }

            if f != new_name:
                if dry_run:
                    print(f"  [DRY-RUN] {f}\n       ---> {new_name}")
                else:
                    try:
                        if os.path.exists(new_full):
                            print(f"  ⚠️ Skipping {f}: Target {new_name} already exists!")
                            item["status"] = "skipped_target_exists"
                        else:
                            os.rename(old_full, new_full)
                            print(f"  ✅ Renamed: {f}\n       ---> {new_name}")
                    except Exception as e:
                        print(f"  ❌ Failed to rename {f}: {e}")
                        item["status"] = f"error: {str(e)}"
            results.append(item)
        if not recursive:
            break
    return results


def rename_rclone_remote_folder(remote_path: str, media_type: str, suffix: str, dry_run: bool, recursive: bool) -> List[Dict]:
    results = []
    print(f"☁️ Scanning Rclone Remote: {remote_path} (recursive={recursive})")

    cmd = ["rclone", "lsf", "--files-only"]
    if recursive:
        cmd.append("-R")
    cmd.append(remote_path)

    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Rclone lsf failed on '{remote_path}': {res.stderr.strip()}")

    lines = [line.strip() for line in res.stdout.splitlines() if line.strip()]
    print(f"Found {len(lines)} file(s) on remote.")

    base_remote = remote_path.rstrip("/")
    for rel_path in sorted(lines):
        _, ext = os.path.splitext(rel_path)
        if ext.lower() not in VIDEO_EXTS:
            continue

        parent_dir = os.path.dirname(rel_path)
        old_filename = os.path.basename(rel_path)
        new_filename, detected_type = parse_standard_filename(old_filename, media_type, suffix)

        if parent_dir:
            old_remote_file = f"{base_remote}/{parent_dir}/{old_filename}"
            new_remote_file = f"{base_remote}/{parent_dir}/{new_filename}"
        else:
            old_remote_file = f"{base_remote}/{old_filename}"
            new_remote_file = f"{base_remote}/{new_filename}"

        item = {
            "old_name": old_filename,
            "new_name": new_filename,
            "rel_path": rel_path,
            "type": detected_type,
            "status": "unchanged" if old_filename == new_filename else ("preview" if dry_run else "renamed")
        }

        if old_filename != new_filename:
            if dry_run:
                print(f"  [DRY-RUN REMOTE] {old_filename}\n       ---> {new_filename}")
            else:
                # Fast server-side move: 0 byte transfer
                mv_cmd = ["rclone", "moveto", old_remote_file, new_remote_file]
                mv_res = subprocess.run(mv_cmd, capture_output=True, text=True)
                if mv_res.returncode == 0:
                    print(f"  ✅ [Server-Side Renamed] {old_filename}\n       ---> {new_filename}")
                else:
                    print(f"  ❌ Rclone moveto failed for {old_filename}: {mv_res.stderr.strip()}")
                    item["status"] = f"error: {mv_res.stderr.strip()}"
        results.append(item)
    return results


def main():
    parser = argparse.ArgumentParser(description="RcloneFlix FileBot-Style Mass Renamer (TV & Movies)")
    parser.add_argument("--path", type=str, help="Local directory path or Rclone remote path (e.g. gdrive:Media/Movies)")
    parser.add_argument("--type", choices=["auto", "tv", "movie"], default="auto", help="Media type (auto, tv, or movie)")
    parser.add_argument("--suffix", type=str, default="_AV1", help="Suffix to append before extension (default: _AV1)")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Simulate renames without writing changes (default: True)")
    parser.add_argument("--execute", action="store_true", help="Apply actual renames (disables dry-run)")
    parser.add_argument("--recursive", action="store_true", default=True, help="Scan subfolders recursively (default: True)")
    parser.add_argument("--payload", type=str, help="JSON or Base64 payload string (Kaggle/GHA worker mode)")

    args = parser.parse_args()

    target_path = args.path
    media_type = args.type
    suffix = args.suffix
    dry_run = not args.execute
    recursive = args.recursive

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

        if "path" in cfg:
            target_path = cfg["path"]
        if "media_type" in cfg:
            media_type = cfg["media_type"]
        if "suffix" in cfg:
            suffix = cfg["suffix"]
        if "dry_run" in cfg:
            dry_run = bool(cfg["dry_run"])
        if "execute" in cfg and cfg["execute"]:
            dry_run = False
        if "recursive" in cfg:
            recursive = bool(cfg["recursive"])

        if "rclone_config_snippet" in cfg:
            conf_dir = os.path.expanduser("~/.config/rclone")
            os.makedirs(conf_dir, exist_ok=True)
            with open(os.path.join(conf_dir, "rclone.conf"), "w", encoding="utf-8") as f:
                f.write(cfg["rclone_config_snippet"])
            print("🔑 Ephemeral rclone config installed.")

    if not target_path:
        print("❌ Error: No target path provided. Specify --path or 'path' in payload.")
        sys.exit(1)

    print("=" * 65)
    print("🏷️  RCLONEFLIX MASS MEDIA RENAMER (FILEBOT STYLE)")
    print(f"Target Path: {target_path}")
    print(f"Media Type:  {media_type}")
    print(f"Suffix:      {suffix}")
    print(f"Mode:        {'🔍 DRY RUN (Preview Only)' if dry_run else '⚡ EXECUTE (Applying Changes)'}")
    print("=" * 65)

    is_remote = ":" in target_path and not (target_path.startswith("http://") or target_path.startswith("https://"))

    if is_remote:
        results = rename_rclone_remote_folder(target_path, media_type, suffix, dry_run, recursive)
    else:
        results = rename_local_folder(target_path, media_type, suffix, dry_run, recursive)

    total = len(results)
    changed = len([r for r in results if r["status"] in ("preview", "renamed")])
    unchanged = len([r for r in results if r["status"] == "unchanged"])
    errors = len([r for r in results if "error" in r["status"]])

    print("\n" + "=" * 65)
    print("📊 RENAMING SUMMARY")
    print(f"Total Videos Scanned: {total}")
    print(f"Renamed / Identified: {changed}")
    print(f"Already Standardized: {unchanged}")
    print(f"Errors / Skipped:     {errors}")
    print("=" * 65)


if __name__ == "__main__":
    main()
