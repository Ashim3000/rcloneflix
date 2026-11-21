import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import { AUDIO_EXTENSIONS, COMIC_EXTENSIONS, isComicExtension } from "../lib/mediaTypes";
import { type MediaSourceVersion, mergeItemVersions } from "../lib/multiVersion";
import { getIsoWeekString } from "../lib/recommendations";

export { AUDIO_EXTENSIONS, COMIC_EXTENSIONS, isComicExtension };
export type { MediaSourceVersion };
export type LibraryType = "movies" | "tv" | "music" | "audiobooks" | "books" | "comics" | "adult" | "photos";

// ─── Photo Vault ─────────────────────────────────────────────────────────────

export type PhotoStorageMode = "compressed" | "original" | "both";

export type GalleryPhoto = {
  id: string;
  arweaveId?: string;
  arweaveUrl?: string;
  remotePath?: string;
  remoteOriginalPath?: string;
  remotePreviewPath?: string;
  storageMode?: PhotoStorageMode;
  filename: string;
  sizeBytes: number;
  originalSizeBytes?: number;
  width?: number;
  height?: number;
  caption?: string;
  isAdult: boolean;
  uploadedAt: number;
};

export type PhotoGallery = {
  id: string;
  title: string;
  description?: string;
  coverPhotoId?: string;
  isAdult: boolean;
  photos: GalleryPhoto[];
  storageMode?: PhotoStorageMode;
  remoteBackupType?: "none" | "original" | "compressed";
  remoteName?: string;
  remotePath?: string;
  createdAt: number;
  updatedAt: number;
};

export type Library = {
  id: string;
  name: string;
  type: LibraryType;
  remotePaths: string[];  // one or more remote paths for this library
  isSharedPass?: boolean;
  passId?: string;
  expiresAt?: number;
  isExpired?: boolean;
  grantorLabel?: string;
};

export type AccessPassDuration = "1d" | "7d" | "60d" | "lifetime";

export type IssuedPass = {
  passId: string;
  label: string;
  remoteName: string;
  duration: AccessPassDuration;
  createdAt: number;
  sharedLibraries: { id: string; name: string; type: LibraryType }[];
  tokenPath: string;
  status?: "unclaimed" | "claimed" | "revoked" | "expired";
  claimedAt?: number;
  expiresAt?: number;
  guestEmail?: string;
  lastReminderSentAt?: number;
};

export type StremioAddonConfig = {
  id: string;
  name: string;
  manifestUrl: string;
  baseUrl: string;
  version: string;
  description?: string;
  supportedTypes: string[];
  idPrefixes: string[];
  hasDebridEmbedded: boolean;
  enabled: boolean;
};

export type TvSubscription = {
  seriesId: string;              // showId or normalized title key
  imdbId?: string;               // e.g. "tt11280740"
  seriesTitle: string;
  posterUrl?: string;
  libraryId: string;
  monitoredSeasons: "all" | number[];
  qualityProfile: "any" | "720p" | "1080p" | "4k";
  preferredSource: "auto" | "stremio_debrid" | "easynews" | "infinidysk";
  /** When preferredSource is "auto" (all sources), which one to try first. */
  sourcePriority?: "stremio_debrid" | "easynews" | "infinidysk";
  /** Preferred scene/release groups (e.g. FLUX, NTb, MeGusta). Matching releases are
   *  ranked first; if none match, any release that passes quality/size still grabs. */
  preferredReleaseGroups?: string[];
  maxSizeGb: number;             // e.g. 6
  transcodeToMp4: boolean;       // true = route through Kaggle/GHA H.264/AAC transcoder
  destinationRemotePath: string; // e.g. "gdrive:TV Shows/Severance"
  lastCheckedAt?: number;
  lastGrabbedEpisode?: string;   // e.g. "S02E04"
  /** "tv" (default, SxxExx tracking) or "dated_scene" (site + release-date tracking). */
  subscriptionKind?: "tv" | "dated_scene";
  /** dated_scene only: newest release date already grabbed, "YYYY-MM-DD". */
  lastGrabbedDate?: string;
  status: "active" | "paused";
};

export type AudioBookmark = {
  id: string;
  itemId: string;
  timestamp: number; // in seconds
  title?: string;
  note?: string;
  createdAt: number;
};

export type RcloneRemote = {
  name: string;
  type: string;
};

// ─── Weekly Recommendations ──────────────────────────────────────────────────

export type RecommendationBadgeEffect =
  | "glow"     // Pulsating cyan/neon accent halo
  | "pulse"    // Rhythmic breathing opacity
  | "flame"    // Hot amber/orange/rose gradient with Flame icon
  | "shimmer"  // Angled light-sweep metallic reflection
  | "gold";    // Audiophile/prestige gold foil with Star icon

export type WeeklyRecommendation = {
  itemId: string;           // MediaItem id
  title: string;            // Media title
  posterUrl?: string;       // Poster thumbnail
  badgeText: string;        // e.g. "Admin Pick", "Curator Choice", "Must Watch", "Essential"
  badgeEffect: RecommendationBadgeEffect;
  note?: string;            // Optional 1-sentence curator pitch for new guests
  addedAt: number;          // Timestamp when recommended
};

export type LibraryWeeklyPicks = {
  weekId: string;           // ISO week identifier, e.g. "2026-W46"
  items: WeeklyRecommendation[]; // Strictly capped at max 3 items
};

export type AdminWeeklyRecommendations = Record<string, LibraryWeeklyPicks>; // Keyed by libraryId

export type GhaAccount = {
  id: string;
  label: string;
  owner: string;
  repo: string;
  token: string;
  workflowFile?: string;
  branch?: string;
  enabled?: boolean;
  allowPublicRepo?: boolean;
  isExhausted?: boolean;
  exhaustedAt?: number;
};

