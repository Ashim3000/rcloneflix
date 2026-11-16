# RcloneFlix v0.9.71 — Comprehensive Feature Catalog, Roadmap & Commercial Sales Strategy

> **The ultimate local-first, serverless personal media center that streams directly from 40+ cloud storage providers, WebDAV backends, Debrid services, Usenet (Easynews), and Telegram — with zero local bandwidth cloud offloading.**

---

## 🌟 Executive Summary & Elevator Pitch

**What is RcloneFlix?**  
RcloneFlix is a unified desktop streaming powerhouse that turns your existing cloud storage, WebDAV shares, Debrid accounts, and Usenet subscriptions into a personal Netflix, Audible, Kindle, and Spotify — **without requiring a dedicated 24/7 server, Plex Pass, or local disk space**.

Everything streams on-demand, metadata is matched automatically, and heavy bandwidth transfers (cloud-to-cloud file copying, AV1 transcoding, Streamtape uploads, and Telegram backups) are offloaded to **free, headless cloud workers running at 1Gbps+ with 0 MB of your home internet bandwidth**.

---

## 💎 The 5 Core Pillars (Key Selling Points)

1. **True Serverless Cloud Streaming (The Anti-Plex)**:
   - No 24/7 power-hungry PC running in a closet, no NAS required, no port-forwarding headaches.
   - Runs directly on your desktop/laptop (Linux, Windows, ChromeOS/Debian) and streams straight from remote cloud chunks.
2. **Zero Storage Duplication**:
   - Stream 100+ TB directly from Google Drive, OneDrive, OpenDrive, Dropbox, Telegram, or WebDAV from an entry-level laptop with a 256 GB SSD.
3. **Headless Cloud Offload Engine (1Gbps+ Free Worker)**:
   - Free off-device batch transfers, video transcoding to AV1, Streamtape CDN uploads, and Telegram uploads (up to 2 GB per file) executed in the cloud without consuming home internet data.
4. **Whispersync Immersion Reading (Audible + Kindle in One)**:
   - Simultaneously listen to audiobooks while highlighting synchronized text in EPUBs, featuring automated M4B chapterized conversion and TOC alignment.
5. **Universal Entertainment Hub & Total Privacy**:
   - Movies, TV Shows, Music, Audiobooks, eBooks, PDFs, Photos, and PIN-locked Adult Vault in a single unified interface.
   - 100% local-first: no telemetry, no tracking, transparent on-the-fly Rclone Crypt decryption.

---

## 📋 Comprehensive Feature Status Inventory (v0.9.71)

### ✅ Working Features (Production Ready in v0.9.71)

#### 1. Core Cloud & Streaming Engine
* **40+ Rclone Cloud Providers**: Native streaming from Google Drive, Microsoft OneDrive, Dropbox, OpenDrive, Box, Mega, pCloud, Amazon S3, Backblaze B2, SFTP, FTP, and generic WebDAV.
* **Transparent Rclone Crypt**: Decrypts and streams encrypted cloud files and directories on-the-fly with zero disk footprint.
* **Embedded AList Daemon Engine**: Bundled headless AList service that mounts cyberlockers, PikPak, 115, Baidu, and Telegram-Drive into unified virtual remotes.
* **4-Tier Playback Fallback Hierarchy**: Resolves media via `Local Disk` ➔ `Streamtape CDN` ➔ `DoodStream CDN Relay` ➔ `Primary Cloud Remote`.
* **Zero-Bandwidth Dual Cyberlocker Offloading**: Cloud-to-cloud remote upload and two-way cloning between Streamtape and DoodStream (transfers happen datacenter-to-datacenter without local bandwidth).
* **Autonomous Background Keep-Alive Bot**: Invisible, sandboxed, audio-muted DOM scheduler that silently pings files reaching Day 25+ of inactivity to reset 30/60-day cyberlocker deletion clocks back to Day 0.
* **Automated DMCA Filename Versioning**: Increments file versioning (`_v2`, `_v3`) upon re-uploads to evade automated host filename bans while stripping tags in the UI (`cleanDisplayTitle`).
* **Guest Link Cloaking & Shielding**: When libraries are accessed via shared passes, raw cloud paths, cyberlocker URLs, and host names are cloaked to prevent guest DMCA reporting abuse.

