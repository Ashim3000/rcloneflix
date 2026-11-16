# RcloneFlix v1.0.3 Remediation & Feature Plan — REVIEWED & CORRECTED

**Target Reviewer:** Claude / Engineering Maintainer
**Status:** Reviewed line-by-line against the v1.0.2 codebase on 2026-11-13. Every claim was verified by reading the actual source (and, where relevant, live-probing external APIs). Corrections are marked **`[CORRECTED]`**, confirmed claims **`[VERIFIED]`**, and infeasible items **`[SCRAPPED]`**. All drop-in code below references symbols that were confirmed to exist at the stated locations.

## 0. Review Summary (read this first)

| # | Item | Verdict |
| :-- | :--- | :--- |
| 1 | NNTP Test Connection Hang | **VERIFIED** — all 4 root causes real (Cargo.lock ships rustls with *both* `ring` and `aws-lc-rs` → CryptoProvider ambiguity panic is confirmed). Drop-in approved with minor notes. |
| 2 | Streamtape Account-Wide Keep-Alive | **VERIFIED + expanded** — direct `fetch` to `api.streamtape.com` already works in-app (`streamtapeOffload.ts:55`); iframe ping infra already exists (`performSilentKeepAliveVisit`). Drop-in added. |
| 3 | Title Disambiguation | **CORRECTED** — `showTitle` pollution is at DirectPlayPage.tsx **lines 315, 349 and 380** (3 sites, not 1); `release.series_title` does not exist; Rust already strips portal names (`stream_ingest.rs:198`); CloudTranscodeModal already has a type switcher (`manualType`). Narrowed, corrected drop-ins. |
| 4 | Flat Storage Heuristics + Canonical Namer | **CORRECTED** — original anime regex breaks on hyphenated titles and matches years; flat-music claim "`parts.length === 0`" was imprecise. Safe regexes + full helper provided. |
| 5 | Example Portals Rebrand + Comics Recency | **VERIFIED** — all three sort-parameter claims confirmed in code (`stream_ingest.rs:4453-4457`, `:4496`). RCO is behind a Cloudflare challenge for naked clients — drop-in degrades gracefully. |
| 6 | MovieBite Episode Drill-Down | **CORRECTED** — Cinemeta does **NOT** accept `tmdb:` ids (live-tested: `Cannot GET /series/tmdb:1399.json`). Working replacement: `tmdb.elfhosted.com` Stremio addon (live-tested OK, returns 373 episodes for tmdb:1399 with names + thumbnails). `extract_moviebite` already parses `?season=&episode=` so playback needs zero changes. |
| 7 | Yomi.to Extensionless HLS | **CORRECTED** — the proposed `workers.dev`/`cinextream` substring whitelist is dangerous (the user's own `tg-serverless` / crypt Cloudflare workers serve **MP4s** from `workers.dev` → hls.js would fatally mis-parse them). The proxy already content-sniffs m3u8; correct fix is a `/playlist.m3u8` proxy path requested by the resolver, which makes the **existing** `isHls` check pass with no player edits. |
| 8 | InfiniDysk Full Operation Suite | **CORRECTED** — `usenet_mount_status` does not exist (it is `usenet_get_status`); `CloudTranscodeModal` takes `sourceInput` (not `{url}`); `CloudTransferModal` has **no way to seed its URL** (needs a new `initialDirectUrl` prop). Complete corrected drop-ins. |
| 9 | DropMB Album Container + uDrop Subfolders | **VERIFIED + simplified** — `offloadRemoteFolderToDropmb` (dropmbOffload.ts:860) already proves the single-share pattern; `createDropmbShare` already truncates names to 30 chars (the plan's `.slice(0,30)` is redundant); `MediaItem.dropmbShareUrl` does not exist yet (add it). uDrop root-only bugs confirmed at udrop.ts:91-105 and :202-231. |
| 10 | Offload Mirrors Panel | **VERIFIED** — anchors confirmed (MediaDetailPage ~1120, MediaDetailsModal ~889, `isGuest` exists in both). Shared component drop-in provided. |
| 11 | Multi-Account GHA/Kaggle Pool | **CORRECTED** — GHA quota exhaustion often does **not** fail the dispatch call (the POST can return 204 and the run fails at queue time), so reactive-only detection is insufficient; added proactive billing check. Kaggle creds live in the Rust store (`rcloneflix-keys.json`), so rotation must re-save creds before retry. **ToS caution added.** |
| 12 | Cast & DLNA Audit | **AUDIT COMPLETED** — answered in place of the "challenge": **critical confirmed bug** — every local stream server binds `127.0.0.1` (player.rs:171, stream_proxy.rs:107, usenet_dav.rs:431) while `cast.rs:174-188` rewrites the URL to the LAN IP → the Chromecast gets *connection refused*; casting local streams can never have worked. LAN relay drop-in provided. DLNA binds `0.0.0.0` ✓ correct. Tailscale-Funnel-for-DLNA claim corrected (Funnel is HTTPS-only and cannot carry SSDP). |
| 13 | iOS Build Pipeline | **SCRAPPED** — iOS forbids spawning child processes, so the entire rclone/AList/VLC sidecar architecture is impossible there; a Capacitor shell would install but every `invoke()` fails (dead UI). Full reasoning inside. |
| 14 | Album-Level Fix Match | **VERIFIED** — all three symptoms confirmed (MusicLibraryPage:546-556 passes `tracks[0]`; FixMatchModal:667 omits `entity=album`; handleSelect:729-756 single-track overwrite). Deezer already used via `safeFetch` precedent. Drop-ins provided, aligned to the existing TV sibling-propagation pattern at FixMatchModal:759+. |
| 15 | Vinyl DSP + Liner Notes | **CORRECTED (major)** — WebAudio media-element DSP is **hard-disabled on Linux desktop** (`AudioMiniPlayer.tsx:264-269`: WebKitGTK disconnects the GStreamer sink on `createMediaElementSource`). A WaveShaper in the EQ chain would be **inert on the primary platform**. Rescoped: tube saturation = Windows/Android only; needle-drop/crackle = standalone AudioContext (works everywhere, including Linux). MusicBrainz `inc` string corrected (original lacked `artist-rels`/`recording-level-rels` → zero producer credits would have been returned). WebKitGTK has no inline PDF plugin → booklet images render inline, PDFs open externally. |
| 16 | **(NEW)** Kaggle Job Name Compaction & Filename Reassertion | **ROOT-CAUSED** — `sanitize_title` (kaggle.rs:270-289) truncates to **32 chars**, and "Lord Of The Rings Rings Of Power" is *exactly* 32 chars, so `S03E04` is always chopped → **every episode of that show collides onto the same kernel slug** (`transcode-lord-of-the-rings-rings-of-power`). Kaggle rejects pushes to a slug whose kernel is still queued/running, and the status poller (keyed by slug) conflates jobs. Fix = compact unique hash slugs + short in-VM staging names + real filename reasserted only at the final upload (which the upload code paths already support unchanged). |
| 17 | **(NEW)** Android TV Operability Audit | **AUDITED — foundation is solid, four real gaps found.** The TV layer is far less "gimped" than feared: leanback manifest, spatial D-pad nav engine, native key forwarding, gamepad polling, PiP and focus-ring CSS all exist and are well built. Confirmed gaps: (1) the remote's **Play/Pause button is dead in the video player** (Java sends action `"toggle"`, player only handles `"play-pause"`); (2) **music/audiobook playback ignores ALL media-session transport controls** (no listener in AudioMiniPlayer); (3) **hover-revealed controls are unreachable on TV** — `opacity-0 group-hover:opacity-100` elements (27 files) never appear with a D-pad, and the nav engine deliberately skips invisible elements; (4) **no playback path for MKV/AC3/EAC3/DTS content** — `shouldForceVlc` returns `false` on Android and the WebView cannot demux/decode them, with no external-player fallback. Drop-ins for all four + overscan tweak. |
| 18 | **(NEW)** UI Beautification Pass (Desktop + Android TV) | **ADDED** — low-risk, CSS/markup-only polish split per platform. Desktop (.deb/flatpak/.exe): self-hosted fonts (typography currently collapses to system fallbacks offline — Google Fonts is CDN-loaded in `index.html:9-12`), route cross-fades, skeleton shimmer loaders (the `shimmer` keyframe in `tailwind.config.js` is defined but **unused**), card/hero micro-polish, filmic noise overlay (the `bg-noise` utility also exists unused). Android TV: 10-foot type scale, focus "spotlight" treatment, shelf scroll-snap, and blur/shadow removal for weak TV GPUs. All items respect the SOLID UI STANDARD (no translucent modals) and `prefers-reduced-motion`. |
| 19 | **(NEW)** Music Mode Beautification & Visualizations | **ADDED** — the current "visualizer" is a 48×18 px **fake** sine-wave canvas hardcoded to gold (ignores all accent themes); a real `AnalyserNode` already sits unused-for-visuals in the EQ graph on Windows/Android. New shared `SpectrumCanvas` (bars + radial-ring styles): **real FFT** on Windows/Android (incl. Android TV, 30 fps cap), honest seeded "ambient" mode on Linux desktop (WebAudio is architecturally unavailable there, per Item 15). Plus ambilight blurred-art backdrop in the Music Skin window, ring visualizer + vinyl spin around skin artwork, dominant-color glow behind album covers, and a sidebar icon fix: the Music *section* and the *Music Player Skin* mode button currently share the same lucide `Music` note (`Sidebar.tsx:18` and `:234`) — the section keeps the grandfathered note, the mode button becomes `Disc3`. Butterchurn/WebGL/beat-detection explicitly out of scope. |
| 20 | **(NEW)** Admin Weekly Recommendations & Guest Badge Engine | **ADDED** — Admin can recommend up to 3 titles per library per week with customizable visual badge effects (Gold Star, Neon Glow, Flame, Shimmer, Pulse). Capped at 3 titles per library per ISO week; admin can switch badge effects/titles daily. Recommendations and badge styles are snapshotted serverlessly into exported `.rflix` guest passes, transferring directly to guest libraries and mounting a "⭐ Curator's Weekly Picks" top shelf for new users. **Review corrections applied:** admin-side item mirroring added (without it the badge/shelf appeared only on guest devices), MediaCard badge-collision suppression (4 existing `top-2 left-2` badges), payload-type extension made explicit, guest rec ids remapped to `shared_` ids, invalid `rgba(var(--color-accent-glow),…)` shadow syntax fixed, concrete HomePage drop-ins anchored at verified lines. |
| 21 | **(NEW)** Guest Pass Remote Anonymization & Credential Shielding | **ADDED + CORRECTED (major)** — concept approved, but the proposed `cloud_remote_N` naming was **rejected on review**: `startsWith("shared_")` is a security boundary enforced in the Rust backend (write guards in `rclone_sync.rs`/`rclone.rs`), guest detection (`Sidebar.tsx:58`), remote pickers, and pass teardown (`removeSharedPass`) — dropping the prefix would make admin remotes guest-writable and leave credentials behind after expiry. Corrected scheme anonymizes the **suffix**: `shared_cloud_N` / `shared_fast_N` (displayed "Cloud Remote N" / "Fast Cloud Remote N"). Also completed the missing import-side plumbing (the orig→anon `remoteMapping` now ships in the payload; without it, imported passes could not rewrite item paths and nothing would play) and replaced the "never discover admin names" claim with an honest threat model (masking against casual inspection, not cryptographic hiding). |
| 22 | **(NEW)** Music Mode In-Skin Album Switching & Queue Desync Fix | **ROOT-CAUSED & FIXED** — In compact Music Mode (`MusicSkinShell`), selecting a new album failed due to a circular Zustand ↔ local-state feedback loop in `AudioMiniPlayer.tsx:196-200` that overwrote the new album's track index 0 with the previous album's stale track index, causing `currentTrack` to resolve to `undefined` on smaller albums and freezing playback. Fixed by decoupling internal advances from external album dispatches. Also added direct in-skin album stop/dismiss button, clear queue action, clickable artist/album links on Now Playing, and fixed permanently-hidden tab labels (`hidden xs:inline`). |

---

## 1. Item 1: InfiniDysk NNTP Test Connection Hang & Timeouts — **[VERIFIED]**

### A. Symptom & Environment
In *Settings → InfiniDysk*, clicking **"Test Connection"** hangs indefinitely regardless of whether Easynews (`news.easynews.com:563`) or Premiumize (`usenet.premiumize.me:563`) credentials are provided.

### B. Root Cause Breakdown (all four verified in source)
1. **Primary — Rustls 0.23 CryptoProvider panic — CONFIRMED.** `src-tauri/Cargo.lock` shows the `rustls` package compiled with **both** `aws-lc-rs` **and** `ring` features enabled (transitively). With two providers present, `ClientConfig::builder()` cannot auto-select one and panics (`Could not automatically determine the process-level CryptoProvider…`). In Tauri v2 the panicking async command never resolves its IPC promise, so `testingNntp` in `SettingsPage.tsx:6525-6543` stays `true` forever (the handler's `finally` never runs because the promise never settles).
2. **Secondary — zero timeouts — CONFIRMED.** `nntp_connect` (`usenet_dav.rs:131-172`) wraps nothing in `tokio::time::timeout`.
3. **Tertiary — no explicit TLS flush — CONFIRMED.** All `write_all` calls in `nntp_connect`/`nntp_body` lack `flush()`; `tokio-rustls` can hold small frames in its session buffer.
4. **Quaternary — 381/281 handling — CONFIRMED.** Current code sends `AUTHINFO PASS` unconditionally; a server that answers `281` directly after `USER` would then receive a spurious `PASS` and fail the check at line 167.

### C. Drop-in Replacement (`src-tauri/src/commands/usenet_dav.rs`)

Replace `nntp_connect` (lines 131-172) and `usenet_test_connection` (lines 616-621) with:

```rust
async fn nntp_connect(cfg: &UsenetServerConfig) -> Result<BufReader<Box<dyn NntpIo>>, String> {
    let host = cfg.host.trim().to_string();
    if host.is_empty() {
        return Err("Usenet host is not configured".to_string());
    }

    // Rustls 0.23 ships with BOTH ring and aws-lc-rs features in this build;
    // install ring explicitly to resolve the provider ambiguity (safe to call repeatedly:
    // install_default() returns Err after the first call, which we intentionally ignore).
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();

    let tcp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        TcpStream::connect((host.as_str(), cfg.port)),
    )
    .await
    .map_err(|_| format!("Connection to {}:{} timed out after 10s", host, cfg.port))?
    .map_err(|e| format!("NNTP connect error to {}:{}: {e}", host, cfg.port))?;

    let io: Box<dyn NntpIo> = if cfg.use_tls {
        let mut roots = tokio_rustls::rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

        let tls_cfg = tokio_rustls::rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();

        let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_cfg));
        let name = tokio_rustls::rustls::pki_types::ServerName::try_from(host.clone())
            .map_err(|e| format!("Bad TLS host '{host}': {e}"))?;

        let tls_stream = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            connector.connect(name, tcp),
        )
        .await
        .map_err(|_| format!("TLS handshake with {host}:{} timed out after 10s", cfg.port))?
        .map_err(|e| format!("TLS handshake error with {host}:{}: {e}", cfg.port))?;

        Box::new(tls_stream)
    } else {
        Box::new(tcp)
    };

    let mut r = BufReader::new(io);
    let mut line = String::new();

    tokio::time::timeout(std::time::Duration::from_secs(8), r.read_line(&mut line))
        .await
        .map_err(|_| "Timed out waiting for NNTP greeting banner".to_string())?
        .map_err(|e| format!("Failed to read NNTP banner: {e}"))?;

    if !line.starts_with("200") && !line.starts_with("201") {
        return Err(format!("NNTP banner error: {}", line.trim()));
    }

    if !cfg.username.trim().is_empty() {
        r.get_mut()
            .write_all(format!("AUTHINFO USER {}\r\n", cfg.username.trim()).as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        r.get_mut().flush().await.map_err(|e| e.to_string())?;

        line.clear();
        tokio::time::timeout(std::time::Duration::from_secs(8), r.read_line(&mut line))
            .await
            .map_err(|_| "Timed out waiting for AUTHINFO USER response".to_string())?
            .map_err(|e| e.to_string())?;

        // 381 = password required; 281 = accepted without password
        if line.starts_with("381") {
            r.get_mut()
                .write_all(format!("AUTHINFO PASS {}\r\n", cfg.password.trim()).as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            r.get_mut().flush().await.map_err(|e| e.to_string())?;

            line.clear();
            tokio::time::timeout(std::time::Duration::from_secs(8), r.read_line(&mut line))
                .await
                .map_err(|_| "Timed out waiting for AUTHINFO PASS response".to_string())?
                .map_err(|e| e.to_string())?;
        }

        if !line.starts_with("281") {
            return Err(format!("NNTP authentication failed: {}", line.trim()));
        }
    }

    Ok(r)
}

#[tauri::command]
pub async fn usenet_test_connection(config: UsenetServerConfig) -> Result<String, String> {
    let test_fut = async {
        let mut conn = nntp_connect(&config).await?;
        let _ = conn.get_mut().write_all(b"QUIT\r\n").await;
        let _ = conn.get_mut().flush().await;
        Ok::<String, String>(format!(
            "Connected and authenticated successfully! Host: {}",
            config.host
        ))
    };

    tokio::time::timeout(std::time::Duration::from_secs(15), test_fut)
        .await
        .map_err(|_| format!("Connection test to {} timed out after 15 seconds.", config.host))?
}
```

**Implementation notes for the lower-cost model:**
- `NntpIo`, `webpki_roots`, and all `tokio::io` traits are already imported at the top of the file (lines 1-12) — no new `use` statements are needed except none; `tokio::time` is fully-qualified above.
- Also add a `flush()` after the `BODY` write in `nntp_body` (line 216-217): insert `r.get_mut().flush().await.map_err(|e| e.to_string())?;` directly after the existing `write_all`. This hardens the *streaming* path with the same TLS-buffer fix.
- Because every streaming request also goes through `nntp_connect`, this fix repairs stalled playback mounts too, not just the settings test.

**Verification:** `cargo check`, then package per AGENTS.md (`npx tauri build --bundles deb` + `dpkg -i`). Test against a bogus host (`10.255.255.1:563`) → must error within ~10-15s, not spin forever. Test real Easynews/Premiumize creds → success toast < 2s.

---

## 2. Item 2: Streamtape Keep-Alive Bot Account-Wide API Auto-Discovery — **[VERIFIED]**

### A. Verified Facts
- The bot (`src/lib/cyberlockerKeepAlive.ts`) only scans `item.versions` — files pushed via Cloud Explorer / external rclone never appear and silently expire under Streamtape's 30-day inactivity policy. **Confirmed.**
- Direct browser `fetch` to `https://api.streamtape.com/file/listfolder` **already works in this app** — `streamtapeOffload.ts:55-75` does exactly this (including the `&folder={id}` sub-folder form). No Rust proxying needed.
- The silent iframe visit mechanism (`performSilentKeepAliveVisit`, sandboxed, `allow="autoplay 'none'"`) already exists and is reused as-is.

### B. Drop-in Code

**1. `src/store/appStore.ts`** — in `KeepAliveConfig` (line ~425) add one optional field (optional ⇒ no migration needed):

```typescript
  /** When true, the bot also crawls the whole Streamtape account via API and pings every file, not just library versions. */
  accountWideStreamtape?: boolean;
```

**2. `src/lib/cyberlockerKeepAlive.ts`** — append:

```typescript
type StreamtapeApiFile = { linkid: string; name: string };

const ST_PING_MAP_KEY = "rcloneflix_st_account_pings";

function loadStPingMap(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(ST_PING_MAP_KEY) || "{}"); } catch { return {}; }
}
function saveStPingMap(map: Record<string, number>) {
  try { localStorage.setItem(ST_PING_MAP_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

/**
 * Recursively crawls the entire Streamtape account via the listfolder API
 * (same endpoint pattern already used in streamtapeOffload.ts) and returns every file's linkid.
 */
export async function discoverStreamtapeAccountFiles(): Promise<StreamtapeApiFile[]> {
  const { streamtapeConfig } = useAppStore.getState();
  if (!streamtapeConfig?.apiLogin?.trim() || !streamtapeConfig?.apiKey?.trim()) return [];

  const login = encodeURIComponent(streamtapeConfig.apiLogin.trim());
  const key = encodeURIComponent(streamtapeConfig.apiKey.trim());
  const out: StreamtapeApiFile[] = [];
  const queue: (string | null)[] = [null]; // null = account root
  const seenFolders = new Set<string>();
  let crawled = 0;

  while (queue.length > 0 && crawled < 50) { // hard folder cap — safety against API loops
    const folder = queue.shift() ?? null;
    crawled++;
    const url =
      `https://api.streamtape.com/file/listfolder?login=${login}&key=${key}` +
      (folder ? `&folder=${encodeURIComponent(folder)}` : "");
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const json = await resp.json();
      if (json?.status !== 200) continue;
      for (const f of json?.result?.files || []) {
        if (f?.linkid) out.push({ linkid: String(f.linkid), name: String(f.name || "") });
      }
      for (const fl of json?.result?.folders || []) {
        const id = String(fl?.id ?? "");
        if (id && !seenFolders.has(id)) {
          seenFolders.add(id);
          queue.push(id);
        }
      }
    } catch (err) {
      log.warn("keepalive", `Streamtape folder crawl failed for '${folder}': ${err}`);
    }
    await new Promise((r) => setTimeout(r, 500)); // API courtesy delay
  }
  return out;
}

/**
 * Pings up to maxVisits account-wide Streamtape files whose last ping exceeds the
 * configured expiry threshold. Reuses the existing sandboxed-iframe visit mechanism.
 */
