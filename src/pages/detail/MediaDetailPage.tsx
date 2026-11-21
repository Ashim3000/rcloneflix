import { useState, useMemo, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { ArrowLeft, Play, Star, Clock, Calendar, Tag, Wrench, Download, CheckCircle2, HardDrive, Film, Tv, Compass, Copy, Check, Info, Globe, Layers, CloudUpload, Loader2, Headphones, BookOpen, Cloud, Sparkles, Share2, Bell, BellRing, Radio, X } from "lucide-react";
import {
  useAppStore,
  isLocalItem,
  getMediaItemDeduplicationKey,
  mergeMediaItems,
  findAlbumAndTracksForTrack,
  type MediaItem,
  type RecommendationBadgeEffect,
} from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { FixMatchModal } from "../../components/library/FixMatchModal";
import { EasynewsSearchModal } from "../../components/discovery/EasynewsSearchModal";
import { StremioStreamsModal } from "../../components/discovery/StremioStreamsModal";
import { InfiniDyskSearchModal } from "../../components/discovery/InfiniDyskSearchModal";
import { ShareStreamLinkModal } from "../../components/common/ShareStreamLinkModal";
import { MediaShelf } from "../../components/library/MediaShelf";
import { fetchMoreLikeThis, getIsoWeekString } from "../../lib/recommendations";
import { RecommendationBadge } from "../../components/library/RecommendationBadge";
import { SubscribeModal } from "../../components/tv/SubscribeModal";
import { OffloadMirrorsPanel } from "../../components/library/OffloadMirrorsPanel";
import { persistItems } from "../../lib/libraryDb";
import { fetchCanonicalSeriesEpisodes, type CanonicalSeries } from "../../lib/tvMetadata";
import { checkSingleTvSubscription } from "../../lib/tvSubscriptionEngine";
import { resolveDiscoveryCardNavigation } from "../../lib/discoveryMatching";
import { AUDIO_EXTENSIONS } from "../../lib/mediaTypes";
import { downloadSingleItem } from "../../lib/downloadManager";
import { FavoriteButton } from "../../components/common/FavoriteButton";
import { AddToPlaylistButton } from "../../components/playlist/AddToPlaylistButton";
import { useArtwork } from "../../lib/artwork";
import { extractMediaTechnicalSpecs } from "../../lib/mediaInfo";
import { pushItemToStreamtape } from "../../lib/streamtapeOffload";
import { pushItemToDoodstream } from "../../lib/doodstreamOffload";
import { seedItemToRealDebrid } from "../../lib/realDebridSeeder";
import {
  offloadMediaItemToTelegram,
  hasTelegramVersion,
} from "../../lib/telegramOffload";
import { offloadItemToCatbox } from "../../lib/catboxOffload";
import { UserTagsEditor } from "../../components/common/UserTagsEditor";
import { FingerprintIdentifyModal } from "../../components/library/FingerprintIdentifyModal";
import {
  offloadAudioItemToDropmb,
  isDropmbUrl,
  extractDropmbShareId,
  getDropmbExpirationStatus,
} from "../../lib/dropmbOffload";
import type { MediaSourceVersion } from "../../lib/multiVersion";
import {
  findMatchingAudiobook,
  findMatchingEbook,
  isAudiobookItem,
  isEbookItem,
} from "../../lib/whispersync";
import { PairAudiobookModal } from "../../components/audiobooks/PairAudiobookModal";
import { KaggleAlignModal } from "../../components/audiobooks/KaggleAlignModal";

export function MediaDetailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    mediaItems,
    watchProgress,
    whispersyncPairs,
    setAudioState,
    toggleWatchCompleted,
    libraries,
    debridConfig,
    tvSubscriptions,
    removeTvSubscription,
    rcloneConfigPath,
    setLibraryRecommendation,
    removeLibraryRecommendation,
    adminWeeklyRecommendations,
    upsertMediaItem,
  } = useAppStore();
  const [showPairModal, setShowPairModal] = useState(false);
  const [showKaggleAlign, setShowKaggleAlign] = useState(false);
  const [pushingToDoodstream, setPushingToDoodstream] = useState(false);
  const [pushingToRd, setPushingToRd] = useState(false);
  const [showStremioModal, setShowStremioModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [recommendations, setRecommendations] = useState<MediaItem[]>([]);
  const [loadingRecs, setLoadingRecs] = useState(false);
  const [canonicalSeries, setCanonicalSeries] = useState<CanonicalSeries | null>(null);

  const rawItem = (location.state?.item ?? {}) as MediaItem;

  // Find the canonical/merged version of this item from store
  const item = useMemo(() => {
    if (rawItem.matchedLibraryId && mediaItems[rawItem.matchedLibraryId]) {
      return mediaItems[rawItem.matchedLibraryId];
    }
    if (!rawItem.id) return rawItem;
    const direct = mediaItems[rawItem.id];
    if (direct) return direct;

    const key = getMediaItemDeduplicationKey(rawItem);
    const matches = Object.values(mediaItems).filter(
      (m) => getMediaItemDeduplicationKey(m) === key
    );
    if (matches.length > 0) {
      const local = matches.find(isLocalItem);
      return local ? mergeMediaItems(local, rawItem) : matches[0];
    }
    return rawItem;
  }, [rawItem, mediaItems]);

  const isGuest = useMemo(
    () => libraries.some((l) => l.id === item.libraryId && l.isSharedPass),
    [libraries, item.libraryId]
  );

  const [showRecommendModal, setShowRecommendModal] = useState(false);
  const [showSubscribeModal, setShowSubscribeModal] = useState(false);
  const currentWeek = getIsoWeekString();
  const libraryPicks = adminWeeklyRecommendations?.[item.libraryId];
  const isRecommended = Boolean(
    item.isRecommended ||
    item.recommendationBadge ||
    (libraryPicks?.weekId === currentWeek && libraryPicks.items?.some((p) => p.itemId === item.id))
  );
  const initialEffect: RecommendationBadgeEffect =
    item.recommendationBadge?.effect ||
    (libraryPicks?.weekId === currentWeek && libraryPicks.items?.find((p) => p.itemId === item.id)?.badgeEffect) ||
    "gold";
  const [selectedEffect, setSelectedEffect] = useState<RecommendationBadgeEffect>(initialEffect);

  const isBookOrAudio = isEbookItem(item) || isAudiobookItem(item);
  const isEbook = isEbookItem(item);
  const isAudio = isAudiobookItem(item);

  const isTvItem = item.libraryType === "tv" || item.groupType === "show" || Boolean(item.showTitle) || Boolean(item.showId);
  const seriesKey = item.showId || item.metadataId || item.showTitle || item.title || "";
  const seriesTitle = item.showTitle || item.title || "";

  useEffect(() => {
    if (!isTvItem || !seriesTitle) {
      setCanonicalSeries(null);
      return;
    }
    let active = true;
    const imdbId = seriesKey.startsWith("tt") ? seriesKey : item.metadataId?.startsWith("tt") ? item.metadataId : undefined;
    fetchCanonicalSeriesEpisodes(seriesTitle, imdbId).then((res) => {
      if (active && res) setCanonicalSeries(res);
    });
    return () => {
      active = false;
    };
  }, [isTvItem, seriesTitle, seriesKey, item.metadataId]);

  const missingTvEpisodesCount = useMemo(() => {
    if (!isTvItem || !canonicalSeries) return 0;
    const normShow = seriesTitle.toLowerCase().trim();
    const ownedSet = new Set<string>();
    for (const m of Object.values(mediaItems)) {
      if (
        (m.showId && m.showId === seriesKey) ||
        (m.showTitle || m.title || "").toLowerCase().trim() === normShow
      ) {
        if (m.season !== undefined && m.episode !== undefined) {
          ownedSet.add(`S${m.season}E${m.episode}`);
        }
      }
    }
    return canonicalSeries.episodes.filter(
      (ep) => ep.season > 0 && ep.hasAired && !ownedSet.has(`S${ep.season}E${ep.episode}`)
    ).length;
  }, [isTvItem, canonicalSeries, mediaItems, seriesKey, seriesTitle]);

  const resolvedTvDestPath = useMemo(() => {
    if (!isTvItem) return "";
    const rp = item.remotePath || "";
    if (rp && rp.includes(":")) {
      const lastSlash = rp.lastIndexOf("/");
      if (lastSlash !== -1) {
        const parent = rp.slice(0, lastSlash);
        if (/\/season\s*\d+$/i.test(parent)) {
          const grandSlash = parent.lastIndexOf("/");
          if (grandSlash !== -1) return parent.slice(0, grandSlash);
        }
        return parent;
      }
    }
    const tvLib = libraries.find((l) => l.type === "tv" && !l.isSharedPass && l.remotePaths.length > 0);
    if (tvLib) {
      const base = tvLib.remotePaths[0].replace(/\/+$/, "");
      const safeTitle = seriesTitle.replace(/[/\\?%*:|"<>]/g, "").trim();
      return `${base}/${safeTitle}`;
    }
    return "";
  }, [isTvItem, item.remotePath, libraries, seriesTitle]);

  useEffect(() => {
    if (!item.title || isBookOrAudio) {
      setRecommendations([]);
      return;
    }
    let active = true;
    setLoadingRecs(true);
    fetchMoreLikeThis(item)
      .then((recs) => {
        if (active) setRecommendations(recs);
      })
      .finally(() => {
        if (active) setLoadingRecs(false);
      });
    return () => {
      active = false;
    };
  }, [item.id, item.title, item.metadataId, isBookOrAudio]);

  const allMediaItems = useMemo(() => Object.values(mediaItems), [mediaItems]);
  const companion = useMemo(() => {
    if (!isBookOrAudio) return undefined;
    if (isEbook) {
      return findMatchingAudiobook(item, allMediaItems, whispersyncPairs);
    } else {
      return findMatchingEbook(item, allMediaItems, whispersyncPairs);
    }
  }, [item, isBookOrAudio, isEbook, allMediaItems, whispersyncPairs]);

  const handleStartImmersionReading = () => {
    if (!companion) return;
    if (isEbook) {
      setAudioState({
        playlist: [companion],
        playlistIndex: 0,
        playToken: Date.now(),
      });
      navigate("/play/epub", { state: { item } });
    } else {
      setAudioState({
        playlist: [item],
        playlistIndex: 0,
        playToken: Date.now(),
      });
      navigate("/play/epub", { state: { item: companion } });
    }
  };

  const [showFixMatch, setShowFixMatch] = useState(false);
  const [showFingerprintModal, setShowFingerprintModal] = useState(false);
  const [showEasynewsSearch, setShowEasynewsSearch] = useState(false);
  const [showInfiniDyskModal, setShowInfiniDyskModal] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [showVersionMenu, setShowVersionMenu] = useState(false);
  const [pushingToStreamtape, setPushingToStreamtape] = useState(false);
  const [pushingToTelegram, setPushingToTelegram] = useState(false);
  const [pushingToDropmb, setPushingToDropmb] = useState(false);
  const [pushingToCatbox, setPushingToCatbox] = useState(false);
  const catboxEnabled = useAppStore((s) => s.catboxConfig?.enabled ?? false);
  const tech = useMemo(() => extractMediaTechnicalSpecs(item), [item]);
  const isDownloaded = isLocalItem(item);

  // Derive progress: check direct ID first, then fallback to deduplication key
  const progress = useMemo(() => {
    if (!item.id) return undefined;
    if (watchProgress[item.id]) return watchProgress[item.id];
    if (rawItem.id && watchProgress[rawItem.id]) return watchProgress[rawItem.id];

    const key = getMediaItemDeduplicationKey(item);
    for (const p of Object.values(watchProgress)) {
      const it = mediaItems[p.itemId];
      if (it && getMediaItemDeduplicationKey(it) === key) {
        return p;
      }
    }
    return undefined;
  }, [item, rawItem, watchProgress, mediaItems]);

  const handleShareMediaItem = async () => {
    if (!item.remotePath) return;
    const isWinPath = /^[a-zA-Z]:[\\\/]/.test(item.remotePath);
    const remotePath = item.remotePath;
    const cleanRemote = !isWinPath && remotePath.includes(":") ? remotePath.split(":")[0].replace(/:+$/, "") : "";
    const cleanFile = !isWinPath && remotePath.includes(":") ? remotePath.split(":").slice(1).join(":") : remotePath;

    // For local files or remotes without native rclone public link support (telegram-drive, udrop, etc.), open ShareStreamLinkModal
    if (!cleanRemote || cleanRemote === "telegram-drive" || cleanRemote === "tg-native" || cleanRemote === "udrop") {
      setShowShareModal(true);
      return;
    }

    // Default for cloud remotes supporting rclone link (Google Drive, Dropbox, OneDrive, etc.)
    try {
      useToastStore.getState().addToast(`Generating public share link for "${item.title}"...`, "info");
      const link = await invoke<string>("get_rclone_link", {
        configPath: rcloneConfigPath || "",
        remoteName: cleanRemote,
        filePath: cleanFile,
      });
      await navigator.clipboard.writeText(link);
      useToastStore.getState().addToast("Copied public share link to clipboard!", "success");
    } catch (err: any) {
      // Fallback to Share modal if rclone link is unsupported
      setShowShareModal(true);
    }
  };

  const pct = progress?.duration ? (progress.position / progress.duration) * 100 : 0;

  const handlePlay = (version?: MediaSourceVersion) => {
    if (!item.remotePath && item.libraryId === "discovery") {
      useToastStore
        .getState()
        .addToast("This title is a discovery recommendation not found in your mapped cloud libraries.", "info");
      return;
    }

    const ext = item.filename.split(".").pop()?.toLowerCase() ?? "";

    if (ext === "epub") {
      navigate("/play/epub", { state: { item } });
    } else if (ext === "pdf") {
      navigate("/play/pdf", { state: { item } });
    } else if (ext === "cbz" || ext === "cbr" || ext === "cb7" || ext === "cbt" || item.libraryType === "comics") {
      navigate("/play/comic", { state: { item } });
    } else if (AUDIO_EXTENSIONS.includes(ext) || item.libraryType === "music") {
      const albumInfo = findAlbumAndTracksForTrack(mediaItems, item);
      const playlist = albumInfo?.tracks && albumInfo.tracks.length > 0 ? albumInfo.tracks : [item];
      const playlistIndex = albumInfo ? albumInfo.trackIndex : 0;
      window.dispatchEvent(new CustomEvent("rcloneflix:play-audio", {
        detail: { playlist, playlistIndex },
      }));
    } else {
      navigate("/play/video", { state: { item, resumeAt: progress?.position, selectedVersion: version } });
    }
  };

  const formatDuration = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const initialBackdrop = item.backdropUrl || item.showBackdropUrl;
  const [backdropCandidate, setBackdropCandidate] = useState<string | undefined>(initialBackdrop);
  const [backdropError, setBackdropError] = useState(false);
  const backdropSrc = useArtwork(backdropCandidate);

  // TV episodes should prioritize showPosterUrl for their portrait poster over 16:9 thumbnails
  const initialPoster = item.showPosterUrl || item.posterUrl;
  const [posterCandidate, setPosterCandidate] = useState<string | undefined>(initialPoster);
  const [posterError, setPosterError] = useState(false);
  const posterSrc = useArtwork(posterCandidate);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Backdrop */}
      <div className="relative h-72 flex-shrink-0 bg-void">
        {backdropSrc && !backdropError ? (
          <img
            src={backdropSrc}
            alt=""
            className="w-full h-full object-cover hero-backdrop"
            onError={() => {
              if (item.showBackdropUrl && backdropCandidate !== item.showBackdropUrl) {
                setBackdropCandidate(item.showBackdropUrl);
              } else if (item.backdropUrl && backdropCandidate !== item.backdropUrl) {
                setBackdropCandidate(item.backdropUrl);
              } else {
                setBackdropError(true);
              }
            }}
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-panel to-muted" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-void via-void/50 to-void/20" />

        <button
          onClick={() => navigate(-1)}
          className="absolute top-4 left-6 flex items-center gap-2 text-white/80 hover:text-white transition-colors"
        >
          <ArrowLeft size={20} />
          <span className="font-body text-sm">Back</span>
        </button>
      </div>

      {/* Content */}
      <div className="px-8 pb-12 -mt-12 relative">
        <div className="flex gap-6 items-end mb-6">
          {/* Poster */}
          {posterSrc && !posterError ? (
            <img
              src={posterSrc}
              alt=""
              className="w-28 aspect-[2/3] rounded-xl border border-border shadow-lg flex-shrink-0 object-cover bg-panel"
              onError={() => {
                if (item.showPosterUrl && posterCandidate !== item.showPosterUrl) {
                  setPosterCandidate(item.showPosterUrl);
                } else if (item.posterUrl && posterCandidate !== item.posterUrl) {
                  setPosterCandidate(item.posterUrl);
                } else {
                  setPosterError(true);
                }
              }}
            />
          ) : (
            <div className="w-28 aspect-[2/3] rounded-xl border border-border shadow-lg flex-shrink-0 bg-panel flex flex-col items-center justify-center p-3 text-center">
              {item.libraryType === "tv" || item.season !== undefined ? (
                <Tv size={26} className="text-subtle/50 mb-1" />
              ) : (
                <Film size={26} className="text-subtle/50 mb-1" />
              )}
              <span className="text-[11px] text-subtle font-display leading-tight line-clamp-3">
                {item.showTitle || item.title}
              </span>
            </div>
          )}

          <div className="pb-2 min-w-0">
            {item.showTitle && (
              <p className="text-subtle font-body text-sm mb-1">{item.showTitle}</p>
            )}
            <h1 className="font-display text-4xl text-bright tracking-wide leading-tight">
              {item.title.toUpperCase()}
            </h1>
            {item.season && item.episode && (
              <p className="text-accent font-body text-sm mt-1">
                Season {item.season} · Episode {item.episode}
                {item.episodeTitle && ` · ${item.episodeTitle}`}
              </p>
            )}
          </div>
        </div>

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-4 mb-6 text-subtle font-body text-sm">
          {item.libraryId === "discovery" && !item.remotePath && (
            <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-accent/20 text-accent border border-accent/30 flex items-center gap-1">
              <Compass size={11} />
              Discovery Title
            </span>
          )}
          {isLocalItem(item) && (
            <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
              <HardDrive size={11} />
              Local File
            </span>
          )}
          {item.year && (
            <span className="flex items-center gap-1.5">
              <Calendar size={13} />
              {item.year}
            </span>
          )}
          {item.rating && (
            <span className="flex items-center gap-1.5">
              <Star size={13} className="text-accent" />
              {item.rating.toFixed(1)}
            </span>
          )}
          {item.duration && (
            <span className="flex items-center gap-1.5">
              <Clock size={13} />
              {formatDuration(item.duration)}
            </span>
          )}
          {item.genres?.map((g) => (
            <span key={g} className="flex items-center gap-1.5">
              <Tag size={13} />
              {g}
            </span>
          ))}
          {item.artist && <span>{item.artist}</span>}
          {item.author && <span>by {item.author}</span>}
        </div>

        <div className="mb-4">
          <UserTagsEditor
            itemIds={[item.id]}
            tags={item.userTags || []}
            libraryType={item.libraryType}
            libraryRoute={`/${item.libraryType}`}
          />
        </div>

        {/* Progress bar */}
        {pct > 0 && !progress?.completed && (
          <div className="mb-6">
            <div className="h-1 bg-muted rounded-full overflow-hidden mb-1">
              <div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-subtle font-body text-xs">{Math.round(pct)}% watched</p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-3 mb-8">
          {item.remotePath ? (
            <>
              <motion.button
                data-tv-autofocus="true"
                autoFocus
                onClick={() => handlePlay()}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="btn-primary flex items-center gap-2 px-8 py-3 focus:ring-4 focus:ring-accent focus:outline-none"
              >
                <Play size={18} fill="currentColor" />
                {progress && !progress.completed && pct > 5
                  ? (item.libraryType === "books" ? "Resume Reading" : "Resume")
                  : (item.libraryType === "books" ? "Read Now" : "Play")}
              </motion.button>

              {item.versions && item.versions.length > 1 && (
                <div className="relative">
                  <button
                    onClick={() => setShowVersionMenu(!showVersionMenu)}
                    className="btn-secondary flex items-center gap-2 px-4 py-3"
                    title="Select specific source or cloud version"
                  >
                    <Layers size={16} />
                    <span>Play Version ({item.versions.length})</span>
                  </button>
                  {showVersionMenu && (
                    <div className="absolute top-full mt-2 left-0 w-80 bg-surface border border-border rounded-xl shadow-2xl p-2 z-50 flex flex-col gap-1">
                      <div className="text-xs font-semibold text-subtle px-3 py-1.5 uppercase tracking-wider">
                        Available Playback Versions
                      </div>
                      {item.versions.map((ver) => (
                        <button
                          key={ver.id}
                          onClick={() => {
                            setShowVersionMenu(false);
                            handlePlay(ver);
                          }}
                          className="flex flex-col items-start px-3 py-2 rounded-lg hover:bg-white/10 text-left transition-colors"
                        >
                          <div className="flex items-center gap-2 w-full justify-between">
                            <span className="text-sm font-medium text-white truncate">
                              {isGuest
                                ? ver.isLocal
                                  ? "Local Storage"
                                  : ver.sourceType === "real-debrid" || ver.remoteName === "real-debrid"
                                  ? "Ultra 4K Stream"
                                  : ver.sourceType === "streamtape" || ver.remoteName === "streamtape"
                                  ? "Fast Cloud Stream"
                                  : ver.sourceType === "doodstream" || ver.remoteName === "doodstream"
                                  ? "Standard Cloud Stream"
                                  : "Cloud Stream"
                                : ver.isLocal
                                ? "Local Storage"
                                : ver.sourceType === "real-debrid" || ver.remoteName === "real-debrid"
                                ? "Real-Debrid 4K CDN"
                                : ver.sourceType === "streamtape"
                                ? "Streamtape CDN"
                                : ver.sourceType === "doodstream"
                                ? "DoodStream CDN"
                                : ver.remoteName}
                            </span>
                            {ver.isLocal && (
                              <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-mono font-bold shrink-0">
                                Priority 1
                              </span>
                            )}
                            {(ver.sourceType === "real-debrid" || ver.remoteName === "real-debrid") && (
                              <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-mono font-bold shrink-0">
                                Priority 2 (4K CDN)
                              </span>
                            )}
                            {ver.sourceType === "streamtape" && (
                              <span className="text-[10px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded font-mono font-bold shrink-0">
                                Priority 3
                              </span>
                            )}
                            {ver.sourceType === "doodstream" && (
                              <span className="text-[10px] bg-cyan-500/20 text-cyan-400 px-1.5 py-0.5 rounded font-mono font-bold shrink-0">
                                Priority 4
                              </span>
                            )}
                            {!ver.isLocal && ver.sourceType !== "streamtape" && ver.sourceType !== "doodstream" && ver.sourceType !== "real-debrid" && ver.remoteName !== "real-debrid" && (
                              <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded font-mono font-bold shrink-0">
                                Priority 5
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-subtle font-mono truncate max-w-full mt-0.5">
                            {isGuest ? "Cloud Optimized Stream" : ver.remotePath}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {!isBookOrAudio && (
                <button
                  onClick={() => setShowStremioModal(true)}
                  className="btn-accent flex items-center gap-2 px-6 py-3 bg-accent text-void font-semibold hover:bg-accent/90"
                  title="Search Stremio Addons & Multi-Tracker Debrid caches"
                >
                  <Sparkles size={18} />
                  <span>Stremio Streams</span>
                </button>
              )}
              <button
                onClick={() => setShowEasynewsSearch(true)}
                className="btn-secondary flex items-center gap-2 px-6 py-3"
                title={`Search Usenet for "${item.title}"`}
              >
                <Globe size={18} />
                Search on Easynews
              </button>
              {!isBookOrAudio && (
                <button
                  onClick={() => setShowInfiniDyskModal(true)}
                  className="btn-secondary flex items-center gap-2 px-5 py-3 text-cyan-400 border border-cyan-500/40 bg-cyan-500/10 hover:border-cyan-400 hover:bg-cyan-500/20"
                  title="Search Usenet indexers (OMGWTFNZBs & NZBIndex) and stream via InfiniDysk WebDAV"
                >
                  <Radio size={18} />
                  <span>InfiniDysk Usenet</span>
                </button>
              )}
              <button
                onClick={() => navigate("/explorer")}
                className="btn-secondary flex items-center gap-2 px-5 py-3"
                title="Search your cloud remotes in Cloud Explorer"
              >
                <Compass size={18} />
                Find in Cloud Explorer
              </button>
            </div>
          )}

          <FavoriteButton itemId={item.id} size="lg" showLabel />
          <AddToPlaylistButton items={item} size="lg" showLabel />

          <button
            onClick={() => {
              const isComp = progress?.completed;
              const nextState = toggleWatchCompleted(item.id, !isComp);
              useToastStore.getState().addToast(
                nextState
                  ? `Marked "${item.title}" as watched`
                  : `Marked "${item.title}" as unwatched`,
                "info"
              );
            }}
            className={`btn-secondary flex items-center gap-2 px-5 py-3 transition-colors ${
              progress?.completed
                ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                : "text-subtle hover:text-white"
            }`}
            title={progress?.completed ? "Watched (Click to mark unwatched)" : "Mark as Watched"}
          >
            <Check size={18} className={progress?.completed ? "text-emerald-400" : "currentColor"} />
            <span>{progress?.completed ? "Watched" : "Mark Watched"}</span>
          </button>

          {isBookOrAudio && (
            <div className="flex items-center gap-2">
              {companion ? (
                <>
                  <motion.button
                    onClick={handleStartImmersionReading}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="btn-accent flex items-center gap-2 px-5 py-3 shadow-md"
                    title={`Immersion Reading: Read and listen together with "${companion.title}"`}
                  >
                    {isEbook ? <Headphones size={18} /> : <BookOpen size={18} />}
                    <span>Read Along</span>
                  </motion.button>
                  <button
                    onClick={() => setShowKaggleAlign(true)}
                    className="btn-secondary flex items-center gap-2 px-4 py-3 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                    title="Align EPUB & Audiobook via Kaggle free T4 GPU (Whisper SMIL Media Overlays)"
                  >
                    <Sparkles size={16} />
                    <span>Align Audio (GPU)</span>
                  </button>
                </>
              ) : null}
              <button
                onClick={() => setShowPairModal(true)}
                className={`btn-secondary flex items-center gap-2 px-4 py-3 ${
                  companion ? "border-accent/40 text-accent font-semibold" : ""
                }`}
                title={
                  companion
                    ? `Paired with "${companion.title}" - click to change`
                    : `Pair with companion ${isEbook ? "audiobook" : "ebook"}`
                }
              >
                {isEbook ? <Headphones size={16} /> : <BookOpen size={16} />}
                <span>{companion ? "Paired Companion" : `Pair ${isEbook ? "Audiobook" : "Ebook"}`}</span>
              </button>
            </div>
          )}

          {item.remotePath && (
            <>
              {isLocalItem(item) ? (
                <div
                  className="btn-secondary opacity-75 cursor-default flex items-center gap-2 px-4 py-3 text-emerald-400"
                  title="This title is stored locally on your device"
                >
                  <CheckCircle2 size={16} />
                  Stored Locally
                </div>
              ) : (
                <button
                  onClick={() => downloadSingleItem(item)}
                  className="btn-secondary flex items-center gap-2 px-4 py-3"
                  title={`Download "${item.title}"`}
                >
                  <Download size={16} />
                  Download
                </button>
              )}

              {/* Cyberlocker Push or Cached Badges */}
              {(item.libraryType === "movies" || item.libraryType === "tv") && (
                isGuest ? (
                  item.versions?.some(
                    (v) =>
                      v.sourceType === "streamtape" ||
                      v.sourceType === "doodstream" ||
                      v.remoteName === "streamtape" ||
                      v.remoteName === "doodstream" ||
                      v.remotePath.toLowerCase().startsWith("streamtape:") ||
                      v.remotePath.toLowerCase().startsWith("doodstream:")
                  ) ? (
                    <div
                      className="btn-secondary opacity-80 cursor-default flex items-center gap-2 px-4 py-3 text-amber-400 border border-amber-500/30"
                      title="Optimized Cloud Fast Stream ready"
                    >
                      <CheckCircle2 size={16} />
                      <span>Cloud Fast Stream</span>
                    </div>
                  ) : null
                ) : (
                  <>
                    {/* Telegram Serverless Tier 1 Offload */}
                    {hasTelegramVersion(item) ? (
                      <div
                        className="btn-secondary opacity-80 cursor-default flex items-center gap-2 px-4 py-3 text-sky-400 border border-sky-500/30"
                        title="Cached on Telegram Serverless CDN (tg-serverless) for direct unauthenticated streaming"
                      >
                        <CheckCircle2 size={16} />
                        <span>tg-serverless Cached</span>
                      </div>
                    ) : (
                      <button
                        onClick={async () => {
                          setPushingToTelegram(true);
                          try {
                            await offloadMediaItemToTelegram(item);
                          } catch (err: any) {
                            console.error("Telegram offload error:", err);
                          } finally {
                            setPushingToTelegram(false);
                          }
                        }}
                        disabled={pushingToTelegram}
                        className="btn-secondary flex items-center gap-2 px-4 py-3 text-sky-400 border border-sky-500/30 hover:border-sky-400 transition-colors"
                        title="Offload video streaming to Telegram Serverless CDN (< 2 GB)"
                      >
                        {pushingToTelegram ? (
                          <Loader2 size={16} className="animate-spin text-sky-400" />
                        ) : (
                          <CloudUpload size={16} />
                        )}
                        <span>{pushingToTelegram ? "Offloading to TG…" : "Offload to TG"}</span>
                      </button>
                    )}

                    {/* Catbox.moe Opt-In Offload (Desktop only, non-video <= 200 MB) */}
                    {catboxEnabled &&
                      !(typeof window !== "undefined" && (window as any).AndroidBridge) &&
                      (["music", "books", "comics", "audiobooks"].includes(item.libraryType as string)) &&
                      (!item.sizeBytes || item.sizeBytes <= 200 * 1024 * 1024) && (
                        item.versions?.some((v) => v.remoteName === "catbox" || (v.sourceType as any) === "catbox") ? (
                          <div
                            className="btn-secondary opacity-80 cursor-default flex items-center gap-2 px-4 py-3 text-emerald-400 border border-emerald-500/30"
                            title="Cached on Catbox.moe public hotlink"
                          >
                            <CheckCircle2 size={16} />
                            <span>Catbox Cached</span>
                          </div>
                        ) : (
                          <button
                            onClick={async () => {
                              setPushingToCatbox(true);
                              try {
                                const url = await offloadItemToCatbox(item);
                                useToastStore.getState().addToast(`Offloaded to Catbox (public link): ${url}`, "success");
                              } catch (err: any) {
                                useToastStore.getState().addToast(`Catbox offload failed: ${err?.message || err}`, "error");
                              } finally {
                                setPushingToCatbox(false);
                              }
                            }}
                            disabled={pushingToCatbox}
                            title="Offload to Catbox.moe (creates a public https://files.catbox.moe/... URL)"
                            className="btn-secondary flex items-center gap-2 px-4 py-3 text-amber-300 border border-amber-500/30 hover:bg-amber-500/10 disabled:opacity-50"
                          >
                            {pushingToCatbox ? <Loader2 size={16} className="animate-spin" /> : <CloudUpload size={16} />}
                            <span>{pushingToCatbox ? "Uploading to Catbox…" : "Offload to Catbox"}</span>
                          </button>
                        )
                      )}

                    {/* Streamtape Tier 1 Offload */}
                    {item.versions?.some(
                      (v) =>
                        v.sourceType === "streamtape" ||
                        v.remoteName === "streamtape" ||
                        v.remotePath.toLowerCase().startsWith("streamtape:")
                    ) ? (
                      <div
                        className="btn-secondary opacity-80 cursor-default flex items-center gap-2 px-4 py-3 text-amber-400 border border-amber-500/30"
                        title="Cached on Streamtape CDN for zero cloud remote API consumption"
                      >
                        <CheckCircle2 size={16} />
                        <span>Streamtape Cached</span>
                      </div>
                    ) : (
                      <button
                        onClick={async () => {
                          setPushingToStreamtape(true);
                          await pushItemToStreamtape(item);
                          setPushingToStreamtape(false);
                        }}
                        disabled={pushingToStreamtape}
                        className="btn-secondary flex items-center gap-2 px-4 py-3 text-amber-400 border border-amber-500/30 hover:border-amber-400 transition-colors"
                        title="Offload video streaming to Streamtape CDN cache"
                      >
                        {pushingToStreamtape ? (
                          <Loader2 size={16} className="animate-spin text-amber-400" />
                        ) : (
                          <CloudUpload size={16} />
                        )}
                        <span>{pushingToStreamtape ? "Pushing to CDN…" : "Push to Streamtape"}</span>
                      </button>
                    )}

                    {/* DoodStream Tier 2 Rolling Relay */}
                    {item.versions?.some(
                      (v) =>
                        v.sourceType === "doodstream" ||
                        v.remoteName === "doodstream" ||
                        v.remotePath.toLowerCase().startsWith("doodstream:")
                    ) ? (
                      <div
                        className="btn-secondary opacity-80 cursor-default flex items-center gap-2 px-4 py-3 text-cyan-400 border border-cyan-500/30"
                        title="Mirrored to DoodStream CDN for 60-day fallback relay"
                      >
                        <CheckCircle2 size={16} />
                        <span>DoodStream Cached</span>
                      </div>
                    ) : (
                      <button
                        onClick={async () => {
                          setPushingToDoodstream(true);
                          await pushItemToDoodstream(item);
                          setPushingToDoodstream(false);
                        }}
                        disabled={pushingToDoodstream}
                        className="btn-secondary flex items-center gap-2 px-4 py-3 text-cyan-400 border border-cyan-500/30 hover:border-cyan-400 transition-colors"
                        title="Mirror video streaming to DoodStream CDN relay"
                      >
                        {pushingToDoodstream ? (
                          <Loader2 size={16} className="animate-spin text-cyan-400" />
                        ) : (
                          <CloudUpload size={16} />
                        )}
                        <span>{pushingToDoodstream ? "Mirroring to CDN…" : "Push to DoodStream"}</span>
                      </button>
                    )}

                    {/* Real-Debrid Untouched 4K/1080p CDN Tier */}
                    {debridConfig?.realDebridApiKey && (
                      item.versions?.some(
                        (v) =>
                          v.sourceType === "real-debrid" ||
                          v.remoteName === "real-debrid" ||
                          v.remotePath.toLowerCase().includes(".real-debrid.com")
                      ) ? (
                        <div
                          className="btn-secondary opacity-80 cursor-default flex items-center gap-2 px-4 py-3 text-emerald-400 border border-emerald-500/30"
                          title="Cached on Real-Debrid CDN for untouched 4K/1080p high-bitrate streaming"
                        >
                          <CheckCircle2 size={16} />
                          <span>Real-Debrid 4K Cached</span>
                        </div>
                      ) : (
                        <button
                          onClick={async () => {
                            setPushingToRd(true);
                            await seedItemToRealDebrid(item);
                            setPushingToRd(false);
                          }}
                          disabled={pushingToRd}
                          className="btn-secondary flex items-center gap-2 px-4 py-3 text-emerald-400 border border-emerald-500/30 hover:border-emerald-400 transition-colors"
                          title="Seed untouched original video to Real-Debrid CDN via cloud worker"
                        >
                          {pushingToRd ? (
                            <Loader2 size={16} className="animate-spin text-emerald-400" />
                          ) : (
                            <CloudUpload size={16} />
                          )}
                          <span>{pushingToRd ? "Seeding to RD…" : "Seed to Real-Debrid"}</span>
                        </button>
                      )
                    )}
                  </>
                )
              )}

              {/* DropMB Audio/Book Offload, Share Link & Expiration (Hidden for Guests) */}
              {!isGuest && (item.libraryType === "music" || item.libraryType === "audiobooks" || item.libraryType === "books") && (
                (() => {
                  const dropmbVer = item.versions?.find(
                    (v) =>
                      v.remoteName === "dropmb" ||
                      v.remotePath.toLowerCase().includes("dropmb.com")
                  );
                  const isDropmbCached = Boolean(dropmbVer || isDropmbUrl(item.remotePath));
                  const dropmbUrl = dropmbVer?.remotePath || (isDropmbUrl(item.remotePath) ? item.remotePath : "");
                  const shareId = dropmbUrl ? extractDropmbShareId(dropmbUrl) : null;
                  const publicShareLink = shareId ? `https://dropmb.com/share/${shareId}` : null;
                  const expStatus = getDropmbExpirationStatus(dropmbVer?.expiresAt || item.dropmbExpiresAt);

                  if (isDropmbCached) {
                    return (
                      <div className="flex items-center gap-2">
                        <div
                          className="btn-secondary opacity-90 cursor-default flex items-center gap-2 px-4 py-3 text-cyan-400 border border-cyan-500/30"
                          title={`Cached on DropMB Cloud (100-Day Inactivity Lease). ${expStatus.tooltip}`}
                        >
                          <CheckCircle2 size={16} />
                          <span>DropMB ({expStatus.label})</span>
                        </div>
                        {publicShareLink && (
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(publicShareLink);
                              useToastStore.getState().addToast("Copied DropMB public share link to clipboard!", "success");
                            }}
                            className="btn-secondary flex items-center gap-2 px-4 py-3 text-cyan-400 border border-cyan-500/30 hover:border-cyan-400 hover:bg-cyan-500/10 transition-colors"
                            title={`DropMB Public Share Link: ${publicShareLink} (Click to copy)`}
                          >
                            <Share2 size={16} />
                            <span>Share Link</span>
                          </button>
                        )}
                      </div>
                    );
                  }

                  return (
                    <button
                      onClick={async () => {
                        setPushingToDropmb(true);
                        await offloadAudioItemToDropmb(item);
                        setPushingToDropmb(false);
                      }}
                      disabled={pushingToDropmb}
                      className="btn-secondary flex items-center gap-2 px-4 py-3 text-cyan-400 border border-cyan-500/30 hover:border-cyan-400 transition-colors"
                      title={item.libraryType === "books" ? "Offload book to DropMB (100-Day Cloud Storage)" : "Offload audio track to DropMB (100-Day Cloud Storage)"}
                    >
                      {pushingToDropmb ? (
                        <Loader2 size={16} className="animate-spin text-cyan-400" />
                      ) : (
                        <Cloud size={16} />
                      )}
                      <span>{pushingToDropmb ? "Offloading..." : "Offload to DropMB"}</span>
                    </button>
                  );
                })()
              )}

              <button
                onClick={() => setShowFixMatch(true)}
                className="btn-secondary flex items-center gap-2 px-4 py-3"
              >
                <Wrench size={16} />
                Fix Match
              </button>

              {(item.libraryType as string) === "adult" && (
                <button
                  onClick={() => setShowFingerprintModal(true)}
                  className="btn-secondary flex items-center gap-2 px-4 py-3"
                >
                  <Sparkles size={16} className="text-accent" />
                  Identify by Fingerprint
                </button>
              )}

              {!isGuest && item.remotePath && (
                <button
                  onClick={handleShareMediaItem}
                  className="btn-secondary flex items-center gap-2 px-4 py-3 text-emerald-400 border border-emerald-500/30 hover:border-emerald-400 hover:bg-emerald-500/10 transition-colors"
                  title="Share Public Link (Copy to Clipboard)"
                >
                  <Share2 size={16} />
                  <span>Share Link</span>
                </button>
              )}
            </>
          )}

          {/* Universal Stremio & Easynews Discovery (Available for all video titles, whether local or discovery) */}
          {!isBookOrAudio && (
            <>
              <button
                onClick={() => setShowStremioModal(true)}
                className="btn-secondary flex items-center gap-2 px-4 py-3 text-accent border border-accent/40 bg-accent/10 hover:border-accent hover:bg-accent/20 transition-colors"
                title="Search Stremio Addons & Multi-Tracker Debrid caches"
              >
                <Sparkles size={16} />
                <span>Stremio Streams</span>
              </button>

              <button
                onClick={() => setShowEasynewsSearch(true)}
                className={`btn-secondary flex items-center gap-2 px-4 py-3 ${
                  missingTvEpisodesCount > 0
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:text-white hover:border-amber-400"
                    : "text-subtle hover:text-white"
                }`}
                title="Search Easynews Usenet for missing episodes or alternative releases"
              >
                <Globe size={16} className={missingTvEpisodesCount > 0 ? "text-amber-400" : ""} />
                <span>
                  {missingTvEpisodesCount > 0
                    ? `Find Missing (${missingTvEpisodesCount})`
                    : "Search Easynews"}
                </span>
              </button>

              <button
                onClick={() => setShowInfiniDyskModal(true)}
                className="btn-secondary flex items-center gap-2 px-4 py-3 text-cyan-400 border border-cyan-500/30 bg-cyan-500/10 hover:border-cyan-400 hover:bg-cyan-500/20 transition-colors cursor-pointer"
                title="Search Usenet indexers (OMGWTFNZBs & NZBIndex) and stream via InfiniDysk WebDAV"
              >
                <Radio size={16} />
                <span>InfiniDysk Usenet</span>
              </button>
            </>
          )}

          {isTvItem && (
            <>
              <button
                onClick={() => {
                  const targetId = item.showId || item.metadataId || item.showTitle || item.title;
                  navigate(`/tv/show/${encodeURIComponent(targetId)}`, { state: { item } });
                }}
                className="btn-secondary flex items-center gap-2 px-4 py-3 text-accent border-accent/30 hover:border-accent"
                title="View full series episode list and seasons"
              >
                <Tv size={16} />
                <span>Series Episodes</span>
              </button>

              {resolvedTvDestPath && !isGuest && (
                tvSubscriptions?.[seriesKey] ? (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        const sub = tvSubscriptions[seriesKey];
                        useToastStore.getState().addToast(`Checking missing episodes for ${seriesTitle}...`, "info");
                        const res = await checkSingleTvSubscription(sub, 2);
                        if (res.grabbed.length === 0) {
                          useToastStore.getState().addToast("No new aired missing episodes found on configured sources.", "info");
                        }
                      }}
                      className="btn-secondary flex items-center gap-2 px-4 py-3 border-emerald-500/40 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                      title={`Subscribed! Routing new episodes to ${tvSubscriptions[seriesKey].destinationRemotePath}. Click to check now.`}
                    >
                      <BellRing size={16} className="text-emerald-400" />
                      <span>Subscribed (Check Now)</span>
                    </button>
                    <button
                      onClick={() => setShowSubscribeModal(true)}
                      className="btn-secondary px-3 py-3 text-xs text-subtle hover:text-accent hover:border-accent/50"
                      title="Edit subscription settings (quality, release groups, sources, conversion)"
                    >
                      Settings
                    </button>
                    <button
                      onClick={() => {
                        removeTvSubscription(seriesKey);
                        useToastStore.getState().addToast(`Unsubscribed from "${seriesTitle}"`, "info");
                      }}
                      className="btn-secondary px-3 py-3 text-xs text-subtle hover:text-danger hover:border-danger/40"
                    >
                      Unsubscribe
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowSubscribeModal(true)}
                    className="btn-secondary flex items-center gap-2 px-4 py-3 text-white/90 hover:text-accent hover:border-accent"
                    title={`Subscribe: choose quality, release groups, search sources and conversion for ${resolvedTvDestPath}`}
                  >
                    <Bell size={16} />
                    <span>Subscribe</span>
                  </button>
                )
              )}
            </>
          )}

          {/* Weekly Recommendation (Admin only) */}
          {!isGuest && (
            <button
              onClick={() => setShowRecommendModal(true)}
              className={`btn-secondary flex items-center gap-2 px-4 py-3 border transition-colors cursor-pointer ${
                isRecommended
                  ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                  : "text-subtle hover:text-amber-300 hover:border-amber-500/40"
              }`}
              title={isRecommended ? "Title is Recommended this week (Click to edit badge effect or remove)" : "Recommend title this week (Max 3/week)"}
            >
              <Star size={16} className={isRecommended ? "fill-amber-400 text-amber-400" : ""} />
              <span>{isRecommended ? "Recommended" : "Recommend Title"}</span>
            </button>
          )}
        </div>

        {/* Overview */}
        {(item.overview ?? item.showOverview) && (
          <div className="mb-6">
            <h3 className="text-text font-body font-semibold text-sm mb-2">Overview</h3>
            <p className="text-subtle font-body text-sm leading-relaxed max-w-2xl">
              {item.overview ?? item.showOverview}
            </p>
          </div>
        )}

        {/* File & Technical Media Info */}
        {item.remotePath ? (
          <div className="bg-panel border border-border rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Info size={14} className="text-accent" />
                <h3 className="text-text font-body font-semibold text-xs uppercase tracking-wider">Media & File Specs</h3>
              </div>
              {tech.container && (
                <span className="px-2 py-0.5 rounded bg-surface border border-border text-[10px] font-mono uppercase text-accent font-semibold">
                  {tech.container}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
              {tech.resolution && (
                <div className="p-2.5 rounded-lg bg-surface/60 border border-border/40">
                  <span className="text-subtle/70 block text-[10px] uppercase font-mono">Resolution</span>
                  <span className="text-accent font-mono font-semibold text-xs">{tech.resolution}</span>
                </div>
              )}
              {tech.videoCodec && (
                <div className="p-2.5 rounded-lg bg-surface/60 border border-border/40">
                  <span className="text-subtle/70 block text-[10px] uppercase font-mono">Video Codec</span>
                  <span className="text-text font-mono text-xs font-medium">{tech.videoCodec}</span>
                </div>
              )}
              {tech.audioCodec && (
                <div className="p-2.5 rounded-lg bg-surface/60 border border-border/40">
                  <span className="text-subtle/70 block text-[10px] uppercase font-mono">Audio Codec</span>
                  <span className="text-text font-mono text-xs font-medium">{tech.audioCodec}</span>
                </div>
              )}
              {tech.sizeFormatted && (
                <div className="p-2.5 rounded-lg bg-surface/60 border border-border/40">
                  <span className="text-subtle/70 block text-[10px] uppercase font-mono">File Size</span>
                  <span className="text-text font-mono text-xs font-medium">{tech.sizeFormatted}</span>
                </div>
              )}
              {tech.durationFormatted && (
                <div className="p-2.5 rounded-lg bg-surface/60 border border-border/40">
                  <span className="text-subtle/70 block text-[10px] uppercase font-mono">Duration</span>
                  <span className="text-text font-mono text-xs font-medium">{tech.durationFormatted}</span>
                </div>
              )}
              {item.metadataSource && (
                <div className="p-2.5 rounded-lg bg-surface/60 border border-border/40">
                  <span className="text-subtle/70 block text-[10px] uppercase font-mono">Metadata Match</span>
                  <span className="text-text uppercase font-mono text-[10px] font-semibold">
                    {item.metadataSource} ({item.metadataConfidence ?? "auto"})
                  </span>
                </div>
              )}
            </div>

            {/* Remote File Path with 1-click Copy */}
            {tech.fullPath && (
              <div className="pt-2.5 border-t border-border/40 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <span className="text-subtle/70 text-[10px] uppercase font-mono block">Full Remote Path</span>
                  <p className="text-text font-mono text-xs truncate" title={tech.fullPath}>
                    {tech.fullPath}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(tech.fullPath);
                    setCopiedPath(true);
                    useToastStore.getState().addToast("Copied file path to clipboard", "success");
                    setTimeout(() => setCopiedPath(false), 2000);
                  }}
                  className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 shrink-0"
                  title="Copy full remote path"
                >
                  {copiedPath ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                  <span>{copiedPath ? "Copied" : "Copy Path"}</span>
                </button>
              </div>
            )}

            {/* Offload Mirrors & Direct Links Panel */}
            {!isGuest && <OffloadMirrorsPanel item={item} />}
          </div>
        ) : (
          <div className="bg-panel border border-border rounded-xl p-4">
            <h3 className="text-text font-body font-semibold text-xs uppercase tracking-wider mb-2">Discovery Catalog Recommendation</h3>
            <p className="text-subtle font-body text-xs leading-relaxed">
              This title is featured in trending global discovery. If you have this file on another cloud remote or folder, map it in Settings &rarr; Libraries or search your remotes in Cloud Explorer.
            </p>
          </div>
        )}

        {/* More Like This Shelf */}
        {!isBookOrAudio && recommendations.length > 0 && (
          <div className="mt-8 -mx-8">
            <MediaShelf
              title="More Like This"
              items={recommendations}
              progressMap={watchProgress}
              onItemClick={(recItem) =>
                resolveDiscoveryCardNavigation(recItem, mediaItems, navigate)
              }
            />
          </div>
        )}
      </div>

      {showFixMatch && <FixMatchModal item={item} onClose={() => setShowFixMatch(false)} />}
      {showFingerprintModal && (
        <FingerprintIdentifyModal item={item} onClose={() => setShowFingerprintModal(false)} />
      )}

      <StremioStreamsModal
        isOpen={showStremioModal}
        onClose={() => setShowStremioModal(false)}
        item={item}
      />

      <EasynewsSearchModal
        isOpen={showEasynewsSearch}
        onClose={() => setShowEasynewsSearch(false)}
        initialQuery={
          item.season !== undefined && item.episode !== undefined
            ? `${(item.showTitle || item.title || "").replace(/["':]/g, " ").replace(/\s+/g, " ").trim()} S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`
            : (item.title || item.showTitle || "").replace(/["':]/g, " ").replace(/\s+/g, " ").trim()
        }
      />

      <InfiniDyskSearchModal
        isOpen={showInfiniDyskModal}
        onClose={() => setShowInfiniDyskModal(false)}
        initialQuery={
          item.season !== undefined && item.episode !== undefined
            ? `${(item.showTitle || item.title || "").replace(/["':]/g, " ").replace(/\s+/g, " ").trim()} S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`
            : (item.title || item.showTitle || "").replace(/["':]/g, " ").replace(/\s+/g, " ").trim()
        }
        item={item}
      />

      {showShareModal && item.remotePath && (() => {
        const isWin = /^[a-zA-Z]:[\\\/]/.test(item.remotePath);
        const rmName = !isWin && item.remotePath.includes(":") ? item.remotePath.split(":")[0] : "";
        const fPath = !isWin && item.remotePath.includes(":") ? item.remotePath.split(":").slice(1).join(":") : item.remotePath;
        return (
          <ShareStreamLinkModal
            remoteName={rmName}
            filePath={fPath}
            fileName={item.filename || `${item.title}.mp4`}
            onClose={() => setShowShareModal(false)}
          />
        );
      })()}

      {showPairModal && (
        <PairAudiobookModal
          item={item}
          currentPair={companion}
          isOpen={showPairModal}
          onClose={() => setShowPairModal(false)}
        />
      )}

      {showKaggleAlign && companion && (
        <KaggleAlignModal
          isOpen={showKaggleAlign}
          onClose={() => setShowKaggleAlign(false)}
          epubItem={isEbook ? item : companion}
          audioItem={isEbook ? companion : item}
        />
      )}

      {/* Admin Recommendation Modal - Solid UI Standard */}
      {showSubscribeModal && resolvedTvDestPath && (
        <SubscribeModal
          isOpen={showSubscribeModal}
          onClose={() => setShowSubscribeModal(false)}
          seed={{
            seriesId: seriesKey,
            imdbId: canonicalSeries?.imdbId || (seriesKey.startsWith("tt") ? seriesKey : undefined),
            seriesTitle,
            posterUrl: item.showPosterUrl || item.posterUrl,
            libraryId:
              (libraries.find((l) => l.id === item.libraryId) || libraries.find((l) => l.type === "tv"))?.id ||
              item.libraryId,
            destinationRemotePath: resolvedTvDestPath,
          }}
          existing={tvSubscriptions?.[seriesKey] || null}
        />
      )}

      {showRecommendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80">
          <div className="w-full max-w-sm rounded-2xl bg-panel border border-border shadow-2xl p-5 flex flex-col gap-4 text-white">
            <div className="flex items-center justify-between pb-2 border-b border-white/10">
              <h3 className="text-sm font-heading font-bold text-white flex items-center gap-2">
                <Star size={16} className="text-amber-400 fill-amber-400" />
                <span>Weekly Recommendation</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowRecommendModal(false)}
                className="p-1 rounded-lg hover:bg-white/10 text-white/60 hover:text-white cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <p className="text-xs text-white/70">
              Recommend <span className="font-semibold text-white">"{item.title}"</span> for week{" "}
              <span className="font-mono text-accent">{currentWeek}</span>. Max 3 titles per library. Badges transfer to all guest passes issued this week.
            </p>

            <div className="flex flex-col gap-2">
              <label className="text-[11px] font-semibold text-white/50 uppercase tracking-wider">
                Select Badge Style
              </label>
              <div className="grid grid-cols-1 gap-2">
                {(["gold", "flame", "glow", "shimmer", "pulse"] as RecommendationBadgeEffect[]).map((eff) => (
                  <button
                    key={eff}
                    type="button"
                    onClick={() => setSelectedEffect(eff)}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl border text-xs transition-colors cursor-pointer ${
                      selectedEffect === eff
                        ? "bg-accent/20 border-accent text-white"
                        : "bg-surface border-white/10 text-white/70 hover:bg-white/5"
                    }`}
                  >
                    <span className="capitalize font-medium">{eff}</span>
                    <RecommendationBadge effect={eff} />
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2 border-t border-white/10">
              {isRecommended ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      removeLibraryRecommendation(item.libraryId, item.id);
                      const updated: MediaItem = {
                        ...item,
                        isRecommended: false,
                        recommendationBadge: undefined,
                      };
                      upsertMediaItem(updated);
                      persistItems([updated]);
                      useToastStore.getState().addToast(`Removed recommendation for "${item.title}"`, "info");
                      setShowRecommendModal(false);
                    }}
                    className="flex-1 py-2 rounded-xl bg-danger/15 hover:bg-danger/25 text-danger border border-danger/30 text-xs font-semibold cursor-pointer"
                  >
                    Remove Pick
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLibraryRecommendation(item.libraryId, {
                        itemId: item.id,
                        title: item.title,
                        badgeEffect: selectedEffect,
                        badgeText: "RECOMMENDED",
                        addedAt: Date.now(),
                      });
                      const updated: MediaItem = {
                        ...item,
                        isRecommended: true,
                        recommendationBadge: {
                          text: "RECOMMENDED",
                          effect: selectedEffect,
                        },
                      };
                      upsertMediaItem(updated);
                      persistItems([updated]);
                      useToastStore.getState().addToast(`Updated badge effect to ${selectedEffect}!`, "success");
                      setShowRecommendModal(false);
                    }}
                    className="flex-1 py-2 rounded-xl bg-accent text-void text-xs font-bold hover:brightness-110 cursor-pointer"
                  >
                    Save Effect
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    const res = setLibraryRecommendation(item.libraryId, {
                      itemId: item.id,
                      title: item.title,
                      badgeEffect: selectedEffect,
                      badgeText: "RECOMMENDED",
                      addedAt: Date.now(),
                    });
                    if (res.success) {
                      const updated: MediaItem = {
                        ...item,
                        isRecommended: true,
                        recommendationBadge: {
                          text: "RECOMMENDED",
                          effect: selectedEffect,
                        },
                      };
                      upsertMediaItem(updated);
                      persistItems([updated]);
                      useToastStore.getState().addToast(`Recommended "${item.title}" with ${selectedEffect} badge!`, "success");
                      setShowRecommendModal(false);
                    } else {
                      useToastStore.getState().addToast(res.error || "Could not set recommendation", "error");
                    }
                  }}
                  className="w-full py-2.5 rounded-xl bg-accent text-void text-xs font-bold hover:brightness-110 cursor-pointer"
                >
                  Set as Weekly Pick
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
