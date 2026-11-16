import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore, type MediaItem } from "../store/appStore";
import { useToastStore } from "../store/toastStore";
import { log } from "./log";
import { createVersionFromItem, type MediaSourceVersion } from "./multiVersion";
import { persistItems } from "./libraryDb";
import { getDownloadedFilePath } from "./downloadManager";

const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB per chunk (DropMB default chunk size)

async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url as any, init as any);
      return res as unknown as Response;
    } catch {
      // Fallback to fetch
    }
  }
  return await window.fetch(url, init);
}

/**
 * Checks if a given URL is a DropMB share or stream link.
 */
export function isDropmbUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.includes("dropmb.com/share/") || lower.includes("dropmb.com/api/shares/") || lower.includes("dropmb.com/s/");
}

/**
 * Extracts the share ID from a DropMB URL.
 */
export function extractDropmbShareId(url: string): string | null {
  const m = url.match(/dropmb\.com\/(?:share|api\/shares|s)\/([a-zA-Z0-9_-]+)/i);
  return m ? m[1] : null;
}

/**
 * Obtains an access token for a DropMB share.
 */
export async function getDropmbShareToken(shareId: string): Promise<string | null> {
  try {
    const res = await httpFetch(`https://dropmb.com/api/shares/${shareId}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      return data.token || null;
    }
  } catch (err) {
    console.warn(`Failed getting DropMB token for share ${shareId}:`, err);
  }
  return null;
}

/**
 * Resolves a DropMB share URL into direct audio stream details.
 */
export async function resolveDropmbStream(
  url: string
): Promise<{ streamUrl: string; proxiedUrl: string; title: string; filename: string; shareId: string; files?: any[] } | null> {
  const shareId = extractDropmbShareId(url);
  if (!shareId) return null;

  try {
    const token = await getDropmbShareToken(shareId);
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await httpFetch(`https://dropmb.com/api/shares/${shareId}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    const files: Array<{ id: string; name: string; size: string }> = data.files || [];
    if (!files.length) return null;

    // Pick first audio file, or first file
    const audioFile =
      files.find((f) => {
        const lower = f.name.toLowerCase();
        return (
          lower.endsWith(".mp3") ||
          lower.endsWith(".m4a") ||
          lower.endsWith(".m4b") ||
          lower.endsWith(".flac") ||
          lower.endsWith(".ogg") ||
          lower.endsWith(".wav") ||
          lower.endsWith(".opus")
        );
      }) || files[0];

    const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : "";
    const streamUrl = `https://dropmb.com/api/shares/${shareId}/files/${audioFile.id}?download=false${tokenQuery}`;
    const referer = `https://dropmb.com/share/${shareId}`;

    let proxiedUrl = streamUrl;
    try {
      proxiedUrl = await invoke<string>("get_stream_proxy_url", {
        url: streamUrl,
        referer,
      });
    } catch {
      proxiedUrl = streamUrl;
    }

    return {
      streamUrl,
      proxiedUrl,
      title: data.name || audioFile.name.replace(/\.[^/.]+$/, "").replace(/[_.]+/g, " ").trim(),
      filename: audioFile.name,
      shareId,
      files,
    };
  } catch (err) {
    console.warn("Failed resolving DropMB stream:", err);
    return null;
  }
}

/**
 * Resolves all audio tracks in a DropMB multi-file album share.
 */
export async function resolveDropmbShareTracks(url: string): Promise<Array<{
  streamUrl: string;
  proxiedUrl: string;
  title: string;
  filename: string;
  album: string;
  size: number;
}> | null> {
  const shareId = extractDropmbShareId(url);
  if (!shareId) return null;

  try {
    const token = await getDropmbShareToken(shareId);
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await httpFetch(`https://dropmb.com/api/shares/${shareId}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    const files: Array<{ id: string; name: string; size: string }> = data.files || [];
    if (!files.length) return null;

    const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : "";
    const referer = `https://dropmb.com/share/${shareId}`;

    const tracks = [];
    for (const f of files) {
      const streamUrl = `https://dropmb.com/api/shares/${shareId}/files/${f.id}?download=false${tokenQuery}`;
      let proxiedUrl = streamUrl;
      try {
        proxiedUrl = await invoke<string>("get_stream_proxy_url", {
          url: streamUrl,
          referer,
        });
      } catch {
        proxiedUrl = streamUrl;
      }
      tracks.push({
        streamUrl,
        proxiedUrl,
        title: f.name.replace(/\.[^/.]+$/, "").replace(/[_.]+/g, " ").trim(),
        filename: f.name,
        album: data.name || "",
        size: parseInt(f.size, 10) || 0,
      });
    }
    return tracks;
  } catch (err) {
    console.warn("Failed resolving DropMB share tracks:", err);
    return null;
  }
}

/**
 * Generates an 8-character random alphanumeric share ID.
 */
function generateRandomShareId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const randomValues = new Uint8Array(8);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < randomValues.length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}

export type DropmbExpirationStatus = {
  formattedDate: string;
  daysLeft: number;
  status: "healthy" | "warning" | "expired";
  label: string;
  tooltip: string;
};

/**
 * Calculates human-readable expiration details and health status for DropMB shares.
 */
export function getDropmbExpirationStatus(expiresAt?: number): DropmbExpirationStatus {
  // DropMB policies enforce a 100-day rolling inactivity lease
  const ts = expiresAt && expiresAt > 0 ? expiresAt : Date.now() + 100 * 86400 * 1000;
  const now = Date.now();
  const diffMs = ts - now;
  const daysLeft = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const d = new Date(ts);
  const formattedDate = d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
  });

  if (daysLeft < 0) {
    return {
      formattedDate,
      daysLeft,
      status: "expired",
      label: "Expired",
      tooltip: `DropMB share expired on ${d.toLocaleDateString()}. Click to re-offload.`,
    };
  }

  const years = Math.floor(daysLeft / 365);
  const remMonths = Math.floor((daysLeft % 365) / 30);
  const timeStr = years > 0 ? `${years}y ${remMonths}m` : `${daysLeft}d`;

  if (daysLeft <= 20) {
    return {
      formattedDate,
      daysLeft,
      status: "warning",
      label: `Expires in ${daysLeft}d (Inactivity)`,
      tooltip: `DropMB inactivity lease expires on ${d.toLocaleDateString()} (${daysLeft} days remaining). Open or stream to refresh rolling 100-day window.`,
    };
  }

  return {
    formattedDate,
    daysLeft,
    status: "healthy",
    label: `Expires: ${formattedDate} (${timeStr})`,
    tooltip: `Cached on DropMB Cloud (100-day rolling inactivity lease). Auto-refreshed on access and via keep-alive. Valid until ${d.toLocaleDateString()} (${timeStr} remaining).`,
  };
}

