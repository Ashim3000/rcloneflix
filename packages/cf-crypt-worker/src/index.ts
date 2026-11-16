/**
 * RcloneFlix Serverless Crypt & Direct Stream Proxy (Cloudflare Worker)
 *
 * Implements the official rclone crypt file format (NaCl SecretBox XSalsa20-Poly1305):
 *   - 32-byte file header: "RCLONE\x00\x00" (8 bytes) + 24-byte random fileNonce
 *   - Encrypted blocks: 65,552 bytes each = 16-byte Poly1305 MAC + up to 65,536-byte XSalsa20 ciphertext
 *   - Per-block nonce: 24-byte fileNonce incremented little-endian by blockIndex (0, 1, 2, ...)
 */

export interface Env {
  MASTER_KEY_HEX: string; // 64-char hex string (32 bytes) for AES-256-GCM token decryption
}

interface StreamTokenPayload {
  /** Direct HTTP/HTTPS URL to the encrypted (or unencrypted) file on cloud storage */
  originUrl: string;
  /** Optional custom HTTP headers needed by origin (e.g. Authorization for WebDAV/OneDrive) */
  originHeaders?: Record<string, string>;
  /** True if the origin file is encrypted with rclone crypt */
  isCrypt: boolean;
  /** 64-char hex string (32 bytes) representing the rclone crypt NaCl SecretBox dataKey */
  dataKeyHex?: string;
  /** Optional known cleartext size in bytes */
  cleartextSize?: number;
  /** Optional MIME type override (e.g. "video/mp4", "video/x-matroska") */
  mimeType?: string;
  /** Filename for Content-Disposition */
  filename?: string;
  /** Expiration timestamp (Unix seconds) */
  exp: number;
}

const RCLONE_MAGIC = new Uint8Array([0x52, 0x43, 0x4c, 0x4f, 0x4e, 0x45, 0x00, 0x00]); // "RCLONE\0\0"
const RCLONE_HEADER_SIZE = 32;
const BLOCK_DATA_SIZE = 65536; // 64 KiB cleartext per block
const BLOCK_TAG_SIZE = 16;     // 16-byte Poly1305 authenticator tag
const BLOCK_ENC_SIZE = BLOCK_DATA_SIZE + BLOCK_TAG_SIZE; // 65,552 bytes per encrypted block

// In-memory isolate cache for 24-byte file nonces and encrypted file sizes
const headerNonceCache = new Map<string, { nonce: Uint8Array; encSize: number }>();

// ============================================================================
// 1. PURE-TYPESCRIPT NaCl SecretBox (XSalsa20-Poly1305) IMPLEMENTATION
// ============================================================================

function rotl32(x: number, b: number): number {
  return ((x << b) | (x >>> (32 - b))) >>> 0;
}

function load32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      (buf[offset + 3] << 24)) >>>
    0
  );
}

function store32LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

const SIGMA = new Uint8Array([
  101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107,
]); // "expand 32-byte k"

/**
 * HSalsa20 core function: derives a 32-byte subkey from a 32-byte key and 16-byte nonce prefix.
 */
