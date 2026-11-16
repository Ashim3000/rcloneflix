import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useAppStore, isLocalPath, type MediaItem } from "../store/appStore";
import { useToastStore } from "../store/toastStore";

export type DownloadItem = {
  remote_path: string;
  filename: string;
  subfolder?: string;
};

export type DownloadProgressEvent = {
  download_id: string;
  total_files: number;
  completed_files: number;
  current_file: string;
  destination_path: string;
  status: "downloading" | "completed" | "error";
  error?: string;
};

export type ActiveDownload = {
  id: string;
  title: string;
  totalFiles: number;
  completedFiles: number;
  currentFile: string;
  destinationPath: string;
  status: "downloading" | "completed" | "error";
  error?: string;
  timestamp: number;
};

interface DownloadStore {
  downloads: Record<string, ActiveDownload>;
  activeToastId: string | null;
  setDownload: (id: string, update: Partial<ActiveDownload>) => void;
  removeDownload: (id: string) => void;
  dismissToast: () => void;
}

export const useDownloadStore = create<DownloadStore>((set) => ({
  downloads: {},
  activeToastId: null,
  setDownload: (id, update) =>
    set((state) => {
      const existing = state.downloads[id] || {
        id,
        title: "",
        totalFiles: 1,
        completedFiles: 0,
        currentFile: "",
        destinationPath: "",
        status: "downloading",
        timestamp: Date.now(),
      };
      return {
        downloads: {
          ...state.downloads,
          [id]: { ...existing, ...update },
        },
        activeToastId: id,
      };
    }),
  removeDownload: (id) =>
    set((state) => {
      const next = { ...state.downloads };
      delete next[id];
      return {
        downloads: next,
        activeToastId: state.activeToastId === id ? null : state.activeToastId,
      };
    }),
  dismissToast: () => set({ activeToastId: null }),
}));

// Initialize event listener for Tauri download-progress events
let listenerInitialized = false;
export function initDownloadListener() {
  if (listenerInitialized) return;
  listenerInitialized = true;

  listen<DownloadProgressEvent>("download-progress", (event) => {
    const payload = event.payload;
    const store = useDownloadStore.getState();
    const existing = store.downloads[payload.download_id];
    const title = existing?.title || payload.current_file;

    store.setDownload(payload.download_id, {
      totalFiles: payload.total_files,
      completedFiles: payload.completed_files,
      currentFile: payload.current_file,
      destinationPath: payload.destination_path,
      status: payload.status,
      error: payload.error,
    });

    if (payload.status === "completed") {
      useToastStore.getState().addToast(
        `Downloaded "${title}"`,
        "success",
        8000,
        {
          label: "Open Folder",
          onClick: () => openDownloadFolder(payload.destination_path),
        }
      );
    } else if (payload.status === "error") {
      useToastStore.getState().addToast(
        `Download error for "${title}": ${payload.error || "Unknown error"}`,
        "error",
        7000
      );
    }
  });
}

/** Open the destination folder in the OS file manager */
export async function openDownloadFolder(path?: string): Promise<void> {
  try {
    await invoke("open_download_folder", { path: path || null });
  } catch (err) {
    console.error("Failed to open download folder:", err);
  }
}

