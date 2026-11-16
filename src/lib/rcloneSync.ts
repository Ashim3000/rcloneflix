/**
 * Backup and restore through an rclone remote.
 *
 * This is the sync path that doesn't need OAuth. The user's rclone config
 * already authenticates every remote they own, so a backup is just a file
 * written to one of them. Any device with the same rclone.conf can read it.
 *
 * Restore merges rather than overwrites: watch progress takes whichever side
 * was watched more recently, so two devices converge instead of the last one
 * to sync winning.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  useAppStore,
  type Library,
  type MediaItem,
  type PlaybackSettings,
  type WatchProgress,
  type Playlist,
  type IptvConfig,
  type AudioBookmark,
} from "../store/appStore";
import { log } from "./log";
import { getUserBookmarks, type SiteBookmark } from "./siteBookmarks";
import {
  persistItems,
  persistProgress,
  persistPlaylists,
  persistFavorites,
} from "./libraryDb";
import { encryptBytes, decryptBytes } from "./crypto";

export const BACKUP_DIR = "RcloneFlix";
export const BACKUP_FILE = "rcloneflix-backup.json.gz";
export const ENCRYPTED_BACKUP_PREFIX = "RFLIX_ENC1:";

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export type BackupPayload = {
  version: 2 | 3;
  exportedAt: number;
  deviceName: string;
  settings: {
    libraries: Library[];
    playback: PlaybackSettings;
    tmdbApiKey: string;
    thePornDbApiKey: string;
    rcloneConfigContent: string;
    iptvConfig?: IptvConfig;
    siteBookmarks?: SiteBookmark[];
  };
  mediaItems: Record<string, MediaItem>;
  watchProgress: Record<string, WatchProgress>;
  playlists?: Record<string, Playlist>;
  favorites?: Record<string, number>;
  audioBookmarks?: Record<string, AudioBookmark[]>;
};

export function backupPathFor(remoteFolder: string): string {
  const base = remoteFolder.replace(/\/$/, "");
  return `${base}/${BACKUP_FILE}`;
}

function deviceName(): string {
  // No hostname API in the webview; a stable per-install label is enough to
  // tell "which device wrote this" in the UI.
  const key = "rcloneflix-device-name";
  let name = localStorage.getItem(key);
  if (!name) {
    name = `device-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(key, name);
  }
  return name;
}

export async function backupToRemote(remoteFolder: string, passphrase?: string): Promise<number> {
  const s = useAppStore.getState();
  if (!s.rcloneConfigPath) throw new Error("No rclone config loaded");

  const payload: BackupPayload = {
    version: 3,
    exportedAt: Date.now(),
    deviceName: deviceName(),
    settings: {
      libraries: s.libraries,
      playback: s.playback,
      tmdbApiKey: s.tmdbApiKey,
      thePornDbApiKey: s.thePornDbApiKey,
      rcloneConfigContent: s.rcloneConfigContent,
      iptvConfig: s.iptvConfig,
      siteBookmarks: getUserBookmarks(),
    },
    mediaItems: s.mediaItems,
    watchProgress: s.watchProgress,
    playlists: s.playlists,
    favorites: s.favorites,
    audioBookmarks: s.audioBookmarks,
  };

  s.setSyncState({ syncing: true, error: undefined });
  try {
    // mkdir is idempotent and cheap; rcat will not create parent folders.
    await invoke("rclone_mkdir", {
      configPath: s.rcloneConfigPath,
      remotePath: remoteFolder.replace(/\/$/, ""),
    }).catch(() => {});

    let contentToWrite = JSON.stringify(payload);
    if (passphrase && passphrase.trim()) {
      const plainBytes = new TextEncoder().encode(contentToWrite);
      const cipherBytes = await encryptBytes(plainBytes, passphrase.trim());
      contentToWrite = `${ENCRYPTED_BACKUP_PREFIX}${uint8ArrayToBase64(cipherBytes)}`;
    }

    const bytes = await invoke<number>("rclone_write_backup", {
      configPath: s.rcloneConfigPath,
      remotePath: backupPathFor(remoteFolder),
      content: contentToWrite,
    });

    s.setSyncState({ syncing: false, lastSyncAt: Date.now() });
    log.info("sync", `backup written to ${remoteFolder} (${bytes} bytes)`);
    return bytes;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    s.setSyncState({ syncing: false, error: msg });
    throw e;
  }
}

export type RestoreSummary = {
  deviceName: string;
  exportedAt: number;
  itemsAdded: number;
  progressUpdated: number;
  librariesRestored: number;
  playlistsUpdated: number;
  favoritesUpdated: number;
};

/**
 * Restore from a backup file.
 *
 * `remotePath` is the full path to the backup (so a user can pick an older
 * file, or one written by a differently-named device).
 */