#### 2. Cinema, Video & Web Portals
* **Hardware-Accelerated Video Player**: Native desktop player supporting MKV, MP4, WebM, AVI, TS, multi-audio tracks, and embedded/external subtitles (SRT, ASS, VTT).
* **Trakt & Simkl Integration**: Real-time scrobbling and two-way watch progress synchronization with 48-Hour discovery shelves.
* **Streaming Portals & Verified Live Playback**:
  * **MovieBite**: API extraction with mirror priority scoring (Cloudflare Worker edge streams prioritized, dead proxies filtered) and live Range GET packet probing.
  * **CineXtream / Yomi.to**: In-browser WebAssembly stream decryption (`decrypt.wasm`) with proxy segment rewriting for disguised `.ts.jpg` chunks.
  * **Pluto TV & Tubi TV**: Verified live channel stitchers and FAST TV manifests.
  * **BrokenSilenze & BaddiesEast**: Search crawler with automatic fallback to BrokenSilenze; Vidmoly and VOE embed extraction.
  * **Streamed.pk**: Live sports and PPV discovery with sandboxed WebKit playback.
  * **Adult Portals**: Native PornHub and Sxyprn decoders.
* **Local HTTP Stream Proxy**: Transparently rewrites HLS playlists to explicit typed endpoints (`/segment.ts`, `/segment.mp4`, `/playlist.m3u8`) and normalizes `Content-Type: video/mp2t`, eliminating MSE/FFmpeg codec rejection.

#### 3. Books, Audiobooks & Whispersync
* **Whispersync Immersion Reading**: Read EPUB ebooks while listening to companion audiobooks with real-time text/sentence highlighting, structural chapter TOC alignment, and Jaccard token matching.
* **Built-in EPUB & PDF Readers**: Typography controls (Serif, Sans, OpenDyslexic), reading themes (Sepia, Dark, AMOLED black), jump-to-page, and reading progress tracking.
* **One-Click M4B Audiobook Converter**: Converts loose folders of MP3/M4A/AAC files into a single chapterized M4B audiobook.
* **Audio Mini-Player**: Persistent bottom mini-player with waveforms, queue management, volume boost, and MusicBrainz metadata.

#### 4. Headless Cloud Offloader & Debrid
* **Cloud Worker Transfers (Kaggle)**: Zero local bandwidth cloud-to-cloud file copying, moving, and syncing.
* **Telegram 2GB Offloader**: Uses Telethon MTProto to upload media files up to 2,000 MB directly to Telegram channels/chats, bypassing standard 50 MB bot API limits.
* **Direct Web URL Offload**: Paste any HTTP/HTTPS or Debrid link; cloud workers pull and route it directly to Telegram, Streamtape, or cloud storage.
* **Cloud AV1/HEVC Transcoding**: Offloads video re-encoding to cloud workers with custom CRF profiles.
* **Easynews & Debrid**: Native Easynews API Usenet search (stream without downloading NZBs) and Real-Debrid / Premiumize / Offcloud unrestrictors.
* **TV Missing Episode Discovery**: TMDB air-date comparison flagging missing broadcast episodes with a 1-click search in Easynews.
* **DropMB 5-Year Offload**: Cloud file/folder packaging with 5-year expiration date tracking badges.

#### 5. Networking, Privacy & Packaging
* **Tailscale Serve / Funnel**: One-click private mesh network streaming to phones and laptops without port forwarding.
* **DLNA / UPnP Media Server**: Port 8200 streaming server for Smart TVs, PlayStation, Xbox, and media receivers.
* **Cryptographic Access Passes**: Shareable guest passes with expiration limits and library scoping.
* **PIN-Protected Adult Vault**: Hidden adult library with ThePornDB metadata matching.
* **Packaged Releases**: Ready-to-run `.deb` (Debian/Ubuntu), `.flatpak` (universal Linux), and `.exe` (Windows NSIS x64).

---

* **GitHub Actions Worker Overflow**: Automated fallback runner engine (`.github/workflows/cloud_worker.yml`) dispatched via `workflow_dispatch` when Kaggle hits concurrency limits (≥ 2 jobs), handling heavy video transcodes, transfers, and Whispersync alignments.
* **Real-Debrid Torrent Seeding Pipeline**: Cloud-worker based zero-bandwidth torrent seeding engine (`mktorrent` + `aria2c`) that seeds untouched 4K/1080p high-bitrate media into Real-Debrid CDN cache, making uncompressed remuxes instantly streamable as Priority 2 in the playback hierarchy.
* **GPU-Accelerated Whispersync Alignment Engine**: Cloud containerized faster-whisper alignment worker with pinned PyAV compatibility and SMIL overlay generator, transcribing audiobooks and injecting sentence-level synchronizations into EPUBs with zero local CPU load.

