# Comic Loading Speed — YACReader-Inspired Implementation Plan

**Produced by:** Claude (source study of YACReader `common/comic.cpp` / `compressed_archive/` / `YACReader/render.cpp` vs. our `archive.rs` + `ComicReaderPage.tsx`, 2026-11-16, tree at `f524cf0`)
**Audience:** Implementing AI agent. Exact anchors + complete drop-in code for every item.

**What YACReader does that we don't (and what translates to remote streaming):**
1. Extraction starts at the resume page's archive section and streams each page out via callback the moment it decompresses (`FileComic::getSections` + `fileExtracted` → `imageLoaded(page)`).
2. It extracts *only the archive indexes it needs* (`getAllData(indexes)`), never the whole archive, and keeps a decoded-image ring buffer around the cursor with the current page decoded at `TimeCriticalPriority` (`render.cpp`).
3. The library has a cover-only fast path (first image only).
4. Everything runs in-process (linked 7-Zip), never a subprocess.

Our translation, ranked by payoff: **A+B+C** (random access to *compressed non-solid* CBRs — pages in 1–2 range requests instead of the ~8 s progressive crawl), **D** (progressive path shows page 1 after ~2 MB), **E** (decode-ahead, trivial), **F** (covers), **G** (in-process CBZ, optional).