function hsalsa20(key: Uint8Array, nonce16: Uint8Array): Uint8Array {
  let x0 = load32LE(SIGMA, 0);
  let x1 = load32LE(key, 0);
  let x2 = load32LE(key, 4);
  let x3 = load32LE(key, 8);
  let x4 = load32LE(key, 12);
  let x5 = load32LE(SIGMA, 4);
  let x6 = load32LE(nonce16, 0);
  let x7 = load32LE(nonce16, 4);
  let x8 = load32LE(nonce16, 8);
  let x9 = load32LE(nonce16, 12);
  let x10 = load32LE(SIGMA, 8);
  let x11 = load32LE(key, 16);
  let x12 = load32LE(key, 20);
  let x13 = load32LE(key, 24);
  let x14 = load32LE(key, 28);
  let x15 = load32LE(SIGMA, 12);

  for (let i = 0; i < 20; i += 2) {
    // Column round
    x4 ^= rotl32((x0 + x12) >>> 0, 7);
    x8 ^= rotl32((x4 + x0) >>> 0, 9);
    x12 ^= rotl32((x8 + x4) >>> 0, 13);
    x0 ^= rotl32((x12 + x8) >>> 0, 18);

    x9 ^= rotl32((x5 + x1) >>> 0, 7);
    x13 ^= rotl32((x9 + x5) >>> 0, 9);
    x1 ^= rotl32((x13 + x9) >>> 0, 13);
    x5 ^= rotl32((x1 + x13) >>> 0, 18);

    x14 ^= rotl32((x10 + x6) >>> 0, 7);
    x2 ^= rotl32((x14 + x10) >>> 0, 9);
    x6 ^= rotl32((x2 + x14) >>> 0, 13);
    x10 ^= rotl32((x6 + x2) >>> 0, 18);

    x3 ^= rotl32((x15 + x11) >>> 0, 7);
    x7 ^= rotl32((x3 + x15) >>> 0, 9);
    x11 ^= rotl32((x7 + x3) >>> 0, 13);
    x15 ^= rotl32((x11 + x7) >>> 0, 18);

    // Diagonal round
    x1 ^= rotl32((x0 + x3) >>> 0, 7);
    x2 ^= rotl32((x1 + x0) >>> 0, 9);
    x3 ^= rotl32((x2 + x1) >>> 0, 13);
    x0 ^= rotl32((x3 + x2) >>> 0, 18);

    x6 ^= rotl32((x5 + x4) >>> 0, 7);
    x7 ^= rotl32((x6 + x5) >>> 0, 9);
    x4 ^= rotl32((x7 + x6) >>> 0, 13);
    x5 ^= rotl32((x4 + x7) >>> 0, 18);

    x11 ^= rotl32((x10 + x9) >>> 0, 7);
    x8 ^= rotl32((x11 + x10) >>> 0, 9);
    x9 ^= rotl32((x8 + x11) >>> 0, 13);
    x10 ^= rotl32((x9 + x8) >>> 0, 18);

    x12 ^= rotl32((x15 + x14) >>> 0, 7);
    x13 ^= rotl32((x12 + x15) >>> 0, 9);
    x14 ^= rotl32((x13 + x12) >>> 0, 13);
    x15 ^= rotl32((x14 + x13) >>> 0, 18);
  }

  const out = new Uint8Array(32);
  store32LE(out, 0, x0);
  store32LE(out, 4, x5);
  store32LE(out, 8, x10);
  store32LE(out, 12, x15);
  store32LE(out, 16, x6);
  store32LE(out, 20, x7);
  store32LE(out, 24, x8);
  store32LE(out, 28, x9);
  return out;
}

/**
 * Generates Salsa20 keystream or XORs input with Salsa20 keystream using a 32-byte subkey and 8-byte nonce suffix.
 */
