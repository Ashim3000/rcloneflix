import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Search, SortAsc } from "lucide-react";
import { useAppStore, selectItemsByLibrary, selectInProgress, type LibraryType, type MediaItem } from "../store/appStore";
import { AdultPinLock } from "../components/adult/AdultPinLock";
import { MediaCard } from "../components/library/MediaCard";
import { MediaShelf } from "../components/library/MediaShelf";
import { ScanBar } from "../components/common/ScanBar";
import { scanLibrary } from "../lib/scanner";

type SortKey = "addedAt" | "title" | "year" | "rating";

type Props = {
  libraryType: LibraryType;
};

export function LibraryPage({ libraryType }: Props) {
  const navigate = useNavigate();
  const {
    libraries, mediaItems, watchProgress, adultSettings,
    tmdbApiKey, thePornDbApiKey,
  } = useAppStore();

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("addedAt");

  // Find the library matching this page's type
  const library = libraries.find((l) => l.type === libraryType);

  const isAdult = libraryType === "adult";
  const pinLocked = isAdult && adultSettings.pinEnabled && !adultSettings.unlocked;

  const allItems = useMemo(() => {
    if (!library) return [];
    return selectItemsByLibrary(mediaItems, library.id);
  }, [mediaItems, library]);

  const inProgress = useMemo(() => {
    if (!library) return [];
    return selectInProgress(mediaItems, watchProgress).filter((i) => i.libraryId === library.id);
  }, [mediaItems, watchProgress, library]);

  const filtered = useMemo(() => {
    let items = [...allItems];
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter((i) => i.title.toLowerCase().includes(q));
    }
    items.sort((a, b) => {
      switch (sort) {
        case "title": return a.title.localeCompare(b.title);
        case "year": return (b.year ?? 0) - (a.year ?? 0);
        case "rating": return (b.rating ?? 0) - (a.rating ?? 0);
        default: return b.addedAt - a.addedAt;
      }
    });
    return items;
  }, [allItems, search, sort]);

  const handleItemClick = (item: MediaItem) => {
    navigate("/detail", { state: { item } });
  };

  if (pinLocked) {
    return <AdultPinLock />;
  }

  const displayName = library?.name ?? libraryType.charAt(0).toUpperCase() + libraryType.slice(1);

  return (
    <div className="flex flex-col h-full">
      <ScanBar libraryId={library?.id} />
      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="px-8 pt-8 pb-4 flex items-end justify-between">
          <div>
            <h1 className="font-display text-5xl text-bright tracking-wide">{displayName.toUpperCase()}</h1>
            <p className="text-subtle font-body text-sm mt-1">
              {allItems.length} {allItems.length === 1 ? "item" : "items"}
              {library && (
                <span className="ml-2 font-mono text-xs">
                  · {library.remotePaths.length === 1 ? library.remotePaths[0] : `${library.remotePaths.length} folders`}
                </span>
              )}
            </p>
          </div>
          {library && (
            <button
              onClick={() => scanLibrary(library, { tmdb: tmdbApiKey, theporndb: thePornDbApiKey })}
              className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
            >
              Scan Library
            </button>
          )}
        </div>

        {/* No library configured */}
        {!library && (
          <div className="px-8 py-16 text-center">
            <p className="text-subtle font-body text-sm mb-3">
              No {libraryType} library configured yet.
            </p>
            <button onClick={() => navigate("/settings")} className="btn-secondary text-sm">
              Add in Settings →
            </button>
          </div>
        )}

        {library && (
          <>
            {/* Continue Watching */}
            {inProgress.length > 0 && (
              <div className="mb-4">
                <MediaShelf
                  title="Continue Watching"
                  items={inProgress}
                  progressMap={watchProgress}
                  showProgress
                  onItemClick={handleItemClick}
                />
              </div>
            )}

            {/* Search + Sort */}
            <div className="px-8 mb-5 flex items-center gap-3">
              <div className="relative flex-1 max-w-xs">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
                <input
                  type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search..." className="input-field pl-9 py-2 text-sm"
                />
              </div>
              <div className="relative">
                <SortAsc size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
                <select
                  value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
                  className="input-field pl-9 py-2 text-sm appearance-none pr-8"
                >
                  <option value="addedAt">Recently Added</option>
                  <option value="title">Title</option>
                  <option value="year">Year</option>
                  <option value="rating">Rating</option>
                </select>
              </div>
            </div>

            {/* Grid */}
            {filtered.length === 0 ? (
              <div className="px-8 py-12 text-center">
                <p className="text-subtle font-body text-sm">
                  {search
                    ? `No results for "${search}"`
                    : "No items yet. Run a scan to populate this library."}
                </p>
              </div>
            ) : (
              <div
                className="px-8 grid gap-5 pb-12"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
              >
                {filtered.map((item, i) => (
                  <MediaCard
                    key={item.id}
                    item={item}
                    progress={watchProgress[item.id]}
                    index={i}
                    onPlay={() => handleItemClick(item)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
