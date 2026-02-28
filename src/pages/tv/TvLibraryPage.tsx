import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Search } from "lucide-react";
import { useAppStore, selectTvShows, type TvShow } from "../../store/appStore";
import { ScanBar } from "../../components/common/ScanBar";
import { MediaShelf } from "../../components/library/MediaShelf";
import { selectInProgress } from "../../store/appStore";

export function TvLibraryPage() {
  const { libraries, mediaItems, watchProgress } = useAppStore();
  const [search, setSearch] = useState("");
  const navigate = useNavigate();

  const library = libraries.find((l) => l.type === "tv");

  const shows = useMemo(() => {
    if (!library) return [];
    return selectTvShows(mediaItems, library.id);
  }, [mediaItems, library]);

  const filtered = useMemo(() => {
    if (!search.trim()) return shows;
    const q = search.toLowerCase();
    return shows.filter((s) => s.title.toLowerCase().includes(q));
  }, [shows, search]);

  // Continue watching - TV episodes only
  const inProgress = useMemo(() => {
    if (!library) return [];
    return selectInProgress(mediaItems, watchProgress)
      .filter((i) => i.libraryId === library.id);
  }, [mediaItems, watchProgress, library]);

  return (
    <div className="flex flex-col h-full">
      <ScanBar libraryId={library?.id} />
      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="px-8 pt-8 pb-4 flex items-end justify-between">
          <div>
            <h1 className="font-display text-5xl text-bright tracking-wide">TV SHOWS</h1>
            <p className="text-subtle font-body text-sm mt-1">
              {shows.length} series · {Object.keys(mediaItems).filter(id => mediaItems[id].libraryType === "tv").length} episodes
            </p>
          </div>
          <ScanBar libraryId={library?.id} compact />
        </div>

        {/* Continue Watching */}
        {inProgress.length > 0 && (
          <div className="mb-6">
            <MediaShelf
              title="Continue Watching"
              items={inProgress}
              progressMap={watchProgress}
              showProgress
            />
          </div>
        )}

        {/* Search */}
        <div className="px-8 mb-6">
          <div className="relative max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search shows..."
              className="input-field pl-9 py-2 text-sm"
            />
          </div>
        </div>

        {/* Shows grid */}
        {filtered.length === 0 ? (
          <div className="px-8 py-16 text-center">
            <p className="text-subtle font-body text-sm">
              {search ? `No shows matching "${search}"` : "No TV shows yet. Run a scan to populate this library."}
            </p>
          </div>
        ) : (
          <div
            className="px-8 grid gap-5 pb-12"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
          >
            {filtered.map((show, i) => (
              <ShowCard
                key={show.showId}
                show={show}
                index={i}
                onClick={() => navigate(`/tv/show/${encodeURIComponent(show.showId)}`, { state: { show } })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ShowCard({ show, index, onClick }: { show: TvShow; index: number; onClick: () => void }) {
  const [imgError, setImgError] = useState(false);
  const COLORS = [
    "from-blue-900 to-blue-800", "from-purple-900 to-purple-800",
    "from-green-900 to-green-800", "from-orange-900 to-orange-800",
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.5) }}
      className="flex flex-col gap-2 cursor-pointer group"
      onClick={onClick}
    >
      <div className="relative rounded-xl overflow-hidden aspect-[2/3] bg-panel border border-border
        hover:border-muted hover:scale-[1.03] hover:shadow-card-hover transition-all duration-300">
        {show.posterUrl && !imgError ? (
          <img
            src={show.posterUrl}
            alt={show.title}
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
            loading="lazy"
          />
        ) : (
          <div className={`w-full h-full bg-gradient-to-br ${COLORS[index % COLORS.length]} flex items-center justify-center p-3`}>
            <span className="text-white/60 font-display text-center text-sm leading-tight">{show.title}</span>
          </div>
        )}
        {/* Episode count badge */}
        <div className="absolute bottom-2 right-2 bg-black/70 rounded px-1.5 py-0.5">
          <span className="text-white/80 text-xs font-body">
            {Object.keys(show.seasons).length}S · {show.episodeCount}E
          </span>
        </div>
      </div>
      <div className="px-0.5">
        <p className="text-text font-body text-sm font-medium truncate">{show.title}</p>
        <p className="text-subtle font-body text-xs">{show.year}</p>
      </div>
    </motion.div>
  );
}