function salsa20Xor(subkey: Uint8Array, nonce8: Uint8Array, input: Uint8Array, output: Uint8Array): void {
  const j0 = load32LE(SIGMA, 0);
  const j1 = load32LE(subkey, 0);
  const j2 = load32LE(subkey, 4);
  const j3 = load32LE(subkey, 8);
  const j4 = load32LE(subkey, 12);
  const j5 = load32LE(SIGMA, 4);
  const j6 = load32LE(nonce8, 0);
  const j7 = load32LE(nonce8, 4);
  let j8 = 0;
  let j9 = 0;
  const j10 = load32LE(SIGMA, 8);
  const j11 = load32LE(subkey, 16);
  const j12 = load32LE(subkey, 20);
  const j13 = load32LE(subkey, 24);
  const j14 = load32LE(subkey, 28);
  const j15 = load32LE(SIGMA, 12);

  const block = new Uint8Array(64);
  let pos = 0;
  const len = input.length;

  while (pos < len) {
    let x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7;
    let x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15;

    for (let i = 0; i < 20; i += 2) {
      x4 ^= rotl32((x0 + x12) >>> 0, 7);
      x8 ^= rotl32((x4 + x0) >>> 0, 9);
      x12 ^= rotl32((x8 + x4) >>> 0, 13);
      x0 ^= rotl32((x12 + x8) >>> 0, 18);

      x9 ^= rotl32((x5 + x1) >>> 0, 7);
      x13 ^= rotl32((x9 + x5) >>> 0, 9);
      x1 ^= rotl32((x13 + x9) >>> 0, 13);
      x5 ^= rotl32((x1 + x13) >>> 0, 18);

      x14 ^= rotl32((x10 + x6) >>> 0, 7);
      x2 ^= rotl32((x14 + x10) >>> 0, 9);
      x6 ^= rotl32((x2 + x14) >>> 0, 13);
      x10 ^= rotl32((x6 + x2) >>> 0, 18);

      x3 ^= rotl32((x15 + x11) >>> 0, 7);
      x7 ^= rotl32((x3 + x15) >>> 0, 9);
      x11 ^= rotl32((x7 + x3) >>> 0, 13);
      x15 ^= rotl32((x11 + x7) >>> 0, 18);

      x1 ^= rotl32((x0 + x3) >>> 0, 7);
      x2 ^= rotl32((x1 + x0) >>> 0, 9);
      x3 ^= rotl32((x2 + x1) >>> 0, 13);
      x0 ^= rotl32((x3 + x2) >>> 0, 18);

      x6 ^= rotl32((x5 + x4) >>> 0, 7);
      x7 ^= rotl32((x6 + x5) >>> 0, 9);
      x4 ^= rotl32((x7 + x6) >>> 0, 13);
      x5 ^= rotl32((x4 + x7) >>> 0, 18);

      x11 ^= rotl32((x10 + x9) >>> 0, 7);
      x8 ^= rotl32((x11 + x10) >>> 0, 9);
      x9 ^= rotl32((x8 + x11) >>> 0, 13);
      x10 ^= rotl32((x9 + x8) >>> 0, 18);

      x12 ^= rotl32((x15 + x14) >>> 0, 7);
      x13 ^= rotl32((x12 + x15) >>> 0, 9);
      x14 ^= rotl32((x13 + x12) >>> 0, 13);
      x15 ^= rotl32((x14 + x13) >>> 0, 18);
    }

    store32LE(block, 0, (x0 + j0) >>> 0);
    store32LE(block, 4, (x1 + j1) >>> 0);
    store32LE(block, 8, (x2 + j2) >>> 0);
    store32LE(block, 12, (x3 + j3) >>> 0);
    store32LE(block, 16, (x4 + j4) >>> 0);
    store32LE(block, 20, (x5 + j5) >>> 0);
    store32LE(block, 24, (x6 + j6) >>> 0);
    store32LE(block, 28, (x7 + j7) >>> 0);
    store32LE(block, 32, (x8 + j8) >>> 0);
    store32LE(block, 36, (x9 + j9) >>> 0);
    store32LE(block, 40, (x10 + j10) >>> 0);
    store32LE(block, 44, (x11 + j11) >>> 0);
    store32LE(block, 48, (x12 + j12) >>> 0);
    store32LE(block, 52, (x13 + j13) >>> 0);
    store32LE(block, 56, (x14 + j14) >>> 0);
    store32LE(block, 60, (x15 + j15) >>> 0);

    const chunk = Math.min(64, len - pos);
    for (let k = 0; k < chunk; k++) {
      output[pos + k] = input[pos + k] ^ block[k];
    }
    pos += chunk;

    j8 = (j8 + 1) >>> 0;
    if (j8 === 0) {
      j9 = (j9 + 1) >>> 0;
    }
  }
}

/**
 * Poly1305 one-time MAC computation using BigInt (exact 130-bit arithmetic).
 */
function poly1305Mac(msg: Uint8Array, key32: Uint8Array): Uint8Array {
  const P = (1n << 130n) - 5n;

  // Clamp r
  const rBytes = new Uint8Array(key32.subarray(0, 16));
  rBytes[3] &= 15;
  rBytes[7] &= 15;
  rBytes[11] &= 15;
  rBytes[15] &= 15;
  rBytes[4] &= 252;
  rBytes[8] &= 252;
  rBytes[12] &= 252;

  let r = 0n;
  for (let i = 15; i >= 0; i--) {
    r = (r << 8n) | BigInt(rBytes[i]);
  }

  let s = 0n;
  for (let i = 31; i >= 16; i--) {
    s = (s << 8n) | BigInt(key32[i]);
  }

  let acc = 0n;
  for (let offset = 0; offset < msg.length; offset += 16) {
    const chunkLen = Math.min(16, msg.length - offset);
    let n = 1n; // High bit (1 << (8 * chunkLen))
    for (let i = chunkLen - 1; i >= 0; i--) {
      n = (n << 8n) | BigInt(msg[offset + i]);
    }
    acc = ((acc + n) * r) % P;
  }

  acc = (acc + s) & ((1n << 128n) - 1n);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    tag[i] = Number(acc & 0xffn);
    acc >>= 8n;
  }
  return tag;
}

