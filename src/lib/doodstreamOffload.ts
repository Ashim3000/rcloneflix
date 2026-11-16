import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore, type MediaItem } from "../store/appStore";
import { useToastStore } from "../store/toastStore";
import { log } from "./log";
import { createVersionFromItem, type MediaSourceVersion } from "./multiVersion";
import { persistItems } from "./libraryDb";
import { getNextIteratedFilename, extractIterationNumber } from "./cyberlockerVersion";

const DOOD_BASE_URLS = [
  "https://doodapi.co/api",
  "https://doodstream.com/api",
  "https://dood.to/api",
];

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
 * Triggers a zero-bandwidth remote URL upload directly to DoodStream servers.
 */
export async function doodstreamRemoteUpload(
  streamUrl: string,
  title?: string,
  folderId?: string
): Promise<{ fileCode: string; downloadUrl: string; shareUrl: string } | null> {
  const { doodstreamConfig } = useAppStore.getState();
  if (!doodstreamConfig?.apiKey) {
    throw new Error("DoodStream API Key is not configured in Settings.");
  }

  const apiKey = doodstreamConfig.apiKey.trim();
  const titleParam = title ? `&new_title=${encodeURIComponent(title)}` : "";
  const folderParam = folderId ? `&fld_id=${encodeURIComponent(folderId)}` : "";

  let lastError: any = null;

  for (const base of DOOD_BASE_URLS) {
    const uploadUrl = `${base}/upload/url?key=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(streamUrl)}${titleParam}${folderParam}`;
    try {
      const resp = await httpFetch(uploadUrl);
      if (!resp.ok) {
        lastError = new Error(`HTTP ${resp.status} from ${base}`);
        continue;
      }
      const data = await resp.json();
      if (data && (data.status === 200 || data.msg === "OK") && data.result) {
        const fileCode = data.result.filecode || data.result.file_code;
        const downloadUrl = data.result.download_url || `https://dood.to/d/${fileCode}`;
        const shareUrl = `https://dood.to/e/${fileCode}`;
        log.info("doodstream", `Remote URL upload queued successfully: ${fileCode}`);
        return { fileCode, downloadUrl, shareUrl };
      } else {
        lastError = new Error(data?.msg || "Upload URL failed on DoodStream");
      }
    } catch (err) {
      lastError = err;
    }
  }

  log.error("doodstream", `Failed doodstreamRemoteUpload across all endpoints: ${lastError}`);
  throw lastError || new Error("DoodStream remote upload failed");
}

/**
 * Checks the status of an ongoing DoodStream remote URL download.
 */
export async function checkDoodstreamRemoteUploadStatus(
  fileCode: string
): Promise<{ status: string; progress?: number; isComplete: boolean }> {
  const { doodstreamConfig } = useAppStore.getState();
  if (!doodstreamConfig?.apiKey) {
    return { status: "UNCONFIGURED", isComplete: false };
  }

  const apiKey = doodstreamConfig.apiKey.trim();
  for (const base of DOOD_BASE_URLS) {
    const statusUrl = `${base}/urlupload/status?key=${encodeURIComponent(apiKey)}&file_code=${encodeURIComponent(fileCode)}`;
    try {
      const resp = await httpFetch(statusUrl);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data && data.result && Array.isArray(data.result) && data.result.length > 0) {
        const item = data.result[0];
        const statusStr = (item.status || "").toUpperCase();
        const isComplete = statusStr === "OK" || statusStr === "COMPLETED";
        const progress = item.bytes_total > 0
          ? Math.round((item.bytes_downloaded / item.bytes_total) * 100)
          : undefined;
        return { status: statusStr, progress, isComplete };
      }
    } catch {
      // try next base
    }
  }
  return { status: "UNKNOWN", isComplete: false };
}

/**
 * Pushes a media item to DoodStream CDN.
 * If a Streamtape link is already available, uses cloud-to-cloud cloning for zero local bandwidth.
 */
