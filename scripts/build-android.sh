#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "==> Building RcloneFlix Android & Android TV APKs..."

echo "==> Building frontend web assets..."
npm run build

echo "==> Syncing web assets with Capacitor Android..."
npx cap sync android

VERSION=$(node -p "require('./package.json').version")
OUTPUT_DIR="/mnt/chromeos/MyFiles/Downloads"
mkdir -p "$OUTPUT_DIR"

cd "$PROJECT_ROOT/android"

# Step 1: Universal / Phone APK build
echo "==> [1/2] Building Universal Android Release APK (version $VERSION)..."
./gradlew assembleRelease

OUTPUT_APK="$PROJECT_ROOT/android/app/build/outputs/apk/release/app-release.apk"
if [ -f "$OUTPUT_APK" ]; then
  echo "==> Universal APK built successfully."
  cp "$OUTPUT_APK" "$OUTPUT_DIR/RcloneFlix_${VERSION}_universal.apk"
  cp "$OUTPUT_APK" "$OUTPUT_DIR/RcloneFlix_${VERSION}_android.apk"
  echo "==> Saved: RcloneFlix_${VERSION}_universal.apk and RcloneFlix_${VERSION}_android.apk"
else
  echo "==> Error: Output APK not found at $OUTPUT_APK"
  exit 1
fi

# Step 2: Dedicated Android TV APK build (strict leanback required & sensorLandscape)
echo "==> [2/2] Building Dedicated Android TV Release APK (version ${VERSION}-tv)..."
MANIFEST="$PROJECT_ROOT/android/app/src/main/AndroidManifest.xml"
BUILD_GRADLE="$PROJECT_ROOT/android/app/build.gradle"

cp "$MANIFEST" "${MANIFEST}.bak"
cp "$BUILD_GRADLE" "${BUILD_GRADLE}.bak"

cleanup() {
  if [ -f "${MANIFEST}.bak" ]; then
    mv -f "${MANIFEST}.bak" "$MANIFEST"
  fi
  if [ -f "${BUILD_GRADLE}.bak" ]; then
    mv -f "${BUILD_GRADLE}.bak" "$BUILD_GRADLE"
  fi
}
trap cleanup EXIT

# Configure for Android TV
sed -i 's/android:name="android.software.leanback"[[:space:]]*android:required="false"/android:name="android.software.leanback" android:required="true"/' "$MANIFEST"
sed -i 's/android:name="\.MainActivity"/android:name=".MainActivity"\n            android:screenOrientation="sensorLandscape"/' "$MANIFEST"
sed -i "s/versionName \"${VERSION}\"/versionName \"${VERSION}-tv\"/" "$BUILD_GRADLE"

./gradlew clean assembleRelease

if [ -f "$OUTPUT_APK" ]; then
  echo "==> Android TV APK built successfully."
  cp "$OUTPUT_APK" "$OUTPUT_DIR/RcloneFlix_${VERSION}_android_tv.apk"
  echo "==> Saved: RcloneFlix_${VERSION}_android_tv.apk"
else
  echo "==> Error: Android TV APK not found at $OUTPUT_APK"
  exit 1
fi

echo "==> All Android packages built and saved successfully!"