export const DROPMB_ELIGIBLE_EXTS = new Set([
  // Audio
  "mp3", "m4a", "m4b", "flac", "ogg", "wav", "opus", "aac", "alac", "wma", "aiff",
  // Books & Documents
  "epub", "pdf", "mobi", "azw3", "txt", "djvu",
  // Comics
  "cbr", "cbz",
  // Photos
  "jpg", "jpeg", "png", "webp", "avif", "gif", "bmp",
  // Archives
  "zip", "rar", "7z", "tar", "gz"
]);

/**
 * Returns true if the file or extension is eligible for DropMB cloud storage.
 */
export function isDropmbEligibleExtension(filenameOrExt: string): boolean {
  if (!filenameOrExt) return false;
  const ext = filenameOrExt.includes(".")
    ? filenameOrExt.split(".").pop()?.toLowerCase() || ""
    : filenameOrExt.toLowerCase();
  return DROPMB_ELIGIBLE_EXTS.has(ext);
}

/**
 * Signs in to DropMB and retrieves an access token.
 */
export async function signIntoDropmb(
  email: string,
  password: string
): Promise<{ ok: boolean; token: string; message: string; user?: any }> {
  try {
    const res = await invoke<{ ok: boolean; token: string; status: number; user?: any }>(
      "dropmb_sign_in",
      { email, password }
    );
    if (res && res.token) {
      useAppStore.getState().setDropmbConfig({
        enabled: true,
        email: email.trim(),
        password,
        token: res.token,
      });
      return { ok: true, token: res.token, message: "Successfully signed in to DropMB!", user: res.user };
    }
    return { ok: false, token: "", message: "No token returned from DropMB." };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return { ok: false, token: "", message: msg };
  }
}

/**
 * Checks whether a JWT token is expired (or within 60 seconds of expiring).
 */
function isDropmbTokenExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const jsonStr = atob(base64);
    const payload = JSON.parse(jsonStr);
    if (typeof payload.exp === "number") {
      // Refresh if expired or within 60 seconds of expiry
      return payload.exp * 1000 <= Date.now() + 60_000;
    }
  } catch {
    // Non-JWT or unparseable token; assume valid and let server validate
  }
  return false;
}

/**
 * Converts a Uint8Array into a base64 string in 32 KB chunks without stack overflow.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Resolves a valid, non-expired DropMB access token, automatically signing in
 * with saved email & password if the token is missing, expired, or forceRefresh=true.
 */