/** Start a generic download batch */
export async function startDownloadJob(
  title: string,
  items: DownloadItem[]
): Promise<string | null> {
  const remoteItems = items.filter((i) => !isLocalPath(i.remote_path));
  const configPath = useAppStore.getState().rcloneConfigPath;
  if (!configPath || remoteItems.length === 0) return null;

  initDownloadListener();

  const downloadId = `dl-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  useDownloadStore.getState().setDownload(downloadId, {
    id: downloadId,
    title,
    totalFiles: remoteItems.length,
    completedFiles: 0,
    currentFile: remoteItems[0].filename,
    status: "downloading",
    timestamp: Date.now(),
  });

  useToastStore.getState().addToast(
    `Downloading "${title}" (${remoteItems.length} ${remoteItems.length === 1 ? "file" : "files"})…`,
    "info",
    3500
  );

  try {
    const destDir = await invoke<string>("start_download", {
      configPath,
      downloadId,
      items: remoteItems,
      destinationDir: null,
    });
    useDownloadStore.getState().setDownload(downloadId, { destinationPath: destDir });
    return downloadId;
  } catch (err) {
    const errorMsg = String(err);
    useDownloadStore.getState().setDownload(downloadId, {
      status: "error",
      error: errorMsg,
    });
    useToastStore.getState().addToast(`Failed to start download: ${errorMsg}`, "error", 5000);
    return null;
  }
}

/** Helper to compute subfolder based on library type and media metadata */
export function getMediaSubfolder(item: MediaItem): string {
  switch (item.libraryType) {
    case "tv": {
      const show = item.showTitle || item.title || "TV Shows";
      const season = item.season !== undefined ? `Season ${item.season}` : "Season 1";
      return `TV/${show}/${season}`;
    }
    case "music": {
      const artist = item.artist || "Unknown Artist";
      const album = item.album || "Unknown Album";
      return `Music/${artist}/${album}`;
    }
    case "movies": {
      return `Movies/${item.title || "Movies"}`;
    }
    case "books":
    case "audiobooks": {
      const author = item.author || item.artist || "Unknown Author";
      return `Books/${author}`;
    }
    case "adult": {
      return `Adult/${item.title || "Media"}`;
    }
    default:
      return "Media";
  }
}

/** Download a single media item */
export async function downloadSingleItem(item: MediaItem): Promise<string | null> {
  if (isLocalPath(item.remotePath)) {
    useToastStore.getState().addToast(`"${item.title}" is already stored locally on your device`, "info");
    return null;
  }
  const subfolder = getMediaSubfolder(item);
  const title = item.episodeTitle || item.title || item.filename;
  return startDownloadJob(title, [
    {
      remote_path: item.remotePath,
      filename: item.filename,
      subfolder,
    },
  ]);
}

/** Download an entire TV season */
export async function downloadSeason(
  episodes: MediaItem[],
  showTitle: string,
  seasonNum: number
): Promise<string | null> {
  const show = showTitle || "TV Show";
  const subfolder = `TV/${show}/Season ${seasonNum}`;
  const remoteEpisodes = episodes.filter((ep) => !isLocalPath(ep.remotePath));
  if (remoteEpisodes.length === 0) {
    useToastStore.getState().addToast(`All episodes of ${show} Season ${seasonNum} are already stored locally`, "info");
    return null;
  }
  const items: DownloadItem[] = remoteEpisodes.map((ep) => ({
    remote_path: ep.remotePath,
    filename: ep.filename,
    subfolder,
  }));
  return startDownloadJob(`${show} Season ${seasonNum}`, items);
}

/** Download an entire Music album */
export async function downloadAlbum(
  tracks: MediaItem[],
  albumTitle: string,
  artistName?: string
): Promise<string | null> {
  const artist = artistName || tracks[0]?.artist || "Unknown Artist";
  const subfolder = `Music/${artist}/${albumTitle}`;
  const remoteTracks = tracks.filter((t) => !isLocalPath(t.remotePath));
  if (remoteTracks.length === 0) {
    useToastStore.getState().addToast(`All tracks of "${albumTitle}" are already stored locally`, "info");
    return null;
  }
  const items: DownloadItem[] = remoteTracks.map((t) => ({
    remote_path: t.remotePath,
    filename: t.filename,
    subfolder,
  }));
  return startDownloadJob(`${albumTitle} by ${artist}`, items);
}

/**
 * Quickly checks if an item is already downloaded to local storage.
 * Takes < 0.2ms and returns the local file path, or null if not downloaded.
 */
export async function getDownloadedFilePath(item: MediaItem): Promise<string | null> {
  // If item is already on a local folder path, return it directly (< 0.01ms)
  if (isLocalPath(item.remotePath)) {
    return item.remotePath;
  }
  try {
    const subfolder = getMediaSubfolder(item);
    const localPath = await invoke<string | null>("find_downloaded_file", {
      subfolder,
      filename: item.filename,
    });
    return localPath || null;
  } catch {
    return null;
  }
}

