# RcloneFlix: Universal Content Discovery, DirectPlay, Debrid & Media Architecture Spec

**Version:** 1.1.0  
**Status:** Approved Architecture & Implementation Blueprint  
**Location:** `/home/ashim3000/rcloneflix/docs/DIRECTPLAY_AND_DISCOVERY_SPEC.md`  
**Confidentiality:** Public since 2026-11-16 — repo open-sourced under GPL-3.0-only (see `AGENTS.md` §1.5)  
**Target Platform:** Linux Desktop (Tauri v2 + React 18 / TypeScript + Rust + bundled Rclone + bundled yt-dlp)  
**Future Targets:** Windows Desktop (.msi / .exe), Android (Tauri Mobile)

---

## 1. Executive Summary & Core Philosophy

RcloneFlix is a **serverless, client-to-cloud media ecosystem** designed to combine the library management elegance of Plex/Infuse with the universal playback versatility of Stremio and VLC, while completely removing the requirement for a self-hosted central server, WireGuard VPN bridges, or monthly VPS infrastructure bills.

### The Core Problem Solved
Traditional media discovery and web streaming are broken by friction:
* Users are forced to open an external web browser, navigate spammy websites, dodge malicious popups and redirect ads, open browser DevTools or copy video embed links, and paste them into a player.
* Conventional browser extensions (like DirectPlay) are crippled by Chrome Manifest V3 constraints, sandboxing, and CORS barriers.
* Standalone cloud managers lack native media curation, automatic metadata grouping, and instant web discovery.

### The RcloneFlix Solution
RcloneFlix transforms into a **single, unified standalone desktop portal**:
1. **Never Open a Browser:** Type a base website domain (`baddieseast.com.co`, `moviebite.org`, `rlsbb.ru`, `eztv.ag`) directly into a universal top bar.
2. **In-App Discovery:** The app crawls the target site natively, presenting clean, ad-free post releases with post titles and posters in an in-app grid.
3. **Instant Resolution (DirectPlay & Debrid):** One click resolves the underlying media—whether from cyberlocker video embeds (Streamtape, Dood, Mixdrop) or premium file-lockers (Rapidgator, Katfile via Real-Debrid/Premiumize)—and matches TMDB/Cinemeta metadata.
4. **Three Action Modes:** Stream instantly (Ghost Player PiP), save as a 0 MB library bookmark (JIT resolution), or archive permanently (Cloud PVR via bundled `yt-dlp` remuxing HLS to clean `.mp4` on cloud remotes).

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                           RCLONEFLIX UNIFIED HUB                              │
├───────────────────┬───────────────────────────┬───────────────────────────────┤
│   LOCAL STORAGE   │   ENCRYPTED CLOUD VAULT   │     WEB DISCOVERY & INGEST    │
│  (/home/.../SSD)  │   (odrivecrypt/drivemine) │  (moviebite, baddieseast, RD) │
└───────────────────┴───────────────────────────┴───────────────────────────────┘
                                    │
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │   UNIVERSAL SEARCH & INGEST BAR (Stremio Experience)   │
       └────────────────────────────────────────────────────────┘
