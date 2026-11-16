import { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Globe,
  Film,
  Tv,
  Music,
  ArrowRight,
  Compass,
  Clock,
  Trash2,
  Sparkles,
  Layers,
  BookOpen,
  Info,
  Zap,
  Radio,
} from "lucide-react";
import {
  useAppStore,
  selectTvShows,
  type MediaItem,
  type TvShow,
} from "../../store/appStore";
import {
  crawlWebsiteReleases,
  isSpecificStreamOrFile,
  type SiteDiscoveryFeed,
  type DiscoveredRelease,
} from "../../lib/streamResolver";
import {
  getRecentSearches,
  addRecentSearch,
  clearRecentSearches,
} from "../../lib/siteBookmarks";
import { SiteDiscoveryDrawer } from "../discovery/SiteDiscoveryDrawer";
import { AddStreamBookmarkModal } from "../library/AddStreamBookmarkModal";
import { MediaDetailsModal } from "../library/MediaDetailsModal";
import { EasynewsSearchModal } from "../discovery/EasynewsSearchModal";
import { StremioStreamsModal } from "../discovery/StremioStreamsModal";
import { InfiniDyskSearchModal } from "../discovery/InfiniDyskSearchModal";
import { Loader2, X } from "lucide-react";
import { isTvEnvironment } from "../../lib/tvNavigation";

