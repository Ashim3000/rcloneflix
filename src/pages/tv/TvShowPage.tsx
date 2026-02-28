import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Star, Play, ChevronDown, ChevronUp } from "lucide-react";
import { useAppStore, type TvShow, type TvEpisode } from "../../store/appStore";

export function TvShowPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { watchProgress } = useAppStore();
  const show = location.state?.show as TvShow | undefined;

  const [expandedSeason, setExpandedSeason] = useState<number | null>(() => {
    if (!show) return null;
    const seasons = Object.keys(show.seasons).map(Number).sort((a, b) => a - b);
    return seasons[0] ?? null;
  });

  if (!show) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-subtle font-body">Show not found.</p>
      </div>
    );
  }

  const seasons = Object.values(show.seasons).sort((a, b) => a.seasonNumber - b.seasonNumber);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Backdrop hero */}
      <div className="relative h-64 flex-shrink-0">
        {show.backdropUrl ? (
          <img src={show.backdropUrl} alt={show.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-panel to-muted" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-void via-void/60 to-transparent" />

        {/* Back button */}
        <button
          onClick={() => navigate(-1)}
          className="absolute top-4 left-6 flex items-center gap-2 text-white/80 hover:text-white transition-colors"
        >
          <ArrowLeft size={20} />
          <span className="font-body text-sm">TV Shows</span>
        </button>

        {/* Show info overlay */}
        <div className="absolute bottom-4 left-6 right-6 flex items-end gap-4">
          {show.posterUrl && (
            <img
              src={show.posterUrl}
              alt={show.title}
              className="w-20 rounded-lg border border-border shadow-lg flex-shrink-0 -mb-8"
            />
          )}
          <div className="pb-1">
            <h1 className="font-display text-4xl text-white tracking-wide">{show.title.toUpperCase()}</h1>
            <div className="flex items-center gap-3 mt-1">
              {show.year && <span className="text-white/60 font-body text-sm">{show.year}</span>}
              {show.rating && (
                <span className="flex items-center gap-1 text-white/60 font-body text-sm">
                  <Star size={12} className="text-accent" fill="currentColor" />
                  {show.rating.toFixed(1)}
                </span>
              )}
              <span className="text-white/60 font-body text-sm">
                {seasons.length} Season{seasons.length !== 1 ? "s" : ""} · {show.episodeCount} Episodes
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Overview */}
      <div className={`px-6 ${show.posterUrl ? "pt-10" : "pt-4"} pb-4`}>
        {show.overview && (
          <p className="text-subtle font-body text-sm leading-relaxed max-w-2xl">{show.overview}</p>
        )}
      </div>

      {/* Seasons */}
      <div className="px-6 pb-12 space-y-3">
        {seasons.map((season) => (
          <div key={season.seasonNumber} className="bg-panel border border-border rounded-xl overflow-hidden">
            {/* Season header */}
            <button
              onClick={() => setExpandedSeason(
                expandedSeason === season.seasonNumber ? null : season.seasonNumber
              )}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-muted transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="font-body font-semibold text-bright text-sm">
                  {season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`}
                </span>
                <span className="text-subtle font-body text-xs">
                  {season.episodes.length} episode{season.episodes.length !== 1 ? "s" : ""}
                </span>
              </div>
              {expandedSeason === season.seasonNumber
                ? <ChevronUp size={16} className="text-subtle" />
                : <ChevronDown size={16} className="text-subtle" />}
            </button>

            {/* Episode list */}
            <AnimatePresence>
              {expandedSeason === season.seasonNumber && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden border-t border-border"
                >
                  {season.episodes.map((episode, i) => (
                    <EpisodeRow
                      key={episode.id}
                      episode={episode}
                      index={i}
                      progress={watchProgress[episode.id]}
                    />
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </div>
  );
}

function EpisodeRow({
  episode,
  index,
  progress,
}: {
  episode: TvEpisode;
  index: number;
  progress?: { position: number; duration: number; completed: boolean };
}) {
  const navigate = useNavigate();
  const pct = progress && progress.duration ? (progress.position / progress.duration) * 100 : 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: index * 0.03 }}
      className="flex items-start gap-4 px-5 py-4 hover:bg-muted transition-colors cursor-pointer border-b border-border/50 last:border-0 group"
      onClick={() => navigate("/play/video", { state: { item: episode, resumeAt: progress?.position } })}
    >
      {/* Thumbnail */}
      <div className="relative w-28 h-16 rounded-lg overflow-hidden bg-muted flex-shrink-0">
        {episode.thumbUrl ? (
          <img src={episode.thumbUrl} alt={episode.episodeTitle ?? ""} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-panel to-muted flex items-center justify-center">
            <Play size={20} className="text-subtle" />
          </div>
        )}
        {/* Progress bar */}
        {pct > 0 && !progress?.completed && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        )}
        {/* Play overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center transition-all">
          <div className="w-8 h-8 rounded-full bg-accent/90 items-center justify-center hidden group-hover:flex">
            <Play size={14} className="text-void ml-0.5" fill="currentColor" />
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-subtle font-body text-xs font-medium">
            E{String(episode.episode).padStart(2, "0")}
          </span>
          <span className="text-text font-body text-sm font-medium truncate">
            {episode.episodeTitle ?? episode.title}
          </span>
        </div>
        {episode.overview && (
          <p className="text-subtle font-body text-xs line-clamp-2 leading-relaxed">{episode.overview}</p>
        )}
        {progress && !progress.completed && pct > 0 && (
          <p className="text-accent font-body text-xs mt-1">
            Resume · {Math.round(pct)}% watched
          </p>
        )}
      </div>
    </motion.div>
  );
}