export type KaggleAccount = {
  id: string;
  label: string;
  username: string;
  key: string;
  enabled?: boolean;
  isExhausted?: boolean;
  exhaustedAt?: number;
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
  metadataSource?: "cinemeta" | "tmdb" | "musicbrainz" | "openlibrary" | "audnexus" | "theporndb" | "manual" | "itunes" | "deezer" | "googlebooks";
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
  // Web Stream Bookmarking (Feature 1)
  isSourceBookmark?: boolean;
  sourceUrl?: string;
  sourceProvider?: string;
  // Grouping & Badges
  badge?: string;
  subtitle?: string;
  itemCount?: number;
  groupType?: "show" | "album" | "book" | "single";
  // User-defined tags & Stash-style adult metadata
  userTags?: string[];
  studio?: string;
  performers?: string[];
  oshash?: string;
  phash?: string;
  // Technical media specs
  sizeBytes?: number;
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  resolution?: string;
  streamUrl?: string;
  inLibrary?: boolean;
  matchedLibraryId?: string;
  dropmbExpiresAt?: number;
  dropmbShareUrl?: string;
  // Admin Weekly Recommendations
  isRecommended?: boolean;
  recommendationBadge?: {
    text: string;
    effect: RecommendationBadgeEffect;
    note?: string;
  };
  // Multi-version Plex-style duplicate grouping
  versions?: MediaSourceVersion[];
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
  percentage?: number;    // 0.0 to 1.0 (Whispersync progress)
  isNextUp?: boolean;     // true when dynamically surfaced by Next Up engine
  nextUpReason?: string;  // e.g. "Next Up: S2 · E3" or "Next in Franchise"
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

// ─── Playlists & Favorites ───────────────────────────────────────────────────

export type Playlist = {
  id: string;
  name: string;
  description?: string;
  type: "music" | "video" | "mixed";
  itemIds: string[];
  createdAt: number;
  updatedAt: number;
};

// ─── App Config ───────────────────────────────────────────────────────────────

/** ISO 639-2/B code (e.g. "eng") or plain name used to auto-pick an audio track. */
export type PlaybackSettings = {
  preferredAudioLanguage: string;
  preferredSubtitleLanguage: string;
  /** "auto" probes for multiple audio tracks and uses VLC only when needed. */
  videoEngine: "auto" | "vlc" | "html5";
};

export type AppConfig = {
  tmdbApiKey: string;
  thePornDbApiKey: string;
  googleClientId: string;
  rcloneConfigPath: string;
  rcloneConfigContent: string;  // actual file content for Drive sync
  remotes: RcloneRemote[];
  libraries: Library[];
  setupComplete: boolean;
  googleAccount: GoogleAccount | null;
  playback: PlaybackSettings;
  localStorageCapMb: number; // local cache cap in MB, defaults to 200 MB
  artworkRemoteMirrorEnabled: boolean; // mirror covers to remote
  photoSettings: PhotoSettings;
  issuedPasses: IssuedPass[];
  simklSettings: SimklSettings;
  traktSettings: SimklSettings;
  kaggleUsername: string;
  kaggleKey: string;
  iptvConfig: IptvConfig;
  easynewsConfig: EasynewsConfig;
  debridConfig: DebridConfig;
  rcloneSettings: RcloneSettings;
  streamtapeConfig: StreamtapeConfig;
  doodstreamConfig: DoodstreamConfig;
  catboxConfig?: { enabled: boolean; userhash?: string };
  stashBoxProviders?: Array<{ id: string; name: string; endpoint: string; apiKey: string; enabled: boolean }>;
  experimentalPhashEnabled?: boolean;
  keepAliveConfig: KeepAliveConfig;
  telegramConfig: TelegramConfig;
  dropmbConfig: DropmbConfig;
  storytellerConfig?: {
    serverUrl: string;
    apiKey?: string;
    autoSync?: boolean;
  };
  ghaConfig?: GhaConfig;
  stremioAddons?: StremioAddonConfig[];
  tvSubscriptions?: Record<string, TvSubscription>;
  themeConfig?: ThemeConfig;
};

export type ThemeAccent = "gold" | "emerald" | "cyan" | "crimson" | "amethyst" | "rose";

export type ThemeConfig = {
  accent: ThemeAccent;
  oledMode: boolean;
};

export const defaultThemeConfig: ThemeConfig = {
  accent: "gold",
  oledMode: false,
};

export type GhaConfig = {
  enabled: boolean;
  token: string;
  owner: string;
  repo: string;
  workflowFile?: string;
  allowPublicRepo?: boolean;
};

export type RcloneSettings = {
  dirCacheTime: string;
  vfsReadChunkSize: string;
  vfsReadChunkSizeLimit: string;
  vfsCacheMode: string;
  tpsLimit: number;
  tpsLimitBurst: number;
  autoScanOnStartup: boolean;
};

export const defaultRcloneSettings: RcloneSettings = {
  dirCacheTime: "72h",
  vfsReadChunkSize: "16M",
  vfsReadChunkSizeLimit: "64M",
  vfsCacheMode: "full",
  tpsLimit: 4,
  tpsLimitBurst: 2,
  autoScanOnStartup: false,
};

export type EasynewsConfig = {
  enabled: boolean;
  username: string;
  password: string;
  port: number; // 443 or 444
};

export type DebridConfig = {
  realDebridApiKey: string;
  premiumizeApiKey: string;
  offcloudApiKey: string;
};

export type StreamtapeConfig = {
  enabled: boolean;
  apiLogin: string;
  apiKey: string;
  autoOffload: boolean;
  autoOffloadLibraries: string[];
};

export const defaultStreamtapeConfig: StreamtapeConfig = {
  enabled: false,
  apiLogin: "",
  apiKey: "",
  autoOffload: false,
  autoOffloadLibraries: [],
};

export type DoodstreamConfig = {
  enabled: boolean;
  apiKey: string;
  autoOffload: boolean;
  autoOffloadLibraries: string[];
  autoMirror: boolean;
};

export const defaultDoodstreamConfig: DoodstreamConfig = {
  enabled: false,
  apiKey: "",
  autoOffload: false,
  autoOffloadLibraries: [],
  autoMirror: true,
};

export type KeepAliveConfig = {
  enabled: boolean;
  checkIntervalHours: number;
  maxDaysBeforeExpiry: number;
  maxBatchSize: number;
  visitDwellMs: number;
  lastRunAt?: number;
  totalKeptAlive: number;
  accountWideStreamtape?: boolean;
};

export const defaultKeepAliveConfig: KeepAliveConfig = {
  enabled: true,
  checkIntervalHours: 12,
  maxDaysBeforeExpiry: 25,
  maxBatchSize: 5,
  visitDwellMs: 12000,
  totalKeptAlive: 0,
  accountWideStreamtape: false,
};

export type TelegramConfig = {
  enabled: boolean;
  botToken: string;
  chatId: string;
  apiId?: string;
  apiHash?: string;
  workerUrl?: string;
};

export const defaultTelegramConfig: TelegramConfig = {
  enabled: false,
  botToken: "",
  chatId: "",
  apiId: "",
  apiHash: "",
};

export type DropmbConfig = {
  enabled: boolean;
  email: string;
  password?: string;
  token?: string;
};

export const defaultDropmbConfig: DropmbConfig = {
  enabled: false,
  email: "",
  password: "",
  token: "",
};

export type IptvConfig = {
  provider: "apollo" | "generic" | "xtream";
  username?: string;
  password?: string;
  domain?: string;
  serverUrl?: string;
  outputFormat?: "ts" | "m3u8";
  m3uUrl?: string;
  epgUrl?: string;
  favoriteChannels: string[];
};

export type SimklSettings = {
  enabled: boolean;
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  scrobbleEnabled: boolean;
  discoveryShelvesEnabled: boolean;
  lastDiscoveryFetchAt?: number;
  trendingMovies?: MediaItem[];
  anticipatedMovies?: MediaItem[];
  trendingShows?: MediaItem[];
  anticipatedShows?: MediaItem[];
};

export type TraktSettings = SimklSettings;

export type PhotoSettings = {
  configured: boolean;
  remoteName: string;
  folder: string;
  isEncrypted: boolean;
};

type AppStore = AppConfig & {
  mediaItems: Record<string, MediaItem>;
  watchProgress: Record<string, WatchProgress>;
  playlists: Record<string, Playlist>;
  favorites: Record<string, number>; // itemId -> favoritedAt timestamp
  galleries: Record<string, PhotoGallery>;
  audioBookmarks: Record<string, AudioBookmark[]>;
  scanState: ScanState;
  adultSettings: AdultSettings;
  syncState: SyncState;
  whispersyncPairs: Record<string, string>; // ebookId <-> audiobookId
  audioState: {
    playlist: MediaItem[];
    playlistIndex: number;
    playToken: number;
    shuffle?: boolean;
    repeatMode?: "off" | "all" | "one";
    expanded?: boolean;
  } | null;
  setAudioState: (
    state: {
      playlist: MediaItem[];
      playlistIndex: number;
      playToken: number;
      shuffle?: boolean;
      repeatMode?: "off" | "all" | "one";
      expanded?: boolean;
    } | null
  ) => void;
  enqueueAudioNext: (item: MediaItem) => void;
  enqueueAudioEnd: (items: MediaItem | MediaItem[]) => void;
  removeFromAudioQueue: (index: number) => void;
  reorderAudioQueue: (fromIndex: number, toIndex: number) => void;
  toggleAudioShuffle: () => void;
  cycleAudioRepeat: () => void;
  setAudioExpanded: (expanded: boolean) => void;
  setAudioPlaylistIndex: (index: number) => void;

  // Plexamp / Finamp / Winamp Compact Music Player Skin Mode
  isMusicSkinMode: boolean;
  musicSkinTab: "playing" | "lyrics" | "queue" | "library" | "notes";
  isSkinPinnedOnTop: boolean;
  prevWindowBounds: { width: number; height: number; x: number; y: number } | null;
  setMusicSkinMode: (active: boolean) => void;
  setMusicSkinTab: (tab: "playing" | "lyrics" | "queue" | "library" | "notes") => void;
  setSkinPinnedOnTop: (pinned: boolean) => void;
  setPrevWindowBounds: (bounds: { width: number; height: number; x: number; y: number } | null) => void;

  // Whispersync
  setWhispersyncPair: (ebookId: string, audiobookId: string) => void;
  removeWhispersyncPair: (id: string) => void;

  // Config
  setTmdbApiKey: (key: string) => void;
  setThePornDbApiKey: (key: string) => void;
  setGoogleClientId: (id: string) => void;
  setRcloneConfigPath: (path: string) => void;
  setRcloneConfigContent: (content: string) => void;
  setRemotes: (remotes: RcloneRemote[]) => void;
  setLibraries: (libraries: Library[]) => void;
  addLibrary: (lib: Library) => void;
  removeLibrary: (id: string) => void;
  updateLibrary: (id: string, updates: Partial<Library>) => void;
  addIssuedPass: (pass: IssuedPass) => void;
  removeIssuedPass: (passId: string) => void;
  updateIssuedPass: (passId: string, updates: Partial<IssuedPass>) => void;
  markLibraryExpired: (passId: string) => void;
  completeSetup: () => void;
  setGoogleAccount: (account: GoogleAccount | null) => void;
  setPlaybackSettings: (updates: Partial<PlaybackSettings>) => void;
  setLocalStorageCapMb: (mb: number) => void;
  setArtworkRemoteMirrorEnabled: (enabled: boolean) => void;
  setPhotoSettings: (settings: PhotoSettings) => void;

  // Weekly Recommendations
  adminWeeklyRecommendations?: AdminWeeklyRecommendations;
  guestRecommendations?: WeeklyRecommendation[];
  setLibraryRecommendation: (
    libraryId: string,
    rec: WeeklyRecommendation
  ) => { success: boolean; error?: string };
  removeLibraryRecommendation: (libraryId: string, itemId: string) => void;
  updateLibraryRecommendationEffect: (
    libraryId: string,
    effect: RecommendationBadgeEffect,
    badgeText?: string
  ) => void;

  // Multi-Account Pools
  ghaAccounts?: GhaAccount[];
  kaggleAccounts?: KaggleAccount[];
  setGhaAccounts: (accounts: GhaAccount[]) => void;
  setKaggleAccounts: (accounts: KaggleAccount[]) => void;
  setSimklSettings: (settings: Partial<SimklSettings>) => void;
  setSimklDiscoveryData: (data: {
    trendingMovies?: MediaItem[];
    anticipatedMovies?: MediaItem[];
    trendingShows?: MediaItem[];
    anticipatedShows?: MediaItem[];
    lastDiscoveryFetchAt?: number;
  }) => void;
  setTraktSettings: (settings: Partial<SimklSettings>) => void;
  setTraktDiscoveryData: (data: {
    trendingMovies?: MediaItem[];
    anticipatedMovies?: MediaItem[];
    trendingShows?: MediaItem[];
    anticipatedShows?: MediaItem[];
    lastDiscoveryFetchAt?: number;
  }) => void;
  setEasynewsConfig: (updates: Partial<EasynewsConfig>) => void;
  setDebridConfig: (updates: Partial<DebridConfig>) => void;
  setRcloneSettings: (updates: Partial<RcloneSettings>) => void;
  setStreamtapeConfig: (updates: Partial<StreamtapeConfig>) => void;
  setDoodstreamConfig: (updates: Partial<DoodstreamConfig>) => void;
  setCatboxConfig: (updates: Partial<{ enabled: boolean; userhash?: string }>) => void;
  setStashBoxProviders: (providers: Array<{ id: string; name: string; endpoint: string; apiKey: string; enabled: boolean }>) => void;
  setExperimentalPhashEnabled: (enabled: boolean) => void;
  setKeepAliveConfig: (updates: Partial<KeepAliveConfig>) => void;
  setTelegramConfig: (updates: Partial<TelegramConfig>) => void;
  setDropmbConfig: (updates: Partial<DropmbConfig>) => void;
  setStorytellerConfig: (updates: Partial<{ serverUrl: string; apiKey?: string; autoSync?: boolean }>) => void;
  resetConfig: () => void;
  importConfig: (config: Partial<AppConfig> & {
    mediaItems?: Record<string, MediaItem>;
    watchProgress?: Record<string, WatchProgress>;
    playlists?: Record<string, Playlist>;
    favorites?: Record<string, number>;
    galleries?: Record<string, PhotoGallery>;
    audioBookmarks?: Record<string, AudioBookmark[]>;
  }) => void;

  // Audio Bookmarks
  addAudioBookmark: (bookmark: AudioBookmark) => void;
  removeAudioBookmark: (itemId: string, bookmarkId: string) => void;

  // Photo Galleries
  upsertGallery: (gallery: PhotoGallery) => void;
  removeGallery: (id: string) => void;
  addPhotoToGallery: (galleryId: string, photo: GalleryPhoto) => void;
  removePhotoFromGallery: (galleryId: string, photoId: string) => void;

  // Media
  upsertMediaItem: (item: MediaItem) => void;
  removeMediaItem: (id: string) => void;
  bulkUpsertMediaItems: (items: MediaItem[]) => void;
  updateItemMetadata: (id: string, updates: Partial<MediaItem>) => void;
  setItemUserTags: (itemId: string, tags: string[]) => void;
  bulkAddUserTag: (itemIds: string[], tag: string) => void;
  clearLibraryItems: (libraryId: string) => void;

  // Watch Progress
  updateWatchProgress: (progress: WatchProgress) => void;
  markCompleted: (itemId: string) => void;
  clearProgress: (itemId: string) => void;
  toggleWatchCompleted: (itemId: string, completed?: boolean) => boolean;
  markMultipleCompleted: (itemIds: string[], completed: boolean) => void;

  // Playlists
  createPlaylist: (
    name: string,
    type?: "music" | "video" | "mixed",
    description?: string,
    initialItemIds?: string[]
  ) => string;
  updatePlaylist: (id: string, updates: Partial<Omit<Playlist, "id" | "createdAt">>) => void;
  setPlaylist: (playlist: Playlist) => void;
  deletePlaylist: (id: string) => void;
  addToPlaylist: (playlistId: string, itemIds: string | string[]) => void;
  removeFromPlaylist: (playlistId: string, itemId: string) => void;
  reorderPlaylist: (playlistId: string, itemIds: string[]) => void;

  // Favorites
  toggleFavorite: (itemId: string) => boolean;
  setFavorite: (itemId: string, favoritedAt?: number | null) => void;

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

  // Kaggle Cloud Transcoder
  setKaggleUsername: (username: string) => void;
  setKaggleKey: (key: string) => void;

  // Cloud Worker Rotation (GitHub Actions Fallback)
  setGhaConfig: (config: Partial<GhaConfig>) => void;

  // IPTV & Live TV
  setIptvConfig: (config: Partial<IptvConfig>) => void;
  toggleIptvFavorite: (channelId: string) => void;

  // Stremio Addons
  addStremioAddon: (addon: StremioAddonConfig) => void;
  removeStremioAddon: (id: string) => void;
  toggleStremioAddon: (id: string, enabled: boolean) => void;

  // TV Subscriptions
  upsertTvSubscription: (sub: TvSubscription) => void;
  removeTvSubscription: (seriesId: string) => void;

  // Cloud Explorer Persisted Navigation State
  explorerLastRemote: string;
  explorerLastSegments: string[];
  setExplorerNavigationState: (remote: string, segments: string[]) => void;

  // Appearance & Themes
  setThemeConfig: (updates: Partial<ThemeConfig>) => void;
};

const defaultAdultSettings: AdultSettings = {
  hidden: false, pinEnabled: false, pinHash: "", pinLength: 4, unlocked: false,
};

const defaultScanState: ScanState = { status: "idle", newItemsFound: 0 };

const defaultPlayback: PlaybackSettings = {
  preferredAudioLanguage: "eng",
  preferredSubtitleLanguage: "",
  videoEngine: "auto",
};

const defaultConfig: AppConfig = {
  tmdbApiKey: "", thePornDbApiKey: "", googleClientId: "", rcloneConfigPath: "",
  rcloneConfigContent: "", remotes: [], libraries: [],
  setupComplete: false, googleAccount: null,
  playback: defaultPlayback,
  localStorageCapMb: 200,
  artworkRemoteMirrorEnabled: true,
  kaggleUsername: "",
  kaggleKey: "",
  photoSettings: {
    configured: false,
    remoteName: "",
    folder: "Photos",
    isEncrypted: false,
  },
  issuedPasses: [],
  simklSettings: {
    enabled: false,
    clientId: "",
    scrobbleEnabled: false,
    discoveryShelvesEnabled: true,
    lastDiscoveryFetchAt: 0,
    trendingMovies: [],
    anticipatedMovies: [],
    trendingShows: [],
    anticipatedShows: [],
  },
  traktSettings: {
    enabled: false,
    clientId: "",
    scrobbleEnabled: false,
    discoveryShelvesEnabled: true,
    lastDiscoveryFetchAt: 0,
    trendingMovies: [],
    anticipatedMovies: [],
    trendingShows: [],
    anticipatedShows: [],
  },
  iptvConfig: {
    provider: "apollo",
    username: "",
    password: "",
    domain: "tvnow.best",
    m3uUrl: "",
    epgUrl: "",
    favoriteChannels: [],
  },
  easynewsConfig: {
    enabled: false,
    username: "",
    password: "",
    port: 443,
  },
  debridConfig: {
    realDebridApiKey: "",
    premiumizeApiKey: "",
    offcloudApiKey: "",
  },
  rcloneSettings: defaultRcloneSettings,
  streamtapeConfig: defaultStreamtapeConfig,
  doodstreamConfig: defaultDoodstreamConfig,
  keepAliveConfig: defaultKeepAliveConfig,
  telegramConfig: defaultTelegramConfig,
  dropmbConfig: defaultDropmbConfig,
  storytellerConfig: {
    serverUrl: "",
    apiKey: "",
    autoSync: false,
  },
  ghaConfig: {
    enabled: false,
    token: "",
    owner: "",
    repo: "",
    workflowFile: "cloud_worker.yml",
  },
  stremioAddons: [],
  tvSubscriptions: {},
  themeConfig: defaultThemeConfig,
};

const defaultIptvConfig: IptvConfig = {
  provider: "apollo",
  username: "",
  password: "",
  domain: "tvnow.best",
  serverUrl: "",
  outputFormat: "ts",
  m3uUrl: "",
  epgUrl: "",
  favoriteChannels: [],
};

const rcloneflixConfigStorage: StateStorage = {
  getItem: (name: string): string | null => {
    try {
      if (typeof localStorage !== "undefined") {
        const lsVal = localStorage.getItem(name);
        if (lsVal) return lsVal;
      }
    } catch {}
    try {
      const bridge = typeof window !== "undefined" ? (window as any).AndroidBridge : undefined;
      if (bridge?.readStorageFile) {
        const nativeVal = bridge.readStorageFile(name);
        if (nativeVal && nativeVal.trim().startsWith("{")) {
          try {
            if (typeof localStorage !== "undefined") {
              localStorage.setItem(name, nativeVal);
            }
          } catch {}
          return nativeVal;
        }
      }
    } catch {}
    return null;
  },
  setItem: (name: string, value: string): void => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(name, value);
      }
    } catch (e) {
      console.warn("[appStore] localStorage.setItem failed:", e);
    }
    try {
      const bridge = typeof window !== "undefined" ? (window as any).AndroidBridge : undefined;
      if (bridge?.writeStorageFile) {
        bridge.writeStorageFile(name, value);
      }
    } catch {}
  },
  removeItem: (name: string): void => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(name);
      }
    } catch {}
    try {
      const bridge = typeof window !== "undefined" ? (window as any).AndroidBridge : undefined;
      if (bridge?.writeStorageFile) {
        bridge.writeStorageFile(name, "");
      }
    } catch {}
  },
};

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      ...defaultConfig,
      mediaItems: {},
      adminWeeklyRecommendations: {},
      guestRecommendations: [],
      ghaAccounts: [],
      kaggleAccounts: [],
      watchProgress: {},
      playlists: {},
      favorites: {},
      galleries: {},
      audioBookmarks: {},
      whispersyncPairs: {},
      audioState: null,
      setAudioState: (audioState) =>
        set((s) => ({
          audioState: audioState
            ? {
                shuffle: s.audioState?.shuffle ?? false,
                repeatMode: s.audioState?.repeatMode ?? "off",
                expanded: s.audioState?.expanded ?? false,
                ...audioState,
              }
            : null,
        })),
      enqueueAudioNext: (item) =>
        set((s) => {
          if (!s.audioState) {
            return {
              audioState: {
                playlist: [item],
                playlistIndex: 0,
                playToken: Date.now(),
                shuffle: false,
                repeatMode: "off",
                expanded: false,
              },
            };
          }
          const nextList = [...s.audioState.playlist];
          const insertIdx = Math.min(nextList.length, s.audioState.playlistIndex + 1);
          nextList.splice(insertIdx, 0, item);
          return {
            audioState: {
              ...s.audioState,
              playlist: nextList,
            },
          };
        }),
      enqueueAudioEnd: (items) =>
        set((s) => {
          const arr = Array.isArray(items) ? items : [items];
          if (arr.length === 0) return {};
          if (!s.audioState) {
            return {
              audioState: {
                playlist: arr,
                playlistIndex: 0,
                playToken: Date.now(),
                shuffle: false,
                repeatMode: "off",
                expanded: false,
              },
            };
          }
          return {
            audioState: {
              ...s.audioState,
              playlist: [...s.audioState.playlist, ...arr],
            },
          };
        }),
      removeFromAudioQueue: (index) =>
        set((s) => {
          if (!s.audioState) return {};
          const nextList = s.audioState.playlist.filter((_, i) => i !== index);
          if (nextList.length === 0) return { audioState: null };
          let nextIdx = s.audioState.playlistIndex;
          if (index < nextIdx) nextIdx = Math.max(0, nextIdx - 1);
          else if (nextIdx >= nextList.length) nextIdx = nextList.length - 1;
          return {
            audioState: {
              ...s.audioState,
              playlist: nextList,
              playlistIndex: nextIdx,
            },
          };
        }),
      reorderAudioQueue: (fromIndex, toIndex) =>
        set((s) => {
          if (!s.audioState) return {};
          const list = [...s.audioState.playlist];
          if (
            fromIndex < 0 ||
            fromIndex >= list.length ||
            toIndex < 0 ||
            toIndex >= list.length ||
            fromIndex === toIndex
          ) {
            return {};
          }
          const currentItem = list[s.audioState.playlistIndex];
          const [moved] = list.splice(fromIndex, 1);
          list.splice(toIndex, 0, moved);
          const newCurrentIdx = currentItem ? list.indexOf(currentItem) : s.audioState.playlistIndex;
          return {
            audioState: {
              ...s.audioState,
              playlist: list,
              playlistIndex: newCurrentIdx >= 0 ? newCurrentIdx : 0,
            },
          };
        }),
      toggleAudioShuffle: () =>
        set((s) => {
          if (!s.audioState) return {};
          return {
            audioState: {
              ...s.audioState,
              shuffle: !s.audioState.shuffle,
            },
          };
        }),
      cycleAudioRepeat: () =>
        set((s) => {
          if (!s.audioState) return {};
          const cur = s.audioState.repeatMode ?? "off";
          const next = cur === "off" ? "all" : cur === "all" ? "one" : "off";
          return {
            audioState: {
              ...s.audioState,
              repeatMode: next,
            },
          };
        }),
      setAudioExpanded: (expanded) =>
        set((s) => {
          if (!s.audioState) return {};
          return {
            audioState: {
              ...s.audioState,
              expanded,
            },
          };
        }),
      setAudioPlaylistIndex: (playlistIndex) =>
        set((s) => {
          if (!s.audioState || s.audioState.playlistIndex === playlistIndex) return {};
          return {
            audioState: {
              ...s.audioState,
              playlistIndex,
            },
          };
        }),
      isMusicSkinMode: false,
      musicSkinTab: "playing",
      isSkinPinnedOnTop: true,
      prevWindowBounds: null,
      setMusicSkinMode: (isMusicSkinMode) =>
        set((s) => ({
          isMusicSkinMode,
          musicSkinTab: isMusicSkinMode
            ? s.audioState?.playlist?.length
              ? "playing"
              : "library"
            : s.musicSkinTab,
          audioState: s.audioState ? { ...s.audioState, expanded: false } : null,
        })),
      setMusicSkinTab: (musicSkinTab) => set({ musicSkinTab }),
      setSkinPinnedOnTop: (isSkinPinnedOnTop) => set({ isSkinPinnedOnTop }),
      setPrevWindowBounds: (prevWindowBounds) => set({ prevWindowBounds }),
      explorerLastRemote: "",
      explorerLastSegments: [],
      setExplorerNavigationState: (explorerLastRemote, explorerLastSegments) =>
        set({ explorerLastRemote, explorerLastSegments }),

      setThemeConfig: (updates) =>
        set((s) => {
          const next = { ...(s.themeConfig || defaultThemeConfig), ...updates };
          try {
            if (typeof document !== "undefined") {
              document.documentElement.setAttribute("data-accent", next.accent);
              document.documentElement.setAttribute("data-oled", next.oledMode ? "true" : "false");
            }
          } catch {}
          return { themeConfig: next };
        }),
      scanState: defaultScanState,
      adultSettings: defaultAdultSettings,
      syncState: { syncing: false },

      setWhispersyncPair: (ebookId, audiobookId) =>
        set((s) => ({
          whispersyncPairs: {
            ...s.whispersyncPairs,
            [ebookId]: audiobookId,
            [audiobookId]: ebookId,
          },
        })),

      removeWhispersyncPair: (id) =>
        set((s) => {
          const next = { ...s.whispersyncPairs };
          const paired = next[id];
          delete next[id];
          if (paired) delete next[paired];
          return { whispersyncPairs: next };
        }),

      setTmdbApiKey: (key) => set({ tmdbApiKey: key }),
      setThePornDbApiKey: (key) => set({ thePornDbApiKey: key }),
      setKaggleUsername: (username) => set({ kaggleUsername: username }),
      setKaggleKey: (key) => set({ kaggleKey: key }),
      setIptvConfig: (cfg) =>
        set((s) => ({
          iptvConfig: {
            ...(s.iptvConfig || defaultIptvConfig),
            ...cfg,
          },
        })),
      toggleIptvFavorite: (channelId) =>
        set((s) => {
          const base = s.iptvConfig || defaultIptvConfig;
          const current = base.favoriteChannels || [];
          const exists = current.includes(channelId);
          return {
            iptvConfig: {
              ...base,
              favoriteChannels: exists
                ? current.filter((id) => id !== channelId)
                : [...current, channelId],
            },
          };
        }),
      setGoogleClientId: (id) => set({ googleClientId: id }),
      setRcloneConfigPath: (path) => set({ rcloneConfigPath: path }),
      setRcloneConfigContent: (content) => set({ rcloneConfigContent: content }),
      setRemotes: (remotes) => set({ remotes }),
      setLibraries: (libraries) => set({ libraries }),
      addLibrary: (lib) => set((s) => ({ libraries: [...s.libraries, lib] })),
      removeLibrary: (id) => set((s) => ({ libraries: s.libraries.filter((l) => l.id !== id) })),
      updateLibrary: (id, updates) =>
        set((s) => ({ libraries: s.libraries.map((l) => l.id === id ? { ...l, ...updates } : l) })),
      addIssuedPass: (pass) =>
        set((s) => ({ issuedPasses: [...(s.issuedPasses || []), pass] })),
      removeIssuedPass: (passId) =>
        set((s) => ({ issuedPasses: (s.issuedPasses || []).filter((p) => p.passId !== passId) })),
      updateIssuedPass: (passId, updates) =>
        set((s) => ({
          issuedPasses: (s.issuedPasses || []).map((p) =>
            p.passId === passId ? { ...p, ...updates } : p
          ),
        })),
      markLibraryExpired: (passId) =>
        set((s) => ({
          libraries: (s.libraries || []).map((l) =>
            l.passId === passId ? { ...l, isExpired: true } : l
          ),
          issuedPasses: (s.issuedPasses || []).map((p) =>
            p.passId === passId ? { ...p, status: "expired" } : p
          ),
        })),
      completeSetup: () => set({ setupComplete: true }),
      setGoogleAccount: (account) => set({ googleAccount: account }),
      setPlaybackSettings: (updates) =>
        set((s) => ({ playback: { ...s.playback, ...updates } })),
      setLocalStorageCapMb: (localStorageCapMb) => set({ localStorageCapMb }),
      setArtworkRemoteMirrorEnabled: (artworkRemoteMirrorEnabled) => set({ artworkRemoteMirrorEnabled }),
      setPhotoSettings: (photoSettings) => set({ photoSettings }),
      setLibraryRecommendation: (libraryId, rec) => {
        const currentWeek = getIsoWeekString();
        const existing = get().adminWeeklyRecommendations?.[libraryId];
        const activeItems = (existing?.weekId === currentWeek ? existing.items : []).filter(
          (item) => item.itemId !== rec.itemId
        );
        if (activeItems.length >= 3) {
          return {
            success: false,
            error: "Weekly limit reached. You can only recommend up to 3 titles per library per week. Remove one to add this.",
          };
        }
        const updatedItems = [...activeItems, { ...rec, addedAt: Date.now() }];
        set((state) => ({
          adminWeeklyRecommendations: {
            ...(state.adminWeeklyRecommendations || {}),
            [libraryId]: {
              weekId: currentWeek,
              items: updatedItems,
            },
          },
        }));
        return { success: true };
      },
      removeLibraryRecommendation: (libraryId, itemId) => {
        set((state) => {
          const existing = state.adminWeeklyRecommendations?.[libraryId];
          if (!existing) return state;
          return {
            adminWeeklyRecommendations: {
              ...state.adminWeeklyRecommendations,
              [libraryId]: {
                ...existing,
                items: existing.items.filter((i) => i.itemId !== itemId),
              },
            },
          };
        });
      },
      updateLibraryRecommendationEffect: (libraryId, effect, badgeText) => {
        set((state) => {
          const existing = state.adminWeeklyRecommendations?.[libraryId];
          if (!existing) return state;
          return {
            adminWeeklyRecommendations: {
              ...state.adminWeeklyRecommendations,
              [libraryId]: {
                ...existing,
                items: existing.items.map((i) => ({
                  ...i,
                  badgeEffect: effect,
                  ...(badgeText ? { badgeText } : {}),
                })),
              },
            },
          };
        });
      },
      setGhaAccounts: (accounts) => set({ ghaAccounts: accounts }),
      setKaggleAccounts: (accounts) => set({ kaggleAccounts: accounts }),
      setSimklSettings: (updates) =>
        set((s) => ({ simklSettings: { ...s.simklSettings, ...updates } })),
      setSimklDiscoveryData: (data) =>
        set((s) => ({ simklSettings: { ...s.simklSettings, ...data } })),
      setTraktSettings: (updates) =>
        set((s) => ({ traktSettings: { ...s.traktSettings, ...updates } })),
      setTraktDiscoveryData: (data) =>
        set((s) => ({ traktSettings: { ...s.traktSettings, ...data } })),
      setEasynewsConfig: (updates) =>
        set((s) => ({ easynewsConfig: { ...s.easynewsConfig, ...updates } })),
      setDebridConfig: (updates) =>
        set((s) => ({ debridConfig: { ...s.debridConfig, ...updates } })),
      setRcloneSettings: (updates) =>
        set((s) => ({ rcloneSettings: { ...(s.rcloneSettings || defaultRcloneSettings), ...updates } })),
      setStreamtapeConfig: (updates) =>
        set((s) => ({ streamtapeConfig: { ...(s.streamtapeConfig || defaultStreamtapeConfig), ...updates } })),
      setDoodstreamConfig: (updates) =>
        set((s) => ({ doodstreamConfig: { ...(s.doodstreamConfig || defaultDoodstreamConfig), ...updates } })),
      setCatboxConfig: (updates) =>
        set((s) => ({ catboxConfig: { enabled: false, ...(s.catboxConfig || {}), ...updates } })),
      setStashBoxProviders: (providers) => set({ stashBoxProviders: providers }),
      setExperimentalPhashEnabled: (enabled) => set({ experimentalPhashEnabled: enabled }),
      setKeepAliveConfig: (updates) =>
        set((s) => ({ keepAliveConfig: { ...(s.keepAliveConfig || defaultKeepAliveConfig), ...updates } })),
      setTelegramConfig: (updates) =>
        set((s) => ({ telegramConfig: { ...(s.telegramConfig || defaultTelegramConfig), ...updates } })),
      setDropmbConfig: (updates) =>
        set((s) => ({ dropmbConfig: { ...(s.dropmbConfig || defaultDropmbConfig), ...updates } })),
      setStorytellerConfig: (updates) =>
        set((s) => ({
          storytellerConfig: {
            serverUrl: "",
            apiKey: "",
            autoSync: false,
            ...(s.storytellerConfig || {}),
            ...updates,
          },
        })),
      setGhaConfig: (updates) =>
        set((s) => ({
          ghaConfig: {
            enabled: false,
            token: "",
            owner: "",
            repo: "",
            workflowFile: "cloud_worker.yml",
            ...(s.ghaConfig || {}),
            ...updates,
          },
        })),

      addStremioAddon: (addon) =>
        set((s) => {
          const existing = (s.stremioAddons || []).filter(
            (a) => a.manifestUrl !== addon.manifestUrl && a.id !== addon.id
          );
          return { stremioAddons: [...existing, addon] };
        }),
      removeStremioAddon: (id) =>
        set((s) => ({
          stremioAddons: (s.stremioAddons || []).filter((a) => a.id !== id && a.manifestUrl !== id),
        })),
      toggleStremioAddon: (id, enabled) =>
        set((s) => ({
          stremioAddons: (s.stremioAddons || []).map((a) =>
            a.id === id || a.manifestUrl === id ? { ...a, enabled } : a
          ),
        })),

      upsertTvSubscription: (sub) =>
        set((s) => ({
          tvSubscriptions: {
            ...(s.tvSubscriptions || {}),
            [sub.seriesId]: sub,
          },
        })),
      removeTvSubscription: (seriesId) =>
        set((s) => {
          const next = { ...(s.tvSubscriptions || {}) };
          delete next[seriesId];
          return { tvSubscriptions: next };
        }),
      resetConfig: () => set({
        ...defaultConfig,
        mediaItems: {},
      adminWeeklyRecommendations: {},
      guestRecommendations: [],
      ghaAccounts: [],
      kaggleAccounts: [],
        watchProgress: {},
        playlists: {},
        favorites: {},
        galleries: {},
        audioBookmarks: {},
        scanState: defaultScanState,
        adultSettings: defaultAdultSettings,
        syncState: { syncing: false },
      }),
      importConfig: (config) => set((s) => ({
        ...s,
        ...config,
        mediaItems: config.mediaItems ?? s.mediaItems,
        watchProgress: config.watchProgress ?? s.watchProgress,
        playlists: config.playlists ?? s.playlists,
        favorites: config.favorites ?? s.favorites,
        galleries: config.galleries ?? s.galleries,
        audioBookmarks: config.audioBookmarks ?? s.audioBookmarks,
      })),

      addAudioBookmark: (bookmark) =>
        set((s) => {
          const list = s.audioBookmarks?.[bookmark.itemId] || [];
          const exists = list.some((b) => b.id === bookmark.id);
          const updated = exists
            ? list.map((b) => (b.id === bookmark.id ? bookmark : b))
            : [...list, bookmark];
          return {
            audioBookmarks: {
              ...(s.audioBookmarks || {}),
              [bookmark.itemId]: updated.sort((a, b) => a.timestamp - b.timestamp),
            },
          };
        }),
      removeAudioBookmark: (itemId, bookmarkId) =>
        set((s) => {
          const list = s.audioBookmarks?.[itemId] || [];
          return {
            audioBookmarks: {
              ...(s.audioBookmarks || {}),
              [itemId]: list.filter((b) => b.id !== bookmarkId),
            },
          };
        }),

      upsertGallery: (gallery) =>
        set((s) => ({
          galleries: { ...s.galleries, [gallery.id]: gallery },
        })),
      removeGallery: (id) =>
        set((s) => {
          const next = { ...s.galleries };
          delete next[id];
          return { galleries: next };
        }),
      addPhotoToGallery: (galleryId, photo) =>
        set((s) => {
          const gallery = s.galleries[galleryId];
          if (!gallery) return s;
          const exists = gallery.photos.some((p) => p.id === photo.id);
          const updatedPhotos = exists
            ? gallery.photos.map((p) => (p.id === photo.id ? photo : p))
            : [...gallery.photos, photo];
          return {
            galleries: {
              ...s.galleries,
              [galleryId]: {
                ...gallery,
                coverPhotoId: gallery.coverPhotoId || photo.id,
                photos: updatedPhotos,
                updatedAt: Date.now(),
              },
            },
          };
        }),
      removePhotoFromGallery: (galleryId, photoId) =>
        set((s) => {
          const gallery = s.galleries[galleryId];
          if (!gallery) return s;
          const updatedPhotos = gallery.photos.filter((p) => p.id !== photoId);
          return {
            galleries: {
              ...s.galleries,
              [galleryId]: {
                ...gallery,
                coverPhotoId:
                  gallery.coverPhotoId === photoId
                    ? updatedPhotos[0]?.id
                    : gallery.coverPhotoId,
                photos: updatedPhotos,
                updatedAt: Date.now(),
              },
            },
          };
        }),

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
      setItemUserTags: (itemId, tags) => {
        const clean = Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean)));
        let updatedItem: MediaItem | null = null;
        set((s) => {
          const cur = s.mediaItems[itemId];
          if (!cur) return s;
          updatedItem = { ...cur, userTags: clean };
          return { mediaItems: { ...s.mediaItems, [itemId]: updatedItem } };
        });
        if (updatedItem) {
          import("../lib/libraryDb").then(({ persistItems }) => persistItems([updatedItem!])).catch(() => {});
        }
      },
      bulkAddUserTag: (itemIds, tag) => {
        const cleanTag = tag.trim();
        if (!cleanTag || itemIds.length === 0) return;
        const updatedList: MediaItem[] = [];
        set((s) => {
          const next = { ...s.mediaItems };
          for (const id of itemIds) {
            const cur = next[id];
            if (!cur) continue;
            const merged = Array.from(new Set([...(cur.userTags || []), cleanTag]));
            const upd = { ...cur, userTags: merged };
            next[id] = upd;
            updatedList.push(upd);
          }
          return { mediaItems: next };
        });
        if (updatedList.length > 0) {
          import("../lib/libraryDb").then(({ persistItems }) => persistItems(updatedList)).catch(() => {});
        }
      },
      clearLibraryItems: (libraryId) =>
        set((s) => {
          const n: Record<string, MediaItem> = {};
          Object.values(s.mediaItems).forEach((i) => { if (i.libraryId !== libraryId) n[i.id] = i; });
          return { mediaItems: n };
        }),

      updateWatchProgress: (progress) =>
        set((s) => {
          const next = { ...s.watchProgress, [progress.itemId]: progress };
          const item = s.mediaItems[progress.itemId];
          if (item) {
            const key = getMediaItemDeduplicationKey(item);
            for (const other of Object.values(s.mediaItems)) {
              if (other.id !== progress.itemId && getMediaItemDeduplicationKey(other) === key) {
                next[other.id] = { ...progress, itemId: other.id };
              }
            }

            // Whispersync: propagate progress percentage to paired ebook or audiobook
            const pairedId = s.whispersyncPairs[progress.itemId];
            if (pairedId && s.mediaItems[pairedId]) {
              const pairedItem = s.mediaItems[pairedId];
              const pct =
                progress.percentage ??
                (progress.duration > 0 ? progress.position / progress.duration : undefined);
              if (pct !== undefined) {
                const existingPaired = s.watchProgress[pairedId];
                const pairedDur = pairedItem.duration || existingPaired?.duration || 0;
                const pairedPos = pairedDur > 0 ? Math.round(pct * pairedDur) : existingPaired?.position || 0;
                next[pairedId] = {
                  ...(existingPaired || {
                    position: 0,
                    duration: pairedDur,
                    completed: false,
                    lastWatchedAt: Date.now(),
                  }),
                  itemId: pairedId,
                  percentage: pct,
                  position: pairedPos,
                  duration: pairedDur,
                  completed: pct >= 0.95,
                  lastWatchedAt: Date.now(),
                };
              }
            }
          }
          return { watchProgress: next };
        }),
      markCompleted: (itemId) =>
        set((s) => {
          const next = { ...s.watchProgress };
          const item = s.mediaItems[itemId];
          const key = item ? getMediaItemDeduplicationKey(item) : null;
          const matchingIds = [itemId];
          if (key) {
            for (const other of Object.values(s.mediaItems)) {
              if (other.id !== itemId && getMediaItemDeduplicationKey(other) === key) {
                matchingIds.push(other.id);
              }
            }
          }
          const now = Date.now();
          for (const id of matchingIds) {
            const it = s.mediaItems[id] || item;
            const dur =
              next[id]?.duration && next[id].duration > 0
                ? next[id].duration
                : it?.duration && it.duration > 0
                ? it.duration
                : 100;
            next[id] = {
              ...(next[id] || { itemId: id }),
              itemId: id,
              position: dur,
              duration: dur,
              percentage: 1.0,
              completed: true,
              lastWatchedAt: now,
            };
          }
          if (item) {
            import("../lib/simkl")
              .then(({ simklScrobble }) => simklScrobble("stop", item, 100))
              .catch(() => {});
          }
          return { watchProgress: next };
        }),
      clearProgress: (itemId) =>
        set((s) => {
          const next = { ...s.watchProgress };
          const item = s.mediaItems[itemId];
          const key = item ? getMediaItemDeduplicationKey(item) : null;
          const matchingIds = [itemId];
          if (key) {
            for (const other of Object.values(s.mediaItems)) {
              if (other.id !== itemId && getMediaItemDeduplicationKey(other) === key) {
                matchingIds.push(other.id);
              }
            }
          }
          for (const id of matchingIds) {
            delete next[id];
          }
          return { watchProgress: next };
        }),
      toggleWatchCompleted: (itemId, forceCompleted) => {
        const s = get();
        const existing = s.watchProgress[itemId];
        const isCurrentlyCompleted = !!(existing?.completed || (existing?.duration && existing.position / existing.duration >= 0.9));
        const targetCompleted = typeof forceCompleted === "boolean" ? forceCompleted : !isCurrentlyCompleted;
        if (targetCompleted) {
          s.markCompleted(itemId);
        } else {
          s.clearProgress(itemId);
        }
        return targetCompleted;
      },
      markMultipleCompleted: (itemIds, completed) =>
        set((s) => {
          const next = { ...s.watchProgress };
          const now = Date.now();
          for (const itemId of itemIds) {
            const item = s.mediaItems[itemId];
            const key = item ? getMediaItemDeduplicationKey(item) : null;
            const matchingIds = [itemId];
            if (key) {
              for (const other of Object.values(s.mediaItems)) {
                if (other.id !== itemId && getMediaItemDeduplicationKey(other) === key) {
                  matchingIds.push(other.id);
                }
              }
            }
            for (const id of matchingIds) {
              if (completed) {
                const it = s.mediaItems[id] || item;
                const dur =
                  next[id]?.duration && next[id].duration > 0
                    ? next[id].duration
                    : it?.duration && it.duration > 0
                    ? it.duration
                    : 100;
                next[id] = {
                  ...(next[id] || { itemId: id }),
                  itemId: id,
                  position: dur,
                  duration: dur,
                  percentage: 1.0,
                  completed: true,
                  lastWatchedAt: now,
                };
              } else {
                delete next[id];
              }
            }
          }
          return { watchProgress: next };
        }),

      createPlaylist: (name, type = "mixed", description, initialItemIds = []) => {
        const id = `pl-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const now = Date.now();
        const playlist: Playlist = {
          id,
          name: name.trim() || "Untitled Playlist",
          description,
          type,
          itemIds: [...initialItemIds],
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          playlists: { ...s.playlists, [id]: playlist },
        }));
        return id;
      },
      updatePlaylist: (id, updates) =>
        set((s) => {
          const existing = s.playlists[id];
          if (!existing) return s;
          return {
            playlists: {
              ...s.playlists,
              [id]: {
                ...existing,
                ...updates,
                updatedAt: Date.now(),
              },
            },
          };
        }),
      setPlaylist: (playlist) =>
        set((s) => ({
          playlists: { ...s.playlists, [playlist.id]: playlist },
        })),
      deletePlaylist: (id) =>
        set((s) => {
          const next = { ...s.playlists };
          delete next[id];
          return { playlists: next };
        }),
      addToPlaylist: (playlistId, itemIds) =>
        set((s) => {
          const existing = s.playlists[playlistId];
          if (!existing) return s;
          const idsToAdd = Array.isArray(itemIds) ? itemIds : [itemIds];
          const existingSet = new Set(existing.itemIds);
          const newIds = idsToAdd.filter((id) => !existingSet.has(id));
          if (newIds.length === 0) return s;
          return {
            playlists: {
              ...s.playlists,
              [playlistId]: {
                ...existing,
                itemIds: [...existing.itemIds, ...newIds],
                updatedAt: Date.now(),
              },
            },
          };
        }),
      removeFromPlaylist: (playlistId, itemId) =>
        set((s) => {
          const existing = s.playlists[playlistId];
          if (!existing) return s;
          return {
            playlists: {
              ...s.playlists,
              [playlistId]: {
                ...existing,
                itemIds: existing.itemIds.filter((id) => id !== itemId),
                updatedAt: Date.now(),
              },
            },
          };
        }),
      reorderPlaylist: (playlistId, itemIds) =>
        set((s) => {
          const existing = s.playlists[playlistId];
          if (!existing) return s;
          return {
            playlists: {
              ...s.playlists,
              [playlistId]: {
                ...existing,
                itemIds,
                updatedAt: Date.now(),
              },
            },
          };
        }),

      toggleFavorite: (itemId) => {
        let isFav = false;
        set((s) => {
          const next = { ...s.favorites };
          const item = s.mediaItems[itemId];
          const key = item ? getMediaItemDeduplicationKey(item) : null;
          const matchingIds = [itemId];
          if (key) {
            for (const other of Object.values(s.mediaItems)) {
              if (other.id !== itemId && getMediaItemDeduplicationKey(other) === key) {
                matchingIds.push(other.id);
              }
            }
          }

          const currentlyFav = matchingIds.some((id) => Boolean(next[id]));
          if (currentlyFav) {
            for (const id of matchingIds) {
              delete next[id];
            }
            isFav = false;
          } else {
            const now = Date.now();
            for (const id of matchingIds) {
              next[id] = now;
            }
            isFav = true;
          }
          return { favorites: next };
        });
        return isFav;
      },
      setFavorite: (itemId, favoritedAt) =>
        set((s) => {
          const next = { ...s.favorites };
          const item = s.mediaItems[itemId];
          const key = item ? getMediaItemDeduplicationKey(item) : null;
          const matchingIds = [itemId];
          if (key) {
            for (const other of Object.values(s.mediaItems)) {
              if (other.id !== itemId && getMediaItemDeduplicationKey(other) === key) {
                matchingIds.push(other.id);
              }
            }
          }
          if (favoritedAt === null || favoritedAt === undefined) {
            for (const id of matchingIds) {
              delete next[id];
            }
          } else {
            for (const id of matchingIds) {
              next[id] = favoritedAt;
            }
          }
          return { favorites: next };
        }),

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
      storage: createJSONStorage(() => rcloneflixConfigStorage),
      version: 3,
      migrate: (persistedState: unknown, fromVersion: number) => {
        const state = persistedState as Record<string, unknown>;
        if (fromVersion < 2) {
          // Migrate Library.remotePath → Library.remotePaths
          const libs = (state.libraries ?? []) as Array<Record<string, unknown>>;
          state.libraries = libs.map((lib) => ({
            ...lib,
            remotePaths: (lib.remotePaths as string[] | undefined) ??
              (lib.remotePath ? [lib.remotePath as string] : []),
          }));
        }
        if (fromVersion < 3) {
          state.playback = { ...defaultPlayback, ...(state.playback as object ?? {}) };
        }
        return state as unknown as AppStore;
      },
      // Secrets are deliberately excluded from localStorage and kept in the
      // OS-level Tauri store instead (see lib/secrets.ts). localStorage in a
      // webview is trivially readable and survives uninstall.
      partialize: (s) => {
        const {
          tmdbApiKey: _tmdb,
          thePornDbApiKey: _porn,
          kaggleUsername: _ku,
          kaggleKey: _kk,
          googleAccount: _google,
          rcloneConfigContent: _conf,
          // mediaItems / watchProgress / playlists / favorites live in SQLite (lib/libraryDb.ts).
          // Persisting them here is what put the library against WebKit's
          // localStorage quota in the first place.
          mediaItems: _items,
          watchProgress: _progress,
          playlists: _playlists,
          favorites: _favorites,
          audioState: _audioState,
          isMusicSkinMode: _isMusicSkinMode,
          musicSkinTab: _musicSkinTab,
          prevWindowBounds: _prevWindowBounds,
          ...rest
        } = s;
        // Cast: persist() types partialize as returning the full state, but
        // omitting keys is exactly the point — they're restored from the
        // Tauri store instead.
        return {
          ...rest,
          adultSettings: { ...s.adultSettings, unlocked: false },
          scanState: { ...s.scanState, status: "idle" as ScanStatus, progress: undefined },
          syncState: { ...s.syncState, syncing: false },
        } as unknown as AppStore;
      },
    }
  )
);

// ─── Selectors ────────────────────────────────────────────────────────────────

// ─── Local Path & Deduplication Helpers ─────────────────────────────────────

export function isLocalPath(path?: string): boolean {
  if (!path) return false;
  // Unix absolute path or home path
  if (path.startsWith("/") || path.startsWith("~") || path.startsWith("./") || path.startsWith("../")) {
    return true;
  }
  // Windows absolute path (e.g., C:\ or C:/ or \\server\share)
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    return true;
  }
  // If path has no remote prefix before colon
  const colonIndex = path.indexOf(":");
  if (colonIndex === -1) {
    return true;
  }
  // Windows single letter drive like C:
  if (colonIndex === 1 && /^[a-zA-Z]$/.test(path.slice(0, 1))) {
    return true;
  }
  return false;
}

export function isLocalItem(item?: MediaItem): boolean {
  if (!item) return false;
  return isLocalPath(item.remotePath);
}

function normalizeKeyStr(str?: string): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/['".,_\-\(\)\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Computes a deduplication fingerprint for a media item.
 * Items referring to the same content share the same fingerprint.
 */
export function getMediaItemDeduplicationKey(item: MediaItem): string {
  // 1. TV episode: show + season + episode
  // NOTE: For TV, metadataId is the SERIES ID (e.g. IMDb tt0944947 or TMDb 1399).
  // All episodes of a series share this metadataId, so TV episodes must be
  // distinguished by show + season + episode (or filename) so distinct episodes are never merged.
  if (item.libraryType === "tv") {
    const show = normalizeKeyStr(item.showTitle || item.title);
    if (item.episode !== undefined) {
      const season = item.season ?? 1;
      return `tv:ep:${show}:s${season}:e${item.episode}`;
    }
    return `tv:ep:${show}:${item.filename.toLowerCase().trim()}`;
  }

  // 2. Music track: artist + album + (trackNumber or title or filename)
  // NOTE: For music, iTunes / Deezer metadataId is often the ALBUM collectionId.
  // Tracks must be distinguished by trackNumber or track title so songs are not collapsed into 1.
  if (item.libraryType === "music") {
    const artist = normalizeKeyStr(item.artist);
    const album = normalizeKeyStr(item.album);
    const trackNum = item.trackNumber ? `trk:${item.trackNumber}` : "";
    const title = normalizeKeyStr(item.title);
    if (artist && (album || trackNum)) {
      return `music:${artist}:${album}:${trackNum || title || item.filename.toLowerCase().trim()}`;
    }
    return `music:${artist || "unknown"}:${album || "unknown"}:${item.filename.toLowerCase().trim()}`;
  }

  // 3. Comics / Audiobooks / Books: author/series + title + filename/issue
  // NOTE: Audiobooks and Comics have multiple issues/chapters for the same series.
  // Issues and chapters must be kept distinct.
  if (item.libraryType === "comics" || item.libraryType === "books" || item.libraryType === "audiobooks" || isComicExtension(item.filename)) {
    const author = normalizeKeyStr(item.author || item.artist || item.showTitle) || "unknown";
    const title = normalizeKeyStr(item.album || item.title) || "unknown";
    const file = item.filename.toLowerCase().trim();
    return `${item.libraryType || "comics"}:${author}:${title}:${file}`;
  }

  // 4. Standalone media (Movies / Adult): Matched online metadata identifier (Cinemeta / TMDb / ThePornDB)
  if (item.metadataId && item.metadataSource) {
    return `${item.libraryType}:meta:${item.metadataSource}:${item.metadataId}`;
  }

  // 5. Fallback for Movies / Adult / Unmatched: title + year (or title)
  const normTitle = normalizeKeyStr(item.title);
  if (normTitle) {
    const yearStr = item.year ? `:${item.year}` : "";
    return `${item.libraryType}:title:${normTitle}${yearStr}`;
  }

  // 6. Absolute Fallback to filename
  return `${item.libraryType}:file:${item.filename.toLowerCase().trim()}`;
}

/**
 * Merges two duplicate items, preferring fields from `preferred` while inheriting
 * any richer metadata present in `secondary`.
 */
export function mergeMediaItems(preferred: MediaItem, secondary: MediaItem): MediaItem {
  const mergedVersions = mergeItemVersions(preferred, secondary).versions;
  return {
    ...secondary,
    ...preferred,
    versions: mergedVersions,
    posterUrl: preferred.posterUrl || secondary.posterUrl,
    backdropUrl: preferred.backdropUrl || secondary.backdropUrl,
    thumbUrl: preferred.thumbUrl || secondary.thumbUrl,
    overview: preferred.overview || secondary.overview,
    rating: preferred.rating || secondary.rating,
    genres: (preferred.genres && preferred.genres.length > 0) ? preferred.genres : secondary.genres,
    duration: preferred.duration || secondary.duration,
    year: preferred.year || secondary.year,
    metadataId: preferred.metadataId || secondary.metadataId,
    metadataSource: preferred.metadataSource || secondary.metadataSource,
    metadataConfidence: preferred.metadataConfidence || secondary.metadataConfidence,
    episodeTitle: preferred.episodeTitle || secondary.episodeTitle,
    showTitle: preferred.showTitle || secondary.showTitle,
    showPosterUrl: preferred.showPosterUrl || secondary.showPosterUrl,
    showBackdropUrl: preferred.showBackdropUrl || secondary.showBackdropUrl,
    showOverview: preferred.showOverview || secondary.showOverview,
    artist: preferred.artist || secondary.artist,
    album: preferred.album || secondary.album,
    trackNumber: preferred.trackNumber || secondary.trackNumber,
    author: preferred.author || secondary.author,
    userTags: Array.from(new Set([...(preferred.userTags || []), ...(secondary.userTags || [])])),
    studio: preferred.studio || secondary.studio,
    performers: (preferred.performers && preferred.performers.length > 0) ? preferred.performers : secondary.performers,
    oshash: preferred.oshash || secondary.oshash,
    phash: preferred.phash || secondary.phash,
  };
}

/**
 * Deduplicates a list of media items.
 * If duplicate items are detected (same content across local and remote sources),
 * the LOCAL version is always preferred and returned in the unified view.
 */
export function deduplicateMediaItems(items: MediaItem[]): MediaItem[] {
  const map = new Map<string, MediaItem>();

  for (const item of items) {
    const key = getMediaItemDeduplicationKey(item);
    const existing = map.get(key);

    if (!existing) {
      map.set(key, item);
      continue;
    }

    const itemIsLocal = isLocalItem(item);
    const existingIsLocal = isLocalItem(existing);

    if (itemIsLocal && !existingIsLocal) {
      // Local version supersedes remote duplicate
      map.set(key, mergeMediaItems(item, existing));
    } else if (!itemIsLocal && existingIsLocal) {
      // Keep existing local version, inherit any new metadata
      map.set(key, mergeMediaItems(existing, item));
    } else {
      // Both local or both remote: prefer higher confidence or newer item
      const preferNew =
        (item.metadataConfidence === "high" && existing.metadataConfidence !== "high") ||
        (item.posterUrl && !existing.posterUrl) ||
        item.addedAt > existing.addedAt;
      if (preferNew) {
        map.set(key, mergeMediaItems(item, existing));
      } else {
        map.set(key, mergeMediaItems(existing, item));
      }
    }
  }

  return Array.from(map.values());
}

// ─── Selectors ────────────────────────────────────────────────────────────────

export function selectItemsByLibrary(items: Record<string, MediaItem>, libraryId: string): MediaItem[] {
  const raw = Object.values(items).filter((i) => i.libraryId === libraryId);
  return deduplicateMediaItems(raw).sort((a, b) => b.addedAt - a.addedAt);
}

export function selectRecentlyAdded(items: Record<string, MediaItem>, libraryId: string, limit = 20): MediaItem[] {
  return selectItemsByLibrary(items, libraryId).slice(0, limit);
}

export function selectRecentlyAddedGrouped(
  items: Record<string, MediaItem>,
  library: Library,
  limit = 20
): MediaItem[] {
  if (library.type === "tv") {
    const rawEpisodes = Object.values(items).filter(
      (i) => i.libraryId === library.id && i.libraryType === "tv"
    ) as TvEpisode[];
    const episodes = deduplicateMediaItems(rawEpisodes) as TvEpisode[];
    const showMap: Record<
      string,
      {
        episodes: TvEpisode[];
        showTitle: string;
        showId?: string;
        posterUrl?: string;
        backdropUrl?: string;
        overview?: string;
        year?: number;
        rating?: number;
        newestAddedAt: number;
      }
    > = {};

    for (const ep of episodes) {
      const showKey = normalizeKeyStr(ep.showTitle) || ep.showId || ep.title;
      if (!showMap[showKey]) {
        showMap[showKey] = {
          episodes: [],
          showTitle: ep.showTitle || ep.title,
          showId: ep.showId,
          posterUrl: ep.showPosterUrl || ep.posterUrl,
          backdropUrl: ep.showBackdropUrl || ep.backdropUrl,
          overview: ep.showOverview || ep.overview,
          year: ep.year,
          rating: ep.rating,
          newestAddedAt: ep.addedAt,
        };
      }
      const s = showMap[showKey];
      s.episodes.push(ep);
      if (ep.addedAt > s.newestAddedAt) s.newestAddedAt = ep.addedAt;
      if (!s.posterUrl && (ep.showPosterUrl || ep.posterUrl)) s.posterUrl = ep.showPosterUrl || ep.posterUrl;
      if (!s.backdropUrl && (ep.showBackdropUrl || ep.backdropUrl)) s.backdropUrl = ep.showBackdropUrl || ep.backdropUrl;
      if (!s.overview && (ep.showOverview || ep.overview)) s.overview = ep.showOverview || ep.overview;
      if (!s.showId && ep.showId) s.showId = ep.showId;
      if (!s.year && ep.year) s.year = ep.year;
    }

    const showList = Object.entries(showMap).map(([showKey, s]) => {
      const epCount = s.episodes.length;
      const seasons = Array.from(new Set(s.episodes.map((e) => e.season ?? 1)));
      let badge = `${epCount} New Episodes`;
      if (epCount === 1) {
        const single = s.episodes[0];
        badge = `S${single.season ?? 1}E${single.episode ?? 1}`;
      } else if (seasons.length === 1) {
        badge = `Season ${seasons[0]} Added`;
      }

      const sample = s.episodes[0];
      const card: MediaItem = {
        id: `show-${s.showId || showKey}`,
        libraryId: library.id,
        libraryType: "tv",
        remotePath: sample.remotePath,
        filename: sample.filename,
        title: s.showTitle,
        showTitle: s.showTitle,
        showId: s.showId || showKey,
        posterUrl: s.posterUrl,
        backdropUrl: s.backdropUrl,
        overview: s.overview,
        year: s.year,
        rating: s.rating,
        addedAt: s.newestAddedAt,
        lastScannedAt: sample.lastScannedAt,
        badge,
        subtitle: `${epCount} Episode${epCount === 1 ? "" : "s"}`,
        itemCount: epCount,
        groupType: "show",
      };
      return card;
    });

    return showList.sort((a, b) => b.addedAt - a.addedAt).slice(0, limit);
  }

  if (library.type === "music") {
    const rawTracks = Object.values(items).filter(
      (i) => i.libraryId === library.id && (i.libraryType === "music" || i.libraryType === "audiobooks")
    );
    const tracks = deduplicateMediaItems(rawTracks);
    const albumMap: Record<
      string,
      {
        tracks: MediaItem[];
        albumName: string;
        artistName: string;
        posterUrl?: string;
        year?: number;
        newestAddedAt: number;
      }
    > = {};

    for (const track of tracks) {
      const artist = track.artist || "Unknown Artist";
      const album = track.album || track.title;
      const albumKey = `${artist.toLowerCase()}:::${album.toLowerCase()}`;

      if (!albumMap[albumKey]) {
        albumMap[albumKey] = {
          tracks: [],
          albumName: album,
          artistName: artist,
          posterUrl: track.posterUrl,
          year: track.year,
          newestAddedAt: track.addedAt,
        };
      }
      const a = albumMap[albumKey];
      a.tracks.push(track);
      if (track.addedAt > a.newestAddedAt) a.newestAddedAt = track.addedAt;
      if (!a.posterUrl && track.posterUrl) a.posterUrl = track.posterUrl;
      if (!a.year && track.year) a.year = track.year;
    }

    const albumList = Object.entries(albumMap).map(([albumKey, a]) => {
      const trackCount = a.tracks.length;
      const sample = a.tracks[0];
      const card: MediaItem = {
        id: `album-${albumKey}`,
        libraryId: library.id,
        libraryType: "music",
        remotePath: sample.remotePath,
        filename: sample.filename,
        title: a.albumName,
        artist: a.artistName,
        album: a.albumName,
        posterUrl: a.posterUrl,
        year: a.year,
        addedAt: a.newestAddedAt,
        lastScannedAt: sample.lastScannedAt,
        badge: trackCount > 1 ? `${trackCount} Tracks` : "Single",
        subtitle: a.artistName,
        itemCount: trackCount,
        groupType: "album",
      };
      return card;
    });

    return albumList.sort((a, b) => b.addedAt - a.addedAt).slice(0, limit);
  }

  if (library.type === "audiobooks") {
    const groups = selectAudiobooks(items, library.id);
    const bookList = groups.map((g) => {
      const first = g.tracks[0];
      const newestAddedAt = Math.max(...g.tracks.map((t) => t.addedAt));
      const card: MediaItem = {
        id: g.id,
        libraryId: library.id,
        libraryType: "audiobooks",
        remotePath: first.remotePath,
        filename: first.filename,
        title: g.title,
        author: g.author,
        artist: g.author,
        posterUrl: g.posterUrl || first.posterUrl,
        overview: g.overview || first.overview,
        year: g.year || first.year,
        addedAt: newestAddedAt,
        lastScannedAt: first.lastScannedAt,
        badge: g.tracks.length > 1 ? `${g.tracks.length} Chapters` : "Audiobook",
        subtitle: g.author || "Audiobook",
        itemCount: g.tracks.length,
        groupType: "book",
      };
      return card;
    });

    return bookList.sort((a, b) => b.addedAt - a.addedAt).slice(0, limit);
  }

  // Movies, Books, Adult: pass through deduplicated items
  return selectRecentlyAdded(items, library.id, limit);
}

/**
 * Extracts a normalized franchise base title for movie sequel grouping.
 * Examples:
 * - "Dune: Part One" -> "dune"
 * - "Dune: Part Two" -> "dune"
 * - "John Wick: Chapter 3 - Parabellum" -> "john wick"
 * - "Toy Story 2" -> "toy story"
 * - "The Godfather Part II" -> "the godfather"
 */
export function extractFranchiseBaseTitle(title?: string): string {
  if (!title) return "";
  let clean = title.toLowerCase().trim();
  // Strip year in parens
  clean = clean.replace(/\(\d{4}\)/g, "").trim();
  // Strip ": ..." or " - ..." subtitle
  const colonIdx = clean.search(/[:\-–—]/);
  if (colonIdx > 2) {
    clean = clean.slice(0, colonIdx).trim();
  }
  // Strip trailing "part 1/2/one/two/ii/iii", "chapter X", "vol X", or trailing numbers/roman numerals
  clean = clean
    .replace(/\b(part|chapter|volume|vol\.?|book)\s*([0-9]+|one|two|three|four|five|i|ii|iii|iv|v|vi)\b.*$/i, "")
    .replace(/\s+([2-9]|ii|iii|iv|v|vi)$/i, "")
    .replace(/['".,_\-\(\)\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length >= 3 ? clean : "";
}

export function selectInProgress(
  items: Record<string, MediaItem>,
  progress: Record<string, WatchProgress>,
  limit = 20
): (MediaItem & { progress: WatchProgress })[] {
  const deduped = deduplicateMediaItems(Object.values(items));
  const keyToPreferred = new Map<string, MediaItem>();
  for (const item of deduped) {
    keyToPreferred.set(getMediaItemDeduplicationKey(item), item);
  }

  const isCompletedProgress = (p?: WatchProgress): boolean => {
    if (!p) return false;
    return Boolean(p.completed || (p.duration > 0 && p.position / p.duration >= 0.9));
  };

  const result: (MediaItem & { progress: WatchProgress })[] = [];
  const seenIds = new Set<string>();
  const activeShowKeys = new Set<string>();
  const activeMovieFranchises = new Set<string>();

  // 1. Collect actively in-progress (partially watched) items
  const sortedInProgress = Object.values(progress)
    .filter((p) => !isCompletedProgress(p) && p.position > 30 && items[p.itemId])
    .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);

  for (const p of sortedInProgress) {
    const raw = items[p.itemId];
    if (!raw) continue;
    const preferred = keyToPreferred.get(getMediaItemDeduplicationKey(raw)) ?? raw;
    if (!seenIds.has(preferred.id)) {
      seenIds.add(preferred.id);
      result.push({ ...preferred, progress: p });
      if (preferred.libraryType === "tv") {
        const showKey = normalizeKeyStr(preferred.showTitle) || preferred.showId || normalizeKeyStr(preferred.title);
        if (showKey) activeShowKeys.add(showKey);
      } else if (preferred.libraryType === "movies") {
        const base = extractFranchiseBaseTitle(preferred.title);
        if (base) activeMovieFranchises.add(base);
      }
    }
  }

  // 2. Compute "Next Up" for TV Shows
  const tvShows = selectTvShows(items);
  for (const show of tvShows) {
    const showKey = normalizeKeyStr(show.title) || show.showId;
    if (activeShowKeys.has(showKey) || activeShowKeys.has(show.showId)) continue;

    // Flatten all episodes in chronological order (Season 1..N, Episode 1..M; ignore Season 0 specials)
    const allEps: TvEpisode[] = [];
    const sortedSeasonNums = Object.keys(show.seasons)
      .map(Number)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);

    for (const sNum of sortedSeasonNums) {
      const season = show.seasons[sNum];
      if (season?.episodes) {
        allEps.push(...season.episodes);
      }
    }
    if (allEps.length === 0) continue;

    // Find the most recently completed episode in this series
    let latestCompletedIdx = -1;
    let latestCompletedTime = 0;

    for (let i = 0; i < allEps.length; i++) {
      const ep = allEps[i];
      const p = progress[ep.id];
      if (isCompletedProgress(p) && (p?.lastWatchedAt || 0) >= latestCompletedTime) {
        latestCompletedIdx = i;
        latestCompletedTime = p?.lastWatchedAt || 1;
      }
    }

    if (latestCompletedIdx >= 0 && latestCompletedIdx + 1 < allEps.length) {
      // Find the immediate next unwatched episode
      const nextEp = allEps[latestCompletedIdx + 1];
      const nextEpProgress = progress[nextEp.id];
      if (!isCompletedProgress(nextEpProgress) && !seenIds.has(nextEp.id)) {
        seenIds.add(nextEp.id);
        const sNum = nextEp.season ?? 1;
        const eNum = nextEp.episode ?? 1;
        const badgeLabel = `Next Up: S${sNum} · E${eNum}`;
        const syntheticProgress: WatchProgress = {
          itemId: nextEp.id,
          position: 0,
          duration: nextEp.duration || 0,
          completed: false,
          lastWatchedAt: latestCompletedTime,
          isNextUp: true,
          nextUpReason: badgeLabel,
        };
        result.push({
          ...nextEp,
          badge: badgeLabel,
          progress: syntheticProgress,
        });
      }
    }
  }

  // 3. Compute "Next Up" for Movie Franchises / Sequels in library
  const movies = deduped.filter((m) => m.libraryType === "movies" && m.year);
  const franchiseGroups = new Map<string, MediaItem[]>();
  for (const m of movies) {
    const base = extractFranchiseBaseTitle(m.title);
    if (!base) continue;
    if (!franchiseGroups.has(base)) franchiseGroups.set(base, []);
    franchiseGroups.get(base)!.push(m);
  }

  for (const [base, group] of franchiseGroups.entries()) {
    if (group.length < 2 || activeMovieFranchises.has(base)) continue;
    // Sort chronologically by release year, then title
    group.sort((a, b) => (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title));

    let lastWatchedMovieIdx = -1;
    let lastWatchedMovieTime = 0;
    for (let i = 0; i < group.length; i++) {
      const p = progress[group[i].id];
      if (isCompletedProgress(p) && (p?.lastWatchedAt || 0) >= lastWatchedMovieTime) {
        lastWatchedMovieIdx = i;
        lastWatchedMovieTime = p?.lastWatchedAt || 1;
      }
    }

    if (lastWatchedMovieIdx >= 0 && lastWatchedMovieIdx + 1 < group.length) {
      const sequel = group[lastWatchedMovieIdx + 1];
      const sequelProg = progress[sequel.id];
      if (!isCompletedProgress(sequelProg) && !(sequelProg && sequelProg.position > 30) && !seenIds.has(sequel.id)) {
        seenIds.add(sequel.id);
        const badgeLabel = "Next in Franchise";
        result.push({
          ...sequel,
          badge: badgeLabel,
          progress: {
            itemId: sequel.id,
            position: 0,
            duration: sequel.duration || 0,
            completed: false,
            lastWatchedAt: lastWatchedMovieTime,
            isNextUp: true,
            nextUpReason: badgeLabel,
          },
        });
      }
    }
  }

  return result
    .sort((a, b) => (b.progress.lastWatchedAt || 0) - (a.progress.lastWatchedAt || 0))
    .slice(0, limit);
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

export function selectMusicArtists(items: Record<string, MediaItem>, libraryId?: string): MusicArtist[] {
  const rawTracks = Object.values(items).filter(
    (i) => (libraryId ? i.libraryId === libraryId : true) && (i.libraryType === "music" || i.libraryType === "audiobooks")
  );
  const tracks = deduplicateMediaItems(rawTracks);
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
    } else {
      if (!artist.albums[albumName].posterUrl && track.posterUrl) {
        artist.albums[albumName].posterUrl = track.posterUrl;
      }
      if (!artist.albums[albumName].year && track.year) {
        artist.albums[albumName].year = track.year;
      }
    }
    // Use first available poster as the artist image
    if (!artist.posterUrl && track.posterUrl) artist.posterUrl = track.posterUrl;
    artist.albums[albumName].tracks.push(track);
    artist.trackCount++;
  }

  // Enforce album artwork priority & sort tracks once per album (O(N log K) instead of O(N^2 log K))
  for (const artist of Object.values(artistMap)) {
    for (const album of Object.values(artist.albums)) {
      album.tracks.sort(
        (a, b) =>
          (a.trackNumber ?? 999) - (b.trackNumber ?? 999) ||
          // Tie-break (incl. all-undefined trackNumbers, e.g. "Album – 01-03 Title"
          // rips the parser couldn't number): numeric filename order, never scan order.
          a.filename.localeCompare(b.filename, undefined, { numeric: true })
      );
      if (album.posterUrl) {
        for (const t of album.tracks) {
          t.posterUrl = album.posterUrl;
        }
      }
    }
  }

  return Object.values(artistMap).sort((a, b) => a.name.localeCompare(b.name));
}

export type TrackAlbumInfo = {
  artistName: string;
  albumName: string;
  tracks: MediaItem[];
  trackIndex: number;
};

export function findAlbumAndTracksForTrack(
  mediaItems: Record<string, MediaItem>,
  track: MediaItem
): TrackAlbumInfo | null {
  const ext = track.filename?.split(".").pop()?.toLowerCase() ?? "";
  const isAudio =
    track.libraryType === "music" ||
    track.libraryType === "audiobooks" ||
    AUDIO_EXTENSIONS.includes(ext);

  if (!isAudio) return null;

  const targetArtist = (track.artist || "").trim().toLowerCase();
  const targetAlbum = (track.album || "").trim().toLowerCase();

  let candidateTracks: MediaItem[] = [];

  // 1. If album metadata is present, search across all tracks with matching album
  if (targetAlbum) {
    candidateTracks = Object.values(mediaItems).filter((item) => {
      const itemExt = item.filename?.split(".").pop()?.toLowerCase() ?? "";
      if (item.libraryType !== track.libraryType && !AUDIO_EXTENSIONS.includes(itemExt)) return false;
      const alb = (item.album || "").trim().toLowerCase();
      if (alb !== targetAlbum) return false;
      if (targetArtist && item.artist) {
        return item.artist.trim().toLowerCase() === targetArtist;
      }
      return true;
    });
  }

  // 2. If no candidate tracks found by album, try by directory folder
  if (candidateTracks.length === 0 && track.remotePath) {
    const lastSlash = track.remotePath.lastIndexOf("/");
    if (lastSlash > 0) {
      const parentDir = track.remotePath.substring(0, lastSlash);
      candidateTracks = Object.values(mediaItems).filter((item) => {
        if (!item.remotePath) return false;
        return (
          item.remotePath.startsWith(parentDir + "/") &&
          item.remotePath.indexOf("/", parentDir.length + 1) === -1
        );
      });
    }
  }

  // Fallback to single track if no siblings found
  if (candidateTracks.length === 0) {
    return {
      artistName: track.artist || "Unknown Artist",
      albumName: track.album || "Unknown Album",
      tracks: [track],
      trackIndex: 0,
    };
  }

  const deduped = deduplicateMediaItems(candidateTracks).sort((a, b) => {
    if (a.trackNumber !== undefined && b.trackNumber !== undefined && a.trackNumber !== b.trackNumber) {
      return a.trackNumber - b.trackNumber;
    }
    return a.filename.localeCompare(b.filename, undefined, { numeric: true });
  });

  const trackIndex = deduped.findIndex(
    (t) =>
      t.id === track.id ||
      t.remotePath === track.remotePath ||
      (t.title && track.title && t.title.toLowerCase() === track.title.toLowerCase())
  );

  return {
    artistName: track.artist || deduped[0]?.artist || "Unknown Artist",
    albumName: track.album || deduped[0]?.album || "Unknown Album",
    tracks: deduped,
    trackIndex: trackIndex >= 0 ? trackIndex : 0,
  };
}


// ─── Audiobook hierarchy ──────────────────────────────────────────────────────

export type AudiobookGroup = {
  id: string;
  title: string;
  author?: string;
  year?: number;
  posterUrl?: string;
  overview?: string;
  libraryId: string;
  tracks: MediaItem[];
};

export function selectAudiobooks(items: Record<string, MediaItem>, libraryId?: string): AudiobookGroup[] {
  const rawBooks = Object.values(items).filter(
    (i) => (libraryId ? i.libraryId === libraryId : true) && 
           (i.libraryType === "audiobooks" || (i.libraryType === "books" && !isComicExtension(i.filename)))
  );
  const books = deduplicateMediaItems(rawBooks);
  const groupMap: Record<string, AudiobookGroup> = {};

  for (const item of books) {
    const key = item.album || item.showTitle || item.title;
    if (!groupMap[key]) {
      groupMap[key] = {
        id: item.id,
        title: key,
        author: item.author || item.artist,
        year: item.year,
        posterUrl: item.posterUrl,
        overview: item.overview,
        libraryId: item.libraryId,
        tracks: [],
      };
    }
    const group = groupMap[key];
    if (!group.posterUrl && item.posterUrl) group.posterUrl = item.posterUrl;
    if (!group.author && (item.author || item.artist)) group.author = item.author || item.artist;
    group.tracks.push(item);
  }

  for (const group of Object.values(groupMap)) {
    group.tracks.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  }

  return Object.values(groupMap).sort((a, b) => a.title.localeCompare(b.title));
}

// Group TV episodes into Show -> Season -> Episode hierarchy
export function selectTvShows(items: Record<string, MediaItem>, libraryId?: string): TvShow[] {
  const rawEpisodes = Object.values(items).filter(
    (i) => (libraryId ? i.libraryId === libraryId : true) && i.libraryType === "tv"
  ) as TvEpisode[];

  const episodes = deduplicateMediaItems(rawEpisodes) as TvEpisode[];
  const showMap: Record<string, TvShow> = {};

  for (const ep of episodes) {
    const showKey = normalizeKeyStr(ep.showTitle) || ep.showId || ep.title;
    if (!showMap[showKey]) {
      showMap[showKey] = {
        showId: ep.showId ?? showKey,
        title: ep.showTitle ?? ep.title,
        posterUrl: ep.showPosterUrl ?? ep.posterUrl,
        backdropUrl: ep.showBackdropUrl ?? ep.backdropUrl,
        overview: ep.showOverview ?? ep.overview,
        rating: ep.rating,
        year: ep.year,
        libraryId: ep.libraryId,
        seasons: {},
        episodeCount: 0,
      };
    } else {
      const show = showMap[showKey];
      if (!show.posterUrl && (ep.showPosterUrl || ep.posterUrl)) {
        show.posterUrl = ep.showPosterUrl || ep.posterUrl;
      }
      if (!show.backdropUrl && (ep.showBackdropUrl || ep.backdropUrl)) {
        show.backdropUrl = ep.showBackdropUrl || ep.backdropUrl;
      }
      if (!show.overview && (ep.showOverview || ep.overview)) {
        show.overview = ep.showOverview || ep.overview;
      }
      if (!show.year && ep.year) show.year = ep.year;
      if (ep.showId && (!show.showId || show.showId === showKey)) {
        show.showId = ep.showId;
      }
      if (ep.showTitle && show.title !== ep.showTitle) {
        show.title = ep.showTitle;
      }
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

export function isItemFavorited(
  item: MediaItem,
  favorites: Record<string, number>,
  allItems?: Record<string, MediaItem>
): boolean {
  if (favorites[item.id]) return true;
  if (!allItems) return false;
  const key = getMediaItemDeduplicationKey(item);
  for (const favId of Object.keys(favorites)) {
    const candidate = allItems[favId];
    if (candidate && getMediaItemDeduplicationKey(candidate) === key) {
      return true;
    }
  }
  return false;
}

export function selectFavoriteItems(
  items: Record<string, MediaItem>,
  favorites: Record<string, number>
): MediaItem[] {
  const deduped = deduplicateMediaItems(Object.values(items));
  const keyToPreferred = new Map<string, MediaItem>();
  for (const item of deduped) {
    keyToPreferred.set(getMediaItemDeduplicationKey(item), item);
  }

  const result: MediaItem[] = [];
  const seenIds = new Set<string>();
  const favTimestamps = new Map<string, number>();

  for (const [id, time] of Object.entries(favorites)) {
    const raw = items[id];
    if (!raw) continue;
    const preferred = keyToPreferred.get(getMediaItemDeduplicationKey(raw)) ?? raw;
    favTimestamps.set(
      preferred.id,
      Math.max(favTimestamps.get(preferred.id) ?? 0, time)
    );
    if (!seenIds.has(preferred.id)) {
      seenIds.add(preferred.id);
      result.push(preferred);
    }
  }

  return result.sort((a, b) => (favTimestamps.get(b.id) ?? 0) - (favTimestamps.get(a.id) ?? 0));
}

export function selectPlaylistItems(
  playlist: Playlist | undefined,
  items: Record<string, MediaItem>
): MediaItem[] {
  if (!playlist) return [];
  const deduped = deduplicateMediaItems(Object.values(items));
  const keyToPreferred = new Map<string, MediaItem>();
  for (const item of deduped) {
    keyToPreferred.set(getMediaItemDeduplicationKey(item), item);
  }

  return playlist.itemIds
    .map((id) => {
      const raw = items[id];
      if (!raw) return undefined;
      return keyToPreferred.get(getMediaItemDeduplicationKey(raw)) ?? raw;
    })
    .filter((item): item is MediaItem => Boolean(item));
}