export async function getValidDropmbToken(forceRefresh = false): Promise<string> {
  const { dropmbConfig } = useAppStore.getState();
  let token = dropmbConfig?.token?.trim() || "";
  const email = dropmbConfig?.email?.trim() || "";
  const password = dropmbConfig?.password || "";

  const needsRefresh = forceRefresh || !token || isDropmbTokenExpired(token);
  if (needsRefresh && email && password) {
    try {
      const loginRes = await signIntoDropmb(email, password);
      if (loginRes.ok && loginRes.token) {
        token = loginRes.token.trim();
      }
    } catch {}
  }

  return token;
}

/**
 * Returns authorization headers for DropMB API requests.
 */
export async function getDropmbAuthHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const token = await getValidDropmbToken(forceRefresh);

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
    headers["Cookie"] = `access_token=${token}`;
  }

  return headers;
}

/**
 * Creates a new DropMB share container with a 100-day rolling inactivity lease.
 * Uses native backend command (`dropmb_create_share`) so WebView `Headers` never strips `Cookie`.
 */
async function createDropmbShare(fileName: string): Promise<{ shareId: string; expiresAt: number }> {
  const shareId = generateRandomShareId();
  const expiresAt = Date.now() + 100 * 86400 * 1000;
  // DropMB limits share container name to <= 30 characters
  const trimmedName = (fileName || "Share").trim();
  const safeName = trimmedName.length > 30 ? trimmedName.slice(0, 30) : trimmedName;

  let token = await getValidDropmbToken(false);
  let res = await invoke<{ ok: boolean; status: number; data?: any; body?: string }>(
    "dropmb_create_share",
    {
      id: shareId,
      name: safeName,
      expiration: "never",
      token,
    }
  );

  // If 401/403 and email/password are configured, force-refresh token once and retry
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    const refreshedToken = await getValidDropmbToken(true);
    if (refreshedToken && refreshedToken !== token) {
      token = refreshedToken;
      res = await invoke<{ ok: boolean; status: number; data?: any; body?: string }>(
        "dropmb_create_share",
        {
          id: shareId,
          name: safeName,
          expiration: "never",
          token,
        }
      );
    }
  }

  if (!res.ok) {
    const errText = res.body || "";
    if (res.status === 403 || res.status === 401) {
      throw new Error(
        `DropMB requires an authenticated account (anonymous uploads were disabled by dropmb.com). ` +
        `Please sign in or enter your session token in Settings -> Cyberlocker & Cloud Offload.`
      );
    }
    throw new Error(`Failed to create DropMB share container (HTTP ${res.status}): ${errText}`);
  }

  return {
    shareId: res.data?.id || shareId,
    expiresAt,
  };
}

/**
 * Uploads a single chunk to an existing DropMB share via native backend command.
 */
async function uploadDropmbChunk(
  shareId: string,
  chunkBytes: Uint8Array,
  fileName: string,
  chunkIndex: number,
  totalChunks: number,
  existingFileId?: string
): Promise<string> {
  const chunkBase64 = uint8ArrayToBase64(chunkBytes);
  let token = await getValidDropmbToken(false);

  let res = await invoke<{ ok: boolean; status: number; data?: any; body?: string }>(
    "dropmb_upload_chunk",
    {
      shareId,
      fileName,
      chunkIndex,
      totalChunks,
      fileId: existingFileId || null,
      token,
      chunkBase64,
    }
  );

  if (!res.ok && (res.status === 401 || res.status === 403)) {
    const refreshedToken = await getValidDropmbToken(true);
    if (refreshedToken && refreshedToken !== token) {
      token = refreshedToken;
      res = await invoke<{ ok: boolean; status: number; data?: any; body?: string }>(
        "dropmb_upload_chunk",
        {
          shareId,
          fileName,
          chunkIndex,
          totalChunks,
          fileId: existingFileId || null,
          token,
          chunkBase64,
        }
      );
    }
  }

  if (!res.ok) {
    throw new Error(`DropMB chunk ${chunkIndex + 1}/${totalChunks} upload failed (HTTP ${res.status}): ${res.body || ""}`);
  }

  return res.data?.id || existingFileId || "";
}

/**
 * Completes a DropMB share upload session via native backend command.
 */
async function completeDropmbShare(shareId: string): Promise<void> {
  let token = await getValidDropmbToken(false);
  let res = await invoke<{ ok: boolean; status: number; body?: string }>(
    "dropmb_complete_share",
    {
      shareId,
      token,
    }
  );

  if (!res.ok && (res.status === 401 || res.status === 403)) {
    const refreshedToken = await getValidDropmbToken(true);
    if (refreshedToken && refreshedToken !== token) {
      token = refreshedToken;
      res = await invoke<{ ok: boolean; status: number; body?: string }>(
        "dropmb_complete_share",
        {
          shareId,
          token,
        }
      );
    }
  }

  if (!res.ok) {
    throw new Error(`Failed to finalize DropMB share (HTTP ${res.status}): ${res.body || ""}`);
  }
}

