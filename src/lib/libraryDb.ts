/**
 * SQLite-backed media library.
 *
 * `mediaItems` and `watchProgress` are no longer persisted through zustand into
 * localStorage — at ~500 bytes an item that hit WebKit's quota somewhere north
 * of 6k files, after which writes throw, memory looks fine, and the library
 * empties on the next launch. They live in library.db instead and are mirrored
 * into the store at startup for the UI to read synchronously.
 *
 * Writes are fire-and-forget batches: the store stays the source of truth for
 * rendering, SQLite for durability.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  useAppStore,
  type MediaItem,
  type WatchProgress,
  type Playlist,
} from "../store/appStore";
import { log } from "./log";
import { legacyState, legacyBlobSize } from "./legacyStore";

type StoredItem = { id: string; libraryId: string; data: string };
type StoredPlaylist = { id: string; data: string };
type StoredFavorite = { itemId: string; favoritedAt: number };

function toStored(item: MediaItem): StoredItem {
  return { id: item.id, libraryId: item.libraryId, data: JSON.stringify(item) };
}

export async function persistItems(items: MediaItem[]): Promise<void> {
  if (items.length === 0) return;
  const BATCH_SIZE = 250;
  try {
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const slice = items.slice(i, i + BATCH_SIZE);
      await invoke("library_upsert_items", { items: slice.map(toStored) });
    }
  } catch (e) {
    log.error("library-db", `upsert of ${items.length} items failed: ${e}`);
    throw e;
  }
}

export async function deleteItems(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await invoke("library_remove_items", { ids });
  } catch (e) {
    log.error("library-db", `delete failed: ${e}`);
  }
}

export async function clearLibrary(libraryId: string): Promise<void> {
  try {
    await invoke("library_clear_library", { libraryId });
  } catch (e) {
    log.error("library-db", `clear library failed: ${e}`);
  }
}

export async function persistProgress(progress: WatchProgress): Promise<void> {
  try {
    await invoke("library_set_progress", {
      itemId: progress.itemId,
      data: JSON.stringify(progress),
    });
  } catch (e) {
    log.error("library-db", `progress write failed: ${e}`);
  }
}

export async function persistProgressBatch(progressList: WatchProgress[]): Promise<void> {
  if (progressList.length === 0) return;
  const formatted = progressList.map((p) => ({
    itemId: p.itemId,
    data: JSON.stringify(p),
  }));
  if (typeof window !== "undefined" && "AndroidBridge" in window) {
    try {
      const BATCH_SIZE = 500;
      for (let i = 0; i < formatted.length; i += BATCH_SIZE) {
        await invoke("library_upsert_progress_batch", {
          progressList: formatted.slice(i, i + BATCH_SIZE),
        });
      }
      return;
    } catch (e) {
      log.error("library-db", `library_upsert_progress_batch failed: ${e}`);
    }
  }
  for (const p of progressList) {
    await persistProgress(p);
  }
}

export async function deleteProgress(itemId: string): Promise<void> {
  try {
    await invoke("library_remove_progress", { itemId });
  } catch (e) {
    log.error("library-db", `progress delete failed: ${e}`);
  }
}

export async function persistPlaylists(playlists: Playlist[]): Promise<void> {
  if (playlists.length === 0) return;
  try {
    await invoke("library_upsert_playlists", {
      playlists: playlists.map((p) => ({ id: p.id, data: JSON.stringify(p) })),
    });
  } catch (e) {
    log.error("library-db", `upsert of ${playlists.length} playlists failed: ${e}`);
  }
}

export async function deletePlaylists(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await invoke("library_remove_playlists", { ids });
  } catch (e) {
    log.error("library-db", `delete playlists failed: ${e}`);
  }
}

export async function persistFavorites(
  favs: Array<{ itemId: string; favoritedAt: number }>
): Promise<void> {
  if (favs.length === 0) return;
  try {
    await invoke("library_set_favorites", {
      favorites: favs,
    });
  } catch (e) {
    log.error("library-db", `set ${favs.length} favorites failed: ${e}`);
  }
}

export async function deleteFavorites(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  try {
    await invoke("library_remove_favorites", { itemIds });
  } catch (e) {
    log.error("library-db", `remove favorites failed: ${e}`);
  }
}

/**
 * One-time import of the pre-0.4 localStorage library. Runs before the first
 * load so an upgrading user never sees an empty app.
 */
