import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Globe,
  Film,
  Tv,
  Play,
  Calendar,
  Search,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Star,
  Bookmark,
  Check,
  Trophy,
} from "lucide-react";
import { isSeriesContainerRelease, type SiteDiscoveryFeed, type DiscoveredRelease } from "../../lib/streamResolver";
import {
  isSiteBookmarked,
  saveUserBookmark,
  removeUserBookmark,
} from "../../lib/siteBookmarks";
import { useToastStore } from "../../store/toastStore";

type Props = {
  isOpen: boolean;
  feed: SiteDiscoveryFeed | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  onSelectRelease: (release: DiscoveredRelease) => void;
  onInstantPlay?: (release: DiscoveredRelease) => void;
  onRetry?: () => void;
  onSearch?: (query: string) => void;
  searchPlaceholder?: string;
};

function formatReleaseDate(dateStr?: string, mediaType?: string) {
  if (!dateStr) return null;
  const ts = Number(dateStr);
  if (!isNaN(ts) && ts > 1000000000000) {
    const d = new Date(ts);
    const now = Date.now();
    const diffMs = ts - now;
    // Live sports: if match started in the last 3.5 hours or starts in next 15 mins:
    if (mediaType === "sports") {
      if (diffMs <= 15 * 60 * 1000 && diffMs >= -3.5 * 60 * 60 * 1000) {
        return "🔴 LIVE";
      }
    }
    const isToday = d.toDateString() === new Date().toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return isToday ? `Today ${timeStr}` : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${timeStr}`;
  }
  return dateStr.split(" ").slice(0, 3).join(" ");
}

export function SiteDiscoveryDrawer({
  isOpen,
  feed,
  isLoading,
  error,
  onClose,
  onSelectRelease,
  onInstantPlay,
  onRetry,
  onSearch,
  searchPlaceholder,
}: Props) {
  const [filterQuery, setFilterQuery] = useState("");
  const [bookmarked, setBookmarked] = useState<boolean>(false);
  const addToast = useToastStore((s) => s.addToast);

  // Sync bookmark status when feed changes
  useMemo(() => {
    if (feed?.site_url) {
      setBookmarked(isSiteBookmarked(feed.site_url));
    }
  }, [feed?.site_url]);

  const filteredReleases = useMemo(() => {
    if (!feed?.releases) return [];
    if (!filterQuery.trim()) return feed.releases;
    // If onSearch is provided, the input is for site search (submitting queries),
    // so we don't aggressively blank out the current feed as the user is typing
    if (onSearch) return feed.releases;
    const q = filterQuery.toLowerCase();
    return feed.releases.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.post_url.toLowerCase().includes(q) ||
        (r.season && `s${r.season}`.includes(q)) ||
        (r.episode && `e${r.episode}`.includes(q))
    );
  }, [feed, filterQuery, onSearch]);

  const handleToggleBookmark = () => {
    if (!feed?.site_url) return;
    if (bookmarked) {
      removeUserBookmark(feed.site_url);
      setBookmarked(false);
      addToast(`Removed ${feed.site_title || feed.site_url} from bookmarks`, "info");
    } else {
      saveUserBookmark({
        title: feed.site_title || new URL(feed.site_url).hostname,
        url: feed.site_url,
        category: "movies_tv",
        description: `Crawled ${feed.releases?.length || 0} releases`,
        bookmarkType: "site",
      });
      setBookmarked(true);
      addToast(`Added "${feed.site_title || feed.site_url}" as a crawlable site bookmark!`, "success");
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      {/* Docked below top search bar (top-[68px]) leaving top bar interactive */}
      <div className="fixed inset-x-3 sm:inset-x-6 top-[68px] bottom-3 z-40 flex flex-col items-center justify-start pointer-events-none">
        <motion.div
          initial={{ opacity: 0, scale: 0.98, y: -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: -8 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="pointer-events-auto relative flex flex-col w-full max-w-6xl h-full bg-panel border border-border rounded-2xl shadow-2xl overflow-hidden font-body"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-3.5 border-b border-border bg-panel/95 backdrop-blur shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2 rounded-xl bg-accent/15 text-accent border border-accent/25 shrink-0">
                <Globe className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base sm:text-lg font-bold text-bright tracking-tight truncate">
                    {feed?.site_title || "Site Releases Discovery"}
                  </h2>
                  {feed?.releases && (
                    <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-accent/20 text-accent border border-accent/30">
                      {feed.releases.length} releases
                    </span>
                  )}
                  {feed?.site_url && (
                    <button
                      onClick={handleToggleBookmark}
                      className={`flex items-center gap-1 px-2.5 py-0.5 text-xs font-semibold rounded-lg border transition-all ${
                        bookmarked
                          ? "bg-accent/20 text-accent border-accent/40"
                          : "bg-void/60 text-subtle border-border hover:text-bright hover:bg-muted/40"
                      }`}
                      title={bookmarked ? "Remove Bookmark" : "Bookmark this site"}
                    >
                      <Star className={`w-3 h-3 ${bookmarked ? "fill-accent" : ""}`} />
                      <span>{bookmarked ? "Bookmarked" : "Bookmark Site"}</span>
                    </button>
                  )}
                </div>
                {feed?.site_url && (
                  <p className="text-xs text-subtle truncate max-w-md">
                    {feed.site_url}
                  </p>
                )}
              </div>
            </div>

            {/* Filter and Close */}
            <div className="flex items-center gap-3 shrink-0">
              {(onSearch || (feed && feed.releases.length > 0)) && (
                <div className="relative w-56 sm:w-72">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-subtle" />
                  <input
                    type="text"
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && onSearch && filterQuery.trim()) {
                        onSearch(filterQuery.trim());
                      }
                    }}
                    placeholder={searchPlaceholder || (onSearch ? "Search site (Enter)..." : "Filter releases...")}
                    style={{ backgroundColor: "#0E1117", color: "#EEF2F8" }}
                    className="w-full pl-8 pr-16 py-1.5 text-xs bg-void border border-border rounded-lg text-bright placeholder:text-subtle focus:outline-none focus:border-accent transition-colors"
                  />
                  {onSearch && filterQuery.trim() ? (
                    <button
                      onClick={() => onSearch(filterQuery.trim())}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 px-2 py-0.5 text-[10px] font-bold rounded bg-accent text-void hover:bg-accent-glow transition-all"
                      title="Search site"
                    >
                      Search
                    </button>
                  ) : filterQuery ? (
                    <button
                      onClick={() => setFilterQuery("")}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle hover:text-bright text-xs"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              )}

              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-subtle hover:text-bright hover:bg-muted/40 transition-colors"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Content Area */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4">
                <Loader2 className="w-10 h-10 text-accent animate-spin" />
                <div className="text-center">
                  <p className="text-sm font-semibold text-bright">
                    Crawling releases from site...
                  </p>
                  <p className="text-xs text-subtle mt-1">
                    Extracting posts, metadata, and playable streams
                  </p>
                </div>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-20 gap-4 text-center max-w-md mx-auto">
                <div className="p-3 rounded-2xl bg-danger/10 text-danger border border-danger/20">
                  <AlertTriangle className="w-8 h-8" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-bright">Discovery Failed</h3>
                  <p className="text-xs text-subtle mt-1">{error}</p>
                </div>
                {onRetry && (
                  <button
                    onClick={onRetry}
                    className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-panel hover:bg-muted/60 border border-border text-bright transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Try Again
                  </button>
                )}
              </div>
            ) : filteredReleases.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center max-w-md mx-auto space-y-3">
                <p className="text-sm text-subtle font-medium">
                  {filterQuery
                    ? `No releases match "${filterQuery}"`
                    : "No playable releases found on this page."}
                </p>
                {onSearch && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (filterQuery.trim()) onSearch(filterQuery.trim());
                    }}
                    className="flex items-center gap-2 w-full max-w-sm mt-2"
                  >
                    <input
                      type="text"
                      value={filterQuery}
                      onChange={(e) => setFilterQuery(e.target.value)}
                      placeholder={searchPlaceholder || "Search query..."}
                      style={{ backgroundColor: "#0E1117", color: "#EEF2F8" }}
                      className="flex-1 px-3 py-2 text-xs bg-void border border-border rounded-lg text-bright placeholder:text-subtle focus:outline-none focus:border-accent"
                    />
                    <button
                      type="submit"
                      className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-accent text-void hover:bg-accent-glow shrink-0 shadow"
                    >
                      Search
                    </button>
                  </form>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {filteredReleases.map((release, idx) => (
                  <motion.div
                    key={`${release.post_url}-${idx}`}
                    whileHover={{ y: -4 }}
                    onClick={() => onSelectRelease(release)}
                    className="group relative flex flex-col bg-void/60 hover:bg-void border border-border/70 hover:border-accent/60 rounded-xl overflow-hidden cursor-pointer shadow-sm hover:shadow-xl transition-all"
                  >
                    {/* Poster Thumbnail */}
                    <div className="relative aspect-[16/10] bg-void overflow-hidden flex items-center justify-center">
                      {release.thumbnail ? (
                        <img
                          src={release.thumbnail}
                          alt={release.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          loading="lazy"
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = "none";
                          }}
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-panel to-void text-subtle/40 p-4">
                          {release.media_type === "tv" || release.season || release.episode ? (
                            <Tv className="w-8 h-8 mb-1" />
                          ) : (
                            <Film className="w-8 h-8 mb-1" />
                          )}
                          <span className="text-[10px] text-center line-clamp-2">
                            {release.site_domain}
                          </span>
                        </div>
                      )}

                      {/* Episode Badge */}
                      {(release.season != null || release.episode != null) && (
                        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-void/90 backdrop-blur text-[11px] font-bold text-accent border border-accent/40 shadow">
                          {release.season != null && `S${String(release.season).padStart(2, "0")}`}
                          {release.episode != null && `E${String(release.episode).padStart(2, "0")}`}
                        </div>
                      )}

                      {/* Play / Inspect / View Episodes Overlay Button */}
                      {(() => {
                        const isSeriesContainer =
                          isSeriesContainerRelease(release) ||
                          release.post_url.includes("/category/");

                        return (
                          <div
                            onClick={(e) => {
                              if (isSeriesContainer) {
                                e.stopPropagation();
                                onSelectRelease(release);
                              } else if (onInstantPlay) {
                                e.stopPropagation();
                                onInstantPlay(release);
                              }
                            }}
                            className="absolute inset-0 bg-void/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"
                            title={
                              isSeriesContainer
                                ? "View Episodes"
                                : onInstantPlay
                                ? (release.media_type === "music" || release.site_domain.includes("iheart") ? "Play Radio Station" : "Instant Play Stream")
                                : "Inspect & Play"
                            }
                          >
                            <div className="p-3 rounded-full bg-accent text-void shadow-lg transform group-hover:scale-110 transition-transform">
                              {isSeriesContainer ? (
                                <Tv className="w-5 h-5" />
                              ) : (
                                <Play className="w-5 h-5 fill-current" />
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>

                    {/* Metadata Footer */}
                    <div className="p-3 flex-1 flex flex-col justify-between gap-1.5">
                      <h3
                        className="text-xs font-semibold text-bright line-clamp-2 leading-snug group-hover:text-accent transition-colors"
                        title={release.title}
                      >
                        {release.title}
                      </h3>

                      <div className="flex items-center justify-between text-[11px] text-subtle mt-auto pt-1 border-t border-border/40">
                        <span className="capitalize flex items-center gap-1">
                          {release.media_type === "sports" ? (
                            <>
                              <Trophy className="w-3 h-3 text-accent" />
                              <span className="text-accent font-semibold">Sports</span>
                            </>
                          ) : release.media_type === "tv" ? (
                            <>
                              <Tv className="w-3 h-3 text-sky-400" />
                              <span>TV</span>
                            </>
                          ) : (
                            <>
                              <Film className="w-3 h-3 text-amber-400" />
                              <span>Movie</span>
                            </>
                          )}
                        </span>

                        {release.date && (
                          <span
                            className={`flex items-center gap-1 text-[10px] font-mono truncate max-w-[110px] ${
                              release.media_type === "sports" && formatReleaseDate(release.date, release.media_type)?.includes("LIVE")
                                ? "text-red-400 font-bold"
                                : "text-subtle"
                            }`}
                          >
                            <Calendar className="w-2.5 h-2.5" />
                            <span>{formatReleaseDate(release.date, release.media_type)}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