export async function runStreamtapeAccountKeepAlive(maxVisits = 10): Promise<number> {
  const { keepAliveConfig } = useAppStore.getState();
  const thresholdMs = (keepAliveConfig?.maxDaysBeforeExpiry ?? 25) * 24 * 60 * 60 * 1000;
  const dwellMs = keepAliveConfig?.visitDwellMs ?? 12000;

  const files = await discoverStreamtapeAccountFiles();
  if (files.length === 0) return 0;

  const pings = loadStPingMap();
  const due = files.filter((f) => Date.now() - (pings[f.linkid] || 0) >= thresholdMs);
  log.info("keepalive", `Account-wide Streamtape: ${files.length} files total, ${due.length} due for ping.`);

  let visited = 0;
  for (const f of due.slice(0, maxVisits)) {
    const ok = await performSilentKeepAliveVisit(`https://streamtape.com/e/${f.linkid}`, dwellMs);
    if (ok) {
      pings[f.linkid] = Date.now();
      visited++;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  saveStPingMap(pings);
  return visited;
}
```

**3.** In `runKeepAliveHealthCheck` — immediately before the final `setKeepAliveConfig({...})` call (line ~251), add:

```typescript
    let accountVisited = 0;
    if (keepAliveConfig?.accountWideStreamtape) {
      try {
        accountVisited = await runStreamtapeAccountKeepAlive(Math.max(0, maxBatch - visitedCount));
      } catch (err) {
        log.warn("keepalive", `Account-wide Streamtape sweep failed: ${err}`);
      }
    }
```

and change `totalKeptAlive: (keepAliveConfig?.totalKeptAlive ?? 0) + visitedCount` to `+ visitedCount + accountVisited`.

**4. Settings toggle** — in the existing Keep-Alive Bot panel in `SettingsPage.tsx`, add a checkbox bound to `keepAliveConfig.accountWideStreamtape` via the existing `setKeepAliveConfig({ accountWideStreamtape: e.target.checked })` setter (pattern identical to the other keep-alive toggles already in that panel).

**Note:** the original plan's `streamtapeAccountPingMap` in `appStore.ts` was moved to `localStorage` on purpose — the ping map can grow to thousands of entries and does not belong in the persisted Zustand snapshot that rehydrates on every launch.

---

## 3. Item 3: Media Title Disambiguation & Pre-Save Editing — **[CORRECTED]**

### A. Verified Reality vs. Plan Claims
- The `showTitle` pollution exists at **three** sites, not one: `DirectPlayPage.tsx` **lines 315, 349, 380** — each reads `showTitle: discoveryFeed?.site_title || undefined`.
- **`release.series_title` does not exist** on `DiscoveredRelease` (fields: `title, post_url, thumbnail, date, site_domain, media_type, season, episode`). The plan's proposed assignment would not compile.
- **Important subtlety the plan missed:** after a *series drill-down* (e.g. a Yomi anime page), `discoveryFeed.site_title` **is** the correct series title and must be kept for episodes. Only top-level *portal* feeds (BaddiesEast home, MovieBite trending) mislabel. The discriminator that works with existing data: an episode from a drill-down always carries `season`/`episode` numbers.
- Rust-side portal-name stripping **already exists**: `stream_ingest.rs:198` strips `moviebite|miruro|streamtape|doodstream|clicknupload|baddieseast|brokensilenze` from titles. The gap is only missing tokens + bare-domain tokens.
- `CloudTranscodeModal` **already has** a library-type switcher (`manualType` / `setManualType`, line 169) — the plan's "provide a 1-click Library Type switcher" is already delivered. The only real gap is the TMDB auto-match clobbering an explicitly-passed title.
- The "pre-download confirmation popover" **already exists in substance**: all DirectPlay saves route through `AddStreamBookmarkModal` (DirectPlayPage:962-981), which has an editable title that feeds `downloadWebStream`'s filename (AddStreamBookmarkModal:534-541). Do **not** build popover UI inside `downloadManager.ts` (it is a non-React lib and cannot render UI).

### B. Drop-in Edits

**1. `src/pages/DirectPlayPage.tsx`** — apply this identical replacement at **all three** sites (lines 315, 349, 380):

```typescript
// OLD (3 occurrences):
        showTitle: discoveryFeed?.site_title || undefined,
// NEW:
        showTitle:
          release.media_type === "tv" && (release.season != null || release.episode != null)
            ? discoveryFeed?.site_title || undefined
            : undefined,
```

(Series drill-down episodes keep their series title; flat portal cards no longer inherit the portal name.)

**2. `src-tauri/src/commands/stream_ingest.rs`** — in the `junk_patterns` array (line ~192-202), add two entries:

```rust
        r"(?i)\b(tubitv|tubi|baddieshub|readcomicsonline|mangadex|miruro|yomi)\b",
        r"(?i)\b[a-z0-9-]{3,}\.(?:com|net|org|cc|to|ru|io|tv|me|sh)\b",
```

(The second pattern strips any bare `hostname.tld` token from title candidates before TMDB/Cinemeta querying.)

**3. `src/components/library/CloudTranscodeModal.tsx`** — add a `lockTitle` prop:

```typescript
// In Props (line ~45-53), add:
  lockTitle?: boolean;
```

Then inside the metadata effect, immediately **before** the `matchMetadataForStream(titleCandidate, ...)` call (line ~396), insert:

```typescript
    // When the caller passed an explicit, trusted title (e.g. on-site title from a portal
    // or user-edited title from AddStreamBookmarkModal), do NOT let background TMDB
    // matching overwrite it. Library-type routing still works via the manualType switcher.
    if (lockTitle && initialTitle) {
      setCleanTitle(initialTitle);
      setManualTitle(initialTitle);
      setLoadingMeta(false);
      setDestFolder(
        normalizeDestinationRemoteFolder(
          routeDestination(initialTitle, parsedYear, detectedType, selectedRemote, parsedSeason),
          selectedRemote
        )
      );
      return;
    }
```

(Destructure `lockTitle` in the component's parameter list alongside `initialTitle`.)

**4. `src/components/library/AddStreamBookmarkModal.tsx`** — at the embedded `<CloudTranscodeModal …>` (line 1288-1298), add:

```tsx
          lockTitle={Boolean(editableTitle)}
```

### C. Scope Note
Item 3.4 (pre-download popover) is **delivered by existing architecture** — no new code. The verification row for this item becomes: "open any direct link → AddStreamBookmarkModal shows editable title → saved filename matches the edited title."

---

## 4. Item 4: Flat Storage Heuristics & Canonical Naming — **[CORRECTED]**

### A. Corrections to the Plan
- The proposed anime regex `^(?:\[[^\]]+\]\s*)?([^-]+?)\s*-\s*(\d{1,4})` is broken two ways: `[^-]+?` truncates any hyphenated show title (`Re-Zero`, `K-On`), and `\d{1,4}` happily matches `Show - 2024` as episode 2024. Fixed below (requires `" - "` with surrounding spaces, caps at 3 digits ≤ 500, allows hyphens inside the title).
- Music/TV extraction run in **separate functions selected by library type** (`extractMusicInfo` vs `extractEpisodeInfo`), so the anime regex cannot collide with `Artist - Album - 01 - Title` music files — that fear in early drafts was unfounded.
- The flat-music claim was imprecise: `extractMusicInfo` handles `parts.length >= 1`; the broken case is `parts.length === 0` after the filename pop, where artist/album stay `undefined`. Fix is a filename-segment fallback.

### B. Drop-in Code (`src/lib/scanner.ts`)

**1. Anime absolute numbering** — in `extractEpisodeInfo`, inside the final `else` branch (after the `epOnlyMatch` block, line ~486-492), append:

```typescript
      // 4. Anime absolute numbering (flat storage):
      //    "[SubsPlease] Show Name - 01 (1080p).mkv", "Show Name - 01 [1080p].mkv", "Show - 01v2.mkv"
      if (episode === undefined) {
        const animeMatch = stem.match(
          /^\s*(?:\[[^\]]+\]\s*)?(.{2,80}?)\s+-\s+(\d{1,3})(?:v\d+)?\s*(?:[([].*)?$/
        );
        if (animeMatch) {
          const epNum = parseInt(animeMatch[2], 10);
          if (epNum >= 0 && epNum <= 500) {
            episode = epNum;
            if (season === undefined) season = 1;
            if (!showTitle) {
              showTitle = animeMatch[1].replace(/[_.]+/g, " ").replace(/\s{2,}/g, " ").trim();
            }
          }
        }
      }
```

**2. Flat dashed music** — in `extractMusicInfo`, directly after the `parts`-based artist/album block (after line ~343, before the year extraction), insert:

```typescript
  // Flat-storage fallback (Telegram channels, tg-serverless, flat WebDAV):
  // no folders at all — parse the filename itself.
  if (!artist && !album) {
    const flatStem = filename.replace(/\.[^/.]+$/, "");
    const segs = flatStem.split(" - ").map((s) => s.trim()).filter(Boolean);
    if (segs.length >= 4 && /^\d{1,3}$/.test(segs[2])) {
      // "Artist - Album - 01 - Title"
      return {
        artist: segs[0],
        album: segs[1],
        trackNumber: parseInt(segs[2], 10),
        title: segs.slice(3).join(" - "),
        year: undefined,
      };
    }
    if (segs.length === 3 && /^\d{1,3}$/.test(segs[1])) {
      // "Artist - 01 - Title"
      return {
        artist: segs[0],
        trackNumber: parseInt(segs[1], 10),
        title: segs.slice(2).join(" - "),
        year: undefined,
      };
    }
    if (segs.length === 2 && !/^\d{1,3}$/.test(segs[0])) {
      // "Artist - Title" — fall through so the shared track-number/title logic below runs
      artist = segs[0];
    }
  }
```

**3. Canonical namer helper** — append to `scanner.ts` (exported for reuse):

```typescript
/**
 * Builds a canonical, scanner-round-trippable filename for offloads to FLAT remotes
 * (telegram:, telegram-drive:, tg-serverless:, streamtape:). Capped at 180 chars
 * per the ext4 filename invariant in AGENTS.md §1.3.5.
 */
export function buildCanonicalFilename(item: MediaItem): string {
  const ext = (item.filename?.split(".").pop() || "mkv").toLowerCase();
  const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();
  const q = item.resolution ? `.${item.resolution}` : "";

  if (item.libraryType === "tv" && item.showTitle && item.season != null && item.episode != null) {
    const show = clean(item.showTitle).replace(/\s+/g, ".");
    const epTitle =
      item.title && item.title !== item.showTitle
        ? `.${clean(item.title).replace(/\s+/g, ".")}`
        : "";
    return `${show}.S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}${epTitle}${q}.${ext}`.slice(0, 180);
  }
  if (item.libraryType === "music" && item.artist) {
    const tn = item.trackNumber != null ? ` - ${String(item.trackNumber).padStart(2, "0")}` : "";
    const alb = item.album ? ` - ${clean(item.album)}` : "";
    return `${clean(item.artist)}${alb}${tn} - ${clean(item.title)}.${ext}`.slice(0, 180);
  }
  const y = item.year ? `.(${item.year})` : "";
  return `${clean(item.title).replace(/\s+/g, ".")}${y}${q}.${ext}`.slice(0, 180);
}
```

(`MediaItem.trackNumber` and `.resolution` both exist — verified at appStore.ts:154.)

**4. Integration** (anchored instructions, not blind edits):
- `CloudTranscodeModal.tsx` already generates output filenames via `generateFilename(...)` — when `isOffloadDestinationRemote(selectedRemote)` is true (helper already exported at the top of that file), prefer `buildCanonicalFilename` for the output filename.
- `CloudTransferModal.tsx` — in the dispatch handler's **single-item** branch (`isSingleItem && items.length === 1`), when the destination remote is flat (`["telegram","telegram-drive","tg-serverless","streamtape"].includes(destRemote.replace(/:.*/, ""))`), switch the rclone operation from `copy` to `copyto` with `buildCanonicalFilename` as the destination leaf name. The corresponding `MediaItem` for the selected explorer row may not exist; in that case fall back to the raw filename unchanged (no behavior regression).

---

## 5. Item 5: "Example Portals" Rebrand & Comics Recency — **[VERIFIED]**

### A. Rebrand (trivial, confirmed anchors)
`src/pages/DirectPlayPage.tsx`:
- Line 572: `"Browse featured media portals or bookmark..."` → `"Browse example media portals or bookmark..."`.
- Line 682 comment + line 688: `"Featured Portals"` → `"Example Portals"`.
- `siteBookmarks.ts` already exports `EXAMPLE_BOOKMARKS` — no further changes.

### B. Comics Recency (`src-tauri/src/commands/stream_ingest.rs`, section starting ~line 4400)

**1. Archive.org** — make the sort conditional (keep `downloads desc` for real searches, which is better relevance; recency only for the empty-query default). Replace the fixed `ia_url` (line ~4453-4457):

```rust
    let ia_sort = if clean_q.is_empty() { "publicdate+desc" } else { "downloads+desc" };
    let ia_url = format!(
        "https://archive.org/advancedsearch.php?q={}&fl[]=identifier,title,year&sort[]={}&rows=24&output=json",
        enc_ia, ia_sort
    );
```

**2. MangaDex** — in the empty-query branch (line ~4496), replace `order[followedCount]=desc` with `order[latestUploadedChapter]=desc`. (Parameter verified valid in the MangaDex v5 API.)

**3. ReadComicsOnline default listing** — insert at the top of the function body, before the autocomplete branch (line ~4400):

```rust
    // 0. Empty-query default: surface the latest RCO releases instead of nothing.
    //    NOTE: readcomicsonline.ru sits behind a Cloudflare challenge for cold clients;
    //    this scrape degrades gracefully (IA + MangaDex still populate the feed on failure).
    if clean_q.is_empty() {
        if let Ok(resp) = client
            .get("https://readcomicsonline.ru/latest-release")
            .header("Referer", "https://readcomicsonline.ru/")
            .send()
            .await
        {
            if let Ok(text) = resp.text().await {
                if let Ok(re) = Regex::new(
                    r#"href="https://readcomicsonline\.ru/comic/([a-z0-9-]+)"[^>]*>\s*([^<]{2,120})<"#,
                ) {
                    let mut seen = std::collections::HashSet::new();
                    for cap in re.captures_iter(&text).take(40) {
                        let slug = cap[1].to_string();
                        if !seen.insert(slug.clone()) {
                            continue;
                        }
                        let title = cap[2].trim().to_string();
                        if title.is_empty() {
                            continue;
                        }
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
```

**Temper the original claim:** "ensuring the portal *always* displays fresh books" is not guaranteeable — the Cloudflare challenge can intermittently block the scrape. The honest contract is "fresh RCO releases when reachable; recent IA uploads + newest MangaDex chapters always."

---

## 6. Item 6: MovieBite TV Season & Episode Drill-Down — **[CORRECTED]**

### A. Corrections (live-verified on 2026-11-13)
- **Cinemeta does NOT accept `tmdb:` ids.** `https://v3-cinemeta.strem.io/meta/series/tmdb:1399.json` → `Cannot GET …`. The plan's primary metadata source is dead on arrival.
- **Working keyless replacement:** the public Stremio TMDB addon — `https://tmdb.elfhosted.com/meta/series/tmdb:{id}.json` returns `meta.name`, `meta.poster`, and a `videos[]` array (`season`, `episode`/`number`, `name`, `thumbnail`, `overview`); verified live with tmdb:1399 → 373 episodes.
- MovieBite's own detail endpoints (`/api/detail`, `/api/tv/{id}`, etc.) all return `{"error":"Forbidden"}` — not usable.
- **Playback needs zero changes**: `extract_moviebite` (stream_ingest.rs:380-401) already parses `?season=` / `?episode=` query params from the watch URL, so episode `post_url`s of the form below stream through the existing extractor as-is.
- The frontend guard must be added to **both** `handleSelectRelease` (line ~251-263) **and** `handleInstantPlayRelease` (line ~275-287) — the plan named only one.

### B. Drop-in Code

**1. `src/pages/DirectPlayPage.tsx`** — add this line to the series-drilldown condition in **both** handlers (the two identical `if (...)` blocks):

```typescript
      (release.post_url.includes("moviebite.org/watch/tv/") &&
        !release.post_url.includes("episode=")) ||
```

**2. `src-tauri/src/commands/stream_ingest.rs`** — in `crawl_site_releases`, inside the `if host.contains("moviebite")` branch (line 3669), insert **before** the trending fetch:

```rust
        // TV show drill-down: moviebite.org/watch/tv/{tmdb_id} (no episode param yet)
        if let Some(cap) = Regex::new(r"(?i)moviebite\.org/watch/tv/(\d+)")
            .unwrap()
            .captures(&url)
        {
            if !url.contains("episode=") && !url.contains("&ep=") {
                let tmdb_id = cap[1].to_string();
                let meta_url = format!("https://tmdb.elfhosted.com/meta/series/tmdb:{}.json", tmdb_id);
                if let Ok(resp) = client.get(&meta_url).send().await {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        let meta = &json["meta"];
                        let show_title = meta["name"].as_str().unwrap_or("TV Series").to_string();
                        let poster = meta["poster"].as_str().map(|s| s.to_string());
                        let mut ep_releases: Vec<DiscoveredRelease> = Vec::new();
                        if let Some(videos) = meta["videos"].as_array() {
                            for v in videos {
                                let season = v["season"].as_i64().unwrap_or(0);
                                let episode =
                                    v["episode"].as_i64().or_else(|| v["number"].as_i64()).unwrap_or(0);
                                if season <= 0 || episode <= 0 {
                                    continue; // skip specials/previews (season 0)
                                }
                                let ep_name = v["name"].as_str().unwrap_or("").to_string();
                                let title = if ep_name.is_empty() {
                                    format!("{} - S{:02}E{:02}", show_title, season, episode)
                                } else {
                                    format!("{} - S{:02}E{:02} - {}", show_title, season, episode, ep_name)
                                };
                                ep_releases.push(DiscoveredRelease {
                                    title,
                                    post_url: format!(
                                        "https://moviebite.org/watch/tv/{}?season={}&episode={}",
                                        tmdb_id, season, episode
                                    ),
                                    thumbnail: v["thumbnail"]
                                        .as_str()
                                        .map(|s| s.to_string())
                                        .or_else(|| poster.clone()),
                                    date: v["firstAired"].as_str().map(|s| s.chars().take(10).collect()),
                                    site_domain: "moviebite.org".to_string(),
                                    media_type: "tv".to_string(),
                                    season: Some(season as u32),
                                    episode: Some(episode as u32),
                                });
                            }
                        }
                        if !ep_releases.is_empty() {
                            ep_releases.sort_by_key(|r| (r.season.unwrap_or(0), r.episode.unwrap_or(0)));
                            return Ok(SiteDiscoveryFeed {
                                site_title: show_title,
                                site_url: url.clone(),
                                releases: ep_releases,
                            });
                        }
                    }
                }
                // elfhosted unreachable → fall through to the trending feed (old behavior).
            }
        }
```

**Implementation notes:** match the `season`/`episode` field types to the existing `DiscoveredRelease` struct definition (if they are `Option<i32>`, drop the `as u32` casts accordingly). The `SiteDiscoveryFeed` field names (`site_title`, `site_url`, `releases`) are confirmed from the comics crawl at line 4559. Note how this interacts with Item 3's fix: these episodes carry `season`/`episode`, so `showTitle` correctly inherits `site_title` (= the show name) in the player.

---

## 7. Item 7: Yomi.to Extensionless HLS Bulletproofing — **[CORRECTED]**

### A. What the Plan Got Right and Wrong
- **Right:** the symptom chain is real. `isHls` (VideoPlayerPage.tsx:1051-1059) is a URL-substring check; an extensionless CineXtream worker URL (wrapped as `http://127.0.0.1:8552/stream?url=…workers.dev…`) fails it, the playlist text hits the native `<video>` demuxer, and playback dies.
- **Wrong (dangerous):** adding `workers.dev` / `cinextream` / `sourceProvider.includes("yomi")` to `isHls` creates **false positives**: this app's own Cloudflare workers (`tg-serverless` WebDAV gateway, `cf-crypt-worker`) serve **MP4 files** from `*.workers.dev`. Feeding an MP4 to hls.js produces a fatal manifest-parse error and a 28-second watchdog stall — a direct regression of the bug #160 class of fixes.
- **Key architectural fact the plan missed:** the proxy **already content-sniffs HLS** (`stream_proxy.rs:326-330`: `is_m3u8 = target_url.contains(".m3u8") || path.contains(".m3u8") || content_type.contains("mpegurl") …`) and already rewrites + serves `application/vnd.apple.mpegurl`. The only gap is signaling the *frontend*. The resolver *knows* with certainty when a stream is HLS (it just decrypted a CineXtream playlist) — so let it say so in the proxy URL path.

### B. Corrected Fix: `/playlist.m3u8` proxy path requested by the resolver

**1. `src-tauri/src/commands/stream_proxy.rs`** — replace `get_stream_proxy_url` (line ~528-539):

```rust
#[tauri::command]
pub async fn get_stream_proxy_url(
    url: String,
    referer: Option<String>,
    is_hls: Option<bool>,
) -> Result<String, String> {
    let port = get_or_start_proxy_server().await?;
    let ref_str = referer.unwrap_or_else(|| infer_referer(&url));
    // "/playlist.m3u8" guarantees (a) proxy-side playlist rewriting even if the upstream
    // worker sends a generic content-type, and (b) the frontend isHls check passes,
    // because the local URL now contains ".m3u8". Existing callers pass no is_hls → unchanged.
    let endpoint = if is_hls.unwrap_or(false) { "playlist.m3u8" } else { "stream" };
    Ok(format!(
        "http://127.0.0.1:{}/{}?url={}&referer={}",
        port,
        endpoint,
        url_encode(&url),
        url_encode(&ref_str)
    ))
}
```

(Verified: the proxy's request handler parses query params with `Url::query_pairs()` regardless of path, `is_m3u8_hint`/`is_m3u8` both match `path.contains(".m3u8")`, and `shouldForceVlc` on Linux explicitly returns `false` for `.m3u8` URLs — so these streams land in hls.js inside VideoPlayerPage, same engine that plays iHeart-adjacent HLS today. No player-file edits required at all.)

**2. `src/lib/streamResolver.ts`** — update the wrapper (line 145-147):

```typescript
export async function getStreamProxyUrl(url: string, referer?: string, isHls?: boolean): Promise<string> {
  return invoke<string>("get_stream_proxy_url", {
    url: url.trim(),
    referer: referer ?? null,
    isHls: isHls ?? null,
  });
}
```

Then pass `true` at the **four call sites that have just decrypted a CineXtream playlist** (these URLs are HLS *by construction*):
- line ~223 (`fetchWebStreamInfo` cinextream branch): `info.direct_stream_url = await getStreamProxyUrl(decrypted, undefined, true);`
- line ~258-270 (`cinextream://` marker branch): `return await getStreamProxyUrl(decrypted, undefined, true);`
- line ~273-284 (`yomi.to/watch/` branch): same change.
- line ~291-300 (resolved `cinextream://` branch): same change.

All other call sites stay untouched (MP4/worker/WebDAV streams keep the `/stream` path).

**3. Hardening (optional but cheap)** — `rewrite_m3u8_playlist` misroutes *extensionless child playlists* inside a master to the `segment.ts` endpoint. Per the HLS spec, the URI line following `#EXT-X-STREAM-INF:` is always a child playlist. In `rewrite_m3u8_playlist` (stream_proxy.rs:440+), track it:

```rust
    let mut last_was_stream_inf = false;
```

In the `trimmed.starts_with('#')` branch add:

```rust
            if trimmed.starts_with("#EXT-X-STREAM-INF:") {
                last_was_stream_inf = true;
            }
```

And in the final (bare-URL) branch change the endpoint selection to:

```rust
                let endpoint = if last_was_stream_inf || lower_resolved.contains(".m3u8") {
                    "playlist.m3u8"
                } else if lower_resolved.contains(".mp4") || lower_resolved.contains(".m4s") {
                    "segment.mp4"
                } else {
                    "segment.ts"
                };
                last_was_stream_inf = false;
```

**4. CORS/Referer passthrough** — already correct, no change: the proxy sends `Referer`/`Origin` via `infer_referer`/`infer_origin` on every segment hop (stream_proxy.rs:287-293).

---

## 8. Item 8: InfiniDysk Search Full Operation Suite — **[CORRECTED]**

### A. Corrections to the Plan
- `usenet_mount_status` **does not exist**. The real command is **`usenet_get_status`** → `{ configured, host, port, mounted_remote, port_8553_active, files_count }` (usenet_dav.rs:578-589). Also, every usenet `invoke` boots the engine via `get_usenet_engine()`, so no "restart it gracefully" logic is needed — only a *configured* check.
- `CloudTranscodeModal` props are `{ sourceInput, sourceItems?, initialTitle?, initialPoster?, mediaType? }` — **not** `{url, title, type}`. `sourceInput` accepts a raw URL (AddStreamBookmarkModal:1294 already passes one).
- `CloudTransferModal` accepts `initialUrlMode` but its `directUrl` is **internal state with no seeding prop** — opened as the plan described, the URL field would be empty. A new `initialDirectUrl` prop is required (drop-in below).
- The plan's `handleSaveConvertAction` snippet only opened the bookmark modal. Note that **AddStreamBookmarkModal already embeds the full suite** (download via `downloadWebStream`, transcode via embedded `CloudTranscodeModal`, bookmark) — so "Save / Convert" → `AddStreamBookmarkModal` genuinely delivers most of the parity with one button. The `…` menu adds the direct one-click paths.

### B. Drop-in Code

**1. `src/components/explorer/CloudTransferModal.tsx`** — add URL seeding:

```typescript
// In Props (line ~51-62), add:
  initialDirectUrl?: string;

// In the destructured params (line ~79-90), add:
  initialDirectUrl,

// Change line ~160:
  const [directUrl, setDirectUrl] = useState<string>(initialDirectUrl || "");
```

**2. `src/components/discovery/InfiniDyskSearchModal.tsx`** — additions (all referenced symbols verified):

```tsx
// ── New imports ──
import { CloudTranscodeModal } from "../library/CloudTranscodeModal";
import { CloudTransferModal } from "../explorer/CloudTransferModal";
import { downloadWebStream } from "../../lib/streamResolver";
import { Download, Sliders, Send, MoreHorizontal, ChevronDown, Save } from "lucide-react";

// ── New state (next to bookmarkTarget) ──
type ParsedFile = { name: string; size: number; kind: string };
const [transcodeTarget, setTranscodeTarget] = useState<{ url: string; title: string } | null>(null);
const [transferTarget, setTransferTarget] = useState<{ url: string; title: string } | null>(null);
const [openMenuUrl, setOpenMenuUrl] = useState<string | null>(null);
const [expandedUrl, setExpandedUrl] = useState<string | null>(null);
const [parsedFilesMap, setParsedFilesMap] = useState<Record<string, ParsedFile[]>>({});
const [nntpConfigured, setNntpConfigured] = useState(true);

// ── NNTP configured guard (runs on open; engine auto-boots on any usenet invoke) ──
useEffect(() => {
  if (!isOpen) return;
  invoke<{ configured: boolean }>("usenet_get_status")
    .then((s) => setNntpConfigured(Boolean(s?.configured)))
    .catch(() => setNntpConfigured(false));
}, [isOpen]);

// ── Shared parse helper with cache ──
const ensureParsed = async (nzb: UsenetSearchResult): Promise<ParsedFile[]> => {
  const cached = parsedFilesMap[nzb.nzb_url];
  if (cached) return cached;
  const playables = await invoke<ParsedFile[]>("parse_nzb_media_files", {
    nzbUrl: nzb.nzb_url,
    nzbXml: null,
    password: null,
  });
  setParsedFilesMap((prev) => ({ ...prev, [nzb.nzb_url]: playables || [] }));
  return playables || [];
};

const davUrlFor = (file: ParsedFile) =>
  `http://127.0.0.1:8553/dav/${encodeURIComponent(file.name)}`;

const pickTarget = (playables: ParsedFile[], specific?: ParsedFile) =>
  specific || [...playables].sort((a, b) => b.size - a.size)[0];

// ── Action handlers ──
const withParsed = async (
  nzb: UsenetSearchResult,
  specific: ParsedFile | undefined,
  action: (file: ParsedFile, streamUrl: string) => void | Promise<void>
) => {
  setIngestingUrl(nzb.nzb_url);
  try {
    const playables = await ensureParsed(nzb);
    if (!playables.length) {
      addToast("No playable media files found inside this NZB release", "error");
      return;
    }
    const target = pickTarget(playables, specific);
    await action(target, davUrlFor(target));
  } catch (err: any) {
    addToast(`Failed to parse release: ${err?.message || err}`, "error");
  } finally {
    setIngestingUrl(null);
    setOpenMenuUrl(null);
  }
};

const handleSaveConvert = (nzb: UsenetSearchResult, specific?: ParsedFile) =>
  withParsed(nzb, specific, (file, url) =>
    setBookmarkTarget({ url, title: nzb.title || file.name })
  );

const handleDownload = (nzb: UsenetSearchResult, specific?: ParsedFile) =>
  withParsed(nzb, specific, async (file, url) => {
    addToast(`Downloading "${file.name.split("/").pop()}" from Usenet...`, "info");
    await downloadWebStream({
      download_id: `nzbdl-${Date.now()}`,
      stream_url: url,
      original_url: nzb.nzb_url,
      filename: file.name.split("/").pop() || "usenet-media.mkv",
    });
    addToast("Usenet download completed!", "success");
  });

const handleTranscode = (nzb: UsenetSearchResult, specific?: ParsedFile) =>
  withParsed(nzb, specific, (file, url) =>
    setTranscodeTarget({ url, title: nzb.title || file.name })
  );

const handleTransfer = (nzb: UsenetSearchResult, specific?: ParsedFile) =>
  withParsed(nzb, specific, (file, url) =>
    setTransferTarget({ url, title: nzb.title || file.name })
  );

const handleExpandFiles = async (nzb: UsenetSearchResult) => {
  if (expandedUrl === nzb.nzb_url) {
    setExpandedUrl(null);
    return;
  }
  setIngestingUrl(nzb.nzb_url);
  try {
    await ensureParsed(nzb);
    setExpandedUrl(nzb.nzb_url);
  } catch (err: any) {
    addToast(`Failed to inspect release: ${err?.message || err}`, "error");
  } finally {
    setIngestingUrl(null);
  }
};
```

**Card action row** — replace the current two-button block (lines 319-349) with:

```tsx
<div className="flex items-center gap-2 shrink-0 relative">
  <button
    type="button"
    onClick={() => handleExpandFiles(res)}
    disabled={isIngesting}
    className="px-2 py-1.5 rounded-lg border border-border bg-surface hover:bg-panel text-subtle hover:text-text text-xs flex items-center gap-1 transition-colors cursor-pointer"
    title="Inspect files inside this release"
  >
    <ChevronDown size={13} className={expandedUrl === res.nzb_url ? "rotate-180 transition-transform" : "transition-transform"} />
    {parsedFilesMap[res.nzb_url] ? <span>{parsedFilesMap[res.nzb_url].length} files</span> : <span>Files</span>}
  </button>

  <button
    type="button"
    onClick={() => handleSaveConvert(res)}
    disabled={isIngesting}
    className="px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-panel text-subtle hover:text-text text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
    title="Save, download, convert, or bookmark this release"
  >
    <Save size={13} />
    <span>Save / Convert</span>
  </button>

  <button
    type="button"
    onClick={() => handlePlayNzb(res)}
    disabled={isIngesting}
    className="px-3.5 py-1.5 rounded-lg bg-cyan-500 text-void font-semibold text-xs flex items-center gap-1.5 hover:bg-cyan-400 transition-colors cursor-pointer"
  >
    {isIngesting ? (
      <><Loader2 size={13} className="animate-spin" /><span>Mounting...</span></>
    ) : (
      <><Play size={13} fill="currentColor" /><span>Stream</span></>
    )}
  </button>

  <button
    type="button"
    onClick={() => setOpenMenuUrl(openMenuUrl === res.nzb_url ? null : res.nzb_url)}
    disabled={isIngesting}
    className="p-1.5 rounded-lg border border-border bg-surface hover:bg-panel text-subtle hover:text-text transition-colors cursor-pointer"
    title="More actions"
  >
    <MoreHorizontal size={14} />
  </button>

  {openMenuUrl === res.nzb_url && (
    <div className="absolute right-0 top-full mt-1 z-20 w-56 rounded-xl bg-panel border border-border shadow-2xl py-1 text-xs">
      <button onClick={() => handleDownload(res)} className="w-full text-left px-3 py-2 hover:bg-surface flex items-center gap-2 text-text cursor-pointer">
        <Download size={13} /> Download to Computer
      </button>
      <button onClick={() => handleTranscode(res)} className="w-full text-left px-3 py-2 hover:bg-surface flex items-center gap-2 text-text cursor-pointer">
        <Sliders size={13} /> Cloud Transcode (AV1 / H.264)
      </button>
      <button onClick={() => handleTransfer(res)} className="w-full text-left px-3 py-2 hover:bg-surface flex items-center gap-2 text-text cursor-pointer">
        <Send size={13} /> Cloud Transfer / Offload
      </button>
      <button onClick={() => handleBookmarkNzb(res)} className="w-full text-left px-3 py-2 hover:bg-surface flex items-center gap-2 text-text cursor-pointer">
        <Bookmark size={13} /> Add to Library (0 MB Bookmark)
      </button>
    </div>
  )}
</div>
```

**Multi-file accordion** — directly below the card's metadata row (after the size/date `div`, inside the card container), add:

```tsx
{expandedUrl === res.nzb_url && (parsedFilesMap[res.nzb_url] || []).length > 0 && (
  <div className="mt-2 w-full border-t border-border/50 pt-2 space-y-1">
    {(parsedFilesMap[res.nzb_url] || []).map((f) => (
      <div key={f.name} className="flex items-center justify-between gap-2 px-2 py-1 rounded-lg hover:bg-surface text-xs font-mono">
        <span className="truncate text-subtle flex-1" title={f.name}>{f.name}</span>
        <span className="text-subtle/70 shrink-0">{formatSize(f.size)}</span>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => handlePlayNzbFile(res, f)} className="p-1 rounded hover:bg-panel text-cyan-400 cursor-pointer" title="Play this file">
            <Play size={12} fill="currentColor" />
          </button>
          <button onClick={() => handleSaveConvert(res, f)} className="p-1 rounded hover:bg-panel text-subtle hover:text-text cursor-pointer" title="Save / Convert this file">
            <Save size={12} />
          </button>
          <button onClick={() => handleTranscode(res, f)} className="p-1 rounded hover:bg-panel text-subtle hover:text-text cursor-pointer" title="Transcode this file">
            <Sliders size={12} />
          </button>
        </div>
      </div>
    ))}
  </div>
)}
```

`handlePlayNzbFile` is a thin wrapper around the existing `handlePlayNzb` logic with a specific file: refactor `handlePlayNzb` to accept `(nzb, specificFile?)` and use `pickTarget(playables, specificFile)` instead of its inline sort (the rest of its body — building `playItem` and navigating — is unchanged and already correct post-v1.0.2).

**Modal renders** — before the closing fragment tag (next to the existing `bookmarkTarget` render):

```tsx
{transcodeTarget && (
  <CloudTranscodeModal
    isOpen={true}
    onClose={() => setTranscodeTarget(null)}
    sourceInput={transcodeTarget.url}
    initialTitle={transcodeTarget.title}
    mediaType="movies"
    lockTitle
  />
)}
{transferTarget && (
  <CloudTransferModal
    isOpen={true}
    onClose={() => setTransferTarget(null)}
    sourceRemote="usenet-drive"
    sourcePath=""
    initialUrlMode={true}
    initialDirectUrl={transferTarget.url}
  />
)}
```

**Configured guard** — in the empty-state block (line ~262-272), when `!nntpConfigured`, render the existing tip line in amber with the text: *"InfiniDysk NNTP server is not configured — set your provider in Settings → InfiniDysk before streaming or saving releases."*

**Important caveat to document in the UI copy:** Cloud Transcode / Cloud Transfer executed by **cloud workers (Kaggle/GHA) cannot reach `http://127.0.0.1:8553`** — this was already established in the TV-subscription engine design. The transfer path for usenet releases must run with the **local rclone** execution target (`downloadWebStream`-style local pull + upload), which `CloudTransferModal`'s URL mode already does for non-worker dispatches. The implementing model must verify the chosen `TransferExecutionTarget` defaults to local when the source URL is a loopback address — if the modal defaults to a cloud worker, force-select local for `127.0.0.1` sources and disable the worker options with a tooltip.

---

## 9. Item 9: Multi-Track Album Single-Share Offload (DropMB) & uDrop Subfolders — **[VERIFIED, simplified]**

### A. Verified Facts
- The per-track loop at `MusicLibraryPage.tsx:544-556` (each `offloadAudioItemToDropmb(track)` → own share) — **confirmed**.
- `createDropmbShare` **already truncates names to 30 chars** (dropmbOffload.ts:384-386) — drop the plan's redundant `albumName.slice(0, 30)`.
- `offloadRemoteFolderToDropmb` (dropmbOffload.ts:860+) already demonstrates the one-share/many-files pattern (`createDropmbShare` once → `uploadDropmbChunk(shareId, …)` per file → `completeDropmbShare` once). The album offloader mirrors `offloadItemToDropmb`'s per-track stream-session machinery into that pattern.
- `MediaItem.dropmbShareUrl` does **not** exist. Add it; also set `shareUrl` on the version (the field exists — multiVersion.ts:19 — and the keep-alive bot already consumes it).
- uDrop bugs confirmed exactly as described (udrop.ts:91-105 root-only rclone check; :202-231 root-only API listing). One addition: `getUdropDirectLinkForFile`'s WebDAV fallback uses `encodeURIComponent(fileName)` which **encodes `/` as `%2F`** — subfolder paths must be encoded per-segment.

### B. Drop-in Code

**1. `src/store/appStore.ts`** — next to `dropmbExpiresAt` (line ~175) add:

```typescript
  dropmbShareUrl?: string;
```

**2. `src/lib/dropmbOffload.ts`** — append:

```typescript
/**
 * Offloads ALL tracks of an album into ONE DropMB share container, so the user
 * gets a single https://dropmb.com/share/{shareId} link covering the whole album.
 * Mirrors offloadItemToDropmb()'s stream-session + chunk loop per track.
 */
export async function offloadAlbumToDropmb(
  albumName: string,
  tracks: MediaItem[],
  onProgress?: (pct: number, msg: string) => void
): Promise<string | null> {
  const { rcloneConfigPath, libraries, upsertMediaItem } = useAppStore.getState();
  const addToast = useToastStore.getState().addToast;
  if (tracks.length === 0) return null;

  addToast(`Creating single DropMB share for album "${albumName}" (${tracks.length} tracks)...`, "info");
  try {
    // One share container for the whole album (createDropmbShare truncates the name itself)
    const { shareId, expiresAt } = await createDropmbShare(albumName);
    const albumShareUrl = `https://dropmb.com/share/${shareId}`;
    const updatedItems: MediaItem[] = [];

    for (let t = 0; t < tracks.length; t++) {
      const item = tracks[t];
      const basePct = Math.round((t / tracks.length) * 90);
      onProgress?.(basePct, `Uploading track ${t + 1}/${tracks.length}: ${item.title}`);

      // Resolve a localhost byte stream for this track (same logic as offloadItemToDropmb)
      let localStreamUrl = "";
      let fileSize = item.sizeBytes || 0;
      let activeSessionId: string | null = null;
      const localPath = await getDownloadedFilePath(item);
      if (localPath) {
        const res = await invoke<{ file_url: string }>("start_local_file_stream", { filePath: localPath });
        localStreamUrl = res.file_url;
      } else {
        const library = libraries.find((l) => l.id === item.libraryId);
        const matchingRoot =
          library?.remotePaths.find((p) => {
            const r = p.replace(/\/+$/, "");
            return item.remotePath.startsWith(r + "/") || (r.endsWith(":") && item.remotePath.startsWith(r));
          }) ?? library?.remotePaths[0] ?? "";
        const rootTrimmed = matchingRoot.replace(/\/+$/, "");
        let relPath: string;
        if (item.remotePath.startsWith(rootTrimmed + "/")) {
          relPath = item.remotePath.slice(rootTrimmed.length + 1);
        } else if (rootTrimmed.endsWith(":") && item.remotePath.startsWith(rootTrimmed)) {
          relPath = item.remotePath.slice(rootTrimmed.length).replace(/^\/+/, "");
        } else {
          relPath = item.remotePath.split("/").pop() ?? item.filename;
        }
        activeSessionId = `offload-dropmb-album-${item.id}`;
        const res = await invoke<{ file_url: string }>("start_stream_session", {
          configPath: rcloneConfigPath,
          remoteRoot: matchingRoot,
          filePath: relPath,
          sessionId: activeSessionId,
        });
        localStreamUrl = res.file_url;
      }

      try {
        if (!localStreamUrl) throw new Error(`No stream for "${item.title}"`);
        if (!fileSize || fileSize <= 0) {
          try {
            const headRes = await httpFetch(localStreamUrl, { method: "HEAD" });
            const len = headRes.headers.get("content-length");
            if (len) fileSize = parseInt(len, 10);
          } catch { /* unknown size tolerated */ }
        }
        const sizeKnown = fileSize > 0;
        const totalChunks = sizeKnown ? Math.max(1, Math.ceil(fileSize / CHUNK_SIZE)) : 1;
        const fileName = item.filename || `${item.title}.mp3`;

        let fileId = "";
        let chunkIndex = 0;
        let offset = 0;
        while (!sizeKnown || offset < fileSize) {
          const start = offset;
          const end = sizeKnown ? Math.min(fileSize - 1, start + CHUNK_SIZE - 1) : start + CHUNK_SIZE - 1;
          const chunkRes = await httpFetch(localStreamUrl, { headers: { Range: `bytes=${start}-${end}` } });
          if (!chunkRes.ok && chunkRes.status !== 206) {
            if (!sizeKnown && chunkIndex > 0) break;
            throw new Error(`Chunk fetch failed for "${item.title}" (HTTP ${chunkRes.status})`);
          }
          const chunkBytes = new Uint8Array(await chunkRes.arrayBuffer());
          if (chunkBytes.byteLength === 0) break;
          fileId = await uploadDropmbChunk(
            shareId, chunkBytes, fileName, chunkIndex,
            sizeKnown ? totalChunks : chunkIndex + 1, fileId || undefined
          );
          offset += chunkBytes.byteLength;
          chunkIndex++;
          if (chunkBytes.byteLength < CHUNK_SIZE) break;
        }

        // Register the album-share version on this track
        const token = await getDropmbShareToken(shareId);
        const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : "";
        const directStreamUrl = `https://dropmb.com/api/shares/${shareId}/files/${fileId}?download=false${tokenQuery}`;
        const dropmbVersion: MediaSourceVersion = {
          id: `${item.id}-dropmb-2`,
          remoteName: "dropmb",
          remotePath: directStreamUrl,
          libraryId: item.libraryId,
          sizeBytes: fileSize,
          container: item.filename.split(".").pop()?.toLowerCase(),
          isLocal: false,
          priority: 2,
          sourceType: "streamtape",
          addedAt: Date.now(),
          expiresAt,
          shareUrl: albumShareUrl,
        };
        const existingVersions =
          item.versions && item.versions.length > 0
            ? item.versions.filter((v) => !v.remoteName.toLowerCase().includes("dropmb"))
            : [createVersionFromItem(item)];
        const updatedItem: MediaItem = {
          ...item,
          dropmbExpiresAt: expiresAt,
          dropmbShareUrl: albumShareUrl,
          versions: [dropmbVersion, ...existingVersions].sort((a, b) => a.priority - b.priority),
        };
        upsertMediaItem(updatedItem);
        updatedItems.push(updatedItem);
      } finally {
        if (activeSessionId) {
          invoke("stop_stream_session", { sessionId: activeSessionId }).catch(() => {});
        }
      }
    }

    onProgress?.(95, "Finalizing album share...");
    await completeDropmbShare(shareId);
    await persistItems(updatedItems);

    try { await navigator.clipboard.writeText(albumShareUrl); } catch { /* clipboard optional */ }
    addToast(`Album "${albumName}" offloaded to one DropMB share! Link copied: ${albumShareUrl}`, "success", 7000);
    onProgress?.(100, "Completed!");
    return albumShareUrl;
  } catch (err: any) {
    const msg = err?.message || String(err);
    addToast(`DropMB album offload failed: ${msg}`, "error", 6000);
    log.error("dropmb", `Album offload failed for "${albumName}": ${msg}`);
    return null;
  }
}
```

(`getDownloadedFilePath`, `httpFetch`, `CHUNK_SIZE`, `MediaSourceVersion`, `createVersionFromItem`, `persistItems` are all already imported/defined in this file — verified.)

**3. `src/pages/music/MusicLibraryPage.tsx`** — replace the body of the "Offload Album" `onClick` (lines ~546-568) with:

```tsx
onClick={async () => {
  setOffloadingAlbum(true);
  const pending = selectedAlbum.tracks.filter(
    (track) => !track.versions?.some(
      (v) => v.remoteName === "dropmb" || v.remotePath.toLowerCase().includes("dropmb.com")
    )
  );
  if (pending.length === 0) {
    addToast("All tracks in this album are already on DropMB.", "info");
  } else {
    await offloadAlbumToDropmb(selectedAlbum.name, pending);
  }
  setOffloadingAlbum(false);
}}
```

(Update the import at line 20: `import { offloadAlbumToDropmb, getDropmbExpirationStatus } from "../../lib/dropmbOffload";` — keep `offloadAudioItemToDropmb` only if still referenced elsewhere in the file.)

**4. `src/lib/udrop.ts`** — three patches:

```typescript
// Per-segment path encoding (encodeURIComponent would break '/' into %2F)
const encodeWebdavPath = (p: string) =>
  p.split("/").filter(Boolean).map(encodeURIComponent).join("/");

// (a) Subfolder-aware rclone existence check — replace checkUdropFileExistsViaRclone:
export async function checkUdropFileExistsViaRclone(
  fileName: string,
  remoteName = "udrop",
  subpath = ""
): Promise<boolean> {
  try {
    const res = await invoke<any[]>("list_remote_path", {
      remote: remoteName,
      path: subpath.replace(/^\/+|\/+$/g, ""),
    });
    if (Array.isArray(res)) {
      const cleanTarget = fileName.toLowerCase().trim();
      return res.some((item) => {
        const name = (item.name || item.path || "").toLowerCase().trim();
        return name === cleanTarget || name.endsWith("/" + cleanTarget);
      });
    }
  } catch (e) {
    console.warn("Could not check uDrop via Rclone:", e);
  }
  return false;
}

// (b) Folder-aware API listing — add beside listUdropRootFiles:
export async function listUdropFolder(parentFolderId?: string | number): Promise<{
  files: UdropApiFile[];
  folders: Array<{ id: string | number; folderName?: string; name?: string }>;
}> {
  const { accessToken, accountId } = await getUdropAuthToken();
  const formData = new URLSearchParams();
  formData.append("access_token", accessToken);
  formData.append("account_id", accountId);
  if (parentFolderId != null) formData.append("parent_folder_id", String(parentFolderId));
  const res = await httpFetchWithTimeout(`${API_BASE}/folder/listing`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  }, 8000);
  if (!res.ok) throw new Error(`uDrop folder/listing failed (${res.status})`);
  const json = await res.json();
  if (json._status === "error") throw new Error(json.response || "Failed listing uDrop folder");
  return { files: json.data?.files || [], folders: json.data?.folders || [] };
}

// (c) Recursive search — replace findUdropFileByName:
export async function findUdropFileByName(
  fileName: string,
  maxFolders = 30
): Promise<UdropApiFile | null> {
  const clean = fileName.toLowerCase().trim();
  const queue: Array<string | number | undefined> = [undefined]; // undefined = root
  const matches: UdropApiFile[] = [];
  let crawled = 0;
  while (queue.length > 0 && crawled < maxFolders) {
    const folderId = queue.shift();
    crawled++;
    try {
      const { files, folders } = await listUdropFolder(folderId);
      for (const f of files) {
        if (f.filename.toLowerCase().trim() === clean) matches.push(f);
      }
      for (const fl of folders) queue.push(fl.id);
    } catch { /* continue with remaining folders */ }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => Number(b.id) - Number(a.id));
  return matches[0];
}

// (d) In getUdropDirectLinkForFile, change the fallback line to accept an optional subpath:
//   return `https://www.udrop.com/webdav/${encodeWebdavPath(subpath ? `${subpath}/${fileName}` : fileName)}`;
// (add `subpath = ""` as a second parameter; callers that know the relative dir, e.g.
//  `media/Music/${albumFolder}`, pass it through.)
```

---

## 10. Item 10: Admin Offload Mirrors Panel on Details — **[VERIFIED]**

Anchors confirmed: `MediaDetailPage.tsx` "Full Remote Path" card at ~1120-1145, `MediaDetailsModal.tsx` at ~889-908, `isGuest` exists in both (MediaDetailPage:102, MediaDetailsModal:130).

### Drop-in: `src/components/library/OffloadMirrorsPanel.tsx` (new file)

```tsx
import { useState } from "react";
import { Copy, Check, Link2 } from "lucide-react";
import type { MediaItem } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { getDropmbExpirationStatus } from "../../lib/dropmbOffload";

type Mirror = { key: string; label: string; colorCls: string; url: string; badge?: string };

export function OffloadMirrorsPanel({ item }: { item: MediaItem }) {
  const addToast = useToastStore((s) => s.addToast);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const mirrors: Mirror[] = [];
  const seen = new Set<string>();
  const push = (m: Mirror) => {
    if (m.url && !seen.has(m.url)) {
      seen.add(m.url);
      mirrors.push(m);
    }
  };

  if (item.dropmbShareUrl) {
    push({
      key: "dropmb-share",
      label: "DropMB",
      colorCls: "bg-cyan-500/15 border-cyan-500/40 text-cyan-300",
      url: item.dropmbShareUrl,
      badge: getDropmbExpirationStatus(item.dropmbExpiresAt).label,
    });
  }
  for (const v of item.versions || []) {
    const rn = (v.remoteName || "").toLowerCase();
    const url = v.shareUrl || v.remotePath;
    if (rn.includes("dropmb")) {
      push({
        key: `dropmb-${v.id}`, label: "DropMB",
        colorCls: "bg-cyan-500/15 border-cyan-500/40 text-cyan-300",
        url, badge: getDropmbExpirationStatus(v.expiresAt ?? item.dropmbExpiresAt).label,
      });
    } else if (rn.includes("streamtape") || v.sourceType === "streamtape") {
      push({
        key: `st-${v.id}`, label: "Streamtape",
        colorCls: "bg-amber-500/15 border-amber-500/40 text-amber-300",
        url: v.shareUrl || url,
      });
    } else if (rn.includes("udrop")) {
      push({
        key: `ud-${v.id}`, label: "uDrop",
        colorCls: "bg-violet-500/15 border-violet-500/40 text-violet-300",
        url,
      });
    } else if (rn.includes("dood") || v.sourceType === "doodstream") {
      push({
        key: `dood-${v.id}`, label: "DoodStream",
        colorCls: "bg-rose-500/15 border-rose-500/40 text-rose-300",
        url: v.shareUrl || url,
      });
    } else if (rn.includes("telegram") || rn.includes("tg-") || v.sourceType === "telegram") {
      push({
        key: `tg-${v.id}`, label: "Telegram",
        colorCls: "bg-sky-500/15 border-sky-500/40 text-sky-300",
        url: v.telegramDirectUrl || url,
      });
    } else if (v.sourceType === "real-debrid") {
      push({
        key: `rd-${v.id}`, label: "Real-Debrid",
        colorCls: "bg-emerald-500/15 border-emerald-500/40 text-emerald-300",
        url,
      });
    }
  }

  if (mirrors.length === 0) return null;

  return (
    <div className="pt-2.5 border-t border-border/40 space-y-1.5">
      <span className="text-subtle/70 text-[10px] uppercase font-mono flex items-center gap-1.5">
        <Link2 size={10} /> Offload Mirrors &amp; Direct Links
      </span>
      {mirrors.map((m) => (
        <div key={m.key} className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1 flex items-center gap-2">
            <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono font-semibold shrink-0 ${m.colorCls}`}>
              {m.label}
            </span>
            <p className="text-text font-mono text-xs truncate" title={m.url}>{m.url}</p>
            {m.badge && <span className="text-[10px] text-subtle shrink-0">{m.badge}</span>}
          </div>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(m.url);
              setCopiedKey(m.key);
              addToast(`Copied ${m.label} link`, "success");
              setTimeout(() => setCopiedKey(null), 2000);
            }}
            className="btn-secondary text-xs py-1 px-2 flex items-center gap-1 shrink-0"
          >
            {copiedKey === m.key ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
          </button>
        </div>
      ))}
    </div>
  );
}
```

**Integration** — in both files, directly **after** the closing `</div>` of the "Full Remote Path" row (MediaDetailPage ~1145; MediaDetailsModal ~910), add:

```tsx
{!isGuest && <OffloadMirrorsPanel item={item} />}
```

(plus the import). Guests see nothing — the component is not rendered for them at all.

---

## 11. Item 11: Multi-Account Pool & Quota Rotation (GHA / Kaggle) — **[CORRECTED]**

### A. Corrections and Caveats
1. **Detection correction:** a GHA `workflow_dispatch` POST frequently returns **204 even when Actions minutes are exhausted** — the run is then created and immediately fails at queue time with a billing annotation. Reactive 403/422 matching alone will miss this. The corrected design uses **both**: (a) reactive rotation on 403/422 with quota keywords, and (b) a proactive check of `GET /users/{owner}/settings/billing/actions` (`total_minutes_used` vs `included_minutes`) before selecting an account. The billing endpoint needs a classic PAT with `user` scope or a fine-grained token with "Plan" read — note this in the Settings helper text.
2. **Kaggle correction:** credentials live in the **Rust** store (`rcloneflix-keys.json`, keys `kaggle_username`/`kaggle_key` — kaggle.rs:126-129) and every `dispatch_kaggle_*` command loads them from there. Rotation therefore works by calling the existing `saveKaggleCredentials(...)` with the next account **before retrying the dispatch** — no Rust changes required. Also: Kaggle GPU-quota exhaustion usually surfaces as a kernel-runtime failure, not a push failure; rotation catches push-time quota errors, and the status poller should mark the account exhausted when kernel output contains the GPU-quota message.
3. **⚠️ Terms-of-service caution (do not delete this note):** GitHub's ToS permits **one free personal account per person**, and Kaggle similarly prohibits multiple accounts for quota evasion. This feature must be framed and shipped as *"pool of accounts you legitimately control"* (e.g. a personal + an organization account, or paid accounts). The app must not automate account creation, and the Settings copy should not encourage creating throwaway accounts. The original plan's "users can easily create multiple free GitHub accounts (5 accounts = 10,000 minutes)" framing is removed.

### B. Drop-in Code

**1. `src/store/appStore.ts`:**

```typescript
export type GhaAccount = {
  id: string;
  label: string;
  owner: string;
  repo: string;
  token: string;
  workflowFile?: string;
  branch?: string;
  isExhausted?: boolean;
  exhaustedAt?: number;
};

export type KaggleAccount = {
  id: string;
  label: string;
  username: string;
  key: string;
  isExhausted?: boolean;
  exhaustedAt?: number;
};
```

Add to the store state interface + defaults + setters (all optional ⇒ no persisted-state migration):

```typescript
  ghaAccounts?: GhaAccount[];          // extra accounts; the existing ghaConfig stays the primary
  kaggleAccounts?: KaggleAccount[];    // extra accounts; kaggleUsername/kaggleKey stay the primary
  setGhaAccounts: (accounts: GhaAccount[]) => void;
  setKaggleAccounts: (accounts: KaggleAccount[]) => void;
  // implementations:
  setGhaAccounts: (accounts) => set({ ghaAccounts: accounts }),
  setKaggleAccounts: (accounts) => set({ kaggleAccounts: accounts }),
```

**2. `src/lib/cloudWorkerRouter.ts`** — refactor `dispatchGitHubAction` into a pool loop. Rename the existing body to a private `dispatchGhaToAccount(acct, params)` (replace its `useAppStore` reads with the `acct` fields: `token/owner/repo/workflowFile/branch`), then:

```typescript
function getGhaAccountPool(): GhaAccount[] {
  const { ghaConfig, ghaAccounts } = useAppStore.getState();
  const pool: GhaAccount[] = [];
  if (ghaConfig?.token && ghaConfig?.owner && ghaConfig?.repo) {
    pool.push({
      id: "primary",
      label: `Primary (${ghaConfig.owner})`,
      owner: ghaConfig.owner,
      repo: ghaConfig.repo,
      token: ghaConfig.token,
      workflowFile: ghaConfig.workflowFile,
      branch: (ghaConfig as any).branch,
    });
  }
  for (const a of ghaAccounts || []) {
    if (a.token && a.owner && a.repo) pool.push(a);
  }
  // Auto-recover exhausted accounts after 24h (monthly quota may have reset; cheap retry)
  const RECOVERY_MS = 24 * 60 * 60 * 1000;
  const fresh = pool.filter((a) => !a.isExhausted || Date.now() - (a.exhaustedAt || 0) > RECOVERY_MS);
  const stale = pool.filter((a) => !fresh.includes(a));
  return [...fresh, ...stale]; // exhausted accounts last, never dropped entirely
}

function markGhaExhausted(id: string) {
  const { ghaAccounts, setGhaAccounts } = useAppStore.getState();
  if (id === "primary") return; // primary is tracked implicitly by pool ordering on next failure
  setGhaAccounts(
    (ghaAccounts || []).map((a) =>
      a.id === id ? { ...a, isExhausted: true, exhaustedAt: Date.now() } : a
    )
  );
}

/** Proactive quota probe; returns false when the account is out of included minutes. */
async function ghaAccountHasMinutes(acct: GhaAccount): Promise<boolean> {
  try {
    const res = await httpFetch(`https://api.github.com/users/${acct.owner}/settings/billing/actions`, {
      headers: {
        Authorization: `Bearer ${acct.token.trim()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return true; // token lacks billing scope → cannot tell → assume OK
    const j = await res.json();
    if (typeof j.total_minutes_used === "number" && typeof j.included_minutes === "number") {
      return j.total_minutes_used < j.included_minutes;
    }
  } catch { /* network issue → assume OK */ }
  return true;
}

const QUOTA_ERR = /usage limit|billing|minutes.*exceed|spending|payment/i;

export async function dispatchGitHubAction(params: {
  jobType: CloudJobType;
  payload: any;
}): Promise<{ runUrl: string; status: string; workflowRunId?: number }> {
  const pool = getGhaAccountPool();
  if (pool.length === 0) {
    throw new Error("GitHub Actions runner is not configured in Settings.");
  }
  let lastErr: any = null;
  for (const acct of pool) {
    if (pool.length > 1 && !(await ghaAccountHasMinutes(acct))) {
      markGhaExhausted(acct.id);
      lastErr = new Error(`GHA account "${acct.label}" is out of included Actions minutes.`);
      continue;
    }
    try {
      return await dispatchGhaToAccount(acct, params);
    } catch (e: any) {
      const msg = String(e?.message || e);
      const quotaHit = /HTTP (403|422)/.test(msg) && QUOTA_ERR.test(msg);
      if (!quotaHit) throw e; // real config/network error — surface it, do not rotate
      markGhaExhausted(acct.id);
      lastErr = e;
    }
  }
  throw lastErr || new Error("All configured GitHub Actions accounts are quota-exhausted.");
}
```

**Poller note for the implementer:** the GHA run poller (`initGitHubActionsPoller`) still reads `ghaConfig` directly; when multi-account is active, jobs dispatched on a secondary account are polled with the wrong token. Record `acct.id` + `owner/repo/token` on the job entry at dispatch time and poll per-job with that account's token (the job stores already carry per-job metadata — extend them with `ghaAccountId`).

**3. Kaggle rotation (`src/lib/kaggleTranscode.ts`)** — add a wrapper and route the three dispatch helpers through it:

```typescript
const KAGGLE_QUOTA_ERR = /quota|gpu.*limit|limit.*exceed|maximum.*session/i;

async function withKaggleRotation<T>(dispatch: () => Promise<T>): Promise<T> {
  try {
    return await dispatch();
  } catch (e: any) {
    const msg = String(e?.message || e);
    const { kaggleAccounts, kaggleUsername } = useAppStore.getState();
    const backups = (kaggleAccounts || []).filter(
      (a) => a.username && a.key && !a.isExhausted && a.username !== kaggleUsername
    );
    if (!KAGGLE_QUOTA_ERR.test(msg) || backups.length === 0) throw e;
    const next = backups[0];
    // Kaggle creds live in the Rust keys store — swap them, then retry once.
    await saveKaggleCredentials({ username: next.username, key: next.key });
    useAppStore.getState().setKaggleUsername(next.username);
    useAppStore.getState().setKaggleKey(next.key);
    return await dispatch();
  }
}
// Example: export async function dispatchKaggleTranscode(req) {
//   return withKaggleRotation(() => invoke("dispatch_kaggle_transcode", { req }));
// }
```

**4. Settings UI (`src/pages/SettingsPage.tsx`)** — in the existing GHA panel (anchors: handlers at ~488-508) and Kaggle panel (~195-200), add an account-pool list below the primary form. Minimal structure (the implementing model wires the obvious `useState` form bindings):

```tsx
{/* Backup account pool */}
<div className="space-y-2 pt-3 border-t border-border/40">
  <span className="text-xs font-semibold text-subtle uppercase">Backup Account Pool</span>
  {(ghaAccounts || []).map((a) => (
    <div key={a.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface border border-border text-xs">
      <div className="min-w-0 flex-1">
        <span className="font-semibold text-text">{a.label}</span>
        <span className="text-subtle font-mono ml-2">{a.owner}/{a.repo}</span>
      </div>
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${a.isExhausted ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300"}`}>
        {a.isExhausted ? "Quota Exhausted" : "Standby"}
      </span>
      <button onClick={() => setGhaAccounts((ghaAccounts || []).filter((x) => x.id !== a.id))}
        className="p-1 text-subtle hover:text-rose-400 cursor-pointer"><Trash2 size={13} /></button>
    </div>
  ))}
  <button onClick={() => setShowAddGhaAccount(true)} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5">
    <Plus size={13} /> Add Backup Account
  </button>
  <p className="text-[10px] text-subtle">
    Add accounts you legitimately control (e.g. an organization account or a paid plan).
    Auto-failover engages when the active account's included minutes run out.
  </p>
</div>
```

(The inline add-form mirrors the existing primary GHA form fields; identical pattern for Kaggle with `username`/`key`.)

---

## 12. Item 12: Cast & DLNA — Audit Completed — **[AUDIT ANSWERED]**

The plan asked for verification; here are the verified answers, with fixes.

### A. Finding 1 — CRITICAL: casting local streams is broken by design (confirmed bug)
- Every local stream server binds **loopback only**: `rclone serve http` → `--addr 127.0.0.1:{port}` (player.rs:171), DirectPlay proxy → `127.0.0.1:8552` (stream_proxy.rs:107), InfiniDysk → `127.0.0.1:8553` (usenet_dav.rs:431).
- `cast_load_media` (cast.rs:174-188) rewrites `127.0.0.1` → the host's LAN IP in the URL sent to the Chromecast. **Nothing listens on the LAN interface**, so the device gets *connection refused* for every local/rclone/usenet/proxy stream. Only direct-CDN URLs can ever have cast successfully.
- **Fix (drop-in, keeps loopback-only security for normal operation):** a LAN relay that is only started while casting. Add to `cast.rs`:

```rust
use std::sync::OnceLock;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener as TokioTcpListener;

static CAST_RELAY: OnceLock<tokio::sync::Mutex<Option<u16>>> = OnceLock::new();

/// Starts (once) a 0.0.0.0-bound TCP relay that forwards raw bytes to a loopback port,
/// so Chromecast devices on the LAN can reach streams served on 127.0.0.1.
async fn ensure_cast_relay(local_port: u16) -> Result<u16, String> {
    let lock = CAST_RELAY.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut guard = lock.lock().await;
    // One relay per local port is enough for a single active cast session.
    // (Restart with a new target when the port changes.)
    let listener = TokioTcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("Cast relay bind failed: {e}"))?;
    let relay_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((mut inbound, _)) => {
                    tokio::spawn(async move {
                        if let Ok(mut outbound) =
                            TcpStream::connect(("127.0.0.1", local_port)).await
                        {
                            let _ = copy_bidirectional(&mut inbound, &mut outbound).await;
                        }
                    });
                }
                Err(_) => break,
            }
        }
    });
    *guard = Some(relay_port);
    Ok(relay_port)
}
```

Then in `cast_load_media`, replace the URL translation block (lines 174-188) with:

```rust
let effective_stream_url = if req.stream_url.contains("127.0.0.1") || req.stream_url.contains("localhost") {
    if let Some(ref dev_ip) = current_status.device_ip {
        if let Some(local_ip) = get_local_ip_for(dev_ip) {
            // Local servers bind loopback only — bridge via a LAN relay.
            let local_port = reqwest::Url::parse(&req.stream_url)
                .ok()
                .and_then(|u| u.port())
                .unwrap_or(80);
            match ensure_cast_relay(local_port).await {
                Ok(relay_port) => {
                    let url = reqwest::Url::parse(&req.stream_url).ok();
                    match url {
                        Some(mut u) => {
                            let _ = u.set_host(Some(&local_ip));
                            let _ = u.set_port(Some(relay_port));
                            u.to_string()
                        }
                        None => req.stream_url.clone(),
                    }
                }
                Err(e) => {
                    log::warn!("[cast] Relay start failed ({}); falling back to raw URL", e);
                    req.stream_url.replace("127.0.0.1", &local_ip).replace("localhost", &local_ip)
                }
            }
        } else { req.stream_url.clone() }
    } else { req.stream_url.clone() }
} else {
    req.stream_url.clone()
};
```

(`TcpStream` from `tokio::net` — add the import if cast.rs doesn't have it. Optionally stop the relay in `disconnect_cast_device`; leaving it running is harmless as it only forwards to loopback.)

### B. Finding 2 — avahi-browse hard dependency (confirmed)
`discover_cast_devices` (cast.rs:398-455) returns silently-empty when `avahi-browse` is absent. Pure-Rust fallback via the `mdns-sd` crate:

```toml
# src-tauri/Cargo.toml
mdns-sd = "0.13"
```

```rust
// After the avahi attempt in discover_cast_devices, before the final log line:
if devices.is_empty() {
    let found = tokio::task::spawn_blocking(|| {
        let mut out: Vec<CastDevice> = Vec::new();
        if let Ok(mdns) = mdns_sd::ServiceDaemon::new() {
            if let Ok(receiver) = mdns.browse("_googlecast._tcp.local.") {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
                while std::time::Instant::now() < deadline {
                    if let Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) =
                        receiver.recv_timeout(std::time::Duration::from_millis(600))
                    {
                        let ip = info
                            .get_addresses()
                            .iter()
                            .find(|a| a.is_ipv4())
                            .map(|a| a.to_string());
                        if let Some(ip) = ip {
                            let name = info
                                .get_property_val_str("fn")
                                .unwrap_or_else(|| info.get_fullname())
                                .to_string();
                            let model = info
                                .get_property_val_str("md")
                                .unwrap_or("Chromecast")
                                .to_string();
                            let port = info.get_port();
                            if !out.iter().any(|d| d.ip == ip && d.port == port) {
                                out.push(CastDevice {
                                    id: format!("{}:{}", ip, port),
                                    name,
                                    model,
                                    ip,
                                    port,
                                });
                            }
                        }
                    }
                }
            }
            let _ = mdns.shutdown();
        }
        out
    })
    .await
    .unwrap_or_default();
    devices.extend(found);
}
```

(*Implementer note:* `mdns-sd`'s exact accessor names shift between minor versions — if `get_addresses()` returns `&HashSet<Ipv4Addr>` in the pinned version, drop the `is_ipv4()` filter. Compile-check decides.)

### C. Finding 3 — MIME / container reality check (honest limitation)
`DefaultMediaReceiver` plays MP4 (H.264/AAC), WebM, and HLS. The `content_type` inference at cast.rs:192-201 defaults everything non-m3u8 to `video/mp4` — an MKV/AC3/DTS stream will load and then stall or play silent. **A full remux pipeline is out of scope for v1.0.3** (deferred). Minimal honest UX: in the frontend cast launcher, when `shouldForceVlc(item.filename)` is true for the item, show a warning toast — *"This container/codec may not play on Chromecast. Consider Cloud Transcode to H.264/AAC first."* No backend change.

### D. Finding 4 — DLNA verified ✓, Tailscale claim corrected
- `rclone serve dlna --addr 0.0.0.0:8200` (dlna.rs:294-295) — **correctly LAN-bound**; rclone's DLNA server handles its own SSDP announcements on UDP 1900. Verified correct; no change.
- **Correction:** Tailscale **Funnel is HTTPS-only and cannot carry SSDP multicast or cleartext HTTP** — it can never expose DLNA to remote devices. `set_tailscale_serve`/`funnel` remain valid for *direct HTTP stream URLs* (e.g. pasting a stream URL into a remote player), but the plan's "verify Funnel does not disrupt DLNA clients" task is moot: DLNA is LAN-only by protocol. Document this in the Settings copy for the Tailscale section.

---

## 13. Item 13: One-Off iOS Build Pipeline — **[SCRAPPED — not feasible as specified]**

**Verdict: scrapped under the "absolutely impossible or highly difficult" criterion.** The proposed Capacitor workflow would produce an installable `.ipa` whose UI renders — and then every single feature fails, because:

1. **iOS prohibits spawning child processes.** The entire backend architecture is sidecar-based: `rclone serve http` daemon pools, the AList binary, external VLC — all launched via `Command::spawn`. None of this can exist on iOS, under any wrapper (Capacitor *or* native Tauri iOS). There is no iOS rclone binary and no mechanism to run one.
2. **The frontend is 100% `invoke()`-driven.** Under Capacitor there is no Tauri runtime at all — every `invoke("...")` rejects. Playback, libraries (SQLite via Rust), streaming, settings persistence: all dead. The app would be a splash screen with non-functional chrome.
3. **Native blockers even under Tauri's official iOS target:** `vlc-rs = "0.3"` (Cargo.toml:32) and the X11 XID embedding path do not compile for iOS; `avahi-browse`, `tailscale`, `ffprobe` shell-outs don't exist there.

Since the stated priority for this plan is *"making every proposed change functional"*, shipping a knowingly non-functional shell fails the bar. **Removed from the v1.0.3 scope and from the test matrix.**

*Viable future direction (out of scope, for the roadmap):* a thin iOS client that talks to a RcloneFlix instance running on the user's desktop/home server over Tailscale (the `set_tailscale_serve` HTTP surface already exists) — i.e., a remote-control + stream-receiver app, not a port.

---

## 14. Item 14: Album-Level Fix Match & Tracklist Reconciliation — **[VERIFIED]**

All three symptoms confirmed in source (MusicLibraryPage:546-556, FixMatchModal:667, FixMatchModal:729-756). The TV sibling-propagation block at FixMatchModal:759+ is the in-repo precedent for the album propagation pattern. Deezer via plain `safeFetch` already has precedent at line 694.

### Drop-in Code

**1. `src/components/library/FixMatchModal.tsx`:**

Props:

```typescript
// Add to Props:
  mode?: "track" | "album";
  albumTracks?: MediaItem[];