```

---

## 2. Post-Mortem: What Failed, What Was Half-Cooked & Lessons Learned

To ensure we never reinvent the wheel or repeat dead-end implementations, here is the exact breakdown of previous attempts:

### 2.1 DirectPlay Initial Ingest (Half-Cooked & Broken)
* **What was tried:**
  * Implemented host extractors in `stream_ingest.rs` expecting raw embed URLs (e.g. `streamtape.com/e/...` or `dood.watch/e/...`).
  * In user testing, **6 out of 7 links failed**; only MovieBite worked.
* **Why it failed:**
  1. **Missing Parent Page Website Scraping:** Real-world users do not hunt down raw iframe embed links. They visit an article or blog post (e.g. `https://baddieseast.com.co/episode-5/`). The previous code only checked the top-level HTML for `<video>` or `<source>` tags and completely ignored `<iframe>` embeds and player scripts pointing to Streamtape, Doodstream, Mixdrop, etc.
  2. **Too Many Steps:** The user had to open a browser, navigate the site, copy the link, and come back. This completely violated the core appeal of content discovery.
  3. **Forced Library Addition:** The user couldn't simply stream directly; they were forced through an "Add to Library" modal before playback could begin.
  4. **Broken Metadata Matching (Failed 100% of the time):**
     * Obfuscated CDN URLs (e.g. `tapecontent.net/.../video.mp4`) have random hash names that cannot be matched to movies or shows.
     * When title text was extracted, TV show episode titles (e.g. `"Baddies East Season 1 Episode 5"`) were queried against Cinemeta/TMDB movie endpoints as a literal string. This caused Cinemeta to return completely unrelated popular movies every single time.
* **The New Blueprint:**
  * Support full base domain crawling (`baddieseast.com.co`, `moviebite.org`) to extract post feeds directly into an in-app discovery view.
  * When a post is clicked, inspect its HTML for all supported cyberlocker `<iframe>` embeds and resolve the stream.
  * Use the human-readable **post title** (e.g. `"Baddies East - Season 1 Episode 5"`) for metadata matching. Use regex to extract Show Name, Season `SS`, and Episode `EE`, routing TV shows to TV endpoints and merging episodes into the existing series listing by TMDB Show ID.

### 2.2 Photo Vault (Implemented Feature Not Displaying)
* **What was tried:**
  * Added photo upload pipeline that compresses images to WebP (<95 KB) and encrypts them with AES-256-GCM before uploading to `drivemine:Photos/<Gallery>/` as `.enc` files (e.g. `002_min_min.webp.enc`).
  * Files exist on the remote (verified 72 KB on `drivemine:Photos/Untitled Gallery/` and `Tina Yoshi.../`).
  * Local cache files exist in `~/.cache/com.rcloneflix.app/photos/`.
* **Why viewing fails:**
  1. **Key Derivation Mismatch (Adult PIN vs Default Key):**
     * Photos uploaded with an adult PIN derive their AES key from that PIN.
     * When `PhotosPage` loads cover thumbnails, if `gallery.isAdult` is true, it queries `getSessionPin() || "rcloneflix-adult-vault-standard"`. If the session PIN has expired or was not set at upload time, the derived key is wrong. AES-GCM fails tag authentication (`Decryption failed: incorrect PIN or corrupted data`), leaving cards empty.
  2. **Remote Path Disconnect (`remotePath` vs `remotePreviewPath`):**
     * In `PhotoUploadModal.tsx`, remote paths were in some cases constructed without the remote prefix or with malformed subdirectories. When `photoVault.ts` calls `rclone_read_bytes`, `rclone cat` fails because the path doesn't resolve.
  3. **Cache Key Disconnect:**
     * Upload cached files using generated IDs (`photoId`). If the gallery store persisted with differing IDs or failed to sync the ID to the photo record, the disk cache lookup missed and fell back to `rclone cat`, hitting the remote path issue.
* **The New Blueprint:**
  * Enforce fully qualified remote paths (`${remote}:Photos/${galleryTitle}/${filename}.enc`).
  * Explicit key classification: Store `keyType: 'public' | 'adult_standard' | 'adult_custom'` on every photo record. If `adult_custom` and no valid session PIN exists, show a clean "Enter PIN to Unlock" prompt instead of throwing a silent decryption error.
  * Maintain an in-memory LRU decrypted object URL cache (`decryptedUrlCache`) so scrolling never re-runs heavy PBKDF2 iterations (100,000 rounds).

