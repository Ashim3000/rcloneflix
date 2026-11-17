# Stream Ingest, Extractor & Player Routing Post-Mortem

**Document Location:** `docs/STREAM_INGEST_AND_EXTRACTOR_POSTMORTEM.md`  
**Date:** September 17, 2026  
**Scope:** Media discovery, cyberlocker extraction, HLS/audio player routing, and filesystem safety.

---

## 1. Summary of Regressions & Identified Bugs

| Bug / Failure | Symptom / Error | Root Cause | Implemented Fix |
| :--- | :--- | :--- | :--- |
| **Streamtape False Bypass** | `[mov,mp4] moov atom not found` in VLC | Webpage URL ended with `.avi.mp4`. `is_direct_media_url` returned `true` without scraping. | Excluded video hosts (`streamtape`, `dood`, `vidmoly`, etc.) from `is_direct_media_url`. |
| **Streamtape Obfuscation** | Scraper regex failed to extract video URL | Streamtape added decoy domain to `ideoooolink` (`.dcom`) and chained `.substring()` calls to `norobotlink`/`captchalink`. | Updated `extract_streamtape` to avoid honeypots, sum chained `.substring()` skips, append `&stream=1`, and resolve 302 redirect. |
| **Yomi.to 4Animo Obfuscation** | `adaptive demux error: Failed to create demuxer` / `detected format png_pipe` in VLC | 4Animo (`cdn.4animo.xyz`) disguises HLS segments as PNG image containers. | Implemented `resolve_cinextream` using WebAssembly decryption to extract clean unencrypted master `.m3u8` from Cloudflare Worker (`super-forest-20dc-zoko...workers.dev`), confirmed working in VLC. |
| **AniLink CDN 403 Block** | Standalone requests return `HTTP 403 Forbidden` | AniLink stream URLs (`fetch.nexabloom.top`) are guarded by Cloudflare bot protection requiring active browser session; internal API is iframe-only (`https://anilink.cc/docs`). | Routed Yomi extraction to clean CineXtream HLS streams that have no Cloudflare blocks and play natively in VLC. |
| **GogoAnime Stream Failure** | `direct_stream=None`, fallback to original URL | Episode page uses multiple mirrors in `data-video`; Vidmoly was not prioritized or lacked Referer. | Enabled Vidmoly mirror regex extraction with `Referer: https://ww4.gogoanimes.fi/` yielding `box-*.vmeas.cloud` master `.m3u8`. |
| **Audio Player Hijack** | Adult / Movie `.m3u8` video routed to `AudioMiniPlayer` | `.m3u8` extension check was global; inspect modal defaulted `libraryType` to `libraries[0]` ("music"). | Restricted `.m3u8` audio routing strictly to `isIheartStream`. Ensured media inspect respects classified type. |
| **iHeart WebKitGTK CORS** | `manifestLoadError: code: 0` in mini player | WebKitGTK enforces strict CORS on `.m3u8` and `.aac` segments. | Built `TauriHlsLoader` using `@tauri-apps/plugin-http` (`tauriFetch`) to proxy chunks via Rust backend. |
| **PornHub VLC 410** | `access stream error: HTTP 410 error` | PornHub CDN (`phncdn.com`) rejects VLC requests without Referer header. | Attached `:http-referrer=https://www.pornhub.com/` and User-Agent via `vlc::sys::libvlc_media_add_option`. |
| **Download Filename Crash** | `File name too long (os error 36)` | Long HTML titles exceeded Linux ext4 255-byte segment limit. | Truncated path segments to 180 characters in `sanitize_path_segment`. |
| **Yomi Series Flattened to Movie** | Entire anime series treated as single movie page | Yomi server does not render episode HTML; frontend hydrates via AniList GraphQL. | Built `crawl_yomi_feed` with AniList GraphQL integration to enumerate all episodes (`1..=N`) with `media_type: "tv"` and episode numbers; added series drilldown in DirectPlay. |
| **Yomi Subtitle Dependency** | Foreign audio unplayable without external subtitles | Extractor defaulted to Japanese audio (`category=sub`). | Updated `resolve_cinextream` to query `category=dub` first (fallback to `sub`), labeling streams as English Dub. |
| **Dev Server Connection Refused** | `Could not connect to localhost: Connection refused` in installed deb | Running raw `cargo build --release` doesn't embed frontend assets and points to `localhost:1420`. | Always package with `npx tauri build --bundles deb` and install via `sudo dpkg -i`. |
| **GogoAnime Hierarchy & 404s** | Sidebar links scraped as episodes; relative paths appended to category URL causing 404s; reverse order | Scraper unconfined to `#episode_related`; `site_url` used instead of domain origin. | Scoped to `<ul id="episode_related">`, resolved against `base_origin`, sorted ascending, stripped promotional titles. |
| **GogoAnime Dub Preference** | Subbed versions prioritized in search and drilldown | Default parsing retained HTML order where subs precede dubs. | Sorted releases with `(Dub)` or `-dub` first in search and catalog feeds. |
| **Sports Streams False Match** | Unrelated movies overwrite clean live sports match titles | `matchMetadataForStream` called unconditionally for all web streams. | Bypassed Cinemeta/TMDB matching when `isSports` is true; retained clean event title and sports metadata. |
| **BaddiesEast Search 404 & Scraping** | 404 on search; missing thumbnails; unparsed entities | Baddies East uses `/search/{q}` instead of `/?s=`; TieLabs places thumbnail after title; search feeds embed images in `<content:encoded>`. | Added `/search/{q}` routing; expanded RSS to `<content:encoded>` and `<media:content>`; expanded heading thumbnail window; decoded WordPress entities. |
| **Direct Media False Crawl** | Direct `.mkv`/`.webm`/`.avi` links crawled as HTML websites | DirectPlay input bar only checked `.mp4`/`.m3u8`; `crawl_website_releases` attempted to fetch feeds and download large binary video files into RAM as HTML. | Created `isSpecificStreamOrFile` supporting all media extensions; routed direct streams to Action Modal; added backend direct media guard short-circuiting crawler. |

