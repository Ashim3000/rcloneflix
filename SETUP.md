# RcloneFlix — Setup, Build & Run Guide
## For Zorin OS 18 (Ubuntu 24.04 base)

---

## What's in This Build

This is the complete RcloneFlix app including:

- ✅ Setup wizard (rclone config import, API keys, library mapping, Google sign-in)
- ✅ Home screen with Continue Watching + Recently Added rows per library
- ✅ Full library pages with poster grids, search, sort
- ✅ Startup scan + manual scan with metadata fetching (TMDB, MusicBrainz, Open Library, ThePornDB)
- ✅ Fix incorrect match on any media item
- ✅ Video player (full-screen, keyboard shortcuts, seek, subtitles, progress saving)
- ✅ Audio mini-player bar (persists while browsing, for music & audiobooks)
- ✅ EPUB reader (dark/sepia/light themes, font size, page position saved)
- ✅ PDF reader (zoom, page navigation, position saved)
- ✅ Adult library PIN protection + hide from sidebar (Settings → Adult & Privacy)
- ✅ Settings page (API keys, library management, adult PIN, Google sync)
- ✅ Google OAuth scaffolding (requires your own Google Cloud client ID)

**Note on Google Sync:** The UI and OAuth flow are fully built. To activate it, you need to create a free Google Cloud project and add your Client ID to Settings. Instructions are at the bottom of this file.

---

## Step 1: Install System Dependencies

Open Terminal and run these commands in order.

### System libraries for Tauri

```bash
sudo apt update

sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

### libVLC (for video and audio playback)

```bash
sudo apt install -y \
  libvlc-dev \
  vlc \
  libvlccore-dev
```

### rclone

The `.deb` bundles rclone v1.73.1, so you do not need a system install to run the packaged
app. For development (`npm run tauri dev`) it falls back to whatever is on `PATH`:

```bash
sudo apt install -y rclone
```

If that gives an outdated version, use the official installer instead:
```bash
curl https://rclone.org/install.sh | sudo bash
```

Verify: `rclone version`

---

## Step 2: Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Press **Enter** to accept defaults. When finished:

```bash
source $HOME/.cargo/env
```

Verify: `rustc --version`

---

## Step 3: Install Node.js

The version in Zorin's software center is too old. Use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:
```bash
node --version   # Should be v20.x or higher
npm --version    # Should be 10.x or higher
```

---

## Step 4: Install project dependencies

Navigate to the rcloneflix folder and install:

```bash
cd rcloneflix
npm install
```

---

## Fetching the bundled rclone binary

`tauri.conf.json` ships `src-tauri/rclone` as a bundled resource so the packaged app does not
depend on a system install. The binary is not in git (76 MB), so fetch it once before your
first `tauri build`:

```bash
curl -fsSL -o /tmp/rclone.zip https://downloads.rclone.org/v1.73.1/rclone-v1.73.1-linux-amd64.zip
unzip -jo /tmp/rclone.zip '*/rclone' -d src-tauri/
chmod +x src-tauri/rclone
```

`npm run tauri dev` does not need this — it falls back to rclone on `PATH`.

---

## Step 5: Run in development mode

```bash
npm run tauri dev
```

This will:
1. Start the Vite dev server
2. Compile the Rust backend (first run takes 3–5 minutes)
3. Open the RcloneFlix window

---

## Step 6: Build the installable packages

When you're ready to build the final app:

```bash
npm run tauri build
```

This creates two packages in `src-tauri/target/release/bundle/`:

**`.deb` package** (recommended for Zorin OS):
```
src-tauri/target/release/bundle/deb/RcloneFlix_0.3.0_amd64.deb
```
Install it by double-clicking in Files, or via terminal:
```bash
sudo dpkg -i src-tauri/target/release/bundle/deb/RcloneFlix_0.3.0_amd64.deb
```

**`.AppImage`** (portable, no install needed):
```
src-tauri/target/release/bundle/appimage/RcloneFlix_0.3.0_amd64.AppImage
```
Make it executable and run:
```bash
chmod +x RcloneFlix_0.3.0_amd64.AppImage
./RcloneFlix_0.3.0_amd64.AppImage
```

---

## Getting Your API Keys

### TMDB (required for Movies & TV metadata)
1. Sign up free at https://www.themoviedb.org/signup
2. Go to Settings → API → Request an API Key → Developer
3. App name: RcloneFlix, use: Personal
4. Copy the **API Read Access Token** (the long JWT one, not the short key)
5. Paste into RcloneFlix during setup or Settings → API Keys

### ThePornDB (optional, Adult library only)
1. Sign up at https://theporndb.net/register
2. Go to Account Settings → API Key
3. Paste into RcloneFlix Settings → API Keys

### MusicBrainz, Open Library, Audnexus
No keys needed — built in, just work automatically.

---

## Setting Up Google Sync (Optional)

Google sync saves your watch progress and config to Google Drive.

1. Go to https://console.cloud.google.com
2. Create a new project called "RcloneFlix"
3. Go to APIs & Services → Enable APIs → enable **Google Drive API**
4. Go to APIs & Services → OAuth consent screen:
   - User type: External
   - App name: RcloneFlix
   - Add your email as a test user
5. Go to APIs & Services → Credentials → Create Credentials → OAuth Client ID:
   - Application type: Desktop app
   - Name: RcloneFlix
6. Copy the **Client ID**
7. In RcloneFlix → Settings → Account & Sync → paste your Client ID → click Sign in with Google

---

## Finding Your rclone Config File

On Zorin OS, your rclone config is at:
```
~/.config/rclone/rclone.conf
```

In the Files app: press **Ctrl+H** to show hidden files, then navigate to `.config/rclone/`.

---

## Keyboard Shortcuts (Video Player)

| Key | Action |
|-----|--------|
| Space or K | Play / Pause |
| → | Skip forward 10s |
| ← | Skip back 10s |
| F | Toggle fullscreen |
| M | Toggle mute |
| Escape | Leave fullscreen, or go back to the library |

**Audio & subtitle tracks.** The track selector appears only when playback has fallen back to
the native VLC engine (which happens automatically when the webview cannot decode the file,
e.g. HEVC video or AC3/DTS audio). WebKitGTK's HTML5 `<video>` provides no way to switch
tracks, so the menu is hidden on that path rather than shown as a control that does nothing.

---

## Troubleshooting

**"rclone not found":** Run `rclone version` in Terminal. If missing, re-run the install step.

**"libvlc not found" compile error:** Run `sudo apt install -y libvlc-dev vlc libvlccore-dev`

**Rust compile errors on first run:** Run `rustup update stable`

**Video won't play / blank screen:** Make sure rclone can access your remote — test with `rclone ls yourremote:` in Terminal.

**epub.js / pdf.js not loading:** Both are bundled locally — no internet connection needed.

**Video plays but there's no Audio & Subtitles button:** That button only appears on the
native VLC path. If the webview can decode the file itself, it plays through HTML5 `<video>`,
which cannot switch tracks.

**Secrets:** API keys and Google tokens live in the Tauri store under
`~/.local/share/com.rcloneflix.app/`, not in localStorage. They are not encrypted at rest —
treat that directory as sensitive.

**"No remotes found" after importing config:** Make sure you selected `~/.config/rclone/rclone.conf`. In Files, press Ctrl+H to see hidden folders.

**Streamtape / AList WebDAV Backend:**
AList v3.64.0+ is bundled headlessly to expose a high-performance Streamtape WebDAV backend on loopback `127.0.0.1:5244`.
- **Admin credentials**: Universal username `admin`, password `rcloneflix`.
- **Rclone remote**: Automatically created as `[streamtape]` pointing to `http://127.0.0.1:5244/dav/streamtape`.
- **Data directory**: Stored in `~/.local/share/com.rcloneflix.desktop/alist_data/`.
- **Configuration**: In RcloneFlix, navigate to **Settings → Streamtape & AList**, enter your Streamtape API Login ID and API Key, and toggle **Enable Streamtape CDN Offloading**.
- Full technical details: see [AList Streamtape Setup Guide](docs/ALIST_STREAMTAPE_SETUP_GUIDE.md).

