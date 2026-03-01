import { memo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Play, MoreVertical, Wrench, CheckCircle2, Clock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAppStore, type MediaItem, type WatchProgress } from "../../store/appStore";

type Props = {
  item: MediaItem;
  progress?: WatchProgress;
  onPlay?: (item: MediaItem) => void;
  onFixMatch?: (item: MediaItem) => void;
  index?: number;
};

const PLACEHOLDER_COLORS = [
  "from-blue-900 to-blue-800",
  "from-purple-900 to-purple-800",
  "from-green-900 to-green-800",
  "from-orange-900 to-orange-800",
  "from-pink-900 to-pink-800",
  "from-teal-900 to-teal-800",
];

function ProgressBar({ progress }: { progress: WatchProgress }) {
  const pct = Math.min(100, (progress.position / progress.duration) * 100);
  return (
    <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
      <div
        className="h-full bg-accent transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export const MediaCard = memo(function MediaCard({ item, progress, onPlay, onFixMatch, index = 0 }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const colorClass = PLACEHOLDER_COLORS[index % PLACEHOLDER_COLORS.length];
  const isLowConfidence = item.metadataConfidence === "low";
  const navigate = useNavigate();
  // Scoped selectors so this card only re-renders when these specific
  // values change — not on every unrelated store update (scan progress,
  // other items' watch progress, adult unlock, etc.)
  // Determine play route based on file extension and library type
  const handlePlay = (mediaItem: MediaItem) => {
    if (onPlay) { onPlay(mediaItem); return; }

    const ext = mediaItem.filename.split(".").pop()?.toLowerCase() ?? "";

    if (ext === "epub") {
      navigate("/play/epub", { state: { item: mediaItem } });
    } else if (ext === "pdf") {
      navigate("/play/pdf", { state: { item: mediaItem } });
    } else if (["mp3","flac","aac","ogg","m4a","wav","opus","m4b"].includes(ext)) {
      window.dispatchEvent(new CustomEvent("rcloneflix:play-audio", {
        detail: { playlist: [mediaItem], playlistIndex: 0 },
      }));
    } else {
      navigate("/play/video", { state: { item: mediaItem, resumeAt: progress?.position } });
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
        className="relative rounded-xl overflow-hidden aspect-[2/3] cursor-pointer bg-panel border border-border hover:border-muted transition-all duration-300 hover:shadow-card-hover hover:scale-[1.03]"
        onClick={() => handlePlay(item)}
      >
        {item.posterUrl && !imgError ? (
          <img
            src={item.posterUrl}
            alt={item.title}
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
            loading="lazy"
          />
        ) : (
          <div className={`w-full h-full bg-gradient-to-br ${colorClass} flex items-center justify-center p-3`}>
            <span className="text-white/60 font-display text-center text-sm leading-tight line-clamp-4">
              {item.title}
            </span>
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-300 flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            whileHover={{ opacity: 1, scale: 1 }}
            className="w-12 h-12 rounded-full bg-accent/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200"
          >
            <Play size={20} className="text-void ml-1" fill="currentColor" />
          </motion.div>
        </div>

        {/* Progress bar */}
        {progress && !progress.completed && <ProgressBar progress={progress} />}

        {/* Completed badge */}
        {progress?.completed && (
          <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-teal flex items-center justify-center">
            <CheckCircle2 size={14} className="text-void" />
          </div>
        )}

        {/* Low confidence badge */}
        {isLowConfidence && (
          <div className="absolute top-2 left-2 bg-black/70 rounded px-1.5 py-0.5">
            <span className="text-yellow-400 text-xs font-body">?</span>
          </div>
        )}

        {/* Context menu button */}
        <button
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
                className="absolute top-10 right-2 z-20 bg-panel border border-border rounded-xl shadow-card-hover overflow-hidden min-w-[160px]"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => { handlePlay(item); setMenuOpen(false); }}
                  className="flex items-center gap-2.5 w-full px-4 py-3 text-text hover:bg-muted text-sm font-body transition-colors"
                >
                  <Play size={14} />
                  Play
                </button>
                {progress && !progress.completed && (
                  <button
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2.5 w-full px-4 py-3 text-text hover:bg-muted text-sm font-body transition-colors"
                  >
                    <Clock size={14} />
                    Resume ({formatTime(progress.position)})
                  </button>
                )}
                <div className="border-t border-border" />
                <button
                  onClick={() => { onFixMatch?.(item); setMenuOpen(false); }}
                  className="flex items-center gap-2.5 w-full px-4 py-3 text-subtle hover:text-text hover:bg-muted text-sm font-body transition-colors"
                >
                  <Wrench size={14} />
                  Fix incorrect match
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* Title + meta */}
      <div className="px-0.5">
        <p className="text-text font-body text-sm font-medium truncate leading-tight">
          {item.title}
        </p>
        <p className="text-subtle font-body text-xs mt-0.5">
          {item.year && <span>{item.year}</span>}
          {item.season && item.episode && (
            <span>
              {item.year ? " · " : ""}S{String(item.season).padStart(2, "0")}E
              {String(item.episode).padStart(2, "0")}
            </span>
          )}
          {item.artist && <span>{item.artist}</span>}
          {item.author && <span>{item.author}</span>}
        </p>
      </div>
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
