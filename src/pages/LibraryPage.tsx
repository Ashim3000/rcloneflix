import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Search, SortAsc, BookOpen, Sparkles, RefreshCw, Heart, Globe, Plus } from "lucide-react";
import { AddStreamBookmarkModal } from "../components/library/AddStreamBookmarkModal";
import {
  useAppStore,
  selectItemsByLibrary,
  selectInProgress,
  selectAudiobooks,
  deduplicateMediaItems,
  isItemFavorited,
  type LibraryType,
  type MediaItem,
} from "../store/appStore";
import { AdultPinLock } from "../components/adult/AdultPinLock";
import { VirtualMediaGrid } from "../components/library/VirtualMediaGrid";
import { MediaShelf } from "../components/library/MediaShelf";
import { ScanBar } from "../components/common/ScanBar";
import { ExpiredPassBanner } from "../components/accessPass/ExpiredPassBanner";
import { scanLibrary, refreshLibraryMetadata } from "../lib/scanner";
import { AUDIO_EXTENSIONS } from "../lib/mediaTypes";
import { AudiobookConverterModal } from "../components/audiobooks/AudiobookConverterModal";
import { refreshSimklDiscovery } from "../lib/simkl";
import { annotateWithLibraryMatch, resolveDiscoveryCardNavigation } from "../lib/discoveryMatching";

type SortKey = "addedAt" | "title" | "year" | "rating";

type Props = {
  libraryType: LibraryType;
};