### 2.3 Abandoned Paths (Do NOT Reinvent):
* **Arweave Decentralized Photo Storage:** Abandoned. Network transaction confirmations took too long, gateways suffered from intermittent CORS/rate-limiting, and managing Arweave wallet tokens created massive user friction. Encrypted cloud storage (`drivemine:Photos/` / `odrivecrypt:Photos/`) via Rclone is the sole permanent target.
* **Shared Telegram / Teldrive Bots:** Abandoned. Shared bot pools get rate-limited and banned by Telegram's anti-abuse algorithms within 48 hours, causing total data loss. Casual users cannot be expected to create their own Telegram applications on my.telegram.org.
* **In-App Local Usenet Reassembly (NZBDav):** Abandoned. Unpacking multi-part yEnc articles and computing PAR2 parity blocks in desktop RAM is too resource-heavy. Usenet downloads are delegated exclusively to Premiumize's cloud NZB API.

---

## 3. Universal Search & Ingest Bar

### 3.1 UX / UI Architecture & Contrast Fix
* Stationed persistently in the top navigation header across all screens (Libraries, Photos, Settings, Player).
* **Strict Styling & Contrast Enforcement:**
  * Uses dark cinema palette (`bg-panel border-border text-bright placeholder-subtle`).
  * Explicitly sets `-webkit-appearance: none;` and high-contrast text color (`#EEF2F8`) so Linux WebKitGTK never renders white-on-white text.
* **Keyboard Shortcut:** `Ctrl+K` or `/` to instantly focus.
* **Recent Searches Memory:**
  * Stores the last 10 user queries in `localStorage`.
  * Displayed in the search bar dropdown when focused, with 1-click re-query and clear history buttons.
* **Site Bookmarking from Search:**
  * Whenever a site or feed is crawled, a quick "Bookmark Site" button allows adding the domain to the user's permanent DirectPlay bookmarks.

### 3.2 Deterministic Input Routing Hierarchy

```
[ User Input in Universal Bar ]
            │
            ├─► Starts with "http://", "https://", or matches Domain RegEx?
            │     │
            │     ├─► Base Website / Category Domain? (e.g. "baddieseast.com.co", "moviebite.org", "rlsbb.ru", "eztv.ag")
            │     │     └──► Route to [Site Crawler & Feed Discovery Engine]
            │     │
            │     ├─► Cyberlocker / Web Video Embed? (e.g. "streamtape.com/v/...", "dood.li/e/...", "moviebite.org/watch/...")
            │     │     └──► Route to [DirectPlay Stream Resolver]
            │     │
            │     └─► Premium File-Locker URL? (e.g. Rapidgator, 1Fichier, Katfile, DDownload)
            │           └──► Route to [Real-Debrid / Premiumize / Offcloud Unrestrict Engine]
            │
            ├─► Starts with "magnet:?xt=" or 40-char Torrent InfoHash?
            │     └──► Route to [Debrid Torrent Engine]
            │
            └─► Standard Search Query? (e.g. "The Wire", "House of the Dragon")
                  └──► Concurrent Search:
                        1. Local / Cloud Library SQLite database
                        2. TMDB API (Movies & TV Series)
                        3. Cinemeta Catalog API
```

---

## 4. In-App Site Crawler & Dedicated DirectPlay Section

### 4.1 Non-Overlapping Discovery Drawer (`SiteDiscoveryDrawer.tsx`)
* **Positioning Blueprint:**
  * The drawer/panel is **docked directly beneath the top search bar** (`top-[64px]`) rather than centering as a fullscreen overlay.
  * The top search bar remains **100% visible, focused, and editable** so users can refine or update queries immediately without dismissing the results view.

### 4.2 Dedicated "DirectPlay & Streams" Library Page (`/directplay`)
Accessed from the persistent sidebar, this page serves as the content discovery portal:
1. **Interactive Ingest Bar:** Top input to scrape any web URL, RSS feed, or paste direct stream links.
2. **"My Bookmarked Sites" Grid:**
   * Displays sites bookmarked by the user with custom title, favicon/logo, and last-crawled timestamp.
   * Clicking any bookmark instantly opens its live release feed.