**Rules for the implementer:**
1. Read `KNOWN_BUGS_AND_FIXES.md` (esp. the comics entries) and `AGENTS.md` first.
2. After each item: `cargo check` in `src-tauri/` and/or `npx tsc --noEmit`. Both must stay clean.
3. Items A→B→C are one feature and must land together (A alone changes nothing user-visible; B without C produces entries the page fetcher can't serve).
4. The empirical harnesses still exist: `COMIC_BASE=... COMIC_FILES=... cargo test comic_stream_probe -- --nocapture --ignored` (and `progressive_comic_probe`) against `rclone serve http` of real files. Run them before claiming any item done.
5. When an item is implemented and verified, add a KNOWN_BUGS entry with real symbol names. Never mark RESOLVED from intent.
6. No version bump, no pushes unless the user asks (`AGENTS.md` §1.5).
7. If an anchor does not match the current source, STOP and report.

---

## Item A — Expose the entry header offset in the RAR scanner

**File:** `src-tauri/crates/infinidysk-archive/src/rar.rs`

The scanner already reports each entry's packed-data range, `stored`, and `solid` flags. Random access to a compressed entry additionally needs **where the entry's header block starts** (so the span `header..data_end` can be grafted onto the archive prefix). In `Scanner::next`, `self.pos` at the top of each loop iteration *is* the start of the block being parsed, so the field can be injected there without touching the RAR4/RAR5 parsers' logic.

**Edit 1** — in `pub struct Entry` (~line 39), after the `data: Range<u64>` field and its doc comment, add:

```rust
    /// Absolute offset where this entry's header block starts in the volume.
    /// `header_start..data.end` is the complete self-contained span of this entry.
    pub header_start: u64,
```

**Edit 2** — both `Entry { ... }` struct literals must initialize it (the real value is injected in Edit 3). In the RAR5 literal (~line 382, `(file & 0x1 == 0).then(|| Entry {`) and the RAR4 literal (~line 497, `let entry = (flags & 0x00e0 != 0x00e0).then(|| Entry {`), add as the first field:

```rust
                    header_start: 0, // set by Scanner::next before the entry is returned
```

**Edit 3** — in `Scanner::next` (~line 157), replace:

```rust
                Parsed::Advance(len, entry) => {
                    self.pos = self
                        .pos
                        .checked_add(len)
                        .ok_or_else(|| self.corrupt("data size"))?;
                    if let Some(entry) = entry {
                        return Ok(Step::Entry(entry));
                    }
                }
```

with:

```rust
                Parsed::Advance(len, entry) => {
                    let header_start = self.pos;
                    self.pos = self
                        .pos
                        .checked_add(len)
                        .ok_or_else(|| self.corrupt("data size"))?;
                    if let Some(mut entry) = entry {
                        entry.header_start = header_start;
                        return Ok(Step::Entry(entry));
                    }
                }
```

No other construction sites exist (verified: the only `Entry {` literals in the crate are the two above; `sevenzip.rs` has its own unrelated `Entry`). `cargo check` must pass for the whole workspace.

---

## Item B — Manifest: emit compressed non-solid CBR entries instead of bailing

**File:** `src-tauri/src/commands/archive.rs`

RAR archives are **non-solid by default** — each entry decompresses independently. Today the manifest gives up the moment any image entry is `!stored` (line ~675), sending the whole comic to the progressive full-download path. Instead, emit those entries with `compression_method: 100` plus the archive-prefix length, and only fall back for genuinely solid / encrypted / multi-volume archives.

**Edit 1** — extend the entry struct. Replace (~line 526):

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct RemoteZipPageEntry {
    pub name: String,
    pub compression_method: u16,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_header_offset: u64,
}
```

with:

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct RemoteZipPageEntry {
    pub name: String,
    /// 0 = ZIP stored, 8 = ZIP deflate, 99 = stored RAR entry (raw image bytes
    /// at local_header_offset), 100 = compressed non-solid RAR entry
    /// (local_header_offset = entry HEADER start; compressed_size = the whole
    /// header+data span; archive_prefix_len bytes from offset 0 must be
    /// prepended to form a valid single-entry archive).
    pub compression_method: u16,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_header_offset: u64,
    /// Only used by method 100. serde(default) keeps old persisted manifests valid.
    #[serde(default)]
    pub archive_prefix_len: u64,
}
```

The two existing `RemoteZipPageEntry { ... }` literals (ZIP central-directory branch and the stored-RAR branch) each gain `archive_prefix_len: 0,` as their last field.

**Edit 2** — in `fetch_remote_comic_manifest`, the RAR branch. Before the `loop {` (~line 655), the declarations currently read:

```rust
            let mut scanner = infinidysk_archive::rar::Scanner::new();
            let mut current_offset: u64 = 0;
            let mut entries = Vec::new();
```

Add one more:

```rust
            let mut archive_prefix_len: u64 = 0;
```

**Edit 3** — replace the `Step::Entry` arm (~line 673):

```rust
                    Ok(infinidysk_archive::rar::Step::Entry(entry)) => {
                        if is_comic_image_entry(&entry.name) {
                            if !entry.stored {
                                return Err("CBR archive contains compressed RAR streams; falling back to full download".to_string());
                            }
                            let packed_len = entry.data.end.saturating_sub(entry.data.start);
                            entries.push(RemoteZipPageEntry {
                                name: entry.name,
                                compression_method: 99, // 99 indicates stored RAR entry
                                compressed_size: packed_len,
                                uncompressed_size: entry.size.unwrap_or(packed_len),
                                local_header_offset: entry.data.start,
                            });
                        }
                        current_offset = entry.data.end;
                    }
```

with:

```rust
                    Ok(infinidysk_archive::rar::Step::Entry(entry)) => {
                        // Everything before the first entry header (signature, main
                        // header, service blocks) is the reusable archive prefix.
                        if archive_prefix_len == 0 {
                            archive_prefix_len = entry.header_start;
                        }
                        if is_comic_image_entry(&entry.name) {
                            if entry.encrypted || entry.split_before || entry.split_after {
                                return Err("CBR entry is encrypted or spans volumes; falling back to full extractor".to_string());
                            }
                            if entry.solid || scanner.volume().solid {
                                // Solid streams need every prior entry decompressed first —
                                // only the progressive sequential path can serve these.
                                return Err("CBR archive uses solid compression; falling back to progressive download".to_string());
                            }
                            let packed_len = entry.data.end.saturating_sub(entry.data.start);
                            if entry.stored {
                                entries.push(RemoteZipPageEntry {
                                    name: entry.name,
                                    compression_method: 99, // stored RAR entry: raw image bytes
                                    compressed_size: packed_len,
                                    uncompressed_size: entry.size.unwrap_or(packed_len),
                                    local_header_offset: entry.data.start,
                                    archive_prefix_len: 0,
                                });
                            } else {
                                // Non-solid compressed entry: YACReader-style random access.
                                // Span = header..data_end, self-contained once the prefix
                                // is prepended (extracted by Item C).
                                entries.push(RemoteZipPageEntry {
                                    name: entry.name,
                                    compression_method: 100,
                                    compressed_size: entry.data.end.saturating_sub(entry.header_start),
                                    uncompressed_size: entry.size.unwrap_or(packed_len),
                                    local_header_offset: entry.header_start,
                                    archive_prefix_len,
                                });
                            }
                        }
                        current_offset = entry.data.end;
                    }
```

No frontend change needed: `ComicReaderPage` round-trips `RemoteZipPageEntry` objects opaquely back into `fetch_remote_comic_page`.

---

## Item C — `fetch_remote_comic_page`: extract method-100 entries via a synthesized single-entry RAR

**File:** `src-tauri/src/commands/archive.rs`, in `fetch_remote_comic_page` (~line 819).

Mechanism: fetch the archive prefix (bytes `0..archive_prefix_len`) + the entry span, concatenate into a tiny `.rar` in temp, run `unrar` on it. The synthesized file has no end-of-archive block — `unrar` reports that as an error while **still extracting the complete entry** (the same tolerance `partial_extract_pages` already relies on), so exit status is ignored and success is judged by an image appearing. Solid archives never reach this path (Item B falls them back).

**Anchor:** insert directly after the `client` builder (after the `.map_err(|e| format!("HTTP client error: {}", e))?;` line) and **before** the existing `// Stored RAR entries (method 99)...` comment:

```rust
    // Compressed non-solid RAR entries (method 100): synthesize a minimal
    // single-entry archive (prefix + header/data span) and decompress just this
    // page — no full-archive download (YACReader-style selective extraction).
    if entry.compression_method == 100 {
        if entry.archive_prefix_len == 0 || entry.archive_prefix_len > 4 * 1024 * 1024 {
            return Err("Invalid CBR archive prefix length for page extraction".to_string());
        }
        let prefix_resp = client
            .get(&stream_url)
            .header("Range", format!("bytes=0-{}", entry.archive_prefix_len - 1))
            .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to fetch CBR archive prefix: {}", e))?;
        let prefix_bytes = prefix_resp.bytes().await.map_err(|e| format!("Reading CBR prefix failed: {}", e))?;

        let span_start = entry.local_header_offset;
        let span_end = span_start + entry.compressed_size.saturating_sub(1);
        let span_resp = client
            .get(&stream_url)
            .header("Range", format!("bytes={}-{}", span_start, span_end))
            .header("User-Agent", "Mozilla/5.0 RcloneFlix/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to fetch CBR page span: {}", e))?;
        let span_bytes = span_resp.bytes().await.map_err(|e| format!("Reading CBR page span failed: {}", e))?;

        // Unique temp area per (stream, entry) so concurrent prefetches never collide.
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        stream_url.hash(&mut h);
        entry.local_header_offset.hash(&mut h);
        let base = std::env::temp_dir()
            .join("rcloneflix-books")
            .join("rar-pages")
            .join(format!("{:016x}", h.finish()));
        let out_dir = base.join("out");
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("temp dir: {}", e))?;
        let rar_path = base.join("page.rar");
        std::fs::write(&rar_path, [prefix_bytes.as_ref(), span_bytes.as_ref()].concat())
            .map_err(|e| format!("temp write: {}", e))?;

        let rar_str = rar_path.to_string_lossy().into_owned();
        let out_str = out_dir.to_string_lossy().into_owned();
        // Exit status intentionally ignored: the missing end-of-archive block is
        // reported as an error even though the entry extracts fine.
        let _ = std_command("unrar").args(["x", "-y", "-inul", &rar_str, &format!("{}/", out_str)]).output();
        let mut images = Vec::new();
        collect_images_recursively(&out_dir, &mut images);
        if images.is_empty() {
            let _ = std_command("7z").args(["x", "-y", &rar_str, &format!("-o{}", out_str)]).output();
            collect_images_recursively(&out_dir, &mut images);
        }

        let result = if let Some(img) = images.first() {
            std::fs::read(img)
                .map(|bytes| {
                    format!(
                        "data:{};base64,{}",
                        mime_for_image_name(&entry.name),
                        BASE64_STANDARD.encode(&bytes)
                    )
                })
                .map_err(|e| format!("Failed reading extracted page: {}", e))
        } else {
            Err("Could not extract compressed CBR page (is unrar or 7z installed?)".to_string())
        };
        let _ = std::fs::remove_dir_all(&base);
        return result;
    }
```

**Verification (mandatory, empirical):** serve a real compressed (non-solid) `.cbr` with `rclone serve http` and run the `comic_stream_probe` harness; the manifest must now return method-100 entries instead of the "compressed RAR streams" error, and fetching page 1 and a mid-book page must each complete in a couple of seconds. Then open the same comic in the app: first page should render in ~1–3 s and jumping to any page must not trigger the progressive downloader. A **solid** test archive (`rar a -s`) must still fall back to the progressive path.

---

## Item D — Progressive path: first page after ~2 MB, backed-off rescan cadence

**File:** `src-tauri/src/commands/archive.rs`, in `start_progressive_comic_download`.

After Items A–C the progressive path only serves solid/unscannable archives, but its first-page latency is still bound by `CHUNK`(4 MB) + `EXTRACT_EVERY`(8 MB). YACReader's "current page first" ordering can't apply to solid streams (they decompress front-to-back by nature), but the cadence can: extract after the *first* small chunk, then back off.

**Edit 1** — replace (~line 332):

```rust
        const CHUNK: u64 = 4 * 1024 * 1024;
        const EXTRACT_EVERY: u64 = 8 * 1024 * 1024;
```

with:

```rust
        // First chunk + first extraction are small so page 1 appears after ~2 MB;
        // the rescan cadence then doubles up to 16 MB to keep repeated tolerant
        // extractions cheap on big archives.
        const CHUNK: u64 = 4 * 1024 * 1024;
        const FIRST_CHUNK: u64 = 2 * 1024 * 1024;
        const MAX_EXTRACT_INTERVAL: u64 = 16 * 1024 * 1024;
        let mut extract_interval: u64 = FIRST_CHUNK;
```

**Edit 2** — replace:

```rust
            let end = offset + CHUNK - 1;
```

with:

```rust
            let end = offset + (if offset == 0 { FIRST_CHUNK } else { CHUNK }) - 1;
```

**Edit 3** — replace:

```rust
            if finished || offset.saturating_sub(last_extract_at) >= EXTRACT_EVERY {
                last_extract_at = offset;
```

with:

```rust
            if finished || offset.saturating_sub(last_extract_at) >= extract_interval {
                last_extract_at = offset;
                extract_interval = (extract_interval * 2).min(MAX_EXTRACT_INTERVAL);
```

(The rest of that block is unchanged.) Verify with the `progressive_comic_probe` harness: first non-empty page list must arrive at ~2 MB downloaded (was ≥8 MB).

---

## Item E — Reader: symmetric prefetch + decode-ahead (YACReader's render buffer, in miniature)

**File:** `src/pages/player/ComicReaderPage.tsx`

Today the reader preloads only the next 1–2 pages and nothing behind, so paging backward refetches 1–2 MB from the remote despite the 16-page byte cache; and preloaded pages still pay full JPEG decode at display time. YACReader keeps a *decoded* window on both sides of the cursor.

**Anchor:** in the Single/Spread effect, replace (~line 505):

```ts
        // Preload next 2 pages in background for instant page turns
        const preloadStart = readerMode === "spread" ? currentPage + 2 : currentPage + 1;
        for (let p = preloadStart; p <= Math.min(totalPages, preloadStart + 1); p++) {
          void resolveSinglePageUrl(p).catch(() => {});
        }
```

with:

```ts
        // Preload a symmetric window and pre-rasterize (YACReader-style decode
        // buffer): next 2 pages AND the previous page, then Image.decode() so a
        // page turn lands on an already-decoded bitmap instead of paying JPEG
        // decode (hundreds of ms for 4K scans) on display.
        const preDecode = (u: string | null) => {
          if (!u) return;
          try {
            const im = new Image();
            im.src = u;
            void im.decode().catch(() => {});
          } catch {}
        };
        preDecode(primaryUrl);
        preDecode(secondaryUrl);
        const preloadStart = readerMode === "spread" ? currentPage + 2 : currentPage + 1;
        for (let p = preloadStart; p <= Math.min(totalPages, preloadStart + 1); p++) {
          void resolveSinglePageUrl(p).then(preDecode).catch(() => {});
        }
        const backPage = readerMode === "spread" ? currentPage - 2 : currentPage - 1;
        if (backPage >= 1) {
          void resolveSinglePageUrl(backPage).then(preDecode).catch(() => {});
        }
```

The ±8-page eviction window in `resolvePageUncached` already accommodates the backward preload — do not change the cache size. In-flight dedupe (`pageFetchInFlightRef`) already prevents double fetches. Smoke: page forward twice then backward — the backward turn must be instant (no network).

---

## Item F — Cover fast-path for comic library cards

**File:** `src-tauri/src/commands/archive.rs` (+ one registration line)

YACReaderLibrary extracts only the first image for covers. We get the same nearly for free by composing the two existing commands. Append after `fetch_remote_comic_page`:

```rust
/// First page only, for library/card thumbnails — never downloads the archive.
/// (YACReaderLibrary-style cover fast path.)
#[tauri::command]
pub async fn fetch_remote_comic_cover(stream_url: String) -> Result<String, String> {
    let entries = fetch_remote_comic_manifest(stream_url.clone()).await?;
    let first = entries
        .into_iter()
        .next()
        .ok_or_else(|| "No pages found in comic".to_string())?;
    fetch_remote_comic_page(stream_url, first).await
}
```

Register it in `src-tauri/src/lib.rs` directly after the line `commands::archive::fetch_remote_comic_page,` (~line 109):

```rust
            commands::archive::fetch_remote_comic_cover,
```

Frontend wiring is a separate, optional step: wherever comic cards currently render a placeholder, call `invoke("fetch_remote_comic_cover", { streamUrl })` lazily (on-visible, one at a time, cache the data-URI by item id). Do NOT call it eagerly for a whole grid — each cover costs 2–4 range requests. If no suitable card component is found, ship the command alone and note the wiring as pending; do not invent a new UI.

---

## Item G (optional, lowest priority) — In-process CBZ extraction for local files

**Files:** `src-tauri/Cargo.toml`, `src-tauri/src/commands/archive.rs`

For local/downloaded CBZs, `extract_comic_pages` shells out to `unzip` → `tar` → `python` → `7z`. YACReader links its decompressor in-process for a reason: no process spawns, one pass, and it works on Windows where `unzip`/`python` may be absent.

**Cargo.toml** (`[dependencies]`):

```toml
zip = { version = "2", default-features = false, features = ["deflate"] }
```

**Edit** — in `extract_comic_pages`, replace the whole ZIP branch (~lines 154–184, from `if is_zip_magic || lower.ends_with(".cbz") || lower.ends_with(".zip") {` through its closing `}`) with:

```rust
    if is_zip_magic || lower.ends_with(".cbz") || lower.ends_with(".zip") {
        // In-process first (no subprocess spawn; works without unzip/python —
        // notably on Windows), external tools as fallback.
        let in_process: Result<(), String> = (|| {
            let f = std::fs::File::open(&archive_path).map_err(|e| e.to_string())?;
            let mut zip = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
            for i in 0..zip.len() {
                let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
                if !entry.is_file() {
                    continue;
                }
                let name = entry.name().to_string();
                if name.contains("__MACOSX") || !is_comic_image_entry(&name) {
                    continue;
                }
                // Flatten subdirs but keep the full path in the name so the
                // natural sort below still orders pages correctly.
                let mut flat = name.replace(['/', '\\'], "_");
                flat.truncate(180);
                let out_path = dest_dir.join(flat);
                let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if in_process.is_ok() {
            let mut check = Vec::new();
            collect_images_recursively(&dest_dir, &mut check);
            extracted = !check.is_empty();
        }
        if !extracted {
            if let Ok(s) = std_command("unzip").args(["-o", "-q", &archive_path, "-d", &dest_str]).status() {
                if s.success() {
                    extracted = true;
                }
            }
        }
        if !extracted {
            let _ = std_command("tar").args(["-xf", &archive_path, "-C", &dest_str]).status();
        }
        if !extracted {
            let py_script = format!(
                "import zipfile; zipfile.ZipFile(r'''{}''').extractall(r'''{}''')",
                archive_path, dest_str
            );
            for py in ["python3", "python"] {
                if let Ok(out) = std_command(py).args(["-c", &py_script]).output() {
                    if out.status.success() {
                        extracted = true;
                        break;
                    }
                }
            }
        }
        if !extracted {
            if let Ok(out) = std_command("7z").args(["x", "-y", &archive_path, &format!("-o{}", dest_str)]).output() {
                if out.status.success() {
                    extracted = true;
                }
            }
        }
    }
```

(The RAR/universal fallback block below it is untouched.)

---

## Out of scope / rejected after study

- **YACReader's wrap-around section ordering for the progressive path**: only matters for non-solid archives, which Items A–C serve with true random access; the remaining progressive users are solid streams where front-to-back is forced.
- **In-process RAR decompression** (porting the unrar algorithm): the synthesized-archive trick in Item C gets the same result through the already-required `unrar` binary.
- **Android**: these Rust commands have no polyfill equivalents; comics-on-Android is already tracked as Item 2 of `POST_LAUNCH_DROPIN_IMPLEMENTATION.md`. Do not mix the two.

## After all items

1. `cargo check` + `npx tsc --noEmit` clean; run both `#[ignore]` comic probes against real files and quote the timings in your report.
2. KNOWN_BUGS entries with real symbols for each landed item.
3. Report honestly per item; anything skipped is listed as skipped.