```

Album search — in the `item.libraryType === "music"` branch (line ~664), when `mode === "album"`, replace the two queries with album-entity queries:

```typescript
      } else if (item.libraryType === "music" && mode === "album") {
        try {
          const itunesRes = await safeFetch(
            `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=album&limit=10`
          );
          if (itunesRes && itunesRes.ok) {
            const data = await itunesRes.json();
            (data.results ?? []).forEach((r: any) => {
              const rawPoster = r.artworkUrl100 as string | undefined;
              const poster = rawPoster ? rawPoster.replace(/\/\d+x\d+bb\./, "/600x600bb.") : undefined;
              const y = r.releaseDate ? parseInt(r.releaseDate.split("-")[0]) : undefined;
              found.push({
                id: String(r.collectionId),
                title: r.collectionName ?? q,
                artist: r.artistName,
                album: r.collectionName,
                year: isNaN(y as number) ? undefined : y,
                genres: r.primaryGenreName ? [r.primaryGenreName] : undefined,
                posterUrl: poster,
                overview: `${r.artistName ?? ""} • ${r.trackCount ?? "?"} tracks`,
                source: "itunes",
              });
            });
          }
        } catch {}
        if (found.length === 0) {
          try {
            const deezerRes = await safeFetch(
              `https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=10`
            );
            if (deezerRes && deezerRes.ok) {
              const data = await deezerRes.json();
              (data.data ?? []).forEach((r: any) => {
                found.push({
                  id: `deezer-${r.id}`,
                  title: r.title ?? q,
                  artist: r.artist?.name,
                  album: r.title,
                  posterUrl: r.cover_xl || r.cover_big || r.cover_medium,
                  overview: `${r.artist?.name ?? ""} • ${r.nb_tracks ?? "?"} tracks`,
                  source: "deezer",
                });
              });
            }
          } catch {}
        }
      } else if (item.libraryType === "music") {
        // ... existing track-mode iTunes/Deezer code unchanged ...
```

Album selection handler — add next to `handleSelect` and call it from the result card's `onClick` when `mode === "album"`:

```typescript
  const handleSelectAlbum = async (result: SearchResult) => {
    setSelected(result.id);
    const tracks = [...(albumTracks || [])].sort(
      (a, b) => (a.trackNumber ?? 999) - (b.trackNumber ?? 999) || a.title.localeCompare(b.title)
    );
    if (tracks.length === 0) return;

    // 1. Fetch the official tracklist
    let officialTracks: Array<{ title: string; trackNumber?: number; duration?: number }> = [];
    try {
      if (result.source === "itunes") {
        const res = await safeFetch(
          `https://itunes.apple.com/lookup?id=${encodeURIComponent(result.id)}&entity=song&limit=200`
        );
        if (res && res.ok) {
          const data = await res.json();
          officialTracks = (data.results ?? [])
            .filter((r: any) => r.wrapperType === "track")
            .map((r: any) => ({
              title: r.trackName,
              trackNumber: r.trackNumber,
              duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined,
            }));
        }
      } else if (result.source === "deezer") {
        const deezerId = result.id.replace(/^deezer-/, "");
        const res = await safeFetch(`https://api.deezer.com/album/${deezerId}/tracks?limit=200`);
        if (res && res.ok) {
          const data = await res.json();
          officialTracks = (data.data ?? []).map((r: any, i: number) => ({
            title: r.title,
            trackNumber: r.track_position ?? i + 1,
            duration: r.duration,
          }));
        }
      }
    } catch (err) {
      console.warn("Tracklist lookup failed; applying album metadata only:", err);
    }
    officialTracks.sort((a, b) => (a.trackNumber ?? 999) - (b.trackNumber ?? 999));

    // 2. Atomically update ALL tracks: album/artist/art/year/genres on everyone,
    //    official track title where an aligned entry exists (by trackNumber, else index).
    const updates: MediaItem[] = tracks.map((t, idx) => {
      const byNumber =
        t.trackNumber != null
          ? officialTracks.find((o) => o.trackNumber === t.trackNumber)
          : undefined;
      const official = byNumber ?? officialTracks[idx];
      return {
        ...t,
        album: result.album ?? result.title,
        artist: result.artist ?? t.artist,
        posterUrl: result.posterUrl ?? t.posterUrl,
        year: result.year ?? t.year,
        genres: result.genres ?? t.genres,
        title: official?.title || t.title,
        trackNumber: t.trackNumber ?? official?.trackNumber,
        duration: t.duration ?? official?.duration,
        metadataId: result.id,
        metadataSource: result.source,
        metadataConfidence: "manual" as const,
      };
    });

    useAppStore.getState().bulkUpsertMediaItems(updates);
    persistItems(updates).catch((err) => console.error("Failed persisting album match:", err));
    onClose();
  };
```

(Result card `onClick`: `mode === "album" ? handleSelectAlbum(result) : handleSelect(result)`.)

**2. `src/pages/music/MusicLibraryPage.tsx`** — the album-header button (line ~546-556): add an `albumFixMode` state flag set by this button, and pass it through to the modal render:

```tsx
// state: const [albumFixMode, setAlbumFixMode] = useState(false);
<button
  onClick={() => { setAlbumFixMode(true); setFixMatchTarget(selectedAlbum.tracks[0]); }}
  ...
>
// At the FixMatchModal render site:
<FixMatchModal
  ...existing props...
  mode={albumFixMode ? "album" : "track"}
  albumTracks={albumFixMode ? selectedAlbum?.tracks : undefined}
  onClose={() => { setAlbumFixMode(false); /* + existing close logic */ }}
/>
```

The per-track search icon (line ~810) keeps the default `mode="track"` — granular fixes unchanged.

**API notes (verified):** iTunes Search/Lookup support CORS and `entity=album` / `lookup?id=&entity=song` exactly as used above. Deezer's public API is already consumed by this modal via `safeFetch` with silent failure — the album endpoints follow the same shape. MusicBrainz was dropped from the search path (slower, 1 req/s rate limit, adds little over iTunes+Deezer here); it is used in Item 15 where it is the only source for personnel credits.

---

## 15. Item 15: Vinyl Warmth DSP & Liner Notes — **[CORRECTED]**

### A. Platform Reality (critical correction)
`AudioMiniPlayer.tsx:264-269`: **WebAudio media-element routing is deliberately disabled on Linux desktop** — WebKitGTK disconnects the native GStreamer sink when `createMediaElementSource` is called (`if (isLinuxDesktop) return;` at line 281). Therefore:
- The plan's WaveShaper-in-EQ-chain **would be silently inert on ChromeOS/Linux — the primary platform.**
- **Rescope:** (1) tube-saturation WaveShaper ships for Windows/Android where the graph actually runs; (2) the needle-drop transient and surface-crackle bed use a **standalone `AudioContext` + `AudioBufferSourceNode`** that never touches the media element — this works on every platform including Linux, and is what delivers the "DroppedNeedle" aesthetic everywhere.

### B. Drop-in: DSP (`src/components/audioplayer/AudioMiniPlayer.tsx`)

**1. State & setting** (persist like the existing EQ prefs):

```typescript
type VinylMode = "off" | "tube" | "vinyl";
const [vinylMode, setVinylMode] = useState<VinylMode>(
  () => (localStorage.getItem("rcloneflix_vinyl_mode") as VinylMode) || "off"
);
useEffect(() => { try { localStorage.setItem("rcloneflix_vinyl_mode", vinylMode); } catch {} }, [vinylMode]);
```

**2. Tube saturation (non-Linux graph only)** — add a ref `const tubeShaperRef = useRef<WaveShaperNode | null>(null);` and a curve helper:

```typescript
function makeTubeCurve(drive = 0.25): Float32Array {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + drive * 3;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k) / norm; // gentle symmetric soft-clip ≈ even-harmonic warmth
  }
  return curve;
}
```

In `attachWebAudio`, change the graph construction (currently `preamp.connect(filters[0])`, line ~304) to insert the shaper:

```typescript
        const tube = ctx.createWaveShaper();
        tube.curve = makeTubeCurve(0.25);
        tube.oversample = "2x";
        preamp.connect(tube);
        tube.connect(filters[0]);
        tubeShaperRef.current = tube;
