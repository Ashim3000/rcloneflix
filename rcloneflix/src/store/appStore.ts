import { create } from "zustand";
import { persist } from "zustand/middleware";

// ─── Library & Config ────────────────────────────────────────────────────────

export type LibraryType = "movies" | "tv" | "music" | "audiobooks" | "books" | "adult";

export type Library = {
  id: string;
  name: string;
  type: LibraryType;
  remotePath: string;
};

export type RcloneRemote = {
  name: string;
  type: string;
};

// ─── Media Items ─────────────────────────────────────────────────────────────

export type MediaItem = {
  id: string;
  libraryId: string;
  libraryType: LibraryType;
  remotePath: string;
  filename: string;
  title: string;
  year?: number;
  posterUrl?: string;
  backdropUrl?: string;
  overview?: string;
  rating?: number;
  genres?: string[];
  duration?: number;
  metadataId?: string;
  metadataSource?: "tmdb" | "musicbrainz" | "openlibrary" | "audnexus" | "theporndb" | "manual";
  metadataConfidence?: "high" | "low" | "manual";
  addedAt: number;
  lastScannedAt: number;
  // TV
  season?: number;
  episode?: number;
  showTitle?: string;
  // Music
  artist?: string;
  album?: string;
  trackNumber?: number;
  // Books
  author?: string;
};

// ─── Watch Progress ───────────────────────────────────────────────────────────

export type WatchProgress = {
  itemId: string;
  position: number;
  duration: number;
  completed: boolean;
  lastWatchedAt: number;
};

// ─── Scan State ───────────────────────────────────────────────────────────────

export type ScanStatus = "idle" | "scanning" | "error";

export type ScanState = {
  status: ScanStatus;
  currentLibrary?: string;
  progress?: number;
  lastScanAt?: number;
  lastError?: string;
  newItemsFound: number;
};

// ─── Adult Settings ───────────────────────────────────────────────────────────

export type AdultSettings = {
  hidden: boolean;
  pinEnabled: boolean;
  pinHash: string;
  pinLength: 4 | 5 | 6;
  unlocked: boolean;
};

// ─── Config ───────────────────────────────────────────────────────────────────

export type AppConfig = {
  tmdbApiKey: string;
  thePornDbApiKey: string;
  rcloneConfigPath: string;
  remotes: RcloneRemote[];
  libraries: Library[];
  setupComplete: boolean;
  googleLinked: boolean;
};

type AppStore = AppConfig & {
  mediaItems: Record<string, MediaItem>;
  watchProgress: Record<string, WatchProgress>;
  scanState: ScanState;
  adultSettings: AdultSettings;

  setTmdbApiKey: (key: string) => void;
  setThePornDbApiKey: (key: string) => void;
  setRcloneConfigPath: (path: string) => void;
  setRemotes: (remotes: RcloneRemote[]) => void;
  addLibrary: (lib: Library) => void;
  removeLibrary: (id: string) => void;
  updateLibrary: (id: string, updates: Partial<Library>) => void;
  completeSetup: () => void;
  setGoogleLinked: (linked: boolean) => void;
  resetConfig: () => void;

  upsertMediaItem: (item: MediaItem) => void;
  removeMediaItem: (id: string) => void;
  bulkUpsertMediaItems: (items: MediaItem[]) => void;
  updateItemMetadata: (id: string, updates: Partial<MediaItem>) => void;

  updateWatchProgress: (progress: WatchProgress) => void;
  markCompleted: (itemId: string) => void;
  clearProgress: (itemId: string) => void;

  setScanState: (state: Partial<ScanState>) => void;
  resetScanState: () => void;

  setAdultHidden: (hidden: boolean) => void;
  setAdultPin: (pinHash: string, length: 4 | 5 | 6) => void;
  setAdultPinEnabled: (enabled: boolean) => void;
  setAdultUnlocked: (unlocked: boolean) => void;
  clearAdultPin: () => void;
};

const defaultAdultSettings: AdultSettings = {
  hidden: false,
  pinEnabled: false,
  pinHash: "",
  pinLength: 4,
  unlocked: false,
};

const defaultScanState: ScanState = {
  status: "idle",
  newItemsFound: 0,
};

