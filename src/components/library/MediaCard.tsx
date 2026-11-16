import { memo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Play, MoreVertical, Wrench, CheckCircle2, Clock, Heart, ListPlus, Info, Star, Film, Globe, Trash2, Zap, BookOpen, Copy, Check } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAppStore, isItemFavorited, findAlbumAndTracksForTrack, type MediaItem, type WatchProgress } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { FixMatchModal } from "./FixMatchModal";
import { AddToPlaylistModal } from "../playlist/AddToPlaylistModal";
import { MediaDetailsModal } from "./MediaDetailsModal";
import { CloudTranscodeModal } from "./CloudTranscodeModal";
import { AudiobookConverterModal } from "../audiobooks/AudiobookConverterModal";
import { AUDIO_EXTENSIONS } from "../../lib/mediaTypes";
import { useArtwork } from "../../lib/artwork";
import { RecommendationBadge } from "./RecommendationBadge";

type Props = {
  item: MediaItem;
  progress?: WatchProgress;
  onPlay?: (item: MediaItem) => void;
  onFixMatch?: (item: MediaItem) => void;
  onClick?: (item: MediaItem) => void;
  index?: number;
  groupTracks?: MediaItem[];
};

const PLACEHOLDER_COLORS = [
  "from-violet-900 to-purple-900",
  "from-blue-900 to-indigo-900",
  "from-emerald-900 to-teal-900",
  "from-amber-900 to-orange-900",
  "from-rose-900 to-pink-900",
  "from-cyan-900 to-blue-900",
];

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function getItemMediaSpecs(item: MediaItem) {
  const container = item.container || item.filename?.split(".").pop()?.toUpperCase() || "";
  let resolution = item.resolution;
  if (!resolution && item.filename) {
    const fn = item.filename.toLowerCase();
    if (fn.includes("2160p") || fn.includes("4k") || fn.includes("uhd")) resolution = "4K";
    else if (fn.includes("1080p") || fn.includes("1080i") || fn.includes("fhd")) resolution = "1080p";
    else if (fn.includes("720p") || fn.includes("hd")) resolution = "720p";
    else if (fn.includes("480p") || fn.includes("576p") || fn.includes("sd")) resolution = "480p";
  }
  let codec = item.videoCodec;
  if (!codec && item.filename) {
    const fn = item.filename.toLowerCase();
    if (fn.includes("x265") || fn.includes("h265") || fn.includes("hevc")) codec = "HEVC";
    else if (fn.includes("x264") || fn.includes("h264") || fn.includes("avc")) codec = "H.264";
    else if (fn.includes("av1")) codec = "AV1";
    else if (fn.includes("vp9")) codec = "VP9";
  }
  const size = formatFileSize(item.sizeBytes);
  const duration = item.duration && item.duration > 0 ? formatTime(item.duration) : undefined;
  return { container, resolution, codec, size, duration };
}

