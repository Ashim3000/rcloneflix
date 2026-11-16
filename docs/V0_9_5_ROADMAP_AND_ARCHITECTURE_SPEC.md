# RcloneFlix v0.9.5 Architecture Specification & Roadmap

**Target Version:** v0.9.5  
**Document Author:** Antigravity Engineering  
**Date:** October 9, 2026  
**Status:** Approved for Implementation  

---

## 1. Executive Summary & Objectives

Version 0.9.4 addressed core regressions (EPUB scanner poisoning, DropMB multi-format expansion, Telegram Bot API fallback, and Cloud Explorer date-modified sorting). 

For **v0.9.5**, development focuses on three major architectural pillars:
1. **TV Show Missing Episode Discovery & Instant Easynews Resolution**: Automatically identify un-acquired aired TV episodes using TMDB air-date metadata, surfacing a 1-click Easynews search action directly within the season accordion.
2. **Multi-Provider Cloud Worker Dispatcher (Rotation Engine)**: Eliminate single-provider throttling, queue stalls, and usage wire trips by rotating background compute tasks across **Kaggle**, **GitHub Actions (GHA)**, and **Lightning.ai / Hugging Face Spaces**.
3. **Real-Debrid High-Bitrate Torrent Seeding Pipeline**: Provide an uncompressed, original-quality cloud streaming alternative to Streamtape by generating `.torrent` payloads on cloud runners, seeding them directly to Real-Debrid daemons, and caching unrestricted CDN links in SQLite.

---

## 2. Feature 1: TV Show Missing Episode Discovery & Easynews Ingest

### 2.1 The Problem & Opportunity
Currently, `MediaDetailPage.tsx` displays episodes scanned from the user's local or cloud rclone remotes. If a season is missing episodes (e.g., episodes 7–10 of a 10-episode season, or newly aired weekly episodes), they are simply missing from the UI. Users must manually leave the page, open the Discovery drawer, and manually type search queries.

Because **Easynews provides a direct HTTP search API** (unlike Real-Debrid which has no search engine), RcloneFlix can bridge this gap automatically.

### 2.2 Architecture & Flow
```
TMDB Series Metadata (Aired Episodes)
          │
          ├── Compare with SQLite (Scanned Library Items)
          │
          ▼
   Identify Missing Episodes (air_date <= today && !in_library)
          │
          ▼
   Render Missing Row in Season Accordion
   [ Episode 07 - "Title" • Aired Oct 4, 2026 • [🔍 Search Easynews] ]
          │
          ▼ (User Clicks)
   Execute Easynews Query: `"{Show Title}" S{season:02d}E{episode:02d}`
          │
          ├── Direct Stream (HTML5 Video Player)
          └── 1-Click Ingest / Download to Cloud Remote
```

### 2.3 Implementation Details
- **Frontend (`src/pages/detail/MediaDetailPage.tsx`):**
  - Fetch TMDB season details via existing TMDB API integration.
  - Compute `missingEpisodes = tmdbSeason.episodes.filter(ep => !scannedEpisodes.has(ep.episode_number) && isAired(ep.air_date))`.
  - Display subtle dashed-border row for missing episodes with an air date badge and a `"Search Easynews"` button.
- **Search Modal / Drawer Integration:**
  - Clicking `"Search Easynews"` opens a targeted Easynews search sheet pre-filtered to video formats (1080p/4K) with one-click play and one-click cloud import.

---

## 3. Feature 2: Multi-Provider Cloud Worker Dispatcher (Rotation Engine)