const defaultConfig: AppConfig = {
  tmdbApiKey: "",
  thePornDbApiKey: "",
  rcloneConfigPath: "",
  remotes: [],
  libraries: [],
  setupComplete: false,
  googleLinked: false,
};

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      ...defaultConfig,
      mediaItems: {},
      watchProgress: {},
      scanState: defaultScanState,
      adultSettings: defaultAdultSettings,

      setTmdbApiKey: (key) => set({ tmdbApiKey: key }),
      setThePornDbApiKey: (key) => set({ thePornDbApiKey: key }),
      setRcloneConfigPath: (path) => set({ rcloneConfigPath: path }),
      setRemotes: (remotes) => set({ remotes }),
      addLibrary: (lib) => set((s) => ({ libraries: [...s.libraries, lib] })),
      removeLibrary: (id) => set((s) => ({ libraries: s.libraries.filter((l) => l.id !== id) })),
      updateLibrary: (id, updates) =>
        set((s) => ({ libraries: s.libraries.map((l) => l.id === id ? { ...l, ...updates } : l) })),
      completeSetup: () => set({ setupComplete: true }),
      setGoogleLinked: (linked) => set({ googleLinked: linked }),
      resetConfig: () => set({ ...defaultConfig, mediaItems: {}, watchProgress: {}, scanState: defaultScanState, adultSettings: defaultAdultSettings }),

      upsertMediaItem: (item) =>
        set((s) => ({ mediaItems: { ...s.mediaItems, [item.id]: item } })),
      removeMediaItem: (id) =>
        set((s) => { const n = { ...s.mediaItems }; delete n[id]; return { mediaItems: n }; }),
      bulkUpsertMediaItems: (items) =>
        set((s) => {
          const n = { ...s.mediaItems };
          items.forEach((i) => { n[i.id] = i; });
          return { mediaItems: n };
        }),
      updateItemMetadata: (id, updates) =>
        set((s) => ({ mediaItems: { ...s.mediaItems, [id]: { ...s.mediaItems[id], ...updates } } })),

      updateWatchProgress: (progress) =>
        set((s) => ({ watchProgress: { ...s.watchProgress, [progress.itemId]: progress } })),
      markCompleted: (itemId) =>
        set((s) => ({ watchProgress: { ...s.watchProgress, [itemId]: { ...s.watchProgress[itemId], completed: true } } })),
      clearProgress: (itemId) =>
        set((s) => { const n = { ...s.watchProgress }; delete n[itemId]; return { watchProgress: n }; }),

      setScanState: (state) => set((s) => ({ scanState: { ...s.scanState, ...state } })),
      resetScanState: () => set({ scanState: defaultScanState }),

      setAdultHidden: (hidden) => set((s) => ({ adultSettings: { ...s.adultSettings, hidden } })),
      setAdultPin: (pinHash, length) =>
        set((s) => ({ adultSettings: { ...s.adultSettings, pinHash, pinLength: length, pinEnabled: true } })),
      setAdultPinEnabled: (enabled) =>
        set((s) => ({ adultSettings: { ...s.adultSettings, pinEnabled: enabled } })),
      setAdultUnlocked: (unlocked) =>
        set((s) => ({ adultSettings: { ...s.adultSettings, unlocked } })),
      clearAdultPin: () =>
        set((s) => ({ adultSettings: { ...s.adultSettings, pinHash: "", pinEnabled: false, unlocked: false } })),
    }),
    {
      name: "rcloneflix-config",
      partialize: (s) => ({
        ...s,
        adultSettings: { ...s.adultSettings, unlocked: false },
        scanState: { ...s.scanState, status: "idle" as ScanStatus, progress: undefined },
      }),
    }
  )
);

// ─── Selectors ────────────────────────────────────────────────────────────────

export function selectItemsByLibrary(items: Record<string, MediaItem>, libraryId: string): MediaItem[] {
  return Object.values(items)
    .filter((i) => i.libraryId === libraryId)
    .sort((a, b) => b.addedAt - a.addedAt);
}

export function selectRecentlyAdded(items: Record<string, MediaItem>, libraryId: string, limit = 20): MediaItem[] {
  return selectItemsByLibrary(items, libraryId).slice(0, limit);
}

export function selectInProgress(
  items: Record<string, MediaItem>,
  progress: Record<string, WatchProgress>,
  limit = 20
): (MediaItem & { progress: WatchProgress })[] {
  return Object.values(progress)
    .filter((p) => !p.completed && p.position > 30 && items[p.itemId])
    .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt)
    .slice(0, limit)
    .map((p) => ({ ...items[p.itemId], progress: p }));
}