3. **"Curated Example Bookmarks" Directory:**
   * **Movies & TV:** `MovieBite` (`moviebite.org`), `BaddiesEast` (`baddieseast.com.co`), `BrokenSilenze` (`brokensilenze.net`), `PrimeWire` (`primewire.tf` / mirrors)
   * **Anime:** `GogoAnime` (`gogoanime.py` / mirrors), `Yomi` (`yomi.to`)
   * **Live Sports & PPV:** `PPV.st`, `Tap4Sport` (`tap4sport.st`), `RiveStream` (`rivestream.ru`)
   * **Ad-Free YouTube / Video:** Invidious (`https://yt.chocolatemoo53.com`)
   * **Music & Albums:** Saavn (`saavn.squid.wtf`), iHeartRadio Live
   * **Shadow Library & Books:** Anna's Archive (`annas-archive.org`)
   * **Adult:** PornHub, etc.

### 4.3 Crawling & Parsing Pipeline (Rust Native HTTP)
1. **Network Engine:** Uses Rust `reqwest` client with desktop User-Agent, spoofed headers, and automatic redirect handling (no browser sandbox or CORS limits).
2. **HTML DOM Scraper (using `scraper` crate):**
   * Scans document for post containers (`article`, `.post`, `.entry`, `.item`, `div[class*="video"]`, `div[class*="episode"]`).
   * Extracts headline text, post permalink, thumbnail, and date.
3. **MovieBite Multi-Server Fallback Engine:**
   * Instead of aborting on the first server candidate (e.g. Saturn), the extractor iterates through all returned server objects (`Saturn`, `Jupiter`, `Mars`, `Neptune`).
   * Validates stream status via lightweight HTTP HEAD request and returns the first active, non-empty mirror.

---

## 5. DirectPlay Multi-Host Stream Resolvers

Adapted from `/home/ashim3000/directplay/content.js` and ported to native Rust execution:

### 5.1 Supported Hosts & Extraction Mechanics
| Cyberlocker Host | Extraction Method | Output Stream |
|---|---|---|
| **Streamtape** (`streamtape.com`, `.net`, `.to`, `.xyz`) | Regex match `#ideoolink` / inline script tokens (`id=`, `expires=`, `token=`). Reconstruct `https://streamtape.to/get_video?id=...`. Follow HTTP HEAD redirect to `tapecontent.net` direct MP4. | Direct MP4 |
| **Doodstream** (`dood.watch`, `.to`, `.la`, `.li`, `.pm`, `doodstream.com`, `dooood.com`, `doods.pro`) | Scrapes `/pass_md5/{hash}`. Queries token endpoint with spoofed `Referer`. Appends token string + expiry to CDN host. | Direct MP4 |
| **Mixdrop** (`mixdrop.ag`, `.co`, `.to`, `.sx`, `.bz`) | Unpacks JavaScript (`eval(function(p,a,c,k,e,d)...)`), extracts `MDCore.wurl`, normalizes protocol to `https:`. | Direct MP4 |
| **Filemoon** (`filemoon.sx`, `.in`, `.to`, `.pk`) | Unpacks packed JavaScript, extracts master HLS `.m3u8` playlist URL. | HLS Playlist |
| **Lulustream** (`lulustream.com`, `luluvdo.com`, `lulu.st`) | Extracts JWPlayer configuration or inline video source. | HLS / MP4 |
| **Bunkr** (`bunkr.pk`, `.si`, `.cr`, `bunkrr.su`, etc.) | Scrapes download/view page, requests `signUrl` or server download node. | Direct MP4 |
| **Filester** (`filester.sh`, `.me`, `.si`, `.gg`) | Calls async download API endpoint with file hash to obtain direct CDN URL. | Direct MP4 |
| **Sxyprn** (`sxyprn.com`, `.net`) | Decodes Base64 `ssut51` / `boo` token, normalizes `.vid` to `.mp4`. | Direct MP4 |
| **Miruro** (`miruro.tv`) | Intercepts HLS manifest URL from episode player API. | HLS Playlist |
| **MovieBite** (`moviebite.org`) | Queries internal `/api/watch/{id}` endpoint to return CDN source URL. | HLS / MP4 |
| **Archive.org** | Resolves direct file URL from metadata JSON API. | Direct MP4 / MKV |

