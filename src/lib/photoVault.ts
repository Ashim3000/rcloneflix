/**
 * Photo Vault Manager for RcloneFlix.
 *
 * Provides high-speed retrieval, in-memory decryption, and disk caching
 * for photos stored on cloud remotes (with legacy Arweave fallback).
 */

import { type GalleryPhoto, isLocalPath } from "../store/appStore";
import {
  rcloneReadBytes,
  readLocalFileBytes,
  getCachedVaultPhoto,
  saveCachedVaultPhoto,
  prepareVaultPhoto,
  batchPrepareVaultPhotos,
  type VaultPhotoRequest,
} from "./tauri";
import { createDecryptedObjectUrl, decryptBytes } from "./crypto";
import { fetchEncryptedBytes } from "./arweave";

/**
 * In-memory LRU cache of decrypted photo object URLs:
 * cacheKey -> { objectUrl, lastAccessed }
 */
const decryptedUrlCache = new Map<string, { url: string; lastAccessed: number }>();
const MAX_CACHED_URLS = 60; // Keep up to 60 photos decrypted in RAM

const MAX_CONCURRENT_VAULT_OPS = 3;
let activeVaultOps = 0;
const vaultWaitQueue: Array<() => void> = [];

async function withVaultSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  if (activeVaultOps >= MAX_CONCURRENT_VAULT_OPS) {
    await new Promise<void>((resolve) => vaultWaitQueue.push(resolve));
  }
  activeVaultOps++;
  try {
    return await fn();
  } finally {
    activeVaultOps--;
    const next = vaultWaitQueue.shift();
    if (next) next();
  }
}

function evictOldestDecryptedUrls() {
  if (decryptedUrlCache.size <= MAX_CACHED_URLS) return;
  const entries = Array.from(decryptedUrlCache.entries()).sort(
    (a, b) => a[1].lastAccessed - b[1].lastAccessed
  );
  while (decryptedUrlCache.size > MAX_CACHED_URLS && entries.length > 0) {
    const [oldestId, item] = entries.shift()!;
    if (item.url.startsWith("blob:")) {
      URL.revokeObjectURL(item.url);
    }
    decryptedUrlCache.delete(oldestId);
  }
}

/**
 * Determine image MIME type from filename.
 */
export function mimeTypeFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/jpeg";
  }
}

function normalizeRemotePath(rawPath?: string, defaultRemote = "drivemine"): string {
  if (!rawPath) return "";
  const trimmed = rawPath.trim();
  if (isLocalPath(trimmed)) {
    return trimmed;
  }
  if (trimmed.includes(":")) {
    return trimmed;
  }
  return `${defaultRemote}:${trimmed.replace(/^\/+/, "")}`;
}

/**
 * Fetches encrypted bytes for a photo from local disk cache, cloud remote, or Arweave.
 */
async function fetchPhotoEncryptedBytes(
  photo: GalleryPhoto,
  configPath: string,
  cacheKey: string,
  forceOriginal: boolean,
  maxCacheMb = 200
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  // 1. Check local disk cache (check primary cacheKey and photo.id fallback)
  try {
    let localBytes = await getCachedVaultPhoto(cacheKey);
    if ((!localBytes || localBytes.length === 0) && cacheKey !== photo.id) {
      localBytes = await getCachedVaultPhoto(photo.id);
    }
    if (localBytes && localBytes.length > 0) {
      const mime = forceOriginal || photo.storageMode === "original"
        ? mimeTypeFromFilename(photo.filename)
        : "image/webp";
      return { bytes: localBytes, mimeType: mime };
    }
  } catch (err) {
    console.warn("Disk cache check failed:", err);
  }

  // 2. Fetch from cloud remote or Arweave
  let bytes: Uint8Array | null = null;
  let mimeType = "image/webp";

  const rawCandidatePaths: string[] = [];
  if (forceOriginal) {
    if (photo.remoteOriginalPath) rawCandidatePaths.push(photo.remoteOriginalPath);
    if (photo.remotePath) rawCandidatePaths.push(photo.remotePath);
    if (photo.remotePreviewPath) rawCandidatePaths.push(photo.remotePreviewPath);
  } else {
    if (photo.remotePreviewPath) rawCandidatePaths.push(photo.remotePreviewPath);
    if (photo.remotePath) rawCandidatePaths.push(photo.remotePath);
    if (photo.remoteOriginalPath) rawCandidatePaths.push(photo.remoteOriginalPath);
  }

  if (rawCandidatePaths.length > 0) {
    for (const rawPath of rawCandidatePaths) {
      const normalized = normalizeRemotePath(rawPath);
      try {
        bytes = await rcloneReadBytes(configPath, normalized);
        if (bytes && bytes.length > 0) {
          mimeType = forceOriginal || normalized.endsWith(".jpg.enc") || normalized.endsWith(".png.enc")
            ? mimeTypeFromFilename(photo.filename)
            : "image/webp";
          break;
        }
      } catch (readErr) {
        // If normalized failed and differs from raw, try raw directly
        if (normalized !== rawPath) {
          try {
            bytes = await rcloneReadBytes(configPath, rawPath);
            if (bytes && bytes.length > 0) {
              mimeType = forceOriginal || rawPath.endsWith(".jpg.enc") || rawPath.endsWith(".png.enc")
                ? mimeTypeFromFilename(photo.filename)
                : "image/webp";
              break;
            }
          } catch {}
        }
      }
    }
  }

  if ((!bytes || bytes.length === 0) && photo.arweaveId) {
    // Fallback to Arweave for legacy uploads
    try {
      bytes = await fetchEncryptedBytes(photo.arweaveId);
      mimeType = "image/webp";
    } catch {}
  }

  if (!bytes || bytes.length === 0) {
    throw new Error(`Unable to fetch photo bytes for ${photo.filename}`);
  }

  // 3. Save to local disk cache asynchronously
  saveCachedVaultPhoto(cacheKey, bytes, maxCacheMb).catch((err) => {
    console.warn("Failed saving photo to disk cache:", err);
  });

  return { bytes, mimeType };
}