---

## 2. Technical Post-Mortem Details

### 2.1 Streamtape Extraction Architecture
* **Endpoint Pattern**: Modern Streamtape embeds:
  ```html
  <script>
  document.getElementById('norobotlink').innerHTML = '//streamtape.com/get_video?id=x' + ('xcdO2rv...').substring(1).substring(2);
  document.getElementById('captchalink').innerHTML = '//streamtape.com/get_video?id=x'+ ('defgO2rv...').substring(4);
  </script>
  ```
* **Decoding Rule**:
  1. Ignore `ideoooolink` if `norobotlink` or `captchalink` exists.
  2. Parse the chained `.substring(n)` calls: `total_skip = sum(n)`.
  3. Slice token: `token[total_skip..]`.
  4. Ensure `&stream=1` query parameter is attached.
  5. Issue a HEAD request with `Referer: url` to capture the 302 `Location` header pointing to `tapecontent.net`.

### 2.2 Yomi.to Architecture & Provider Integration
* **Site Structure & Episode Hydration**:
  - Yomi is a Next.js single-page application. Series pages (`/anime/{slug}-{anilist_id}`) do **not** contain server-rendered HTML links to individual episodes.
  - Episode lists are hydrated on the client via AniList GraphQL (`https://graphql.anilist.co`).
  - To properly discover series episodes without fragile HTML scraping, `crawl_yomi_feed` queries AniList GraphQL with the series `id`, extracts `title`, `coverImage`, and `episodes` (or `nextAiringEpisode.episode - 1`), and generates individual `DiscoveredRelease` entries for each episode (`1..=total_episodes`).
  - In `DirectPlayPage.tsx`, clicking on a TV series release card automatically initiates `handleCrawl(release.post_url)` to expand the series hierarchy into all its playable episodes.
* **Audio Preference (English Dub Invariant)**:
  - Because native video playback cannot always load or render external subtitle tracks reliably, Yomi extraction **strictly prioritizes English dubbed audio**.
  - `resolve_cinextream` queries `category=dub` first (`Referer: https://cinextream.cc/api/embed/anime/dub/...`).
  - If English dubbing is unavailable for that specific episode, it gracefully falls back to `category=sub`.
  - Resolved streams are tagged with `[Dub]` in the title and labeled `Yomi.to (English Dub)`.
* **Provider 4 (CineXtream) — Primary Verified Stream**:
  - API: `GET https://cinextream.cc/api/anime-stream?anilistId={id}&episode={ep}&category=dub` (fallback: `category=sub`).
  - Decryption: Key derived via `SHA-256(anilistId + "c1n3t4r-0bf5c4t10n-s4lt-v1-2024-09")`, executed against WebAssembly module `https://cinextream.cc/decrypt.wasm` (`normalizeBuffer`).
  - Stream: Clean unencrypted master `.m3u8` from Cloudflare Worker proxy (`https://super-forest-20dc-zoko.forest-gum-n2-7-2-0-5.workers.dev/...`).
  - Playback Verification: Confirmed clean 1080p H.264 / AAC MPEG-TS playback in VLC with 0 demuxer errors.