export function UniversalSearchBar() {
  const navigate = useNavigate();
  const { mediaItems } = useAppStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const isTv = isTvEnvironment();

  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isTvModalOpen, setIsTvModalOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  // Discovery Drawer state
  const [isDiscoveryOpen, setIsDiscoveryOpen] = useState(false);
  const [isCrawling, setIsCrawling] = useState(false);
  const [discoveryFeed, setDiscoveryFeed] = useState<SiteDiscoveryFeed | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [lastCrawlUrl, setLastCrawlUrl] = useState<string>("");

  // Easynews Search Modal state
  const [isEasynewsOpen, setIsEasynewsOpen] = useState(false);
  const [easynewsInitialQuery, setEasynewsInitialQuery] = useState("");
  const [isInfiniDyskOpen, setIsInfiniDyskOpen] = useState(false);
  const [infiniDyskInitialQuery, setInfiniDyskInitialQuery] = useState("");

  // Stremio Discovery state
  const [stremioResults, setStremioResults] = useState<Array<{
    id: string;
    name: string;
    type: "movie" | "series";
    poster?: string;
    background?: string;
    year?: string | number;
    description?: string;
    genres?: string[];
  }>>([]);
  const [isSearchingStremio, setIsSearchingStremio] = useState(false);
  const [selectedStremioItem, setSelectedStremioItem] = useState<MediaItem | null>(null);

  // Action Card / Bookmark Modal state
  const [isActionModalOpen, setIsActionModalOpen] = useState(false);
  const [actionUrl, setActionUrl] = useState<string>("");

  // Media Details Modal state (for Movies/Episodes clicked in search)
  const [selectedDetailsItem, setSelectedDetailsItem] = useState<MediaItem | null>(null);

  useEffect(() => {
    setRecentSearches(getRecentSearches());
  }, []);

  useEffect(() => {
    const handleOpenTvSearch = () => {
      refreshRecent();
      setIsTvModalOpen(true);
      setIsFocused(true);
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
        }
      }, 80);
    };
    window.addEventListener("rcloneflix:open-search", handleOpenTvSearch);
    return () => window.removeEventListener("rcloneflix:open-search", handleOpenTvSearch);
  }, []);

  const refreshRecent = () => {
    setRecentSearches(getRecentSearches());
  };

  // Detect if query looks like a URL, magnet URI, or domain
  const isUrlOrDomain = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return false;
    if (q.startsWith("http://") || q.startsWith("https://") || q.startsWith("magnet:?")) return true;
    if (q === "tubi" || q === "tubitv" || q === "tubi.tv" || q === "baddies" || q === "baddieseast") return true;
    if (q.includes(".") && !q.includes(" ") && q.length > 4) {
      const tlds = [
        ".com", ".org", ".net", ".co", ".to", ".sx", ".me", ".tv",
        ".ru", ".site", ".pk", ".si", ".su", ".in", ".ag", ".tf", ".wtf", ".bz"
      ];
      return tlds.some((tld) => q.includes(tld));
    }
    return false;
  }, [query]);

  // Live Stremio Cinemeta catalog search for media not necessarily in the local library
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || isUrlOrDomain || trimmed.length < 2) {
      setStremioResults([]);
      return;
    }

    let active = true;
    const timer = setTimeout(async () => {
      setIsSearchingStremio(true);
      try {
        const enc = encodeURIComponent(trimmed);
        const [movResp, serResp] = await Promise.all([
          fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${enc}.json`).catch(() => null),
          fetch(`https://v3-cinemeta.strem.io/catalog/series/top/search=${enc}.json`).catch(() => null),
        ]);

        const movData = movResp?.ok ? await movResp.json() : null;
        const serData = serResp?.ok ? await serResp.json() : null;

        if (!active) return;

        const combined: Array<{
          id: string;
          name: string;
          type: "movie" | "series";
          poster?: string;
          background?: string;
          year?: string | number;
          description?: string;
          genres?: string[];
        }> = [];
        const seen = new Set<string>();

        for (const m of [...(movData?.metas || []), ...(serData?.metas || [])]) {
          if (m?.id && !seen.has(m.id)) {
            seen.add(m.id);
            combined.push({
              id: m.id,
              name: m.name || m.title || "Unknown Title",
              type: m.type === "series" ? "series" : "movie",
              poster: m.poster,
              background: m.background,
              year: m.year,
              description: m.description,
              genres: m.genres,
            });
          }
        }

        if (active) {
          setStremioResults(combined.slice(0, 6));
        }
      } catch (err) {
        console.warn("Cinemeta search failed:", err);
      } finally {
        if (active) setIsSearchingStremio(false);
      }
    }, 280);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, isUrlOrDomain]);

  // Keyboard shortcut: Ctrl+K or / to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey && e.key === "k") || (e.key === "/" && document.activeElement?.tagName !== "INPUT")) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Unified TV Shows indexing (matches series name directly)
  const allTvShows = useMemo(() => {
    return selectTvShows(mediaItems);
  }, [mediaItems]);

  const matchingTvShows = useMemo(() => {
    if (!query.trim() || isUrlOrDomain) return [];
    const q = query.toLowerCase().trim();
    return allTvShows
      .filter((s) => s.title.toLowerCase().includes(q))
      .slice(0, 4);
  }, [allTvShows, query, isUrlOrDomain]);

  // Movies & Videos matching
  const matchingMovies = useMemo(() => {
    if (!query.trim() || isUrlOrDomain) return [];
    const q = query.toLowerCase().trim();
    return Object.values(mediaItems)
      .filter((item: MediaItem) =>
        (item.libraryType === "movies" || item.libraryType === "adult" || !item.libraryType) &&
        item.title.toLowerCase().includes(q)
      )
      .slice(0, 4);
  }, [mediaItems, query, isUrlOrDomain]);

  // TV Episodes matching (if user searches a specific episode title)
  const matchingEpisodes = useMemo(() => {
    if (!query.trim() || isUrlOrDomain) return [];
    const q = query.toLowerCase().trim();
    return Object.values(mediaItems)
      .filter((item: MediaItem) =>
        item.libraryType === "tv" &&
        ((item.episodeTitle && item.episodeTitle.toLowerCase().includes(q)) ||
         (item.showTitle && item.showTitle.toLowerCase().includes(q) && matchingTvShows.length === 0))
      )
      .slice(0, 4);
  }, [mediaItems, query, isUrlOrDomain, matchingTvShows]);

  // Music & Audiobooks matching
  const matchingAudio = useMemo(() => {
    if (!query.trim() || isUrlOrDomain) return [];
    const q = query.toLowerCase().trim();
    return Object.values(mediaItems)
      .filter((item: MediaItem) =>
        (item.libraryType === "music" || item.libraryType === "audiobooks" || item.libraryType === "books") &&
        (item.title.toLowerCase().includes(q) ||
         (item.artist && item.artist.toLowerCase().includes(q)) ||
         (item.album && item.album.toLowerCase().includes(q)) ||
         (item.author && item.author.toLowerCase().includes(q)))
      )
      .slice(0, 4);
  }, [mediaItems, query, isUrlOrDomain]);

  const hasAnyLibraryMatches =
    matchingTvShows.length > 0 ||
    matchingMovies.length > 0 ||
    matchingEpisodes.length > 0 ||
    matchingAudio.length > 0;

  const handleCrawlSite = async (targetUrl: string) => {
    let formatted = targetUrl.trim();
    if (!formatted || formatted === "https://" || formatted === "http://") return;
    if (formatted.toLowerCase().startsWith("magnet:?")) {
      handleOpenActionModal(formatted);
      return;
    }
    const lower = formatted.toLowerCase();
    if (lower === "tubi" || lower === "tubitv" || lower === "tubi.tv") {
      formatted = "https://tubitv.com";
    } else if (lower === "baddies" || lower === "baddieseast") {
      formatted = "https://baddieseast.com.co";
    } else if (!formatted.startsWith("http://") && !formatted.startsWith("https://")) {
      formatted = `https://${formatted}`;
    }
    setLastCrawlUrl(formatted);
    addRecentSearch(formatted);
    refreshRecent();
    setIsCrawling(true);
    setDiscoveryError(null);
    setIsDiscoveryOpen(true);
    setIsFocused(false);
    setIsTvModalOpen(false);

    try {
      const feed = await crawlWebsiteReleases(formatted);
      setDiscoveryFeed(feed);
    } catch (err: any) {
      console.error("Crawl error:", err);
      setDiscoveryError(err.message || String(err) || "Failed to crawl site");
    } finally {
      setIsCrawling(false);
    }
  };

  const handleOpenActionModal = (targetUrl: string) => {
    let formatted = targetUrl.trim();
    if (!formatted.startsWith("http://") && !formatted.startsWith("https://") && !formatted.toLowerCase().startsWith("magnet:?")) {
      formatted = `https://${formatted}`;
    }
    addRecentSearch(formatted);
    refreshRecent();
    setActionUrl(formatted);
    setIsActionModalOpen(true);
    setIsFocused(false);
    setIsTvModalOpen(false);
  };

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    addRecentSearch(trimmed);
    refreshRecent();

    if (isUrlOrDomain) {
      if (isSpecificStreamOrFile(trimmed)) {
        handleOpenActionModal(trimmed);
      } else {
        handleCrawlSite(trimmed);
      }
    } else if (matchingTvShows.length > 0) {
      handleClickTvShow(matchingTvShows[0]);
    } else if (matchingMovies.length > 0) {
      handleClickMovie(matchingMovies[0]);
    } else if (matchingEpisodes.length > 0) {
      handleClickEpisode(matchingEpisodes[0]);
    } else if (matchingAudio.length > 0) {
      handleClickAudio(matchingAudio[0]);
    } else {
      // Default: Discover on MovieBite
      handleCrawlSite(`https://moviebite.org`);
    }
  };

  const handleClickTvShow = (show: TvShow) => {
    setIsFocused(false);
    setIsTvModalOpen(false);
    setQuery("");
    navigate(`/tv/show/${encodeURIComponent(show.showId)}`, { state: { show } });
  };

  const handleClickMovie = (item: MediaItem) => {
    setIsFocused(false);
    setIsTvModalOpen(false);
    setSelectedDetailsItem(item);
  };

  const handleClickEpisode = (episode: MediaItem) => {
    setIsFocused(false);
    setIsTvModalOpen(false);
    const parent = allTvShows.find(
      (s) => s.showId === episode.showId || s.title.toLowerCase() === (episode.showTitle ?? "").toLowerCase()
    );
    if (parent) {
      navigate(`/tv/show/${encodeURIComponent(parent.showId)}`, { state: { show: parent } });
    } else {
      setSelectedDetailsItem(episode);
    }
  };

  const handleClickAudio = (track: MediaItem) => {
    setIsFocused(false);
    setIsTvModalOpen(false);
    setQuery("");
    if (track.libraryType === "music") {
      window.dispatchEvent(
        new CustomEvent("rcloneflix:play-audio", {
          detail: { playlist: [track], playlistIndex: 0 },
        })
      );
      navigate("/music");
    } else if (track.libraryType === "audiobooks" || track.libraryType === "books") {
      navigate("/library/books");
    } else {
      setSelectedDetailsItem(track);
    }
  };

  const handleSelectRelease = (release: DiscoveredRelease) => {
    setIsDiscoveryOpen(false);
    handleOpenActionModal(release.post_url);
  };

  const handleClearHistory = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearRecentSearches();
    setRecentSearches([]);
  };

  return (
    <>
      {isTv && isTvModalOpen && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-md z-40"
          onClick={() => {
            setIsTvModalOpen(false);
            setIsFocused(false);
          }}
        />
      )}
      <div
        role={isTv && isTvModalOpen ? "dialog" : undefined}
        aria-modal={isTv && isTvModalOpen ? "true" : undefined}
        className={
          isTv
            ? isTvModalOpen
              ? "fixed top-8 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 py-2 z-50"
              : "hidden"
            : "relative w-full max-w-2xl mx-auto px-4 py-2 z-40"
        }
      >
        <form onSubmit={handleSubmit} className="relative flex items-center">
          <div className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none text-subtle">
            {isUrlOrDomain ? (
              <Globe className="w-4 h-4 text-accent animate-pulse" />
            ) : (
              <Search className="w-4 h-4" />
            )}
          </div>

          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => {
              refreshRecent();
              setIsFocused(true);
            }}
            onBlur={() => {
              if (!isTv) {
                setTimeout(() => setIsFocused(false), 280);
              }
            }}
            placeholder="Search TV shows, movies, music, or paste stream link..."
            style={{
              WebkitAppearance: "none",
              backgroundColor: "#141820",
              color: "#EEF2F8",
            }}
            className="w-full pl-10 pr-24 py-2 text-xs sm:text-sm bg-panel border border-border focus:border-accent rounded-xl text-bright placeholder:text-subtle shadow-lg focus:outline-none transition-all font-body"
          />

          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
            {isTv && isTvModalOpen && (
              <button
                type="button"
                data-close-modal="true"
                onClick={() => {
                  setIsTvModalOpen(false);
                  setIsFocused(false);
                }}
                title="Close Search"
                className="p-1 rounded-lg bg-void/80 border border-border text-subtle hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            {query ? (
              <button
                type="submit"
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-accent text-void hover:bg-accent-glow shadow transition-all"
              >
                {isUrlOrDomain ? (
                  query.includes("/episode-") || query.includes("/watch/") || query.includes(".mp4") ? (
                    <>
                      <span>Resolve</span>
                      <ArrowRight className="w-3 h-3" />
                    </>
                  ) : (
                    <>
                      <Compass className="w-3 h-3" />
                      <span>Crawl</span>
                    </>
                  )
                ) : (
                  <>
                    <span>Search</span>
                    <ArrowRight className="w-3 h-3" />
                  </>
                )}
              </button>
            ) : (
              <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono text-subtle bg-void/60 border border-border rounded shadow-sm">
                Ctrl K
              </kbd>
            )}
          </div>
        </form>

        {/* Dropdown Quick Results & Recent Searches */}
        {isFocused && (
          <div className="absolute left-4 right-4 top-full mt-1.5 bg-panel border border-border rounded-xl shadow-2xl overflow-hidden backdrop-blur-xl z-50 max-h-[75vh] overflow-y-auto">
            {/* If user typed a URL or domain */}
            {isUrlOrDomain ? (
              <div className="p-2">
                <button
                  onClick={() => handleSubmit()}
                  onMouseDown={() => handleSubmit()}
                  className="w-full flex items-center gap-3 p-2.5 rounded-lg text-left hover:bg-muted/40 text-bright transition-colors"
                >
                  <div className="p-2 rounded-lg bg-accent/15 text-accent border border-accent/25">
                    {query.trim().toLowerCase().startsWith("magnet:?") ? (
                      <Zap className="w-4 h-4 text-amber-400" />
                    ) : (
                      <Globe className="w-4 h-4" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold truncate text-bright">
                      {query.trim().toLowerCase().startsWith("magnet:?")
                        ? "Resolve Torrent Magnet via Debrid"
                        : isSpecificStreamOrFile(query)
                        ? "Resolve and Play Direct Stream"
                        : `Crawl Releases on ${query}`}
                    </p>
                    <p className="text-[11px] text-subtle truncate">{query}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-subtle" />
                </button>
              </div>
            ) : query.trim() ? (
              /* Library Matches (Categorized: TV Series, Movies, Episodes, Music) */
              <div className="p-2 space-y-2">
                {/* 1. TV Series Section */}
                {matchingTvShows.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-accent uppercase tracking-wider">
                      <Tv className="w-3 h-3" />
                      <span>TV Series</span>
                    </div>
                    {matchingTvShows.map((show) => {
                      const seasonCount = Object.keys(show.seasons).length;
                      return (
                        <button
                          key={show.showId}
                          onClick={() => handleClickTvShow(show)}
                          onMouseDown={() => handleClickTvShow(show)}
                          className="w-full flex items-center gap-3 p-2 rounded-lg text-left hover:bg-muted/40 text-bright transition-colors group"
                        >
                          <div className="w-8 h-11 bg-void rounded overflow-hidden flex items-center justify-center shrink-0 border border-border">
                            {show.posterUrl ? (
                              <img src={show.posterUrl} alt={show.title} className="w-full h-full object-cover" />
                            ) : (
                              <Tv className="w-4 h-4 text-subtle" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold truncate text-bright group-hover:text-accent transition-colors">
                              {show.title}
                            </p>
                            <p className="text-[11px] text-subtle">
                              {seasonCount} Season{seasonCount !== 1 ? "s" : ""} · {show.episodeCount} Episodes
                            </p>
                          </div>
                          <div className="flex items-center gap-1 px-2 py-1 rounded bg-accent/10 text-accent text-[11px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity">
                            <span>Open Series</span>
                            <ArrowRight className="w-3 h-3" />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* 2. Movies & Videos Section */}
                {matchingMovies.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-purple-400 uppercase tracking-wider">
                      <Film className="w-3 h-3" />
                      <span>Movies & Videos</span>
                    </div>
                    {matchingMovies.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => handleClickMovie(item)}
                        onMouseDown={() => handleClickMovie(item)}
                        className="w-full flex items-center gap-3 p-2 rounded-lg text-left hover:bg-muted/40 text-bright transition-colors group"
                      >
                        <div className="w-8 h-11 bg-void rounded overflow-hidden flex items-center justify-center shrink-0 border border-border">
                          {item.posterUrl ? (
                            <img src={item.posterUrl} alt={item.title} className="w-full h-full object-cover" />
                          ) : (
                            <Film className="w-4 h-4 text-subtle" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold truncate text-bright group-hover:text-accent transition-colors">
                            {item.title}
                          </p>
                          <p className="text-[11px] text-subtle">
                            {item.year ? `${item.year} · ` : ""}
                            {(item.libraryType || "movie").toUpperCase()}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 px-2 py-1 rounded bg-purple-500/10 text-purple-400 text-[11px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity">
                          <Info className="w-3 h-3" />
                          <span>Details</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* 3. Individual Episodes Section */}
                {matchingEpisodes.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-blue-400 uppercase tracking-wider">
                      <Layers className="w-3 h-3" />
                      <span>Episodes</span>
                    </div>
                    {matchingEpisodes.map((ep) => (
                      <button
                        key={ep.id}
                        onClick={() => handleClickEpisode(ep)}
                        onMouseDown={() => handleClickEpisode(ep)}
                        className="w-full flex items-center gap-3 p-2 rounded-lg text-left hover:bg-muted/40 text-bright transition-colors group"
                      >
                        <div className="w-8 h-11 bg-void rounded overflow-hidden flex items-center justify-center shrink-0 border border-border">
                          {ep.posterUrl || ep.showPosterUrl ? (
                            <img src={ep.posterUrl || ep.showPosterUrl} alt={ep.title} className="w-full h-full object-cover" />
                          ) : (
                            <Tv className="w-4 h-4 text-subtle" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold truncate text-bright group-hover:text-accent transition-colors">
                            {ep.episodeTitle ?? ep.title}
                          </p>
                          <p className="text-[11px] text-subtle truncate">
                            {ep.showTitle ? `${ep.showTitle} · ` : ""}
                            {ep.season && ep.episode ? `S${ep.season}E${ep.episode}` : "Episode"}
                          </p>
                        </div>
                        <ArrowRight className="w-3.5 h-3.5 text-subtle group-hover:text-accent shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {/* 4. Music & Audiobooks Section */}
                {matchingAudio.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">
                      <Music className="w-3 h-3" />
                      <span>Music & Audio</span>
                    </div>
                    {matchingAudio.map((track) => (
                      <button
                        key={track.id}
                        onClick={() => handleClickAudio(track)}
                        onMouseDown={() => handleClickAudio(track)}
                        className="w-full flex items-center gap-3 p-2 rounded-lg text-left hover:bg-muted/40 text-bright transition-colors group"
                      >
                        <div className="w-8 h-8 bg-void rounded overflow-hidden flex items-center justify-center shrink-0 border border-border">
                          {track.posterUrl ? (
                            <img src={track.posterUrl} alt={track.title} className="w-full h-full object-cover" />
                          ) : track.libraryType === "books" ? (
                            <BookOpen className="w-4 h-4 text-subtle" />
                          ) : (
                            <Music className="w-4 h-4 text-subtle" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold truncate text-bright group-hover:text-accent transition-colors">
                            {track.title}
                          </p>
                          <p className="text-[11px] text-subtle truncate">
                            {track.artist || track.author || track.album || "Audio track"}
                          </p>
                        </div>
                        <ArrowRight className="w-3.5 h-3.5 text-subtle group-hover:text-accent shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {/* 5. Stremio & Community Discovery (Movies & Series outside local library) */}
                {stremioResults.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-accent uppercase tracking-wider">
                      <span className="flex items-center gap-1.5">
                        <Sparkles className="w-3 h-3 text-accent" />
                        <span>Stremio & Community Discovery</span>
                      </span>
                      {isSearchingStremio && (
                        <Loader2 className="w-3 h-3 animate-spin text-accent" />
                      )}
                    </div>
                    {stremioResults.map((meta) => {
                      const isTv = meta.type === "series";
                      const synthesized: MediaItem = {
                        id: meta.id,
                        libraryId: "stremio-catalog",
                        metadataId: meta.id,
                        title: meta.name,
                        showTitle: isTv ? meta.name : undefined,
                        year: meta.year ? parseInt(String(meta.year).split("-")[0], 10) : undefined,
                        posterUrl: meta.poster,
                        backdropUrl: meta.background,
                        overview: meta.description,
                        libraryType: isTv ? "tv" : "movies",
                        remotePath: "",
                        filename: "",
                        addedAt: Date.now(),
                        lastScannedAt: Date.now(),
                      };
                      return (
                        <div
                          key={meta.id}
                          className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-muted/40 transition-colors group"
                        >
                          <button
                            type="button"
                            onMouseDown={() => {
                              setIsFocused(false);
                              if (isTv) {
                                navigate(`/tv/show/${encodeURIComponent(meta.id)}`, {
                                  state: { item: synthesized },
                                });
                              } else {
                                navigate(`/movie/${encodeURIComponent(meta.id)}`, {
                                  state: { item: synthesized },
                                });
                              }
                            }}
                            className="flex items-center gap-3 flex-1 min-w-0 text-left"
                          >
                            <div className="w-8 h-11 bg-void rounded overflow-hidden flex items-center justify-center shrink-0 border border-border">
                              {meta.poster ? (
                                <img src={meta.poster} alt={meta.name} className="w-full h-full object-cover" />
                              ) : isTv ? (
                                <Tv className="w-4 h-4 text-subtle" />
                              ) : (
                                <Film className="w-4 h-4 text-subtle" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold truncate text-bright group-hover:text-accent transition-colors">
                                {meta.name}
                              </p>
                              <p className="text-[11px] text-subtle">
                                {meta.year ? `${meta.year} · ` : ""}
                                {isTv ? "TV SERIES" : "MOVIE"} · Stremio
                              </p>
                            </div>
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              setIsFocused(false);
                              setSelectedStremioItem(synthesized);
                            }}
                            className="flex items-center gap-1 px-2.5 py-1 rounded bg-accent/15 hover:bg-accent/25 text-accent text-[11px] font-semibold border border-accent/30 transition-all shrink-0 ml-2"
                            title="Find instant torrent & Debrid streams via Stremio addons"
                          >
                            <Sparkles className="w-3 h-3 text-accent" />
                            <span>Streams</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Fallback option & Easynews / Stremio search */}
                <div className="pt-2 border-t border-border/50 space-y-1">
                  <button
                    onMouseDown={() => {
                      const synthesized: MediaItem = {
                        id: `stremio-search-${Date.now()}`,
                        libraryId: "stremio-catalog",
                        title: query.trim(),
                        libraryType: "movies",
                        remotePath: "",
                        filename: "",
                        addedAt: Date.now(),
                        lastScannedAt: Date.now(),
                      };
                      setSelectedStremioItem(synthesized);
                      setIsFocused(false);
                    }}
                    className="w-full flex items-center justify-between p-2 rounded-lg text-left hover:bg-muted/40 text-subtle hover:text-bright transition-colors text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <Sparkles className="w-3.5 h-3.5 text-accent" />
                      <span>Search Stremio Community Addons for &ldquo;<strong className="text-white">{query.trim()}</strong>&rdquo;</span>
                    </span>
                    <ArrowRight className="w-3 h-3 text-accent" />
                  </button>

                  <button
                    onMouseDown={() => {
                      setEasynewsInitialQuery(query.trim());
                      setIsEasynewsOpen(true);
                      setIsFocused(false);
                    }}
                    className="w-full flex items-center justify-between p-2 rounded-lg text-left hover:bg-muted/40 text-subtle hover:text-bright transition-colors text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <Globe className="w-3.5 h-3.5 text-accent" />
                      <span>Search Easynews Usenet for &ldquo;<strong className="text-white">{query.trim()}</strong>&rdquo;</span>
                    </span>
                    <ArrowRight className="w-3 h-3 text-accent" />
                  </button>

                  <button
                    onMouseDown={() => {
                      setInfiniDyskInitialQuery(query.trim());
                      setIsInfiniDyskOpen(true);
                      setIsFocused(false);
                    }}
                    className="w-full flex items-center justify-between p-2 rounded-lg text-left hover:bg-muted/40 text-subtle hover:text-cyan-400 transition-colors text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <Radio className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Search InfiniDysk Usenet for &ldquo;<strong className="text-white">{query.trim()}</strong>&rdquo;</span>
                    </span>
                    <ArrowRight className="w-3 h-3 text-cyan-400" />
                  </button>

                  <button
                    onMouseDown={() => handleCrawlSite("https://moviebite.org")}
                    className="w-full flex items-center justify-between p-2 rounded-lg text-left hover:bg-muted/40 text-subtle hover:text-bright transition-colors text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <Compass className="w-3.5 h-3.5 text-subtle" />
                      <span>Explore web releases on MovieBite</span>
                    </span>
                    <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ) : (
              /* Recent Searches & Suggested Portals */
              <div className="p-2">
                {recentSearches.length > 0 && (
                  <div className="mb-2">
                    <div className="flex items-center justify-between px-2 py-1">
                      <span className="text-[11px] font-semibold text-subtle uppercase tracking-wider flex items-center gap-1.5">
                        <Clock className="w-3 h-3" />
                        Recent Searches
                      </span>
                      <button
                        onMouseDown={handleClearHistory}
                        className="text-[10px] text-subtle hover:text-danger transition-colors flex items-center gap-1"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                        Clear
                      </button>
                    </div>
                    <div className="space-y-0.5">
                      {recentSearches.slice(0, 6).map((q) => (
                        <button
                          key={q}
                          onMouseDown={() => {
                            setQuery(q);
                            if (q.startsWith("http") || q.includes(".")) {
                              handleCrawlSite(q);
                            }
                          }}
                          className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left text-xs text-subtle hover:text-bright hover:bg-muted/30 transition-all"
                        >
                          <Clock className="w-3 h-3 text-subtle shrink-0" />
                          <span className="truncate">{q}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-1 border-t border-border/50 space-y-1">
                  <button
                    onMouseDown={() => {
                      setEasynewsInitialQuery("");
                      setIsEasynewsOpen(true);
                      setIsFocused(false);
                    }}
                    className="w-full flex items-center justify-between p-2 rounded-lg text-left hover:bg-muted/40 text-subtle hover:text-accent transition-colors text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <Globe className="w-3.5 h-3.5 text-accent" />
                      <span>Easynews Multi-Type Search (Videos, Audio, Books, Archives)</span>
                    </span>
                    <ArrowRight className="w-3 h-3 text-accent" />
                  </button>

                  <button
                    onMouseDown={() => navigate("/directplay")}
                    className="w-full flex items-center justify-between p-2 rounded-lg text-left hover:bg-muted/40 text-subtle hover:text-accent transition-colors text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <Sparkles className="w-3.5 h-3.5 text-accent" />
                      Browse DirectPlay & Curated Portals
                    </span>
                    <ArrowRight className="w-3 h-3" />
                  </button>

                  <button
                    onMouseDown={() => handleCrawlSite("https://tubitv.com")}
                    className="w-full flex items-center justify-between p-2 rounded-lg text-left hover:bg-muted/40 text-subtle hover:text-accent transition-colors text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <Tv className="w-3.5 h-3.5 text-accent" />
                      <span>Tubi TV Live Channels (Free News, Sports & Entertainment)</span>
                    </span>
                    <ArrowRight className="w-3 h-3 text-accent" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Portaled Modals & Drawers: Rendered on document.body to avoid containment/clipping bugs */}
      {typeof document !== "undefined" &&
        createPortal(
          <>
            {/* Discovery Drawer */}
            <SiteDiscoveryDrawer
              isOpen={isDiscoveryOpen}
              feed={discoveryFeed}
              isLoading={isCrawling}
              error={discoveryError}
              onClose={() => setIsDiscoveryOpen(false)}
              onSelectRelease={handleSelectRelease}
              onRetry={() => {
                const target = lastCrawlUrl || discoveryFeed?.site_url || query;
                if (target.trim()) {
                  void handleCrawlSite(target);
                }
              }}
              onSearch={(q) => {
                const currentUrl = lastCrawlUrl || discoveryFeed?.site_url || "";
                if (currentUrl.includes("gogoanime") || currentUrl.includes("gogoanimes")) {
                  void handleCrawlSite(`https://ww4.gogoanimes.fi/search.html?keyword=${encodeURIComponent(q)}`);
                } else if (currentUrl) {
                  void handleCrawlSite(`${currentUrl.replace(/\/$/, "")}/?s=${encodeURIComponent(q)}`);
                }
              }}
            />

            {/* Action Card / Bookmark Modal */}
            <AddStreamBookmarkModal
              isOpen={isActionModalOpen}
              onClose={() => setIsActionModalOpen(false)}
              initialUrl={actionUrl}
              autoInspect={true}
            />

            {/* Media Details Modal when clicking movie or item in search */}
            {selectedDetailsItem && (
              <MediaDetailsModal
                item={selectedDetailsItem}
                isOpen={!!selectedDetailsItem}
                onClose={() => setSelectedDetailsItem(null)}
                onPlay={(item, resume) => {
                  setSelectedDetailsItem(null);
                  navigate("/play/video", { state: { item, resumeAt: resume ? undefined : 0 } });
                }}
              />
            )}

            {/* Easynews Multi-Type Search Modal */}
            <EasynewsSearchModal
              isOpen={isEasynewsOpen}
              onClose={() => setIsEasynewsOpen(false)}
              initialQuery={easynewsInitialQuery}
            />

            {/* InfiniDysk Usenet Search Modal */}
            <InfiniDyskSearchModal
              isOpen={isInfiniDyskOpen}
              onClose={() => setIsInfiniDyskOpen(false)}
              initialQuery={infiniDyskInitialQuery}
            />

            {/* Stremio Streams Modal for Search Results */}
            {selectedStremioItem && (
              <StremioStreamsModal
                isOpen={!!selectedStremioItem}
                onClose={() => setSelectedStremioItem(null)}
                item={selectedStremioItem}
              />
            )}
          </>,
          document.body
        )}
    </>
  );
}
