/**
 * Native in-browser WebP image compressor.
 *
 * Compresses images strictly to under 95 KB (target max 95,000 bytes)
 * using HTML5 Canvas, ensuring it qualifies for Arweave's free tier
 * without needing external CLI tools or FFmpeg.
 */

export const MAX_VAULT_BYTES = 88_000; // Strictly < 88 KB (safely below 105 KiB Turbo limit with ANS-104 headers)

export interface CompressedImageResult {
  blob: Blob;
  arrayBuffer: ArrayBuffer;
  bytes: Uint8Array;
  sizeBytes: number;
  width: number;
  height: number;
}

/**
 * Loads an image Blob/File into an HTMLImageElement.
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error("Failed to load image into canvas: " + String(e)));
    img.src = src;
  });
}

/**
 * Encodes a canvas to a WebP blob if supported, or falls back to JPEG if WebKitGTK
 * rejects WebP export and defaults to uncompressed PNG.
 */
function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (webpBlob) => {
        if (webpBlob && webpBlob.type === "image/webp") {
          resolve(webpBlob);
        } else {
          // WebKitGTK defaults to image/png for unsupported webp canvas export.
          // Fall back to image/jpeg which respects lossy quality compression in WebKitGTK.
          canvas.toBlob(
            (jpegBlob) => {
              if (jpegBlob) resolve(jpegBlob);
              else reject(new Error("Canvas toBlob JPEG failed"));
            },
            "image/jpeg",
            quality
          );
        }
      },
      "image/webp",
      quality
    );
  });
}

/**
 * Compresses any image (JPEG, PNG, WebP, HEIC/AVIF if browser supports)
 * down to < 88 KB using adaptive downscaling and quality tuning.
 */
export async function compressImageToVault(
  fileOrBlob: Blob | File,
  maxBytes: number = MAX_VAULT_BYTES
): Promise<CompressedImageResult> {
  const objectUrl = URL.createObjectURL(fileOrBlob);

  try {
    const img = await loadImage(objectUrl);
    const origWidth = img.naturalWidth || img.width;
    const origHeight = img.naturalHeight || img.height;

    // Steps of max dimension and quality to try until size is under maxBytes
    const attempts = [
      { maxDim: 1600, quality: 0.80 },
      { maxDim: 1400, quality: 0.72 },
      { maxDim: 1280, quality: 0.68 },
      { maxDim: 1024, quality: 0.62 },
      { maxDim: 900,  quality: 0.58 },
      { maxDim: 800,  quality: 0.52 },
      { maxDim: 640,  quality: 0.48 },
      { maxDim: 500,  quality: 0.42 },
    ];

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) throw new Error("Could not get 2D canvas context");

    let finalBlob: Blob | null = null;
    let finalWidth = origWidth;
    let finalHeight = origHeight;

    for (const attempt of attempts) {
      let targetW = origWidth;
      let targetH = origHeight;

      if (targetW > attempt.maxDim || targetH > attempt.maxDim) {
        if (targetW > targetH) {
          targetH = Math.round((targetH * attempt.maxDim) / targetW);
          targetW = attempt.maxDim;
        } else {
          targetW = Math.round((targetW * attempt.maxDim) / targetH);
          targetH = attempt.maxDim;
        }
      }

      canvas.width = targetW;
      canvas.height = targetH;
      ctx.clearRect(0, 0, targetW, targetH);

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, targetW, targetH);

      const blob = await canvasToBlob(canvas, attempt.quality);
      finalWidth = targetW;
      finalHeight = targetH;
      finalBlob = blob;

      if (blob.size <= maxBytes) {
        break; // Successfully under threshold!
      }
    }

    if (!finalBlob || finalBlob.size > maxBytes) {
      throw new Error(
        `Unable to compress image below free tier limit (${Math.round((finalBlob?.size ?? 0) / 1024)} KB vs max ${Math.round(maxBytes / 1024)} KB)`
      );
    }

    const arrayBuffer = await finalBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    return {
      blob: finalBlob,
      arrayBuffer,
      bytes,
      sizeBytes: bytes.byteLength,
      width: finalWidth,
      height: finalHeight,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
