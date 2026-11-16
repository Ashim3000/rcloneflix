import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore, isLocalPath, type MediaItem } from "../store/appStore";
import { useToastStore } from "../store/toastStore";
import { useCloudTransferStore, initCloudTransferPoller } from "./kaggleTransfer";
import { createVersionFromItem, type MediaSourceVersion } from "./multiVersion";
import { persistItems } from "./libraryDb";
import { dispatchCloudTask } from "./cloudWorkerRouter";

export const TELEGRAM_MAX_BYTES = 2000 * 1024 * 1024; // 2 GB hard limit
const DIRECT_SINGLE_PUT_MAX_BYTES = 32 * 1024 * 1024; // 32 MiB single-PUT threshold
const HTTP_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024; // 16 MiB per HTTP chunk (= 32 x 512 KiB MTProto parts)
const MTPROTO_PART_BYTES = 524288; // 512 KiB per Telegram SaveBigFilePart

async function getLocalEngineBaseUrl(): Promise<string> {
  try {
    const status = await invoke<{ webdav_url: string }>("telegram_get_status");
    if (status?.webdav_url) {
      return status.webdav_url.replace(/\/webdav\/?$/, "");
    }
  } catch {
    // ignore
  }
  const proxyUrl = await invoke<string>("get_stream_proxy_url");
  return proxyUrl.replace(/\/+$/, "");
}

async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url as any, init as any);
      return res as unknown as Response;
    } catch {
      // Fallback to window.fetch
    }
  }
  return await window.fetch(url, init);
}

/**
 * Checks whether a media item is eligible for Telegram offload (< 2 GB).
 */
export function canOffloadToTelegram(item: MediaItem): { eligible: boolean; reason?: string } {
  if (item.sizeBytes && item.sizeBytes > TELEGRAM_MAX_BYTES) {
    const gb = (item.sizeBytes / (1024 * 1024 * 1024)).toFixed(2);
    return {
      eligible: false,
      reason: `File is ${gb} GB, which exceeds Telegram's 2.00 GB per-file limit.`,
    };
  }
  return { eligible: true };
}

/**
 * Returns true if the item already has an active Telegram offloaded version.
 */
export function hasTelegramVersion(item: MediaItem): boolean {
  if (
    item.remotePath?.startsWith("telegram-drive:") ||
    item.remotePath?.startsWith("telegram:") ||
    item.remotePath?.startsWith("tg-native:") ||
    item.remotePath?.startsWith("tg-serverless:")
  ) {
    return true;
  }
  return Boolean(
    item.versions?.some(
      (v) =>
        v.sourceType === "telegram" ||
        v.remoteName === "telegram-drive" ||
        v.remotePath.startsWith("telegram-drive:") ||
        v.remoteName === "tg-serverless" ||
        v.remotePath.startsWith("tg-serverless:")
    )
  );
}

/**
 * Attaches a newly uploaded Telegram asset to a MediaItem in `useAppStore` and SQLite `library.db`.
 * Maps directly to the canonical `telegram-drive:` remote, preserving Telegram msgId and chatId.
 */