/**
 * NaCl crypto_secretbox_open (XSalsa20-Poly1305):
 * Authenticates and decrypts a single rclone crypt block (16-byte tag + ciphertext).
 */
function naclSecretboxOpen(
  box: Uint8Array,
  nonce24: Uint8Array,
  key32: Uint8Array
): Uint8Array | null {
  if (box.length < 16) return null;

  const subkey = hsalsa20(key32, nonce24.subarray(0, 16));
  const nonce8 = nonce24.subarray(16, 24);

  // First 32 bytes of Salsa20 stream are the Poly1305 one-time key
  const first32Zero = new Uint8Array(32);
  const polyKey = new Uint8Array(32);
  salsa20Xor(subkey, nonce8, first32Zero, polyKey);

  const receivedTag = box.subarray(0, 16);
  const ciphertext = box.subarray(16);

  const computedTag = poly1305Mac(ciphertext, polyKey);
  let diff = 0;
  for (let i = 0; i < 16; i++) {
    diff |= receivedTag[i] ^ computedTag[i];
  }
  if (diff !== 0) {
    return null; // MAC verification failed!
  }

  // Decrypt: in NaCl secretbox, ciphertext starts at byte 32 of the Salsa20 stream
  const paddedIn = new Uint8Array(32 + ciphertext.length);
  paddedIn.set(ciphertext, 32);
  const paddedOut = new Uint8Array(32 + ciphertext.length);
  salsa20Xor(subkey, nonce8, paddedIn, paddedOut);

  return paddedOut.subarray(32);
}

/**
 * Increments a 24-byte nonce as a little-endian integer by `blockIndex`.
 * Matches rclone backend/crypt/cipher.go nonce.carry(i).
 */
function addNonceLE(baseNonce24: Uint8Array, blockIndex: number): Uint8Array {
  const out = new Uint8Array(baseNonce24);
  let carry = BigInt(blockIndex);
  for (let i = 0; i < 24 && carry > 0n; i++) {
    const sum = BigInt(out[i]) + (carry & 0xffn);
    out[i] = Number(sum & 0xffn);
    carry = (carry >> 8n) + (sum >> 8n);
  }
  return out;
}

// ============================================================================
// 2. RCLONE CRYPT SIZE & RANGE TRANSLATION MATH
// ============================================================================

/**
 * Converts encrypted rclone crypt file size -> exact cleartext byte size.
 */
export function encryptedToCleartextSize(encSize: number): number {
  if (encSize <= RCLONE_HEADER_SIZE) return 0;
  const payload = encSize - RCLONE_HEADER_SIZE;
  const fullBlocks = Math.floor(payload / BLOCK_ENC_SIZE);
  const remainder = payload % BLOCK_ENC_SIZE;
  const lastBlockCleartext = remainder > BLOCK_TAG_SIZE ? remainder - BLOCK_TAG_SIZE : 0;
  return fullBlocks * BLOCK_DATA_SIZE + lastBlockCleartext;
}

/**
 * Converts cleartext file size -> exact encrypted rclone crypt file size.
 */
