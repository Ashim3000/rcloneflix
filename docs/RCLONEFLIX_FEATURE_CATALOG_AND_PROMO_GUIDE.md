# RcloneFlix v0.9.3 — Comprehensive Feature Catalog & Promotional Guide

> **The ultimate local-first, serverless personal media center that streams directly from 40+ cloud storage providers, WebDAV backends, Debrid services, and Telegram — with zero local bandwidth cloud offloading.**

---

## 🌟 Executive Summary & Elevator Pitch

**What is RcloneFlix?**  
RcloneFlix is a unified desktop streaming powerhouse that turns your existing cloud storage, WebDAV shares, Debrid accounts, and Usenet subscriptions into a personal Netflix, Audible, Kindle, and Spotify — **without requiring a dedicated 24/7 server, Plex Pass, or local disk space**. 

Everything streams on-demand, metadata is matched automatically, and heavy bandwidth transfers (cloud-to-cloud file copying, AV1 transcoding, Streamtape uploads, and Telegram backups) are offloaded to **free, headless cloud workers running at 1Gbps+ with 0 MB of your home internet bandwidth**.

---

## 💎 The 5 Core Pillars (Key Selling Points)

```
┌────────────────────────────────────────────────────────────────────────┐
│                          RCLONEFLIX PILLARS                           │
├─────────────────┬──────────────────┬─────────────────┬─────────────────┤
│  SERVERLESS &   │  UNIVERSAL ALL-  │ ZERO-BANDWIDTH  │ UNCOMPROMISING  │
│   ZERO DUPING   │     IN-ONE       │  CLOUD ENGINE   │ PRIVACY & ENCR  │
│                 │                  │                 │                 │
│ Stream directly │ Video, Music,    │ Off-device 1G+  │ Transparent     │
│ from 40+ clouds │ Audiobooks,      │ transfers, AV1  │ Rclone Crypt,   │
│ without local   │ EPUBs, PDFs, and │ transcode, and  │ PIN vault, zero │
│ hard drives or  │ Photos in one    │ Telegram/Tape   │ telemetry, 100% │
│ servers.        │ sleek desktop UI.│ offloads.       │ local-first.    │
└─────────────────┴──────────────────┴─────────────────┴─────────────────┘
```

1. **True Serverless Cloud Streaming**: No Plex Server, no Jellyfin instance, no NAS required. Runs directly on your desktop/laptop (Linux, Windows, ChromeOS/Debian) and streams straight from remote cloud chunks.
2. **Zero Storage Duplication**: Stream files transparently from Google Drive, OneDrive, OpenDrive, Dropbox, Telegram, or WebDAV without downloading them locally first.
3. **Headless Cloud Offload Engine (1Gbps+ Free Worker)**: Free off-device batch transfers, video transcoding to AV1, Streamtape CDN uploads, and Telegram uploads (up to 2 GB per file) executed in the cloud without consuming home internet data.
4. **Whispersync Immersion Reading**: Simultaneously listen to audiobooks while highlighting synchronized text in EPUBs, featuring automated M4B chapterized conversion.
5. **Universal Entertainment Hub**: Movies, TV Shows, Music, Audiobooks, eBooks, PDFs, Photos, and Adult Vault in a single unified interface.

---

## 📋 Comprehensive Feature Breakdown

### 1. Cloud Storage & Streaming Backend
* **40+ Rclone Cloud Providers**: Native integration with Google Drive, Microsoft OneDrive, Dropbox, OpenDrive, Box, Mega, pCloud, Amazon S3, Backblaze B2, SFTP, FTP, and generic WebDAV.
* **Transparent Rclone Crypt (Zero-Knowledge)**: Stream encrypted files and folders on-the-fly without decrypting them to disk.
* **AList Daemon Engine (Built-In)**: Headless AList daemon bundled directly in the app to mount Streamtape, PikPak, 115, Quark, Baidu, and Telegram-Drive into unified virtual remotes.
* **Smart Streaming Buffer & VFS Caching**: Configurable directory cache time, read chunk sizing, and stream buffering tuned for immediate playback start without buffering hiccups.
* **Multi-Remote Library Aggregation**: A single "Movies" or "Books" library can seamlessly aggregate folders across multiple separate cloud providers and local drives simultaneously.

---