export async function attachTelegramVersionToItem(
  item: MediaItem,
  tgMeta: {
    msgId: number;
    chatId: string;
    size: number;
    name: string;
    folder?: string;
    remotePath?: string;
    mimeType?: string;
  }
): Promise<MediaItem> {
  const folder = tgMeta.folder || (item.libraryType === "tv" || item.season !== undefined ? "TV Shows - TD" : "Movies TD");
  const tdRemotePath = tgMeta.remotePath || `telegram-drive:${folder}/${tgMeta.name}`;
  const existingVersions: MediaSourceVersion[] =
    item.versions && item.versions.length > 0
      ? [...item.versions]
      : [createVersionFromItem(item, isLocalPath(item.remotePath))];

  const tgVersion: MediaSourceVersion = {
    id: `${item.id}-td-${tgMeta.msgId}`,
    remoteName: "telegram-drive",
    remotePath: tdRemotePath,
    libraryId: item.libraryId,
    resolution: item.resolution,
    videoCodec: item.videoCodec,
    audioCodec: item.audioCodec,
    sizeBytes: tgMeta.size || item.sizeBytes,
    container: tgMeta.name.split(".").pop()?.toLowerCase() || item.filename.split(".").pop()?.toLowerCase(),
    isLocal: false,
    priority: 2, // Tier 1 Cloud CDN priority
    sourceType: "telegram",
    addedAt: Date.now(),
    telegramChatId: tgMeta.chatId,
    telegramMsgId: tgMeta.msgId,
    telegramMimeType: tgMeta.mimeType,
  };

  const filtered = existingVersions.filter(
    (v) => v.telegramMsgId !== tgMeta.msgId && v.remotePath !== tdRemotePath && !v.remotePath.startsWith("tg-serverless:")
  );
  const updatedVersions = [...filtered, tgVersion].sort((a, b) => a.priority - b.priority);

  const updatedItem: MediaItem = {
    ...item,
    versions: updatedVersions,
  };

  useAppStore.getState().upsertMediaItem(updatedItem);
  await persistItems([updatedItem]);
  return updatedItem;
}

/**
 * Queries the embedded Rust MTProto engine `/manifest` endpoint and maps all index entries
 * to any existing matching items in `library.db`.
 */
export async function syncTelegramManifestToLibrary(): Promise<number> {
  try {
    const { telegramConfig } = useAppStore.getState();
    await invoke("telegram_configure_and_connect", {
      apiId: telegramConfig?.apiId ? Number(telegramConfig.apiId) : null,
      apiHash: telegramConfig?.apiHash || null,
      botToken: telegramConfig?.botToken || null,
      defaultChatId: telegramConfig?.chatId || null,
    });
    const entries = await invoke<any[]>("telegram_sync_index", {
      chatId: telegramConfig?.chatId || null,
    });
    let synced = 0;
    for (const entry of entries || []) {
      if (entry && entry.msgId && entry.name) {
        await registerTelegramOffloadResult(entry);
        synced++;
      }
    }
    return synced;
  } catch (e) {
    console.warn("Could not sync Telegram manifest:", e);
    return 0;
  }
}

/**
 * Registers an uploaded Telegram message ID in `library.db` mapped to `telegram-drive:`.
 */
export async function registerTelegramOffloadResult(meta: {
  msgId: number;
  chatId: string;
  name: string;
  size: number;
  folder?: string;
  path?: string;
  remotePath?: string;
  targetItemId?: string;
}): Promise<void> {
  const allItems = useAppStore.getState().mediaItems;
  let targetItem: MediaItem | undefined = meta.targetItemId ? allItems[meta.targetItemId] : undefined;
  if (!targetItem) {
    const cleanName = meta.name.toLowerCase().trim();
    targetItem = Object.values(allItems).find(
      (it) => it.filename.toLowerCase().trim() === cleanName
    );
  }
  if (targetItem && meta.msgId > 0) {
    await attachTelegramVersionToItem(targetItem, {
      msgId: meta.msgId,
      chatId: meta.chatId,
      size: meta.size,
      name: meta.name,
      folder: meta.folder,
      remotePath: meta.remotePath,
    });
  }
}

/**
 * Reconciles the local library index with the actual files in `telegram-drive:`.
 * Detects files renamed or moved using the external Telegram Drive desktop application,
 * updating their `remotePath` while preserving `telegramChatId` and `telegramMsgId`.
 */