---

## Project Structure

```
rcloneflix/
├── src/
│   ├── components/
│   │   ├── adult/         AdultPinLock.tsx
│   │   ├── audioplayer/   AudioMiniPlayer.tsx
│   │   ├── common/        ScanBar.tsx
│   │   ├── layout/        AppShell.tsx, Sidebar.tsx
│   │   ├── library/       MediaCard.tsx, MediaShelf.tsx, FixMatchModal.tsx
│   │   └── setup/         (5 setup wizard steps)
│   ├── lib/
│   │   ├── pin.ts          PIN hashing (SHA-256)
│   │   ├── scanner.ts      Scan orchestrator + metadata fetching
│   │   ├── secrets.ts      API keys / tokens via the Tauri store (not localStorage)
│   │   ├── streamtapeOffload.ts Streamtape CDN push and auto-offload poller
│   │   ├── sync.ts         Google Drive backup & restore (OAuth PKCE)
│   │   └── tauri.ts        Typed Tauri IPC wrappers
│   ├── pages/
│   │   ├── player/
│   │   │   ├── VideoPlayerPage.tsx
│   │   │   ├── EpubReaderPage.tsx
│   │   │   └── PdfReaderPage.tsx
│   │   ├── HomePage.tsx
│   │   ├── LibraryPage.tsx
│   │   ├── SettingsPage.tsx
│   │   └── SetupPage.tsx
│   └── store/
│       └── appStore.ts     Zustand store (config, media, progress, scan, adult)
│
└── src-tauri/
    └── src/
        └── commands/
            ├── alist.rs    Headless AList server lifecycle & Streamtape storage config
            ├── rclone.rs   Config parsing, file listing
            ├── scan.rs     File discovery, filename parsing
            ├── player.rs   rclone serve HTTP, stream sessions, libVLC control
            ├── google.rs   Google OAuth loopback listener
            └── store.rs    Key/secret storage (Tauri store — not encrypted at rest)
```