### 2. Video Playback & Cinema Experience
* **Native Desktop Video Player**: High-performance hardware-accelerated playback supporting MKV, MP4, WebM, AVI, TS, and more.
* **Multi-Audio & Subtitle Track Switching**: Instantly switch between multiple audio languages and embedded or external subtitle tracks (SRT, ASS, VTT).
* **Trakt & Simkl 2-Way Sync & Scrobbling**:
  * Real-time playback scrobbling to Trakt.tv.
  * Native Simkl device PIN pairing for automated watch status sync.
  * 48-Hour Discovery Shelves on the Home screen featuring Trending & Anticipated movies and TV shows.
* **Smart Watch Progress & Resume**: Automatically resumes videos where you left off, marks episodes as watched, and manages "Continue Watching" across libraries.
* **Streamtape CDN Edge Fallback**: Automatic route optimization to Streamtape CDN when available, preserving primary cloud remote bandwidth and API quotas.

---

### 3. Reading & Audiobooks (Kindle + Audible in One)
* **Whispersync-Style Immersion Reading**:
  * Synchronized text-to-audio playback: read EPUB books while listening to the companion audiobook track.
  * Real-time sentence/paragraph highlighting synchronized with the audio narrator.
* **Built-in EPUB Reader**:
  * Customizable typography: Serif, Sans-Serif, OpenDyslexic, font sizes, line height, and margins.
  * Color schemes: Light, Dark, Sepia, and AMOLED Void Black.
  * Table of Contents navigation, bookmarking, and reading percentage tracking.
* **Built-in PDF Reader**:
  * Native zoom, dual-page / single-page view, sidebar thumbnails, text search, and jump-to-page navigation.
* **Audiobook Player & Converter**:
  * Dedicated chapter drawer, variable playback speed (0.5x to 3.0x), 15s/30s skip controls, and sleep timer.
  * **Automated M4B Audiobook Converter**: Convert loose folders of MP3/M4A/AAC files into a single chapterized M4B audiobook file with one click.

---

### 4. Music & Audio Experience
* **Built-in Audio Mini-Player**: Persistent bottom mini-player with waveform/seek bar, volume boost, queue management, and album art display.
* **Lossless & Hi-Res Format Support**: Play FLAC, ALAC, WAV, AAC, OGG, and MP3 straight from cloud storage without transcoding.
* **MusicBrainz Integration**: Automatic artist, album, track number, and cover art matching directly in the file explorer.

---

### 5. Headless Cloud Offload Engine (Zero Local Bandwidth)
* **Off-Device Cloud-to-Cloud Transfers**:
  * Copy, Move, or Mirror files between any cloud remotes via headless Kaggle workers with Gigabit bandwidth.
  * Zero consumption of local home internet or mobile data.
* **Telegram Cloud Offload (Up to 2,000 MB per file)**:
  * Uses **Telethon MTProto** (bypassing standard 50 MB bot API limits) to upload media files up to **2 GB each** directly into Telegram channels, groups, or personal chats.
  * Built-in fallback credentials using official Telegram Desktop keys—just enter your Bot Token and Chat ID.
* **Streamtape Direct Edge Offloader**:
  * Direct multipart uploads to Streamtape's edge ingestion API with folder routing, returning live watch URLs in real time.
* **Direct Web URL Offload Engine**:
  * Paste any HTTP/HTTPS direct download link, open web directory URL, or Debrid link.
  * The cloud worker downloads the link at gigabit speed and routes it to Telegram, Streamtape, or your chosen Rclone remote.
* **Headless Cloud AV1 Transcoder**:
  * Offload CPU/GPU-heavy video transcoding to cloud workers running FFmpeg with modern AV1/HEVC encoding presets and custom CRF profiles.
* **Live Cloud Transfer Drawer**:
  * Real-time terminal log viewer, progress bars, cancellation controls, and job history.

---

### 6. Discovery, Debrid & Web Stream Bookmarks
* **Easynews & Usenet Search Engine**:
  * Native Easynews API integration: search Usenet retention directly in RcloneFlix and stream video files without downloading NZBs or using SABnzbd.
* **Debrid Resolvers**:
  * Built-in API support for **Real-Debrid**, **Premiumize**, and **Offcloud**.
  * Unrestrict and stream premium hoster and torrent links directly in-app.
* **Web Stream Bookmarking & Site Discovery**:
  * Bookmark direct HLS/DASH/MP4 web streams and custom IPTV feeds.
  * Browse and stream bookmarked web video feeds with full player controls.
* **Automatic Metadata Matching (TMDB & ThePornDB)**:
  * Automatic identification of movies and TV episodes with release year, posters, backdrops, plot overviews, and cast lists.
  * Manual "Match Folder" tool for fixing misnamed media using TMDB, MusicBrainz, or ThePornDB.

