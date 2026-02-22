import { useState, useMemo } from "react";
import { useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Search, SortAsc } from "lucide-react";
import {
  useAppStore,
  selectItemsByLibrary,
  selectInProgress,
  type MediaItem,
  type LibraryType,
} from "../store/appStore";
import { MediaCard } from "../components/library/MediaCard";
import { FixMatchModal } from "../components/library/FixMatchModal";
import { MediaShelf } from "../components/library/MediaShelf";
import { ScanBar } from "../components/common/ScanBar";
import { AdultPinLock } from "../components/adult/AdultPinLock";

type SortOption = "recently-added" | "title" | "year" | "rating";

const SORT_LABELS: Record<SortOption, string> = {
  "recently-added": "Recently Added",
  title: "Title",
  year: "Year",
  rating: "Rating",
};

export function LibraryPage() {
  const { type } = useParams<{ type: string }>();
  const libraryType = type as LibraryType;

  const { libraries, mediaItems, watchProgress, adultSettings } = useAppStore();

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>("recently-added");
  const [fixingItem, setFixingItem] = useState<MediaItem | null>(null);
  const [pinUnlocked, setPinUnlocked] = useState(false);

  // Find the library config for this type
  const library = libraries.find((l) => l.type === libraryType);

  // Adult PIN gate
  const needsPin =
    libraryType === "adult" &&
    adultSettings.pinEnabled &&
    !adultSettings.unlocked &&
    !pinUnlocked;

  // Get all items for this library
  const allItems = useMemo(() => {
    if (!library) return [];
    return selectItemsByLibrary(mediaItems, library.id);
  }, [mediaItems, library]);

  // Continue watching items for this library
  const inProgress = useMemo(() => {
    if (!library) return [];
    return selectInProgress(mediaItems, watchProgress).filter(
      (i) => i.libraryId === library.id
    );
  }, [mediaItems, watchProgress, library]);

  // Filter + sort
  const displayItems = useMemo(() => {
    let items = [...allItems];

    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.artist?.toLowerCase().includes(q) ||
          i.author?.toLowerCase().includes(q) ||
          i.showTitle?.toLowerCase().includes(q)
      );
    }

    switch (sort) {
      case "title":
        items.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "year":
        items.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
        break;
      case "rating":
        items.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
        break;
      default:
        items.sort((a, b) => b.addedAt - a.addedAt);
    }

    return items;
  }, [allItems, search, sort]);

  const title = library?.name ?? (type ? type.charAt(0).toUpperCase() + type.slice(1) : "Library");

  if (needsPin) {
    return <AdultPinLock onUnlocked={() => setPinUnlocked(true)} />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Scan bar with per-library scan */}
      <ScanBar libraryId={library?.id} />

      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="px-8 pt-8 pb-4 flex items-end justify-between gap-4"
        >
          <div>
            <h1 className="font-display text-5xl text-bright tracking-wide">
              {title.toUpperCase()}
            </h1>
            <p className="text-subtle font-body text-sm mt-1">
              {allItems.length} item{allItems.length !== 1 ? "s" : ""}
              {library && (
                <span className="font-mono ml-2 text-xs">· {library.remotePath}</span>
              )}
            </p>
          </div>

          {/* Scan button */}
          {library && (
            <ScanBar libraryId={library.id} compact />
          )}
        </motion.div>

        {/* Continue Watching for this library */}
        {inProgress.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6"
          >
            <MediaShelf
              title="Continue Watching"
              items={inProgress}
              progressMap={watchProgress}
              showProgress
            />
          </motion.div>
        )}

        {/* Search + Sort controls */}
        <div className="px-8 mb-6 flex items-center gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}...`}
              className="input-field pl-9 py-2 text-sm"
            />
          </div>

          <div className="flex items-center gap-2">
            <SortAsc size={14} className="text-subtle" />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortOption)}
              className="bg-panel border border-border rounded-lg px-3 py-2 text-text text-sm font-body outline-none focus:border-accent transition-colors"
            >
              {(Object.keys(SORT_LABELS) as SortOption[]).map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Grid */}
        {displayItems.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="px-8 py-16 text-center"
          >
            <p className="text-subtle font-body text-sm">
              {search
                ? `No results for "${search}"`
                : allItems.length === 0
                ? "No items yet. Run a scan to populate this library."
                : "No items match your search."}
            </p>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="px-8 grid gap-5 pb-12"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            }}
          >
            <AnimatePresence>
              {displayItems.map((item, i) => (
                <MediaCard
                  key={item.id}
                  item={item}
                  progress={watchProgress[item.id]}
                  onFixMatch={setFixingItem}
                  index={i}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>

      {/* Fix Match modal */}
      <AnimatePresence>
        {fixingItem && (
          <FixMatchModal item={fixingItem} onClose={() => setFixingItem(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