---

### ⚠️ Features with Caveats / In Progress

1. **Vidmoly 50-Request Limit**:
   * *Status*: Vidmoly caps free accounts at 50 requests/day and rejects Streamtape clone links. DoodStream + Streamtape are the active dual-host production pair; Vidmoly is used strictly as a playback resolver for web releases.
2. **Google Cast (Chromecast)**:
   * *Status*: DLNA/UPnP streaming to TVs and consoles works out of the box, but direct Chromecast browser casting from a Tauri desktop app is limited without an external Cast sender.

---

### 🔮 Planned Features (Roadmap)

* **Mobile Companion Client**: Lightweight Android/iOS companion app connecting over Tailscale to stream from your desktop library on the go.
* **Stremio Addon Compatibility**: Translation layer allowing community Stremio addons (Cinemeta, Torrentio) to load inside RcloneFlix.
* **OpenSubtitles Automatic Subtitle Downloader**: 1-click subtitle fetching for foreign language audio tracks directly inside the video player.

---

## 🎯 Commercial Sales Strategy & Marketing Guide

### 1. Business & Distribution Model
* **Platform Recommendation**: **Gumroad**, **Lemon Squeezy**, or **Whop**.
  * They handle automated license key generation, global VAT/taxes, credit card/PayPal processing, and instant delivery of the `.deb`, `.flatpak`, and `.exe` installers.
* **Pricing Strategy**:
  * **Option 1 (One-Time Lifetime License)**: **$29 – $49**. Highly attractive to the self-hosted community who hate subscriptions.
  * **Option 2 (Tiered Access)**:
    * **Standard License ($24)**: Full desktop app (`.deb`, `.flatpak`, `.exe`), all streaming backends, Whispersync.
    * **Pro / Lifetime Cloud Bundle ($49)**: Full app + pre-configured cloud worker scripts + VIP setup documentation.

### 2. Critical Legal & Positioning Guidelines ⚠️
* **Position as a "Personal Cloud Media Station & Universal Reader"**:
  * Emphasize: *Multi-cloud streaming, Rclone Crypt, WebDAV client, Whispersync immersion reader, Debrid personal link unrestrictor, Telegram backup tool*.
  * **Do NOT use piracy keywords** on public storefronts (Gumroad/Stripe/PayPal will freeze accounts if they see terms like "free movie scraper" or "baddies stream downloader"). Market it as an advanced media manager and cloud player.

### 3. Recommended Forums & Communities to Advertise On

| Platform / Forum | Section / Angle | Why It Works |
| :--- | :--- | :--- |
| **Reddit: `r/rclone`** | *"I built a native desktop streaming GUI for Rclone remotes with on-the-fly crypt decryption"* | Primary target audience; they already have cloud remotes and want a Netflix-style UI. |
| **Reddit: `r/DataHoarder`** | Focus on: *Zero local bandwidth cloud-to-cloud transfers, Telegram 2GB backups, and 40+ cloud streaming* | Data hoarders love moving massive files without burning local bandwidth. |
| **Reddit: `r/RealDebrid` & `r/debrid`** | Focus on: *Serverless desktop streaming from Real-Debrid / Premiumize without Plex* | Massive community constantly looking for desktop players alternative to Stremio. |
| **Reddit: `r/usenet` & `r/easynews`** | Focus on: *Native Easynews streaming without downloading NZBs or running SABnzbd* | Instant video streaming from Easynews retention is a rare, high-demand feature. |
| **Reddit: `r/audiobooks`** | Focus on: *Whispersync immersion reading (EPUB + Audiobook sync) and 1-click M4B converter* | Book lovers actively seek alternatives to Amazon's locked Whispersync ecosystem. |
| **Rclone Official Forum** | Post under the **"Show and Tell"** category | High respect for tools built around Rclone; drives immediate early power-user adoption. |
| **LowEndTalk / WebHostingTalk** | Post in the software / script marketplace | Huge concentration of seedbox owners and VPS users who manage remote cloud storage. |
| **Hacker News (Show HN)** | *"Show HN: RcloneFlix – Local-first cloud media center with on-the-fly Rclone Crypt streaming"* | Great for viral developer adoption and feedback if open-core or indie-funded. |
