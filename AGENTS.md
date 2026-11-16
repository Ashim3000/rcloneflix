# RcloneFlix Agent Directives & Engineering Rules

> [!IMPORTANT]
> **MANDATORY DIRECTIVE: CONSULT DOCUMENTATION BEFORE ACTING**
> Prior to implementing features, refactoring scrapers, altering media routing, modifying download/playback pipelines, or running builds, the agent **MUST** inspect existing documentation in:
> 1. `KNOWN_BUGS_AND_FIXES.md` (check all 51+ documented bugs and root causes)
> 2. `docs/STREAM_INGEST_AND_EXTRACTOR_POSTMORTEM.md` (check extractor rules and stream invariants)
> 3. `docs/DIRECTPLAY_AND_DISCOVERY_SPEC.md` (check DirectPlay discovery contracts)
> Assumptions without checking prior post-mortems lead to immediate regressions. The agent must verify what has already been tried and succeeded or failed before writing or executing new code.

---

## 1. Core Architectural Invariants

### 1.1 Audio vs Video Player Routing (STRICTLY SITE-SPECIFIC)
* **iHeartRadio Only**: HLS `.m3u8` audio manifests are strictly restricted to iHeartRadio streams (`ihrhls.com`, `revma.ihrhls.com`, `iheart.com`).
* **VLC Exclusivity for Video**: All other `.m3u8` streams (movies, TV shows, anime, adult portals, live sports) **MUST ALWAYS** route to the native VLC video player via `VideoPlayerPage`.
* **Zero Fallback Misclassification**: Inspecting video streams must never default `libraryType` to `"music"`.

### 1.2 Direct Media vs Video Host Webpages
* **Host Exclusion**: Webpages from streaming portals and cyberlockers (`streamtape`, `dood`, `mixdrop`, `voe`, `filemoon`, `vidmoly`, `yomi.to`, `gogoanime`, `pornhub`, `sxyprn`, `moviebite`, `baddieseast`, etc.) often have movie titles ending in `.mp4`, `.mkv`, or `.avi` in their URL paths (e.g. `/v/123/Movie.1080p.mp4`).
* **Never Bypass Extractors**: `is_direct_media_url` MUST explicitly exclude these domains so they are never erroneously treated as direct media files and dumped onto VLC before being scraped.

### 1.3 Verified Extractor Specifications
1. **Streamtape**:
   - Streamtape injects honeypot decoy domains (`/streamtape.dcom/...`) into `ideoooolink`.
   - Legitimate tokens are located in `captchalink` or `norobotlink` using chained `.substring(...)` offsets (e.g. `.substring(1).substring(2)` or `.substring(4)`).
   - Player click appends `&stream=1`.
   - The resolved link (`https://streamtape.com/get_video?...&stream=1`) yields a 302 redirect via HEAD request to the direct `tapecontent.net` MP4 stream.
2. **Yomi.to Series Hierarchy & English Dub Invariant**:
   - Yomi uses Next.js with AniList IDs (`/anime/{slug}-{anilist_id}` and `/watch/{slug}-{anilist_id}/{episode}`).
   - **Series Hierarchy**: Yomi series pages do NOT render HTML links for episodes; they hydrate via AniList GraphQL. Crawling a series queries AniList GraphQL (`crawl_yomi_feed`) to enumerate all episodes (`1..=total_episodes`) with `media_type: "tv"`. In DirectPlay, selecting a series card drills down to display all individual episodes in `SiteDiscoveryDrawer`.
   - **English Dub Invariant**: Subtitles cannot be loaded reliably into native player instances. Therefore, Yomi extraction **strictly queries `category=dub` first** (`resolve_cinextream`) with fallback to `category=sub` only if dubbing is unavailable. Streams are tagged with `[Dub]` and labeled `Yomi.to (English Dub)`.
   - **Primary Resolver**: CineXtream (`resolve_cinextream`) uses WebAssembly decryption (`decrypt.wasm` + SHA-256 key derivation) to resolve clean unencrypted MPEG-TS HLS playlists (`super-forest-20dc-zoko...workers.dev`), verified 100% playable in VLC.
   - **4Animo Caveat**: 4Animo segments are PNG-obfuscated (`png_pipe`) causing VLC demuxer failure; it is preserved only as a secondary fallback.
3. **GogoAnime**:
   - Extracts master `.m3u8` streams from the Vidmoly mirror (`data-video` attribute) with `Referer: https://ww4.gogoanimes.fi/`.
   - Category pages (`/category/{slug}`) auto-resolve Episode 1 (`/{slug}-episode-1`).
4. **VLC Referer Headers**:
   - Sites requiring specific Referers (PornHub `phncdn.com`, Sxyprn `trafficdeposit.com`, Vidmoly) must have `:http-referrer` and `:http-user-agent` passed to `libvlc_media_add_option`.
5. **Download Filename Sanitization**:
   - Path segments must be truncated to 180 characters to avoid Linux ext4 filesystem `File name too long (os error 36)`.

### 1.4 Packaging & Standalone Desktop Binary Rule
* **Mandatory Debian Bundling**: Never test standalone execution with raw unbundled `cargo build --release` binaries; doing so leaves `devUrl: "http://localhost:1420"` active and causes `Connection refused`.
* **Packaging Pipeline**: Always run `npx tauri build --bundles deb` followed by `sudo dpkg -i /home/ashim3000/rcloneflix/src-tauri/target/release/bundle/deb/RcloneFlix_0.6.10_amd64.deb` before launching `/usr/bin/rcloneflix`.

### 1.5 Version Control & Repositories
* **Local Pair Programming Only**: Never push code, branches, or tags to GitHub or any remote repository. All work is strictly local on this machine.