export async function pushItemToDoodstream(
  item: MediaItem,
  onProgress?: (msg: string) => void
): Promise<boolean> {
  const { doodstreamConfig, upsertMediaItem } = useAppStore.getState();
  const addToast = useToastStore.getState().addToast;

  if (!doodstreamConfig?.enabled || !doodstreamConfig?.apiKey) {
    addToast("DoodStream is not enabled. Please configure your API key in Settings.", "error");
    return false;
  }

  const existingStreamtape = item.versions?.find(
    (v) => v.sourceType === "streamtape" || v.remoteName === "streamtape" || v.shareUrl?.includes("streamtape")
  );

  addToast(`Queuing "${item.title}" for DoodStream CDN mirror...`, "info");
  onProgress?.("Resolving stream source...");

  try {
    let sourceStreamUrl = "";

    // 1. If Streamtape version exists, resolve its direct stream URL for zero-bandwidth cloud clone
    if (existingStreamtape?.shareUrl) {
      try {
        const resolved = await invoke<string>("resolve_web_stream_url", {
          url: existingStreamtape.shareUrl,
        });
        if (resolved && resolved.startsWith("http")) {
          sourceStreamUrl = resolved;
          log.info("doodstream", `Using resolved Streamtape direct link for cloud-to-cloud clone`);
        }
      } catch (err) {
        log.warn("doodstream", `Failed resolving Streamtape shareUrl: ${err}`);
      }
    }

    // 2. Fall back to item's direct stream URL or source URL
    if (!sourceStreamUrl && item.streamUrl?.startsWith("http")) {
      sourceStreamUrl = item.streamUrl;
    } else if (!sourceStreamUrl && item.sourceUrl?.startsWith("http")) {
      sourceStreamUrl = item.sourceUrl;
    }

    if (!sourceStreamUrl) {
      throw new Error("No direct stream URL available for cloud-to-cloud upload. Media must be accessible online or cached on Streamtape first.");
    }

    const currentIter = extractIterationNumber(item.filename || item.title);
    const nextFilename = getNextIteratedFilename(
      item.filename || `${item.title}.mp4`,
      Math.max(2, currentIter)
    );

    onProgress?.("Triggering DoodStream cloud transfer...");
    const res = await doodstreamRemoteUpload(sourceStreamUrl, nextFilename);
    if (!res) {
      throw new Error("DoodStream returned empty upload result");
    }

    const doodVersion: MediaSourceVersion = {
      id: `${item.id}-doodstream-${currentIter}`,
      remoteName: "doodstream",
      remotePath: `doodstream:${res.fileCode}`,
      libraryId: item.libraryId,
      resolution: item.resolution,
      videoCodec: item.videoCodec,
      audioCodec: item.audioCodec,
      sizeBytes: item.sizeBytes,
      container: (item.filename || "media.mp4").split(".").pop()?.toLowerCase(),
      isLocal: false,
      priority: 3,
      sourceType: "doodstream",
      shareUrl: res.shareUrl,
      addedAt: Date.now(),
      lastKeepAliveAt: Date.now(),
      iteration: currentIter,
    };

    const existingVersions = (item.versions && item.versions.length > 0
      ? item.versions.filter((v) => !v.remoteName.toLowerCase().includes("dood"))
      : [createVersionFromItem(item)]
    );

    const updatedItem: MediaItem = {
      ...item,
      versions: [...existingVersions, doodVersion].sort((a, b) => a.priority - b.priority),
    };

    upsertMediaItem(updatedItem);
    await persistItems([updatedItem]);

    addToast(`"${item.title}" successfully mirrored to DoodStream CDN!`, "success");
    log.info("doodstream", `Mirrored "${item.title}" to DoodStream (${res.fileCode})`);
    return true;
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error("DoodStream push failed:", msg);
    addToast(`DoodStream mirror failed: ${msg}`, "error");
    log.error("doodstream", `Mirror failed for ${item.title}: ${msg}`);
    return false;
  }
}

/**
 * Cloud-to-cloud clone: Replicates a Streamtape file to DoodStream with 0 MB local bandwidth.
 */
export async function cloneStreamtapeToDoodstream(
  item: MediaItem,
  onProgress?: (msg: string) => void
): Promise<boolean> {
  const streamtapeVer = item.versions?.find(
    (v) => v.sourceType === "streamtape" || v.remoteName === "streamtape" || v.shareUrl?.includes("streamtape")
  );
  if (!streamtapeVer?.shareUrl) {
    log.warn("doodstream", `Cannot clone: "${item.title}" does not have an active Streamtape share URL.`);
    return false;
  }
  return await pushItemToDoodstream(item, onProgress);
}