export function cleartextToEncryptedSize(clearSize: number): number {
  if (clearSize <= 0) return RCLONE_HEADER_SIZE;
  const fullBlocks = Math.floor(clearSize / BLOCK_DATA_SIZE);
  const remainder = clearSize % BLOCK_DATA_SIZE;
  return (
    RCLONE_HEADER_SIZE +
    fullBlocks * BLOCK_ENC_SIZE +
    (remainder > 0 ? BLOCK_TAG_SIZE + remainder : 0)
  );
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

// ============================================================================
// 3. TOKEN UNSEALING (AES-256-GCM) & HEADER NONCE FETCHING
// ============================================================================

async function unsealStreamToken(token: string, masterKeyHex: string): Promise<StreamTokenPayload> {
  const raw = base64UrlToBytes(token);
  if (raw.length < 28) {
    throw new Error("Malformed token");
  }
  const iv = raw.subarray(0, 12);
  const ciphertextAndTag = raw.subarray(12);

  const keyBytes = hexToBytes(masterKeyHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ciphertextAndTag
  );

  const payload = JSON.parse(new TextDecoder().decode(decrypted)) as StreamTokenPayload;
  if (Date.now() / 1000 > payload.exp) {
    throw new Error("Stream link has expired");
  }
  return payload;
}

/**
 * Fetches bytes 0..31 of the encrypted origin file to extract the 24-byte fileNonce
 * and total encrypted file size from Content-Range. Cached in memory for instant seeks.
 */
async function getFileNonceAndSize(
  originUrl: string,
  originHeaders?: Record<string, string>
): Promise<{ nonce: Uint8Array; encSize: number }> {
  const cached = headerNonceCache.get(originUrl);
  if (cached) return cached;

  const headers = new Headers(originHeaders || {});
  headers.set("Range", "bytes=0-31");

  const resp = await fetch(originUrl, { method: "GET", headers });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`Origin header fetch failed with HTTP ${resp.status}`);
  }

  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.length < RCLONE_HEADER_SIZE) {
    throw new Error("Origin file is smaller than 32-byte rclone crypt header");
  }

  // Verify "RCLONE\x00\x00" magic header
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== RCLONE_MAGIC[i]) {
      throw new Error("Invalid rclone crypt magic header (expected RCLONE\\x00\\x00)");
    }
  }

  const nonce = buf.slice(8, 32);
  let encSize = 0;
  const contentRange = resp.headers.get("Content-Range");
  if (contentRange && contentRange.includes("/")) {
    const totalStr = contentRange.split("/")[1];
    encSize = parseInt(totalStr, 10) || 0;
  } else {
    const cl = resp.headers.get("Content-Length");
    if (cl) encSize = parseInt(cl, 10) || 0;
  }

  const entry = { nonce, encSize };
  headerNonceCache.set(originUrl, entry);
  return entry;
}

