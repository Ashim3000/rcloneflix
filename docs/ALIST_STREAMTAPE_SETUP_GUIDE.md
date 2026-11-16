# AList Bundling & Streamtape Storage Setup Guide

This guide documents the headless **AList v3.64.0+** bundling, database lifecycle, and **Streamtape WebDAV CDN backend** implementation in **RcloneFlix**.

---

## 1. Overview & Architecture

### The Problem
* **Primary Cloud Remote Throttling**: Streaming high-bitrate video directly from primary cloud providers (OpenDrive, Google Drive, OneDrive) rapidly triggers API rate-limits, daily download bandwidth quotas, or account bans.
* **No Native Rclone Driver**: Rclone lacks a native storage backend for Streamtape.
* **Duplicate Library Clutter**: Storing backup or offloaded copies across multiple remotes normally creates duplicate cards in media libraries.

### The Solution
1. **AList WebDAV Bridge**: AList is bundled as a silent, headless sidecar binary bound strictly to localhost loopback (`127.0.0.1:5244`). It provides an official `Streamtape` storage driver that translates Streamtape API calls and chunks into WebDAV endpoints.
2. **Native Rclone Integration**: Rclone connects to AList via a standard `type = webdav` remote named `[streamtape]`.
3. **Plex-Style Multi-Version Grouping**: Media items with a Streamtape copy are deduplicated under a single UI card with a strict playback hierarchy:
   $$\text{Local Storage (Priority 1)} \longrightarrow \text{Streamtape CDN (Priority 2)} \longrightarrow \text{Cloud Master Remote (Priority 3)}$$

```
┌────────────────────────────────────────────────────────┐
│                      RcloneFlix                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │                Frontend UI / VLC                  │  │
│  │   Play: Streamtape CDN (Priority 2, Zero Quota)  │  │
│  └─────────────────────────┬────────────────────────┘  │
│                            │                            │
│                            ▼                            │
│  ┌──────────────────────────────────────────────────┐  │
│  │                  Rclone Core                     │  │
│  │             Remote: [streamtape]                 │  │
│  └─────────────────────────┬────────────────────────┘  │
│                            │ WebDAV                     │
│                            ▼ (http://127.0.0.1:5244)   │
│  ┌──────────────────────────────────────────────────┐  │
│  │          Headless AList Sidecar Daemon           │  │
│  │        Driver: Streamtape (native_proxy)         │  │
│  │        Admin: admin / rcloneflix                 │  │
│  └─────────────────────────┬────────────────────────┘  │
└────────────────────────────┼───────────────────────────┘
                             │ HTTPS API / Chunks
                             ▼
                    Streamtape Cloud CDN
```

---

## 2. Bundled Binaries & Packaging

### Binary Version Requirements
* **AList Version**: **v3.64.0+** (Official Streamtape driver was introduced in **v3.58.0**; older versions return `driver [Streamtape] not found`).
* **Linux Binary**: `src-tauri/alist` (64-bit ELF, executable permissions `chmod +x`).
* **Windows Binary**: `src-tauri/alist.exe` (PE32+ 64-bit executable).

### Packaging Configurations
1. **Tauri Resources (`tauri.conf.json`)**:
   ```json
   "resources": [
     "rclone",
     "alist"
   ]
   ```
2. **Windows Tauri Config (`tauri.windows.conf.json`)**:
   ```json
   "resources": [
     "rclone.exe",
     "alist.exe",
     "libvlc.dll",
     "libvlccore.dll",
     "plugins/**/*"
   ]
   ```
3. **Flatpak Manifest (`flatpak/com.rcloneflix.desktop.yml`)**:
   ```yaml
   - name: rcloneflix
     buildsystem: simple
     build-commands:
       - install -Dm755 rcloneflix /app/bin/rcloneflix
       - install -Dm755 rclone /app/bin/rclone
       - install -Dm755 alist /app/bin/alist
       - install -Dm644 com.rcloneflix.desktop.desktop /app/share/applications/com.rcloneflix.desktop.desktop
       - install -Dm644 com.rcloneflix.desktop.png /app/share/icons/hicolor/256x256/apps/com.rcloneflix.desktop.png
     sources:
       - type: file
         path: ../src-tauri/target/release/rcloneflix
       - type: file
         path: /usr/bin/rclone
       - type: file
         path: ../src-tauri/alist
       - type: file
         path: com.rcloneflix.desktop.desktop
       - type: file
         path: com.rcloneflix.desktop.png
   ```

### Binary Resolution Logic (`src-tauri/src/commands/alist.rs`)
The Rust helper `alist_binary(app: &AppHandle)` searches in this deterministic order:
1. Bundled Tauri application resource directory (`resource_dir.join("alist" | "alist.exe")`).
2. Flatpak runtime path (`/app/bin/alist`).
3. Local development directory (`src-tauri/alist` or `src-tauri/alist.exe`).
4. System `PATH` fallback (`"alist"` or `"alist.exe"`).