export function LibraryPage({ libraryType }: Props) {
  const navigate = useNavigate();
  const [showAudiobookConverter, setShowAudiobookConverter] = useState(false);
  const [selectedBookForConvert, setSelectedBookForConvert] = useState<MediaItem[]>([]);
  const {
    libraries,
    mediaItems,
    watchProgress,
    adultSettings,
    tmdbApiKey,
    thePornDbApiKey,
    scanState,
    favorites,
    simklSettings: rawSimklSettings,
    traktSettings: rawTraktSettings,
  } = useAppStore();

  const simklSettings = rawSimklSettings || rawTraktSettings;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>(() => {
    return (localStorage.getItem(`rcloneflix_sort_${libraryType}`) as SortKey) || "addedAt";
  });

  const handleSortChange = (newSort: SortKey) => {
    setSort(newSort);
    localStorage.setItem(`rcloneflix_sort_${libraryType}`, newSort);
  };
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [showAddBookmarkModal, setShowAddBookmarkModal] = useState(false);

  useEffect(() => {
    if (libraryType === "movies" || libraryType === "tv") {
      const needsFetch =
        (libraryType === "movies" && (!simklSettings?.trendingMovies || simklSettings.trendingMovies.length === 0)) ||
        (libraryType === "tv" && (!simklSettings?.trendingShows || simklSettings.trendingShows.length === 0));

      refreshSimklDiscovery(needsFetch);
    }
  }, [simklSettings?.clientId, libraryType]);

  const annotatedTrendingMovies = useMemo(
    () => annotateWithLibraryMatch(simklSettings?.trendingMovies, mediaItems),
    [simklSettings?.trendingMovies, mediaItems]
  );
  const annotatedTrendingShows = useMemo(
    () => annotateWithLibraryMatch(simklSettings?.trendingShows, mediaItems),
    [simklSettings?.trendingShows, mediaItems]
  );

  const matchingLibraries = useMemo(
    () => libraries.filter((l) => l.type === libraryType),
    [libraries, libraryType]
  );

  const [sourceFilter, setSourceFilter] = useState<"all" | "native" | "external" | "shared">("all");

  const hasExtLibs = useMemo(
    () => matchingLibraries.some((l) => l.id.startsWith("plex-") || l.id.startsWith("jellyfin-")),
    [matchingLibraries]
  );
  const hasSharedLibs = useMemo(
    () =>
      matchingLibraries.some(
        (l) => Boolean(l.isSharedPass) && !l.id.startsWith("plex-") && !l.id.startsWith("jellyfin-")
      ),
    [matchingLibraries]
  );
  const hasNativeLibs = useMemo(
    () =>
      matchingLibraries.some(
        (l) => !l.isSharedPass && !l.id.startsWith("plex-") && !l.id.startsWith("jellyfin-")
      ),
    [matchingLibraries]
  );

  const activeLibs = useMemo(() => {
    return matchingLibraries.filter((lib) => {
      const isExt = lib.id.startsWith("plex-") || lib.id.startsWith("jellyfin-");
      if (sourceFilter === "external") return isExt;
      if (sourceFilter === "shared") return Boolean(lib.isSharedPass) && !isExt;
      if (sourceFilter === "native") return !isExt && !lib.isSharedPass;
      return true;
    });
  }, [matchingLibraries, sourceFilter]);

  const isAdult = libraryType === "adult";
  const pinLocked = isAdult && adultSettings.pinEnabled && !adultSettings.unlocked;

  const isBookLibrary = libraryType === "audiobooks" || libraryType === "books";

  // Books and audiobooks show one card per book, but a book is often many
  // files. Keep the group's tracks alongside the card so playing it can queue
  // the whole thing instead of just the first chapter.
  const { allItems, tracksByCardId } = useMemo(() => {
    const items: MediaItem[] = [];
    const tracks = new Map<string, MediaItem[]>();
    if (activeLibs.length === 0) return { allItems: items, tracksByCardId: tracks };

    for (const lib of activeLibs) {
      if (isBookLibrary) {
        for (const g of selectAudiobooks(mediaItems, lib.id)) {
          const first = g.tracks[0];
          if (!first) continue;
          items.push({
            ...first,
            id: g.id,
            title: g.title,
            author: g.author,
            posterUrl: g.posterUrl || first.posterUrl,
            overview: g.overview || first.overview,
            year: g.year || first.year,
          });
          tracks.set(g.id, g.tracks);
        }
      } else {
        items.push(...selectItemsByLibrary(mediaItems, lib.id));
      }
    }
    return { allItems: deduplicateMediaItems(items), tracksByCardId: tracks };
  }, [mediaItems, activeLibs, isBookLibrary]);

  /** Play a card: for a grouped book, queue every chapter in order. */
  const handleCardPlay = useCallback(
    (card: MediaItem) => {
      const group = tracksByCardId.get(card.id);
      const playlist = group && group.length > 0 ? group : [card];
      const ext = playlist[0].filename.split(".").pop()?.toLowerCase() ?? "";

      if (ext === "epub") {
        navigate("/play/epub", { state: { item: playlist[0] } });
      } else if (ext === "pdf") {
        navigate("/play/pdf", { state: { item: playlist[0] } });
      } else if (ext === "cbz" || ext === "cbr" || ext === "cb7" || ext === "cbt" || playlist[0].libraryType === "comics") {
        navigate("/play/comic", { state: { item: playlist[0] } });
      } else if (AUDIO_EXTENSIONS.includes(ext)) {
        window.dispatchEvent(
          new CustomEvent("rcloneflix:play-audio", {
            detail: { playlist, playlistIndex: 0 },
          })
        );
      } else {
        navigate("/play/video", {
          state: { item: playlist[0], resumeAt: watchProgress[playlist[0].id]?.position },
        });
      }
    },
    [tracksByCardId, navigate, watchProgress]
  );

  const inProgress = useMemo(() => {
    if (matchingLibraries.length === 0) return [];
    const libIds = new Set(matchingLibraries.map((l) => l.id));
    return selectInProgress(mediaItems, watchProgress).filter((i) =>
      libIds.has(i.libraryId)
    );
  }, [mediaItems, watchProgress, matchingLibraries]);

  const filtered = useMemo(() => {
    let items = [...allItems];
    if (onlyFavorites) {
      items = items.filter((i) => isItemFavorited(i, favorites, mediaItems));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.author?.toLowerCase().includes(q)
      );
    }
    items.sort((a, b) => {
      switch (sort) {
        case "title":
          return a.title.localeCompare(b.title);
        case "year":
          return (b.year ?? 0) - (a.year ?? 0);
        case "rating":
          return (b.rating ?? 0) - (a.rating ?? 0);
        default:
          return b.addedAt - a.addedAt;
      }
    });
    return items;
  }, [allItems, search, sort, onlyFavorites, favorites]);

  const handleItemClick = (item: MediaItem) => {
    navigate("/detail", { state: { item } });
  };

  const handleScanAllTypeLibraries = async () => {
    for (const lib of matchingLibraries) {
      await scanLibrary(lib, {
        tmdb: tmdbApiKey,
        theporndb: thePornDbApiKey,
      });
    }
  };

  const handleRefreshAllMetadata = async () => {
    for (const lib of matchingLibraries) {
      await refreshLibraryMetadata(
        lib,
        {
          tmdb: tmdbApiKey,
          theporndb: thePornDbApiKey,
        },
        true
      );
    }
  };

  if (pinLocked) {
    return <AdultPinLock />;
  }

  const displayName =
    matchingLibraries[0]?.name ??
    libraryType.charAt(0).toUpperCase() + libraryType.slice(1);

  return (
    <div className="flex flex-col h-full">
      <ScanBar libraryId={matchingLibraries[0]?.id} />
      <ExpiredPassBanner />
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="px-8 pt-8 pb-4 flex items-end justify-between">
          <div>
            <h1 className="font-display text-5xl text-bright tracking-wide">
              {displayName.toUpperCase()}
            </h1>
            <p className="text-subtle font-body text-sm mt-1">
              {filtered.length} {filtered.length === 1 ? "item" : "items"}
              {matchingLibraries.length > 0 && (
                <span className="ml-2 font-mono text-xs">
                  · {matchingLibraries.length}{" "}
                  {matchingLibraries.length === 1 ? "library" : "libraries"}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddBookmarkModal(true)}
              className="btn-accent text-xs py-2 px-3 flex items-center gap-1.5 shadow-lg shadow-accent/20"
              title="Add Web Stream or Source Bookmark (0 MB Cloud Storage)"
            >
              <Globe size={13} />
              + Add Web Stream
            </button>
            {libraryType === "audiobooks" && filtered.length > 0 && (
              <button
                onClick={() => {
                  setSelectedBookForConvert(filtered);
                  setShowAudiobookConverter(true);
                }}
                className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
                title="Convert MP3 audiobooks into chapterized M4B"
              >
                <BookOpen size={13} className="text-accent" />
                Convert to M4B
              </button>
            )}
            {matchingLibraries.length > 0 && (
              <>
                <button
                  onClick={handleRefreshAllMetadata}
                  disabled={scanState.status === "scanning"}
                  title="Re-fetch metadata and artwork for all items"
                  className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Sparkles
                    size={13}
                    className={scanState.status === "scanning" ? "animate-spin text-accent" : "text-accent"}
                  />
                  Refresh Metadata
                </button>
                <button
                  onClick={handleScanAllTypeLibraries}
                  disabled={scanState.status === "scanning"}
                  className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 disabled:opacity-50"
                >
                  <RefreshCw
                    size={13}
                    className={scanState.status === "scanning" ? "animate-spin" : ""}
                  />
                  {scanState.status === "scanning" ? "Scanning…" : "Scan Libraries"}
                </button>
              </>
            )}
          </div>
        </div>

        {/* No library configured */}
        {matchingLibraries.length === 0 && (
          <div className="px-8 py-16 text-center">
            <p className="text-subtle font-body text-sm mb-3">
              No {libraryType} library configured yet.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setShowAddBookmarkModal(true)}
                className="btn-accent text-sm flex items-center gap-1.5"
              >
                <Globe size={14} />
                + Add Web Stream (0 MB)
              </button>
              <button
                onClick={() => navigate("/settings")}
                className="btn-secondary text-sm"
              >
                Configure Cloud Library →
              </button>
            </div>
          </div>
        )}

        {matchingLibraries.length > 0 && (
          <>
            {/* Continue Watching / Listening */}
            {inProgress.length > 0 && (
              <div className="mb-4">
                <MediaShelf
                  title="Continue Listening / Reading"
                  items={inProgress}
                  progressMap={watchProgress}
                  showProgress
                  onItemClick={handleItemClick}
                />
              </div>
            )}

            {/* Source Filter Pills (All Sources / Native Cloud / Plex & Jellyfin / Shared Passes) */}
            {(hasExtLibs || hasSharedLibs) && (
              <div className="px-8 mb-4 flex items-center gap-1.5">
                {[
                  { id: "all", label: "All Sources" },
                  ...(hasNativeLibs ? [{ id: "native", label: "Native Cloud" }] : []),
                  ...(hasExtLibs ? [{ id: "external", label: "Plex & Jellyfin" }] : []),
                  ...(hasSharedLibs ? [{ id: "shared", label: "Shared Passes" }] : []),
                ].map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSourceFilter(s.id as any)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                      sourceFilter === s.id
                        ? "bg-accent text-void shadow"
                        : "bg-panel text-subtle hover:text-white border border-border"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}

            {/* Search + Sort */}
            <div className="px-8 mb-5 flex items-center gap-3">
              <div className="relative flex-1 max-w-xs">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle"
                />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search titles or authors..."
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
                  onChange={(e) => handleSortChange(e.target.value as SortKey)}
                  className="input-field pl-9 py-2 text-sm appearance-none pr-8 cursor-pointer"
                >
                  <option value="addedAt">Recently Added</option>
                  <option value="year">Recently Released</option>
                  <option value="title">Title (A → Z)</option>
                  <option value="rating">Highest Rated</option>
                </select>
              </div>
              <button
                type="button"
                onClick={() => setOnlyFavorites((prev) => !prev)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded transition-colors ${
                  onlyFavorites
                    ? "bg-red-500/20 text-red-400 border border-red-500/30"
                    : "btn-secondary text-subtle hover:text-bright"
                }`}
                title={onlyFavorites ? "Showing favorites only" : "Filter by favorites"}
              >
                <Heart size={14} className={onlyFavorites ? "fill-red-400" : ""} />
                <span>Favorites</span>
              </button>
            </div>

            {/* Grid */}
            {filtered.length === 0 ? (
              <div className="px-8 py-12 text-center">
                <p className="text-subtle font-body text-sm">
                  {search ? "No matches found." : "This library is empty."}
                </p>
              </div>
            ) : (
              <VirtualMediaGrid
                items={filtered}
                progressMap={watchProgress}
                onPlay={handleCardPlay}
                tracksByCardId={tracksByCardId}
                scrollRef={scrollRef}
              />
            )}

            {/* Discovery Shelves */}
            {libraryType === "movies" && annotatedTrendingMovies && annotatedTrendingMovies.length > 0 && (
              <div className="px-8 mt-12 mb-8">
                <MediaShelf
                  title="Trending Movies · Discovery"
                  items={annotatedTrendingMovies}
                  onItemClick={(item) => resolveDiscoveryCardNavigation(item, mediaItems, navigate)}
                />
              </div>
            )}

            {libraryType === "tv" && annotatedTrendingShows && annotatedTrendingShows.length > 0 && (
              <div className="px-8 mt-12 mb-8">
                <MediaShelf
                  title="Trending TV Shows · Discovery"
                  items={annotatedTrendingShows}
                  onItemClick={(item) => resolveDiscoveryCardNavigation(item, mediaItems, navigate)}
                />
              </div>
            )}
          </>
        )}
      </div>
      <AddStreamBookmarkModal
        isOpen={showAddBookmarkModal}
        onClose={() => setShowAddBookmarkModal(false)}
        defaultLibraryType={libraryType}
        defaultLibraryId={matchingLibraries[0]?.id}
      />
      {showAudiobookConverter && selectedBookForConvert.length > 0 && (
        <AudiobookConverterModal
          items={selectedBookForConvert}
          onClose={() => {
            setShowAudiobookConverter(false);
            setSelectedBookForConvert([]);
          }}
          onSuccess={() => {
            setShowAudiobookConverter(false);
            setSelectedBookForConvert([]);
          }}
        />
      )}
    </div>
  );
}
