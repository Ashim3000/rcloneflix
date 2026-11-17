# RcloneFlix v1.0.2 — Pre-Launch Bugfix & Optimization Implementation Plan

**Produced by:** Claude (full line-level review, 2026-11-12, v1.0.1 tree)
**Audience:** Implementing AI agent / maintainer. Each fix has exact file anchors and drop-in code.
**Rules for the implementer (from `AGENTS.md` + handoff docs):**
1. Read `KNOWN_BUGS_AND_FIXES.md` entries #92, #154, #155, #159, #160 before starting.
2. After each fix: run `npx tsc --noEmit` (frontend) or `cargo check` in `src-tauri/` (backend).
3. When a fix is **implemented and verified**, add/update its entry in `KNOWN_BUGS_AND_FIXES.md`. Never mark RESOLVED from intent — grep for the symbol the fix introduces.
4. Package with `npx tauri build --bundles deb`, never test raw `cargo build` binaries.
5. ~~All work stays local. Never push to any remote.~~ *(Superseded 2026-11-16 — repo is public under GPL-3.0-only; see `AGENTS.md` §1.5. Never push secrets.)*

## Priority Index

| # | Sev | Area | File | Summary |
|---|-----|------|------|---------|
| F1 | CRITICAL | Playback | `src-tauri/src/commands/player.rs` | VFS full-cache regression re-introduced (bug #92 fix reverted) — root cause of slow startup on ALL remotes |
| F2 | CRITICAL | InfiniDysk | `src-tauri/src/commands/usenet_dav.rs` | Suffix Range (`bytes=-N`) served from file head — breaks MP4/MKV tail probes & seeking |
| F3 | HIGH | Playback | `src/pages/player/VideoPlayerPage.tsx` | Cloud Explorer VLC fallback dead (`sourceRef`/`localPathRef` never set) — bug #160 item 4, still open |
| F4 | HIGH | Playback | `src/pages/player/VideoPlayerPage.tsx` | 10s HTML5 stall watchdog races slow remotes — make remote-aware (bug #160 item 1) |
| F5 | HIGH | InfiniDysk | `src/components/discovery/InfiniDyskSearchModal.tsx` | Spread-order bug: playing from a library item plays the ORIGINAL file, not the usenet stream |
| F6 | HIGH | InfiniDysk | `usenet_dav.rs` + modal | Mounted NZB files are in-memory only — all bookmarks/subscription grabs 404 after app restart |
| F7 | HIGH | Whispersync | `kaggle.rs` + `cloud_worker.yml` | Whisper SMIL aligner: alphabetical chapter order + zero text anchoring = guaranteed drift |
| F8 | HIGH | Comics | `src-tauri/src/commands/archive.rs` | Non-Range servers cause silent full-archive download into memory |
| F9 | MEDIUM | Playback/Telegram | `src-tauri/src/commands/telegram.rs` | Serial chunk fetch + runaway loop (bug #159) — pipelined producer/consumer fixes both |
| F10 | MEDIUM | InfiniDysk | `usenet_dav.rs` | Missing NNTP articles silently zero-filled into the video stream |
| F11 | MEDIUM | InfiniDysk | modal | TS type mismatch: indexer health strip always shows red/undefined |
| F12 | MEDIUM | Playback | `src-tauri/src/commands/alist.rs` | AList `native_proxy` keeps triple-proxy buffering for Streamtape (bug #160 item 2) |
| F13 | MEDIUM | Cloud workers | `scripts/cloud_workers/*.py` | Scripts exit 0 even when every item failed — app poller reports success |
| F14 | LOW | Comics | `ComicReaderPage.tsx` | Unbounded page cache (base64 of every visited page held forever) |
| F15 | LOW | Comics | `archive.rs` | No ZIP64 EOCD support (CBZ > 4 GB / >65k entries fails) |
| F16 | LOW | Cloud workers | `transcode_2160p_4k.py` etc. | Streamtape upload success not actually verified |
| F17 | NOTE | Cloud workers | `cloud_worker.yml` | Full rclone.conf + tokens travel as workflow_dispatch inputs (visible in run history) |
| F18 | NOTE | Whispersync | `readalongEngine.ts` | Unchaptered-audio fallback assumes equal-length EPUB chapters |

---

## F1 — CRITICAL: Remove the re-introduced `--vfs-cache-mode full` (player.rs)

**This is the primary cause of "in-app playback is much slower than browser playback for virtually all remote backends."**

Bug #92 (v0.9.5, RESOLVED) documented that `--vfs-cache-mode full --vfs-read-chunk-size 16M` forces rclone to download 16–64 MB chunks *to local disk* before serving the first byte, causing 30–60 s startup stalls, and replaced it with lightweight in-memory streaming flags. The current tree has **regressed**: `get_or_start_serve()` re-adds the full block for every remote (colon-containing) root at `src-tauri/src/commands/player.rs:183-199`, plus `--vfs-read-ahead 32M` which aggressively competes for bandwidth on rate-limited remotes. This also slows the comic reader (F8 area) and audiobook companion streams, which all go through the same daemon pool.

**Replace lines 183–205** (the whole `if clean_remote_root.contains(':') ... else ...` block) **with:**

```rust
        // Direct in-memory streaming (KNOWN_BUGS_AND_FIXES.md #92 — do NOT
        // re-add --vfs-cache-mode full: it blocks first-byte delivery behind
        // 16-64MB disk-cache chunk downloads on rate-limited remotes).
        // Small initial chunk => fast TTFB; the limit lets rclone grow the
        // request size for sustained sequential throughput.
        cmd.args(["--buffer-size", "4M"]);
        if clean_remote_root.contains(':') && !clean_remote_root.starts_with('/') {
            cmd.args([
                "--vfs-read-chunk-size", "2M",
                "--vfs-read-chunk-size-limit", "64M",
            ]);
        }
```

**Verify:** `cargo check`; then play an `.mp4` from `opendrive:`/`gcrypt:` — time-to-first-frame should drop from tens of seconds to ~1–3 s. Confirm seeking still works (ranged reads work fine with the default cache mode off).

---

## F2 — CRITICAL: Suffix Range bug in InfiniDysk WebDAV (usenet_dav.rs)

`src-tauri/src/commands/usenet_dav.rs:502-510`. A suffix range `bytes=-65536` (used by VLC/ffmpeg/ffprobe/rclone to read the MP4 `moov` atom / MKV cues at the file tail) parses `a=""` → `unwrap_or(0)` → serves bytes **0–65536 from the head** with a 206 claiming it's the tail. Demuxers receive garbage → "cannot seek" / probe failures / broken playback on exactly the streaming path InfiniDysk exists for. (`telegram.rs::parse_byte_range` at line 1444 handles this correctly — mirror it.)

**Replace:**

```rust
                    let (start, end) = match range_hdr.as_deref().and_then(|r| r.strip_prefix("bytes=")) {
                        Some(spec) => {
                            let (a, b) = spec.split_once('-').unwrap_or((spec, ""));
                            if a.trim().is_empty() {
                                // Suffix range "bytes=-N": the LAST N bytes.
                                // Players use this to read MP4 moov / MKV cues.
                                let n = b.trim().parse::<u64>().unwrap_or(0).min(real_size);
                                (real_size.saturating_sub(n), real_size.saturating_sub(1))
                            } else {
                                let s = a.trim().parse::<u64>().unwrap_or(0);
                                let e = if b.trim().is_empty() {
                                    real_size.saturating_sub(1)
                                } else {
                                    b.trim().parse::<u64>().unwrap_or(real_size.saturating_sub(1))
                                        .min(real_size.saturating_sub(1))
                                };
                                (s, e)
                            }
                        }
                        None => (0, real_size.saturating_sub(1)),
                    };
```

**Verify:** `curl -s -H "Range: bytes=-100" http://127.0.0.1:8553/dav/<file> -D-` → `Content-Range: bytes <size-100>-<size-1>/<size>`.

---

## F3 — HIGH: Cloud Explorer VLC fallback hangs forever (VideoPlayerPage.tsx)

Bug #160 item 4, confirmed still open. In the explorer branch (`src/pages/player/VideoPlayerPage.tsx:772-789`) neither `sourceRef.current` nor `localPathRef.current` is set. When the stall watchdog or an HLS fatal error later calls `startVlcPlayback()` with no argument, `startVlcPlayback` finds `src == null && localFile == null` and returns immediately → permanent buffering spinner.

**In the explorer branch, immediately after `const activeStream = item.streamUrl || "";` and the empty-check, add** (before the `if (playback.videoEngine === "vlc" ...)` line):

```tsx
      // Arm the VLC fallback: startVlcPlayback() with no args reads these refs.
      // An http(s) URL in localPathRef is played via open_local_media →
      // vlc::Media::new_location, same as the bookmark branch (line ~747).
      const existingExp = watchProgress[item.id];
      sourceRef.current = {
        remoteRoot: "",
        relPath: activeStream,
        startMs: Math.round((resumeAt ?? existingExp?.position ?? 0) * 1000),
      };
      localPathRef.current = activeStream;
      vlcStartedRef.current = false;
```

**Verify:** `tsc --noEmit`; open a `.mkv` via Cloud Explorer preview on a slow remote → watchdog fires → VLC takes over instead of spinning.

---

## F4 — HIGH: Remote-aware HTML5 stall watchdog (VideoPlayerPage.tsx)

Bug #160 item 1. The watchdog at `VideoPlayerPage.tsx:1110-1125` is hardcoded to 10 000 ms (comment even says 3.5 s — stale). Streamtape's mandatory 5 s ticket wait + proxy hops legitimately take 9–11 s, so the watchdog cancels streams that were about to play.

**Add above the watchdog effect:**

```tsx
  // Slow remotes (cyberlocker ticket waits, MTProto round-trips, NNTP
  // assembly) legitimately take >10s to first byte — give them 28s.
  const stallTimeoutMs = useMemo(() => {
    const p = (activeVersion?.remotePath || item?.remotePath || "").toLowerCase();
    const s = (streamUrl || "").toLowerCase();
    const slowMarkers = [
      "streamtape", "tapecontent", "telegram", "tg-native", "tg-serverless",
      "usenet-drive", "udrop", ":8553", ":8552", ":5244", "dood", "mixdrop",
    ];
    return slowMarkers.some((k) => p.includes(k) || s.includes(k)) ? 28000 : 10000;
  }, [activeVersion?.remotePath, item?.remotePath, streamUrl]);
```

**Then in the effect:** replace `}, 10000);` with `}, stallTimeoutMs);`, replace the warn text with
`` console.warn(`HTML5 video stream stalled after ${stallTimeoutMs / 1000}s — falling back to native VLC`); ``,
fix the stale comment (`// HTML5 stall watchdog: remote-aware timeout, then switch to native VLC (Linux only)`), and add `stallTimeoutMs` to the effect dependency array.

---

## F5 — HIGH: InfiniDysk modal plays the wrong file for library items

`src/components/discovery/InfiniDyskSearchModal.tsx:118-131` builds `playItem` with `remotePath: streamUrl` **and then spreads `...(item || {})` last**, so when the modal was opened from a library/detail item, `item.remotePath` (the original cloud file) overwrites the usenet WebDAV URL. VideoPlayerPage then plays the original library file — the "Stream from InfiniDysk" button silently does nothing usenet-related.

**Replace the `playItem` construction in `handlePlayNzb` with (spread FIRST, overrides LAST):**

```tsx
      const playItem: MediaItem = {
        ...(item || {} as MediaItem),
        id: item?.id || `usenet-${now}`,
        libraryId: item?.libraryId || "usenet",
        libraryType: item?.libraryType || "movies",
        title: item?.title || nzb.title,
        filename: best.name,
        remotePath: streamUrl,
        streamUrl,
        sourceUrl: streamUrl, // bookmark branch resolves sourceUrl before remotePath
        addedAt: item?.addedAt || now,
        lastScannedAt: now,
        isSourceBookmark: true,
      };
```

**Verify:** open a movie's detail page → InfiniDysk Usenet → Stream; confirm network activity on port 8553 (not the original remote).

---

## F6 — HIGH: Persist mounted NZB virtual files across restarts (usenet_dav.rs)

`UsenetEngineState.files` is a plain in-memory `HashMap`. Everything the user bookmarks (`http://127.0.0.1:8553/dav/<name>` via `AddStreamBookmarkModal`) and every library item the TV-subscription engine creates from a usenet grab **404s after the next app launch**. This breaks the stated intent: a *persistent* read-only remote emulating a completed SABnzbd download directory.

**Step 1 — derive serde on the structs** (`usenet_dav.rs`, `NzbSegment` already has them):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Volume { ... }     // add Serialize, Deserialize
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Part { ... }       // add Serialize, Deserialize
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirtualFile { ... } // add Serialize, Deserialize
```

**Step 2 — add a mounts path + load on init.** In `get_usenet_engine()`, after `config_path` is built:

```rust
            let mounts_path = base.join("usenet_mounts.json");
            let initial_files: HashMap<String, VirtualFile> = std::fs::read_to_string(&mounts_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            if !initial_files.is_empty() {
                log::info!(target: "usenet", "Restored {} persisted NZB virtual files", initial_files.len());
            }
```

Add `pub mounts_path: PathBuf,` to `UsenetEngineState`, pass `files: RwLock::new(initial_files)` and `mounts_path` into the struct literal.

**Step 3 — save after every mount.** At the end of `parse_nzb_media_files`, after the `files_lock.insert` loop (while still holding the lock):

```rust
    if let Ok(json) = serde_json::to_string(&*files_lock) {
        let _ = std::fs::write(&engine.mounts_path, json);
    }
```

**Verify:** mount an NZB, restart the app, `curl -I http://127.0.0.1:8553/dav/<name>` → 200. (NZB message-ids stay valid on the provider for years; re-parsing is not needed.)

---

## F7 — HIGH: Whisper SMIL aligner — spine order + anchored matching

Applies identically to `generate_align_script()` in `src-tauri/src/commands/kaggle.rs` (~line 1796) and the `whisper_align` section of `.github/workflows/cloud_worker.yml` (~line 680). This is what separates the current output from Storyteller-grade sync. Three defects:

1. **Chapters are processed in `sorted(glob.glob(...))` order** — alphabetical, so `chapter10.xhtml` sorts before `chapter2.xhtml`. Any such EPUB gets catastrophically misaligned SMIL.
2. **Zero transcript↔text matching.** The word cursor advances linearly by the *book's* word count per paragraph. Unnarrated front matter, narrated chapter announcements, footnotes, tokenization differences — every discrepancy accumulates as permanent drift. Storyteller's core trick is fuzzy-anchoring each paragraph's opening text against the transcript; we have the word-level timestamps already, so this is a pure post-processing change.
3. **Cursor clamp bug:** `word_cursor = min(total_words - 1, word_cursor + len(p_words))` pins the cursor once the transcript is exhausted, so every later paragraph gets `start == end ==` last word.

**Drop-in replacement for the alignment portion** (Python; same code goes into both the Rust `format!` template — escape `{`/`}` as `{{`/`}}` there — and the workflow heredoc). Replace from the `html_files = sorted(glob.glob(...))` line through the end of the paragraph loop:

```python
# ---- Spine-ordered chapter discovery (replaces alphabetical glob) ----
import xml.etree.ElementTree as ET

def spine_ordered_html(unpacked_dir):
    try:
        ctree = ET.parse(os.path.join(unpacked_dir, "META-INF", "container.xml"))
        rf = ctree.find(".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile")
        opf_path = os.path.join(unpacked_dir, rf.get("full-path"))
        ns = {"opf": "http://www.idpf.org/2007/opf"}
        otree = ET.parse(opf_path)
        manifest = {i.get("id"): i.get("href") for i in otree.findall(".//opf:manifest/opf:item", ns)}
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
        print(f"OPF spine parse failed ({e}); falling back to glob order")
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
        p_words = [re.sub(r"[^\w]", "", w.lower()) for w in p_text.split() if re.sub(r"[^\w]", "", w.lower())]
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
            '    <par id="par_%s">\n      <text src="%s#%s"/>\n      <audio src="audio.m4b" clipBegin="%.3fs" clipEnd="%.3fs"/>\n    </par>'
            % (p_id, base_h, p_id, start_time, end_time)
        )

    if smil_pars:
        with open(h_path, "w", encoding="utf-8") as f:
            f.write(str(soup))
        header = '<?xml version="1.0" encoding="utf-8"?>\n<smil xmlns="http://www.w3.org/ns/SMIL" xmlns:epub="http://www.idpf.org/2007/ops" version="3.0">\n  <body>\n'
        footer = '\n  </body>\n</smil>'
        with open(smil_path, "w", encoding="utf-8") as f:
            f.write(header + "\n".join(smil_pars) + footer)
        smil_entries.append((smil_fn, rel_html))

print("Alignment coverage: %d matched, %d skipped (unnarrated) paragraphs." % (matched_pars, skipped_pars))
if matched_pars == 0:
    print("❌ No paragraphs could be anchored to the transcript — refusing to upload a useless EPUB.")
    sys.exit(1)
```

**Also fix the EPUB repack** (both places) so `mimetype` is first and STORED (spec-compliant; some readers reject otherwise):

```python
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
```

**Note on multi-file audiobooks:** the aligner downloads a single `audio_remote_path`. The in-app `CompanionAudioBar` also streams a single file. Keep the "Align via Kaggle" button restricted to single-file (`.m4b`/single `.mp3`) companions, or concatenate first — document this in the UI tooltip.

**Verify:** run one alignment on a book whose EPUB has >9 chapter files (forces the alphabetical-sort bug) and spot-check highlights at the start, middle, and end of the book in Immersion Reading.

---

## F8 — HIGH: Comics manifest must refuse non-Range servers (archive.rs)

`fetch_remote_comic_manifest` (`src-tauri/src/commands/archive.rs:343-385`) sends `Range: bytes=0-3`. If the upstream ignores Range and replies `200` with the full body, `probe_resp.bytes().await` **downloads the entire archive into memory** — the exact thing this function exists to avoid — and the same happens again on the tail fetch. Localhost rclone is safe, but direct HTTPS .cbz URLs (uDrop, odd CDNs) are not.

**After `let status = probe_resp.status();` insert:**

```rust
    if status.as_u16() == 200
        && probe_resp.headers().get(reqwest::header::CONTENT_RANGE).is_none()
    {
        // Server ignored our Range header. Reading the body here would pull
        // the entire archive into memory; bail to the full-extractor path.
        return Err("Server does not honor HTTP Range requests; falling back to full extractor".to_string());
    }
```

**And after the tail fetch** (`tail_resp`), before `.bytes()`:

```rust
    if tail_resp.status().as_u16() != 206 {
        return Err("ZIP tail fetch was not ranged (HTTP != 206); falling back".to_string());
    }
```

The `ComicReaderPage` already catches manifest errors and falls back to `download_book_to_temp` + `extract_comic_pages`, so no frontend change is needed. **Note:** F1 is also a comics fix — with the VFS full-cache regression in place, every page read through a daemon triggers a 16 MB chunk download + 32 MB read-ahead, which largely defeats "first pages without downloading the whole file."

---

## F9 — MEDIUM: Telegram pipelined streaming + runaway-loop fix (telegram.rs)

Bug #159, still open. Two issues in the stream loop at `src-tauri/src/commands/telegram.rs:1328-1359`: (a) chunks are fetched strictly serially — one 512 KiB MTProto round-trip at a time caps throughput (~14–16 Mbps); (b) the download iterator lives in the request handler, so on some disconnect patterns it keeps fetching until a write finally errors.

A bounded producer/consumer gives read-ahead (2 MiB in flight) **and** guarantees the producer dies when the consumer goes away, fixing both.

**Replace the `while remaining > 0 { ... }` loop with:**

```rust
    // Clone what the error path needs before moving the iterator into the task.
    let chat_key_for_evict = chat_id_opt
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| engine.load_creds().default_chat_id);

    // Pipelined fetch: the producer downloads MTProto chunks ahead while we
    // write to the socket (bounded channel = 4 x 512 KiB read-ahead). When the
    // consumer returns (client disconnect/seek), tx.send() fails and the
    // producer stops — this is also the fix for the runaway download loop.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(4);
    let producer = tokio::spawn(async move {
        loop {
            match download_iter.next().await {
                Ok(Some(c)) => {
                    if c.is_empty() { break; }
                    if tx.send(Ok(c)).await.is_err() { break; }
                }
                Ok(None) => break,
                Err(e) => { let _ = tx.send(Err(e.to_string())).await; break; }
            }
        }
    });

    let mut stream_err: Option<String> = None;
    while remaining > 0 {
        let chunk = match rx.recv().await {
            Some(Ok(c)) => c,
            Some(Err(e)) => { stream_err = Some(e); break; }
            None => break,
        };
        let skip = skip_leading.min(chunk.len());
        skip_leading -= skip;
        let slice = &chunk[skip..];
        if slice.is_empty() { continue; }
        let take = (remaining as usize).min(slice.len());
        if socket.write_all(&slice[..take]).await.is_err() {
            break; // Client closed connection (e.g. player seeked to a new range)
        }
        remaining -= take as u64;
    }
    producer.abort();

    if let Some(err_str) = stream_err {
        if err_str.contains("FILE_REFERENCE_EXPIRED") {
            log::warn!(target: "telegram", "FILE_REFERENCE_EXPIRED on msg #{msg_id}; evicting cache");
            engine.media_cache.write().await.remove(&(chat_key_for_evict, msg_id));
        }
        return Err(err_str.into());
    }
```

Remove the now-duplicated FILE_REFERENCE_EXPIRED handling from the old match arm. `download_iter`, `client` (if captured) and `media` must be moved into the task — `Downloadable::Media(media)` and the iterator already own their data, so only the `download_iter` binding moves. **Verify:** `cargo check`; stream a tg-native file, navigate away mid-stream, confirm `upload.getFile` log lines stop within ~2 MiB.

---

## F10 — MEDIUM: Stop zero-filling missing NNTP articles silently (usenet_dav.rs)

`read_volume` (line 241-247) and `stream_virtual_range` (line 387-389) replace any failed `BODY` fetch with `vec![0u8; seg_size]` — a missing article becomes half a megabyte of zeros spliced into the video with no log. Players glitch or demuxers desync and nobody knows why.

**Minimum fix** — retry once, then log loudly; abort header scans instead of parsing zeros:

```rust
async fn fetch_segment_with_retry(
    conn: &mut BufReader<Box<dyn NntpIo>>,
    seg: &NzbSegment,
) -> Result<Vec<u8>, String> {
    match nntp_body(conn, &seg.message_id).await {
        Ok((d, _, _)) => Ok(d),
        Err(first_err) => {
            log::warn!(target: "usenet", "BODY retry for <{}>: {}", seg.message_id, first_err);
            nntp_body(conn, &seg.message_id).await.map(|(d, _, _)| d)
        }
    }
}
```

In `read_volume` (used for RAR **header scanning** — zeros here corrupt the parse): propagate the error instead of filling:

```rust
        let data = fetch_segment_with_retry(conn, seg).await
            .map_err(|e| format!("Missing article <{}> while scanning {}: {}", seg.message_id, vol.name, e))?;
```

In `stream_virtual_range` (mid-playback): keep the filler as a last resort so playback limps on, but retry first and log:

```rust
            let data = match fetch_segment_with_retry(conn, seg).await {
                Ok(d) => d,
                Err(e) => {
                    log::error!(target: "usenet", "Article <{}> unrecoverable, zero-filling {} bytes: {}", seg.message_id, vol.seg_size, e);
                    vec![0u8; vol.seg_size as usize]
                }
            };
```

---

## F11 — MEDIUM: InfiniDysk modal type mismatches (InfiniDyskSearchModal.tsx)

The Rust `IndexerHealth` is `{ name, active, hits, error }` and `UsenetSearchResult` has `published_at` (string). The TS types at lines 20-34 expect `{ ok, count }` and `age_days` — so the indexer strip always renders red dots with `undefined releases`, and release dates never display.

**Fix the TS types and render fields:**

```tsx
type UsenetSearchResult = {
  title: string;
  nzb_url: string;
  size_bytes: number;
  published_at?: string;
  indexer: string;
  id: string;
};

type IndexerHealth = {
  name: string;
  active: boolean;
  hits: number;
  error?: string;
};
```

Then update usages: `idx.ok` → `idx.active`, `idx.count` → `idx.hits`, and replace the `res.age_days` block with:

```tsx
                          {res.published_at && (
                            <>
                              <span>&middot;</span>
                              <span>{res.published_at}</span>
                            </>
                          )}
```

---

## F12 — MEDIUM: AList Streamtape — drop the proxy hop (alist.rs)

Bug #160 item 2. `configure_streamtape_storage` (`alist.rs:197-215`) sets `webdav_policy = 'native_proxy'` and `web_proxy = 1`, so media flows Streamtape CDN → AList 8 MB chunk buffer → rclone serve → player. Switching WebDAV policy to a 302 redirect lets rclone follow straight to the `tapecontent.net` CDN link AList resolves, removing one buffering hop and one ticket-wait amplification on seeks.

**In both the INSERT values and the UPDATE SET clauses change** `'native_proxy'` → `'302_redirect'` (keep `web_proxy = 1` for the browser-facing side). Combined with F1 and F4 this closes bug #160's remediation list. **Verify with live playback** — if the rclone WebDAV backend fails on the redirect (older AList drivers mis-sign redirects, see bug #83), revert this single value; F1+F4 alone already fix the stall-race.

---

## F13 — MEDIUM: Cloud worker scripts must fail loudly (scripts/cloud_workers/*.py)

`transcode_2160p_4k.py` and `upscale_720p_to_1080p.py` track `failures` but always exit 0, so Kaggle/GHA mark the run successful and the in-app poller tells the user the transcode finished. (The GHA inline `video_transcode` job uses `check=True` and is fine.)

**At the end of `main()` in both scripts:**

```python
    if failures:
        print(f"❌ {failures} item(s) failed — reporting non-zero exit for job pollers.")
        sys.exit(1)
```

---

## F14 — LOW: Comic page cache eviction (ComicReaderPage.tsx)

`pageDataCacheRef` keeps a base64 data-URI for **every** visited page (~1.3 MB each after base64). A 300-page issue ≈ 400 MB of JS heap — kills Android. Keep a sliding window.

**In `resolveSinglePageUrl`, after each `pageDataCacheRef.current.set(pageNum, ...)` for the remote-entry and disk branches** (not the direct-web-URL branch — those are tiny strings), **add:**

```tsx
      // Sliding-window eviction: keep ~16 pages around the cursor.
      if (pageDataCacheRef.current.size > 16) {
        for (const k of pageDataCacheRef.current.keys()) {
          if (Math.abs(k - pageNum) > 8) {
            const v = pageDataCacheRef.current.get(k);
            if (v?.startsWith("blob:")) URL.revokeObjectURL(v);
            pageDataCacheRef.current.delete(k);
            if (pageDataCacheRef.current.size <= 16) break;
          }
        }
      }
```

(Webtoon mode re-requests evicted pages via its IntersectionObserver, so this is safe.)

---

## F15 — LOW: ZIP64 awareness in the comic manifest (archive.rs)

`fetch_remote_comic_manifest` reads 16-bit entry count / 32-bit `cd_offset` from the EOCD. A CBZ over 4 GB or with sentinel values (`0xFFFF` / `0xFFFFFFFF`) parses garbage offsets. Cheap guard — detect and fall back rather than implementing full ZIP64:

```rust
    let total_entries = read_u16_le(&tail_bytes, eocd + 10) as usize;
    let cd_size = read_u32_le(&tail_bytes, eocd + 12) as u64;
    let cd_offset = read_u32_le(&tail_bytes, eocd + 16) as u64;
    if total_entries == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
        return Err("ZIP64 archive detected; falling back to full extractor".to_string());
    }
```

---

## F16 — LOW: Verify Streamtape uploads actually succeeded (transcode scripts)

`upload_to_streamtape` treats `curl` exit 0 as success; curl returns 0 on HTTP 4xx/5xx without `-f`, and Streamtape returns JSON status in the body. Change the upload call in both scripts:

```python
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
```

---

## F17 — NOTE (security, decide before launch): secrets in workflow_dispatch inputs

`cloudWorkerRouter.ts` dispatches GHA jobs with `rclone_config_snippet: state.rcloneConfigContent` (full OAuth refresh tokens for every remote), Telegram bot token + api_hash, and Streamtape keys inside the `payload` input. **workflow_dispatch inputs are stored in the run's metadata and are visible to anyone with read access to the repo, indefinitely.** Private repo contains it, but one accidental collaborator/visibility flip leaks every credential. Recommended before launch:
- Move the rclone config into a GitHub Actions **repository secret** (`RCLONE_CONF_B64`) that the app updates via the Secrets API (`PUT /repos/{owner}/{repo}/actions/secrets/...` with libsodium sealed-box encryption), and have the workflow read `${{ secrets.RCLONE_CONF_B64 }}` instead of the payload field. Same for Telegram/Streamtape keys.
- At minimum, delete completed workflow runs after the poller confirms completion (`DELETE /repos/{owner}/{repo}/actions/runs/{id}` — the app already has the token and run id).

---

## F18 — NOTE: readalong linear-pacing fallback accuracy

`readalongEngine.ts:360-365` — for a single unchaptered audio file it maps chapter position as `currentChapterIndex / totalChapters`, i.e. assumes all EPUB chapters have equal word counts. Real chapters vary 5–10×, so highlighting drifts to useless mid-book. Once F7 ships, Kaggle-aligned books bypass this path entirely (SMIL mode). If you still want to improve the fallback: `EpubReaderPage` already generates epubjs *locations* — pass each spine item's location-percentage span into `attachContents` and use `(overallRatio - chapterStartPct) / chapterSpanPct` instead of the equal-span math. Low priority; do after F7.

---

## Known doc-vs-code mismatches to correct in docs (no code change)

- `PROJECT_REFERENCE_AND_CLAUDE_HANDOFF.md` §1 claims InfiniDysk does "multi-connection yEnc extraction" — the engine is **single-connection, serial**. Either implement segment pipelining (same producer/consumer pattern as F9, one connection per `connections_limit`, phase 2) or fix the doc.
- Same file says the HTML5 watchdog issue is "recommended fix" — after F3/F4 land, update entries #159/#160 in `KNOWN_BUGS_AND_FIXES.md` to RESOLVED **only after runtime verification**.
- `VideoPlayerPage.tsx:1110` comment says "3.5s" while the code was 10s — F4 rewrites it.

## Suggested implementation order

1. **F1** (one block, biggest user-visible win) → rebuild → verify startup times.
2. **F2, F3, F4, F5** (small, surgical, all launch-blocking UX).
3. **F6, F10, F11** (InfiniDysk robustness).
4. **F8, F13, F16** (safety/correctness, low risk).
5. **F7** (largest change; test on one book end-to-end before accepting).
6. **F9, F12, F14, F15** (performance/polish).
7. **F17** decision + docs cleanup.