* **Provider 2 (AniLink) — Embed Only Contract**:
  - Public contract (`https://anilink.cc/docs`): AniLink is designed exclusively as an iframe player (`/watch/{anilistId}/{episodeNumber}?variant=sub`).
  - Internal API routes (`/api/internal/streams/`) use HMAC-authenticated challenge tokens (`anilink-stream-protection-obfuscated`).
  - Sniffed CDN URLs (`fetch.nexabloom.top`) are guarded by Cloudflare bot protection requiring an active browser TLS session; direct standalone requests return HTTP 403 Forbidden.
* **Provider 6 (4Animo / ReCloud) — Obfuscated Fallback**:
  - Manifest API: `GET https://cdn.4animo.xyz/stream/getSources?t=...`
  - Limitation: Chunks are served disguised as PNG images (`detected format png_pipe`), which native VLC cannot demux without client-side JS/WASM decoding. Used only as a secondary fallback.

### 2.3 Strict Audio vs Video Boundaries
* In `AddStreamBookmarkModal.tsx` and `AudioMiniPlayer.tsx`, `.m3u8` is **NOT** an indicator of audio.
* Video HLS streams (from sports feeds, movies, anime, adult sites) must **NEVER** initialize `AudioMiniPlayer`.
* `isAudio` check is strictly:
  ```typescript
  const isAudio = isIheartStream || directAudioExtensions.test(url);
  ```

### 2.4 BaddiesEast & BrokenSilenze Discovery Architecture
* **Baddies East Search Routing**:
  - `baddieseast.com.co` returns `404 Not Found` on `/?s={query}`. The valid WordPress rewrite slug is `/search/{query}`.
  - The search feed endpoint `https://baddieseast.com.co/search/{query}/feed/` provides high-resolution 1024x579 promotional posters inside `<content:encoded><![CDATA[<p><img src="..." />...]]></content:encoded>`.
* **BrokenSilenze & Vidmoly Ingest**:
  - Search endpoint is `https://brokensilenze.net/?s={query}`.
  - Watch pages host direct embeds to **Vidmoly** (`https://vidmoly.org/embed-...`).
  - Vidmoly extraction yields clean unencrypted master `.m3u8` streams (`box-*.vmeas.cloud`) with `*` CORS wildcards and zero demuxer errors.
* **HTML Heading Precedence Invariant**:
  - In `parse_html_releases`, `plain_heading_re` (`<h[1-4]>`) MUST be evaluated before generic `heading_link_re` (`<(?:h[1-4]|div|a)>`). Otherwise, image thumbnail anchors (`<figure><a href="..."><img ...></a></figure>`) match before the title header, causing empty string titles and dropped articles.
  - Thumbnail extraction must scan both preceding (600 characters) and following (800 characters) surrounding HTML to handle themes where featured images follow the title header (e.g. TieLabs/Sahifa).

### 2.5 Direct Media Stream Guard & Ingest Routing
* **Extension Coverage & Parameter Stripping**:
  - Direct video and audio files (`.mkv`, `.mp4`, `.webm`, `.m3u8`, `.mpd`, `.avi`, `.mov`, `.flv`, `.ts`, `.m4v`, `.mp3`, `.m4a`, `.aac`, `.flac`, `.wav`, etc.) often contain URL tokens or query parameters (`?token=...`, `#fragment`).
  - `isSpecificStreamOrFile` in `streamResolver.ts` cleans query strings before extension matching.
  - Submitting direct media URLs in DirectPlay or UniversalSearchBar immediately opens the Action Modal (`isActionModalOpen(true)`), avoiding unnecessary crawler invocations.
* **Backend Short-Circuit Invariant**:
  - `crawl_website_releases` in `stream_ingest.rs` checks `is_direct_media_url(&trimmed)`.
  - When true, it extracts the clean title, TV season/episode, and media type directly from the URL filename, immediately returning a 1-release `SiteDiscoveryFeed` without issuing HTTP network requests or attempting to read multi-hundred megabyte video payloads into RAM as HTML.

---

## 3. Regression Prevention Rules
1. **Always consult existing documentation and post-mortems in `docs/` and `KNOWN_BUGS_AND_FIXES.md` before modifying scrapers, resolvers, or packaging workflows.**
2. **Never alter `is_direct_media_url` without verifying cyberlocker host exclusions.**
3. **Never test standalone releases using unbundled `cargo build --release` binaries; always run `npx tauri build --bundles deb` followed by `sudo dpkg -i` to verify embedded asset loading.**
4. **Never push secrets to remote git repositories.** *(Updated 2026-11-16: the repo is public under GPL-3.0-only — pushing code is allowed when the user asks; see `AGENTS.md` §1.5.)*
5. **Always verify stream playback in VLC directly rather than relying merely on HTTP 200 responses.**