/**
 * Cloud-to-cloud clone in reverse:
 * When a Streamtape file expires or is removed, auto-reupload to Streamtape
 * using the surviving DoodStream file URL.
 * Iterates the filename (_v2 -> _v3) to bypass automated DMCA filename blocks.
 */
export async function cloneDoodstreamToStreamtape(
  item: MediaItem,
  onProgress?: (msg: string) => void
): Promise<boolean> {
  const { streamtapeConfig, upsertMediaItem } = useAppStore.getState();
  const addToast = useToastStore.getState().addToast;

  if (!streamtapeConfig?.enabled || !streamtapeConfig?.apiLogin || !streamtapeConfig?.apiKey) {
    log.warn("doodstream", "Cannot heal to Streamtape: Streamtape API credentials missing.");
    return false;
  }

  const doodVer = item.versions?.find(
    (v) => v.sourceType === "doodstream" || v.remoteName === "doodstream" || v.shareUrl?.includes("dood")
  );
  if (!doodVer?.shareUrl) {
    log.warn("doodstream", `Cannot heal: "${item.title}" does not have an active DoodStream version.`);
    return false;
  }

  log.info("doodstream", `Auto-healing Streamtape from DoodStream for "${item.title}"`);
  onProgress?.("Resolving DoodStream stream for cloud re-clone...");

  try {
    const directDoodUrl = await invoke<string>("resolve_web_stream_url", {
      url: doodVer.shareUrl,
    });
    if (!directDoodUrl || !directDoodUrl.startsWith("http")) {
      throw new Error("Failed to extract direct stream URL from DoodStream.");
    }

    // Increment DMCA filename version
    const currentIter = doodVer.iteration || extractIterationNumber(item.filename || item.title);
    const nextIter = currentIter + 1;
    const nextFilename = getNextIteratedFilename(
      item.filename || `${item.title}.mp4`,
      nextIter
    );

    // Call Streamtape remotedl/add
    const login = streamtapeConfig.apiLogin.trim();
    const key = streamtapeConfig.apiKey.trim();
    const remoteAddUrl = `https://api.streamtape.com/remotedl/add?login=${encodeURIComponent(login)}&key=${encodeURIComponent(key)}&url=${encodeURIComponent(directDoodUrl)}&name=${encodeURIComponent(nextFilename)}`;

    onProgress?.("Initiating Streamtape remote download...");
    const resp = await httpFetch(remoteAddUrl);
    if (!resp.ok) {
      throw new Error(`Streamtape remotedl returned HTTP ${resp.status}`);
    }

    const data = await resp.json();
    if (data && data.status === 200 && data.result) {
      const remoteTaskId = data.result.id;
      log.info("doodstream", `Streamtape remote download queued: ${remoteTaskId}`);

      const categoryDir = item.libraryType === "tv" ? "TV" : "Movies";
      const targetRemotePath = `streamtape:${categoryDir}/${nextFilename}`;

      const newStreamtapeVer: MediaSourceVersion = {
        id: `${item.id}-streamtape-${nextIter}`,
        remoteName: "streamtape",
        remotePath: targetRemotePath,
        libraryId: item.libraryId,
        resolution: item.resolution,
        videoCodec: item.videoCodec,
        audioCodec: item.audioCodec,
        sizeBytes: item.sizeBytes,
        container: nextFilename.split(".").pop()?.toLowerCase(),
        isLocal: false,
        priority: 2,
        sourceType: "streamtape",
        shareUrl: data.result.url || undefined,
        addedAt: Date.now(),
        lastKeepAliveAt: Date.now(),
        iteration: nextIter,
      };

      const existingVersions = (item.versions && item.versions.length > 0
        ? item.versions.filter((v) => !v.remoteName.toLowerCase().includes("streamtape"))
        : [createVersionFromItem(item)]
      );

      const updatedItem: MediaItem = {
        ...item,
        versions: [newStreamtapeVer, ...existingVersions].sort((a, b) => a.priority - b.priority),
      };

      upsertMediaItem(updatedItem);
      await persistItems([updatedItem]);

      addToast(`"${item.title}" successfully re-seeded to Streamtape (v${nextIter})!`, "success");
      log.info("doodstream", `Completed cloud-to-cloud healing for "${item.title}" (v${nextIter})`);
      return true;
    } else {
      throw new Error(data?.msg || "Streamtape remotedl failed");
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    log.error("doodstream", `Failed cloud healing for ${item.title}: ${msg}`);
    return false;
  }
}
