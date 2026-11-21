import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Play,
  Clock,
  Heart,
  ListPlus,
  Wrench,
  Download,
  Check,
  Loader2,
  Film,
  Star,
  ExternalLink,
  Info,
  Trash2,
  Zap,
  BookOpen,
  Copy,
  Globe,
  Tv,
  Cloud,
  CloudUpload,
  AlertCircle,
  Share2,
  Sparkles,
  Radio,
} from "lucide-react";
import { CloudTranscodeModal } from "./CloudTranscodeModal";
import { AudiobookConverterModal } from "../audiobooks/AudiobookConverterModal";
import { EasynewsSearchModal } from "../discovery/EasynewsSearchModal";
import { StremioStreamsModal } from "../discovery/StremioStreamsModal";
import { InfiniDyskSearchModal } from "../discovery/InfiniDyskSearchModal";
import { OffloadMirrorsPanel } from "./OffloadMirrorsPanel";
import { FingerprintIdentifyModal } from "./FingerprintIdentifyModal";
import { extractMediaTechnicalSpecs } from "../../lib/mediaInfo";
import {
  offloadAudioItemToDropmb,
  getDropmbExpirationStatus,
  isDropmbUrl,
  extractDropmbShareId,
} from "../../lib/dropmbOffload";
import {
  offloadMediaItemToTelegram,
  hasTelegramVersion,
} from "../../lib/telegramOffload";
import { seedItemToRealDebrid } from "../../lib/realDebridSeeder";
import {
  useAppStore,
  isItemFavorited,
  type MediaItem,
  type WatchProgress,
  type RecommendationBadgeEffect,
} from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { useArtwork } from "../../lib/artwork";
import { resolveTrailer } from "../../lib/trailer";
import { invoke } from "@tauri-apps/api/core";
import {
  downloadSingleItem,
  getDownloadedFilePath,
  useDownloadStore,
} from "../../lib/downloadManager";
import { FixMatchModal } from "./FixMatchModal";
import { AddToPlaylistModal } from "../playlist/AddToPlaylistModal";
import { RecommendationBadge } from "./RecommendationBadge";
import { getIsoWeekString } from "../../lib/recommendations";
import { persistItems } from "../../lib/libraryDb";

type Props = {
  item: MediaItem;
  isOpen: boolean;
  onClose: () => void;
  onPlay: (item: MediaItem, resume?: boolean) => void;
  progress?: WatchProgress;
};