function ProgressBar({ progress }: { progress: WatchProgress }) {
  if (!progress.duration || progress.duration === 0) return null;
  const pct = Math.min(100, Math.round((progress.position / progress.duration) * 100));
  if (pct <= 0) return null;
  return (
    <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60 overflow-hidden">
      <div
        className="h-full rounded-full bg-gradient-to-r from-accent-dim to-accent shadow-[0_0_6px_rgba(var(--color-accent-glow),0.8)] transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export const MediaCard = memo(function MediaCard({ item, progress, onPlay, onFixMatch, onClick, index = 0, groupTracks }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [showFixMatch, setShowFixMatch] = useState(false);
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showCloudTranscode, setShowCloudTranscode] = useState(false);
  const [showAudiobookConvert, setShowAudiobookConvert] = useState(false);
  const mediaItems = useAppStore((s) => s.mediaItems);
  const isFavorite = useAppStore((s) => isItemFavorited(item, s.favorites, s.mediaItems));
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const toggleWatchCompleted = useAppStore((s) => s.toggleWatchCompleted);
  const removeMediaItem = useAppStore((s) => s.removeMediaItem);
  const addToast = useToastStore((s) => s.addToast);
  const colorClass = PLACEHOLDER_COLORS[index % PLACEHOLDER_COLORS.length];
  const isLowConfidence = item.metadataConfidence === "low";
  const navigate = useNavigate();
  const posterSrc = useArtwork(item.showPosterUrl || item.posterUrl) || undefined;
  const { container, resolution, codec, size, duration } = getItemMediaSpecs(item);

  const handleCardClick = () => {
    if (onClick) {
      onClick(item);
      return;
    }

    if (item.groupType === "show" || (item.libraryType === "tv" && item.season === undefined)) {
      const targetShowId = item.showId || item.metadataId || item.showTitle || item.title;
      navigate(`/tv/show/${encodeURIComponent(targetShowId)}`, {
        state: { item },
      });
      return;
    }

    const ext = item.filename?.split(".").pop()?.toLowerCase() ?? "";
    if (item.libraryType === "music" || item.groupType === "album" || (AUDIO_EXTENSIONS.includes(ext) && item.libraryType !== "audiobooks")) {
      navigate("/music", {
        state: {
          artistName: item.artist,
          albumName: item.album,
          trackId: item.id,
        },
      });
      return;
    }

    setShowDetails(true);
  };

  const ratingScore = item.rating
    ? item.rating > 10
      ? (item.rating / 10).toFixed(1)
      : item.rating.toFixed(1)
    : null;

  // Callers may supply their own handler; otherwise the card owns the modal so
  // the menu entry is never a dead end.
  const openFixMatch = (mediaItem: MediaItem) => {
    if (onFixMatch) onFixMatch(mediaItem);
    else setShowFixMatch(true);
  };

  // Determine play route based on file extension and library type
  const handlePlay = (mediaItem: MediaItem, resume: boolean = true) => {
    if (onPlay) { onPlay(mediaItem); return; }

    const ext = mediaItem.filename.split(".").pop()?.toLowerCase() ?? "";

    if (ext === "epub") {
      navigate("/play/epub", { state: { item: mediaItem } });
    } else if (ext === "pdf") {
      navigate("/play/pdf", { state: { item: mediaItem } });
    } else if (ext === "cbz" || ext === "cbr" || ext === "cb7" || ext === "cbt" || mediaItem.libraryType === "comics") {
      navigate("/play/comic", { state: { item: mediaItem } });
    } else if (AUDIO_EXTENSIONS.includes(ext) || mediaItem.libraryType === "music") {
      const albumInfo = findAlbumAndTracksForTrack(mediaItems, mediaItem);
      const playlist = albumInfo?.tracks && albumInfo.tracks.length > 0 ? albumInfo.tracks : [mediaItem];
      const playlistIndex = albumInfo ? albumInfo.trackIndex : 0;
      window.dispatchEvent(new CustomEvent("rcloneflix:play-audio", {
        detail: { playlist, playlistIndex },
      }));
    } else {
      navigate("/play/video", {
        state: {
          item: mediaItem,
          resumeAt: resume ? progress?.position : 0,
        },
      });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.5), duration: 0.35 }}
      className="group relative flex flex-col gap-2"
    >
      {/* Poster */}
      <div
        tabIndex={0}
        role="button"
        aria-label={`${item.title}. Press Enter to view details or play.`}
        className="media-card shelf-item group/poster relative rounded-xl overflow-hidden aspect-[2/3] cursor-pointer bg-panel border border-border hover:border-muted transition-all duration-300 hover:shadow-card-hover hover:scale-[1.03] focus:outline-none focus:scale-105 focus:ring-4 focus:ring-accent focus:border-accent z-0 focus:z-20"
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleCardClick();
          }
        }}
      >
        {posterSrc && !imgError ? (
          <img
            src={posterSrc}
            alt={item.title}
            className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover/poster:scale-[1.06] group-focus/poster:scale-[1.06]"
            onError={(e) => {
              if (item.showPosterUrl && e.currentTarget.src !== item.showPosterUrl) {
                e.currentTarget.src = item.showPosterUrl;
              } else if (item.posterUrl && e.currentTarget.src !== item.posterUrl) {
                e.currentTarget.src = item.posterUrl;
              } else {
                setImgError(true);
              }
            }}
            loading="lazy"
          />
        ) : (
          <div className={`w-full h-full bg-gradient-to-br ${colorClass} flex items-center justify-center p-3`}>
            <span className="text-white/60 font-display text-center text-sm leading-tight line-clamp-4">
              {item.showTitle ? `${item.showTitle}` : item.title}
            </span>
          </div>
        )}

        {/* Hover overlay with Quick Play and Details buttons */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/45 group-focus/poster:bg-black/45 transition-all duration-300 flex items-center justify-center pointer-events-none">
          {/* Quick Play in center */}
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            whileHover={{ opacity: 1, scale: 1.08 }}
            onClick={(e) => {
              e.stopPropagation();
              handlePlay(item);
            }}
            className="w-12 h-12 rounded-full bg-accent/90 hover:bg-accent flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus/poster:opacity-100 transition-all duration-200 shadow-xl cursor-pointer pointer-events-auto"
            title={item.libraryType === "books" ? "Read Now" : "Quick Play"}
          >
            <Play size={20} className="text-void ml-1" fill="currentColor" />
          </motion.div>

          {/* Quick Mark Watched toggle button on hover */}
          <button
            tabIndex={-1}
            data-tv-skip="true"
            onClick={(e) => {
              e.stopPropagation();
              const isComp = progress?.completed;
              const nextState = toggleWatchCompleted(item.id, !isComp);
              addToast(
                nextState
                  ? `Marked "${item.title}" as watched`
                  : `Marked "${item.title}" as unwatched`,
                "info"
              );
            }}
            className={`absolute bottom-3 left-3 px-2 py-1 rounded-lg text-xs font-medium flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm border pointer-events-auto ${
              progress?.completed
                ? "bg-emerald-950/80 hover:bg-emerald-900 border-emerald-500/40 text-emerald-400"
                : "bg-black/80 hover:bg-black border-white/10 text-white/90 hover:text-emerald-400"
            }`}
            title={progress?.completed ? "Mark Unwatched" : "Mark as Watched"}
          >
            <Check size={12} className={progress?.completed ? "text-emerald-400" : "text-subtle"} />
            <span>{progress?.completed ? "Watched" : "Mark Watched"}</span>
          </button>

          {/* Quick Info button at bottom-right on hover */}
          <button
            tabIndex={-1}
            data-tv-skip="true"
            onClick={(e) => {
              e.stopPropagation();
              setShowDetails(true);
            }}
            className="absolute bottom-3 right-3 px-2 py-1 rounded-lg bg-black/80 hover:bg-black text-white/90 text-xs font-medium flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm border border-white/10 pointer-events-auto"
            title="Details & Trailer"
          >
            <Info size={13} className="text-accent" />
            <span>Details</span>
          </button>
        </div>

        {/* Rating badge */}
        {ratingScore && (
          <div className="absolute bottom-2 left-2 z-10 px-1.5 py-0.5 rounded-md bg-black/75 backdrop-blur-sm flex items-center gap-1 text-amber-400 text-[11px] font-semibold border border-amber-500/20">
            <Star size={10} fill="currentColor" />
            <span>{ratingScore}</span>
          </div>
        )}

        {/* Progress bar */}
        {progress && !progress.completed && <ProgressBar progress={progress} />}

        {/* Completed badge */}
        {progress?.completed && (
          <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-teal flex items-center justify-center">
            <CheckCircle2 size={14} className="text-void" />
          </div>
        )}

        {/* Weekly Recommendation Badge */}
        {item.recommendationBadge && (
          <div className="absolute top-2 left-2 z-20">
            <RecommendationBadge
              text={item.recommendationBadge.text}
              effect={item.recommendationBadge.effect}
              note={item.recommendationBadge.note}
            />
          </div>
        )}

        {/* In Library badge */}
        {(item.inLibrary || item.badge === "In Library") && !item.recommendationBadge && (
          <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-md bg-emerald-600/90 text-white text-[10px] font-bold tracking-wider shadow-md uppercase flex items-center gap-1 border border-emerald-400/40 backdrop-blur-sm">
            <CheckCircle2 size={11} className="text-emerald-200" />
            <span>In Library</span>
          </div>
        )}

        {/* Group / Status badge (e.g. "8 New Episodes", "12 Tracks", "15 Chapters") */}
        {item.badge && item.badge !== "In Library" && !item.inLibrary && !item.isSourceBookmark && !item.recommendationBadge && (
          <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-md bg-accent text-void text-[10px] font-bold tracking-wider shadow-md uppercase">
            {item.badge}
          </div>
        )}

        {/* Web Stream Bookmark badge */}
        {item.isSourceBookmark && !item.recommendationBadge && (
          <div className="absolute top-2 left-2 z-10 px-1.5 py-0.5 rounded-md bg-blue-600/90 backdrop-blur-sm border border-blue-400/30 flex items-center gap-1 text-white text-[10px] font-bold tracking-wider uppercase shadow-md">
            <Globe size={10} className="text-blue-200" />
            <span>STREAM</span>
          </div>
        )}

        {/* Low confidence badge */}
        {isLowConfidence && !isFavorite && !item.isSourceBookmark && !item.badge && !item.recommendationBadge && (
          <div className="absolute top-2 left-2 bg-black/70 rounded px-1.5 py-0.5">
            <span className="text-yellow-400 text-xs font-body">?</span>
          </div>
        )}

        {/* Favorite indicator badge */}
        {isFavorite && !item.badge && !item.recommendationBadge && (
          <div className="absolute top-2 left-2 z-10 w-6 h-6 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center text-rose-500 border border-rose-500/30">
            <Heart size={12} className="fill-rose-500" />
          </div>
        )}

        {/* Quick delete stream bookmark button on hover */}
        {item.isSourceBookmark && (
          <button
            tabIndex={-1}
            data-tv-skip="true"
            onClick={(e) => {
              e.stopPropagation();
              removeMediaItem(item.id);
              addToast(`Deleted stream bookmark "${item.title}"`, "info");
            }}
            title="Delete Stream Bookmark (0 MB)"
            className="absolute top-2 right-10 w-7 h-7 rounded-lg bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-danger text-white z-10"
          >
            <Trash2 size={13} />
          </button>
        )}

        {/* Context menu button */}
        <button
          tabIndex={-1}
          data-tv-skip="true"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((s) => !s); }}
          className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
        >
          <MoreVertical size={14} className="text-white" />
        </button>

        {/* Context menu */}
        <AnimatePresence>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.9, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -4 }}
                className="absolute top-10 right-2 z-20 bg-panel border border-border rounded-xl shadow-card-hover overflow-hidden min-w-[180px]"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => { setShowDetails(true); setMenuOpen(false); }}
                  className="flex items-center gap-2.5 w-full px-4 py-2.5 text-text hover:bg-muted text-sm font-body transition-colors"
                >
                  <Info size={14} className="text-accent" />
                  Details & Trailer
                </button>
                <button
                  onClick={() => { handlePlay(item); setMenuOpen(false); }}
                  className="flex items-center gap-2.5 w-full px-4 py-2.5 text-text hover:bg-muted text-sm font-body transition-colors"
                >
                  <Play size={14} />
                  {item.libraryType === "books" ? "Read Now" : "Play"}
                </button>
                {progress && !progress.completed && (
                  <button
                    onClick={() => { handlePlay(item); setMenuOpen(false); }}
                    className="flex items-center gap-2.5 w-full px-4 py-2.5 text-text hover:bg-muted text-sm font-body transition-colors"
                  >
                    <Clock size={14} />
                    {item.libraryType === "books" ? "Resume Reading" : `Resume (${formatTime(progress.position)})`}
                  </button>
                )}
                <div className="border-t border-border" />
                <button
                  onClick={() => {
                    toggleFavorite(item.id);
                    setMenuOpen(false);
                  }}
                  className="flex items-center gap-2.5 w-full px-4 py-2.5 text-text hover:bg-muted text-sm font-body transition-colors"
                >
                  <Heart
                    size={14}
                    className={isFavorite ? "fill-rose-500 text-rose-500" : "text-subtle"}
                  />
                  {isFavorite ? "Remove Favorite" : "Favorite"}
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setShowPlaylistModal(true);
                  }}
                  className="flex items-center gap-2.5 w-full px-4 py-2.5 text-text hover:bg-muted text-sm font-body transition-colors"
                >
                  <ListPlus size={14} className="text-subtle" />
                  Add to Playlist
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    const isComp = progress?.completed;
                    const nextState = toggleWatchCompleted(item.id, !isComp);
                    addToast(
                      nextState
                        ? `Marked "${item.title}" as watched`
                        : `Marked "${item.title}" as unwatched`,
                      "info"
                    );
                  }}
                  className="flex items-center gap-2.5 w-full px-4 py-2.5 text-text hover:bg-muted text-sm font-body transition-colors"
                >
                  <Check
                    size={14}
                    className={progress?.completed ? "text-emerald-400" : "text-subtle"}
                  />
                  <span>{progress?.completed ? "Mark as Unwatched" : "Mark as Watched"}</span>
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setShowCloudTranscode(true);
                  }}
                  className="flex items-center gap-2.5 w-full px-4 py-2.5 text-accent hover:bg-muted text-sm font-body transition-colors"
                >
                  <Zap size={14} />
                  Cloud Transcode (AV1)
                </button>
                {(item.libraryType === "audiobooks" ||
                  item.filename.toLowerCase().endsWith(".mp3") ||
                  item.filename.toLowerCase().endsWith(".m4b") ||
                  item.filename.toLowerCase().endsWith(".m4a")) && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setShowAudiobookConvert(true);
                    }}
                    className="flex items-center gap-2.5 w-full px-4 py-2.5 text-accent hover:bg-muted text-sm font-body transition-colors"
                  >
                    <BookOpen size={14} />
                    Convert / Chapterize M4B
                  </button>
                )}
                <div className="border-t border-border" />
                <button
                  onClick={() => { setMenuOpen(false); openFixMatch(item); }}
                  className="flex items-center gap-2.5 w-full px-4 py-2.5 text-subtle hover:text-text hover:bg-muted text-sm font-body transition-colors"
                >
                  <Wrench size={14} />
                  Fix incorrect match
                </button>
                <div className="border-t border-border" />
                <button
                  onClick={() => {
                    removeMediaItem(item.id);
                    setMenuOpen(false);
                    addToast(
                      item.isSourceBookmark
                        ? `Deleted bookmark "${item.title}"`
                        : `Removed "${item.title}" from library (cloud file retained)`,
                      "info"
                    );
                  }}
                  className="flex items-center gap-2.5 w-full px-4 py-2.5 text-danger hover:bg-danger/10 text-sm font-body transition-colors"
                  title={
                    item.isSourceBookmark
                      ? "Delete Stream Bookmark (0 MB)"
                      : "Remove from Library View (Cloud File Retained)"
                  }
                >
                  <Trash2 size={14} />
                  <span>{item.isSourceBookmark ? "Delete Bookmark (0 MB)" : "Remove from Library"}</span>
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      <AddToPlaylistModal
        isOpen={showPlaylistModal}
        onClose={() => setShowPlaylistModal(false)}
        items={[item]}
      />

      {/* Details & Trailer Modal */}
      <MediaDetailsModal
        item={item}
        isOpen={showDetails}
        onClose={() => setShowDetails(false)}
        onPlay={(it, res) => handlePlay(it, res)}
        progress={progress}
      />

      {/* Title + meta */}
      <div
        className="px-0.5 cursor-pointer"
        onClick={handleCardClick}
      >
        {item.groupType === "show" ? (
          <>
            <p
              className="text-text font-body text-sm font-medium truncate leading-tight hover:text-accent transition-colors"
              title={item.showTitle || item.title}
            >
              {item.showTitle || item.title}
            </p>
            <p className="text-subtle font-body text-xs mt-0.5 truncate flex items-center gap-1.5">
              {item.year && <span>{item.year}</span>}
              {item.year && item.subtitle && <span>·</span>}
              {item.subtitle && <span>{item.subtitle}</span>}
            </p>
          </>
        ) : item.libraryType === "tv" || item.season != null ? (
          <>
            <p
              className="text-text font-body text-sm font-medium truncate leading-tight hover:text-accent transition-colors"
              title={`${item.showTitle || item.title}${item.episodeTitle ? ` - ${item.episodeTitle}` : ""}`}
            >
              {item.showTitle || item.title}
            </p>
            <p className="text-subtle font-body text-xs mt-0.5 truncate flex items-center gap-1">
              {item.season != null && item.episode != null && (
                <span className="text-accent/90 font-semibold shrink-0">
                  S{String(item.season).padStart(2, "0")}E{String(item.episode).padStart(2, "0")}
                </span>
              )}
              <span className="truncate">
                {item.season != null && item.episode != null ? "· " : ""}
                {item.episodeTitle || (item.showTitle && item.title !== item.showTitle ? item.title : "")}
              </span>
            </p>
          </>
        ) : (
          <>
            <p
              className="text-text font-body text-sm font-medium truncate leading-tight hover:text-accent transition-colors"
              title={item.title}
            >
              {item.title}
            </p>
            <p className="text-subtle font-body text-xs mt-0.5 truncate">
              {item.subtitle ? (
                <span>{item.subtitle}{item.year ? ` · ${item.year}` : ""}</span>
              ) : (
                <>
                  {item.year && <span>{item.year}</span>}
                  {item.season && item.episode && (
                    <span>
                      {item.year ? " · " : ""}S{String(item.season).padStart(2, "0")}E
                      {String(item.episode).padStart(2, "0")}
                    </span>
                  )}
                  {item.artist && <span>{item.artist}</span>}
                  {item.author && <span>{item.author}</span>}
                </>
              )}
            </p>
          </>
        )}

        {/* Media Technical Info Badges */}
        {(container || resolution || codec || size || duration) && (
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {resolution && (
              <span className="px-1.5 py-0.5 rounded bg-accent/15 border border-accent/30 text-[9px] font-mono text-accent font-semibold leading-tight">
                {resolution}
              </span>
            )}
            {container && (
              <span className="px-1.5 py-0.5 rounded bg-panel border border-border/80 text-[9px] font-mono uppercase text-subtle font-medium leading-tight">
                {container}
              </span>
            )}
            {codec && (
              <span className="px-1.5 py-0.5 rounded bg-panel border border-border/80 text-[9px] font-mono text-subtle leading-tight">
                {codec}
              </span>
            )}
            {size && (
              <span className="px-1.5 py-0.5 rounded bg-panel border border-border/80 text-[9px] font-mono text-subtle leading-tight">
                {size}
              </span>
            )}
            {duration && (
              <span className="px-1.5 py-0.5 rounded bg-panel border border-border/80 text-[9px] font-mono text-subtle leading-tight">
                {duration}
              </span>
            )}
          </div>
        )}

        {/* Cloud file path tooltip / preview on hover */}
        {item.remotePath && (
          <p
            className="text-[10px] font-mono text-subtle/60 hover:text-white truncate mt-0.5 transition-colors cursor-copy"
            title={`Full Path: ${item.remotePath} (Click to copy)`}
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(item.remotePath);
              addToast("Copied file path to clipboard", "success");
            }}
          >
            {item.remotePath.split("/").pop() || item.filename}
          </p>
        )}
      </div>

      {showFixMatch && (
        <FixMatchModal item={item} onClose={() => setShowFixMatch(false)} />
      )}

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
          items={groupTracks && groupTracks.length > 0 ? groupTracks : [item]}
          onClose={() => setShowAudiobookConvert(false)}
          onSuccess={(out) => {
            setShowAudiobookConvert(false);
            addToast(`Saved audiobook M4B to ${out}`, "success");
          }}
        />
      )}
    </motion.div>
  );
});

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