async function migrateFromLocalStorage(): Promise<void> {
  const alreadyDone = await invoke<boolean>("library_migration_done").catch(() => false);
  if (alreadyDone) return;

  const state = legacyState();
  const items: MediaItem[] = Object.values(state?.mediaItems ?? {});
  const progress: WatchProgress[] = Object.values(state?.watchProgress ?? {});

  log.info(
    "library-db",
    `legacy blob ${legacyBlobSize()} bytes; found ${items.length} items, ${progress.length} progress rows`
  );

  if (items.length === 0 && progress.length === 0) {
    // Nothing to import. Do NOT mark the migration done — an empty read here
    // could mean the blob was captured too late rather than genuinely absent,
    // and marking it would permanently skip a real library on the next launch.
    log.info("library-db", "no legacy library found; leaving migration unmarked");
    return;
  }

  try {
    for (let i = 0; i < items.length; i += 500) {
      await persistItems(items.slice(i, i + 500));
    }
    for (const p of progress) await persistProgress(p);
  } catch (e) {
    log.error("library-db", `migration aborted, localStorage left untouched: ${e}`);
    return;
  }

  // Only claim success once SQLite really holds at least what we imported.
  const stored = await invoke<number>("library_count").catch(() => 0);
  if (stored < items.length) {
    log.error(
      "library-db",
      `migration incomplete (${stored}/${items.length} rows) — not marking done`
    );
    return;
  }

  await invoke("library_mark_migrated").catch(() => {});
  log.info("library-db", `migrated ${items.length} items and ${progress.length} progress rows`);
}

/** Load the library from SQLite into the store. Call once at startup. */
export async function loadLibrary(): Promise<void> {
  await migrateFromLocalStorage();

  try {
    const snapshot = await invoke<{
      items: string[];
      progress: string[];
      playlists?: string[];
      favorites?: Array<{ itemId: string; favoritedAt: number }>;
    }>("library_load_all");

    const mediaItems: Record<string, MediaItem> = {};
    for (const json of snapshot.items) {
      try {
        const item = JSON.parse(json) as MediaItem;
        mediaItems[item.id] = item;
      } catch {
        // Skip a corrupt row rather than losing the whole library.
      }
    }

    const watchProgress: Record<string, WatchProgress> = {};
    for (const json of snapshot.progress) {
      try {
        const p = JSON.parse(json) as WatchProgress;
        watchProgress[p.itemId] = p;
      } catch {
        /* ignore */
      }
    }

    const playlists: Record<string, Playlist> = {};
    for (const json of snapshot.playlists ?? []) {
      try {
        const p = JSON.parse(json) as Playlist;
        playlists[p.id] = p;
      } catch {
        /* ignore */
      }
    }

    const favorites: Record<string, number> = {};
    for (const f of snapshot.favorites ?? []) {
      favorites[f.itemId] = f.favoritedAt;
    }

    useAppStore.setState({ mediaItems, watchProgress, playlists, favorites });
    log.info(
      "library-db",
      `loaded ${Object.keys(mediaItems).length} items, ${Object.keys(watchProgress).length} progress rows, ${Object.keys(playlists).length} playlists, ${Object.keys(favorites).length} favorites`
    );
  } catch (e) {
    log.error("library-db", `load failed: ${e}`);
    throw e;
  }
}

