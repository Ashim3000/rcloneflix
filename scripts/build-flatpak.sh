#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

CONFIG_ARGS=()
if [ -f "dist/index.html" ]; then
  echo "==> Existing dist/ detected, reusing built frontend..."
  CONFIG_ARGS+=("-c" '{"build":{"beforeBuildCommand":""}}')
fi

JOBS=${CARGO_BUILD_JOBS:-4}
echo "==> Building RcloneFlix Tauri release binary (jobs: $JOBS)..."
npx tauri build "${CONFIG_ARGS[@]}" --no-bundle -- --jobs "$JOBS"

echo "==> Building Flatpak application with flatpak-builder..."
flatpak-builder --disable-rofiles-fuse --force-clean flatpak/build-dir flatpak/com.rcloneflix.desktop.yml

echo "==> Exporting Flatpak repository..."
flatpak build-export flatpak/repo flatpak/build-dir

VERSION=$(node -p "require('./package.json').version")
OUTPUT_BUNDLE="RcloneFlix_${VERSION}.flatpak"

echo "==> Creating standalone Flatpak bundle: $OUTPUT_BUNDLE..."
flatpak build-bundle flatpak/repo "$OUTPUT_BUNDLE" com.rcloneflix.desktop

if [ -d "/mnt/chromeos/MyFiles/Downloads" ]; then
  echo "==> Copying $OUTPUT_BUNDLE to /mnt/chromeos/MyFiles/Downloads/..."
  cp "$OUTPUT_BUNDLE" "/mnt/chromeos/MyFiles/Downloads/$OUTPUT_BUNDLE"
fi

echo "==> Flatpak build complete: $OUTPUT_BUNDLE"
