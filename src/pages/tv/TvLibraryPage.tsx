import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Search, RefreshCw, Sparkles, SortAsc, MoreVertical, Wrench, Tv, Info } from "lucide-react";
import { useAppStore, selectTvShows, type TvShow } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { ScanBar } from "../../components/common/ScanBar";
import { ExpiredPassBanner } from "../../components/accessPass/ExpiredPassBanner";
import { MediaShelf } from "../../components/library/MediaShelf";
import { scanLibrary, refreshLibraryMetadata } from "../../lib/scanner";
import { selectInProgress } from "../../store/appStore";
import { FixMatchModal } from "../../components/library/FixMatchModal";

type TvSortKey = "addedAt" | "year" | "title" | "rating";

export function TvLibraryPage() {
  const { libraries, mediaItems, watchProgress, scanState, tmdbApiKey, thePornDbApiKey } =
    useAppStore();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<TvSortKey>(() => {
    return (localStorage.getItem("rcloneflix_sort_tv") as TvSortKey) || "addedAt";
  });
  const navigate = useNavigate();

  const handleSortChange = (newSort: TvSortKey) => {
    setSort(newSort);
    localStorage.setItem("rcloneflix_sort_tv", newSort);
  };

  const tvLibraries = useMemo(
    () => libraries.filter((l) => l.type === "tv"),
    [libraries]
  );
  const library = tvLibraries[0];

  const shows = useMemo(() => {
    const tvLibIds = new Set(tvLibraries.map((l) => l.id));
    const tvItems = Object.fromEntries(
      Object.entries(mediaItems).filter(([_, item]) => tvLibIds.has(item.libraryId))
    );
    return selectTvShows(tvItems);
  }, [mediaItems, tvLibraries]);

  const showAddedAtMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of shows) {
      let maxAdded = 0;
      for (const season of Object.values(s.seasons)) {
        for (const ep of season.episodes) {
          if (ep.addedAt > maxAdded) maxAdded = ep.addedAt;
        }
      }
      map.set(s.showId, maxAdded);
    }
    return map;
  }, [shows]);

  const filtered = useMemo(() => {
    let list = shows;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((s) => s.title.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      switch (sort) {
        case "title":
          return a.title.localeCompare(b.title);
        case "year":
          return (b.year ?? 0) - (a.year ?? 0);
        case "rating":
          return (b.rating ?? 0) - (a.rating ?? 0);
        case "addedAt":
        default:
          return (showAddedAtMap.get(b.showId) ?? 0) - (showAddedAtMap.get(a.showId) ?? 0);
      }
    });
  }, [shows, search, sort, showAddedAtMap]);

  // Continue watching - TV episodes only
  const inProgress = useMemo(() => {
    const libIds = new Set(tvLibraries.map((l) => l.id));
    return selectInProgress(mediaItems, watchProgress)
      .filter((i) => libIds.has(i.libraryId));
  }, [mediaItems, watchProgress, tvLibraries]);

  return (
    <div className="flex flex-col h-full">
      <ScanBar libraryId={library?.id} />
      <ExpiredPassBanner />
      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="px-8 pt-8 pb-4 flex items-end justify-between">
          <div>
            <h1 className="font-display text-5xl text-bright tracking-wide">TV SHOWS</h1>
            <p className="text-subtle font-body text-sm mt-1">
              {shows.length} series · {Object.keys(mediaItems).filter(id => mediaItems[id].libraryType === "tv").length} episodes
            </p>
          </div>
          {tvLibraries.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  for (const lib of tvLibraries) {
                    await refreshLibraryMetadata(
                      lib,
                      { tmdb: tmdbApiKey, theporndb: thePornDbApiKey },
                      true
                    );
                  }
                }}
                disabled={scanState.status === "scanning"}
                title="Re-fetch TV metadata and artwork for all episodes"
                className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 disabled:opacity-50"
              >
                <Sparkles
                  size={13}
                  className={scanState.status === "scanning" ? "animate-spin text-accent" : "text-accent"}
                />
                Refresh Metadata
              </button>

              <button
                onClick={async () => {
                  for (const lib of tvLibraries) {
                    await scanLibrary(lib, { tmdb: tmdbApiKey, theporndb: thePornDbApiKey });
                  }
                }}
                disabled={scanState.status === "scanning"}
                className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 disabled:opacity-50"
              >
                <RefreshCw
                  size={13}
                  className={scanState.status === "scanning" ? "animate-spin" : ""}
                />
                {scanState.status === "scanning" ? "Scanning…" : "Scan Library"}
              </button>
            </div>
          )}
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

        {/* Search & Sort */}
        <div className="px-8 mb-6 flex items-center gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search shows..."
              className="input-field pl-9 py-2 text-sm"
            />
          </div>
          <div className="relative">
            <SortAsc
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle pointer-events-none"
            />
            <select
              value={sort}
              onChange={(e) => handleSortChange(e.target.value as TvSortKey)}
              className="input-field pl-9 py-2 text-sm appearance-none pr-8 cursor-pointer"
            >
              <option value="addedAt">Recently Added</option>
              <option value="year">Recently Released</option>
              <option value="title">Title (A → Z)</option>
              <option value="rating">Highest Rated</option>
            </select>
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
  const navigate = useNavigate();
  const [imgError, setImgError] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showFixMatch, setShowFixMatch] = useState(false);
  const COLORS = [
    "from-blue-900 to-blue-800", "from-purple-900 to-purple-800",
    "from-green-900 to-green-800", "from-orange-900 to-orange-800",
  ];

  const repEpisode = useMemo(() => {
    for (const season of Object.values(show.seasons)) {
      if (season.episodes.length > 0) return season.episodes[0];
    }
    return null;
  }, [show]);

  const repItem = useMemo(() => {
    if (!repEpisode) return null;
    return {
      ...repEpisode,
      title: show.title,
      showTitle: show.title,
      posterUrl: show.posterUrl || repEpisode.posterUrl,
      backdropUrl: show.backdropUrl || repEpisode.backdropUrl,
      overview: show.overview || repEpisode.overview,
      year: show.year || repEpisode.year,
    };
  }, [repEpisode, show]);

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: Math.min(index * 0.03, 0.5) }}
        tabIndex={0}
        role="button"
        aria-label={`${show.title}. Press Enter to view episodes.`}
        className="media-card flex flex-col gap-2 cursor-pointer group focus:outline-none focus:scale-105 focus:ring-4 focus:ring-accent rounded-xl"
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
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

          {/* 3-dots Menu Button */}
          <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-20" tabIndex={-1} data-tv-skip="true">
            <button
              type="button"
              tabIndex={-1}
              data-tv-skip="true"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(!menuOpen);
              }}
              className="w-7 h-7 rounded-lg bg-black/70 hover:bg-black/90 flex items-center justify-center text-white/80 hover:text-white transition-all shadow-md backdrop-blur-sm"
              title="Show Options"
            >
              <MoreVertical size={14} />
            </button>
          </div>

          {/* Menu Dropdown */}
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.1 }}
                className="absolute top-10 right-2 w-44 bg-surface/95 backdrop-blur-md border border-border rounded-xl shadow-xl z-30 py-1 overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onClick();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-body text-text hover:bg-panel transition-colors text-left"
                >
                  <Tv size={13} className="text-accent" />
                  <span>View Episodes</span>
                </button>

                {repItem && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      navigate("/detail", { state: { item: repItem } });
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-body text-text hover:bg-panel transition-colors text-left"
                  >
                    <Info size={13} className="text-accent" />
                    <span>Show Details</span>
                  </button>
                )}

                {repItem && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      setShowFixMatch(true);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-body text-text hover:bg-panel transition-colors text-left"
                  >
                    <Wrench size={13} className="text-subtle" />
                    <span>Fix Match</span>
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Episode count badge */}
          <div className="absolute bottom-2 right-2 bg-black/70 rounded px-1.5 py-0.5 pointer-events-none">
            <span className="text-white/80 text-xs font-body">
              {Object.keys(show.seasons).length}S · {show.episodeCount}E
            </span>
          </div>
        </div>
        <div className="px-0.5">
          <p className="text-text font-body text-sm font-medium truncate">{show.title}</p>
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
            {show.year && <span className="text-subtle font-body text-xs">{show.year}</span>}
            {repItem?.resolution && (
              <span className="px-1 py-0.2 rounded bg-accent/15 border border-accent/30 text-[9px] font-mono text-accent font-semibold">
                {repItem.resolution}
              </span>
            )}
            {repItem?.container && (
              <span className="px-1 py-0.2 rounded bg-panel border border-border/80 text-[9px] font-mono uppercase text-subtle font-medium">
                {repItem.container}
              </span>
            )}
            {repItem?.videoCodec && (
              <span className="px-1 py-0.2 rounded bg-panel border border-border/80 text-[9px] font-mono text-subtle">
                {repItem.videoCodec}
              </span>
            )}
          </div>
          {repEpisode?.remotePath && (
            <p
              className="text-[10px] font-mono text-subtle/60 hover:text-white truncate mt-0.5 transition-colors cursor-copy"
              title={`File Path: ${repEpisode.remotePath} (Click to copy)`}
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(repEpisode.remotePath);
                useToastStore.getState().addToast("Copied file path to clipboard", "success");
              }}
            >
              {repEpisode.remotePath.split("/").slice(-2).join("/")}
            </p>
          )}
        </div>
      </motion.div>

      {showFixMatch && repItem && (
        <FixMatchModal
          item={repItem}
          onClose={() => setShowFixMatch(false)}
        />
      )}
    </>
  );
}