/**
 * Main offloader: takes any media item (music, audiobook, ebook, PDF, etc.),
 * streams its data in 10 MB chunks to DropMB with a 100-day rolling inactivity lease,
 * and registers the direct stream/download version on the item.
 */
export async function offloadItemToDropmb(
  item: MediaItem,
  onProgress?: (pct: number, msg: string) => void
): Promise<string | null> {
  const { rcloneConfigPath, libraries, upsertMediaItem } = useAppStore.getState();
  const addToast = useToastStore.getState().addToast;

  const ext = item.filename.includes(".")
    ? item.filename.split(".").pop()
    : (item.libraryType === "books" ? "epub" : "mp3");
  const fileName = item.filename || `${item.title}.${ext}`;
  addToast(`Preparing DropMB Cloud Offload for "${item.title}" (100-Day Rolling Lease)...`, "info");
  onProgress?.(5, "Resolving local stream / file...");

  try {
    // 1. Get a streamable localhost HTTP URL for the track
    let localStreamUrl = "";
    let fileSize = item.sizeBytes || 0;

    let activeSessionId: string | null = null;
    const localPath = await getDownloadedFilePath(item);
    if (localPath) {
      const res = await invoke<{ file_url: string }>("start_local_file_stream", { filePath: localPath });
      localStreamUrl = res.file_url;
    } else {
      const library = libraries.find((l) => l.id === item.libraryId);
      const matchingRoot =
        library?.remotePaths.find((p) => {
          const r = p.replace(/\/+$/, "");
          return item.remotePath.startsWith(r + "/") || (r.endsWith(":") && item.remotePath.startsWith(r));
        }) ??
        library?.remotePaths[0] ??
        "";
      const rootTrimmed = matchingRoot.replace(/\/+$/, "");
      let relPath: string;
      if (item.remotePath.startsWith(rootTrimmed + "/")) {
        relPath = item.remotePath.slice(rootTrimmed.length + 1);
      } else if (rootTrimmed.endsWith(":") && item.remotePath.startsWith(rootTrimmed)) {
        relPath = item.remotePath.slice(rootTrimmed.length).replace(/^\/+/, "");
      } else {
        relPath = item.remotePath.split("/").pop() ?? item.filename;
      }

      activeSessionId = `offload-dropmb-${item.id}`;
      const res = await invoke<{ file_url: string }>("start_stream_session", {
        configPath: rcloneConfigPath,
        remoteRoot: matchingRoot,
        filePath: relPath,
        sessionId: activeSessionId,
      });
      localStreamUrl = res.file_url;
    }

    try {
      if (!localStreamUrl) {
        throw new Error("Unable to establish audio stream session.");
      }

    // Determine total length if not provided
    if (!fileSize || fileSize <= 0) {
      try {
        const headRes = await httpFetch(localStreamUrl, { method: "HEAD" });
        const len = headRes.headers.get("content-length");
        if (len) fileSize = parseInt(len, 10);
      } catch {}
    }

    const sizeKnown = fileSize > 0;
    const totalChunks = sizeKnown ? Math.max(1, Math.ceil(fileSize / CHUNK_SIZE)) : 1;

    // 2. Create the 100-Day DropMB share container
    onProgress?.(10, "Creating 100-day cloud share on DropMB...");
    const { shareId, expiresAt } = await createDropmbShare(fileName);

    let fileId = "";
    let chunkIndex = 0;
    let offset = 0;

    while (!sizeKnown || offset < fileSize) {
      const start = offset;
      const end = sizeKnown ? Math.min(fileSize - 1, start + CHUNK_SIZE - 1) : start + CHUNK_SIZE - 1;
      const chunkPct = sizeKnown
        ? Math.round(10 + (Math.min(offset + CHUNK_SIZE, fileSize) / fileSize) * 80)
        : Math.min(90, 10 + chunkIndex * 5);

      onProgress?.(chunkPct, `Uploading chunk ${chunkIndex + 1}${sizeKnown ? `/${totalChunks}` : ""} to DropMB...`);

      const chunkRes = await httpFetch(localStreamUrl, {
        headers: { Range: `bytes=${start}-${end}` },
      });

      if (!chunkRes.ok && chunkRes.status !== 206) {
        if (!sizeKnown && chunkIndex > 0) {
          break;
        }
        throw new Error(`Failed fetching audio chunk ${chunkIndex + 1} from local stream (HTTP ${chunkRes.status})`);
      }

      const chunkBuffer = await chunkRes.arrayBuffer();
      const chunkBytes = new Uint8Array(chunkBuffer);
      if (chunkBytes.byteLength === 0) {
        break;
      }

      fileId = await uploadDropmbChunk(
        shareId,
        chunkBytes,
        fileName,
        chunkIndex,
        sizeKnown ? totalChunks : chunkIndex + 1,
        fileId || undefined
      );

      offset += chunkBytes.byteLength;
      chunkIndex++;

      if (chunkBytes.byteLength < CHUNK_SIZE) {
        break;
      }
    }

    // 4. Finalize the share
    onProgress?.(95, "Finalizing cloud share...");
    await completeDropmbShare(shareId);

    const token = await getDropmbShareToken(shareId);
    const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : "";
    const directStreamUrl = `https://dropmb.com/api/shares/${shareId}/files/${fileId}?download=false${tokenQuery}`;

    // 5. Register DropMB Version on the media item
    const dropmbVersion: MediaSourceVersion = {
      id: `${item.id}-dropmb-2`,
      remoteName: "dropmb",
      remotePath: directStreamUrl,
      libraryId: item.libraryId,
      sizeBytes: fileSize,
      container: item.filename.split(".").pop()?.toLowerCase(),
      isLocal: false,
      priority: 2,
      sourceType: "streamtape", // Treated as priority-2 cloud CDN version
      addedAt: Date.now(),
      expiresAt,
    };

    const existingVersions =
      item.versions && item.versions.length > 0
        ? item.versions.filter((v) => !v.remoteName.toLowerCase().includes("dropmb"))
        : [createVersionFromItem(item)];

    const updatedItem: MediaItem = {
      ...item,
      dropmbExpiresAt: expiresAt,
      versions: [dropmbVersion, ...existingVersions].sort((a, b) => a.priority - b.priority),
    };

    upsertMediaItem(updatedItem);
    await persistItems([updatedItem]);

    const expStatus = getDropmbExpirationStatus(expiresAt);
    onProgress?.(100, "Completed!");
    addToast(
      `"${item.title}" successfully offloaded to DropMB! (${expStatus.label})`,
      "success",
      6000
    );
    log.info("dropmb", `Successfully offloaded ${item.title} to DropMB at ${directStreamUrl}`);

    return directStreamUrl;
  } finally {
    if (activeSessionId) {
      invoke("stop_stream_session", { sessionId: activeSessionId }).catch(() => {});
    }
  }
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error("DropMB offload error:", msg);
    addToast(`DropMB offload failed: ${msg}`, "error", 6000);
    log.error("dropmb", `Failed offloading ${item.title}: ${msg}`);
    return null;
  }
}

