import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type MediaItem } from "../store/appStore";
import { useToastStore } from "../store/toastStore";
import { log } from "./log";
import { createVersionFromItem } from "./multiVersion";
import { persistItems } from "./libraryDb";

let isOffloading = false;
let offloadTimer: ReturnType<typeof setTimeout> | null = null;

export async function pushItemToStreamtape(
  item: MediaItem,
  onProgress?: (msg: string) => void
): Promise<boolean> {
  const { rcloneConfigPath, streamtapeConfig, upsertMediaItem } = useAppStore.getState();
  const addToast = useToastStore.getState().addToast;

  if (!streamtapeConfig?.enabled || !streamtapeConfig?.apiLogin || !streamtapeConfig?.apiKey) {
    addToast("Streamtape is not configured. Please enter your API ID and Key in Settings.", "error");
    return false;
  }

  // Ensure AList daemon is running
  try {
    await invoke("start_alist_daemon", {
      configPath: rcloneConfigPath,
      apiLogin: streamtapeConfig.apiLogin,
      apiKey: streamtapeConfig.apiKey,
    });
  } catch (err) {
    console.warn("Failed to verify AList daemon before push:", err);
  }

  const categoryDir = item.libraryType === "tv" ? "TV" : "Movies";
  const targetFolder = `streamtape:${categoryDir}`;
  const filename = item.filename || item.remotePath.split("/").pop() || "media.mp4";
  const targetRemotePath = `${targetFolder}/${filename}`;

  addToast(`Pushing "${item.title}" to Streamtape CDN cache...`, "info");
  onProgress?.("Uploading to Streamtape...");

  try {
    await invoke("rclone_copy_file", {
      configPath: rcloneConfigPath,
      sourceRemotePath: item.remotePath,
      targetRemotePath,
    });

    // Resolve public Streamtape shareUrl so Guest Passes and Android can stream without local AList
    let resolvedShareUrl: string | undefined;
    try {
      const login = encodeURIComponent(streamtapeConfig.apiLogin.trim());
      const key = encodeURIComponent(streamtapeConfig.apiKey.trim());
      const listResp = await fetch(`https://api.streamtape.com/file/listfolder?login=${login}&key=${key}`);
      if (listResp.ok) {
        const listJson = await listResp.json();
        const folders: any[] = listJson?.result?.folders || [];
        const files: any[] = listJson?.result?.files || [];
        let matchedFile = files.find((f) => f.name === filename);
        if (!matchedFile) {
          const catFolder = folders.find((fl) => fl.name?.toLowerCase() === categoryDir.toLowerCase());
          if (catFolder?.id) {
            const subResp = await fetch(
              `https://api.streamtape.com/file/listfolder?login=${login}&key=${key}&folder=${encodeURIComponent(catFolder.id)}`
            );
            if (subResp.ok) {
              const subJson = await subResp.json();
              const subFiles: any[] = subJson?.result?.files || [];
              matchedFile = subFiles.find((f) => f.name === filename);
            }
          }
        }
        if (matchedFile?.linkid) {
          resolvedShareUrl = `https://streamtape.com/v/${matchedFile.linkid}`;
        } else if (matchedFile?.link) {
          resolvedShareUrl = matchedFile.link;
        }
      }
    } catch {}

    // Add Streamtape version to media item
    const streamtapeVersion = {
      id: `${item.id}-streamtape-2`,
      remoteName: "streamtape",
      remotePath: targetRemotePath,
      libraryId: item.libraryId,
      resolution: item.resolution,
      videoCodec: item.videoCodec,
      audioCodec: item.audioCodec,
      sizeBytes: item.sizeBytes,
      container: item.filename.split(".").pop()?.toLowerCase(),
      isLocal: false,
      priority: 2,
      sourceType: "streamtape" as const,
      shareUrl: resolvedShareUrl,
      addedAt: Date.now(),
    };

    const existingVersions = item.versions && item.versions.length > 0
      ? item.versions.filter((v) => !v.remoteName.toLowerCase().includes("streamtape"))
      : [createVersionFromItem(item)];

    const updatedItem: MediaItem = {
      ...item,
      versions: [streamtapeVersion, ...existingVersions].sort((a, b) => a.priority - b.priority),
    };

    upsertMediaItem(updatedItem);
    await persistItems([updatedItem]);

    addToast(`"${item.title}" successfully cached to Streamtape CDN!`, "success");
    log.info("streamtape", `Cached "${item.title}" to Streamtape at ${targetRemotePath}`);

    // Cloud-to-cloud rolling relay auto-mirror
    const { doodstreamConfig } = useAppStore.getState();
    if (doodstreamConfig?.enabled && doodstreamConfig?.autoMirror) {
      import("./doodstreamOffload").then(({ cloneStreamtapeToDoodstream }) => {
        cloneStreamtapeToDoodstream(updatedItem).catch((err) => {
          log.warn("streamtape", `Background auto-mirror to Doodstream failed: ${err}`);
        });
      });
    }

    return true;
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error("Streamtape push failed:", msg);
    addToast(`Streamtape offload failed: ${msg}`, "error");
    log.error("streamtape", `Offload failed for ${item.title}: ${msg}`);
    return false;
  }
}