---

### 7. Casting, DLNA & Mesh Network Remote Access
* **DLNA / UPnP Media Server**:
  * Turn RcloneFlix into a local DLNA streaming server (Port 8200).
  * Direct streaming to Xbox, PlayStation, Smart TVs, Roku, and media receivers.
* **Tailscale Serve & Funnel Integration**:
  * One-click private mesh network streaming via Tailscale Serve.
  * Stream to your phone, tablet, or work laptop anywhere in the world without port forwarding or exposing ports to the public internet.
* **Shareable Access Passes**:
  * Generate cryptographically signed **Access Passes** for friends and family.
  * Configure custom expiration dates, read-only permissions, and restrict access to specific libraries.
  * Instant import via one-click pass phrase or QR code.

---

### 8. Privacy, Security & Adult Vault
* **Adult Content & Vault Privacy**:
  * Dedicated PIN-protected Adult Library mode.
  * Option to completely hide adult libraries from view until unlocked via PIN.
  * Automatic metadata matching via ThePornDB API.
* **Zero Telemetry & 100% Local-First**:
  * No user accounts on external servers.
  * No tracking pixels or telemetry.
  * All database records, watch histories, and API keys are stored locally on your machine with optional encrypted cloud backup.
* **One-Click Cloud Backup & Restore**:
  * Export/import encrypted backups (`.json.gz`) directly to and from your Rclone remotes.

---

## 📊 Feature Comparison Matrix

| Feature | RcloneFlix | Plex | Jellyfin | Stremio |
| :--- | :---: | :---: | :---: | :---: |
| **Requires 24/7 Home Server** | ❌ **No** | ✅ Yes | ✅ Yes | ❌ No |
| **Direct Stream from 40+ Clouds** | ✅ **Native** | ❌ (Needs rclone mount) | ❌ (Needs rclone mount) | ❌ No |
| **Transparent Rclone Crypt** | ✅ **Yes** | ❌ Complex | ❌ Complex | ❌ No |
| **Zero-Bandwidth Cloud Offload** | ✅ **Yes (Kaggle)** | ❌ No | ❌ No | ❌ No |
| **Telegram 2GB Cloud Upload** | ✅ **Yes** | ❌ No | ❌ No | ❌ No |
| **Direct Web URL Offload** | ✅ **Yes** | ❌ No | ❌ No | ❌ No |
| **Audiobooks + Whispersync** | ✅ **Yes** | ❌ Plugin hack | ❌ Partial | ❌ No |
| **EPUB & PDF Reader** | ✅ **Yes** | ❌ No | ❌ Books only | ❌ No |
| **Native Easynews & Debrid** | ✅ **Yes** | ❌ No | ❌ Third-party plugin | ✅ Addons |
| **Streamtape Edge Fallback** | ✅ **Yes** | ❌ No | ❌ No | ❌ No |
| **Tailscale Serve / Mesh** | ✅ **Built-in** | ❌ Manual | ❌ Manual | ❌ No |
| **Cost** | 🆓 **100% Free** | 💰 $4.99/mo | 🆓 Free | 🆓 Free |

---

## 🎯 Target Audiences & Promotional Hooks

### 1. The Cloud Hoarder / Rclone Power User
* **Hook**: *"Stop wasting hours downloading files just to watch them. Stream your encrypted cloud storage directly."*
* **Angle**: Transparent rclone crypt streaming, multi-cloud library aggregation, and 0-bandwidth cloud-to-cloud transfers.

### 2. The Debrid & Usenet Enthusiast
* **Hook**: *"Your Real-Debrid, Premiumize, and Easynews accounts in a sleek, serverless Netflix-style UI."*
* **Angle**: Direct streaming, no local storage required, clean metadata matching, and web stream bookmarking.

### 3. The Book & Audiobook Enthusiast
* **Hook**: *"Audible and Kindle in one app — with Whispersync immersion reading that highlights text as the narrator speaks."*
* **Angle**: Built-in EPUB/PDF readers, chapterized M4B audio player, one-click folder-to-M4B converter.

### 4. The Bandwidth & Storage Conscious (Laptops & Chromebooks)
* **Hook**: *"Run a complete 100 TB media empire from an entry-level laptop or Chromebook without filling your SSD."*
* **Angle**: Zero local disk usage, cloud offload transfers that run while your laptop is asleep, zero home internet data consumed.
