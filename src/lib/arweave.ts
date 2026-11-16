/**
 * Arweave Turbo Client for RcloneFlix Photo Vault.
 *
 * Uploads client-side encrypted WebP photos (< 95 KB) to Arweave
 * via ArDrive Turbo at 100% zero cost (free tier <= 105 KB).
 *
 * Also provides retrieval and in-memory decryption helpers.
 */

import { TurboFactory } from "@ardrive/turbo-sdk/web";
import Arweave from "arweave/web";
import { invoke } from "@tauri-apps/api/core";
import { decryptBytes, createDecryptedObjectUrl } from "./crypto";

const JWK_STORAGE_KEY = "rcloneflix_arweave_jwk";
const PRIMARY_GATEWAY = "https://turbo-gateway.com";
const FALLBACK_GATEWAY = "https://arweave.net";

let cachedTurboClient: any = null;

/**
 * Retrieves the persisted Arweave JWK from localStorage, or generates a new one.
 */
async function getOrCreateJwk(): Promise<any> {
  const existing = localStorage.getItem(JWK_STORAGE_KEY);
  if (existing) {
    try {
      return JSON.parse(existing);
    } catch {
      // Corrupt, regenerate
    }
  }

  const arweave = Arweave.init({});
  const jwk = await arweave.wallets.generate();
  localStorage.setItem(JWK_STORAGE_KEY, JSON.stringify(jwk));
  return jwk;
}

const ROTATION_COUNT_KEY = "rcloneflix_arweave_rotation_count";
const MAX_WALLET_ROTATIONS = 3;

function getRotationCount(): number {
  const stored = localStorage.getItem(ROTATION_COUNT_KEY);
  return stored ? parseInt(stored, 10) || 0 : 0;
}

function incrementRotationCount(): number {
  const next = getRotationCount() + 1;
  localStorage.setItem(ROTATION_COUNT_KEY, next.toString());
  return next;
}

async function rotateJwk(): Promise<any> {
  const count = getRotationCount();
  if (count >= MAX_WALLET_ROTATIONS) {
    console.warn(`Maximum Arweave wallet rotations (${MAX_WALLET_ROTATIONS}) reached.`);
    return cachedTurboClient;
  }

  const arweave = Arweave.init({});
  const jwk = await arweave.wallets.generate();
  localStorage.setItem(JWK_STORAGE_KEY, JSON.stringify(jwk));
  incrementRotationCount();
  cachedTurboClient = TurboFactory.authenticated({ privateKey: jwk });
  return cachedTurboClient;
}

/**
 * Initializes or returns the authenticated Turbo client.
 * Automatically rotates wallet key if remaining free bytes fall below 200 KB (up to 3 rotations max).
 */
export async function getTurboClient(): Promise<any> {
  if (!cachedTurboClient) {
    const jwk = await getOrCreateJwk();
    cachedTurboClient = TurboFactory.authenticated({ privateKey: jwk });
  }

  try {
    const status = await cachedTurboClient.getFreeStatus();
    if (
      typeof status?.bytesRemaining === "number" &&
      status.bytesRemaining < 200_000 &&
      getRotationCount() < MAX_WALLET_ROTATIONS
    ) {
      return await rotateJwk();
    }
  } catch {
    // Non-blocking
  }

  return cachedTurboClient;
}

export interface ArweaveUploadResult {
  id: string;
  url: string;
  timestamp: number;
}

/**
 * Safely reads all bytes from a stream across both Node and browser environments,
 * handling stream-browserify, PassThrough, and Web ReadableStream without relying on Symbol.asyncIterator.
 */
async function readStreamToUint8Array(stream: any): Promise<Uint8Array> {
  if (stream instanceof Uint8Array) {
    return stream;
  }
  if (stream && stream.buffer instanceof ArrayBuffer) {
    return new Uint8Array(stream.buffer, stream.byteOffset, stream.byteLength);
  }

  const chunks: Uint8Array[] = [];

  if (stream && typeof stream.on === "function") {
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: any) => {
        chunks.push(new Uint8Array(chunk));
      });
      stream.on("end", () => resolve());
      stream.on("error", (err: any) => reject(err));
    });
  } else if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(new Uint8Array(value));
    }
  } else if (
    stream &&
    typeof Symbol !== "undefined" &&
    Symbol.asyncIterator &&
    typeof stream[Symbol.asyncIterator] === "function"
  ) {
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const nextRes = await iterator.next();
      if (nextRes.done) break;
      if (nextRes.value) chunks.push(new Uint8Array(nextRes.value));
    }
  } else if (
    stream &&
    typeof Symbol !== "undefined" &&
    Symbol.iterator &&
    typeof stream[Symbol.iterator] === "function"
  ) {
    for (const chunk of stream) {
      chunks.push(new Uint8Array(chunk));
    }
  } else {
    throw new Error("Unable to read stream: unrecognized stream format");
  }

  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Uploads encrypted photo bytes to Arweave using Turbo's free tier.
 * Signs the ANS-104 DataItem client-side and dispatches raw binary via native Rust
 * to bypass WebKitGTK browser CORS restrictions.
 */