export async function reconcileTelegramDriveCatalog(): Promise<number> {
  try {
    const files = await invoke<any[]>("list_remote_path", {
      remote: "telegram-drive",
      path: "",
    });
    if (!Array.isArray(files) || files.length === 0) return 0;

    let updatedCount = 0;
    const items = useAppStore.getState().mediaItems;
    for (const item of Object.values(items)) {
      if (!item.versions) continue;
      let itemChanged = false;
      const updatedVersions = item.versions.map((ver) => {
        if (ver.sourceType === "telegram" || ver.remoteName === "telegram-drive") {
          const currentFilename = ver.remotePath.split("/").pop() || item.filename;
          const match = files.find(
            (f) => f.name && f.name.toLowerCase() === currentFilename.toLowerCase()
          );
          if (match && match.path && `telegram-drive:${match.path}` !== ver.remotePath) {
            itemChanged = true;
            return {
              ...ver,
              remotePath: `telegram-drive:${match.path}`,
            };
          }
        }
        return ver;
      });

      if (itemChanged) {
        const updatedItem = { ...item, versions: updatedVersions };
        useAppStore.getState().upsertMediaItem(updatedItem);
        await persistItems([updatedItem]);
        updatedCount++;
      }
    }
    return updatedCount;
  } catch (e) {
    console.warn("Failed to reconcile Telegram Drive catalog:", e);
    return 0;
  }
}

/**
 * Parses Kaggle or GitHub Actions worker output logs for `RCLONEFLIX_TG_OFFLOAD_RESULT:{...}` lines
 * and automatically maps each uploaded file into `library.db`.
 */
export async function parseAndRegisterTelegramWorkerLogs(logText: string): Promise<number> {
  if (!logText) return 0;
  let count = 0;
  const lines = logText.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf("RCLONEFLIX_TG_OFFLOAD_RESULT:");
    if (idx !== -1) {
      const jsonPart = line.slice(idx + "RCLONEFLIX_TG_OFFLOAD_RESULT:".length).trim();
      try {
        const parsed = JSON.parse(jsonPart);
        if (parsed && parsed.msgId && parsed.name) {
          await registerTelegramOffloadResult(parsed);
          count++;
        }
      } catch (e) {
        console.warn("Failed parsing RCLONEFLIX_TG_OFFLOAD_RESULT JSON:", e);
      }
    }
  }
  return count;
}

/**
 * Uploads a file/stream to Telegram using the embedded native Rust MTProto engine.
 * Local files are uploaded directly via `telegram_upload_local_file` without redundant copying;
 * remote streams are piped via the local WebDAV bridge PUT endpoint.
 */
