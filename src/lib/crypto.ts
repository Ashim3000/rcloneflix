/**
 * Universal Client-Side Encryption for Arweave Photo Vault
 *
 * Uses Web Crypto API:
 * - PBKDF2 with SHA-256 (100,000 iterations) for key derivation from PIN / passphrase
 * - AES-GCM with 256-bit keys
 * - 16-byte cryptographic random salt + 12-byte random IV prepended to ciphertext
 *
 * Wire format:
 * [ 16 bytes: Salt ] [ 12 bytes: IV ] [ N bytes: Ciphertext + Auth Tag ]
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/**
 * Derives an AES-GCM 256-bit key from a user PIN / passphrase and a salt.
 */
async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as any,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts an ArrayBuffer or Uint8Array using AES-256-GCM.
 * Prepends salt and IV to the resulting buffer.
 */
export async function encryptBytes(
  data: ArrayBuffer | Uint8Array,
  pin: string
): Promise<Uint8Array> {
  const plainBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(pin, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as any },
    key,
    plainBytes as any
  );

  const cipherBytes = new Uint8Array(ciphertext);
  const result = new Uint8Array(SALT_LENGTH + IV_LENGTH + cipherBytes.length);
  result.set(salt, 0);
  result.set(iv, SALT_LENGTH);
  result.set(cipherBytes, SALT_LENGTH + IV_LENGTH);

  return result;
}

/**
 * Decrypts an encrypted buffer that was created with `encryptBytes`.
 * Throws if the PIN is incorrect or payload is tampered with.
 */
export async function decryptBytes(
  encryptedData: ArrayBuffer | Uint8Array,
  pin: string
): Promise<Uint8Array> {
  const bytes = encryptedData instanceof Uint8Array ? encryptedData : new Uint8Array(encryptedData);
  if (bytes.length < SALT_LENGTH + IV_LENGTH + 16) {
    throw new Error("Invalid encrypted payload: too short");
  }

  const salt = bytes.slice(0, SALT_LENGTH);
  const iv = bytes.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = bytes.slice(SALT_LENGTH + IV_LENGTH);

  const key = await deriveKey(pin, salt);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as any },
      key,
      ciphertext as any
    );
    return new Uint8Array(decrypted);
  } catch (err) {
    throw new Error("Decryption failed: incorrect PIN or corrupted data");
  }
}

/**
 * Helper to decrypt encrypted bytes directly into an ephemeral blob Object URL in memory.
 * Resiliently attempts fallback keys (standard public key and adult standard key)
 * if the provided PIN fails AES-GCM tag verification, ensuring photos are never bricked.
 */
export async function createDecryptedObjectUrl(
  encryptedData: ArrayBuffer | Uint8Array,
  pin: string,
  mimeType = "image/webp"
): Promise<string> {
  const bytes = encryptedData instanceof Uint8Array ? encryptedData : new Uint8Array(encryptedData);

  // Check if bytes are ALREADY a valid plaintext image format:
  // JPEG: 0xFF, 0xD8, 0xFF
  // PNG: 0x89, 0x50, 0x4E, 0x47
  // GIF: 0x47, 0x49, 0x46 ('GIF')
  // WebP: 0x52, 0x49, 0x46, 0x46 ('RIFF')
  // BMP: 0x42, 0x4D ('BM')
  let detectedMime = mimeType;
  const isPlaintextImage =
    bytes.length >= 4 &&
    ((bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && (detectedMime = "image/jpeg", true)) ||
     (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && (detectedMime = "image/png", true)) ||
     (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && (detectedMime = "image/gif", true)) ||
     (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && (detectedMime = "image/webp", true)) ||
     (bytes[0] === 0x42 && bytes[1] === 0x4d && (detectedMime = "image/bmp", true)));

  if (isPlaintextImage) {
    const safeBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
    const blob = new Blob([safeBuffer as ArrayBuffer], { type: detectedMime });
    return URL.createObjectURL(blob);
  }

  let decrypted: Uint8Array;
  try {
    decrypted = await decryptBytes(encryptedData, pin);
  } catch {
    const fallbacks = [
      "rcloneflix-public-vault-2026",
      "rcloneflix-adult-vault-standard",
    ].filter((f) => f !== pin);

    let resolved: Uint8Array | null = null;
    for (const fb of fallbacks) {
      try {
        resolved = await decryptBytes(encryptedData, fb);
        break;
      } catch {
        // try next candidate
      }
    }

    if (resolved) {
      decrypted = resolved;
    } else {
      // Fallback to raw bytes to prevent bricking galleries
      decrypted = bytes;
    }
  }

  // Auto-heal RIFF header for WebP images (ffmpeg pipe:1 leaves bytes 4..8 as 0)
  if (
    decrypted.length >= 12 &&
    decrypted[0] === 0x52 && // 'R'
    decrypted[1] === 0x49 && // 'I'
    decrypted[2] === 0x46 && // 'F'
    decrypted[3] === 0x46    // 'F'
  ) {
    const view = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength);
    if (view.getUint32(4, true) === 0) {
      view.setUint32(4, decrypted.byteLength - 8, true);
    }
  }

  const safeBuffer = decrypted.buffer.slice(
    decrypted.byteOffset,
    decrypted.byteOffset + decrypted.byteLength
  );
  const blob = new Blob([safeBuffer as ArrayBuffer], { type: mimeType });
  return URL.createObjectURL(blob);
}

/**
 * Revokes a created Object URL to free RAM.
 */
export function revokeDecryptedObjectUrl(url: string): void {
  if (url && url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}