### 5.2 Embedded iframe Resolution
When a blog post (e.g. `baddieseast.com.co/episode-5/`) is selected:
1. Rust backend fetches the post page HTML.
2. Scans for `<iframe src="...">` and `<a>` elements matching any supported host domain above.
3. If multiple mirrors exist (e.g. Streamtape + Doodstream), presents them as selectable mirrors with the fastest mirror pre-selected.
4. Executes the corresponding host resolver to obtain the playable CDN URL.

---

## 6. Multi-Engine Debrid & Universal Media Extensions

### 6.1 Real-Debrid, Premiumize & Offcloud Multi-Engine
*(Architectural space reserved to extend the Universal Bar to release blogs, file hosts, and torrents)*

* **Supported Debrid Providers in Settings:**
  1. **Real-Debrid:** `/rest/1.0/unrestrict/link` + `/torrents/addMagnet`
  2. **Premiumize:** `/api/v2/transfer/create` + `/api/v2/folder/list` (Cloud torrents, NZBs, hosters)
  3. **Offcloud:** `/api/cloud` + `/api/instant` (Cloud downloading, rapid hoster unrestrict, BitTorrent caching)
* **The Release Blog & Locker Workflow (`rlsbb.ru`, `eztv.ag`, etc.):**
  1. User enters `rlsbb.ru` or `eztv.ag` into the universal bar.
  2. RcloneFlix crawls releases and displays post titles.
  3. Clicking a release extracts the file-locker link (Rapidgator, Katfile, 1Fichier, DDownload) or magnet hash.
  4. Passes link to the user's active debrid provider (Real-Debrid, Premiumize, or Offcloud).
  5. Service returns a high-speed unthrottled CDN stream link.
  6. Opens the Action Card: Instant Stream, 0 MB Bookmark, Local Download, or Cloud Upload.

### 6.2 Live Stream Feeds & Sports Engine (`rivestream.ru`, `ppv.st`, `tap4sport.st`)
* **How Live Sports & Events Work in RcloneFlix:**
  * Sports sites (`ppv.st`, `tap4sport.st`, `rivestream.ru`) wrap live events in nested iframe players with aggressive popup scripts.
  * RcloneFlix bypasses all browser sandboxes, popups, and redirects using native Rust HTTP fetching.
  * Scrapes the embed page, unpacks player tokens/scripts, and extracts the direct HLS master `.m3u8` manifest.
  * Streams directly into RcloneFlix’s native HLS player or Ghost Player PiP.
  * **Result:** Ad-free, popup-free live UFC, boxing, football, and basketball feeds without an external browser.

### 6.3 Media Beyond Video: Books, Music & Radio
Expanding RcloneFlix's scraper architecture to all media libraries:
1. **Anna's Archive (`annas-archive.org` / mirrors):**
   * Shadows Libgen, Sci-Hub, Z-Library, and Internet Archive.
   * Scrapes book title, author, cover, year, format (`.epub`, `.pdf`), and size.
   * 1-click download directly to local disk (`~/Books/`) or cloud remote (`drivemine:Books/`).
2. **Saavn Music & Album Ingest (`saavn.squid.wtf` API):**
   * **Default Format: High-Efficiency AAC (`.m4a` / 160–320 kbps):** Superior compression curve to MP3, delivering perceptual transparency at half the file size for 2x faster cloud uploads (`rclone move`) and minimal storage overhead.
   * **Optional Formats:** MP3 (320 kbps) for legacy audio setups, and FLAC (Lossless) for audiophile archival.
   * Fetches album metadata, embedded cover art, tracklists, and direct CDN audio URLs.
   * Allows instant streaming or 1-click batch download of full albums with clean ID3 tags directly to local storage or cloud (`remote:Music/<Artist>/<Album>/`).