export async function restoreFromRemote(
  remotePath: string,
  options: { replaceLibraries?: boolean; passphrase?: string } = {}
): Promise<RestoreSummary> {
  const s = useAppStore.getState();
  if (!s.rcloneConfigPath) throw new Error("No rclone config loaded");

  s.setSyncState({ syncing: true, error: undefined });
  try {
    let raw = await invoke<string>("rclone_read_backup", {
      configPath: s.rcloneConfigPath,
      remotePath,
    });

    if (raw.startsWith(ENCRYPTED_BACKUP_PREFIX)) {
      if (!options.passphrase || !options.passphrase.trim()) {
        throw new Error(
          "ENCRYPTED_BACKUP: This backup is encrypted with AES-256-GCM. Please enter your backup passphrase."
        );
      }
      const b64 = raw.slice(ENCRYPTED_BACKUP_PREFIX.length);
      const cipherBytes = base64ToUint8Array(b64);
      const plainBytes = await decryptBytes(cipherBytes, options.passphrase.trim());
      raw = new TextDecoder().decode(plainBytes);
    }

    const backup = JSON.parse(raw) as BackupPayload;
    if (!backup || typeof backup !== "object" || !backup.version) {
      throw new Error("That file is not a RcloneFlix backup");
    }

    // Settings
    const settings = backup.settings ?? ({} as BackupPayload["settings"]);
    if (settings.tmdbApiKey) s.setTmdbApiKey(settings.tmdbApiKey);
    if (settings.thePornDbApiKey) s.setThePornDbApiKey(settings.thePornDbApiKey);
    if (settings.rcloneConfigContent) s.setRcloneConfigContent(settings.rcloneConfigContent);
    if (settings.playback) s.setPlaybackSettings(settings.playback);
    if (settings.iptvConfig) s.setIptvConfig(settings.iptvConfig);
    if (settings.siteBookmarks && Array.isArray(settings.siteBookmarks) && settings.siteBookmarks.length > 0) {
      try {
        const currentBms = getUserBookmarks();
        const existingUrls = new Set(currentBms.map((b) => b.url.toLowerCase()));
        const toAdd = settings.siteBookmarks.filter((b) => !existingUrls.has(b.url.toLowerCase()));
        if (toAdd.length > 0) {
          localStorage.setItem("rcloneflix_site_bookmarks_v1", JSON.stringify([...currentBms, ...toAdd]));
        }
      } catch (err) {
        log.warn("sync", `failed restoring site bookmarks: ${err}`);
      }
    }

    let librariesRestored = 0;
    if (settings.libraries?.length) {
      if (options.replaceLibraries) {
        s.setLibraries(settings.libraries);
        librariesRestored = settings.libraries.length;
      } else {
        // Add only libraries this device doesn't already have.
        const known = new Set(s.libraries.map((l) => `${l.type}:${l.remotePaths.join("|")}`));
        const additions = settings.libraries.filter(
          (l) => !known.has(`${l.type}:${l.remotePaths.join("|")}`)
        );
        if (additions.length) s.setLibraries([...s.libraries, ...additions]);
        librariesRestored = additions.length;
      }
    }

    // Media items: add anything missing, leave local copies alone (they may
    // carry metadata this backup predates).
    const current = useAppStore.getState().mediaItems;
    const incoming = Object.values(backup.mediaItems ?? {});
    const additions = incoming.filter((i) => !current[i.id]);
    if (additions.length) {
      useAppStore.getState().bulkUpsertMediaItems(additions);
      await persistItems(additions).catch(() => {});
    }

    // Watch progress: newest wins, which is what makes two devices converge.
    const localProgress = useAppStore.getState().watchProgress;
    let progressUpdated = 0;
    for (const remote of Object.values(backup.watchProgress ?? {})) {
      const local = localProgress[remote.itemId];
      if (!local || (remote.lastWatchedAt ?? 0) > (local.lastWatchedAt ?? 0)) {
        useAppStore.getState().updateWatchProgress(remote);
        await persistProgress(remote).catch(() => {});
        progressUpdated++;
      }
    }

    // Playlists: merge based on updatedAt timestamp
    const localPlaylists = useAppStore.getState().playlists;
    let playlistsUpdated = 0;
    const playlistsToPersist: Playlist[] = [];
    for (const remote of Object.values(backup.playlists ?? {})) {
      const local = localPlaylists[remote.id];
      if (!local || (remote.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
        useAppStore.getState().setPlaylist(remote);
        playlistsToPersist.push(remote);
        playlistsUpdated++;
      }
    }
    if (playlistsToPersist.length) {
      await persistPlaylists(playlistsToPersist).catch(() => {});
    }

    // Favorites: merge timestamps (take newer or existing)
    const localFavorites = useAppStore.getState().favorites;
    let favoritesUpdated = 0;
    const favsToPersist: Array<{ itemId: string; favoritedAt: number }> = [];
    for (const [itemId, remoteFavoritedAt] of Object.entries(backup.favorites ?? {})) {
      const localFavoritedAt = localFavorites[itemId];
      if (!localFavoritedAt || remoteFavoritedAt > localFavoritedAt) {
        useAppStore.getState().setFavorite(itemId, remoteFavoritedAt);
        favsToPersist.push({ itemId, favoritedAt: remoteFavoritedAt });
        favoritesUpdated++;
      }
    }
    if (favsToPersist.length) {
      await persistFavorites(favsToPersist).catch(() => {});
    }

    // Audio Bookmarks: merge bookmarks by itemId
    if (backup.audioBookmarks) {
      const currentBms = useAppStore.getState().audioBookmarks || {};
      const mergedBms: Record<string, AudioBookmark[]> = { ...currentBms };
      for (const [itemId, bms] of Object.entries(backup.audioBookmarks)) {
        const existing = mergedBms[itemId] || [];
        const existingIds = new Set(existing.map((b) => b.id));
        const newOnes = bms.filter((b) => !existingIds.has(b.id));
        mergedBms[itemId] = [...existing, ...newOnes].sort((a, b) => a.timestamp - b.timestamp);
      }
      useAppStore.setState({ audioBookmarks: mergedBms });
    }

    useAppStore.getState().setSyncState({ syncing: false, lastSyncAt: Date.now() });
    const summary: RestoreSummary = {
      deviceName: backup.deviceName ?? "unknown",
      exportedAt: backup.exportedAt ?? 0,
      itemsAdded: additions.length,
      progressUpdated,
      librariesRestored,
      playlistsUpdated,
      favoritesUpdated,
    };
    log.info("sync", `restored from ${remotePath}: ${JSON.stringify(summary)}`);
    return summary;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useAppStore.getState().setSyncState({ syncing: false, error: msg });
    throw e;
  }
}
