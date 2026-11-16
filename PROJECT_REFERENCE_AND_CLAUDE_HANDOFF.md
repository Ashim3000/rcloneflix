# RcloneFlix: Project Reference & Claude Handoff Guide

**Target Audience:** AI Engineering Agents (Claude, Antigravity) & Maintainers  
**Current Version:** RcloneFlix v1.0.2 (Tauri v2 + React 18 + Rust)  
**Host Environment:** Linux x86_64 (ChromeOS Crostini / Debian Bookworm container)  
**Package Paths:**
- Binary: `/usr/bin/rcloneflix`
- Packaged Debian Package: `/mnt/chromeos/MyFiles/Downloads/RcloneFlix_1.0.2_amd64.deb`
- Project Repository: `/home/ashim3000/rcloneflix`

---

## 1. Project Overview & Architecture

RcloneFlix is a high-performance cross-platform personal streaming and cloud media aggregator built with **Tauri v2**, **React 18**, **TypeScript**, and **Rust**. It unifies disparate cloud remotes, cyberlockers, Usenet, and encrypted vaults into a single Netflix/Plex-style interface.

### Core Stack Components
1. **Frontend (`/src`)**:
   - React 18 + TypeScript + Vite + TailwindCSS + Lucide Icons.
   - Dual-engine media playback:
     - **HTML5 `<video>`**: Used for standard H.264 / AAC MP4 and WebM files.
     - **Native libVLC (embedded)**: Rendered into the Tauri native X11 window (`get_window_xid`) for high-bitrate containers and codecs unsupported by Linux WebKitGTK (AV1, HEVC, AC3, EAC3/DDP, DTS, TrueHD, MKV, TS, AVI).
2. **Backend Core (`/src-tauri`)**:
   - Tauri v2 command router (`src-tauri/src/commands/`).
   - `player.rs`: Orchestrates `VlcManager`, spawns ephemeral `rclone serve http` daemon pools, and handles external players (VLC, MPV, MPC-HC, Kodi).
   - `stream_proxy.rs`: Embedded loopback HTTP proxy (`127.0.0.1:8552`) supporting HTTP 206 partial content range requests for MTProto and custom streams.
   - `telegram.rs`: Pure-Rust MTProto client using `grammers-client = "=0.7.0"` (binary TL sessions, zero C-SQLite collisions).
   - `usenet_dav.rs`: Pure-Rust NNTP client engine listening on `127.0.0.1:8553`, performing on-the-fly streaming for NZB media with mount persistence (`usenet_mounts.json`).
   - `alist.rs`: Manages bundled AList sidecar binary for cyberlocker WebDAV bridges (`302_redirect`).
   - `kaggle.rs` & `.github/workflows/cloud_worker.yml`: Headless cloud transcoding and cloud-to-cloud transfer workers, with spine-ordered OPF parsing and rapidfuzz-anchored SMIL audio-text alignment.

---

## 2. Port Allocation Map

| Port | Service | Implementation | Purpose |
| :--- | :--- | :--- | :--- |
| **8551** | Official Telegram Drive Desktop | cameronamer/telegramdrive | Local WebDAV server (`/dav/<token>/`) |
| **8552** | RcloneFlix DirectPlay Proxy | `stream_proxy.rs` (Rust hyper/tokio) | Native MTProto `tg-native:` streaming |
| **8553** | InfiniDysk Usenet Engine | `usenet_dav.rs` (Rust tokio/hyper) | Direct NNTP-to-WebDAV streaming (`usenet-drive:`) |
| **5244** | Embedded AList Daemon | `/usr/lib/RcloneFlix/alist` | Bridges Streamtape REST API to WebDAV (`/dav/streamtape`) |
| **Dynamic** | Rclone VFS HTTP Stream Pool | `player.rs` (`rclone serve http`) | On-demand VFS HTTP streams for OneDrive, Google Drive, Crypt |

---

## 3. Important Secret & Configuration Locations