---

## 3. Data Directory Isolation & Configuration

### Data Directory Location
To prevent polluting user home directories with runtime files, AList runs entirely inside an isolated app data directory:
* **Linux**: `~/.local/share/com.rcloneflix.desktop/alist_data/`
* **Windows**: `%APPDATA%\com.rcloneflix.desktop\alist_data\`

### Absolute Paths in `config.json`
AList requires explicit absolute paths in `config.json` for database and log locations. If relative paths are used, AList resolves them relative to the current working directory (`CWD`), which can cause database fragmentation and unauthenticated 403 errors.

The `ensure_alist_config(data_dir: &Path)` function generates and validates `config.json` with absolute paths:
```json
{
  "force": false,
  "site_url": "",
  "cdn": "",
  "jwt_secret": "rcloneflix_alist_internal_secret",
  "token_expires_in": 72,
  "database": {
    "type": "sqlite3",
    "host": "",
    "port": 0,
    "user": "",
    "password": "",
    "name": "",
    "db_file": "/home/user/.local/share/com.rcloneflix.desktop/alist_data/data.db",
    "table_prefix": "x_",
    "ssl_mode": ""
  },
  "scheme": {
    "address": "127.0.0.1",
    "http_port": 5244,
    "https_port": -1,
    "force_https": false,
    "cert_file": "",
    "key_file": ""
  },
  "temp_dir": "/home/user/.local/share/com.rcloneflix.desktop/alist_data/temp",
  "bleve_dir": "/home/user/.local/share/com.rcloneflix.desktop/alist_data/bleve",
  "log": {
    "enable": true,
    "name": "/home/user/.local/share/com.rcloneflix.desktop/alist_data/log/log.log",
    "max_size": 10,
    "max_backups": 3,
    "max_age": 7,
    "compress": false
  },
  "max_connections": 0,
  "tls_insecure_skip_verify": true
}
```

Additionally, all process invocations (`admin set` and `server`) explicitly bind the working directory:
```rust
cmd.current_dir(&data_dir);
```

---

## 4. Universal Admin Credentials & Authentication

### Universal Admin Password
* **Username**: `admin`
* **Password**: `rcloneflix`
* **Initialization**: Automatically run via CLI before launching the daemon:
  ```bash
  alist admin set rcloneflix --data ~/.local/share/com.rcloneflix.desktop/alist_data
  ```
  This command initializes `data.db`, creates all internal tables (`x_users`, `x_storages`, `x_settings`), and ensures the password is unconditionally set to `rcloneflix`.

### Rclone Password Obfuscation
In rclone configuration files, passwords cannot be stored in plaintext. The universal password `rcloneflix` is obfuscated via `rclone obscure rcloneflix`:
```ini
pass = DX7ZUA9B10vScxTPS9Q57GzeK8R4Ojq71HI
```
*(Decodes directly to `rcloneflix`).*

---

## 5. Streamtape Storage Driver Setup (SQLite `x_storages`)

The Streamtape driver is registered directly in AList's SQLite database (`data.db`) inside table `x_storages`, according to the [AList Streamtape Driver Specification](https://alistgo.com/guide/drivers/streamtape.html).

### SQLite Insert Query
```sql
INSERT INTO x_storages (
    mount_path, "order", driver, cache_expiration, status, addition, remark,
    disabled, enable_sign, extract_folder, web_proxy, webdav_policy, down_proxy_sign
) VALUES (
    '/streamtape', 0, 'Streamtape', 30, 'work', ?1, 'Streamtape CDN Edge Cache',
    0, 0, 'front', 1, 'native_proxy', 0
) ON CONFLICT(mount_path) DO UPDATE SET
    driver = 'Streamtape',
    addition = excluded.addition,
    disabled = 0,
    enable_sign = 0,
    extract_folder = 'front',
    web_proxy = 1,
    webdav_policy = 'native_proxy',
    down_proxy_sign = 0,
    status = 'work';