```

And react to the toggle (works as bypass by flattening the curve — avoids graph re-patching):

```typescript
useEffect(() => {
  const tube = tubeShaperRef.current;
  if (!tube) return;
  tube.curve = vinylMode === "off" ? null : makeTubeCurve(vinylMode === "vinyl" ? 0.35 : 0.2);
}, [vinylMode]);
```

**3. Needle drop + crackle (ALL platforms, incl. Linux)** — standalone context, procedural buffers, no media-element involvement:

```typescript
const vinylCtxRef = useRef<AudioContext | null>(null);
const crackleNodeRef = useRef<AudioBufferSourceNode | null>(null);

function getVinylCtx(): AudioContext | null {
  try {
    if (!vinylCtxRef.current) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return null;
      vinylCtxRef.current = new Ctx();
    }
    if (vinylCtxRef.current.state === "suspended") void vinylCtxRef.current.resume();
    return vinylCtxRef.current;
  } catch { return null; }
}

/** 1.2s needle-drop transient: low thump + filtered noise burst + a few crackles. */
function playNeedleDrop() {
  const ctx = getVinylCtx();
  if (!ctx) return;
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.floor(sr * 1.2), sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const thump = Math.exp(-t * 18) * Math.sin(2 * Math.PI * 55 * t) * 0.5;      // arm contact
    const hiss = (Math.random() * 2 - 1) * Math.exp(-t * 4) * 0.06;              // groove noise burst
    const crackle = Math.random() < 0.0008 ? (Math.random() * 2 - 1) * 0.35 : 0; // sparse pops
    d[i] = thump + hiss + crackle;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 900;
  bp.Q.value = 0.6;
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  src.connect(bp); bp.connect(gain); gain.connect(ctx.destination);
  src.start();
}