export async function uploadStreamIn16MbChunksToTelegram(params: {
  streamUrl: string;
  fileName: string;
  totalSize: number;
  chatId: string;
  localFilePath?: string;
  onProgress?: (statusText: string) => void;
}): Promise<{ msgId: number; chatId: string; size: number; mimeType?: string }> {
  const { streamUrl, fileName, totalSize, chatId, localFilePath, onProgress } = params;
  const { telegramConfig } = useAppStore.getState();

  await invoke("telegram_configure_and_connect", {
    apiId: telegramConfig?.apiId ? Number(telegramConfig.apiId) : null,
    apiHash: telegramConfig?.apiHash || null,
    botToken: telegramConfig?.botToken || null,
    defaultChatId: chatId || telegramConfig?.chatId || null,
  });

  if (localFilePath && isLocalPath(localFilePath)) {
    onProgress?.(`Uploading ${fileName} (${(totalSize / (1024 * 1024)).toFixed(1)} MB) via native Rust MTProto...`);
    const entry = await invoke<{
      msgId: number;
      chatId: string;
      size: number;
      mimeType: string;
    }>("telegram_upload_local_file", {
      filePath: localFilePath,
      remotePath: `/${fileName}`,
      chatId,
    });
    return entry;
  }

  onProgress?.(`Uploading ${fileName} (${(totalSize / (1024 * 1024)).toFixed(1)} MB) to Telegram via local WebDAV bridge...`);
  const fileRes = await httpFetch(streamUrl);
  if (!fileRes.ok) {
    throw new Error(`Failed reading source stream (HTTP ${fileRes.status})`);
  }
  const buf = await fileRes.arrayBuffer();
  const baseUrl = await getLocalEngineBaseUrl();
  const putRes = await httpFetch(`${baseUrl}/webdav/${encodeURIComponent(fileName)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(buf),
  });
  if (!putRes.ok) {
    throw new Error(`Local MTProto PUT failed (${putRes.status}): ${await putRes.text()}`);
  }
  const data = await putRes.json();
  const entry = data?.entry;
  return {
    msgId: Number(entry?.msgId || putRes.headers.get("X-Telegram-Msg-Id") || 0),
    chatId: entry?.chatId || chatId,
    size: buf.byteLength,
    mimeType: entry?.mimeType,
  };
}

/**
 * Universal Offload Entrypoint for ANY MediaItem < 2 GB (Video, Audiobook, Music Track, EPUB, PDF).
 * - Mode "direct" (default for local files or small files <= 32 MB):
 *   Streams in 16 MiB Range slices through `/upload-chunk` + `/finalize-upload` up to 2 GB.
 * - Mode "cloud" (default for large remote files > 32 MB when Kaggle/GHA is configured):
 *   Dispatches zero-bandwidth remote-to-remote transfer to Kaggle / GitHub Actions MTProto Worker,
 *   with automatic fallback to direct 16 MiB chunked upload if Cloud Worker is not configured.
 */
export async function offloadMediaItemToTelegram(
  item: MediaItem,
  onProgress?: (statusText: string) => void,
  mode: "auto" | "direct" | "cloud" = "auto"
): Promise<void> {
  const check = canOffloadToTelegram(item);
  if (!check.eligible) {
    useToastStore.getState().addToast(`❌ ${check.reason}`, "error", 6000);
    throw new Error(check.reason);
  }

  const { telegramConfig, rcloneConfigContent, kaggleUsername, kaggleKey, ghaConfig } =
    useAppStore.getState();
  const chatId = telegramConfig?.chatId?.trim() || "-1003872024113";
  const hasCloudWorker =
    Boolean(kaggleUsername?.trim() && kaggleKey?.trim()) ||
    Boolean(ghaConfig?.enabled && ghaConfig?.token?.trim());
  const itemIsLocal = isLocalPath(item.remotePath);
  const isSmallFile =
    item.sizeBytes && item.sizeBytes > 0 && item.sizeBytes <= DIRECT_SINGLE_PUT_MAX_BYTES;

  const useDirectChunked =
    mode === "direct" ||
    itemIsLocal ||
    isSmallFile ||
    !hasCloudWorker;

  if (useDirectChunked) {
    let streamUrl = "";
    let activeSessionId: string | null = null;

    try {
      if (itemIsLocal) {
        const res = await invoke<{ file_url: string }>("start_local_file_stream", {
          filePath: item.remotePath,
        });
        streamUrl = res.file_url;
      } else {
        const colonIdx = item.remotePath.indexOf(":");
        const remoteName = item.remotePath.slice(0, colonIdx);
        const subPath = item.remotePath.slice(colonIdx + 1).replace(/^\/+/, "");
        activeSessionId = `tg-offload-${Date.now()}`;
        const res = await invoke<{ file_url: string }>("start_stream_session", {
          configPath: "",
          remoteRoot: `${remoteName}:`,
          filePath: subPath,
          sessionId: activeSessionId,
        });
        streamUrl = res.file_url;
      }

      let totalSize = item.sizeBytes || 0;
      if (!totalSize) {
        const headRes = await httpFetch(streamUrl, { method: "HEAD" });
        totalSize = parseInt(headRes.headers.get("Content-Length") || "0", 10);
      }
      if (!totalSize || isNaN(totalSize) || totalSize <= 0) {
        throw new Error("Could not determine file size for Telegram offload.");
      }
      if (totalSize > TELEGRAM_MAX_BYTES) {
        throw new Error("File exceeds Telegram 2 GB limit.");
      }

      const uploaded = await uploadStreamIn16MbChunksToTelegram({
        streamUrl,
        fileName: item.filename,
        totalSize,
        chatId,
        localFilePath: itemIsLocal ? item.remotePath : undefined,
        onProgress,
      });

      if (!uploaded.msgId) {
        throw new Error("Telegram upload completed but no message ID was returned.");
      }

      await attachTelegramVersionToItem(item, {
        msgId: uploaded.msgId,
        chatId: uploaded.chatId,
        size: uploaded.size,
        name: item.filename,
        mimeType: uploaded.mimeType,
      });

      useToastStore
        .getState()
        .addToast(`✅ Offloaded "${item.title}" to Telegram CDN (msg #${uploaded.msgId})!`, "success", 6000);
      return;
    } finally {
      if (activeSessionId) {
        invoke("stop_stream_session", { sessionId: activeSessionId }).catch(() => {});
      }
    }
  }

  // Zero-Bandwidth Cloud Worker MTProto Offload (up to 2 GB via Kaggle or GitHub Actions)
  onProgress?.(`Dispatching "${item.title}" (< 2 GB) to Cloud MTProto Offloader...`);
  const jobId = `tg-offload-${Date.now()}`;
  let cleanSource = (item.remotePath || "").trim().replace(/^([a-zA-Z0-9_-]+:)\1+/, "$1");
  const transferPayload = {
    job_id: jobId,
    operation: "copy" as const,
    source: cleanSource,
    destination: `telegram:${chatId}`,
    rclone_config_snippet: rcloneConfigContent || undefined,
    telegram_bot_token: telegramConfig?.botToken || undefined,
    telegram_chat_id: chatId,
    telegram_api_id: telegramConfig?.apiId || undefined,
    telegram_api_hash: telegramConfig?.apiHash || undefined,
  };

  const dispatchRes = await dispatchCloudTask({
    jobType: "rclone_transfer",
    title: `TG Offload ${item.title}`.slice(0, 44),
    payload: transferPayload,
  });

  useCloudTransferStore.getState().addJob({
    id: dispatchRes.jobId || jobId,
    title: `Telegram Offload: ${item.title}`,
    operation: "copy",
    source: cleanSource,
    destination: `telegram:${chatId}`,
    kernelSlug: dispatchRes.kernelSlug || dispatchRes.jobId || jobId,
    kernelUrl: dispatchRes.url,
    provider: dispatchRes.provider,
    status: "queued",
    createdAt: Date.now(),
  });
  if (dispatchRes.provider === "kaggle") {
    initCloudTransferPoller();
  }

  useToastStore
    .getState()
    .addToast(
      `🚀 Dispatched "${item.title}" to Cloud Worker (${dispatchRes.provider === "github_actions" ? "GitHub Actions" : "Kaggle"}) for Telegram 2 GB MTProto Offload!`,
      "info",
      6000
    );
}

