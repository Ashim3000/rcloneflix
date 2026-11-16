#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "==> Building RcloneFlix for Windows (x86_64-pc-windows-gnu)..."

# Use safe job concurrency to protect against system memory pressure
JOBS=${CARGO_BUILD_JOBS:-4}

CONFIG_ARGS=("-c" "src-tauri/tauri.windows.conf.json")
if [ -f "dist/index.html" ]; then
  echo "==> Existing dist/ detected, reusing built frontend..."
  CONFIG_ARGS+=("-c" '{"build":{"beforeBuildCommand":""}}')
fi

npx tauri build \
  --target x86_64-pc-windows-gnu \
  --bundles nsis \
  "${CONFIG_ARGS[@]}" \
  -- --jobs "$JOBS"

VERSION=$(node -p "require('./package.json').version")
OUTPUT_SETUP="src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/RcloneFlix_${VERSION}_x64-setup.exe"

if [ -f "$OUTPUT_SETUP" ]; then
  if [ -d "/mnt/chromeos/MyFiles/Downloads" ]; then
    echo "==> Copying $OUTPUT_SETUP to /mnt/chromeos/MyFiles/Downloads/..."
    cp "$OUTPUT_SETUP" "/mnt/chromeos/MyFiles/Downloads/RcloneFlix_${VERSION}_x64-setup.exe"
  fi
  echo "==> Windows NSIS Installer built successfully: $OUTPUT_SETUP"
else
  echo "==> Error: Installer binary not found at $OUTPUT_SETUP"
  exit 1
fi
