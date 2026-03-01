import { create } from "zustand";
import { persist } from "zustand/middleware";

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

// ─── Media Items ──────────────────────────────────────────────────────────────

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
  thumbUrl?: string;
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
  episodeTitle?: string;
  showTitle?: string;
  showId?: string;       // tmdb show id
  showPosterUrl?: string;
  showBackdropUrl?: string;
  showOverview?: string;
  // Music
  artist?: string;
  album?: string;
  trackNumber?: number;
  // Books
  author?: string;
};

// ─── TV Show grouping ─────────────────────────────────────────────────────────

export type TvEpisode = MediaItem & {
  season: number;
  episode: number;
};

export type TvSeason = {
  seasonNumber: number;
  episodes: TvEpisode[];
  posterUrl?: string;
};

export type TvShow = {
  showId: string;         // tmdb id or derived from title
  title: string;
  posterUrl?: string;
  backdropUrl?: string;
  overview?: string;
  rating?: number;
  year?: number;
  libraryId: string;
  seasons: Record<number, TvSeason>;
  episodeCount: number;
};

// ─── Watch Progress ───────────────────────────────────────────────────────────

export type WatchProgress = {
  itemId: string;
  position: number;       // seconds/ms for video/audio; 0 for epub (use cfi)
  duration: number;
  completed: boolean;
  lastWatchedAt: number;
  cfi?: string;           // epubjs CFI string for epub resume
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

// ─── Google / Sync ────────────────────────────────────────────────────────────

export type GoogleAccount = {
  email: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type SyncState = {
  lastSyncAt?: number;
  syncing: boolean;
  error?: string;
};

// ─── App Config ───────────────────────────────────────────────────────────────

export type AppConfig = {
  tmdbApiKey: string;
  thePornDbApiKey: string;
  rcloneConfigPath: string;
  rcloneConfigContent: string;  // actual file content for Drive sync
  remotes: RcloneRemote[];
  libraries: Library[];
  setupComplete: boolean;
  googleAccount: GoogleAccount | null;
};

type AppStore = AppConfig & {
  mediaItems: Record<string, MediaItem>;
  watchProgress: Record<string, WatchProgress>;
  scanState: ScanState;
  adultSettings: AdultSettings;
  syncState: SyncState;

  // Config
  setTmdbApiKey: (key: string) => void;
  setThePornDbApiKey: (key: string) => void;
  setRcloneConfigPath: (path: string) => void;
  setRcloneConfigContent: (content: string) => void;
  setRemotes: (remotes: RcloneRemote[]) => void;
  addLibrary: (lib: Library) => void;
  removeLibrary: (id: string) => void;
  updateLibrary: (id: string, updates: Partial<Library>) => void;
  completeSetup: () => void;
  setGoogleAccount: (account: GoogleAccount | null) => void;
  resetConfig: () => void;
  importConfig: (config: Partial<AppConfig> & { mediaItems?: Record<string, MediaItem>; watchProgress?: Record<string, WatchProgress> }) => void;

  // Media
  upsertMediaItem: (item: MediaItem) => void;
  removeMediaItem: (id: string) => void;
  bulkUpsertMediaItems: (items: MediaItem[]) => void;
  updateItemMetadata: (id: string, updates: Partial<MediaItem>) => void;
  clearLibraryItems: (libraryId: string) => void;

  // Watch Progress
  updateWatchProgress: (progress: WatchProgress) => void;
  markCompleted: (itemId: string) => void;
  clearProgress: (itemId: string) => void;

  // Scan
  setScanState: (state: Partial<ScanState>) => void;
  resetScanState: () => void;

  // Adult
  setAdultHidden: (hidden: boolean) => void;
  setAdultPin: (pinHash: string, length: 4 | 5 | 6) => void;
  setAdultPinEnabled: (enabled: boolean) => void;
  setAdultUnlocked: (unlocked: boolean) => void;
  clearAdultPin: () => void;

  // Sync
  setSyncState: (state: Partial<SyncState>) => void;
};

const defaultAdultSettings: AdultSettings = {
  hidden: false, pinEnabled: false, pinHash: "", pinLength: 4, unlocked: false,
};

const defaultScanState: ScanState = { status: "idle", newItemsFound: 0 };

const defaultConfig: AppConfig = {
  tmdbApiKey: "", thePornDbApiKey: "", rcloneConfigPath: "",
  rcloneConfigContent: "", remotes: [], libraries: [],
  setupComplete: false, googleAccount: null,
};

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      ...defaultConfig,
      mediaItems: {},
      watchProgress: {},
      scanState: defaultScanState,
      adultSettings: defaultAdultSettings,
      syncState: { syncing: false },

      setTmdbApiKey: (key) => set({ tmdbApiKey: key }),
      setThePornDbApiKey: (key) => set({ thePornDbApiKey: key }),
      setRcloneConfigPath: (path) => set({ rcloneConfigPath: path }),
      setRcloneConfigContent: (content) => set({ rcloneConfigContent: content }),
      setRemotes: (remotes) => set({ remotes }),
      addLibrary: (lib) => set((s) => ({ libraries: [...s.libraries, lib] })),
      removeLibrary: (id) => set((s) => ({ libraries: s.libraries.filter((l) => l.id !== id) })),
      updateLibrary: (id, updates) =>
        set((s) => ({ libraries: s.libraries.map((l) => l.id === id ? { ...l, ...updates } : l) })),
      completeSetup: () => set({ setupComplete: true }),
      setGoogleAccount: (account) => set({ googleAccount: account }),
      resetConfig: () => set({ ...defaultConfig, mediaItems: {}, watchProgress: {}, scanState: defaultScanState, adultSettings: defaultAdultSettings, syncState: { syncing: false } }),
      importConfig: (config) => set((s) => ({
        ...s,
        ...config,
        mediaItems: config.mediaItems ?? s.mediaItems,
        watchProgress: config.watchProgress ?? s.watchProgress,
      })),

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
      clearLibraryItems: (libraryId) =>
        set((s) => {
          const n: Record<string, MediaItem> = {};
          Object.values(s.mediaItems).forEach((i) => { if (i.libraryId !== libraryId) n[i.id] = i; });
          return { mediaItems: n };
        }),

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

      setSyncState: (state) => set((s) => ({ syncState: { ...s.syncState, ...state } })),
    }),
    {
      name: "rcloneflix-config",
      partialize: (s) => ({
        ...s,
        adultSettings: { ...s.adultSettings, unlocked: false },
        scanState: { ...s.scanState, status: "idle" as ScanStatus, progress: undefined },
        syncState: { ...s.syncState, syncing: false },
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

// ─── Music hierarchy ──────────────────────────────────────────────────────────

export type MusicAlbum = {
  name: string;
  artistName: string;
  year?: number;
  posterUrl?: string;
  tracks: MediaItem[];
};

export type MusicArtist = {
  name: string;
  posterUrl?: string;
  albums: Record<string, MusicAlbum>;
  albumCount: number;
  trackCount: number;
};

export function selectMusicArtists(items: Record<string, MediaItem>, libraryId: string): MusicArtist[] {
  const tracks = Object.values(items).filter(
    (i) => i.libraryId === libraryId && (i.libraryType === "music" || i.libraryType === "audiobooks")
  );
  const artistMap: Record<string, MusicArtist> = {};
  for (const track of tracks) {
    const artistName = track.artist ?? "Unknown Artist";
    const albumName = track.album ?? "Unknown Album";
    if (!artistMap[artistName]) {
      artistMap[artistName] = { name: artistName, posterUrl: undefined, albums: {}, albumCount: 0, trackCount: 0 };
    }
    const artist = artistMap[artistName];
    if (!artist.albums[albumName]) {
      artist.albums[albumName] = { name: albumName, artistName, year: track.year, posterUrl: track.posterUrl, tracks: [] };
      artist.albumCount++;
    }
    // Use first available poster as the artist image
    if (!artist.posterUrl && track.posterUrl) artist.posterUrl = track.posterUrl;
    artist.albums[albumName].tracks.push(track);
    artist.albums[albumName].tracks.sort((a, b) => (a.trackNumber ?? 999) - (b.trackNumber ?? 999));
    artist.trackCount++;
  }
  return Object.values(artistMap).sort((a, b) => a.name.localeCompare(b.name));
}

// Group TV episodes into Show -> Season -> Episode hierarchy
export function selectTvShows(items: Record<string, MediaItem>, libraryId: string): TvShow[] {
  const episodes = Object.values(items).filter(
    (i) => i.libraryId === libraryId && i.libraryType === "tv"
  ) as TvEpisode[];

  const showMap: Record<string, TvShow> = {};

  for (const ep of episodes) {
    const showKey = ep.showId ?? ep.showTitle ?? ep.title;
    if (!showMap[showKey]) {
      showMap[showKey] = {
        showId: showKey,
        title: ep.showTitle ?? ep.title,
        posterUrl: ep.showPosterUrl ?? ep.posterUrl,
        backdropUrl: ep.showBackdropUrl ?? ep.backdropUrl,
        overview: ep.showOverview ?? ep.overview,
        rating: ep.rating,
        year: ep.year,
        libraryId,
        seasons: {},
        episodeCount: 0,
      };
    }
    const show = showMap[showKey];
    const seasonNum = ep.season ?? 1;
    if (!show.seasons[seasonNum]) {
      show.seasons[seasonNum] = { seasonNumber: seasonNum, episodes: [] };
    }
    show.seasons[seasonNum].episodes.push(ep);
    show.seasons[seasonNum].episodes.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
    show.episodeCount++;
  }

  return Object.values(showMap).sort((a, b) => a.title.localeCompare(b.title));
}