// ============================================================================
// 4. WORKER HTTP HANDLER (HEAD / GET / RANGE 206 STREAMING)
// ============================================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type, Authorization",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Disposition",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (!token) {
      return new Response("Missing ?token= parameter", { status: 400, headers: CORS_HEADERS });
    }

    let payload: StreamTokenPayload;
    try {
      payload = await unsealStreamToken(token, env.MASTER_KEY_HEX);
    } catch (err: any) {
      return new Response(`Unauthorized: ${err.message}`, { status: 401, headers: CORS_HEADERS });
    }

    // Fast path for non-crypt direct proxy
    if (!payload.isCrypt || !payload.dataKeyHex) {
      const proxyHeaders = new Headers(payload.originHeaders || {});
      const rangeReq = request.headers.get("Range");
      if (rangeReq) proxyHeaders.set("Range", rangeReq);

      const upstream = await fetch(payload.originUrl, {
        method: request.method,
        headers: proxyHeaders,
      });

      const respHeaders = new Headers(upstream.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) respHeaders.set(k, v);
      if (payload.mimeType) respHeaders.set("Content-Type", payload.mimeType);
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    }

    // Rclone Crypt Streaming Decryption Path
    try {
      const dataKey = hexToBytes(payload.dataKeyHex);
      const { nonce: fileNonce, encSize: detectedEncSize } = await getFileNonceAndSize(
        payload.originUrl,
        payload.originHeaders
      );

      const totalCleartextSize =
        payload.cleartextSize && payload.cleartextSize > 0
          ? payload.cleartextSize
          : encryptedToCleartextSize(detectedEncSize);

      const totalEncryptedSize =
        detectedEncSize > 0 ? detectedEncSize : cleartextToEncryptedSize(totalCleartextSize);

      const mimeType = payload.mimeType || "video/mp4";
      const dispName = payload.filename || "stream.mp4";

      // Parse incoming HTTP Range header
      const rangeHeader = request.headers.get("Range");
      let clearStart = 0;
      let clearEnd = totalCleartextSize > 0 ? totalCleartextSize - 1 : 0;
      let isPartial = false;

      if (rangeHeader && rangeHeader.startsWith("bytes=") && totalCleartextSize > 0) {
        isPartial = true;
        const parts = rangeHeader.replace("bytes=", "").split("-");
        if (parts[0] === "" && parts[1]) {
          // Suffix range: bytes=-65536
          const suffix = parseInt(parts[1], 10);
          clearStart = Math.max(0, totalCleartextSize - suffix);
          clearEnd = totalCleartextSize - 1;
        } else {
          clearStart = parseInt(parts[0], 10) || 0;
          clearEnd = parts[1] ? Math.min(totalCleartextSize - 1, parseInt(parts[1], 10)) : totalCleartextSize - 1;
        }
      }

      if (clearStart > clearEnd || clearStart >= totalCleartextSize) {
        return new Response("Requested Range Not Satisfiable", {
          status: 416,
          headers: {
            ...CORS_HEADERS,
            "Content-Range": `bytes */${totalCleartextSize}`,
          },
        });
      }

      const contentLength = clearEnd - clearStart + 1;
      const responseHeaders: Record<string, string> = {
        ...CORS_HEADERS,
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
        "Content-Length": String(contentLength),
        "Content-Disposition": `inline; filename="${dispName.replace(/"/g, "")}"`,
      };

      if (isPartial) {
        responseHeaders["Content-Range"] = `bytes ${clearStart}-${clearEnd}/${totalCleartextSize}`;
      }

      if (request.method === "HEAD") {
        return new Response(null, { status: isPartial ? 206 : 200, headers: responseHeaders });
      }

      // Compute aligned 64 KB block boundaries on the encrypted origin file
      const startBlock = Math.floor(clearStart / BLOCK_DATA_SIZE);
      const endBlock = Math.floor(clearEnd / BLOCK_DATA_SIZE);
      const firstBlockSkip = clearStart % BLOCK_DATA_SIZE;

      const encRangeStart = RCLONE_HEADER_SIZE + startBlock * BLOCK_ENC_SIZE;
      const encRangeEnd = Math.min(
        totalEncryptedSize - 1,
        RCLONE_HEADER_SIZE + (endBlock + 1) * BLOCK_ENC_SIZE - 1
      );

      const upstreamHeaders = new Headers(payload.originHeaders || {});
      upstreamHeaders.set("Range", `bytes=${encRangeStart}-${encRangeEnd}`);

      const upstreamResp = await fetch(payload.originUrl, {
        method: "GET",
        headers: upstreamHeaders,
      });

      if (!upstreamResp.ok && upstreamResp.status !== 206 && !upstreamResp.body) {
        return new Response(`Upstream storage returned HTTP ${upstreamResp.status}`, {
          status: 502,
          headers: CORS_HEADERS,
        });
      }

      // Stream and decrypt 65,552-byte blocks on the fly
      let currentBlockIndex = startBlock;
      let isFirstBlock = true;
      let remainingCleartextToEmit = contentLength;
      let buffer = new Uint8Array(0);

      const appendBuffer = (a: Uint8Array, b: Uint8Array): Uint8Array => {
        const merged = new Uint8Array(a.length + b.length);
        merged.set(a, 0);
        merged.set(b, a.length);
        return merged;
      };

      const emitDecryptedBlock = (
        encryptedBlock: Uint8Array,
        controller: TransformStreamDefaultController<Uint8Array>
      ) => {
        if (remainingCleartextToEmit <= 0) return;
        const blockNonce = addNonceLE(fileNonce, currentBlockIndex);
        currentBlockIndex++;

        const cleartext = naclSecretboxOpen(encryptedBlock, blockNonce, dataKey);
        if (!cleartext) {
          controller.error(
            new Error(`rclone crypt Poly1305 MAC verification failed at block ${currentBlockIndex - 1}`)
          );
          return;
        }

        let sliceStart = 0;
        if (isFirstBlock) {
          sliceStart = firstBlockSkip;
          isFirstBlock = false;
        }

        const available = cleartext.length - sliceStart;
        const toSend = Math.min(available, remainingCleartextToEmit);
        if (toSend > 0) {
          controller.enqueue(cleartext.subarray(sliceStart, sliceStart + toSend));
          remainingCleartextToEmit -= toSend;
        }
      };

      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer = appendBuffer(buffer, chunk);
          while (buffer.length >= BLOCK_ENC_SIZE && remainingCleartextToEmit > 0) {
            const block = buffer.subarray(0, BLOCK_ENC_SIZE);
            buffer = buffer.subarray(BLOCK_ENC_SIZE);
            emitDecryptedBlock(block, controller);
          }
        },
        flush(controller) {
          if (buffer.length > BLOCK_TAG_SIZE && remainingCleartextToEmit > 0) {
            emitDecryptedBlock(buffer, controller);
          }
          buffer = new Uint8Array(0);
        },
      });

      const readable = upstreamResp.body!.pipeThrough(transform);
      return new Response(readable, {
        status: isPartial ? 206 : 200,
        headers: responseHeaders,
      });
    } catch (err: any) {
      return new Response(`Crypt Stream Error: ${err.message}`, {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  },
};
