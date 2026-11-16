# RcloneFlix v1.0.3 Feature Audit & Gap Analysis

> [!IMPORTANT]
> **Fix log 2026-11-14** (in source, pending rebuild/reinstall):
> - **§1.1 FIXED** — `parse_nzb_media_files` now junk-filters (.par2/.nfo/.sfv/samples) before probing, probes first segments concurrently over an NNTP connection pool (`connections_limit`, default 4, max 8), skips members with missing articles instead of aborting the mount, and magic-sniffs RAR/MKV/MP4/AVI signatures for obfuscated release names.
> - **§1.2 FIXED** — `VirtualFile.virtual_path` + new `virtualDir` param; PROPFIND is now path- and Depth-aware with synthesized category collections (`/TV Shows/<Show>/Season N`, `/Movies`, …); GET/HEAD resolve hierarchical paths with basename fallback for legacy flat URLs; per-extension Content-Type replaces hardcoded `video/mp4`. InfiniDyskSearchModal, tvSubscriptionEngine and SettingsPage pass/use category paths.
> - **§1.3 DEFERRED** to the v1.0.3 plan §24 queue (cloud workers need an NNTP client + yEnc + unrar — a designed feature, not a bug fix).
> - **§2.1 FIXED** — root cause corrected: `--color-accent` *is* valid space-separated channels; the real issue is Canvas 2D `fillStyle` can never resolve `var()` (invalid assignments are silently ignored → default black). `SpectrumCanvas` now resolves the computed channels per frame (`getComputedStyle`), so bars render in the live accent theme on all platforms.
> - **§2.2 FIXED** — `@keyframes spin-slow` + `.animate-spin-slow` (12s linear) added to `index.css` ahead of the existing reduced-motion reset; playing album art/disc icons now rotate.
> - **§2.3 FIXED** — Vinyl Mode toggle added to the Music Skin utility row (persisted in `localStorage: rcloneflix_vinyl_mode`); `AudioMiniPlayer` fires `playNeedleDropEffect()` on each music track start when enabled (audiobooks excluded). Standalone AudioContext, so it works on Linux desktop.
> - **§2.4 FIXED** — new **Notes** tab in `MusicSkinShell` (`musicSkinTab: "notes"`) calling the existing `fetchAlbumLinerNotes()` for the current track's album: header/label/date, Personnel & Production credits, and tracklist. Booklet scanning stays exclusive to the full Music Library page (needs album-dir access).
> - **Comics CBR full-download bug FIXED** (not in this audit; original launch-review concern #2): `fetch_remote_comic_manifest` probed only 4 bytes but `infinidysk_archive::detect()` matches 7/8-byte RAR signatures via `starts_with`, so every .cbr silently fell back to full download. Probe is now 16 bytes; stored CBRs range-stream like CBZs.
> - **Comics follow-up (2026-11-14, from live testing):** empirical probe against the real library (rclone serve http → drivemine) showed (a) most scene CBRs are *compressed* RAR — not range-streamable by nature — and (b) the Drive remote delivers only ~250–650 KB/s with 3–9 s per ranged request, so even streaming books took 3–25 s **per page**. Fixes: new **progressive comic pipeline** (`start_progressive_comic_download` / `comic_progressive_status` / `cancel_progressive_comic` in archive.rs) — sequential 4 MB ranged chunks to temp + tolerant `unrar x -o-` partial extraction every 8 MB, reader polls and shows pages as they unpack (measured: first 16 pages at **8.4 s** on a compressed CBR, done at 14.4 s). ComicReaderPage Path B2 engages it when the manifest reports compressed-RAR/non-ZIP. Also: in-flight page-fetch dedupe (no more double-fetching a page you navigate onto mid-preload), parallel spread-pair fetch, and concurrent webtoon loading. Empirical test harnesses kept as `#[ignore]` tests in archive.rs (`comic_stream_probe`, `progressive_comic_probe`).
> - **MovieBite TV drill-down FIXED** (plan Item 6 regression): the series-container check excluded any post_url containing `/watch/` (a Yomi convention), so MovieBite show cards (`/watch/tv/{tmdb}`) skipped the episode drill-down and hit the resolve modal with no season/episode (mismatched metadata, e.g. "Andromeda"). Now a shared `isSeriesContainerRelease()` in `streamResolver.ts` (used by DirectPlayPage select + instant-play and SiteDiscoveryDrawer) drills down MovieBite show URLs without an `episode=` param.

> - **GHA job status disconnect FIXED (2026-11-14, live report):** jobs showed "failed" in-app while still running on GitHub Actions. Root cause: the poller read the repo's **latest** run (`runs[0]`) and applied its status to **every** active job — no per-job correlation, single repo only (multi-account dispatches never polled their own repo). Fix: dispatch now resolves the exact run it created (pre-dispatch max-id snapshot → oldest unclaimed newer run) and jobs carry `workflowRunId`/`ghaOwner`/`ghaRepo`; the poller fetches runs from every configured account, drains dispatch-resolved runs onto jobs FIFO, adopts unclaimed worker runs for jobs that lost correlation (app restart), and reads each job's status ONLY from its own run — uncorrelated jobs are left untouched instead of being failed by strangers.

> - **Music tracklist ordering FIXED (2026-11-14, live report):** albums named "Album – 01-03 Title" (album prefix + disc-track token, en dash) parsed to `trackNumber: undefined` for every track (the Item 4 regex only matched a number at the very start of the filename), and `selectMusicArtists`' album sort had no tie-breaker, so those albums displayed in raw scan order. Fixes: disc-track token parsing (`disc*100+track` keeps multi-disc order, strips the album prefix from titles), en/em-dash support + inner track-number capture in the flat "Artist - NN Title" branch, and a numeric-filename tie-breaker in the album sort (fixes already-scanned libraries without a rescan).
> - **Album-level Fix Match FIXED (2026-11-14, live report):** Item 14's `entity=album` correction was never actually implemented — the music search ignored `mode` and queried iTunes/Deezer for songs, so the album picker only ever showed tracks. Now album mode searches iTunes `entity=album` and Deezer `/search/album` (live-tested: "Ca$ino · Baby Keem · 11 tracks"), the seed track keeps its own song title (only album metadata propagates), and MusicLibraryPage no longer passes `mode="album"` for single-track fixes (it did for BOTH entry points — a per-song fix would have album-propagated).

**Date:** 2026-11-13  
**Scope:** Gaps between intended user workflows and current implementation for **InfiniDysk Usenet**, **Simkl Subscribe + Cloud Offload**, and **Music Player Mode** (`MusicSkinShell`).

> [!NOTE]
> Uncommitted changes in `/home/ashim3000/rcloneflix` are not reflected in the installed `/usr/bin/rcloneflix` desktop binary until rebuilt and reinstalled (`npm run build && ./scripts/build-deb.sh` followed by `sudo dpkg -i ...`).

---

## 1. InfiniDysk Usenet Integration (vs. Intended NZBDav-Style Workflow)

### Intended Behavior
* Act as a virtual remote filesystem (`usenet-drive:`) organized by media/library category (`/TV Shows/<Series>/Season X/`, `/Movies/`, `/Music/`, etc.).
* Pair with **Simkl Discovery + Subscribe** so newly aired episodes/releases mount automatically and become immediately streamable or usable as a source for cloud transcoding/conversion.

### Current Issues & Gaps

1. **Stream / "Mounting..." Hangs ~1 Minute Then Fails**
   * **Where:** [`InfiniDyskSearchModal.tsx`](file:///home/ashim3000/rcloneflix/src/components/discovery/InfiniDyskSearchModal.tsx#L389), [`usenet_dav.rs`](file:///home/ashim3000/rcloneflix/src-tauri/src/commands/usenet_dav.rs#L920-L927)
   * **Cause:** Clicking **Stream** calls `parse_nzb_media_files` (which displays `"Mounting..."` while parsing that specific NZB). Inside `parse_nzb_media_files`, the code loops **sequentially over one single NNTP connection** and fetches `segments[0]` for **every `<file>` in the NZB**—including `.par2` repair files, `.nfo`, `.sfv`, samples, and all 50–100+ `.rar`/`.part` volumes.
   * **Failure Modes:**
     * Sequential segment fetching across 50–150 files takes 30–60+ seconds.
     * The `?` operator on `nntp_body(...)` inside that loop aborts the **entire** mount if even a single `.par2` or non-media file has a missing article (`430`) or times out.
     * Obfuscated Usenet release subjects (random hashes without `.rar`/`.mkv` extensions) fail both `has_rar` and `is_video_name`, returning `"No playable video members found in release"`.
   * **Fix Direction:** Filter out `.par2`/`.nfo`/`.sfv`/sample files before probing NNTP, handle missing/bad first segments gracefully per-file instead of aborting the whole NZB, and inspect magic bytes (RAR/MKV/MP4 headers) when filenames are obfuscated.

2. **Flat `/dav/` Directory Instead of Category Folder Hierarchy**
   * **Where:** [`usenet_dav.rs`](file:///home/ashim3000/rcloneflix/src-tauri/src/commands/usenet_dav.rs#L527-L546)
   * **Cause:** `PROPFIND` lists every ingested file flat at `/dav/<filename>`. There are no category directories (`/Movies`, `/TV Shows`, `/Music`, `/Software`, `/Uncategorized`) or nested show/season folders.
   * **Impact:** RcloneFlix libraries cannot be pointed at `usenet-drive:/TV Shows` or `usenet-drive:/Movies` for automatic scanning as new releases are ingested.
   * **Fix Direction:** Store a `virtual_path` / `category` per mounted item (e.g., `TV Shows/Show Name/Season 1/episode.mkv`) and synthesize intermediate `<D:collection/>` directory entries in `PROPFIND` + path resolution in `GET`/`HEAD`.

3. **Simkl Subscribe + Cloud Conversion Skips Usenet (`127.0.0.1` Wall)**
   * **Where:** [`tvSubscriptionEngine.ts`](file:///home/ashim3000/rcloneflix/src/lib/tvSubscriptionEngine.ts#L179-L195)
   * **Cause:** Line 181 explicitly skips Usenet whenever `sub.transcodeToMp4` is enabled (`if (validNzb?.nzb_url && !sub.transcodeToMp4)`), because Kaggle and GitHub Actions cloud workers cannot reach `http://127.0.0.1:8553/dav/...`.
   * **Impact:** InfiniDysk cannot be used as a source for cloud transcoding/offloading—neither from Subscriptions nor from `CloudTranscodeModal` / `CloudTransferModal`.
   * **Fix Direction:** When dispatching a cloud worker job from a Usenet/NZB source, pass the `.nzb` URL + ephemeral NNTP server credentials in the job payload (matching how `rclone_config_snippet` is passed) so `cloud_worker.yml` / `kaggle.rs` can pull directly from the Usenet provider at cloud speed, transcode/remux, and upload to the destination remote.

---

## 2. Music Player Mode (`MusicSkinShell`), Vinyl Features & Visualizer

### Current Issues & Gaps

1. **Spectrum Visualizer Bars Render Solid Black / Nearly Invisible**
   * **Where:** [`SpectrumCanvas.tsx`](file:///home/ashim3000/rcloneflix/src/components/music/SpectrumCanvas.tsx#L15), [`MusicSkinShell.tsx`](file:///home/ashim3000/rcloneflix/src/components/music/MusicSkinShell.tsx#L568)
   * **Cause:** `SpectrumCanvas` defaults `barColor` to `"rgb(var(--color-accent, 99 102 241))"`. Because `--color-accent` is defined as a hex color rather than space-separated RGB channels, `rgb(#...)` is invalid Canvas 2D color syntax, causing `ctx.fillStyle` to fall back to **pure black (`#000000`)** against the dark player background.
   * **Note:** On Linux desktop (ChromeOS/Crostini WebKitGTK), `AnalyserNode` is disabled, so the visualizer uses the ambient animation fallback rather than real-time FFT.
   * **Fix Direction:** Resolve the computed CSS color directly (`getComputedStyle(canvas).getPropertyValue("--color-accent")` or pass an explicit valid hex/rgba color) so the bars render in the active accent theme.

2. **Album Art Crops to a Circle But Never Spins**
   * **Where:** [`MusicSkinShell.tsx`](file:///home/ashim3000/rcloneflix/src/components/music/MusicSkinShell.tsx#L490), [`index.css`](file:///home/ashim3000/rcloneflix/src/index.css#L331)
   * **Cause:** When `playing` is true, `MusicSkinShell.tsx` applies `rounded-full scale-95 shadow-inner animate-spin-slow ring-4 ring-black/60`. However, `.animate-spin-slow` is **never defined** in `tailwind.config.*` or `src/index.css` (it only appears inside the `@media (prefers-reduced-motion: reduce)` reset).
   * **Impact:** The cover crops into a circle while playing, but remains completely static. Adding a real `@keyframes` / `.animate-spin-slow` rule (e.g., `spin 12s linear infinite`) plus an optional vinyl center spindle / groove overlay will make the vinyl mode look intentional.

3. **Vinyl Needle-Drop & Crackle Audio Effect Is Dead Code**
   * **Where:** [`audioEffects.ts`](file:///home/ashim3000/rcloneflix/src/lib/audioEffects.ts#L23), [`AudioMiniPlayer.tsx`](file:///home/ashim3000/rcloneflix/src/components/audioplayer/AudioMiniPlayer.tsx#L28)
   * **Cause:** `playNeedleDropEffect` is implemented in `audioEffects.ts` and imported in `AudioMiniPlayer.tsx`, but is **never called** anywhere in the codebase, and there is no UI toggle for Vinyl Mode.
   * **Fix Direction:** Add a Vinyl Mode toggle in `MusicSkinShell` / `AudioMiniPlayer` settings and trigger `playNeedleDropEffect()` when starting playback in Vinyl Mode.

4. **Liner Notes Missing from Music Player Mode**
   * **Where:** [`musicCredits.ts`](file:///home/ashim3000/rcloneflix/src/lib/musicCredits.ts#L91), [`MusicLibraryPage.tsx`](file:///home/ashim3000/rcloneflix/src/pages/music/MusicLibraryPage.tsx#L537-L590), [`MusicSkinShell.tsx`](file:///home/ashim3000/rcloneflix/src/components/music/MusicSkinShell.tsx)
   * **Cause:** `fetchAlbumLinerNotes` (MusicBrainz credits, labels, and booklet details) is only wired into the full app's `MusicLibraryPage.tsx`. `MusicSkinShell.tsx` only has **Play**, **Lyrics**, **Queue**, and **Library** tabs in its top bar.
   * **Fix Direction:** Add a **Liner Notes / Credits** button or tab directly in `MusicSkinShell` (both in the top bar next to **Lyrics** and/or on the Now Playing card for the active album) calling the existing `fetchAlbumLinerNotes(artist, album)` helper.