/** Drop the now-redundant library blob from localStorage to reclaim quota. */
export async function pruneLegacyLocalStorage(): Promise<void> {
  try {
    const raw = localStorage.getItem("rcloneflix-config");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const legacyCount = Object.keys(parsed?.state?.mediaItems ?? {}).length;
    if (legacyCount === 0) return;

    // Never drop the old copy until SQLite demonstrably holds at least as much.
    const stored = await invoke<number>("library_count").catch(() => 0);
    if (stored < legacyCount) {
      log.warn(
        "library-db",
        `not pruning localStorage: SQLite has ${stored} rows vs ${legacyCount} legacy items`
      );
      return;
    }

    delete parsed.state.mediaItems;
    delete parsed.state.watchProgress;
    localStorage.setItem("rcloneflix-config", JSON.stringify(parsed));
    log.info("library-db", `pruned ${legacyCount} legacy items from localStorage`);
  } catch (e) {
    log.warn("library-db", `could not prune localStorage: ${e}`);
  }
}

let syncStarted = false;
let syncPaused = false;
let syncPrevRefs: (() => void) | null = null;

export function setLibrarySyncPaused(paused: boolean): void {
  syncPaused = paused;
  if (!paused && syncPrevRefs) {
    syncPrevRefs();
  }
}

/**
 * Mirror media/progress mutations into SQLite.
 *
 * Subscribing centrally means no call site can forget to persist — the same
 * approach used for secrets. Diffing by reference is cheap because every store
 * action replaces the containing object.
 */
export function startLibrarySync(): () => void {
  if (syncStarted) {
    return () => {};
  }
  syncStarted = true;

  let prevItems = useAppStore.getState().mediaItems;
  let prevProgress = useAppStore.getState().watchProgress;
  let prevPlaylists = useAppStore.getState().playlists;
  let prevFavorites = useAppStore.getState().favorites;

  syncPrevRefs = () => {
    const cur = useAppStore.getState();
    prevItems = cur.mediaItems;
    prevProgress = cur.watchProgress;
    prevPlaylists = cur.playlists;
    prevFavorites = cur.favorites;
  };

  return useAppStore.subscribe((s) => {
    if (syncPaused) {
      prevItems = s.mediaItems;
      prevProgress = s.watchProgress;
      prevPlaylists = s.playlists;
      prevFavorites = s.favorites;
      return;
    }

    if (s.mediaItems !== prevItems) {
      const before = prevItems;
      const after = s.mediaItems;
      prevItems = after;

      const changed: MediaItem[] = [];
      for (const id in after) {
        if (before[id] !== after[id]) changed.push(after[id]);
      }
      const removed: string[] = [];
      for (const id in before) {
        if (!(id in after)) removed.push(id);
      }

      if (changed.length) void persistItems(changed).catch(() => {});
      if (removed.length) void deleteItems(removed);
    }

    if (s.watchProgress !== prevProgress) {
      const before = prevProgress;
      const after = s.watchProgress;
      prevProgress = after;

      const changedProgress: WatchProgress[] = [];
      for (const id in after) {
        if (before[id] !== after[id]) changedProgress.push(after[id]);
      }
      if (changedProgress.length === 1) {
        void persistProgress(changedProgress[0]);
      } else if (changedProgress.length > 1) {
        void persistProgressBatch(changedProgress);
      }

      for (const id in before) {
        if (!(id in after)) void deleteProgress(id);
      }
    }

    if (s.playlists !== prevPlaylists) {
      const before = prevPlaylists;
      const after = s.playlists;
      prevPlaylists = after;

      const changed: Playlist[] = [];
      for (const id in after) {
        if (before[id] !== after[id]) changed.push(after[id]);
      }
      const removed: string[] = [];
      for (const id in before) {
        if (!(id in after)) removed.push(id);
      }

      if (changed.length) void persistPlaylists(changed).catch(() => {});
      if (removed.length) void deletePlaylists(removed);
    }

    if (s.favorites !== prevFavorites) {
      const before = prevFavorites;
      const after = s.favorites;
      prevFavorites = after;

      const changed: Array<{ itemId: string; favoritedAt: number }> = [];
      for (const id in after) {
        if (before[id] !== after[id]) changed.push({ itemId: id, favoritedAt: after[id] });
      }
      const removed: string[] = [];
      for (const id in before) {
        if (!(id in after)) removed.push(id);
      }

      if (changed.length) void persistFavorites(changed).catch(() => {});
      if (removed.length) void deleteFavorites(removed);
    }
  });
}