export async function uploadEncryptedPhotoToArweave(
  encryptedBytes: Uint8Array,
  filename?: string
): Promise<ArweaveUploadResult> {
  if (encryptedBytes.length > 95_000) {
    throw new Error(
      `Photo payload (${Math.round(encryptedBytes.length / 1024)} KB) exceeds the 95 KB Arweave free tier cutoff.`
    );
  }

  const turbo = await getTurboClient();

  const tags = [
    { name: "App-Name", value: "RcloneFlix-Photo-Vault" },
    { name: "Content-Type", value: "application/octet-stream" },
    { name: "Vault-Type", value: "AES-256-GCM" },
  ];

  if (filename) {
    tags.push({ name: "File-Name", value: filename });
  }

  // Sign the ANS-104 DataItem in JS
  const buffer = Buffer.from(encryptedBytes.buffer, encryptedBytes.byteOffset, encryptedBytes.byteLength);
  const signed = await turbo.signer.signDataItem({
    fileStreamFactory: () => buffer,
    fileSizeFactory: () => buffer.length,
    dataItemOpts: { tags },
  });

  const stream = signed.dataItemStreamFactory();
  const signedBytes = await readStreamToUint8Array(stream);

  // Post binary data item via native Rust reqwest client (bypasses WebKit CORS)
  const res = await invoke<{ id: string; timestamp?: number; winc?: string }>(
    "arweave_post_data_item",
    { bytes: Array.from(signedBytes) }
  );

  return {
    id: res.id,
    url: `${PRIMARY_GATEWAY}/${res.id}`,
    timestamp: res.timestamp || Date.now(),
  };
}

/**
 * In-memory LRU cache of decrypted photo object URLs:
 * photoId -> { objectUrl, lastAccessed }
 */
const decryptedUrlCache = new Map<string, { url: string; lastAccessed: number }>();
const MAX_CACHED_URLS = 60; // Keep up to 60 photos decrypted in RAM

function evictOldestDecryptedUrls() {
  if (decryptedUrlCache.size <= MAX_CACHED_URLS) return;
  const entries = Array.from(decryptedUrlCache.entries()).sort(
    (a, b) => a[1].lastAccessed - b[1].lastAccessed
  );
  while (decryptedUrlCache.size > MAX_CACHED_URLS && entries.length > 0) {
    const [oldestId, item] = entries.shift()!;
    URL.revokeObjectURL(item.url);
    decryptedUrlCache.delete(oldestId);
  }
}

/**
 * Fetches raw encrypted bytes from Arweave gateways via native Rust with browser fallback.
 */
export async function fetchEncryptedBytes(arweaveId: string): Promise<Uint8Array> {
  try {
    const bytes = await invoke<number[]>("arweave_fetch_bytes", { arweaveId });
    return new Uint8Array(bytes);
  } catch (nativeErr) {
    console.warn("Native arweave_fetch_bytes failed, trying fallback:", nativeErr);
    const urls = [
      `${PRIMARY_GATEWAY}/${arweaveId}`,
      `${FALLBACK_GATEWAY}/${arweaveId}`,
    ];

    let lastError: any = null;
    for (const url of urls) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          return new Uint8Array(buf);
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(`Failed to fetch photo from Arweave gateways: ${nativeErr || lastError?.message || "Unknown error"}`);
  }
}

/**
 * Fetches an encrypted photo from Arweave, decrypts it in RAM,
 * caches the Object URL, and returns the viewable URL.
 */
export async function loadAndDecryptPhoto(
  photoId: string,
  arweaveId: string,
  pin: string
): Promise<string> {
  const cached = decryptedUrlCache.get(photoId);
  if (cached) {
    cached.lastAccessed = Date.now();
    return cached.url;
  }

  const encryptedBytes = await fetchEncryptedBytes(arweaveId);
  const objectUrl = await createDecryptedObjectUrl(encryptedBytes, pin, "image/webp");

  decryptedUrlCache.set(photoId, { url: objectUrl, lastAccessed: Date.now() });
  evictOldestDecryptedUrls();
  return objectUrl;
}

/**
 * Pre-fetches and decrypts a photo in the background into memory.
 */
export async function prefetchPhoto(
  photoId: string,
  arweaveId: string,
  pin: string
): Promise<void> {
  if (decryptedUrlCache.has(photoId)) return;
  try {
    await loadAndDecryptPhoto(photoId, arweaveId, pin);
  } catch (err) {
    console.warn("Background prefetch failed for photo", photoId, err);
  }
}

/**
 * Clears all in-memory decrypted object URLs (e.g. when locking adult vault or closing gallery).
 */
export function clearDecryptedCache(): void {
  for (const item of decryptedUrlCache.values()) {
    URL.revokeObjectURL(item.url);
  }
  decryptedUrlCache.clear();
}