/** Looping low-level surface crackle bed while vinyl mode is active. */
function startCrackleBed() {
  const ctx = getVinylCtx();
  if (!ctx || crackleNodeRef.current) return;
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, sr * 4, sr);
  const d = buf.getChannelData(0);
  let pink = 0;
  for (let i = 0; i < d.length; i++) {
    pink = pink * 0.97 + (Math.random() * 2 - 1) * 0.03;                          // cheap pink-ish noise
    const pop = Math.random() < 0.00035 ? (Math.random() * 2 - 1) * 0.5 : 0;
    d[i] = pink * 0.25 + pop;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0.035; // well under the music
  src.connect(gain); gain.connect(ctx.destination);
  src.start();
  crackleNodeRef.current = src;
}

function stopCrackleBed() {
  try { crackleNodeRef.current?.stop(); } catch {}
  crackleNodeRef.current = null;
}
```

Wire-up: in the existing track-change/play effect, when `vinylMode === "vinyl"` call `playNeedleDrop()` on each new track start and `startCrackleBed()` while playing / `stopCrackleBed()` on pause/stop and on mode change away from `"vinyl"`.

**4. UI** — in the EQ/DSP drawer, a three-option segmented control:

```tsx
<div className="space-y-1">
  <span className="text-[10px] uppercase font-mono text-subtle">Analog Warmth</span>
  <div className="flex rounded-lg border border-border overflow-hidden text-xs">
    {([["off", "Off"], ["tube", "Warm Tube"], ["vinyl", "Vinyl + Needle"]] as const).map(([v, lbl]) => (
      <button key={v} onClick={() => setVinylMode(v)}
        className={`flex-1 px-2 py-1.5 cursor-pointer ${vinylMode === v ? "bg-cyan-500 text-void font-semibold" : "bg-surface text-subtle hover:text-text"}`}>
        {lbl}
      </button>
    ))}
  </div>
  {/* Honest platform note */}
  <p className="text-[10px] text-subtle">Tube saturation applies on Windows/Android; needle-drop &amp; crackle work everywhere.</p>
</div>
```

### C. Drop-in: Liner Notes & Booklet (`src/lib/musicCredits.ts` — new file)

**MusicBrainz `inc` correction:** the plan's `inc=artist-credits+recordings+work-level-rels+work-rels` returns **no personnel at all** — producer/engineer/instrument credits are *artist relationships at recording level*, which require `artist-rels` + `recording-level-rels`. Corrected below.

```typescript
import { invoke } from "@tauri-apps/api/core";

export type AlbumCredit = { role: string; name: string; tracks?: string[] };

const MB = "https://musicbrainz.org/ws/2";