3. **iHeartRadio Live Radio Streams:**
   * Direct HLS AAC / MP3 live audio stream resolution for thousands of AM/FM and online stations.
   * Background audio playback through RcloneFlix’s existing `AudioMiniPlayer`.

---

## 7. 3-Tier Title Extraction & Robust Metadata Matching

### 7.1 The 3-Tier Title Hierarchy
Solves the problem of obfuscated cyberlocker hashes (`tapecontent.net/.../video.mp4`):
* **Tier 1 (Page OpenGraph / Schema):** Scrapes `<meta property="og:title">`, `article:section`, or JSON-LD headline from the parent post.
* **Tier 2 (Page Heading / `<title>`):** Scrapes `<h1>` or `<title>`, stripping site suffixes (e.g. `" - Watch Free Online"` or `" · MovieBite"`).
* **Tier 3 (Embed Metadata):** Reads title tags inside the cyberlocker iframe HTML.

### 7.2 Regex Title Sanitization & Episode Detection
Extracts clean show names, seasons, and episodes:
* Patterns matched:
  * `[Ss](\d{1,2})[Ee](\d{1,2})` (e.g. `S01E05`)
  * `Season\s*(\d{1,2})\s*Episode\s*(\d{1,2})` (e.g. `Season 1 Episode 5`)
  * `Episode\s*(\d{1,4})` or `Ep\s*(\d{1,4})`
* Strips scene tags: `.1080p`, `.720p`, `.BluRay`, `.x264`, `.WEB-DL`, `-FLUX`, `-SPARKS`.

### 7.3 Dual-Track TMDB / Cinemeta Queries & TV Grouping
* **If TV Series Detected (`season` and `episode` present):**
  * Queries TV Search: `/search/tv?query={ShowTitle}`.
  * Fetches Episode Details: `/tv/{show_id}/season/{season}/episode/{episode}`.
  * Returns: Show poster, episode still, episode title, synopsis, and air date.
  * **Seamless Grouping (Zero Duplication):** Shows are indexed in `appStore.ts` by `tmdbShowId`. Ingesting Episode 5 automatically slots it into `Season 01` alongside existing Episodes 1–4 under the same series card.
* **If Movie Detected:**
  * Queries Movie Search: `/search/movie?query={CleanTitle}&year={Year}`.
  * Returns: Movie poster, backdrop, tagline, synopsis, runtime, genre.
* **Fix Match Drawer:** Allows one-click re-binding if the automatic match is disputed by the user.

---

## 8. The Four Action Modes

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  Baddies East (2023) — Season 1 Episode 5: The Reckoning                               │
│  720p H.264 • Direct Stream (Streamtape CDN)                                           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  [ ▶ Play Now ]   [ 🔖 0MB Bookmark ]   [ 💾 Download Local ]   [ ☁ Save to Remote ]  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Play Now (Instant DirectPlay):**
   * Zero waiting, zero local disk consumption, zero cloud bandwidth.
   * Plays immediately in the native player or Ghost Player PiP.
2. **Save 0 MB Source Bookmark:**
   * Adds the item to the user's Movies, TV Shows, Music, or Books library grid.
   * Consumes **0 MB** of storage.
   * Live stream URL is resolved Just-In-Time (JIT) when clicked from the library.
3. **Download to Local Disk:**
   * Downloads video/audio/book directly to the user's local filesystem (e.g. `~/Downloads` or local media path).
   * Remuxes HLS to clean `.mp4` using bundled `yt-dlp` or saves direct media file.