/**
 * Offloads a single file from Cloud Explorer directly to DropMB with a 100-day rolling cloud lease.
 * Returns the public share URL, direct stream URL, and expiration timestamp.
 */
export async function offloadRemotePathToDropmb(
  configPath: string,
  remoteName: string,
  remotePath: string,
  fileName: string,
  fileSize?: number,
  onProgress?: (pct: number, msg: string) => void
): Promise<{ shareUrl: string; directStreamUrl: string; expiresAt: number; shareId: string } | null> {
  const addToast = useToastStore.getState().addToast;
  onProgress?.(5, `Starting DropMB offload for "${fileName}" (100-Day Rolling Lease)...`);

  try {
    // Determine stream roots for rclone
    const hasColon = remotePath.includes(":");
    let streamRoot = "";
    let streamFile = "";

    if (hasColon) {
      const parts = remotePath.split(":");
      const rName = parts[0];
      const rSub = parts.slice(1).join(":");
      const lastSlash = rSub.lastIndexOf("/");
      if (lastSlash >= 0) {
        streamRoot = `${rName}:${rSub.substring(0, lastSlash)}`;
        streamFile = rSub.substring(lastSlash + 1);
      } else {
        streamRoot = `${rName}:`;
        streamFile = rSub;
      }
    } else {
      const lastSlash = remotePath.lastIndexOf("/");
      if (lastSlash >= 0) {
        const dir = remotePath.substring(0, lastSlash);
        streamRoot = remoteName.endsWith(":") ? `${remoteName}${dir}` : `${remoteName}:${dir}`;
        streamFile = remotePath.substring(lastSlash + 1);
      } else {
        streamRoot = remoteName.endsWith(":") ? remoteName : `${remoteName}:`;
        streamFile = remotePath;
      }
    }

    const sessionId = `offload-dropmb-${Date.now()}`;
    const res = await invoke<{ file_url: string }>("start_stream_session", {
      configPath,
      remoteRoot: streamRoot,
      filePath: streamFile,
      sessionId,
    });

    const localStreamUrl = res?.file_url;
    if (!localStreamUrl) {
      throw new Error(`Unable to establish remote stream for "${fileName}".`);
    }

    try {
      let actualSize = fileSize || 0;
      if (!actualSize || actualSize <= 0) {
        try {
          const headRes = await httpFetch(localStreamUrl, { method: "HEAD" });
          const len = headRes.headers.get("content-length");
          if (len) actualSize = parseInt(len, 10);
        } catch {}
      }

      onProgress?.(12, "Creating DropMB 100-day cloud share...");
      const { shareId, expiresAt } = await createDropmbShare(fileName);

      const sizeKnown = actualSize > 0;
      const totalChunks = sizeKnown ? Math.max(1, Math.ceil(actualSize / CHUNK_SIZE)) : 1;
      let fileId = "";
      let chunkIndex = 0;
      let offset = 0;

      while (!sizeKnown || offset < actualSize) {
        const start = offset;
        const end = sizeKnown ? Math.min(actualSize - 1, start + CHUNK_SIZE - 1) : start + CHUNK_SIZE - 1;
        const chunkPct = sizeKnown
          ? Math.round(12 + (Math.min(offset + CHUNK_SIZE, actualSize) / actualSize) * 80)
          : Math.min(90, 12 + chunkIndex * 5);

        onProgress?.(chunkPct, `Uploading chunk ${chunkIndex + 1}${sizeKnown ? `/${totalChunks}` : ""} to DropMB...`);

        const chunkRes = await httpFetch(localStreamUrl, {
          headers: { Range: `bytes=${start}-${end}` },
        });

        if (!chunkRes.ok && chunkRes.status !== 206) {
          if (!sizeKnown && chunkIndex > 0) {
            break;
          }
          throw new Error(`Failed fetching chunk ${chunkIndex + 1} from stream (HTTP ${chunkRes.status})`);
        }

        const chunkBuffer = await chunkRes.arrayBuffer();
        const chunkBytes = new Uint8Array(chunkBuffer);
        if (chunkBytes.byteLength === 0) {
          break;
        }

        fileId = await uploadDropmbChunk(
          shareId,
          chunkBytes,
          fileName,
          chunkIndex,
          sizeKnown ? totalChunks : chunkIndex + 1,
          fileId || undefined
        );

        offset += chunkBytes.byteLength;
        chunkIndex++;

        if (chunkBytes.byteLength < CHUNK_SIZE) {
          break;
        }
      }

      onProgress?.(95, "Finalizing cloud share...");
      await completeDropmbShare(shareId);

      const token = await getDropmbShareToken(shareId);
      const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : "";
      const directStreamUrl = `https://dropmb.com/api/shares/${shareId}/files/${fileId}?download=false${tokenQuery}`;
      const shareUrl = `https://dropmb.com/share/${shareId}`;

      const expStatus = getDropmbExpirationStatus(expiresAt);
      onProgress?.(100, "Completed!");
      addToast(
        `"${fileName}" offloaded to DropMB! (${expStatus.label}) Link copied to clipboard.`,
        "success",
        7000
      );

      try {
        await navigator.clipboard.writeText(shareUrl);
      } catch {}

      return { shareUrl, directStreamUrl, expiresAt, shareId };
    } finally {
      invoke("stop_stream_session", { sessionId }).catch(() => {});
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error("DropMB remote offload failed:", msg);
    addToast(`DropMB offload failed: ${msg}`, "error", 6000);
    return null;
  }
}

/**
 * Offloads all eligible files in a cloud folder into a single multi-file DropMB share container.
 */
export async function offloadRemoteFolderToDropmb(
  configPath: string,
  remoteName: string,
  folderPath: string,
  folderName: string,
  onProgress?: (pct: number, msg: string) => void
): Promise<{ shareUrl: string; totalFiles: number; expiresAt: number; shareId: string } | null> {
  const addToast = useToastStore.getState().addToast;
  onProgress?.(5, `Scanning folder "${folderName}" for eligible media...`);

  try {
    const cleanSubpath = folderPath.includes(":")
      ? folderPath.split(":")[1].replace(/^\//, "")
      : folderPath.replace(/^\//, "");

    const cleanRemote = remoteName.replace(/:$/, "");
    const remotePath = cleanSubpath ? `${cleanRemote}:${cleanSubpath}` : `${cleanRemote}:`;
    const items = await invoke<Array<{ name: string; path: string; is_dir: boolean; size: number }>>(
      "list_remote_path",
      {
        configPath,
        remotePath,
      }
    );

    const eligibleFiles = (items || []).filter(
      (it) => !it.is_dir && isDropmbEligibleExtension(it.name)
    );

    if (eligibleFiles.length === 0) {
      throw new Error(
        `No eligible files (audio, books, documents, comics, photos, archives) found in "${folderName}".`
      );
    }

    onProgress?.(10, `Creating DropMB cloud share for ${eligibleFiles.length} file(s)...`);
    const { shareId, expiresAt } = await createDropmbShare(folderName);

    const folderRoot = remoteName.endsWith(":")
      ? `${remoteName}${cleanSubpath}`
      : `${remoteName}:${cleanSubpath}`;

    for (let fIdx = 0; fIdx < eligibleFiles.length; fIdx++) {
      const file = eligibleFiles[fIdx];
      const basePct = Math.round(10 + (fIdx / eligibleFiles.length) * 82);

      onProgress?.(
        basePct,
        `[${fIdx + 1}/${eligibleFiles.length}] Offloading "${file.name}" to DropMB...`
      );

      const fileSessionId = `offload-dropmb-f-${Date.now()}-${fIdx}`;
      try {
        const res = await invoke<{ file_url: string }>("start_stream_session", {
          configPath,
          remoteRoot: folderRoot,
          filePath: file.name,
          sessionId: fileSessionId,
        });

        const localStreamUrl = res?.file_url;
        if (!localStreamUrl) continue;

        let actualSize = file.size || 0;
        if (!actualSize || actualSize <= 0) {
          try {
            const headRes = await httpFetch(localStreamUrl, { method: "HEAD" });
            const len = headRes.headers.get("content-length");
            if (len) actualSize = parseInt(len, 10);
          } catch {}
        }
        if (!actualSize || actualSize <= 0) actualSize = 5 * 1024 * 1024;

        const totalChunks = Math.max(1, Math.ceil(actualSize / CHUNK_SIZE));
        let fileId = "";

        for (let cIdx = 0; cIdx < totalChunks; cIdx++) {
          const start = cIdx * CHUNK_SIZE;
          const end = Math.min(actualSize - 1, (cIdx + 1) * CHUNK_SIZE - 1);

          const chunkRes = await httpFetch(localStreamUrl, {
            headers: { Range: `bytes=${start}-${end}` },
          });
          if (!chunkRes.ok && chunkRes.status !== 206) break;

          const chunkBuffer = await chunkRes.arrayBuffer();
          const chunkBytes = new Uint8Array(chunkBuffer);
          fileId = await uploadDropmbChunk(shareId, chunkBytes, file.name, cIdx, totalChunks, fileId || undefined);
        }
      } finally {
        invoke("stop_stream_session", { sessionId: fileSessionId }).catch(() => {});
      }
    }

    onProgress?.(95, "Finalizing cloud folder share...");
    await completeDropmbShare(shareId);

    const shareUrl = `https://dropmb.com/share/${shareId}`;
    const expStatus = getDropmbExpirationStatus(expiresAt);
    onProgress?.(100, "Completed!");
    addToast(
      `Folder "${folderName}" (${eligibleFiles.length} files) offloaded to DropMB! (${expStatus.label}) Link copied.`,
      "success",
      7000
    );

    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {}

    return { shareUrl, totalFiles: eligibleFiles.length, expiresAt, shareId };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error("DropMB folder offload failed:", msg);
    addToast(`Folder offload failed: ${msg}`, "error", 6000);
    return null;
  }
}

/** Backwards-compatible alias */
export const offloadAudioItemToDropmb = offloadItemToDropmb;

/**
 * Offloads all tracks of an album sequentially to a single DropMB share container.
 * Updates dropmbShareUrl on all album items and registers DropMB source versions.
 */
export async function offloadAlbumToDropmb(
  items: MediaItem[],
  albumTitle: string,
  onProgress?: (pct: number, msg: string) => void
): Promise<string | null> {
  if (!items || items.length === 0) {
    return null;
  }

  const { rcloneConfigPath, libraries, upsertMediaItem } = useAppStore.getState();
  const addToast = useToastStore.getState().addToast;

  addToast(`Preparing DropMB Cloud Container for Album "${albumTitle}" (${items.length} tracks)...`, "info");
  onProgress?.(5, "Creating album container on DropMB...");

  try {
    const { shareId, expiresAt } = await createDropmbShare(albumTitle);
    const updatedItems: MediaItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const basePct = Math.round(5 + (i / items.length) * 85);
      const ext = item.filename?.includes(".")
        ? item.filename.split(".").pop()
        : "mp3";
      const fileName = item.filename || `${item.title}.${ext}`;

      onProgress?.(basePct, `[${i + 1}/${items.length}] Offloading "${item.title}"...`);

      let activeSessionId: string | null = null;
      try {
        let localStreamUrl = "";
        let fileSize = item.sizeBytes || 0;

        const localPath = await getDownloadedFilePath(item);
        if (localPath) {
          const res = await invoke<{ file_url: string }>("start_local_file_stream", { filePath: localPath });
          localStreamUrl = res.file_url;
        } else {
          const library = libraries.find((l) => l.id === item.libraryId);
          const matchingRoot =
            library?.remotePaths.find((p) => {
              const r = p.replace(/\/+$/, "");
              return item.remotePath.startsWith(r + "/") || (r.endsWith(":") && item.remotePath.startsWith(r));
            }) ??
            library?.remotePaths[0] ??
            "";
          const rootTrimmed = matchingRoot.replace(/\/+$/, "");
          let relPath: string;
          if (item.remotePath.startsWith(rootTrimmed + "/")) {
            relPath = item.remotePath.slice(rootTrimmed.length + 1);
          } else if (rootTrimmed.endsWith(":") && item.remotePath.startsWith(rootTrimmed)) {
            relPath = item.remotePath.slice(rootTrimmed.length).replace(/^\/+/, "");
          } else {
            relPath = item.remotePath.split("/").pop() ?? item.filename;
          }

          activeSessionId = `offload-album-${item.id}-${i}`;
          const res = await invoke<{ file_url: string }>("start_stream_session", {
            configPath: rcloneConfigPath,
            remoteRoot: matchingRoot,
            filePath: relPath,
            sessionId: activeSessionId,
          });
          localStreamUrl = res.file_url;
        }

        if (!localStreamUrl) {
          console.warn(`Could not start stream session for "${item.title}", skipping.`);
          continue;
        }

        if (!fileSize || fileSize <= 0) {
          try {
            const headRes = await httpFetch(localStreamUrl, { method: "HEAD" });
            const len = headRes.headers.get("content-length");
            if (len) fileSize = parseInt(len, 10);
          } catch {}
        }

        const sizeKnown = fileSize > 0;
        const totalChunks = sizeKnown ? Math.max(1, Math.ceil(fileSize / CHUNK_SIZE)) : 1;
        let fileId = "";
        let chunkIndex = 0;
        let offset = 0;

        while (!sizeKnown || offset < fileSize) {
          const start = offset;
          const end = sizeKnown ? Math.min(fileSize - 1, start + CHUNK_SIZE - 1) : start + CHUNK_SIZE - 1;
          const chunkRes = await httpFetch(localStreamUrl, {
            headers: { Range: `bytes=${start}-${end}` },
          });

          if (!chunkRes.ok && chunkRes.status !== 206) {
            if (!sizeKnown && chunkIndex > 0) break;
            throw new Error(`Failed fetching chunk ${chunkIndex + 1} for ${item.title}`);
          }

          const chunkBuffer = await chunkRes.arrayBuffer();
          const chunkBytes = new Uint8Array(chunkBuffer);
          if (chunkBytes.byteLength === 0) break;

          fileId = await uploadDropmbChunk(
            shareId,
            chunkBytes,
            fileName,
            chunkIndex,
            sizeKnown ? totalChunks : chunkIndex + 1,
            fileId || undefined
          );

          offset += chunkBytes.byteLength;
          chunkIndex++;
          if (chunkBytes.byteLength < CHUNK_SIZE) break;
        }

        const directStreamUrl = `https://dropmb.com/api/shares/${shareId}/files/${fileId}?download=false`;
        const dropmbVersion: MediaSourceVersion = {
          id: `${item.id}-dropmb-2`,
          remoteName: "dropmb",
          remotePath: directStreamUrl,
          libraryId: item.libraryId,
          sizeBytes: fileSize,
          container: ext?.toLowerCase(),
          isLocal: false,
          priority: 2,
          sourceType: "streamtape",
          addedAt: Date.now(),
          expiresAt,
        };

        const existingVersions =
          item.versions && item.versions.length > 0
            ? item.versions.filter((v) => !v.remoteName.toLowerCase().includes("dropmb"))
            : [createVersionFromItem(item)];

        const updatedItem: MediaItem = {
          ...item,
          dropmbExpiresAt: expiresAt,
          dropmbShareUrl: `https://dropmb.com/share/${shareId}`,
          versions: [dropmbVersion, ...existingVersions].sort((a, b) => a.priority - b.priority),
        };

        updatedItems.push(updatedItem);
        upsertMediaItem(updatedItem);
      } finally {
        if (activeSessionId) {
          invoke("stop_stream_session", { sessionId: activeSessionId }).catch(() => {});
        }
      }
    }

    onProgress?.(95, "Finalizing album share container...");
    await completeDropmbShare(shareId);

    if (updatedItems.length > 0) {
      await persistItems(updatedItems);
    }

    const shareUrl = `https://dropmb.com/share/${shareId}`;
    const expStatus = getDropmbExpirationStatus(expiresAt);
    onProgress?.(100, "Completed!");
    addToast(
      `Album "${albumTitle}" (${updatedItems.length} tracks) offloaded to DropMB! (${expStatus.label}) Link copied.`,
      "success",
      7000
    );

    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {}

    return shareUrl;
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error("DropMB album offload failed:", msg);
    addToast(`Album offload failed: ${msg}`, "error", 6000);
    return null;
  }
}

