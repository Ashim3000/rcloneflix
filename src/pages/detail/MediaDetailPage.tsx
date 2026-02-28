import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Play, Star, Clock, Calendar, Tag, Wrench } from "lucide-react";
import { useAppStore, type MediaItem } from "../../store/appStore";
import { FixMatchModal } from "../../components/library/FixMatchModal";
import { invoke } from "@tauri-apps/api/core";

export function MediaDetailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { watchProgress, libraries, rcloneConfigPath } = useAppStore();
  const item = location.state?.item as MediaItem | undefined;
  const [showFixMatch, setShowFixMatch] = useState(false);

  if (!item) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-subtle font-body">Item not found.</p>
      </div>
    );
  }

  const progress = watchProgress[item.id];
  const pct = progress?.duration ? (progress.position / progress.duration) * 100 : 0;

  const handlePlay = async () => {
    const ext = item.filename.split(".").pop()?.toLowerCase() ?? "";
    const library = libraries.find((l) => l.id === item.libraryId);

    if (ext === "epub") {
      navigate("/play/epub", { state: { item } });
    } else if (ext === "pdf") {
      navigate("/play/pdf", { state: { item } });
    } else if (["mp3","flac","aac","ogg","m4a","wav","opus","m4b"].includes(ext)) {
      if (library) {
        const relPath = item.remotePath.replace(library.remotePath.replace(/\/$/, "") + "/", "");
        try {
          const session = await invoke<{ file_url: string }>("start_stream_session", {
            configPath: rcloneConfigPath,
            remoteRoot: library.remotePath,
            filePath: relPath,
            sessionId: `audio-${item.id}`,
          });
          window.dispatchEvent(new CustomEvent("rcloneflix:play-audio", {
            detail: { item, streamUrl: session.file_url }
          }));
          navigate(-1);
        } catch (e) { console.error(e); }
      }
    } else {
      navigate("/play/video", { state: { item, resumeAt: progress?.position } });
    }
  };

  const formatDuration = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Backdrop */}
      <div className="relative h-72 flex-shrink-0">
        {item.backdropUrl || item.showBackdropUrl ? (
          <img
            src={item.backdropUrl ?? item.showBackdropUrl}
            alt={item.title}
            className="w-full h-full object-cover"
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
          {(item.posterUrl ?? item.showPosterUrl) && (
            <img
              src={item.posterUrl ?? item.showPosterUrl}
              alt={item.title}
              className="w-28 rounded-xl border border-border shadow-lg flex-shrink-0"
            />
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
        <div className="flex gap-3 mb-8">
          <motion.button
            onClick={handlePlay}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="btn-primary flex items-center gap-2 px-8 py-3"
          >
            <Play size={18} fill="currentColor" />
            {progress && !progress.completed && pct > 5 ? "Resume" : "Play"}
          </motion.button>

          <button
            onClick={() => setShowFixMatch(true)}
            className="btn-secondary flex items-center gap-2 px-4 py-3"
          >
            <Wrench size={16} />
            Fix Match
          </button>
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

        {/* File info */}
        <div className="bg-panel border border-border rounded-xl p-4">
          <h3 className="text-text font-body font-semibold text-xs uppercase tracking-wider mb-3">File Info</h3>
          <div className="space-y-2">
            <div className="flex gap-3">
              <span className="text-subtle font-body text-xs w-24 flex-shrink-0">Filename</span>
              <span className="text-text font-mono text-xs truncate">{item.filename}</span>
            </div>
            <div className="flex gap-3">
              <span className="text-subtle font-body text-xs w-24 flex-shrink-0">Path</span>
              <span className="text-text font-mono text-xs truncate">{item.remotePath}</span>
            </div>
            {item.metadataSource && (
              <div className="flex gap-3">
                <span className="text-subtle font-body text-xs w-24 flex-shrink-0">Metadata</span>
                <span className="text-text font-body text-xs capitalize">
                  {item.metadataSource} · {item.metadataConfidence ?? "unknown"} confidence
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {showFixMatch && <FixMatchModal item={item} onClose={() => setShowFixMatch(false)} />}
    </div>
  );
}
