# Packaging Handoff — 2026-11-14

**For the packaging agent.** All code is written, wired, `tsc --noEmit` clean, `cargo check` clean, and committed. Working tree is clean at `a347df0`. Your job is ONLY to build, verify, and copy packages. Do not modify source.

## What's in this release (6 commits since the last installed build)

| Commit | Change |
|---|---|
| `675dd31` | InfiniDysk: fast concurrent NZB mounting + category folder hierarchy (`usenet-drive:/TV Shows/...`); CBR 16-byte magic probe; MovieBite TV drill-down |
| `c9fd59b` | Music: visualizer accent-color fix, `animate-spin-slow` keyframes, Vinyl Mode needle-drop toggle, Liner Notes tab in Music Skin |
| `be03467` | Comics: progressive streaming for compressed CBRs (poll `comic_progressive_status`), page-fetch dedupe/parallelism |
| `73200a5` | TV: SubscribeModal (quality / release groups / source priority / conversion), InfiniDysk buttons on missing episodes & seasons |
| `90482b5` | GHA: per-job workflow-run correlation (no more false "failed" while runs execute) |
| `a347df0` | Music: disc-track filename parsing ("Album – 01-03 Title"), album sort tie-breaker, album-level Fix Match actually searches albums |

The audit log at the top of `docs/V1_0_3_FEATURE_AUDIT_AND_GAPS.md` has full root-cause details.

## Build sequence (sequential — they share cargo locks and dist/)

```bash
cd /home/ashim3000/rcloneflix
npm run build                 # frontend; must succeed before any bundle
./scripts/build-deb.sh
sudo dpkg -i src-tauri/target/release/bundle/deb/RcloneFlix_1.0.3_amd64.deb   # needs user's password
./scripts/build-flatpak.sh
./scripts/build-windows.sh    # NSIS .exe
./scripts/build-android.sh    # builds universal AND TV APKs
```

All finished artifacts go to `/mnt/chromeos/MyFiles/Downloads/` (the scripts mostly do this; verify and `cp` any that didn't).

## Android signing — MUST verify

- Release keystore is `android/rcloneflix-release.jks` + `android/key.properties` (both gitignored, already in place, chmod 600). `build.gradle` loads them automatically; do NOT touch the signing config.
- After building, verify BOTH APKs:
  ```bash
  apksigner verify --print-certs /mnt/chromeos/MyFiles/Downloads/RcloneFlix_1.0.3_universal.apk | head -3
  apksigner verify --print-certs /mnt/chromeos/MyFiles/Downloads/RcloneFlix_1.0.3_android_tv.apk | head -3
  ```
  Expected: Signer #1 `CN=RcloneFlix`, cert SHA-256 starting `440c7912`. Anything else (or a debug cert) = STOP, report, do not ship.
- `keytool -jarfile` prints nothing on these APKs (v2/v3 signatures) — that is normal; use `apksigner`.

## Hard rules

- **Never push to any git remote.** All work stays local (repo is being kept private for sale).
- Do not run `git checkout .`, `git clean`, `git stash`, or any history rewrite.
- Do not bump the version — this is still 1.0.3.
- If a build fails: capture the last ~50 log lines, stop, and report. Do not "fix" source files.
- Do not test with unbundled `cargo build` binaries (devUrl trap — see AGENTS.md §1.4).

## Post-build smoke checklist (desktop .deb, after install)

1. Comics: open a `.cbr` from drivemine → "Streaming comic archive — X% buffered…" → first pages within ~15 s.
2. Music: Ca$ino (Baby Keem) album lists tracks 01→10 in order; visualizer bars are gold, not black; album Fix Match returns albums ("Ca$ino · 11 tracks").
3. TV: Subscribe button opens the settings modal; missing-episode rows show an InfiniDysk button.
4. Dispatch a small GHA job: status should track its own run (check-mark only when THAT run finishes).