/**
 * Loads and decrypts a photo in memory/disk, returning an asset or Blob URL.
 */
export async function loadAndDecryptVaultPhoto(
  photo: GalleryPhoto,
  configPath: string,
  pin: string,
  forceOriginal = false,
  maxCacheMb = 200
): Promise<string> {
  const cacheKey = forceOriginal ? `${photo.id}-orig` : photo.id;

  const cached = decryptedUrlCache.get(cacheKey);
  if (cached) {
    cached.lastAccessed = Date.now();
    return cached.url;
  }

  return withVaultSemaphore(async () => {
    const rawPath = forceOriginal
      ? (photo.remoteOriginalPath || photo.remotePath || photo.remotePreviewPath)
      : (photo.remotePreviewPath || photo.remotePath || photo.remoteOriginalPath);

    // 1. Direct local file rendering (convert local file bytes to instant Blob URL)
    if (rawPath && isLocalPath(rawPath)) {
      const cleanPath = rawPath.replace(/^file:\/\//, "");
      try {
        const bytes = await readLocalFileBytes(cleanPath);
        const ext = cleanPath.split(".").pop()?.toLowerCase() || "jpg";
        const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
        const blob = new Blob([bytes as any], { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);
        decryptedUrlCache.set(cacheKey, { url: objectUrl, lastAccessed: Date.now() });
        evictOldestDecryptedUrls();
        return objectUrl;
      } catch (localErr) {
        console.warn("Direct local file read failed, falling back to prepare:", localErr);
      }
    }

    const normalized = normalizeRemotePath(rawPath);

    // 2. Hardware-accelerated native Rust decryption and instant Blob URL
    try {
      const res = await prepareVaultPhoto(
        cacheKey,
        pin,
        normalized || undefined,
        configPath || undefined
      );
      if (res && res.bytes && res.bytes.length > 0) {
        const blob = new Blob([new Uint8Array(res.bytes)], { type: res.mime_type || "image/webp" });
        const objectUrl = URL.createObjectURL(blob);
        decryptedUrlCache.set(cacheKey, { url: objectUrl, lastAccessed: Date.now() });
        evictOldestDecryptedUrls();
        return objectUrl;
      }
    } catch (nativeErr) {
      console.warn("Native prepareVaultPhoto fallback:", nativeErr);
    }

    // 3. Cloud fetch fallback
    const { bytes, mimeType } = await fetchPhotoEncryptedBytes(
      photo,
      configPath,
      cacheKey,
      forceOriginal,
      maxCacheMb
    );

    // If this is a standard image (plain or transparently decrypted via Rclone crypt),
    // render directly via Blob URL without 100k PBKDF2 Web Crypto iterations!
    const isEncryptedContainer = rawPath?.endsWith(".enc") ||
      photo.remotePath?.endsWith(".enc") ||
      photo.remotePreviewPath?.endsWith(".enc") ||
      photo.remoteOriginalPath?.endsWith(".enc");

    if (!isEncryptedContainer) {
      const blob = new Blob([bytes as any], { type: mimeType });
      const objectUrl = URL.createObjectURL(blob);
      decryptedUrlCache.set(cacheKey, { url: objectUrl, lastAccessed: Date.now() });
      evictOldestDecryptedUrls();
      return objectUrl;
    }

    // Legacy fallback only for .enc files
    const objectUrl = await createDecryptedObjectUrl(bytes, pin, mimeType);
    decryptedUrlCache.set(cacheKey, { url: objectUrl, lastAccessed: Date.now() });
    evictOldestDecryptedUrls();

    return objectUrl;
  });
}

/**
 * Batch prepares a list of photos concurrently in native Rust background threads.
 * Warms up the disk cache so subsequent photo viewing is instantaneous.
 */
export async function batchPreparePhotos(
  photos: GalleryPhoto[],
  pin: string,
  configPath: string
): Promise<Record<string, string>> {
  try {
    const remotePhotos: GalleryPhoto[] = [];

    for (const p of photos) {
      const pPath = p.remotePreviewPath || p.remotePath;
      if (!pPath || !isLocalPath(pPath)) {
        remotePhotos.push(p);
      }
    }

    if (remotePhotos.length > 0) {
      const requests: VaultPhotoRequest[] = remotePhotos.map((p) => ({
        id: p.id,
        filename: p.filename,
        remote_path: p.remotePreviewPath ? normalizeRemotePath(p.remotePreviewPath) : undefined,
        storage_mode: p.storageMode,
        is_adult: p.isAdult,
      }));
      // Warm up Rust disk cache in background threads.
      // Do not store convertFileSrc URLs into decryptedUrlCache.
      return await batchPrepareVaultPhotos(requests, pin, configPath);
    }

    return {};
  } catch (err) {
    console.warn("batchPreparePhotos error:", err);
    return {};
  }
}

/**
 * Prefetch a photo into RAM in the background.
 */
export async function prefetchVaultPhoto(
  photo: GalleryPhoto,
  configPath: string,
  pin: string,
  forceOriginal = false,
  maxCacheMb = 200
): Promise<void> {
  const cacheKey = forceOriginal ? `${photo.id}-orig` : photo.id;
  if (decryptedUrlCache.has(cacheKey)) return;
  try {
    await loadAndDecryptVaultPhoto(photo, configPath, pin, forceOriginal, maxCacheMb);
  } catch (err) {
    console.warn("Background prefetch failed for photo", photo.id, err);
  }
}

/**
 * Decrypts and initiates download of a photo with its proper filename.
 */
export async function downloadDecryptedPhoto(
  photo: GalleryPhoto,
  configPath: string,
  pin: string,
  preferOriginal = true
): Promise<void> {
  const canGetOriginal = preferOriginal && !!(photo.remoteOriginalPath || photo.remotePath);
  const cacheKey = canGetOriginal ? `${photo.id}-orig` : photo.id;

  const { bytes, mimeType } = await fetchPhotoEncryptedBytes(
    photo,
    configPath,
    cacheKey,
    canGetOriginal
  );

  const activePath = canGetOriginal ? (photo.remoteOriginalPath || photo.remotePath) : (photo.remotePreviewPath || photo.remotePath);
  const isEncrypted = activePath?.endsWith(".enc");

  let decryptedBytes = bytes;
  if (isEncrypted) {
    decryptedBytes = await decryptBytes(bytes, pin);
  }

  // Auto-heal RIFF header if WebP
  if (
    decryptedBytes.length >= 12 &&
    decryptedBytes[0] === 0x52 &&
    decryptedBytes[1] === 0x49 &&
    decryptedBytes[2] === 0x46 &&
    decryptedBytes[3] === 0x46
  ) {
    const view = new DataView(
      decryptedBytes.buffer,
      decryptedBytes.byteOffset,
      decryptedBytes.byteLength
    );
    if (view.getUint32(4, true) === 0) {
      view.setUint32(4, decryptedBytes.byteLength - 8, true);
    }
  }

  const blob = new Blob([decryptedBytes as any], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const dlFilename = canGetOriginal
    ? photo.filename
    : photo.filename.replace(/\.[^/.]+$/, "") + ".webp";

  const a = document.createElement("a");
  a.href = url;
  a.download = dlFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Clears in-memory decrypted object URLs.
 */
export function clearVaultCache(): void {
  for (const item of decryptedUrlCache.values()) {
    if (item.url.startsWith("blob:")) {
      URL.revokeObjectURL(item.url);
    }
  }
  decryptedUrlCache.clear();
}
