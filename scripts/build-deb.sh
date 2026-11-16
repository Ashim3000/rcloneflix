#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "==> Building RcloneFlix Debian package (.deb)..."

JOBS=${CARGO_BUILD_JOBS:-4}

CONFIG_ARGS=()
if [ -f "dist/index.html" ]; then
  echo "==> Existing dist/ detected, reusing built frontend..."
  CONFIG_ARGS+=("-c" '{"build":{"beforeBuildCommand":""}}')
fi

npx tauri build \
  "${CONFIG_ARGS[@]}" \
  --bundles deb \
  -- --jobs "$JOBS"

VERSION=$(node -p "require('./package.json').version")
OUTPUT_DEB="src-tauri/target/release/bundle/deb/RcloneFlix_${VERSION}_amd64.deb"

if [ -f "$OUTPUT_DEB" ]; then
  if [ -d "/mnt/chromeos/MyFiles/Downloads" ]; then
    echo "==> Copying $OUTPUT_DEB to /mnt/chromeos/MyFiles/Downloads/..."
    cp "$OUTPUT_DEB" "/mnt/chromeos/MyFiles/Downloads/rcloneflix_${VERSION}_amd64.deb"
    cp "$OUTPUT_DEB" "/mnt/chromeos/MyFiles/Downloads/RcloneFlix_${VERSION}_amd64.deb"
  fi
  echo "==> Installing Debian package locally..."
  sudo dpkg -i "$OUTPUT_DEB" || true
  echo "==> Debian package built and installed successfully: $OUTPUT_DEB"
else
  echo "==> Error: Debian package not found at $OUTPUT_DEB"
  exit 1
fi