/**
 * Offloads a file from Cloud Explorer directly to Telegram (< 2 GB).
 */
export async function offloadExplorerItemToTelegram(
  remoteName: string,
  remoteFilePath: string,
  fileName: string,
  sizeBytes: number,
  onProgress?: (statusText: string) => void
): Promise<void> {
  if (sizeBytes > TELEGRAM_MAX_BYTES) {
    const gb = (sizeBytes / (1024 * 1024 * 1024)).toFixed(2);
    useToastStore.getState().addToast(`❌ File is ${gb} GB, which exceeds Telegram's 2.00 GB limit.`, "error", 6000);
    throw new Error("File exceeds 2 GB limit.");
  }

  const { telegramConfig, rcloneConfigContent, kaggleUsername, kaggleKey, ghaConfig } = useAppStore.getState();
  const chatId = telegramConfig?.chatId?.trim() || "-1003872024113";
  const hasCloudWorker =
    Boolean(kaggleUsername?.trim() && kaggleKey?.trim()) ||
    Boolean(ghaConfig?.enabled && ghaConfig?.token?.trim());
  const itemIsLocal = remoteName === "local" || isLocalPath(remoteFilePath);
  const isSmallFile = sizeBytes > 0 && sizeBytes <= DIRECT_SINGLE_PUT_MAX_BYTES;

  if (itemIsLocal || isSmallFile || !hasCloudWorker) {
    let streamUrl = "";
    let activeSessionId: string | null = null;
    try {
      if (itemIsLocal) {
        const res = await invoke<{ file_url: string }>("start_local_file_stream", {
          filePath: remoteFilePath,
        });
        streamUrl = res.file_url;
      } else {
        activeSessionId = `tg-offload-${Date.now()}`;
        const cleanRemoteName = remoteName.replace(/:+$/, "");
        let relFilePath = remoteFilePath.trim();
        if (relFilePath.toLowerCase().startsWith(`${cleanRemoteName.toLowerCase()}:`)) {
          relFilePath = relFilePath.slice(cleanRemoteName.length + 1);
        }
        relFilePath = relFilePath.replace(/^\/+/, "");
        const res = await invoke<{ file_url: string }>("start_stream_session", {
          configPath: "",
          remoteRoot: `${cleanRemoteName}:`,
          filePath: relFilePath,
          sessionId: activeSessionId,
        });
        streamUrl = res.file_url;
      }

      let totalSize = sizeBytes;
      if (!totalSize || totalSize <= 0) {
        const headRes = await httpFetch(streamUrl, { method: "HEAD" });
        totalSize = parseInt(headRes.headers.get("Content-Length") || "0", 10);
      }
      if (!totalSize || totalSize <= 0) {
        throw new Error("Could not determine file size for Telegram offload.");
      }

      const uploaded = await uploadStreamIn16MbChunksToTelegram({
        streamUrl,
        fileName,
        totalSize,
        chatId,
        onProgress,
      });

      if (!uploaded.msgId) {
        throw new Error("Telegram upload completed but no message ID was returned.");
      }

      await registerTelegramOffloadResult({
        msgId: uploaded.msgId,
        chatId: uploaded.chatId,
        name: fileName,
        size: uploaded.size,
      });

      useToastStore
        .getState()
        .addToast(`✅ Offloaded "${fileName}" to Telegram CDN (msg #${uploaded.msgId})! Available on tg-serverless:`, "success", 6000);
      return;
    } finally {
      if (activeSessionId) {
        invoke("stop_stream_session", { sessionId: activeSessionId }).catch(() => {});
      }
    }
  }

  // Cloud Worker MTProto Offload
  onProgress?.(`Dispatching "${fileName}" to Cloud MTProto Offloader...`);
  const jobId = `tg-offload-${Date.now()}`;
  let cleanSource = remoteFilePath.trim();
  if (!cleanSource.includes(":")) {
    cleanSource = `${remoteName}:${cleanSource}`;
  }
  cleanSource = cleanSource.replace(/^([a-zA-Z0-9_-]+:)\1+/, "$1");

  const transferPayload = {
    job_id: jobId,
    operation: "copy" as const,
    source: cleanSource,
    destination: `telegram:${chatId}`,
    rclone_config_snippet: rcloneConfigContent || undefined,
    telegram_bot_token: telegramConfig?.botToken || undefined,
    telegram_chat_id: chatId,
    telegram_api_id: telegramConfig?.apiId || undefined,
    telegram_api_hash: telegramConfig?.apiHash || undefined,
  };

  const dispatchRes = await dispatchCloudTask({
    jobType: "rclone_transfer",
    title: `TG Offload ${fileName}`.slice(0, 44),
    payload: transferPayload,
  });

  useCloudTransferStore.getState().addJob({
    id: dispatchRes.jobId || jobId,
    title: `Telegram Offload: ${fileName}`,
    operation: "copy",
    source: cleanSource,
    destination: `telegram:${chatId}`,
    kernelSlug: dispatchRes.kernelSlug || dispatchRes.jobId || jobId,
    kernelUrl: dispatchRes.url,
    provider: dispatchRes.provider,
    status: "queued",
    createdAt: Date.now(),
  });
  if (dispatchRes.provider === "kaggle") {
    initCloudTransferPoller();
  }

  useToastStore
    .getState()
    .addToast(
      `🚀 Dispatched "${fileName}" to Cloud Worker (${dispatchRes.provider === "github_actions" ? "GitHub Actions" : "Kaggle"}) for Telegram MTProto Offload!`,
      "info",
      6000
    );
}