4. **Save to Cloud Remote (Rclone PVR):**
   * Uses bundled `yt-dlp` and `rclone move` to stitch and save directly onto the user's cloud remote (`drivemine:`, `odrivecrypt:`, etc.).
   * Automatically organizes into structured folders:
     * Movies: `<Remote>/Movies/<Title> (<Year>)/<Title> (<Year>).mp4`
     * TV: `<Remote>/TV Shows/<Title> (<Year>)/Season <SS>/<Title> - S<SS>E<EE> - <EpTitle>.mp4`
     * Music: `<Remote>/Music/<Artist>/<Album>/`
     * Books: `<Remote>/Books/<Author>/<Title>.epub`

---

## 9. Player Upgrades: VFS Buffering & Ghost Player PiP

### 9.1 VFS Buffer Upgrade (`player.rs`)
Injected into RcloneFlix’s local stream daemon command flags:
```rust
"--vfs-cache-mode", "full",
"--vfs-read-ahead", "64M",
"--buffer-size", "16M",
"--dir-cache-time", "72h",
"--vfs-cache-max-age", "24h",
"--vfs-cache-max-size", "10G"
```
* Eliminates cloud streaming stutter on 1080p/4K bitrates.
* Enables instantaneous scrubbing on encrypted cloud remotes (`odrivecrypt:`, `drivemine:`).

### 9.2 Ghost Player (Floating Draggable PiP)
* Decouples playback state from the active route.
* Minimizing or navigating to Photos, Settings, or Libraries contracts the player into a floating, draggable, resizable mini-window in the bottom corner.
* Headless worker pre-buffers the first 10MB of the next episode in RAM for zero-delay binge transitions.

---

## 10. Universal Frontend Uploads with Optimistic Playback

1. User drags & drops any media file (Movie, Episode, Track, Photo) into RcloneFlix.
2. File moves to local staging (`~/.cache/rcloneflix/staging/`).
3. Card appears in library immediately with an *"Uploading to Cloud..."* status badge.
4. **Immediate Playback:** Clicking "Play" plays the staging file with 0 ms latency.
5. In the background, `rclone move` uploads the file encrypted to the remote. Once complete, the database pointer updates and the staging copy is removed.

---

## 11. Serverless Encrypted `.rflix` Library Sharing Passes

1. **Zero-Passphrase 1-Click Import:** Recipient does NOT enter any passphrase, PIN, or password. Simply dragging and dropping or opening the `.rflix` pass file immediately mounts and displays the shared libraries.
2. **Zero Credential or Grantor `rclone.conf` Exposure:** The recipient never receives or has direct access to the grantor's `rclone.conf`, master keys, or account credentials. Stream access is scoped and isolated without leaking configuration.
3. **Full Remote Backup Metadata Ingest:** The pass automatically pulls full rich metadata (posters, descriptions, episodes, genres) directly from the grantor's remote backup snapshot stored on the rclone remote (`.rcloneflix_backup.json.gz`), providing an instant, fully populated library view without needing web scraping on the recipient's machine.
4. **Single-Use Activation:** Each generated `.rflix` pass is strictly **single-use**. Once claimed and activated on the recipient's machine, it binds to that instance and cannot be forwarded, re-imported, or activated on any other machine.
5. **Direct Client-to-Cloud Streaming:** Friends stream directly from the cloud provider (OpenDrive, Debrid, WebDAV) to their own RcloneFlix instance. The grantor's computer streams 0 bytes; home IP is never exposed and the grantor's machine does not need to stay online.
6. **Restricted Expiry Intervals:** Strictly **1 Day**, **1 Week**, **60 Days**, or **Never (Lifetime)**. (Omitting 30 days disincentivizes commercial subscription abuse).
7. **First-Import Timer:** The expiry countdown begins strictly when the recipient first imports the pass (`activatedAt = Network_NTP_Time`), verified against network time to prevent system clock tampering.
8. **Read-Only Guards:** Client UI strips all upload, edit, scan-modification, and delete buttons; Rust backend explicitly rejects modification commands on shared remotes.
9. **$1 Minimum LNURL-Pay Request System:** In-app Lightning QR invoice allowing invitees to send media requests or feedback with a minimum $1 tip, alerting the grantor via webhook.