async function mbFetch(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/**
 * Fetches producer / engineer / performer credits for an album from MusicBrainz.
 * Personnel live in artist-rels at recording level, hence the inc list below.
 * MusicBrainz rate limit: 1 req/s — the two calls are sequential with a delay.
 */
export async function fetchAlbumCredits(artist: string, album: string): Promise<AlbumCredit[]> {
  const q = encodeURIComponent(`artist:"${artist}" AND release:"${album}"`);
  const search = await mbFetch(`${MB}/release/?query=${q}&limit=1&fmt=json`);
  const mbid = search?.releases?.[0]?.id;
  if (!mbid) return [];

  await new Promise((r) => setTimeout(r, 1100)); // MB rate-limit courtesy

  const rel = await mbFetch(
    `${MB}/release/${mbid}?inc=artist-credits+recordings+recording-level-rels+work-level-rels+artist-rels&fmt=json`
  );
  if (!rel) return [];

  const byRoleAndName = new Map<string, AlbumCredit>();
  const addCredit = (role: string, name: string, track?: string) => {
    const key = `${role}:::${name}`;
    const existing = byRoleAndName.get(key);
    if (existing) {
      if (track && existing.tracks && !existing.tracks.includes(track)) existing.tracks.push(track);
    } else {
      byRoleAndName.set(key, { role, name, tracks: track ? [track] : undefined });
    }
  };

  for (const rels of rel.relations || []) {
    if (rels.artist?.name && rels.type) addCredit(rels.type, rels.artist.name);
  }
  for (const medium of rel.media || []) {
    for (const t of medium.tracks || []) {
      for (const r of t.recording?.relations || []) {
        if (r.artist?.name && r.type) {
          const role = r.attributes?.length ? `${r.type} (${r.attributes.join(", ")})` : r.type;
          addCredit(role, r.artist.name, t.title);
        }
      }
    }
  }
  const order = ["producer", "mix", "mastering", "recording", "engineer", "instrument", "vocal"];
  return [...byRoleAndName.values()].sort((a, b) => {
    const ia = order.findIndex((o) => a.role.toLowerCase().includes(o));
    const ib = order.findIndex((o) => b.role.toLowerCase().includes(o));
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

export type BookletFile = { name: string; path: string; isPdf: boolean };

/**
 * Looks for digital-booklet files next to the album's tracks
 * (booklet.pdf, liner notes, cover scans, Artwork/ or Scans/ subfolders).
 */
export async function findAlbumBooklet(remote: string, albumDirPath: string): Promise<BookletFile[]> {
  const out: BookletFile[] = [];
  const BOOKLET_RE = /(booklet|liner|digital.?booklet|scan|artwork|cover)/i;
  const scanDir = async (path: string, depth: number) => {
    if (depth > 1) return;
    let entries: any[] = [];
    try {
      entries = await invoke<any[]>("list_remote_path", { remote, path });
    } catch { return; }
    for (const e of entries || []) {
      const name: string = e.name || e.path || "";
      const isDir = Boolean(e.is_dir ?? e.IsDir);
      const full = path ? `${path}/${name}` : name;
      if (isDir && /^(artwork|scans?|booklets?)$/i.test(name)) {
        await scanDir(full, depth + 1);
      } else if (!isDir) {
        const lower = name.toLowerCase();
        const isPdf = lower.endsWith(".pdf");
        const isImg = /\.(jpe?g|png|webp)$/i.test(lower);
        if ((isPdf || isImg) && (BOOKLET_RE.test(lower) || depth > 0)) {
          out.push({ name, path: full, isPdf });
        }
      }
    }
  };
  await scanDir(albumDirPath.replace(/^\/+|\/+$/g, ""), 0);
  return out;
}
```

**UI integration (`MusicLibraryPage.tsx` album view):** add a **"Liner Notes & Booklet"** button (`BookOpen` icon) next to Fix Match that opens a side drawer which (a) calls `fetchAlbumCredits(selectedAlbum.artist, selectedAlbum.name)` and renders the role/name list, and (b) calls `findAlbumBooklet(remoteOfAlbum, albumFolderRelPath)` — images render inline in the drawer via the existing stream-session URL pattern; **PDFs do not render inline in WebKitGTK** (no built-in PDF plugin) — for a PDF, show an "Open booklet" button that downloads it via the existing download pipeline and opens the containing folder (`openDownloadFolder` from `downloadManager.ts`). Match the `is_dir` field casing to whatever `list_remote_path` actually returns (check one call's payload; udrop.ts treats entries as `{name, path}` objects).

---

## 16. Item 16 (NEW): Kaggle Job Name Compaction & Filename Reassertion — **[ROOT-CAUSED]**

### A. Symptom
Cloud jobs for long titles — the reported reproducer is *"Lord Of The Rings: Rings Of Power S03E04"* — fail to dispatch or get their status crossed with other episodes of the same show.

### B. Root Cause (verified in `src-tauri/src/commands/kaggle.rs`)
1. **Slug collision from 32-char title truncation (the primary bug).**
   `dispatch_kaggle_transcode` builds the kernel identity as
   `new_title = "Transcode " + sanitize_title(output_filename)` → `kernel_slug = sanitize_slug(new_title)` (lines 895-903).
   `sanitize_title` (line 270) strips the colon and then truncates to **32 characters** — and `"Lord Of The Rings Rings Of Power"` is **exactly 32 characters**, so the `S03E04` disambiguator is always cut off. Result: **S03E04, S03E05, S03E06… all produce the identical kernel slug** `transcode-lord-of-the-rings-rings-of-power`. Consequences, in order of user pain:
   - Kaggle **rejects a `kernels/push` to a slug whose kernel is currently queued or running** → dispatching the next episode while one transcodes fails ("file name limit"-looking error from Kaggle's side).
   - When the push *is* accepted, it creates a **new version of the same kernel**, and the status poller (`get_kaggle_transcode_status(kernel_slug)`) returns the *latest version's* state — the still-running E04 job's UI entry silently starts reporting E05's status/output.
   - The same pattern exists in **all four dispatchers**: `dispatch_kaggle_transfer` (line 1589 — safe-ish only because `job_id` embeds a timestamp), `dispatch_kaggle_align` (line 2090 — `sanitize_title(&req.title)`, **no uniquifier at all**: re-aligning the same book while a run is active always collides), and `dispatch_kaggle_rd_seed` (line 2407 — same).
2. **Full-length real filenames used as in-VM staging paths (secondary).**
   The generated script stages the transcode output as `local_temp_output = os.path.join(work_dir, output_filename)` (script lines 622/643) — i.e. the full `"…Rings Of Power S03E04_AV1.mp4"` name lands in `/kaggle/working`, which Kaggle archives as kernel output artifacts after completion. Long/odd names (colons survive into `output_filename` when the *source file* itself contains one — `sanitize_title` only guards the kernel title, not the media filename) bloat and can break the artifact save step. The GHA inline worker shares the same pattern (`local_out = f"/tmp/work/{out_name}"`, cloud_worker.yml:482) — harmless for artifacts there (`/tmp` isn't archived) but fixed for consistency.

**Key insight that makes the fix cheap:** every upload path already separates *local file handle* from *advertised filename* — rclone uses `copyto <local> <remote-path-with-real-name>`, Telegram passes `DocumentAttributeFilename(file_name=output_filename)`, Streamtape passes `files={"file1": (output_filename, fobj)}`. So the real name can be "reasserted" at upload with **zero changes to the upload code** — only the staging names and kernel identity need compacting.

### C. Drop-in Fixes

**1. Unique compact kernel identity — `src-tauri/src/commands/kaggle.rs`.** Add one helper near `sanitize_slug`:

```rust
/// Short unique job hash: seed (job_id/title) + dispatch-time millis.
/// Uniqueness matters, determinism does not — the caller stores the returned slug.
fn short_job_hash(seed: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    seed.hash(&mut h);
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .hash(&mut h);
    format!("{:08x}", h.finish() & 0xffff_ffff)
}
```

Then change the four dispatchers' title lines to embed the hash **before** the human-readable tail (so truncation can never remove the unique part):

```rust
// dispatch_kaggle_transcode (replace lines 895-903):
let slug_suffix = sanitize_slug(&req.job_id);
let title_source = req.output_filename.as_deref().unwrap_or(&slug_suffix);
let jh = short_job_hash(&req.job_id);
let new_title: String = format!("RFX T{} {}", &jh[..6], sanitize_title(title_source))
    .chars()
    .take(48)
    .collect();
let derived_slug = sanitize_slug(&new_title);
// e.g. "RFX T9f3a1c Lord Of The Rings Rings Of" → slug "rfx-t9f3a1c-lord-of-the-rings-rings-of"
```

```rust
// dispatch_kaggle_transfer (line 1589):
let jh = short_job_hash(&req.job_id);
let new_title: String = format!("RFX X{} Cloud {} {}", &jh[..6], op_upper, sanitize_title(&slug_suffix))
    .chars().take(48).collect();

// dispatch_kaggle_align (line 2090):
let jh = short_job_hash(&req.title);
let new_title: String = format!("RFX A{} Align {}", &jh[..6], sanitize_title(&req.title))
    .chars().take(48).collect();

// dispatch_kaggle_rd_seed (line 2407):
let jh = short_job_hash(&req.title);
let new_title: String = format!("RFX S{} Seed {}", &jh[..6], sanitize_title(&req.title))
    .chars().take(48).collect();
```

No frontend changes needed for tracking: every dispatcher already returns the final slug parsed from Kaggle's response (`final_slug` / `parse_kaggle_user_and_slug`), and the job stores key off that returned value. The human-readable job *title* shown in the app's queue comes from the request, not the kernel slug, so display stays pretty.

**2. Compact in-VM staging, reassert at upload — `generate_transcode_script` in `kaggle.rs`.** Change the two staging lines (script lines 622 and 643):

```python
# OLD (both branches):
        local_temp_output = os.path.join(work_dir, output_filename)
# NEW (both branches):
        local_temp_output = os.path.join(work_dir, f"out_{idx}.mp4")
```

Everything downstream is already correct without modification:
- `target_remote_file` (line 673) keeps the **real** `output_filename` → `rclone copyto local_temp_output target_remote_file` renames on upload (reassertion).
- Telegram MTProto/Bot branches open `local_temp_output` but advertise `output_filename` via the filename attribute (lines 716-719, 750-754) — reassertion free of charge.
- Streamtape multipart passes `(output_filename, fobj)` (line 797) — same.
- The post-upload verification `output_filename in verify_res.stdout` (line 826) checks the *remote* listing, where the real name was asserted — still valid.
- Cleanup `os.remove(local_temp_output)` (line 780-781) — path-agnostic.

Also add a defensive scrub where `output_filename` is derived (immediately after each `output_filename = …` assignment block, lines ~616-621 and ~639-642), because a colon can ride in from the *source file's own name* and some destination backends (OneDrive, Windows SMB) reject `:` in names:

```python
        output_filename = output_filename.replace(":", " -").replace("  ", " ")[:180]
```

(180-char cap matches the ext4 filename invariant from AGENTS.md §1.3.5.)

**3. Mirror in the GHA inline worker — `.github/workflows/cloud_worker.yml` (line ~482):**

```python
# OLD:
                  local_out = f"/tmp/work/{out_name}"
# NEW:
                  out_name = out_name.replace(":", " -").replace("  ", " ")[:180]
                  local_out = f"/tmp/work/out_{idx}.mp4"
```

(The GHA upload paths mirror the Kaggle script's and need no other changes for the same reason.)

**4. Standalone worker scripts** (`scripts/cloud_workers/transcode_2160p_4k.py`, `upscale_720p_to_1080p.py`): apply the same two-line pattern — short `out_{idx}.mp4` staging + real name only in the rclone/Streamtape upload arguments — in their staging sections. Same mechanical change; the implementing model should locate each script's single `local output path` assignment and its upload call.

### D. Why not "rename after the job completes" (the literal reading)
A post-job rename pass (app polls completion → issues `rclone moveto` from a compacted remote name to the real one) was considered and rejected: it adds a failure window (app offline at completion = file stranded under the compact name, breaking scanners and subscriptions), requires new state tracking, and is strictly inferior to reasserting the name *inside the job at upload time*, which is atomic with the upload itself and costs zero extra API calls. The in-job reassertion above achieves the requested outcome ("compact for the job, full name afterwards") with the real name already in place the moment the job finishes.

---

## 17. Item 17 (NEW): Android TV Operability — **[AUDITED, 4 GAPS + FIXES]**

### A. What Already Works (verified — do not rebuild any of this)
The fear that the TV build is "gimped" is mostly unfounded at the *infrastructure* level. All of the following exists and was read line-by-line:
- **Manifest** (`android/app/src/main/AndroidManifest.xml`): `LEANBACK_LAUNCHER` intent category, `android.software.leanback` + `android.hardware.touchscreen` + `gamepad` all `required="false"`, TV banner on both `<application>` and `<activity>`, PiP support. The app installs and launches correctly on Android TV / Google TV / Fire TV.
- **Spatial navigation engine** (`src/lib/tvNavigation.ts`, 653 lines, initialized in `App.tsx:89`): zone-aware D-pad scoring (sidebar ↔ main ↔ modal), shelf-constrained left/right, modal focus scoping, auto-focus restoration via MutationObserver, text-input editing lock (no surprise soft keyboards), Back-button routing (`__rcloneflix_handle_back`), gamepad polling.
- **Native key layer** (`MainActivity.java:572-710`): D-pad/Enter forwarding with repeat throttling, volume keys, media keys, Back → WebView. `AndroidBridge.isTv()` is exposed (line 1287) and `isTvDevice()` checks `UI_MODE_TYPE_TELEVISION` + `FEATURE_LEANBACK`.
- **Video player TV mode** (`VideoPlayerPage.tsx:1588-1635`): dedicated `isTv` branches — ArrowUp/Down reveal and focus the on-screen controls (`data-player-back`, `data-player-play`), Escape/Back collapses controls before exiting.
- **Focus visibility**: `body.is-android-tv` focus ring + scale CSS (`index.css:238-248`), `MediaCard` has `tabIndex={0}` + `.media-card .shelf-item` classes matching the nav engine's selector.
- **Audio media session**: `MediaPlaybackService.java` owns a native MediaSession with play/pause/next/prev/seek/stop callbacks that dispatch `rcloneflix:media-control` CustomEvents into the WebView.

(The separately-tracked OPEN Android audit items #100–125 in `KNOWN_BUGS_AND_FIXES.md` — backup corruption, polyfill argument mismatches, etc. — are data-integrity bugs, not operability, and stay in that document.)

### B. Gap 1 — Remote Play/Pause button is DEAD in the video player (confirmed bug)
`MainActivity.java:676` maps `KEYCODE_MEDIA_PLAY_PAUSE` → `dispatchMediaControl("toggle", 0)`, but the player's handler (`VideoPlayerPage.tsx:1679-1703`) switches on `"play"/"pause"/"play-pause"/"stop"/"next"/"prev"` — **`"toggle"` falls through and does nothing**, and `"seek"` (sent by the lock-screen/TV seekbar via `MediaPlaybackService.java:143`, value in **seconds**) is also unhandled.

**Drop-in** — add two cases to the switch in the `rcloneflix:media-control` handler in `VideoPlayerPage.tsx` (next to `case "play-pause"`):

```typescript
        case "toggle":
          togglePlay();
          break;
        case "seek": {
          const v = (e as CustomEvent)?.detail?.value;
          if (typeof v === "number" && isFinite(v) && v >= 0) handleSeek(v);
          break;
        }
```

### C. Gap 2 — Music/audiobooks ignore ALL transport controls (confirmed)
`AudioMiniPlayer.tsx` calls `AndroidBridge.updateMediaSession(...)` (line 1286) so the native session exists and the TV shows Now-Playing — but **nothing in the component listens for `rcloneflix:media-control`**, so the remote's play/pause/next/prev/seek buttons do nothing for music and audiobooks.

**Drop-in (SIMPLIFIED on re-review)** — `AudioMiniPlayer` already exposes a **complete transport dispatcher** as a window global: `window.__rcloneflix_media_control` (registered at `AudioMiniPlayer.tsx:1360-1414`, handling `toggle` / `play` / `pause` / `next` / `prev` / `seek` / `stop` / `jump` / `volume` / `mute` / `speed` / `sleep` — it is what MusicSkinShell's own transport buttons call via `dispatchControl`, so it is proven live). The only missing piece is translating the `rcloneflix:media-control` CustomEvent (fired by `MainActivity.java` and `MediaPlaybackService.java`) into that global. Bridge it — do **not** re-implement transport logic (no stale-closure risk, no duplicated behavior):

```typescript
  // Bridge hardware/MediaSession transport events (Android TV remote, lock screen,
  // BT headset) into the existing __rcloneflix_media_control dispatcher.
  useEffect(() => {
    const handler = (e: Event) => {
      // The video player owns transport while it is open (/play/video, BrowserRouter)
      if (window.location.pathname.startsWith("/play/")) return;
      const detail = (e as CustomEvent)?.detail;
      if (!detail?.action) return;
      const action = detail.action === "play-pause" ? "toggle" : detail.action;
      (window as any).__rcloneflix_media_control?.(action, detail.value);
    };
    window.addEventListener("rcloneflix:media-control", handler);
    return () => window.removeEventListener("rcloneflix:media-control", handler);
  }, []);
```

*(Verified: the app uses `BrowserRouter` (`main.tsx:15`) with the video player at `/play/video`, so the `pathname` guard is valid. The empty dependency array is safe because the handler only forwards to the window global, which AudioMiniPlayer's own effect keeps fresh — MusicSkinShell's buttons already rely on exactly this. The global's `"seek"` case routes through the component's `handleSeek` and its `"stop"` case pauses and calls `onClose()` — both correct for TV semantics.)*

### D. Gap 3 — Hover-revealed controls are invisible AND unfocusable on TV (confirmed)
27 component files gate actions behind `opacity-0 group-hover:opacity-100` (e.g. `MediaCard.tsx:250, 269, 343, 354` — resolution badge, version switcher, remove button, favorite button). A D-pad never produces `:hover`, and `tvNavigation.ts:isElementVisible` **deliberately skips elements with computed opacity < 0.05** — so these controls can neither be seen nor reached on TV. (MediaCard's center play overlay is the one exception — it already has `group-focus/poster:opacity-100`.)

**Drop-in (global, zero per-component edits)** — append to the Android TV block in `src/index.css` (after line ~250). Tailwind writes the literal class string `group-hover:opacity-100` into the DOM, so an attribute-contains selector matches all 27 files at once:

```css
/* Android TV: a D-pad never hovers — reveal group-hover-gated controls whenever
   the group (or anything inside it) holds focus, so they become visible AND
   focusable (tvNavigation skips elements with opacity < 0.05). */
body.is-android-tv :is(.group, [class*="group/"]):focus-within [class*="group-hover:opacity-100"],
body.is-android-tv :is(.group, [class*="group/"]):focus [class*="group-hover:opacity-100"] {
  opacity: 1 !important;
  pointer-events: auto !important;
}
```

### E. Gap 4 — No playback path for MKV / AC3 / EAC3 / DTS / TrueHD on Android (the real "gimp")
`shouldForceVlc` hard-returns `false` on Android (`VideoPlayerPage.tsx:83`), routing **everything** to the WebView's HTML5 `<video>` — which cannot demux MKV and cannot decode AC3/EAC3/DTS/TrueHD on any Android device. On desktop these files go to embedded libVLC; on Android there is **no fallback at all**, so the dominant TV-library format fails (black screen or silent video). There is also no external-player intent anywhere in `MainActivity.java`.

**Fix (v1.0.3 scope): external-player intent handoff** — VLC for Android / Just Player handle these natively, and sideloading TV users almost always have VLC. Fully in-app playback needs a Media3/ExoPlayer `SurfaceView` bridge — that is the correct long-term answer but is a multi-week change; it goes to the queue (§19), not this release.

**Drop-in 1 — `MainActivity.java`**, inside the `AndroidBridge` inner class (next to `minimizeApp`, line ~1559):

```java
        @JavascriptInterface
        public boolean openInExternalPlayer(final String url, final String title) {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndTypeAndNormalize(android.net.Uri.parse(url), "video/*");
                intent.putExtra("title", title);                     // VLC & MX Player read this
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                // Prefer VLC when installed (plays MKV/AC3/EAC3/DTS/HEVC natively)
                try {
                    getPackageManager().getPackageInfo("org.videolan.vlc", 0);
                    intent.setPackage("org.videolan.vlc");
                } catch (Exception ignored) {
                    // fall through to system chooser
                }
                startActivity(intent);
                return true;
            } catch (Exception e) {
                android.util.Log.w("RcloneFlix", "openInExternalPlayer failed: " + e);
                return false;
            }
        }
```

*(Note: the URL handed over must be reachable from another app — `http://127.0.0.1:<port>` localhost streams from the bundled `startRclone` server ARE reachable by other apps on the same device, so no relay is needed here.)*

**Drop-in 2 — `VideoPlayerPage.tsx`**: add an Android container/codec check where desktop would have forced VLC. Create a helper next to `shouldForceVlc`:

```typescript
/** Containers/codecs the Android WebView cannot play — hand off to an external player. */
function androidNeedsExternalPlayer(filename?: string): boolean {
  if (!isAndroid || !filename) return false;
  const lower = filename.toLowerCase();
  return (
    lower.endsWith(".mkv") || lower.endsWith(".avi") || lower.endsWith(".ts") ||
    lower.endsWith(".m2ts") || lower.endsWith(".vob") || lower.endsWith(".flv") ||
    lower.endsWith(".wmv") ||
    lower.includes("truehd") || /\bdts\b/.test(lower) ||
    lower.includes("ac3") || lower.includes("eac3") || lower.includes("ddp")
  );
}
```

Then, in the playback-start path(s) where the stream URL has just been resolved (the same branch points that call `shouldForceVlc` for desktop, lines ~750/791/869/906/937), insert before the HTML5 assignment:

```typescript
      if (androidNeedsExternalPlayer(item.filename)) {
        const handedOff = Boolean(
          (window as any).AndroidBridge?.openInExternalPlayer?.(resolvedStream, item.title)
        );
        if (handedOff) {
          addToast(`Opening "${item.title}" in external player (VLC)...`, "info");
          navigate(-1);
          return;
        }
        addToast(
          "This file format needs an external player. Install VLC for Android to play MKV/AC3 files.",
          "error", 7000
        );
        // fall through to HTML5 as a last resort
      }
```

*(Wire the exact local variable name per branch — `resolvedStream` / `activeStream` as each branch names it; keep video-progress bookkeeping consistent by treating hand-off as an immediate exit.)*

### F. Minor polish (one-line items)
1. **Overscan**: `index.css:249` pads `#root` by `16px 28px`; Google's TV guidance is 5% of each edge (≈27px vertical / 48px horizontal at 1080p). Change to `body.is-android-tv #root { padding: 27px 48px; }`.
2. **FF/RW while browsing**: `KEYCODE_MEDIA_FAST_FORWARD`/`REWIND` map to ArrowRight/Left globally (`MainActivity.java:691-696`) — correct in the player, harmless elsewhere. No change; documented as intended.

---

## 18. Item 18 (NEW): UI Beautification Pass — Desktop & Android TV — **[ADDED]**

All items below are CSS/markup-only (plus one dependency swap), deliberately scoped so a lower-cost model can implement them without touching logic. Two hard rules carried over from the existing stylesheet: the **SOLID UI STANDARD** (`index.css` — full-screen modal scrims are opaque, never blurred; do not add glassmorphism to modals) and every new animation must respect `prefers-reduced-motion` (guard provided in D7).

### Part 1 — Desktop (.deb / Flatpak / .exe)

**D1. Self-hosted fonts (fixes offline typography collapse — the single highest-impact item).**
`index.html:9-12` loads Bebas Neue / DM Sans / JetBrains Mono from the Google Fonts CDN at runtime. On an offline or firewalled machine (common for a `.deb`/`.exe` media app on a home server or TV PC), **every font falls back** — Bebas Neue's declared fallback is literally `cursive`. Fix:

```bash
npm install @fontsource/bebas-neue @fontsource/dm-sans @fontsource/jetbrains-mono
```

In `src/main.tsx`, before the `index.css` import:

```typescript
import "@fontsource/bebas-neue/400.css";
import "@fontsource/dm-sans/300.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
```

Then delete the three `<link rel=…fonts.googleapis…>` / preconnect tags from `index.html`. Fonts now ship inside the bundle on all three desktop targets (and Android, free of charge). Also fix the fallback stack in `tailwind.config.js`: `display: ["'Bebas Neue'", "'Arial Narrow'", "sans-serif"]` (never `cursive`).

**D2. Route cross-fade transitions.** `framer-motion` is already a dependency and `AppShell.tsx` already imports `useLocation` (line 2). Wrap the `<Outlet />` (line 77):

```tsx
import { motion } from "framer-motion";
// …
<motion.div
  key={location.pathname}
  initial={{ opacity: 0, y: 8 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.18, ease: "easeOut" }}
  className="h-full"
>
  <Outlet />
</motion.div>
```

(No `AnimatePresence` exit animation — exit-waits make navigation feel slower; enter-only keeps it snappy. The D7 guard disables it for reduced-motion users.)

**D3. Skeleton shimmer loaders.** `tailwind.config.js` defines a `shimmer` keyframe + `animate-shimmer` that **no component uses**. Add one utility class to `index.css`:

```css
.skeleton {
  @apply animate-shimmer rounded-xl;
  background: linear-gradient(
    100deg,
    rgb(var(--color-panel)) 40%,
    rgb(var(--color-border)) 50%,
    rgb(var(--color-panel)) 60%
  );
  background-size: 200% 100%;
}
```

Usage: in every library grid / shelf that currently shows a spinner or blank space while `loading`/scanning, render placeholder cards: `<div className="skeleton aspect-[2/3]" />` (grid) and `<div className="skeleton h-4 w-24 mt-2" />` (title line), matching the real card dimensions so the layout doesn't jump when content arrives. Target the main library page grid, Home shelves, and DirectPlay discovery feed first.

**D4. Media card micro-polish (`MediaCard.tsx`).** Three class-string edits:
- **Inner poster zoom**: the card already scales on hover; additionally give the `<img>` `className="… transition-transform duration-500 group-hover/poster:scale-[1.06]"` (card root already has `overflow-hidden`, so the image zooms *inside* the frame — the classic streaming-app treatment).
- **Legibility scrim**: on the card's bottom overlay (where badges sit), ensure a gradient backing: `bg-gradient-to-t from-black/80 via-black/30 to-transparent` so badges never sit on bright artwork.
- **Accent progress bar**: in `ProgressBar` (line 69-81), change the fill to the theme accent with a soft glow so resume-state pops across all accent themes:

```tsx
<div
  className="h-full rounded-full bg-gradient-to-r from-accent-dim to-accent shadow-[0_0_6px_rgba(var(--color-accent-glow),0.8)]"
  style={{ width: `${pct}%` }}
/>
```

**D5. Detail-page cinematic hero (`MediaDetailPage.tsx:313-335`).** The backdrop hero already exists; give it a slow drift + a deeper scrim. Add to `index.css`:

```css
@keyframes heroDrift {
  0% { transform: scale(1.02); }
  100% { transform: scale(1.09); }
}
.hero-backdrop {
  animation: heroDrift 28s ease-in-out infinite alternate;
  will-change: transform;
}
```

Add `hero-backdrop` to the backdrop `<img>`'s className, and make sure the scrim below it is `bg-gradient-to-t from-void via-void/60 to-transparent` so the hero melts into the page instead of ending at a hard edge.

**D6. Filmic grain.** The `bg-noise` SVG-turbulence utility in `tailwind.config.js` is defined and unused. Add `bg-noise` to AppShell's outermost wrapper div — at 3% opacity it kills banding in the dark gradients and gives the whole app a subtle film texture for zero runtime cost. (Skip on TV — see T4.)

**D7. Motion guard (required by every item above).** Append to `index.css`:

```css
@media (prefers-reduced-motion: reduce) {
  .hero-backdrop, .skeleton { animation: none !important; }
  *, *::before, *::after { transition-duration: 0.01ms !important; }
}
```

**D8. Scrollbar accent (one-liner).** `index.css:135-137` — change the thumb hover to the theme accent: `background: rgb(var(--color-accent) / 0.55);`.

### Part 2 — Android TV (10-foot UI, builds on Item 17's `body.is-android-tv` class)

All selectors scope under `body.is-android-tv`, so desktop is untouched. Append to the TV block in `index.css`:

**T1. 10-foot type & density scale.** From 3 m away the current desktop-density text is squint territory:

```css
body.is-android-tv { font-size: 112.5%; }           /* 16px → 18px base */
body.is-android-tv .text-xs { font-size: 0.8rem; }   /* floor tiny labels */
body.is-android-tv .text-\[10px\] { font-size: 0.72rem; }
```

**T2. Focus spotlight + calmer ring.** The current TV rule scales **every** focused element 1.03× with a 24px glow (`index.css:238-248`) — on small icon buttons this causes layout jitter and looks noisy. Replace that block's one-size-fits-all with a two-tier treatment plus a shelf "spotlight" (non-focused siblings dim, the Android-TV-native look):

```css
/* Tier 1: cards get the cinematic lift */
body.is-android-tv .media-card:focus,
body.is-android-tv .shelf-item:focus {
  outline: 3px solid rgb(var(--color-accent)) !important;
  outline-offset: 3px;
  box-shadow: 0 0 24px rgb(var(--color-accent-glow) / 0.55) !important;
  transform: scale(1.06);
  transition: transform 0.16s ease-out;
  z-index: 30 !important;
}
/* Tier 2: buttons/inputs get a ring only — no scale, no jitter */
body.is-android-tv :is(button, a, input, select, textarea, [role="button"]):focus {
  outline: 2px solid rgb(var(--color-accent)) !important;
  outline-offset: 2px;
}
/* Spotlight: dim the rest of a shelf while one card is focused */
body.is-android-tv [data-tv-shelf="true"]:focus-within .shelf-item:not(:focus),
body.is-android-tv [data-tv-shelf="true"]:focus-within .media-card:not(:focus) {
  filter: brightness(0.55) saturate(0.85);
  transition: filter 0.2s ease;
}
```

(Delete the old universal `body.is-android-tv *:focus { … }` rule when adding this — it is superseded.)

**T3. Shelf scroll-snap.** D-pad scrolling through a shelf should land cards on tidy positions:

```css
body.is-android-tv [data-tv-shelf="true"] {
  scroll-snap-type: x proximity;
  scroll-padding-inline: 48px; /* matches Item 17's overscan gutter */
}
body.is-android-tv [data-tv-shelf="true"] .shelf-item,
body.is-android-tv [data-tv-shelf="true"] .media-card {
  scroll-snap-align: center;
}
```

**T4. Performance IS beauty on TV GPUs.** Android TV boxes run weak GPUs in a WebView; `backdrop-blur`, the noise overlay, and 40px shadows cause visible scroll jank, which reads as "cheap" far more than any missing effect would:

```css
body.is-android-tv [class*="backdrop-blur"] {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}
body.is-android-tv .bg-noise { background-image: none !important; }
body.is-android-tv [class*="shadow-card-hover"] { box-shadow: 0 4px 16px rgba(0,0,0,0.5) !important; }
```

**T5. Hide pointer-era chrome.** Scrollbars are meaningless with a D-pad, and `title=""` tooltips never show on TV:

```css
body.is-android-tv ::-webkit-scrollbar { width: 0; height: 0; }
```

(Nothing to do for tooltips in CSS — but Item 17's Gap-3 focus-reveal rule already covers the information they carried.)

**Implementation order for the low-cost model:** D1 → D7 → D3 → D4 → T2 → T4 → T1 → the rest in any order. D1 and D7 first because later items depend on bundled fonts rendering and the motion guard existing.

---

## 19. Item 19 (NEW): Music Mode Beautification & Audio Visualizations — **[ADDED]**

### A. What Exists Today (verified)
- The only "visualizer" in the app is `AudioVisualizer` in `AudioMiniPlayer.tsx:36-100` — a **48×18 px canvas drawing fake sine-wave bars**, hardcoded to gold `#E8A020`/`#F59E0B` (it ignores all five accent themes), rendered once in the mini bar (line 2173). It never reads audio data.
- A **real `AnalyserNode` already exists** in the WebAudio graph (`analyserRef`, `fftSize: 1024`, wired at line ~301-314) and is already consumed for skip-silence RMS — but **only on Windows/Android**; on Linux desktop the whole graph is disabled (Item 15's WebKitGTK constraint), so no real spectrum data exists there.
- `MusicSkinShell.tsx` (the dedicated Winamp-style skin window with EQ presets, lrclib lyrics, and queue tabs) has **no visualizer at all** — prime real estate.
- `useArtwork(posterUrl)` already resolves album art in both the mini player and the skin.

**Honest platform contract (mirrors Item 15):** real FFT visualization is possible on **Windows and Android/Android TV**. On **Linux desktop** the visualizer must run in a procedural "ambient" mode (no audio data exists to read). The hook below handles both transparently and reports which mode is live, so the UI never lies about being "live spectrum" on Linux.

### B. Drop-in 1 — Shared analyser handle: `src/lib/audioGraph.ts` (new file)

```typescript
/** Shared handle to the music WebAudio graph's AnalyserNode (null on Linux desktop). */
let sharedAnalyser: AnalyserNode | null = null;

export function setSharedAnalyser(a: AnalyserNode | null) {
  sharedAnalyser = a;
}
export function getSharedAnalyser(): AnalyserNode | null {
  return sharedAnalyser;
}
```

In `AudioMiniPlayer.tsx`'s `attachWebAudio`, right after `analyserRef.current = analyser;` (line ~314), add `setSharedAnalyser(analyser);` (+ import). In the component's unmount cleanup, call `setSharedAnalyser(null)`.

### C. Drop-in 2 — The visualizer engine: `src/components/audioplayer/SpectrumCanvas.tsx` (new file)

One component, two render styles (`bars` for shelves/mini bar, `ring` for around album art), real-FFT when available with a seeded procedural fallback:

```tsx
import { useEffect, useRef } from "react";
import { getSharedAnalyser } from "../../lib/audioGraph";

type Props = {
  isPlaying: boolean;
  style?: "bars" | "ring";
  bands?: number;
  width: number;
  height: number;
  className?: string;
  /** Seed so the ambient fallback looks different per track (pass track title). */
  seed?: string;
  fpsCap?: number; // 30 on Android TV (Item 18 T4 perf rule)
};

function accentRgb(): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim();
    return v ? `rgb(${v.split(" ").join(",")})` : "rgb(232,160,32)";
  } catch {
    return "rgb(232,160,32)";
  }
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

export function SpectrumCanvas({
  isPlaying, style = "bars", bands = 24, width, height, className, seed = "", fpsCap = 60,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

    const freqBuf = new Uint8Array(512);
    const levels = new Float32Array(bands);
    const phase = hashSeed(seed) * Math.PI * 2;
    const minFrameMs = 1000 / fpsCap;
    let animId = 0;
    let lastFrame = 0;

    const sample = () => {
      const analyser = getSharedAnalyser();
      if (analyser && isPlaying) {
        analyser.getByteFrequencyData(freqBuf);
        // Log-spaced band reduction (musical spacing: bass gets fewer bins than treble)
        for (let b = 0; b < bands; b++) {
          const lo = Math.floor(Math.pow(freqBuf.length * 0.75, b / bands));
          const hi = Math.max(lo + 1, Math.floor(Math.pow(freqBuf.length * 0.75, (b + 1) / bands)));
          let sum = 0;
          for (let i = lo; i < hi; i++) sum += freqBuf[i];
          const v = sum / (hi - lo) / 255;
          levels[b] = Math.max(v, levels[b] * 0.82); // fast attack, slow decay
        }
        return true; // live
      }
      // Ambient fallback (Linux desktop, or paused): seeded, beat-pulsed waves
      const t = performance.now() * 0.001;
      const beat = isPlaying ? 0.5 + 0.5 * Math.pow(Math.abs(Math.sin(t * Math.PI * 1.9 + phase)), 6) : 0;
      for (let b = 0; b < bands; b++) {
        const base = isPlaying
          ? 0.12 + 0.38 * Math.abs(Math.sin(t * 1.7 + phase + b * 0.42) * 0.6 + Math.cos(t * 2.4 - b * 0.3) * 0.4)
          : 0.05;
        const target = Math.min(1, base * (1 - b / (bands * 2.2)) + beat * 0.25 * (b < 4 ? 1 : 0.3));
        levels[b] = levels[b] * 0.85 + target * 0.15;
      }
      return false;
    };

    const render = (now: number) => {
      animId = requestAnimationFrame(render);
      if (now - lastFrame < minFrameMs) return;
      lastFrame = now;
      if (reduced) { ctx.clearRect(0, 0, width, height); return; }
      sample();
      ctx.clearRect(0, 0, width, height);
      const accent = accentRgb();

      if (style === "ring") {
        const cx = width / 2, cy = height / 2;
        const r0 = Math.min(cx, cy) * 0.68;
        ctx.lineWidth = Math.max(1.5, r0 * 0.035);
        for (let b = 0; b < bands; b++) {
          const a0 = (b / bands) * Math.PI * 2 - Math.PI / 2;
          const len = r0 * 0.08 + levels[b] * r0 * 0.3;
          ctx.strokeStyle = accent;
          ctx.globalAlpha = 0.25 + levels[b] * 0.75;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0);
          ctx.lineTo(cx + Math.cos(a0) * (r0 + len), cy + Math.sin(a0) * (r0 + len));
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else {
        const barW = width / bands - 1.5;
        for (let b = 0; b < bands; b++) {
          const hgt = Math.max(2, levels[b] * height);
          const x = b * (barW + 1.5);
          const grad = ctx.createLinearGradient(0, height, 0, height - hgt);
          grad.addColorStop(0, accent);
          grad.addColorStop(1, `rgba(255,255,255,0.85)`);
          ctx.fillStyle = grad;
          ctx.globalAlpha = 0.55 + levels[b] * 0.45;
          ctx.beginPath();
          const r = Math.min(1.5, barW / 2);
          if (typeof ctx.roundRect === "function") ctx.roundRect(x, height - hgt, barW, hgt, [r, r, 0, 0]);
          else ctx.rect(x, height - hgt, barW, hgt);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    };
    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, style, bands, width, height, seed, fpsCap]);

  return <canvas ref={canvasRef} width={width} height={height} className={className} />;
}
```

### D. Integration points

**1. Mini bar (`AudioMiniPlayer.tsx:2173`)** — replace the fake `<AudioVisualizer isPlaying={playing} />` with:

```tsx
<SpectrumCanvas isPlaying={playing} width={64} height={20} bands={16}
  seed={currentTrack?.title || ""} className="hidden md:block opacity-90" />
```

and delete the old `AudioVisualizer` function (lines 36-100). This alone fixes the hardcoded-gold bug — the canvas now follows all five accent themes.

**2. Music Skin window (`MusicSkinShell.tsx`)** — two additions:
- **Ambilight backdrop** (pure CSS, works on every platform): directly inside the shell's root container, behind everything:

```tsx
{posterSrc && (
  <img src={posterSrc} aria-hidden
    className="absolute inset-0 w-full h-full object-cover blur-3xl opacity-25 scale-125 pointer-events-none select-none" />
)}
```

(On Android TV, Item 18 T4 already strips `blur` — acceptable degradation; alternatively gate with `!isAndroid`.)
- **Ring visualizer around the album art**: wrap the existing artwork block in a `relative` container and overlay:

```tsx
<SpectrumCanvas isPlaying={Boolean(audioState?.playing)} style="ring"
  width={260} height={260} bands={48}
  seed={currentTrack?.title || ""}
  className="absolute inset-0 m-auto pointer-events-none" />
```

sized ~15% larger than the art so the rays radiate from behind it. Add a **slow vinyl spin** on the art itself while playing: `className={audioState?.playing ? "animate-[spin_14s_linear_infinite] rounded-full" : "rounded-full"}` on the artwork `<img>` when the skin's disc presentation is active (guarded by the D7 reduced-motion rule, which kills all long animations).

**3. Music library album header (`MusicLibraryPage.tsx`)** — ambient glow behind the album cover using the dominant art color. Drop-in helper (append to `src/lib/artwork.ts` or a new `src/lib/dominantColor.ts`):

```typescript
/** Samples a loaded <img> down to 8×8 and returns its average color as "r,g,b". */
export function getDominantColor(img: HTMLImageElement): string | null {
  try {
    const c = document.createElement("canvas");
    c.width = 8; c.height = 8;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 32) continue;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    if (!n) return null;
    return `${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)}`;
  } catch { return null; } // tainted canvas (remote art without CORS) → no glow, no crash
}
```

Usage on the album-header cover `<img>`: `onLoad={(e) => setGlow(getDominantColor(e.currentTarget))}` then on its wrapper `style={{ boxShadow: glow ? \`0 12px 80px rgba(${glow},0.45)\` : undefined }}`. The try/catch makes CORS-tainted artwork degrade to no glow silently. Reuse the same glow on the AudioMiniPlayer expanded Now-Playing art.

**4. Android TV** — pass `fpsCap={30}` wherever `isTvEnvironment()` is true (import from `tvNavigation.ts`), per Item 18 T4; the analyser is real on Android so TV gets the genuine spectrum.

### E. Sidebar icon disambiguation (verified duplicate)
`Sidebar.tsx` uses the **same lucide `Music` note icon twice**: the Music *library section* nav entry (line 18, `icon: Music`) and the *"Music Player Skin"* mode button (line 234, `<Music size={16} …>`). Per product decision: **the library section keeps the grandfathered note icon; the mode button changes.** `Disc3` (lucide's spinning-record glyph) is the right pick — it reads as "player mode" and matches this item's vinyl-spin artwork treatment.

```tsx
// Sidebar.tsx line 4-5 — add Disc3 to the existing lucide-react import list:
import {
  Home, Film, Tv, Music, BookOpen, Headphones, Layers,
  Shield, Settings, RefreshCw, Cloud, CloudOff, Lock, ListMusic, Images, Disc3,
  // …keep the rest of the existing names unchanged
} from "lucide-react";

// Sidebar.tsx line 234 — ONLY the mode button changes (line 18's `icon: Music` stays):
            <Disc3 size={16} className="text-accent flex-shrink-0" />
```

Optional flourish (consistent with the vinyl theme, costs one class): spin the icon slowly while audio is playing — `className={\`text-accent flex-shrink-0 ${audioState?.playing ? "animate-[spin_4s_linear_infinite]" : ""}\`}` (the Sidebar already subscribes to the store; add `audioState` to its destructuring at line 44 if not present; covered by the Item 18 D7 reduced-motion guard).

### F. Explicitly out of scope (do not attempt)
- Beat-detection / BPM analysis, WebGL shader visualizers (Butterchurn/Milkdrop): heavy dependencies, GPU-fragile in WebKitGTK — queue material only.
- Any attempt to "fix" live FFT on Linux desktop — Item 15's WebKitGTK constraint is architectural; the ambient fallback is the correct behavior there.

---

## 20. Item 20 (NEW): Admin Weekly Recommendations & Guest Badge Engine — **[ADDED + CORRECTED]**

### A. Architectural Concept & Feasibility
**Is it possible?**
**YES, 100% possible, elegant, and native to RcloneFlix's serverless design.**

**Why it works cleanly in a serverless app:**
RcloneFlix has no centralized user-account database or live synchronization server. Guest passes (`.rflix`) are encrypted, self-contained JSON snapshots that bundle:
1. Scoped `rclone.conf` configurations (rewriting access to `shared_*` cloud remotes).
2. Remote backup pointers (`RcloneFlix/.rcloneflix_backup.json.gz`) containing rich library metadata.
3. Single-use token enforcement on cloud storage.

Because guest passes are created at a discrete point in time by the admin:
- The admin's active weekly recommendations (up to 3 titles per library) are snapshotted directly into the `.rflix` pass payload at generation time.
- The admin can freely change titles and badge effects every day, as many times as desired.
- Existing guest passes already imported in the wild remain unchanged, while newly generated passes immediately reflect the latest recommended titles and badge styling.
- This creates an effective **"First Week Orientation"** trick for new users without requiring any ongoing live server synchronization.

### B. Technical Architecture & Data Model

**1. Core Types (`src/store/appStore.ts`):**

```typescript
export type RecommendationBadgeEffect =
  | "glow"     // Pulsating cyan/neon accent halo
  | "pulse"    // Rhythmic breathing opacity
  | "flame"    // Hot amber/orange/rose gradient with Flame icon
  | "shimmer"  // Angled light-sweep metallic reflection
  | "gold";    // Audiophile/prestige gold foil with Star icon

export type WeeklyRecommendation = {
  itemId: string;           // MediaItem id
  title: string;            // Media title
  posterUrl?: string;       // Poster thumbnail
  badgeText: string;        // e.g. "Admin Pick", "Curator Choice", "Must Watch", "Essential"
  badgeEffect: RecommendationBadgeEffect;
  note?: string;            // Optional 1-sentence curator pitch for new guests
  addedAt: number;          // Timestamp when recommended
};

export type LibraryWeeklyPicks = {
  weekId: string;           // ISO week identifier, e.g. "2026-W46"
  items: WeeklyRecommendation[]; // Strictly capped at max 3 items
};

export type AdminWeeklyRecommendations = Record<string, LibraryWeeklyPicks>; // Keyed by libraryId
```

**2. MediaItem Schema Extension (`src/store/appStore.ts`):**
Extend `MediaItem` interface with optional recommendation fields:

```typescript
  // Admin Weekly Recommendations
  isRecommended?: boolean;
  recommendationBadge?: {
    text: string;
    effect: RecommendationBadgeEffect;
    note?: string;
  };
```

**3. ISO Week Helper (`src/lib/recommendations.ts` — new file):**

```typescript
export function getIsoWeekString(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}
```

**4. Zustand State & Actions (`src/store/appStore.ts`):**

```typescript
  adminWeeklyRecommendations?: AdminWeeklyRecommendations;
  guestRecommendations?: WeeklyRecommendation[];

  setLibraryRecommendation: (
    libraryId: string,
    rec: WeeklyRecommendation
  ) => { success: boolean; error?: string };
  removeLibraryRecommendation: (libraryId: string, itemId: string) => void;
  updateLibraryRecommendationEffect: (
    libraryId: string,
    effect: RecommendationBadgeEffect,
    badgeText?: string
  ) => void;
```

With implementation:

```typescript
  adminWeeklyRecommendations: {},
  guestRecommendations: [],

  setLibraryRecommendation: (libraryId, rec) => {
    const currentWeek = getIsoWeekString();
    const existing = get().adminWeeklyRecommendations?.[libraryId];
    const activeItems = (existing?.weekId === currentWeek ? existing.items : []).filter(
      (item) => item.itemId !== rec.itemId
    );

    if (activeItems.length >= 3) {
      return {
        success: false,
        error: "Weekly limit reached. You can only recommend up to 3 titles per library per week. Remove one to add this.",
      };
    }

    const updatedItems = [...activeItems, { ...rec, addedAt: Date.now() }];
    set((state) => ({
      adminWeeklyRecommendations: {
        ...(state.adminWeeklyRecommendations || {}),
        [libraryId]: {
          weekId: currentWeek,
          items: updatedItems,
        },
      },
    }));
    return { success: true };
  },

  removeLibraryRecommendation: (libraryId, itemId) => {
    set((state) => {
      const existing = state.adminWeeklyRecommendations?.[libraryId];
      if (!existing) return state;
      return {
        adminWeeklyRecommendations: {
          ...state.adminWeeklyRecommendations,
          [libraryId]: {
            ...existing,
            items: existing.items.filter((i) => i.itemId !== itemId),
          },
        },
      };
    });
  },

  updateLibraryRecommendationEffect: (libraryId, effect, badgeText) => {
    set((state) => {
      const existing = state.adminWeeklyRecommendations?.[libraryId];
      if (!existing) return state;
      return {
        adminWeeklyRecommendations: {
          ...state.adminWeeklyRecommendations,
          [libraryId]: {
            ...existing,
            items: existing.items.map((i) => ({
              ...i,
              badgeEffect: effect,
              ...(badgeText ? { badgeText } : {}),
            })),
          },
        },
      };
    });
  },
```

**Review notes on the store code:**
- `appStore.ts` must import the helper: `import { getIsoWeekString } from "../lib/recommendations";`
- **Week-rollover semantics (intentional, document in UI copy):** the `weekId` check only gates the *3-per-week cap* — on a new ISO week the first `setLibraryRecommendation` call starts a fresh list (previous week's picks are replaced). If the admin adds nothing in a new week, last week's picks remain active and keep exporting into new passes. Recommendations persist *until replaced*, the cap resets weekly.

### C. Pass Export & Import Pipeline (`src/lib/accessPass.ts`)

**0. Extend the payload type FIRST** — `AccessPassPayload` (accessPass.ts:80-94) is a closed type; without this edit every snippet below is a TS error. Add the field and the type import:

```typescript
import type { WeeklyRecommendation } from "../store/appStore"; // merge into the existing appStore import

export type AccessPassPayload = {
  // ...existing fields unchanged...
  weeklyRecommendations?: Record<string, WeeklyRecommendation[]>; // keyed by ORIGINAL library id
};
```

*(Verified: the guest-pass export branch starts at accessPass.ts:634; `targetLibs` is real at :635 and `s = useAppStore.getState()` is in scope. Persistence is safe on both sides: `adminWeeklyRecommendations`/`guestRecommendations` fall through the persist `partialize` rest-spread (appStore.ts:1717-1746, they are not in the exclusion list), and media items are stored as whole-item JSON blobs in SQLite (`libraryDb.ts:29` — `data: JSON.stringify(item)`), so the new `isRecommended`/`recommendationBadge` fields survive restarts with zero schema work.)*

**1. In `exportAccessPass` (guest pass branch, insert just before the `payload` literal at ~line 767):**

```typescript
  // Harvest active weekly recommendations for the selected libraries
  const weeklyRecommendations: Record<string, WeeklyRecommendation[]> = {};

  for (const lib of targetLibs) {
    const libPicks = s.adminWeeklyRecommendations?.[lib.id];
    if (libPicks && libPicks.items && libPicks.items.length > 0) {
      weeklyRecommendations[lib.id] = libPicks.items.slice(0, 3);
    }
  }

  const payload: AccessPassPayload = {
    // ...existing fields...
    weeklyRecommendations: Object.keys(weeklyRecommendations).length > 0
      ? weeklyRecommendations
      : undefined,
  };
```

**2. In `importGuestPass`:**
When ingesting `backupItems`:

```typescript
  const passRecs = payload.weeklyRecommendations || {};
  const allGuestRecs: WeeklyRecommendation[] = [];

  for (const item of backupItems) {
    if (sharedLibOriginalIds.has(item.libraryId)) {
      // ...existing path rewriting...
      const libRecs = passRecs[item.libraryId] || [];
      const recMatch = libRecs.find(
        (r) =>
          r.itemId === item.id ||
          r.title.toLowerCase().trim() === item.title.toLowerCase().trim()
      );

      const isRecommended = Boolean(recMatch);
      const recommendationBadge = recMatch
        ? {
            text: recMatch.badgeText || "Curator Pick",
            effect: recMatch.badgeEffect || "glow",
            note: recMatch.note,
          }
        : undefined;

      // Remap to the guest-side item id (items are re-id'd `shared_${id}` below)
      if (recMatch) allGuestRecs.push({ ...recMatch, itemId: `shared_${item.id}` });

      matchingItems.push({
        ...item,
        id: `shared_${item.id}`,
        libraryId: scopedLibId,
        remotePath: scopedRemotePath,
        versions: updatedVersions,
        isRecommended,
        recommendationBadge,
      });
    }
  }

  if (allGuestRecs.length > 0) {
    useAppStore.setState({ guestRecommendations: allGuestRecs });
  }
```

### D. Visual Badge Component (`src/components/library/RecommendationBadge.tsx`)

```tsx
import { Sparkles, Flame, Zap, Award, Star } from "lucide-react";
import type { RecommendationBadgeEffect } from "../../store/appStore";

type Props = {
  text: string;
  effect: RecommendationBadgeEffect;
  note?: string;
};

export function RecommendationBadge({ text, effect, note }: Props) {
  const getStyle = () => {
    switch (effect) {
      case "gold":
        return {
          icon: <Star size={10} className="fill-amber-300 text-amber-300" />,
          cls: "bg-gradient-to-r from-amber-950/90 to-yellow-950/90 text-amber-200 border-amber-400/80 shadow-[0_0_12px_rgba(251,191,36,0.45)]",
        };
      case "flame":
        return {
          icon: <Flame size={10} className="fill-orange-400 text-orange-200" />,
          cls: "bg-gradient-to-r from-amber-600 via-orange-600 to-rose-600 text-white border-amber-300/80 shadow-[0_0_12px_rgba(244,63,94,0.5)]",
        };
      case "glow":
        return {
          icon: <Zap size={10} className="fill-cyan-300 text-cyan-200" />,
          cls: "bg-cyan-950/90 text-cyan-200 border-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.55)]",
        };
      case "shimmer":
        return {
          icon: <Sparkles size={10} className="text-purple-200" />,
          cls: "bg-purple-950/90 text-purple-200 border-purple-400/80 animate-shimmer shadow-[0_0_10px_rgba(192,132,252,0.4)]",
        };
      case "pulse":
        return {
          icon: <Award size={10} className="text-accent" />,
          cls: "bg-accent/20 text-accent border-accent animate-pulse shadow-[0_0_8px_rgb(var(--color-accent-glow)/0.5)]",
        };
    }
  };

  const style = getStyle();

  return (
    <div
      className={`px-2 py-0.5 rounded-md border text-[10px] font-bold tracking-wider uppercase flex items-center gap-1 backdrop-blur-md transition-all ${style.cls}`}
      title={note || text}
    >
      {style.icon}
      <span>{text}</span>
    </div>
  );
}
```

**Review notes (verified against source):**
- `animate-shimmer` works — `tailwind.config.js:36` already defines the `shimmer` animation (it is merely unused in markup today), and `animate-pulse` is a Tailwind built-in.
- The shadow token syntax was corrected: `--color-accent-glow` is a **space-separated RGB triplet** (`index.css:9`, e.g. `240 184 64`), so it must be consumed as `rgb(var(--color-accent-glow)/0.5)` — `rgba(var(...),0.5)` is invalid CSS and would silently drop the shadow.
- The `getStyle()` switch is exhaustive over the 5-member union, so TypeScript accepts the missing `default` — do not add one (it would mask future effect additions).

In `src/components/library/MediaCard.tsx` (add `import { RecommendationBadge } from "./RecommendationBadge";` at the top):

```tsx
        {/* Admin Recommendation Badge (transferred to guest passes) */}
        {item.recommendationBadge && (
          <div className="absolute top-2 left-2 z-20">
            <RecommendationBadge
              text={item.recommendationBadge.text}
              effect={item.recommendationBadge.effect}
              note={item.recommendationBadge.note}
            />
          </div>
        )}
```

**⚠️ Badge-collision fix (REQUIRED — verified in source):** MediaCard already renders FOUR mutually-gated badges at `top-2 left-2`: "In Library" (`MediaCard.tsx:297`), the group/status badge (`:305`), the "STREAM" bookmark badge (`:312`), the low-confidence "?" (`:320`) and the favorite heart (`:327`). The recommendation badge would stack on top of them. Place the new block ABOVE the "In Library" badge, use `z-20` (as shown), and append `&& !item.recommendationBadge` to each of those five existing conditions, e.g.:

```tsx
        {(item.inLibrary || item.badge === "In Library") && !item.recommendationBadge && (
        ...
        {item.badge && item.badge !== "In Library" && !item.inLibrary && !item.isSourceBookmark && !item.recommendationBadge && (
        ...
        {item.isSourceBookmark && !item.recommendationBadge && (
        ...
        {isLowConfidence && !isFavorite && !item.isSourceBookmark && !item.badge && !item.recommendationBadge && (
        ...
        {isFavorite && !item.badge && !item.recommendationBadge && (
```

### E. Admin UI Surfacing & Home Page Positioning (Topmost + Leftmost ONLY in RcloneFlix)
- In `MediaDetailPage.tsx` and `MediaDetailsModal.tsx`:
  - If `!isGuest`, renders a "⭐ Recommend Title" button.
  - Opens a modal with live preview of the 5 badge effects, editable badge text, and 1-sentence note.
  - Real-time tally display: `"2 / 3 recommended this week"`.
- In `CreateAccessPassModal.tsx`:
  - Expandable summary shows which titles are recommended for each selected library and allows 1-click badge effect adjustments right before pass generation.
- **⚠️ Admin-side mirroring (REQUIRED — gap found on review):** the store actions in §B only write `adminWeeklyRecommendations`; nothing sets `isRecommended`/`recommendationBadge` on the admin's own `MediaItem`s, so without this step the badge and HomePage shelf would appear **only on guest devices, never for the admin**. In the "⭐ Recommend Title" modal's confirm handler (and in the remove/effect-change paths), mirror onto the item using the existing actions:
  ```typescript
  import { persistItems } from "../../lib/libraryDb";
  // on confirm:
  const updated: MediaItem = {
    ...item,
    isRecommended: true,
    recommendationBadge: { text: badgeText, effect, note },
  };
  useAppStore.getState().upsertMediaItem(updated);   // appStore.ts:629
  void persistItems([updated]).catch(() => {});       // items live in SQLite (libraryDb.ts:32), not localStorage
  // on remove: same pattern with isRecommended: false, recommendationBadge: undefined
  ```
- On `HomePage.tsx` **ONLY** (user explicit requirement; anchors verified — Continue Watching shelf at `HomePage.tsx:162-178`, Recently Added rows at `:199-209`):
  - **Topmost Shelf** — insert directly ABOVE the `{/* Continue Watching */}` block:
    ```tsx
    // selectors (top of component; mediaItems/watchProgress/handleCardClick already exist)
    const guestRecommendations = useAppStore((s) => s.guestRecommendations);
    const recommendedItems = useMemo(
      () => Object.values(mediaItems).filter((i) => i.isRecommended && i.recommendationBadge),
      [mediaItems]
    );
    ```
    ```tsx
    {/* Weekly Recommendations — topmost shelf, HomePage ONLY */}
    {recommendedItems.length > 0 && (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
        className="mb-8"
      >
        <MediaShelf
          title={guestRecommendations?.length ? "⭐ Curator's Weekly Picks" : "⭐ Recommended Titles"}
          items={recommendedItems}
          progressMap={watchProgress}
          onItemClick={handleCardClick}
        />
      </motion.div>
    )}
    ```
  - **Leftmost Card Priority** — at `HomePage.tsx:200`, replace `const recent = selectRecentlyAddedGrouped(mediaItems, lib);` with:
    ```typescript
    const recent = [...selectRecentlyAddedGrouped(mediaItems, lib)].sort(
      (a, b) => (b.isRecommended ? 1 : 0) - (a.isRecommended ? 1 : 0)
    );
    ```
    (`Array.prototype.sort` is stable, so the existing recency order is preserved within each group.)

---

## 21. Item 21 (NEW): Guest Pass Remote Anonymization & Credential Shielding — **[CORRECTED (major) — original naming scheme would have been a security regression]**

### A. Symptom & Vulnerability in Prior Implementation
In the existing codebase (`src/lib/accessPass.ts:275-323`):
- `extractScopedRcloneConfig` derives remote names as `shared_${origRemote}`.
- If an admin's personal remote is named `ashim_personal_gdrive`, `john_doe_onedrive`, or `my_private_seedbox_crypt`, the exported `.rflix` envelope and the recipient's `rclone.conf` literally contain `[shared_ashim_personal_gdrive]`, leaking the admin's personal account name, real name, email handles, or private infrastructure topology.
- Furthermore, raw `rclone.conf` files often contain user comments (`# Personal Drive for ashim@...`) or non-essential identity attributes.

### B. ⚠️ REVIEW CORRECTION — `shared_` is a security boundary: anonymize the SUFFIX, keep the prefix
The originally proposed names (`cloud_remote_N` / `fast_cloud_remote_N`) were verified against the codebase and would cause **critical security regressions**, because `startsWith("shared_")` is an enforcement gate on BOTH sides of the app:

| Site (verified in source) | What breaks if the prefix is dropped |
| :--- | :--- |
| `src-tauri/src/commands/rclone_sync.rs:158,190,229` + `src-tauri/src/commands/rclone.rs:428,472,516` | Rust-side write/copy/delete guards that stop a guest from writing to the admin's cloud (except the `.rflix_passes` token). Renamed remotes would become **fully writable by guests**. |
| `src/lib/androidPolyfill.ts:2625` | The same write guard on Android. |
| `src/lib/accessPass.ts:1321` (`removeSharedPass`) | Teardown collects remotes to delete by the `shared_` prefix → expired/revoked passes would leave **live admin credentials in the guest's rclone.conf forever**. |
| `src/components/layout/Sidebar.tsx:58` | `hasPersonalRemotes = remotes.some((r) => !r.name.startsWith("shared_"))` — a guest device would appear to own personal remotes and unlock non-guest UI. |
| `RemoteBrowser.tsx:51-91`, `CloudExplorerPage.tsx:92,127,150,444,596,663`, `CloudTransferModal.tsx:154,1170` | Pass remotes are filtered OUT of every remote picker by prefix; anonymized ones would pollute pickers and transfer-destination lists. |
| `src/lib/accessPass.ts:1117-1122` (guest import) | The orig→scoped mapping is derived by stripping `shared_` from section names. With opaque names this yields garbage → item paths are never rewritten → **nothing in the pass plays**. |

**Corrected naming scheme — keeps every guard, filter and teardown path working with ZERO changes:**
- Standard library remotes → `shared_cloud_1`, `shared_cloud_2`, …
- Offload/mirror remotes → `shared_fast_1`, `shared_fast_2`, …
- UI display labels: "Cloud Remote 1" / "Fast Cloud Remote 1".

**Honest threat model (replaces "recipients can never discover admin names"):** this removes the admin's remote names from the guest's `rclone.conf`, from UI surfaces, and scrubs identity fields; `parseRcloneIni` (accessPass.ts:207-233) already drops `#`/`;` comments on parse, so comment-stripping needs **zero code**. However: (a) the orig→anon `remoteMapping` must travel inside the `.rflix` payload (the importer needs it to rewrite backup item paths — see C.4), and (b) the cloud backup JSON the guest downloads contains original `remotePath` values. Both are opaque in normal use, but a technically determined guest who decrypts the payload (the envelope key ships in the app binary) can still recover the names. Scope = protection against casual inspection and accidental disclosure, not against a determined reverse-engineer. Write the Settings copy accordingly ("remote names are masked", never "cryptographically hidden").

### C. Drop-in (corrected & complete — 6 coordinated edits in `src/lib/accessPass.ts`)

**C.1 Replace `extractScopedRcloneConfig` (accessPass.ts:275-323).** The real function ALREADY returns `{ scopedConfig, remoteMapping }` (the caller at :743 destructures it — verified), so only the naming and the identity scrub change:

```typescript
/**
 * Extracts a scoped, isolated, ANONYMIZED rclone config for guest passes.
 * Library remotes become shared_cloud_1, 2…; offload remotes shared_fast_1, 2…
 * The shared_ prefix is LOAD-BEARING (write guards, pickers, guest detection,
 * teardown all key on it) — never remove it.
 */
export function extractScopedRcloneConfig(
  configContent: string,
  requiredRemoteNames: string[],
  offloadRemoteNames: Set<string> = new Set()
): { scopedConfig: string; remoteMapping: Record<string, string> } {
  const sections = parseRcloneIni(configContent);
  const allNeededRemotes = new Set<string>();

  for (const req of requiredRemoteNames) {
    findRemoteDependencies(req, sections, allNeededRemotes);
  }

  const remoteMapping: Record<string, string> = {};
  let cloudIdx = 1;
  let fastIdx = 1;
  for (const r of allNeededRemotes) {
    const isOffload =
      offloadRemoteNames.has(r) || /^(udrop|tg[-_]|telegram|streamtape|dropmb|dood)/i.test(r);
    remoteMapping[r] = isOffload ? `shared_fast_${fastIdx++}` : `shared_cloud_${cloudIdx++}`;
  }

  const outputLines: string[] = [];

  for (const origRemote of allNeededRemotes) {
    const sectionProps = sections.get(origRemote);
    if (!sectionProps) continue;

    outputLines.push(`[${remoteMapping[origRemote]}]`);

    for (const [key, rawValue] of sectionProps.entries()) {
      // Scrub display-identity fields ONLY. NEVER scrub auth fields
      // (user, username, pass, token, client_id, drive_id…) — WebDAV/uDrop/SFTP
      // authenticate with `user`/`pass`, and OneDrive needs drive_id.
      if (/^(email|account_email|user_name|drive_user|owner|organization|team_drive_name)$/i.test(key)) {
        continue;
      }

      let value = rawValue;
      // NEVER rewrite backend type or vendor (historical `type = shared_opendrive`
      // bug — sanitizeScopedRcloneConfig at :330 exists to repair exactly that)
      if (key !== "type" && key !== "vendor") {
        for (const [depOrig, depAnon] of Object.entries(remoteMapping)) {
          if (value.startsWith(`${depOrig}:`)) {
            value = `${depAnon}:${value.slice(depOrig.length + 1)}`;
          } else if (value.includes(` ${depOrig}:`)) {
            value = value.split(` ${depOrig}:`).join(` ${depAnon}:`);
          } else if (value === depOrig && (key === "remote" || key === "upstreams" || key === "remotes")) {
            value = depAnon;
          }
        }
      }
      outputLines.push(`${key} = ${value}`);
    }
    outputLines.push("");
  }

  return {
    scopedConfig: outputLines.join("\n").trim(),
    remoteMapping,
  };
}
```

*(The three dependency-rewrite branches are copied verbatim from the existing function at :304-312 — do not "improve" them. Note `tg[-_]` in the offload regex, not bare `tg` — a bare `tg` prefix would misclassify remotes like `tgdrive_movies`, and worse, any admin remote that merely starts with those letters.)*

**C.2 Collect offload remotes in `exportAccessPass`.** The versions-harvest loop at :669-682 already touches every offload remote. Declare `const offloadRemoteNames = new Set<string>();` next to `shareableRemotes` (:644), add the two `offloadRemoteNames.add(...)` lines inside that loop:

```typescript
      for (const v of item.versions) {
        if (v.remoteName) {
          registerRemoteCandidate(v.remoteName);
          offloadRemoteNames.add(v.remoteName);
        }
        const colon = v.remotePath ? v.remotePath.indexOf(":") : -1;
        if (colon !== -1 && !v.remotePath.startsWith("http://") && !v.remotePath.startsWith("https://")) {
          const vr = v.remotePath.slice(0, colon);
          registerRemoteCandidate(vr);
          offloadRemoteNames.add(vr);
        }
      }
```

then pass it at :743:

```typescript
  const { scopedConfig, remoteMapping } = extractScopedRcloneConfig(
    configContent,
    Array.from(shareableRemotes),
    offloadRemoteNames
  );
```

*(Edge cases verified: a remote hosting BOTH library content and offload versions classifies as `shared_fast_N` — cosmetic only, nothing functional keys on the suffix. `primaryRemote` is force-added to `shareableRemotes` at :741 before extraction, so the `tokenPath`/`backupPath` lookups at :777-778 always resolve through `remoteMapping` and their `|| \`shared_${primaryRemote}\`` fallbacks never fire.)*

**C.3 Ship the mapping in the payload.** Add to `AccessPassPayload` (:80-94):

```typescript
  remoteMapping?: Record<string, string>; // orig remote -> anonymized scoped name (guest passes, v1.0.3+)
```

and add `remoteMapping,` to the guest `payload` literal (:767-780). Leave admin passes unset.

**C.4 Import side (:1115-1122) — REQUIRED or nothing plays.** Prefer the shipped mapping; keep the prefix-strip derivation so passes issued by older versions still import:

```typescript
      const availableScopedRemotes = new Set(extractSectionNames(payload.scopedRcloneConfig));
      const guestImportMapping: Record<string, string> = {};
      if (payload.remoteMapping && Object.keys(payload.remoteMapping).length > 0) {
        for (const [orig, anon] of Object.entries(payload.remoteMapping)) {
          if (availableScopedRemotes.has(anon)) guestImportMapping[orig] = anon;
        }
      } else {
        // Legacy passes (pre-v1.0.3): scoped sections are shared_<orig>
        for (const scopedName of availableScopedRemotes) {
          if (scopedName.startsWith("shared_")) {
            guestImportMapping[scopedName.slice("shared_".length)] = scopedName;
          }
        }
      }
```

Everything downstream needs **zero edits** (verified): `rewriteRemotePath` (:480) consumes the mapping; remotes deliberately excluded from scoping (streamtape/telegram loopbacks, :646-650) still fall back to a nonexistent `shared_<orig>` section and are handled by the promote-first-playable-version logic at :1154 exactly as today; version `remoteName` rewriting (:1131-1145) consumes the same mapping.

**C.5 Display helper.** Add to `src/lib/accessPass.ts` (keep pass logic together; the original proposal said `tauri.ts`):

```typescript
export function formatRemoteDisplayName(name: string): string {
  return name
    .replace(/^shared_fast_(\d+)$/i, "Fast Cloud Remote $1")
    .replace(/^shared_cloud_(\d+)$/i, "Cloud Remote $1")
    .replace(/^shared_/i, "Shared ");
}
```

Guest-facing surfaces are already mostly masked (`MediaDetailPage.tsx:548` shows guests "Cloud Optimized Stream" instead of `ver.remotePath`). Apply `formatRemoteDisplayName(...)` wherever a raw `v.remoteName` or remote section name still renders for guests — the version chips in `MediaDetailPage.tsx` / `MediaDetailsModal.tsx`. The Item-10 `OffloadMirrorsPanel` is `!isGuest`-gated and needs nothing.

**C.6 Teardown — NO changes needed (verified):** `cleanupScopedRemotes` (:1267) deletes by section names parsed from `scopedRcloneConfig` (naming-agnostic), and `removeSharedPass` (:1321) keeps working precisely because every anonymized name still starts with `shared_`.

---

## 22. Item 22 (NEW): Music Mode In-Skin Album Switching & Queue Desync Fix — **[ROOT-CAUSED & FIXED]**

### A. Symptom
While inside compact Music Mode (`MusicSkinShell.tsx`):
- Attempting to switch to another album (via the in-skin Library tab or by selecting tracks) fails or keeps playing the previous album.
- Users were forced to exit to "Full App" mode, click `X` on `AudioMiniPlayer` to dismiss the active album, and only then select the new album.

### B. Root Causes (verified in source)
1. **Zustand ↔ Local State Race Condition in `AudioMiniPlayer.tsx:188-200` (Primary Bug):**
   ```typescript
   const [currentIndex, setCurrentIndex] = useState(initialIndex);

   // Effect 1: External prop sync
   useEffect(() => {
     setCurrentIndex(initialIndex);
   }, [initialIndex, playlist, playToken]);

   // Effect 2: Internal advance sync
   useEffect(() => {
     if (audioState && audioState.playlistIndex !== currentIndex) {
       setAudioPlaylistIndex(currentIndex);
     }
   }, [currentIndex, audioState, setAudioPlaylistIndex]);
   ```
   When `playTracks(newAlbumTracks, 0)` is called in `MusicSkinShell`, `audioState` in Zustand updates with `playlistIndex: 0` and the new playlist.
   Because `audioState` is in Effect 2's dependency array, Effect 2 triggers immediately on the render where `audioState.playlistIndex === 0` but local state `currentIndex` is still the **old index from the previous album** (e.g. index 3).
   Effect 2 evaluates `0 !== 3` $\rightarrow$ `true`, and calls `setAudioPlaylistIndex(3)`!
   This **clobbers the store back to 3**. If the new album has fewer tracks (e.g. 2 tracks), `newAlbumTracks[3]` is `undefined`! `currentTrack` evaluates to `null`, `if (!currentTrack) return;` aborts playback, and the player freezes on the previous audio stream.
2. **Missing Stop / Dismiss Control in `MusicSkinShell.tsx`:**
   In Full App mode, `AudioMiniPlayer` has an `X` button calling `setAudioState(null)` to dismiss the album. In `MusicSkinShell`, there was **no stop or dismiss button anywhere** in the header or queue, leaving users trapped with no way to reset the player without exiting to Full App.
3. **Now Playing Navigation Dead Ends:**
   On the Now Playing screen (`playing` tab), `currentTrack.artist` and `currentTrack.album` were plain text paragraphs. Clicking them did nothing, forcing users to manually re-navigate through the hierarchy.
4. **Hidden Navigation Tab Labels:**
   Nav pills used `hidden xs:inline` (e.g. `<span className="hidden xs:inline">Library</span>`). `xs` is not a defined Tailwind breakpoint in this repository, so the text was **permanently hidden**, leaving only cryptic tiny icons that users did not recognize as an album browser.

### C. Drop-in Fixes

**1. Fix State Sync in `src/components/audioplayer/AudioMiniPlayer.tsx`:**
Replace lines 188-200 with decoupled internal-advance synchronization:

```typescript
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  // Synchronize index whenever a new track, playlist, or album is selected externally
  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex, playlist, playToken]);

  // Keep store audioState.playlistIndex synced ONLY when tracks advance internally
  // (Do NOT depend on audioState object to prevent clobbering external dispatches)
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    const currentStoreIdx = useAppStore.getState().audioState?.playlistIndex;
    if (currentStoreIdx !== currentIndex) {
      setAudioPlaylistIndex(currentIndex);
    }
  }, [currentIndex, setAudioPlaylistIndex]);
```

*(Fix verified against source on review: the quoted buggy effects match `AudioMiniPlayer.tsx:188-200` **verbatim**, and the race is real — React runs both effects in the same commit with the stale `currentIndex`, so Effect 2 clobbers the store before Effect 1's `setCurrentIndex(0)` lands. The replacement is safe because the component's `initialIndex` prop IS `audioState.playlistIndex` (`App.tsx:332-337` passes `playlistIndex={audioState.playlistIndex}`), so any external index change still reaches Effect 1 — removing `audioState` from Effect 2's deps loses nothing. Internal advances (`playNextTrack`, the `"jump"` action at :1362) go through `setCurrentIndex` and still sync to the store.)*

And in the playback effect's cleanup (the `return () => {...}` at ~:1038-1050 of the effect whose deps are `[currentIndex, currentTrack?.id, playToken]`): add `audio.pause();` as the first line of the cleanup (before the `removeEventListener` calls) so the previous stream is silenced immediately while the new URL loads.

**2. Stop / Dismiss Controls in `src/components/music/MusicSkinShell.tsx`:**

**`playTracks` (line ~267) — NO CHANGE (correction to the original proposal):** the existing implementation already sets `{ playlist, playlistIndex, playToken: Date.now(), expanded: false }` and switches to the `playing` tab, which is exactly right. The originally proposed extra `window.dispatchEvent(new CustomEvent("rcloneflix:play-audio", ...))` must NOT be added: `App.tsx:73-77`'s listener for that event itself calls `setAudioState(...)` with a second `playToken`, so dispatching both would set the store twice and reload the audio stream twice. With Fix 1 in place, the existing `playTracks` works as-is.

Add `Square` to the lucide import list at `MusicSkinShell.tsx:4-8` (it is not currently imported), then in the header bar (next to "Full App", line ~386):
```tsx
          {/* Stop / Dismiss Current Album */}
          {currentTrack && (
            <button
              type="button"
              onClick={() => {
                dispatchControl("stop");
                setAudioState(null);
                setMusicSkinTab("library");
              }}
              title="Stop playback and dismiss currently playing album"
              className="p-1.5 rounded-lg bg-white/5 hover:bg-rose-500/20 text-white/60 hover:text-rose-300 transition-colors cursor-pointer"
            >
              <Square size={13} className="fill-current" />
            </button>
          )}
```

*(Note: `dispatchControl("stop")` already pauses AND dismisses — the global's `"stop"` case at `AudioMiniPlayer.tsx:1409-1413` calls `onClose()`, which is `() => setAudioState(null)` per `App.tsx:336`. The explicit `setAudioState(null)` after it is harmless belt-and-suspenders; keep it for clarity.)*

**3. Queue "Clear" button** — in Tab 3's header row (`MusicSkinShell.tsx:769-776`, the `Playing Queue ({playlist.length})` / `Track X of N` bar), replace the right-hand span with:

```tsx
              <div className="flex items-center gap-2">
                {playlist.length > 0 && (
                  <span className="text-accent">
                    Track {currentIndex + 1} of {playlist.length}
                  </span>
                )}
                {playlist.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      dispatchControl("stop");
                      setAudioState(null);
                      setMusicSkinTab("library");
                    }}
                    title="Clear queue and dismiss the current album"
                    className="px-1.5 py-0.5 rounded bg-white/5 hover:bg-rose-500/20 text-white/50 hover:text-rose-300 transition-colors cursor-pointer"
                  >
                    Clear
                  </button>
                )}
              </div>
```

**4. Clickable artist/album on Now Playing** (`MusicSkinShell.tsx:497-505` — currently plain `<p>` tags). Add two handlers near `playTracks` (verified: `musicArtists` is the memo at :221, `selectedArtist`/`selectedAlbum` are local state at :83-84, and `MusicArtist.albums` is a `Record<string, MusicAlbum>` per `appStore.ts:2322-2328`):

```typescript
  const navigateToArtist = (artistName?: string) => {
    if (!artistName) return;
    const artist = musicArtists.find((a) => a.name.toLowerCase() === artistName.toLowerCase());
    if (!artist) return;
    setSelectedArtist(artist);
    setSelectedAlbum(null);
    setMusicSkinTab("library");
  };

  const navigateToAlbum = (artistName?: string, albumName?: string) => {
    if (!albumName) return;
    const artist = artistName
      ? musicArtists.find((a) => a.name.toLowerCase() === artistName.toLowerCase())
      : musicArtists.find((a) =>
          Object.keys(a.albums).some((n) => n.toLowerCase() === albumName.toLowerCase())
        );
    if (!artist) return;
    const albumKey = Object.keys(artist.albums).find(
      (n) => n.toLowerCase() === albumName.toLowerCase()
    );
    setSelectedArtist(artist);
    setSelectedAlbum(albumKey ? artist.albums[albumKey] : null);
    setMusicSkinTab("library");
  };
```

then replace the two `<p>` tags:

```tsx
                    <button
                      type="button"
                      onClick={() => navigateToArtist(currentTrack.artist || currentTrack.author)}
                      title="Browse this artist"
                      className="text-xs text-accent font-medium mt-0.5 truncate block max-w-full text-left hover:underline cursor-pointer"
                    >
                      {currentTrack.artist || currentTrack.author || "Unknown Artist"}
                    </button>
                    {currentTrack.album && (
                      <button
                        type="button"
                        onClick={() => navigateToAlbum(currentTrack.artist || currentTrack.author, currentTrack.album)}
                        title="Browse this album"
                        className="text-[11px] text-white/50 mt-0.5 truncate block max-w-full text-left hover:text-white hover:underline cursor-pointer"
                      >
                        {currentTrack.album} {currentTrack.year ? `• ${currentTrack.year}` : ""}
                      </button>
                    )}
```

**5. Tab pill labels** — replace `hidden xs:inline` with `inline` at `MusicSkinShell.tsx:417` (Play), `:430` (Lyrics) and `:456` (Library). *(Verified: `tailwind.config.js` defines no `xs` screen, so these labels are permanently hidden today. The Queue pill (:434-444) has no hidden label — it intentionally shows the live track count `{playlist.length}`; leave it.)*

---

## 23. Verification & Test Plan Matrix (corrected)

| Component | Target Verification |
| :--- | :--- |
| **NNTP Connection** | Test real Easynews/Premiumize creds → success < 2s. Test `10.255.255.1:563` → clean error within 10-15s, spinner always stops. Stream a mounted NZB → still plays (flush fix touches the BODY path). |
| **Streamtape Account Bot** | Enable "account-wide" toggle; verify log line `Account-wide Streamtape: N files total, M due`; verify `rcloneflix_st_account_pings` localStorage fills; iframe count never exceeds batch. |
| **Title Matcher** | Play a BaddiesEast portal card → `showTitle` unset for flat cards; drill into a Yomi series → episodes KEEP the series title. Transcode from AddStreamBookmarkModal with edited title → TMDB does not overwrite it. |
| **Flat Telegram Scanning** | Scan flat dir with `Severance.S01E01.mkv` + `The.Bear.S02E01.mkv` + `[SubsPlease] Frieren - 05 (1080p).mkv` + `MF DOOM - MM..FOOD - 03 - Beef Rapp.mp3` → 2 shows + 1 anime S1E05 + correctly-tagged music track. |
| **Canonical Offload Namer** | Transfer a TV episode to `telegram:` → destination leaf is `Show.S01E01....mkv` (≤180 chars). |
| **Example Portals Rebrand** | UI shows "Example Portals" + "example media portals" copy. |
| **Comics Recency** | Open Comics portal with empty query → IA results sorted by `publicdate desc`, MangaDex by latest chapter; RCO latest-release rows present when CF allows (absence is tolerated, not an error). Searching still uses relevance/downloads sort. |
| **MovieBite Drill-Down** | Click a TV card → episode list (verify S/E ordering, thumbnails); click S01E01 → plays via existing extractor; kill network to elfhosted → falls back to trending without error. |
| **Yomi.to HLS** | Play a Yomi episode → local URL contains `/playlist.m3u8?` → hls.js engages, no demuxer error. Regression: play an MP4 from the user's own CF worker (`tg-serverless`) → still `/stream?`, still native playback. |
| **InfiniDysk Suite** | Result cards show Files / Save-Convert / Stream / ⋯ menu; accordion lists per-file actions on a season pack; Download-to-Computer saves the file; Transfer modal opens pre-filled with the `:8553` URL and forces local execution. |
| **DropMB Album Offload** | Offload a 10-track album → exactly ONE `dropmb.com/share/{id}` link, clipboard-copied; all 10 tracks gain `dropmbShareUrl` + version `shareUrl`. |
| **uDrop Subfolders** | Track in `udrop:media/Music/<album>/` → `findUdropFileByName` finds it; WebDAV fallback URL keeps `/` separators. |
| **Offload Mirrors Panel** | Admin: panel lists DropMB/Streamtape/uDrop/Telegram links with working copy buttons. Guest: panel absent. |
| **Multi-Account Pool** | Add a backup GHA account; set primary token to a quota-dead account → dispatch succeeds on backup, primary marked exhausted; poller tracks the run with the backup token. Kaggle: simulate quota error → creds swap + single retry. |
| **Cast Relay** | Cast an rclone-served file → Chromecast fetches via `LAN_IP:relay_port` and plays (previously: connection refused). `ss -tlnp` confirms the relay only exists after casting starts. |
| **Cast Discovery Fallback** | Rename/remove `avahi-browse` → devices still discovered via mdns-sd within ~4s. |
| **Album Fix Match** | Album-header Fix Match → album cards (not songs); selecting one updates ALL tracks' album/artist/art/year + official per-track titles; per-track Fix Match still works. |
| **Vinyl & Booklet** | "Vinyl + Needle" → needle-drop transient on track start + faint crackle bed **on Linux**; tube curve active on Windows/Android. Liner-notes drawer shows producer/engineer credits for a MusicBrainz-known album; booklet images render; PDFs offer download-and-open. |
| **Kaggle Name Compaction** | Dispatch Kaggle transcodes for TWO episodes of "Lord Of The Rings: Rings Of Power" back-to-back → two DISTINCT kernel slugs (`rfx-t……`), both pushes accepted, both jobs tracked independently to completion. Verify `/kaggle/working` holds only `out_1.mp4` during the run, and the uploaded remote file carries the full real episode filename (colon replaced with " -"). Re-align the same audiobook twice in a row → second push accepted. |
| **Android TV: Transport Keys** | On a TV remote: Play/Pause button toggles video playback (was dead); with music playing, Play/Pause/Next/Prev on the remote and the Now-Playing card all work; lock-screen seek moves both players. |
| **Android TV: Focus Reveal** | D-pad onto a library card → hover-only badges/buttons (favorite, remove, version) become visible and are reachable with further D-pad presses; focus ring visible at every stop; no element focusable while invisible. |
| **Android TV: MKV Handoff** | Play an MKV/EAC3 episode on a TV with VLC installed → opens in VLC and plays with audio. Without VLC → system chooser or clear toast instructing VLC install; app does not black-screen. MP4/H.264 content still plays in-app unchanged. |
| **Beautification: Desktop** | Install the `.deb` on an offline machine → Bebas Neue/DM Sans/JetBrains Mono still render (no system-font fallback). Route changes cross-fade; library loading shows skeleton cards, not spinners; card hover zooms the poster inside the frame; all new motion stops under `prefers-reduced-motion`. Modals remain fully opaque (SOLID UI STANDARD). |
| **Beautification: Android TV** | Text legible from 3 m; focused card lifts with accent ring while shelf siblings dim; small buttons get ring-only (no scale jitter); shelves snap-scroll; no backdrop-blur anywhere on TV; scroll bars hidden. |
| **Music Visualizer** | Windows/Android: play a track with strong bass → bars/ring visibly track the actual music (not a loop); switch accent theme → visualizer recolors. Linux desktop: visualizer animates in ambient mode, differs between tracks, freezes to baseline when paused, and is never labeled "live". Music Skin shows blurred-art ambilight + ring around spinning art; album header glows with the cover's dominant color; CORS-tainted artwork silently skips the glow. |
| **Sidebar Music Icons** | Sidebar shows TWO distinct icons: Music library section = the original note (`Music`), "Music Player Skin" mode button = `Disc3` record; with audio playing, the disc spins slowly (stops under reduced-motion). |
| **Weekly Recommendations** | Admin selects up to 3 titles for Movies library with "Hot Flame" effect → badge appears immediately on the ADMIN's own cards and the "⭐ Recommended Titles" shelf tops the admin HomePage (mirroring step); attempt to add a 4th title is blocked with the limit notice; export Guest Pass A; switch effect to "Gold Star" and export Guest Pass B; Pass A recipient gets "Hot Flame" on the 3 titles, Pass B gets "Gold Star"; both guests see the "⭐ Curator's Weekly Picks" top shelf; recommended items sort furthest-left within HomePage shelves ONLY; the recommendation badge SUPPRESSES (not stacks on) the In-Library/group/STREAM/favorite badges; badge survives an app restart (SQLite JSON blob). |
| **Remote Anonymization** | Export a Guest Pass with libraries backed by personal remotes (`ashim_gdrive`, `seedbox_crypt`, `udrop_offload`); inspect the guest's merged `rclone.conf`: sections are `[shared_cloud_1]`, `[shared_cloud_2]`, `[shared_fast_1]` with no personal names, no comments, no email/identity keys (auth keys like `user`/`pass`/`token` intact — the remote must still mount). Import on a test machine: items PLAY (mapping shipped in payload), UI shows "Cloud Remote 1"/"Fast Cloud Remote 1". Regressions: guest still CANNOT write/transfer to pass remotes (Rust guard keys on `shared_`), pass remotes stay out of remote pickers, `hasPersonalRemotes` stays false on a pure-guest device, and after expiry/revoke `removeSharedPass` deletes all `shared_cloud_*`/`shared_fast_*` sections. A pass exported by an OLD version still imports (legacy prefix-strip mapping path). |
| **Music Mode Album Switch** | Inside compact Music Mode window (`MusicSkinShell`), play Album A track 4; click Library tab and select Album B (2 tracks) → playback switches immediately to Album B track 0, audio plays without freezing, track index does not desync, `currentTrack` remains defined; click header Stop button → album dismisses and returns cleanly to Library tab; click artist/album name on Now Playing → navigates directly to that artist/album in Library; tab pill labels are clearly visible. |

---

## 24. Upcoming Items Queue
*Reserved for additional tasks.*

- (moved here from Item 12) Chromecast remux pipeline for MKV/AC3/DTS → HLS. Deferred.
- (moved here from Item 13) Remote-client iOS strategy over Tailscale serve. Deferred / roadmap.
- (moved here from Item 17) Fully in-app Android playback of MKV/AC3/EAC3/DTS via a Media3 (ExoPlayer) `SurfaceView` bridge in `MainActivity.java` — replaces the external-VLC handoff with native in-app decoding, keeping watch-progress and Up-Next inside RcloneFlix. Multi-week change; design when v1.0.3 ships.
- (moved here from Item 19) Butterchurn (Milkdrop) WebGL visualizer as an optional full-screen music mode on Windows/Android, and a native-side FFT tap for Linux desktop (e.g. a small GStreamer `spectrum`-element bridge exposed through a Tauri event) to make the Linux visualizer genuinely live. Both deferred.