### 3.1 Motivation & Usage Limits
- **Kaggle Limitations:** Kaggle offers 30 hours/week of free compute, but strictly caps active concurrent sessions to 1–2 runs. Multiple simultaneous operations (e.g. M4B audiobook conversion + rclone folder transfer + media offloading) cause queue blockages or API errors.
- **GitHub Actions (GHA):** 
  - Free private repositories receive **2,000 minutes/month** (~33 hours).
  - Ubuntu runners spin up in **10–15 seconds** (significantly faster than Kaggle's 45–60s startup).
  - By using GHA primarily as an overflow/rotation fallback when Kaggle has active jobs, users stay well under the 2,000-minute monthly allotment and completely avoid tripping GitHub's automated high-bandwidth abuse heuristics.
- **Lightning.ai & Hugging Face Spaces:**
  - Lightning.ai provides 22 free compute credits/month.
  - Hugging Face Spaces provides free, persistent 2 vCPU / 16 GB RAM Docker environments suitable for headless tasks.

### 3.2 Dispatcher State Machine (`src/lib/cloudWorkerRouter.ts`)
```text
                       [Job Submitted]
               (Sync / Offload / Transcode / M4B)
                              │
                              ▼
                   [Cloud Worker Router]
                              │
            ┌─────────────────┴─────────────────┐
            │ Active Kaggle Jobs < 2            │ Active Kaggle Jobs >= 2
            │ & Kaggle Quota OK                 │ OR Kaggle Rate Limited
            ▼                                   ▼
      [Dispatch to Kaggle]              [Check GitHub Actions Configured?]
            │                                   │
            │                           ┌───────┴───────┐
            │                           ▼ YES           ▼ NO
            │                     [Dispatch to GHA] [Dispatch to Lightning.ai / Queue]
            ▼                           ▼               ▼
      [Monitor Status via API]   [Poll Run via GHA] [Notify User]
```

### 3.3 GitHub Actions Workflow Specification (`.github/workflows/cloud_worker.yml`)
- Triggered headlessly via GitHub REST API:
  `POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/cloud_worker.yml/dispatches`
- Inputs:
  - `job_type`: `rclone_transfer` | `m4b_convert` | `dropmb_offload` | `rd_torrent_seed`
  - `payload`: Base64-encoded encrypted job payload.
- Runner setup:
  - Ubuntu latest.
  - Automatically installs `rclone`, `ffmpeg`, `mktorrent`, and `aria2`.
  - Executes task and posts exit status.

---

## 4. Feature 3: Real-Debrid High-Bitrate Torrent Seeding Pipeline

### 4.1 Real-Debrid Clarifications (No Scrapers)
- **Real-Debrid has no keyword search API:** As established, RD cannot search for titles in the global swarm without external scrapers.
- **RcloneFlix Policy:** We do not embed torrent scrapers.
- **The Offloading Solution:** Real-Debrid acts as an **untouched high-bitrate streaming host** (replacing Streamtape's degraded 720p compression) by taking library files from cloud remotes, seeding them to RD, and using RD's high-speed CDN for playback.

### 4.2 End-to-End Offloading Pipeline
```text
1. User clicks "Offload to Real-Debrid" on Movie/Episode (MediaDetailsModal)
2. Cloud Worker (Kaggle or GHA) mounts/downloads source file from cloud remote
3. Worker generates .torrent file:
   $ mktorrent -a udp://tracker.opentrackr.org:1337/announce \
               -a udp://open.tracker.cl:1337/announce \
               -l 22 -o payload.torrent source_file.mkv
4. Worker pushes .torrent to RD:
   POST https://api.real-debrid.com/rest/1.0/torrents/addTorrent
   POST https://api.real-debrid.com/rest/1.0/torrents/selectFiles/{id}
5. Worker starts local BitTorrent seeder:
   $ aria2c --enable-dht=true --seed-ratio=1.0 payload.torrent
6. Real-Debrid connects and downloads file into its cache (100% complete)
7. Worker queries:
   GET https://api.real-debrid.com/rest/1.0/torrents/info/{id}
   POST https://api.real-debrid.com/rest/1.0/unrestrict/link (links[0])
8. Worker returns direct unrestricted streaming URL to RcloneFlix
9. RcloneFlix saves URL to SQLite (stream_url, provider='real-debrid')
10. User streams original 4K/1080p Remux with zero compression artifacts
```

---

## 5. Feature 4: DropMB Expiration Date Tracking & In-App Visibility

### 5.1 The Need
DropMB shares default to a 5-year expiration window. Users currently see a static "DropMB Cloud Cached" badge without knowing when their offloaded audio, books, PDFs, or comics will expire.

### 5.2 Technical Design
1. **API & Metadata Capture:**
   - When `createDropmbShare` / `completeDropmbShare` is executed, or when resolving an existing share via `resolveDropmbStream`, extract the ISO timestamp / `expiresAt` field from Pingvin/DropMB share metadata.
   - If not explicitly returned in the payload, compute `Date.now() + 5 * 365.25 * 86400 * 1000`.
2. **Database Persistence:**
   - Store `dropmb_expires_at` in SQLite `media_items` and multi-version record JSON.
3. **In-App Display & UX:**
   - **`MediaDetailsModal.tsx`:** Update the "DropMB Cloud Cached" badge to display `DropMB Cached • Expires: Oct 2031 (4y 11m)`.
   - **`MusicLibraryPage.tsx`:** Display expiration tooltips on album and track badges.
   - **Health Warning System:**
     - `> 90 days`: Subtle green/cyan badge.
     - `< 90 days`: Amber warning badge (`Expires in X days — Click to Renew/Re-offload`).
     - `Expired`: Red alert badge prompting seamless 1-click re-offload.

---

## 6. Feature 5: Cloud Explorer DropMB Offload for Relevant Files & Folders

### 6.1 Objective
Allow users navigating their cloud remotes (Google Drive, OneDrive, S3, WebDAV, local mounts) in Cloud Explorer to offload eligible files and entire folders directly to DropMB without having to first scan or match them into the library.

### 6.2 Scope of Relevant Media & Folders
- **Audio Files:** `.mp3`, `.m4a`, `.m4b`, `.flac`, `.ogg`, `.wav`, `.opus`, `.aac`
- **Ebooks & Documents:** `.epub`, `.pdf`, `.mobi`, `.azw3`, `.txt`
- **Comics & Archives:** `.cbr`, `.cbz`, `.zip`
- **Photos:** `.jpg`, `.jpeg`, `.png`, `.webp`
- **Folders:** Folders containing any of the above formats (e.g. music album folders, audiobook chapter directories, comic series).

### 6.3 UI Integration in `CloudExplorerPage.tsx`
1. **Row Actions for Files:**
   - Display a dedicated **"Offload"** button (CloudUpload icon) on hover alongside Preview/Download for supported file extensions.
2. **Row Actions for Folders:**
   - Display an **"Offload Folder"** button on folders containing audio, books, or comics.
3. **Floating Multi-Select Batch Bar:**
   - Add **"Offload Selected to DropMB"** button when one or more eligible items are checked.
4. **Execution & Feedback:**
   - Runs chunked upload via `dropmbOffload.ts` with floating progress indicator.
   - On completion, copies public share URL to clipboard, triggers success toast, and records the 5-year expiration timestamp.

---

## 7. Summary of v0.9.4 Fixes Under Test

Before implementing v0.9.5, the following v0.9.4 fixes are currently undergoing runtime validation:

| Component | Verified Change |
|---|---|
| **DropMB In-App Offload** | Buttons active on `MediaDetailsModal` for books, PDFs, audiobooks; "Offload Album" on `MusicLibraryPage`. |
| **DropMB On-Demand Reader** | `download_book_to_temp` streams DropMB HTTP URLs directly to reader iframe without persistent disk usage. |
| **DropMB Share Importer** | Multi-track share URLs (`https://dropmb.com/s/LIwq`) parsed and imported with tracks, artists, and albums. |
| **Cloud Explorer Sorting** | Added Date Modified button in toolbar and sortable "Modified" column in table rows. |
| **EPUB Metadata Guard** | Junk folder filtering, title-author match validation, and restoration of corrupted SQLite book records. |
| **Telegram Bot Uploads** | Official HTTP Bot API fallback for files ≤ 50 MB, resolving `ImportBotAuthorizationRequest`. |

---

## 8. Implementation Sequence for v0.9.5

1. **Phase 1: Missing TV Episode Detection & Easynews Action**
   - TMDB air-date comparison logic against SQLite `media_items`.
   - UI styling for missing episode rows in `MediaDetailPage.tsx`.
   - Direct Easynews query builder and search modal trigger.
2. **Phase 2: Cloud Explorer DropMB Offload for Relevant Files & Folders**
   - Row-level action buttons for supported media formats and folders.
   - Batch offload button in floating selection toolbar.
   - Real-time progress tracking and clipboard share link generation.
3. **Phase 3: DropMB Expiration Date Tracking & In-App UI Badges**
   - Record `dropmb_expires_at` in SQLite and multi-version structures.
   - Render expiration date and relative time remaining on cached badges with health thresholds.
4. **Phase 4: GitHub Actions Cloud Worker Integration**
   - Create reusable `.github/workflows/cloud_worker.yml` template.
   - Settings page inputs for GitHub PAT and repository slug.
   - `src/lib/cloudWorkerRouter.ts` for automatic Kaggle ↔ GHA concurrency rotation.
5. **Phase 5: Real-Debrid Seeder & Offload Pipeline**
   - Runner script (`rd_seed.py` / `mktorrent` + `aria2c`).
   - RD API integration for torrent creation, file selection, and unrestricting.
   - UI offload button and cached status badges in `MediaDetailsModal.tsx`.