```

### Key Directives & Column Mapping
| Parameter / Column | Setting | Purpose |
|---|---|---|
| `mount_path` | `/streamtape` | Mount path inside AList WebDAV hierarchy (`/dav/streamtape`). |
| `driver` | `'Streamtape'` | Official AList Streamtape driver (requires v3.58.0+). |
| `webdav_policy` | `'native_proxy'` | Routes WebDAV reads through AList's streaming proxy to prevent CORS and 302 client redirect failures. |
| `down_proxy_sign` | `0` (Off) | Disables downstream URL signatures on proxied streams. |
| `extract_folder` | `'front'` | Sets directory extraction order to front for instant folder indexing. |
| `enable_sign` | `0` (Off) | Prevents token signing overhead on loopback transfers. |
| `web_proxy` | `1` (Enabled) | Ensures media data is fetched via proxy buffers. |
| `status` | `'work'` | Active storage state. |
| `disabled` | `0` | Storage enabled. |

### Addition JSON Payload (`addition`)
```json
{
  "root_folder_id": "0",
  "api_login": "<STREAMTAPE_API_LOGIN>",
  "api_key": "<STREAMTAPE_API_KEY>",
  "enable_range_control": true,
  "range_mode": "chunk",
  "range_chunk_mb": 8,
  "range_concurrency": 4
}
```
* **Range Control**: Streamtape connections often choke when video players request multiple tiny non-sequential byte ranges. Setting `enable_range_control: true` with `chunk` mode (8 MB chunks, 4 concurrency) reshapes incoming HTTP range requests for ultra-smooth playback and seeking.

---

## 6. Rclone WebDAV Remote Configuration

The `[streamtape]` remote block is automatically injected into the user's active `rclone.conf` (as well as standard OS default paths) via `ensure_streamtape_rclone_remote()`:

```ini
[streamtape]
type = webdav
url = http://127.0.0.1:5244/dav/streamtape
vendor = other
user = admin
pass = DX7ZUA9B10vScxTPS9Q57GzeK8R4Ojq71HI
```

### URL Structure Note
* When `url = http://127.0.0.1:5244/dav/streamtape`, accessing `streamtape:` directly navigates the root of the Streamtape account without needing an extra `/streamtape` path prefix.

---

## 7. Frontend User Flow & Settings

### Settings Page (`Settings -> Streamtape & AList`)
1. **Enable Streamtape CDN Offloading**: Toggles daemon startup and playback version routing.
2. **Streamtape API Login & API Key**: User obtains their credentials from [streamtape.com/acc_details](https://streamtape.com/acc_details).
3. **Save & Connect**:
   - Updates `streamtapeConfig` in the store.
   - Invokes Tauri command `start_alist_daemon` with credentials.
   - Configures SQLite `data.db`, injects `rclone.conf`, and launches the daemon.
   - Live status indicator confirms: `"Streamtape WebDAV mounted at /streamtape · rclone [streamtape] ready"`.
4. **Auto-Offload**:
   - When enabled, runs background sync sessions (`runAutoStreamtapeOffload(60)`).
   - Offloads newest movies and episodes up to 1 hour per session with single-transfer concurrency to safeguard cloud quotas.

### Media Detail Page (`MediaDetailPage.tsx`)
* **"Push to Streamtape" Button**: Instantly copies the cloud remote video to `streamtape:Movies/` or `streamtape:TV/` via background `rclone copy`.
* **"Streamtape Cached" Badge**: Appears when a Streamtape CDN copy is available.
* **Version Switcher**: Allows the user to toggle between Streamtape CDN, Local Storage, or Cloud Remotes on demand.

### Automated App Startup Hook (`App.tsx` & `streamtapeOffload.ts`)
When the app launches, `initStreamtapeOffloaderPoller()` inspects `streamtapeConfig`. If offloading is enabled with valid credentials, it automatically launches `start_alist_daemon` silently so Cloud Explorer and playback are functional without opening the Settings page.

---

## 8. Diagnostics & Verification

### 1. Verifying AList Daemon via CLI
Test whether AList is running on port 5244:
```bash
curl -s http://127.0.0.1:5244/api/public/settings | grep -i "version"
```

### 2. Verifying Rclone WebDAV Connection
Test directory listing directly through the WebDAV bridge:
```bash
rclone lsjson streamtape: --config ~/.config/rclone/rclone.conf
```
* **Success**: Returns a JSON array of files stored on Streamtape (`[{"Path":"video.mp4","Size":12345678,...}]`).
* **Error `403 Forbidden`**: Indicates either password mismatch (`pass` not matching `rcloneflix`) or an empty database with no storage mounted.
* **Error `404 Not Found`**: Indicates the mount path in `x_storages` is not `/streamtape`.

### 3. Inspecting the AList SQLite Database
Run this python command to verify internal storage settings:
```bash
python3 -c "
import sqlite3
conn = sqlite3.connect('$HOME/.local/share/com.rcloneflix.desktop/alist_data/data.db')
c = conn.cursor()
c.execute('SELECT mount_path, driver, status, webdav_policy, extract_folder, enable_sign, down_proxy_sign FROM x_storages;')
print(c.fetchall())
"
```
**Expected Output:**
```python
[('/streamtape', 'Streamtape', 'work', 'native_proxy', 'front', 0, 0)]
```