function formatDuration(seconds?: number): string | null {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function MediaDetailsModal({
  item,
  isOpen,
  onClose,
  onPlay,
  progress,
}: Props) {
  const navigate = useNavigate();
  const [trailerId, setTrailerId] = useState<string | null>(null);
  const [loadingTrailer, setLoadingTrailer] = useState(false);
  const [showTrailerPlayer, setShowTrailerPlayer] = useState(false);
  const [trailerSearched, setTrailerSearched] = useState(false);
  const [showFixMatch, setShowFixMatch] = useState(false);
  const [showFingerprintModal, setShowFingerprintModal] = useState(false);
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [showCloudTranscode, setShowCloudTranscode] = useState(false);
  const [showAudiobookConvert, setShowAudiobookConvert] = useState(false);
  const [showEasynewsSearch, setShowEasynewsSearch] = useState(false);
  const [showStremioModal, setShowStremioModal] = useState(false);
  const [showInfiniDyskModal, setShowInfiniDyskModal] = useState(false);
  const [pushingToDropmb, setPushingToDropmb] = useState(false);
  const [pushingToRd, setPushingToRd] = useState(false);
  const [pushingToTelegram, setPushingToTelegram] = useState(false);

  const [posterError, setPosterError] = useState(false);
  const [backdropError, setBackdropError] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const tech = extractMediaTechnicalSpecs(item);
  const posterSrc = useArtwork(item.showPosterUrl || item.posterUrl);
  const backdropSrc = useArtwork(item.backdropUrl || item.showBackdropUrl || item.posterUrl);

  const debridConfig = useAppStore((s) => s.debridConfig);
  const isFavorite = useAppStore((s) => isItemFavorited(item, s.favorites, s.mediaItems));
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const toggleWatchCompleted = useAppStore((s) => s.toggleWatchCompleted);
  const removeMediaItem = useAppStore((s) => s.removeMediaItem);
  const libraries = useAppStore((s) => s.libraries);
  const addToast = useToastStore((s) => s.addToast);

  const isGuest = useMemo(
    () => libraries.some((l) => l.id === item.libraryId && l.isSharedPass),
    [libraries, item.libraryId]
  );

  const setLibraryRecommendation = useAppStore((s) => s.setLibraryRecommendation);
  const removeLibraryRecommendation = useAppStore((s) => s.removeLibraryRecommendation);
  const updateLibraryRecommendationEffect = useAppStore((s) => s.updateLibraryRecommendationEffect);
  const adminWeeklyRecommendations = useAppStore((s) => s.adminWeeklyRecommendations);
  const upsertMediaItem = useAppStore((s) => s.upsertMediaItem);

  const [showRecommendModal, setShowRecommendModal] = useState(false);
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

  const downloads = useDownloadStore((s) => s.downloads);
  const isDownloading = Object.values(downloads).some(
    (d) =>
      d.status === "downloading" &&
      (d.currentFile === item?.filename || d.title === (item?.showTitle ?? item?.title))
  );

  useEffect(() => {
    let active = true;
    getDownloadedFilePath(item).then((path) => {
      if (active) setIsDownloaded(!!path);
    });
    return () => {
      active = false;
    };
  }, [item, downloads]);

  const isVideo =
    item.libraryType === "movies" ||
    item.libraryType === "tv" ||
    item.groupType === "show" ||
    (!item.libraryType && !item.author && !item.artist);

  // Preload trailer when modal opens (video content only)
  useEffect(() => {
    if (!isOpen || !isVideo) {
      setShowTrailerPlayer(false);
      return;
    }

    let active = true;
    setLoadingTrailer(true);
    setTrailerSearched(false);

    resolveTrailer(item)
      .then((id) => {
        if (active) {
          setTrailerId(id);
          setLoadingTrailer(false);
          setTrailerSearched(true);
        }
      })
      .catch(() => {
        if (active) {
          setLoadingTrailer(false);
          setTrailerSearched(true);
        }
      });

    return () => {
      active = false;
    };
  }, [isOpen, item.id, item.metadataId, isVideo]);

  if (!isOpen) return null;

  const description = item.overview || item.showOverview;
  const ratingScore = item.rating
    ? item.rating > 10
      ? (item.rating / 10).toFixed(1)
      : item.rating.toFixed(1)
    : null;

  const handleLaunchTrailer = async () => {
    let targetUrl: string;
    if (trailerId) {
      targetUrl = `https://www.youtube.com/watch?v=${trailerId}`;
    } else {
      const query = encodeURIComponent(`${item.title} ${item.year ?? ""} official trailer`);
      targetUrl = `https://www.youtube.com/results?search_query=${query}`;
    }

    try {
      await invoke("open_external_url", { url: targetUrl });
    } catch {
      window.open(targetUrl, "_blank");
    }
  };

  const hasResume = progress && !progress.completed && progress.position > 15;

  return createPortal(
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
        {/* Backdrop overlay */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/85 backdrop-blur-md"
          onClick={onClose}
        />

        {/* Modal Window */}
        <motion.div
          role="dialog"
          aria-modal="true"
          data-tv-container="modal"
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ type: "spring", duration: 0.4, bounce: 0.1 }}
          className="relative w-full max-w-4xl max-h-[88vh] bg-surface border border-border/80 rounded-2xl shadow-2xl overflow-y-auto z-10 flex flex-col my-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            data-close-modal="true"
            aria-label="Close details"
            className="absolute top-4 right-4 z-30 w-9 h-9 rounded-full bg-black/70 hover:bg-black/90 text-white flex items-center justify-center transition-colors border border-white/10"
          >
            <X size={18} />
          </button>

          {/* Hero Banner with Backdrop and Quick Trailer Launcher */}
          <div className="relative w-full h-44 sm:h-56 md:h-64 bg-panel overflow-hidden flex-shrink-0">
            {backdropSrc && !backdropError ? (
              <img
                src={backdropSrc}
                alt=""
                className="w-full h-full object-cover object-top opacity-50 filter saturate-125"
                onError={() => setBackdropError(true)}
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-tr from-violet-950/80 via-panel to-slate-900/60" />
            )}
            {/* Gradients to blend into modal surface */}
            <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/60 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-surface/90 via-surface/30 to-transparent" />

            {/* Quick trailer badge on hero - video content only */}
            {isVideo && (
              <div className="absolute bottom-4 right-4 z-20">
                <button
                  onClick={handleLaunchTrailer}
                  disabled={loadingTrailer}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-black/80 hover:bg-red-600 text-white text-xs font-semibold backdrop-blur-md border border-white/20 transition-all shadow-lg group active:scale-95 disabled:opacity-50"
                  title="Open official trailer in default browser"
                >
                  {loadingTrailer ? (
                    <Loader2 size={15} className="animate-spin text-white" />
                  ) : (
                    <Film size={15} className="text-red-500 group-hover:text-white" />
                  )}
                  <span>{trailerId ? "Watch Official Trailer" : "Search Trailer"}</span>
                  <ExternalLink size={13} className="text-white/70 group-hover:text-white" />
                </button>
              </div>
            )}
          </div>

          {/* Details Content */}
          <div className="p-6 sm:p-8 -mt-16 sm:-mt-20 relative z-20 flex flex-col gap-6">
            {/* Top row: Poster + Title and Badges */}
            <div className="flex flex-col sm:flex-row gap-6 items-start">
              {/* Poster */}
              <div className="w-32 sm:w-44 flex-shrink-0 aspect-[2/3] rounded-xl overflow-hidden bg-panel border-2 border-border shadow-2xl">
                {posterSrc && !posterError ? (
                  <img
                    src={posterSrc}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      if (item.showPosterUrl && e.currentTarget.src !== item.showPosterUrl) {
                        e.currentTarget.src = item.showPosterUrl;
                      } else {
                        setPosterError(true);
                      }
                    }}
                  />
                ) : (
                  <div className="w-full h-full bg-panel flex items-center justify-center p-3 text-center text-xs text-subtle">
                    {item.title}
                  </div>
                )}
              </div>

              {/* Title & Metadata */}
              <div className="flex-1 flex flex-col gap-3 min-w-0">
                {item.showTitle && (
                  <p className="text-accent text-sm font-semibold tracking-wide uppercase">
                    {item.showTitle}
                  </p>
                )}
                <h1 className="text-2xl sm:text-3xl font-display font-bold text-text leading-tight">
                  {item.title}
                </h1>

                {/* Badges Row */}
                <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-subtle">
                  {ratingScore && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20">
                      <Star size={12} fill="currentColor" />
                      {ratingScore}
                    </span>
                  )}
                  {item.year && (
                    <span className="px-2 py-0.5 rounded-md bg-white/5 border border-border">
                      {item.year}
                    </span>
                  )}
                  {formatDuration(item.duration) && (
                    <span className="px-2 py-0.5 rounded-md bg-white/5 border border-border flex items-center gap-1">
                      <Clock size={11} />
                      {formatDuration(item.duration)}
                    </span>
                  )}
                  {item.season && item.episode && (
                    <span className="px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-400 border border-purple-500/20">
                      Season {item.season}, Ep {item.episode}
                    </span>
                  )}
                  {item.libraryType && (
                    <span className="px-2 py-0.5 rounded-md bg-white/5 border border-border capitalize">
                      {item.libraryType}
                    </span>
                  )}
                  {item.artist && (
                    <span className="px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20">
                      {item.artist}
                    </span>
                  )}
                  {item.author && (
                    <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      By {item.author}
                    </span>
                  )}
                </div>

                {/* Genres */}
                {item.genres && item.genres.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {item.genres.map((g) => (
                      <span
                        key={g}
                        className="px-2.5 py-0.5 rounded-full text-xs font-body bg-panel text-subtle border border-border"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                )}

                {/* Primary Action Buttons */}
                <div className="flex flex-wrap items-center gap-3 mt-3">
                  {item.remotePath ? (
                    <>
                      <button
                        data-tv-autofocus="true"
                        autoFocus
                        onClick={() => {
                          onClose();
                          onPlay(item, hasResume);
                        }}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent hover:bg-accent/90 text-void font-semibold text-sm transition-all shadow-md hover:shadow-accent/25 hover:scale-[1.02] focus:ring-2 focus:ring-accent focus:outline-none"
                      >
                        <Play size={16} fill="currentColor" />
                        {hasResume
                          ? (item.libraryType === "books"
                              ? "Resume Reading"
                              : item.libraryType === "music"
                              ? "Resume Album"
                              : `Resume (${formatTime(progress.position)})`)
                          : (item.libraryType === "books"
                              ? "Read Now"
                              : item.libraryType === "music"
                              ? "Play Album"
                              : "Play Now")}
                      </button>

                      {hasResume && (
                        <button
                          onClick={() => {
                            onClose();
                            onPlay(item, false);
                          }}
                          className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-panel hover:bg-muted text-subtle hover:text-text text-sm transition-colors border border-border focus:ring-2 focus:ring-accent focus:outline-none"
                        >
                          {item.libraryType === "books"
                            ? "Read from Beginning"
                            : item.libraryType === "music"
                            ? "Play from Start"
                            : "Start from Beginning"}
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      data-tv-autofocus="true"
                      autoFocus
                      onClick={() => setShowEasynewsSearch(true)}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent hover:bg-accent/90 text-void font-semibold text-sm transition-all shadow-md hover:shadow-accent/25 hover:scale-[1.02] focus:ring-2 focus:ring-accent focus:outline-none"
                      title="Search Usenet and stream this title immediately"
                    >
                      <Globe size={16} />
                      Search on Easynews
                    </button>
                  )}

                  {/* Trailer Button - video content only */}
                  {isVideo && (
                    <button
                      onClick={handleLaunchTrailer}
                      disabled={loadingTrailer}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-panel hover:bg-muted text-text text-sm font-medium transition-colors border border-border group"
                      title={trailerId ? "Watch official trailer in default browser" : "Search YouTube for trailer"}
                    >
                      {loadingTrailer ? (
                        <Loader2 size={15} className="animate-spin text-accent" />
                      ) : (
                        <Film size={15} className="text-red-500 group-hover:scale-110 transition-transform" />
                      )}
                      <span>{trailerId ? "Watch Trailer" : "Find Trailer"}</span>
                      <ExternalLink size={12} className="text-subtle group-hover:text-text" />
                    </button>
                  )}

                  {/* Stremio Community & Debrid Streams - video content only */}
                  {isVideo && (
                    <button
                      onClick={() => setShowStremioModal(true)}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-accent/10 hover:bg-accent/20 text-accent font-medium text-sm transition-colors border border-accent/40 group"
                      title="Search Stremio Addons & Multi-Tracker Debrid caches"
                    >
                      <Sparkles size={15} className="text-accent group-hover:scale-110 transition-transform" />
                      <span>Stremio Streams</span>
                    </button>
                  )}

                  {/* InfiniDysk Usenet Search & Stream - video content only */}
                  {isVideo && (
                    <button
                      onClick={() => setShowInfiniDyskModal(true)}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 font-medium text-sm transition-colors border border-cyan-500/30 group"
                      title="Search Usenet indexers (OMGWTFNZBs & NZBIndex) and stream via InfiniDysk WebDAV"
                    >
                      <Radio size={15} className="text-cyan-400 group-hover:scale-110 transition-transform" />
                      <span>InfiniDysk Usenet</span>
                    </button>
                  )}

                  {/* Favorite Button */}
                  <button
                    onClick={() => toggleFavorite(item.id)}
                    className={`flex items-center justify-center w-10 h-10 rounded-xl border transition-colors ${
                      isFavorite
                        ? "bg-rose-500/10 border-rose-500/30 text-rose-500 hover:bg-rose-500/20"
                        : "bg-panel border-border text-subtle hover:text-text hover:bg-muted"
                    }`}
                    title={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
                  >
                    <Heart size={16} className={isFavorite ? "fill-rose-500" : ""} />
                  </button>

                  {/* Add to Playlist */}
                  <button
                    onClick={() => setShowPlaylistModal(true)}
                    className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-subtle hover:text-text hover:bg-muted transition-colors"
                    title="Add to Playlist"
                  >
                    <ListPlus size={16} />
                  </button>

                  {/* Mark Watched Toggle */}
                  <button
                    onClick={() => {
                      const isComp = progress?.completed;
                      const nextState = toggleWatchCompleted(item.id, !isComp);
                      addToast(
                        nextState
                          ? `Marked "${item.title}" as watched`
                          : `Marked "${item.title}" as unwatched`,
                        "info"
                      );
                    }}
                    className={`flex items-center justify-center w-10 h-10 rounded-xl border transition-colors ${
                      progress?.completed
                        ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/25"
                        : "bg-panel border-border text-subtle hover:text-text hover:bg-muted"
                    }`}
                    title={progress?.completed ? "Watched (Click to mark unwatched)" : "Mark as Watched"}
                  >
                    <Check size={16} className={progress?.completed ? "text-emerald-400" : ""} />
                  </button>

                  {/* Download */}
                  <button
                    onClick={() => downloadSingleItem(item)}
                    disabled={isDownloading || isDownloaded}
                    className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-subtle hover:text-text hover:bg-muted transition-colors"
                    title={
                      isDownloaded
                        ? "Downloaded Locally"
                        : isDownloading
                        ? "Downloading..."
                        : "Download for Offline Playback"
                    }
                  >
                    {isDownloaded ? (
                      <Check size={16} className="text-emerald-400" />
                    ) : isDownloading ? (
                      <Loader2 size={16} className="animate-spin text-accent" />
                    ) : (
                      <Download size={16} />
                    )}
                  </button>

                  {/* Cloud Transcode */}
                  <button
                    onClick={() => setShowCloudTranscode(true)}
                    className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-accent hover:text-bright hover:bg-accent/20 hover:border-accent/40 transition-colors"
                    title="Cloud Transcode to AV1 (Kaggle)"
                  >
                    <Zap size={16} />
                  </button>

                  {/* Audiobook M4B Converter */}
                  {(item.libraryType === "audiobooks" ||
                    item.filename.toLowerCase().endsWith(".mp3") ||
                    item.filename.toLowerCase().endsWith(".m4b") ||
                    item.filename.toLowerCase().endsWith(".m4a")) && (
                    <button
                      onClick={() => setShowAudiobookConvert(true)}
                      className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-accent hover:text-bright hover:bg-accent/20 hover:border-accent/40 transition-colors"
                      title="Convert / Chapterize to M4B"
                    >
                      <BookOpen size={16} />
                    </button>
                  )}

                  {/* DropMB Cloud Offload / Cached Badge (Music, Audiobooks, Books, PDFs) */}
                  {!isGuest && (item.libraryType === "music" ||
                    item.libraryType === "audiobooks" ||
                    item.libraryType === "books" ||
                    item.filename.toLowerCase().endsWith(".epub") ||
                    item.filename.toLowerCase().endsWith(".pdf") ||
                    item.filename.toLowerCase().endsWith(".mobi") ||
                    item.filename.toLowerCase().endsWith(".azw3") ||
                    item.filename.toLowerCase().endsWith(".cbr") ||
                    item.filename.toLowerCase().endsWith(".cbz") ||
                    item.filename.toLowerCase().endsWith(".mp3") ||
                    item.filename.toLowerCase().endsWith(".flac") ||
                    item.filename.toLowerCase().endsWith(".m4a") ||
                    item.filename.toLowerCase().endsWith(".m4b") ||
                    item.filename.toLowerCase().endsWith(".ogg") ||
                    item.filename.toLowerCase().endsWith(".opus")) && (
                    item.versions?.some(
                      (v) =>
                        v.remoteName === "dropmb" ||
                        v.remotePath.toLowerCase().includes("dropmb.com")
                    ) ? (() => {
                      const dropmbVer = item.versions?.find(
                        (v) =>
                          v.remoteName === "dropmb" ||
                          v.remotePath.toLowerCase().includes("dropmb.com")
                      );
                      const exp = getDropmbExpirationStatus(dropmbVer?.expiresAt || item.dropmbExpiresAt);
                      if (exp.status === "warning") {
                        return (
                          <button
                            onClick={async () => {
                              setPushingToDropmb(true);
                              await offloadAudioItemToDropmb(item);
                              setPushingToDropmb(false);
                            }}
                            disabled={pushingToDropmb}
                            className="flex items-center gap-1.5 px-3 h-10 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-300 hover:bg-amber-500/25 transition-colors text-xs font-mono"
                            title={exp.tooltip}
                          >
                            <AlertCircle size={15} className="text-amber-400" />
                            <span>{exp.label} (Renew)</span>
                          </button>
                        );
                      }
                      if (exp.status === "expired") {
                        return (
                          <button
                            onClick={async () => {
                              setPushingToDropmb(true);
                              await offloadAudioItemToDropmb(item);
                              setPushingToDropmb(false);
                            }}
                            disabled={pushingToDropmb}
                            className="flex items-center gap-1.5 px-3 h-10 rounded-xl bg-danger/15 border border-danger/40 text-danger hover:bg-danger/25 transition-colors text-xs font-mono"
                            title={exp.tooltip}
                          >
                            <AlertCircle size={15} className="text-danger" />
                            <span>Expired (Re-offload)</span>
                          </button>
                        );
                      }
                      const dropmbUrl = dropmbVer?.remotePath || (isDropmbUrl(item.remotePath) ? item.remotePath : "");
                      const shareId = dropmbUrl ? extractDropmbShareId(dropmbUrl) : null;
                      const publicShareLink = shareId ? `https://dropmb.com/share/${shareId}` : null;

                      return (
                        <div className="flex items-center gap-1.5">
                          <div
                            className="flex items-center gap-1.5 px-3 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-xs font-mono cursor-default"
                            title={exp.tooltip}
                          >
                            <Check size={15} className="text-cyan-400" />
                            <span>{exp.label}</span>
                          </div>
                          {publicShareLink && (
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(publicShareLink);
                                useToastStore.getState().addToast("Copied DropMB public share link to clipboard!", "success");
                              }}
                              className="flex items-center gap-1.5 px-2.5 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20 hover:border-cyan-500/50 transition-colors text-xs font-mono"
                              title={`DropMB Public Share Link: ${publicShareLink} (Click to copy)`}
                            >
                              <Share2 size={14} />
                              <span className="hidden sm:inline">Share Link</span>
                            </button>
                          )}
                        </div>
                      );
                    })() : (
                      <button
                        onClick={async () => {
                          setPushingToDropmb(true);
                          await offloadAudioItemToDropmb(item);
                          setPushingToDropmb(false);
                        }}
                        disabled={pushingToDropmb}
                        className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10 hover:border-cyan-500/40 transition-colors disabled:opacity-50"
                        title={item.libraryType === "books"
                          ? "Offload Ebook to DropMB (100-Day Cloud Storage & On-Demand Download)"
                          : "Offload to DropMB (100-Day Cloud Streaming & Zero Local Storage)"}
                      >
                        {pushingToDropmb ? (
                          <Loader2 size={16} className="animate-spin text-cyan-400" />
                        ) : (
                          <Cloud size={16} />
                        )}
                      </button>
                    )
                  )}

                  {/* Real-Debrid Untouched 4K/1080p CDN Tier */}
                  {!isGuest && (item.libraryType === "movies" || item.libraryType === "tv") && debridConfig?.realDebridApiKey && (
                    item.versions?.some(
                      (v) =>
                        v.sourceType === "real-debrid" ||
                        v.remoteName === "real-debrid" ||
                        v.remotePath.toLowerCase().includes(".real-debrid.com")
                    ) ? (
                      <div
                        className="flex items-center gap-1.5 px-3 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-mono cursor-default shrink-0"
                        title="Cached on Real-Debrid CDN for untouched 4K/1080p streaming"
                      >
                        <Check size={15} className="text-emerald-400" />
                        <span>Real-Debrid 4K</span>
                      </div>
                    ) : (
                      <button
                        onClick={async () => {
                          setPushingToRd(true);
                          await seedItemToRealDebrid(item);
                          setPushingToRd(false);
                        }}
                        disabled={pushingToRd}
                        className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 hover:border-emerald-500/40 transition-colors disabled:opacity-50 shrink-0"
                        title="Seed untouched original video to Real-Debrid CDN via cloud worker"
                      >
                        {pushingToRd ? (
                          <Loader2 size={16} className="animate-spin text-emerald-400" />
                        ) : (
                          <CloudUpload size={16} />
                        )}
                      </button>
                    )
                  )}

                  {/* Telegram Serverless Tier 1 CDN (< 2 GB) */}
                  {!isGuest && (
                    hasTelegramVersion(item) ? (
                      <div
                        className="flex items-center gap-1.5 px-3 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-400 text-xs font-mono cursor-default shrink-0"
                        title="Cached on Telegram Serverless CDN (tg-serverless) for direct unauthenticated streaming"
                      >
                        <Check size={15} className="text-sky-400" />
                        <span>tg-serverless</span>
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
                        className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 hover:border-sky-500/40 transition-colors disabled:opacity-50 shrink-0"
                        title="Offload to Telegram Serverless CDN (< 2 GB, zero cloud remote API consumption)"
                      >
                        {pushingToTelegram ? (
                          <Loader2 size={16} className="animate-spin text-sky-400" />
                        ) : (
                          <CloudUpload size={16} />
                        )}
                      </button>
                    )
                  )}

                  {/* Fix Match */}
                  <button
                    onClick={() => setShowFixMatch(true)}
                    className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-subtle hover:text-text hover:bg-muted transition-colors"
                    title="Fix Incorrect Metadata Match"
                  >
                    <Wrench size={15} />
                  </button>

                  {((item.libraryType as string) === "adult" ||
                    libraries.find((l) => l.id === item.libraryId)?.type === "adult") && (
                    <button
                      onClick={() => setShowFingerprintModal(true)}
                      className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-accent hover:text-bright hover:bg-accent/20 hover:border-accent/40 transition-colors"
                      title="Identify by Fingerprint (OSHASH / Stash-Box)"
                    >
                      <Sparkles size={15} />
                    </button>
                  )}

                  {/* Search on Easynews */}
                  <button
                    onClick={() => setShowEasynewsSearch(true)}
                    className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-accent hover:text-bright hover:bg-accent/20 hover:border-accent/40 transition-colors"
                    title="Search Easynews Usenet for this title"
                  >
                    <Globe size={15} />
                  </button>

                  {/* Weekly Recommendation (Admin only) */}
                  {!isGuest && (
                    <button
                      onClick={() => setShowRecommendModal(true)}
                      className={`flex items-center justify-center w-10 h-10 rounded-xl border transition-colors cursor-pointer ${
                        isRecommended
                          ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                          : "bg-panel border-border text-subtle hover:text-amber-300 hover:border-amber-500/40"
                      }`}
                      title={isRecommended ? "Title is Recommended this week (Click to edit badge effect or remove)" : "Recommend title this week (Max 3/week)"}
                    >
                      <Star size={15} className={isRecommended ? "fill-amber-400 text-amber-400" : ""} />
                    </button>
                  )}

                  {/* View Full Series in TV Show Browser */}
                  {(item.libraryType === "tv" || item.showTitle || item.showId) && (
                    <button
                      onClick={() => {
                        onClose();
                        const targetId = item.showId || item.showTitle || item.title;
                        navigate(`/tv/show/${encodeURIComponent(targetId)}`);
                      }}
                      className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-accent hover:text-bright hover:bg-accent/20 hover:border-accent/40 transition-colors"
                      title="View all seasons & episodes in TV show browser"
                    >
                      <Tv size={15} />
                    </button>
                  )}

                  {/* Delete Bookmark / Remove from Library */}
                  <button
                    onClick={() => {
                      removeMediaItem(item.id);
                      onClose();
                      addToast(
                        item.isSourceBookmark
                          ? `Deleted stream bookmark "${item.title}"`
                          : `Removed "${item.title}" from library (cloud file retained)`,
                        "info"
                      );
                    }}
                    className="flex items-center justify-center w-10 h-10 rounded-xl bg-panel border border-border text-subtle hover:text-danger hover:border-danger/30 hover:bg-danger/10 transition-colors"
                    title={
                      item.isSourceBookmark
                        ? "Delete Stream Bookmark (0 MB)"
                        : "Remove from Library View (Cloud File Retained)"
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </div>

            {/* Synopsis / Description */}
            <div className="flex flex-col gap-2 pt-2 border-t border-border/60">
              <h2 className="text-sm font-semibold text-text uppercase tracking-wider">
                Synopsis
              </h2>
              {description ? (
                <p className="text-subtle font-body text-sm sm:text-base leading-relaxed whitespace-pre-line">
                  {description}
                </p>
              ) : (
                <p className="text-subtle/60 text-sm italic">
                  No overview available for this title.
                </p>
              )}
            </div>

            {/* File & Technical Details */}
            <div className="p-4 rounded-xl bg-panel/60 border border-border/50 flex flex-col gap-3 text-xs text-subtle">
              <div className="flex items-center justify-between font-semibold text-text">
                <div className="flex items-center gap-1.5">
                  <Info size={13} className="text-accent" />
                  <span>Media & Technical File Specs</span>
                </div>
                {tech.container && (
                  <span className="px-2 py-0.5 rounded bg-panel border border-border text-[10px] font-mono uppercase text-accent font-semibold">
                    {tech.container}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {tech.resolution && (
                  <div className="p-2 rounded-lg bg-surface/50 border border-border/40">
                    <span className="text-subtle/70 block text-[10px] uppercase font-mono">Resolution</span>
                    <span className="text-accent font-mono font-semibold">{tech.resolution}</span>
                  </div>
                )}
                {tech.videoCodec && (
                  <div className="p-2 rounded-lg bg-surface/50 border border-border/40">
                    <span className="text-subtle/70 block text-[10px] uppercase font-mono">Video Codec</span>
                    <span className="text-text font-mono font-medium">{tech.videoCodec}</span>
                  </div>
                )}
                {tech.audioCodec && (
                  <div className="p-2 rounded-lg bg-surface/50 border border-border/40">
                    <span className="text-subtle/70 block text-[10px] uppercase font-mono">Audio Codec</span>
                    <span className="text-text font-mono font-medium">{tech.audioCodec}</span>
                  </div>
                )}
                {tech.sizeFormatted && (
                  <div className="p-2 rounded-lg bg-surface/50 border border-border/40">
                    <span className="text-subtle/70 block text-[10px] uppercase font-mono">File Size</span>
                    <span className="text-text font-mono font-medium">{tech.sizeFormatted}</span>
                  </div>
                )}
                {tech.durationFormatted && (
                  <div className="p-2 rounded-lg bg-surface/50 border border-border/40">
                    <span className="text-subtle/70 block text-[10px] uppercase font-mono">Duration</span>
                    <span className="text-text font-mono font-medium">{tech.durationFormatted}</span>
                  </div>
                )}
                {item.metadataSource && (
                  <div className="p-2 rounded-lg bg-surface/50 border border-border/40">
                    <span className="text-subtle/70 block text-[10px] uppercase font-mono">Metadata Match</span>
                    <span className="text-text uppercase font-mono text-[11px] font-semibold">
                      {item.metadataSource} ({item.metadataConfidence || "auto"})
                    </span>
                  </div>
                )}
              </div>

              {/* Full File Path with 1-click Copy */}
              {tech.fullPath && (
                isGuest ? (
                  <div className="pt-2 border-t border-border/40 flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <span className="text-subtle/70 text-[10px] uppercase font-mono block">Media Source</span>
                      <p className="text-text font-mono text-xs truncate">
                        Cloud Fast Stream
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="pt-2 border-t border-border/40 flex items-center justify-between gap-2">
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
                        addToast("Copied full file path to clipboard", "success");
                        setTimeout(() => setCopiedPath(false), 2000);
                      }}
                      className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5 shrink-0"
                      title="Copy full remote path"
                    >
                      {copiedPath ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                      <span>{copiedPath ? "Copied" : "Copy Path"}</span>
                    </button>
                  </div>
                )
              )}

              {/* Offload Mirrors & Direct Links Panel */}
              {!isGuest && <OffloadMirrorsPanel item={item} />}
            </div>
          </div>
        </motion.div>

        {/* Sub-modals */}
        {showFixMatch && (
          <FixMatchModal item={item} onClose={() => setShowFixMatch(false)} />
        )}
        <AddToPlaylistModal
          isOpen={showPlaylistModal}
          onClose={() => setShowPlaylistModal(false)}
          items={[item]}
        />
        {showCloudTranscode && (
          <CloudTranscodeModal
            isOpen={true}
            onClose={() => setShowCloudTranscode(false)}
            sourceInput={item.remotePath}
            initialTitle={item.showTitle ? `${item.showTitle} S${String(item.season || 1).padStart(2, "0")}E${String(item.episode || 1).padStart(2, "0")}` : item.title}
            initialPoster={item.posterUrl || item.showPosterUrl}
            mediaType={item.libraryType}
          />
        )}
        {showAudiobookConvert && (
          <AudiobookConverterModal
            items={[item]}
            onClose={() => setShowAudiobookConvert(false)}
            onSuccess={() => {
              setShowAudiobookConvert(false);
            }}
          />
        )}
        <EasynewsSearchModal
          isOpen={showEasynewsSearch}
          onClose={() => setShowEasynewsSearch(false)}
          initialQuery={item.title || item.showTitle || ""}
        />
        <StremioStreamsModal
          isOpen={showStremioModal}
          onClose={() => setShowStremioModal(false)}
          item={item}
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

        {/* Admin Recommendation Modal - Solid UI Standard */}
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
                        addToast(`Removed recommendation for "${item.title}"`, "info");
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
                        addToast(`Updated badge effect to ${selectedEffect}!`, "success");
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
                        addToast(`Recommended "${item.title}" with ${selectedEffect} badge!`, "success");
                        setShowRecommendModal(false);
                      } else {
                        addToast(res.error || "Could not set recommendation", "error");
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
      {showFingerprintModal && (
        <FingerprintIdentifyModal item={item} onClose={() => setShowFingerprintModal(false)} />
      )}
      </div>
    </AnimatePresence>,
    document.body
  );
}