All secrets, user configurations, databases, and tokens are stored in the following locations:

### A. Rclone Configuration
- **Path:** [`~/.config/rclone/rclone.conf`](file:///home/ashim3000/.config/rclone/rclone.conf)
- **Contents:**
  - `[drivemine]`: Google Drive OAuth credentials, client_id, client_secret, refresh_tokens.
  - `[opendrive]`: OpenDrive WebDAV credentials.
  - `[odrivecrypt]`: Rclone Crypt remote encrypting `opendrive:`. Contains obfuscated salt and passphrases.
  - `[gcrypt]`: Rclone Crypt remote encrypting `drivemine:`.
  - `[streamtape]`: Points to local AList WebDAV (`http://127.0.0.1:5244/dav/streamtape`, user: `admin`, pass: `rcloneflix`).
  - `[telegram-drive]`: Tokenized WebDAV link created by official Telegram-Drive desktop app (e.g. `http://127.0.0.1:8551/dav/<token>/`).
  - `[tg-serverless]`: WebDAV configuration for Cloudflare Worker gateway.
  - `[usenet-drive]`: Loopback WebDAV remote pointing to InfiniDysk engine (`http://127.0.0.1:8553/dav/`).
  - `[hetzner]`: Hetzner Storage Box WebDAV remote (`https://u717539.your-storagebox.de`, user `u717539`).
  - `[hcrypt]`: Rclone Crypt remote wrapping `hetzner:crypt` with client encryption.

### B. Telegram Session & Auth
- **Official Telegram Drive App Session:**
  - [`~/.local/share/com.cameronamer.telegramdrive/telegram.session`](file:///home/ashim3000/.local/share/com.cameronamer.telegramdrive/telegram.session) (SQLite DB containing DC options, auth keys, and chat hashes).
- **RcloneFlix Embedded Native Session (`tg-native:`):**
  - Imported into memory and cached in RcloneFlix data directory. Reads from desktop app session automatically if present.

### C. Application Database & Local Storage
- **Directory:** [`~/.local/share/com.rcloneflix.desktop/`](file:///home/ashim3000/.local/share/com.rcloneflix.desktop/)
  - [`library.db`](file:///home/ashim3000/.local/share/com.rcloneflix.desktop/library.db): Main SQLite database.
    - Tables: `media_items` (JSON blob metadata), `watch_progress` (resume timestamps), `playlists`, `favorites`, `meta`.
  - [`localstorage/tauri_localhost_0.localstorage`](file:///home/ashim3000/.local/share/com.rcloneflix.desktop/localstorage/tauri_localhost_0.localstorage): WebKitGTK SQLite database storing frontend `localStorage`.
    - Key `'rcloneflix-config'`: JSON object containing configured libraries (`Movies`, `TV Shows`, `Music`, `Audiobooks`, `Books`, `Comics`, `Adult`), remote paths, player settings, and preferences.
    - API Keys stored in localStorage:
      - `rcloneflix_omg_user` / `rcloneflix_omg_key`: OMGWTFNZBs indexer credentials.
      - `rcloneflix_arweave_jwk`: Arweave decentralized wallet key.
      - `rcloneflix_cf_worker_url` / `rcloneflix_cf_worker_master_key`: Cloudflare worker secrets.
      - `rcloneflix_udrop_config`: uDrop cyberlocker credentials.
  - [`alist_data/data.db`](file:///home/ashim3000/.local/share/com.rcloneflix.desktop/alist_data/data.db): AList SQLite configuration.
    - Table `x_storages`: Contains Streamtape API login (`8235aa313bbefbb97b32`) and API key.
  - [`usenet_config.json`](file:///home/ashim3000/.local/share/com.rcloneflix.desktop/usenet_config.json): NNTP provider server, port, username, password, and SSL flags.
  - [`rcloneflix-keys.json`](file:///home/ashim3000/.local/share/com.rcloneflix.desktop/rcloneflix-keys.json): Local master encryption keys.

---

## 4. Key Architectural Fixes & Optimization History (v1.0.2)

### 1. Streamtape Remote Playback & Watchdog Optimization (Resolved in v1.0.2)
- **Root Cause:** Streamtape enforces a 5s ticket delay (`/file/dlticket`), plus AList proxy buffering hops. The previous 10s HTML5 stall watchdog cancelled the stream right before first byte delivery.
- **Resolution:** Dynamic `stallTimeoutMs` grants 28s startup headroom to slow remotes (`streamtape`, `telegram`, `usenet-drive`, etc.) while keeping 10s for fast sources. In [`alist.rs`](file:///home/ashim3000/rcloneflix/src-tauri/src/commands/alist.rs), changed `webdav_policy` to `'302_redirect'` to drop the buffering proxy hop. Armed `sourceRef.current` and `localPathRef.current` in `VideoPlayerPage.tsx` so Cloud Explorer VLC fallback works reliably.

### 2. Telegram MTProto Streaming & Runaway Loop Prevention (Resolved in v1.0.2)
- **Throughput & Runaway Loop:** Increased `CHUNK_SIZE` from 64 KiB to 512 KiB in [`telegram.rs`](file:///home/ashim3000/rcloneflix/src-tauri/src/commands/telegram.rs), multiplying streaming throughput by 8x (~14–16 Mbps). Implemented bounded pipelined fetch (`mpsc::channel(4)`) with explicit `producer.abort()` when the HTTP client disconnects or seeks.

### 3. VFS Full-Cache Removal & Fast TTFB (Resolved in v1.0.2)
- **Root Cause:** `--vfs-cache-mode full` was re-introduced for colon remotes, forcing 16MB chunk downloads to local disk before serving the first byte.
- **Resolution:** Replaced with lightweight direct in-memory streaming flags (`--buffer-size 4M`, `--vfs-read-chunk-size 2M`, `--vfs-read-chunk-size-limit 64M`) in [`player.rs`](file:///home/ashim3000/rcloneflix/src-tauri/src/commands/player.rs).

### 4. InfiniDysk Usenet Suffix Range & Mount Persistence (Resolved in v1.0.2)
- **Resolution:** Fixed `bytes=-N` suffix ranges in [`usenet_dav.rs`](file:///home/ashim3000/rcloneflix/src-tauri/src/commands/usenet_dav.rs) so demuxers can read MP4 moov / MKV cues at file tail. Persisted virtual mounts across restarts to `~/.local/share/com.rcloneflix.desktop/usenet_mounts.json`. Fixed spread order in `InfiniDyskSearchModal.tsx`.

### 5. Whisper SMIL Spine Order & Anchored Matching (Resolved in v1.0.2)
- **Resolution:** Implemented `spine_ordered_html` reading OPF spine order instead of alphabetical globbing, and integrated `rapidfuzz` anchor matching in [`kaggle.rs`](file:///home/ashim3000/rcloneflix/src-tauri/src/commands/kaggle.rs) and [`.github/workflows/cloud_worker.yml`](file:///home/ashim3000/rcloneflix/.github/workflows/cloud_worker.yml). Ensured `mimetype` is stored uncompressed at archive head.

---

## 5. Build, Verification & Packaging Commands

```bash
# Type check and unit tests
cd /home/ashim3000/rcloneflix
npx tsc --noEmit
npm test

# Rust compilation check
cd /home/ashim3000/rcloneflix/src-tauri
cargo check

# Production build (.deb package)
cd /home/ashim3000/rcloneflix
npm run build
./scripts/build-deb.sh

# Install debian package locally
sudo dpkg -i src-tauri/target/release/bundle/deb/RcloneFlix_1.0.2_amd64.deb

# Copy to ChromeOS Downloads for external device distribution
cp src-tauri/target/release/bundle/deb/RcloneFlix_1.0.2_amd64.deb /mnt/chromeos/MyFiles/Downloads/
```
