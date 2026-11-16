# Specification: Plex-Style Multi-Version Grouping & Streamtape CDN Offloading (via Bundled AList)

## 1. Executive Summary

This architecture solves the two primary operational bottlenecks of personal cloud media libraries:
1. **Cloud Bandwidth & Rate Limit Exhaustion:** Main storage backends (OpenDrive, Google Drive, OneDrive) throttle or ban accounts when subjected to heavy streaming bandwidth.
2. **Library Fragmentation:** Storing duplicates across multiple remotes (e.g. OpenDrive master copy, Google Drive backup, Streamtape edge cache) causes duplicate card clutter.

By combining **Plex-style multi-version deduplication** with **AList-driven Streamtape WebDAV edge caching**, RcloneFlix turns Streamtape into an ephemeral, high-speed CDN tier that transparently handles peak streaming demand without threatening the user's primary cloud accounts.

---

## 2. Feature 1: Plex-Style Multi-Version Media Grouping

### 2.1 Data Model
Instead of discarding duplicate records in `mergeMediaItems`, `MediaItem` and `TvEpisode` track all known source locations:

```ts
export type MediaSourceVersion = {
  id: string;
  remoteName: string;        // "streamtape", "opendrive", "gdrive", "local"
  remotePath: string;        // e.g. "streamtape:/TV/Severance/S01E01.mp4"
  libraryId: string;
  resolution?: string;       // "4K", "1080p", "720p", "SD"
  videoCodec?: string;       // "HEVC", "H.264", "AV1"
  audioCodec?: string;
  sizeBytes?: number;
  container?: string;        // "MP4", "MKV"
  streamUrl?: string;
  isLocal: boolean;
  priority: number;          // Evaluated dynamically based on rules
  lastVerifiedAt?: number;
};
```

### 2.2 Strict Rule-Based Playback Hierarchy
To eliminate decision fatigue and avoid intrusive modals, default playback follows a rigid 3-tier hierarchy:

$$\text{Priority 1: True Local Disk} \;\longrightarrow\; \text{Priority 2: Streamtape CDN} \;\longrightarrow\; \text{Priority 3: Primary Cloud Remote}$$

1. **Priority 1 (True Local Disk):** Instant local playback with zero latency, zero bandwidth, and offline capability.
2. **Priority 2 (Streamtape CDN):** Unthrottled global CDN edge streaming. Saves 100% of the user's cloud bandwidth and quota.
3. **Priority 3 (Primary Cloud Remote):** Master source of truth (OpenDrive, GDrive, OneDrive).
4. **Silent Fast Failover:** If Streamtape returns an HTTP 404, 410, or expired error, the player automatically falls back to Priority 3 without pausing or throwing an error modal.
5. **Manual Selection Override:** A "Play Version" selector remains available on the Media Item Detail page for users wanting to manually force a specific source (e.g. 4K HDR Remux on OpenDrive vs. 1080p Streamtape CDN).

---

## 3. Feature 2: Bundled AList & Streamtape WebDAV Backend

### 3.1 Architectural Role of AList
* **Why AList:** Rclone has no native Streamtape backend. AList (`alistgo.com`) provides a production-grade `StreamTape` storage driver that handles Streamtape API authentication, upload chunks, folder IDs, and translates file IDs into direct 302 CDN edge redirects.
* **WebDAV Bridge:** AList exposes this driver via WebDAV on `http://127.0.0.1:5244/dav`.
* **Zero Rclone Modification:** Rclone connects to AList via a standard `type = webdav` remote (`streamtape:`).

### 3.2 Bundling & Lifecycle (Zero Friction)
* **Pre-bundled Binary:** `alist` (Linux x64/ARM64) and `alist.exe` (Windows x64) are bundled directly inside the Tauri application (`src-tauri/binaries/`). No extra user downloads or terminal commands required.
* **Headless Background Process:** Tauri manages AList as a silent child process bound strictly to loopback (`127.0.0.1:5244`). It starts on app launch and terminates cleanly on app exit.
* **User Settings:** Users only need to enter:
  * **Streamtape API Login ID**
  * **Streamtape API Key**
  * **Enable Streamtape CDN Offload** (Toggle)

---

## 4. Automatic & Manual Offloading to Streamtape

### 4.1 Manual Push to Streamtape
* In Cloud Explorer or on any Movie/Show card, a **"Push to Streamtape Cache"** action triggers an `rclone copy` background task.

### 4.2 Automated Background Offloader
* **Settings:** "Auto-offload newest releases to Streamtape" (selectable for TV Shows and Movies).
* **Already-Uploaded Detection:**
  * **Zero API Cost:** RcloneFlix queries its local database for items where `!item.versions.some(v => v.remoteName === 'streamtape')`.
  * Items are prioritized by `addedAt DESC` (newest first).
* **Safety Caps:**
  * **Time-Capped:** The job runs for a maximum of **1 hour** per execution cycle to prevent prolonged transfer sessions.
  * **Transfer Throttling:** Strict concurrency limit (`--transfers 1` or `--transfers 2`) to protect primary cloud storage from rate-limiting triggers.

---

## 5. Technical Implementation Reference
For detailed configuration on:
- Bundling AList v3.64.0+ binaries for Linux, Flatpak, and Windows
- Setting up the universal admin password (`rcloneflix`)
- SQLite `x_storages` table settings (`native_proxy`, `down_proxy_sign = 0`, `extract_folder = 'front'`, `enable_sign = 0`)
- Rclone remote block injection (`url = http://127.0.0.1:5244/dav/streamtape`)

See the comprehensive guide in [`docs/ALIST_STREAMTAPE_SETUP_GUIDE.md`](ALIST_STREAMTAPE_SETUP_GUIDE.md).