/**
 * Background offload worker.
 * Scans newest library releases and pushes them sequentially to Streamtape.
 * Enforces a strict 1-hour time budget and single-transfer throttling to protect cloud quotas.
 */
export async function runAutoStreamtapeOffload(maxDurationMinutes = 60): Promise<void> {
  if (isOffloading) {
    log.info("streamtape", "Auto-offload already in progress; skipping trigger");
    return;
  }

  const { streamtapeConfig, mediaItems, rcloneConfigPath, upsertMediaItem } = useAppStore.getState();
  if (
    !streamtapeConfig?.enabled ||
    !streamtapeConfig?.autoOffload ||
    !streamtapeConfig?.apiLogin ||
    !streamtapeConfig?.apiKey
  ) {
    return;
  }

  isOffloading = true;
  const startTime = Date.now();
  const maxDurationMs = maxDurationMinutes * 60 * 1000;

  log.info("streamtape", `Starting auto-offload session (budget: ${maxDurationMinutes} min)`);

  try {
    // 1. Ensure AList daemon is active
    await invoke("start_alist_daemon", {
      configPath: rcloneConfigPath,
      apiLogin: streamtapeConfig.apiLogin,
      apiKey: streamtapeConfig.apiKey,
    });

    // 2. Select eligible library items
    const allowedLibs = streamtapeConfig.autoOffloadLibraries || [];
    const all = Object.values(mediaItems);

    const candidates = all
      .filter((item) => {
        if (item.libraryType !== "movies" && item.libraryType !== "tv") return false;
        if (allowedLibs.length > 0 && !allowedLibs.includes(item.libraryId)) return false;
        // Zero-API check: already has a Streamtape version?
        const hasStreamtape = item.versions?.some((v) =>
          v.remoteName.toLowerCase().includes("streamtape") ||
          v.remotePath.toLowerCase().includes("streamtape")
        );
        return !hasStreamtape;
      })
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)); // Newest first

    log.info("streamtape", `Found ${candidates.length} candidates for Streamtape offload`);

    let processedCount = 0;
    for (const item of candidates) {
      if (Date.now() - startTime > maxDurationMs) {
        log.info("streamtape", `Time budget of ${maxDurationMinutes}m exceeded. Pausing offloader.`);
        break;
      }

      const categoryDir = item.libraryType === "tv" ? "TV" : "Movies";
      const targetFolder = `streamtape:${categoryDir}`;
      const filename = item.filename || item.remotePath.split("/").pop() || "media.mp4";
      const targetRemotePath = `${targetFolder}/${filename}`;

      try {
        log.info("streamtape", `Offloading [${processedCount + 1}/${candidates.length}]: ${item.title}`);
        await invoke("rclone_copy_file", {
          configPath: rcloneConfigPath,
          sourceRemotePath: item.remotePath,
          targetRemotePath,
        });

        const streamtapeVersion = {
          id: `${item.id}-streamtape-2`,
          remoteName: "streamtape",
          remotePath: targetRemotePath,
          libraryId: item.libraryId,
          resolution: item.resolution,
          videoCodec: item.videoCodec,
          audioCodec: item.audioCodec,
          sizeBytes: item.sizeBytes,
          container: item.filename.split(".").pop()?.toLowerCase(),
          isLocal: false,
          priority: 2,
          sourceType: "streamtape" as const,
          addedAt: Date.now(),
        };

        const existingVersions = item.versions && item.versions.length > 0
          ? item.versions.filter((v) => !v.remoteName.toLowerCase().includes("streamtape"))
          : [createVersionFromItem(item)];

        const updatedItem: MediaItem = {
          ...item,
          versions: [streamtapeVersion, ...existingVersions].sort((a, b) => a.priority - b.priority),
        };

        upsertMediaItem(updatedItem);
        await persistItems([updatedItem]);
        processedCount++;
      } catch (copyErr) {
        log.warn("streamtape", `Failed offloading ${item.title}: ${copyErr}`);
      }
    }

    log.info("streamtape", `Completed auto-offload session. Offloaded ${processedCount} items.`);
  } catch (err) {
    log.error("streamtape", `Auto-offload error: ${err}`);
  } finally {
    isOffloading = false;
  }
}

/**
 * Initializes the background scheduler for automatic Streamtape offloads.
 */
export function initStreamtapeOffloaderPoller(): () => void {
  // Auto-start AList daemon if Streamtape is enabled
  const { rcloneConfigPath, streamtapeConfig } = useAppStore.getState();
  if (streamtapeConfig?.enabled && streamtapeConfig?.apiLogin && streamtapeConfig?.apiKey) {
    invoke("start_alist_daemon", {
      configPath: rcloneConfigPath,
      apiLogin: streamtapeConfig.apiLogin,
      apiKey: streamtapeConfig.apiKey,
    }).catch((err) => console.warn("Failed to auto-start AList daemon on startup:", err));
  }

  const runCycle = () => {
    runAutoStreamtapeOffload(60).catch(() => {});
  };

  // Run initial offload check 2 minutes after startup
  const initialTimeout = setTimeout(runCycle, 2 * 60 * 1000);

  // Re-run every 6 hours
  const interval = setInterval(runCycle, 6 * 60 * 60 * 1000);

  return () => {
    clearTimeout(initialTimeout);
    clearInterval(interval);
  };
}