---

## 12. Photo Vault Decryption & Viewability Blueprint

### 12.1 Root Cause Summary
* Photos exist on `drivemine:Photos/<Gallery>/` as `.enc` files and in `~/.cache/com.rcloneflix.app/photos/`.
* Decryption fails due to:
  1. Key mismatch: Adult vault PIN derivation falling back to standard key when session PIN is missing.
  2. Inconsistent remote path formats in `appStore.ts` (`drivemine:Photos/...` vs relative paths).
  3. Disconnected cache keys between upload (`photoId`) and viewer lookup.

### 12.2 Implementation Fixes
1. **Remote Path Normalization:** Every photo record strictly stores the fully qualified remote path: `${remote}:Photos/${galleryTitle}/${baseName}.webp.enc`.
2. **Explicit Key Resolution:**
   ```typescript
   function getDecryptionKey(photo: GalleryPhoto, gallery: PhotoGallery): string {
     if (!gallery.isAdult) return PUBLIC_VAULT_KEY;
     const sessionPin = getSessionPin();
     if (sessionPin) return sessionPin;
     return "rcloneflix-adult-vault-standard";
   }
   ```
3. **Decryption Error Handling:** If `decryptBytes` fails with an authentication error, catch it gracefully and prompt the user to re-enter their PIN rather than failing silently.
4. **In-Memory LRU Cache:** Cache decrypted blob URLs in `decryptedUrlCache` so navigating between photos doesn't re-execute expensive PBKDF2 key derivations.

---

## 13. Implementation Roadmap & Phasing

```
[ Phase 1: Photo Vault Viewability & Decryption Fix ]
   └── Fix remote path resolution, PIN key derivation, and blob rendering.
   └── Verify live gallery rendering on existing drivemine:Photos/ galleries.

[ Phase 2: Universal Search Bar & In-App Site Discovery ]
   └── Build UniversalSearchBar.tsx with URL / domain / text classification.
   └── Implement Rust site crawler for base domains (baddieseast.com.co, moviebite.org).
   └── Build SiteDiscoveryDrawer.tsx for in-app release browsing.

[ Phase 3: DirectPlay Multi-Host Resolvers & 3-Tier Metadata ]
   └── Native iframe scraping for Streamtape, Doodstream, Mixdrop, Filemoon, etc.
   └── 3-tier post title extraction hierarchy + TV SxxEyy regex parsing.
   └── Series episode grouping by TMDB Show ID with Fix Match drawer.

[ Phase 4: yt-dlp HLS Remuxing & Cloud PVR Archiving ]
   └── Bundled yt-dlp integration to remux HLS streams into standalone .mp4 files.
   └── Auto-organize into Show (Year)/Season SS/ on cloud remotes via rclone move.

[ Phase 5: Player Buffering & Ghost Player PiP ]
   └── Inject VFS cache and read-ahead buffer flags into player.rs.
   └── Implement global floating, draggable Ghost Player mini-window.

[ Phase 6: Debrid & Release Blog Locker Engine ]
   └── Real-Debrid / Premiumize unrestrict API integration.
   └── Release blog crawling (rlsbb.ru, eztv.ag) for Rapidgator and torrent magnets.

[ Phase 7: Optimistic Frontend Uploads & Serverless .rflix Passes ]
   └── Drag-and-drop staging uploads with instant 0-second playback.
   └── Encrypted .rflix library bundle export/import with 1d/1w/60d/lifetime expiry.
```

---

*This document is stored locally at `/home/ashim3000/rcloneflix/docs/DIRECTPLAY_AND_DISCOVERY_SPEC.md` and will not be pushed to GitHub.*
