import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Globe,
  Film,
  Tv,
  Compass,
  Star,
  ExternalLink,
  Plus,
  Trash2,
  Play,
  Radio,
  Sparkles,
  Flame,
  Layers,
  Search,
  ArrowRight,
  Loader2,
} from "lucide-react";
import {
  EXAMPLE_BOOKMARKS,
  getUserBookmarks,
  saveUserBookmark,
  removeUserBookmark,
  type SiteBookmark,
  type BookmarkCategory,
} from "../lib/siteBookmarks";
import {
  crawlWebsiteReleases,
  searchIheartRadio,
  searchComicsPortal,
  fetchWebStreamInfo,
  isSpecificStreamOrFile,
  isSeriesContainerRelease,
  type SiteDiscoveryFeed,
  type DiscoveredRelease,
} from "../lib/streamResolver";
import { isComicExtension } from "../lib/mediaTypes";
import { SiteDiscoveryDrawer } from "../components/discovery/SiteDiscoveryDrawer";
import { AddStreamBookmarkModal } from "../components/library/AddStreamBookmarkModal";
import { useToastStore } from "../store/toastStore";
import { useAppStore, type MediaItem } from "../store/appStore";

// Module-level persistent browsing session so navigating back from player restores exact spot
let savedDirectPlaySession: {
  isDiscoveryOpen: boolean;
  discoveryFeed: SiteDiscoveryFeed | null;
  lastCrawlUrl: string;
  activeSearchBookmark: SiteBookmark | null;
  searchQuery: string;
} = {
  isDiscoveryOpen: false,
  discoveryFeed: null,
  lastCrawlUrl: "",
  activeSearchBookmark: null,
  searchQuery: "",
};

export function DirectPlayPage() {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const adultSettings = useAppStore((s) => s.adultSettings);
  const setAdultHidden = useAppStore((s) => s.setAdultHidden);

  const [userBookmarks, setUserBookmarks] = useState<SiteBookmark[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [customUrl, setCustomUrl] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [customBookmarkType, setCustomBookmarkType] = useState<"site" | "stream">("site");
  const [showAddModal, setShowAddModal] = useState(false);
  const [isSavingCustom, setIsSavingCustom] = useState(false);

  // Search Modal for Search-Dependent Portals
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [activeSearchBookmark, setActiveSearchBookmark] = useState<SiteBookmark | null>(() => savedDirectPlaySession.activeSearchBookmark);
  const [searchQuery, setSearchQuery] = useState(() => savedDirectPlaySession.searchQuery);

  // Ingest / Quick Crawl Bar on page
  const [pageQuery, setPageQuery] = useState("");
  const [lastCrawlUrl, setLastCrawlUrl] = useState(() => savedDirectPlaySession.lastCrawlUrl);

  // Discovery Drawer State
  const [isDiscoveryOpen, setIsDiscoveryOpen] = useState(() => savedDirectPlaySession.isDiscoveryOpen);
  const [isCrawling, setIsCrawling] = useState(false);
  const [discoveryFeed, setDiscoveryFeed] = useState<SiteDiscoveryFeed | null>(() => savedDirectPlaySession.discoveryFeed);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // Action / Bookmark Modal State
  const [isActionModalOpen, setIsActionModalOpen] = useState(false);
  const [actionUrl, setActionUrl] = useState("");
  const [selectedRelease, setSelectedRelease] = useState<DiscoveredRelease | null>(null);

  useEffect(() => {
    setUserBookmarks(getUserBookmarks());
  }, []);

  // Auto-reset category if adult content gets hidden
  useEffect(() => {
    if (adultSettings.hidden && selectedCategory === "adult") {
      setSelectedCategory("all");
    }
  }, [adultSettings.hidden, selectedCategory]);

  const refreshUserBookmarks = () => {
    setUserBookmarks(getUserBookmarks());
  };

  const handleCrawl = async (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setLastCrawlUrl(trimmed);
    savedDirectPlaySession.lastCrawlUrl = trimmed;
    setActiveSearchBookmark(null);
    savedDirectPlaySession.activeSearchBookmark = null;
    setIsCrawling(true);
    setDiscoveryError(null);
    setIsDiscoveryOpen(true);
    savedDirectPlaySession.isDiscoveryOpen = true;

    try {
      const feed = await crawlWebsiteReleases(url);
      setDiscoveryFeed(feed);
      savedDirectPlaySession.discoveryFeed = feed;
    } catch (err: any) {
      console.error("Crawl error:", err);
      setDiscoveryError(err.message || String(err) || "Failed to crawl site");
    } finally {
      setIsCrawling(false);
    }
  };

  const handleSearchIheart = async (query?: string) => {
    const iheartBm = EXAMPLE_BOOKMARKS.find((b) => b.id === "iheart") || null;
    setActiveSearchBookmark(iheartBm);
    savedDirectPlaySession.activeSearchBookmark = iheartBm;
    setIsCrawling(true);
    setDiscoveryError(null);
    setIsDiscoveryOpen(true);
    savedDirectPlaySession.isDiscoveryOpen = true;

    try {
      const feed = await searchIheartRadio(query);
      setDiscoveryFeed(feed);
      savedDirectPlaySession.discoveryFeed = feed;
    } catch (err: any) {
      console.error("iHeart error:", err);
      setDiscoveryError(err.message || String(err) || "Failed to load iHeart stations");
    } finally {
      setIsCrawling(false);
    }
  };

  const handleSearchComics = async (query = "") => {
    const comicBm = EXAMPLE_BOOKMARKS.find((b) => b.id === "readcomicsonline") || null;
    setActiveSearchBookmark(comicBm);
    savedDirectPlaySession.activeSearchBookmark = comicBm;
    setIsCrawling(true);
    setDiscoveryError(null);
    setIsDiscoveryOpen(true);
    savedDirectPlaySession.isDiscoveryOpen = true;

    try {
      const feed = await searchComicsPortal(query);
      setDiscoveryFeed(feed);
      savedDirectPlaySession.discoveryFeed = feed;
    } catch (err: any) {
      console.error("Comics Portal error:", err);
      setDiscoveryError(err.message || String(err) || "Failed to load comics portal");
    } finally {
      setIsCrawling(false);
    }
  };

  const handleExampleBookmarkClick = (bm: SiteBookmark) => {
    setActiveSearchBookmark(bm);
    savedDirectPlaySession.activeSearchBookmark = bm;
    setSearchQuery("");
    savedDirectPlaySession.searchQuery = "";
    setDiscoveryError(null);

    if (bm.id === "readcomicsonline" || bm.id === "mangadex" || bm.category === "comics") {
      void handleSearchComics();
      return;
    }
    if (bm.id === "iheart") {
      void handleSearchIheart();
      return;
    }
    void handleCrawl(bm.url);
  };

  const handleSearchSubmit = async (e?: React.FormEvent, customQ?: string) => {
    if (e) e.preventDefault();
    const q = (customQ ?? searchQuery).trim();
    if (!q || !activeSearchBookmark) return;

    setShowSearchModal(false);
    setIsCrawling(true);
    setDiscoveryError(null);
    setIsDiscoveryOpen(true);
    savedDirectPlaySession.isDiscoveryOpen = true;
    savedDirectPlaySession.searchQuery = q;
    savedDirectPlaySession.activeSearchBookmark = activeSearchBookmark;

    try {
      let feed: SiteDiscoveryFeed;
      if (
        activeSearchBookmark.id === "readcomicsonline" ||
        activeSearchBookmark.id === "mangadex" ||
        activeSearchBookmark.category === "comics"
      ) {
        feed = await searchComicsPortal(q);
      } else if (activeSearchBookmark.id === "iheart") {
        feed = await searchIheartRadio(q);
      } else if (activeSearchBookmark.id === "yomi") {
        feed = await crawlWebsiteReleases(
          `https://yomi.to/browse?query=${encodeURIComponent(q)}`
        );
      } else if (activeSearchBookmark.id === "balbums") {
        feed = await crawlWebsiteReleases(
          `https://balbums.st/?search=${encodeURIComponent(q.trim())}&mode=broad&sort=latest`
        );
      } else if (activeSearchBookmark.id === "sxyprn") {
        const tag = encodeURIComponent(q.trim().replace(/\s+/g, "-"));
        feed = await crawlWebsiteReleases(`https://www.sxyprn.com/${tag}.html`);
      } else if (activeSearchBookmark.id === "pornhub") {
        feed = await crawlWebsiteReleases(
          `https://www.pornhub.com/video/search?search=${encodeURIComponent(q)}`
        );
      } else if (activeSearchBookmark.id === "baddieseast") {
        feed = await crawlWebsiteReleases(
          `https://baddieseast.com.co/search/${encodeURIComponent(q)}`
        );
      } else {
        feed = await crawlWebsiteReleases(
          `${activeSearchBookmark.url.replace(/\/$/, "")}/?s=${encodeURIComponent(q)}`
        );
      }
      setDiscoveryFeed(feed);
      savedDirectPlaySession.discoveryFeed = feed;
    } catch (err: any) {
      console.error("Search error:", err);
      setDiscoveryError(err.message || String(err) || "Failed to search source");
    } finally {
      setIsCrawling(false);
    }
  };

  const handleSelectRelease = (release: DiscoveredRelease) => {
    // If selecting a series card (e.g. MangaDex title, MovieBite show, Yomi anime page),
    // drill down into the series hierarchy by crawling it to show all its individual issues/episodes!
    if (isSeriesContainerRelease(release)) {
      void handleCrawl(release.post_url);
      return;
    }

    setSelectedRelease(release);
    setIsDiscoveryOpen(false);
    setActionUrl(release.post_url);
    setIsActionModalOpen(true);
  };

  const handleInstantPlayRelease = (release: DiscoveredRelease) => {
    // 1. Guard against series containers: drill down instead of sending HTML to player
    if (isSeriesContainerRelease(release)) {
      void handleCrawl(release.post_url);
      return;
    }

    // 2. Comics & Manga Streams -> ComicReaderPage
    if (
      release.media_type === "comics" ||
      release.post_url.includes("mangadex.org/chapter/") ||
      Boolean(release.post_url.match(/comic\/[^/]+\/\d+/)) ||
      isComicExtension(release.post_url) ||
      isComicExtension(release.title)
    ) {
      setIsDiscoveryOpen(false);
      const comicItem: MediaItem = {
        id: `dp-comic-${release.post_url}`,
        libraryId: "directplay",
        libraryType: "comics",
        remotePath: release.post_url,
        filename: `${release.title}.cbz`,
        title: release.title,
        posterUrl: release.thumbnail || undefined,
        overview: "DirectPlay Comic Issue",
        metadataSource: "manual",
        addedAt: Date.now(),
        lastScannedAt: Date.now(),
        isSourceBookmark: true,
        sourceUrl: release.post_url,
        sourceProvider: release.site_domain,
        season: release.season ?? 1,
        episode: release.episode ?? undefined,
        showTitle:
          release.media_type === "tv" && (release.season != null || release.episode != null)
            ? discoveryFeed?.site_title || undefined
            : undefined,
      };
      navigate("/play/comic", { state: { item: comicItem, seriesIssues: discoveryFeed?.releases } });
      return;
    }

    // 3. Audio Streams (iHeartRadio, Music, Audiobook) -> AudioMiniPlayer via CustomEvent
    const isIheartStream =
      release.post_url.includes("iheart") ||
      release.post_url.includes("ihrhls") ||
      release.post_url.includes("revma") ||
      release.site_domain.includes("iheart");
    const isAudio =
      isIheartStream ||
      release.media_type === "music" ||
      release.media_type === "audiobook";

    const instantItem: MediaItem = {
      id: `dp-instant-${release.post_url}`,
      libraryId: "directplay",
      libraryType: isAudio ? "music" : release.media_type === "tv" ? "tv" : "movies",
      remotePath: release.post_url,
      filename: `${release.title}.${isAudio ? "m4a" : "mp4"}`,
      title: release.title,
      posterUrl: release.thumbnail || undefined,
      overview: isAudio ? "DirectPlay Audio Stream" : "DirectPlay Stream",
      metadataSource: "manual",
      addedAt: Date.now(),
      lastScannedAt: Date.now(),
      isSourceBookmark: true,
      sourceUrl: release.post_url,
      sourceProvider: release.site_domain,
      season: release.season ?? undefined,
      episode: release.episode ?? undefined,
      showTitle:
        release.media_type === "tv" && (release.season != null || release.episode != null)
          ? discoveryFeed?.site_title || undefined
          : undefined,
    };

    if (isAudio) {
      window.dispatchEvent(
        new CustomEvent("rcloneflix:play-audio", {
          detail: { playlist: [instantItem], playlistIndex: 0 },
        })
      );
      return;
    }

    // 4. Video Streams -> VideoPlayerPage (VLC)
    setIsDiscoveryOpen(false);
    const seriesEpisodes: MediaItem[] = (discoveryFeed?.releases || []).map((r) => ({
      id: `dp-instant-${r.post_url}`,
      libraryId: "directplay",
      libraryType: (r.media_type as any) || "tv",
      remotePath: r.post_url,
      filename: `${r.title}.mp4`,
      title: r.title,
      posterUrl: r.thumbnail || undefined,
      overview: "DirectPlay Stream",
      metadataSource: "manual",
      addedAt: Date.now(),
      lastScannedAt: Date.now(),
      isSourceBookmark: true,
      sourceUrl: r.post_url,
      sourceProvider: r.site_domain,
      season: r.season ?? undefined,
      episode: r.episode ?? undefined,
      showTitle:
        r.media_type === "tv" && (r.season != null || r.episode != null)
          ? discoveryFeed?.site_title || undefined
          : undefined,
    }));

    navigate("/play/video", { state: { item: instantItem, seriesEpisodes } });
  };

  const handlePageCrawl = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = pageQuery.trim();
    if (!trimmed) return;
    handleCrawl(trimmed);
  };

  const handlePageInspectStream = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = pageQuery.trim();
    if (!trimmed) return;
    setActionUrl(trimmed);
    setIsActionModalOpen(true);
  };

  const handlePageQuerySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pageQuery.trim();
    if (!trimmed) return;

    if (isSpecificStreamOrFile(trimmed)) {
      handlePageInspectStream(e);
    } else {
      handlePageCrawl(e);
    }
  };

  const handlePlayUserBookmark = (bm: SiteBookmark) => {
    if (bm.bookmarkType === "site" || !isSpecificStreamOrFile(bm.url)) {
      handleCrawl(bm.url);
      return;
    }

    const item: MediaItem = {
      id: bm.id,
      libraryId: "directplay",
      libraryType: (bm.mediaType as any) || "movies",
      remotePath: bm.url,
      filename: `${bm.title}.mp4`,
      title: bm.title,
      posterUrl: bm.posterUrl,
      overview: bm.description || "DirectPlay Stream Bookmark",
      metadataSource: "manual",
      addedAt: bm.addedAt || Date.now(),
      lastScannedAt: Date.now(),
      isSourceBookmark: true,
      sourceUrl: bm.url,
      sourceProvider: (() => {
        try {
          return new URL(bm.url).hostname;
        } catch {
          return "Custom Stream";
        }
      })(),
    };
    navigate("/play/video", { state: { item } });
  };

  const handleAddCustomBookmark = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = customUrl.trim();
    if (!trimmed) return;

    let formattedUrl = trimmed;
    if (!formattedUrl.startsWith("http://") && !formattedUrl.startsWith("https://")) {
      formattedUrl = `https://${formattedUrl}`;
    }

    setIsSavingCustom(true);
    let title = customTitle.trim();
    let posterUrl: string | undefined = undefined;
    let mediaType: string = "movies";

    if (customBookmarkType === "site") {
      try {
        const feed = await crawlWebsiteReleases(formattedUrl);
        if (!title) {
          title = feed.site_title || new URL(formattedUrl).hostname;
        }
      } catch {
        if (!title) {
          try {
            title = new URL(formattedUrl).hostname;
          } catch {
            title = formattedUrl;
          }
        }
      } finally {
        setIsSavingCustom(false);
      }

      saveUserBookmark({
        title,
        url: formattedUrl,
        category: "movies_tv",
        description: "Crawlable media portal",
        bookmarkType: "site",
      });

      refreshUserBookmarks();
      setCustomUrl("");
      setCustomTitle("");
      setShowAddModal(false);
      addToast(`Saved "${title}" as a crawlable site bookmark!`, "success");
      return;
    }

    try {
      const info = await fetchWebStreamInfo(formattedUrl);
      if (!title) {
        title = info.clean_title || info.raw_title;
      }
      if (info.poster_url) {
        posterUrl = info.poster_url;
      }
      if (info.media_type) {
        mediaType = info.media_type;
      }
    } catch {
      if (!title) {
        try {
          title = new URL(formattedUrl).hostname;
        } catch {
          title = formattedUrl;
        }
      }
    } finally {
      setIsSavingCustom(false);
    }

    saveUserBookmark({
      title,
      url: formattedUrl,
      category: "other",
      description: "Direct stream bookmark",
      posterUrl,
      mediaType,
      bookmarkType: "stream",
    });

    refreshUserBookmarks();
    setCustomUrl("");
    setCustomTitle("");
    setShowAddModal(false);

    addToast(`Saved "${title}" to your Saved Streams!`, "success");
  };

  const handleDeleteUserBookmark = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeUserBookmark(id);
    refreshUserBookmarks();
    addToast("Removed site from bookmarks.", "info");
  };

  const categories: { id: string; label: string; icon: any }[] = [
    { id: "all", label: "All Portals", icon: Globe },
    { id: "movies_tv", label: "Movies & TV", icon: Film },
    { id: "anime", label: "Anime", icon: Sparkles },
    { id: "comics", label: "Comics & Manga", icon: Layers },
    { id: "radio", label: "Live Radio", icon: Radio },
    ...(!adultSettings.hidden ? [{ id: "adult", label: "Adult", icon: Flame }] : []),
  ];

  const filteredExampleBookmarks = EXAMPLE_BOOKMARKS.filter((bm) => {
    if (adultSettings.hidden && bm.category === "adult") return false;
    if (selectedCategory === "all") return true;
    return bm.category === selectedCategory;
  });

  const visibleUserBookmarks = userBookmarks.filter((bm) => {
    if (adultSettings.hidden && bm.category === "adult") return false;
    return true;
  });

  return (
    <div className="flex-1 overflow-y-auto px-6 py-8 font-body">
      {/* Header */}
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-display text-bright tracking-wide flex items-center gap-3">
              <Compass className="w-8 h-8 text-accent" />
              DIRECTPLAY & STREAMING
            </h1>
            <p className="text-sm text-subtle mt-1">
              Stream on-demand, match metadata, or crawl bookmarks directly to your collection.
            </p>
          </div>

          <button
            onClick={() => setShowAddModal(true)}
            className="self-start md:self-auto flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-accent text-void hover:bg-accent-glow shadow transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>Add Bookmark / Portal</span>
          </button>
        </div>

        {/* Quick URL / Domain Ingest Bar */}
        <form onSubmit={handlePageQuerySubmit} className="relative flex items-center">
          <Globe className="absolute left-4 w-5 h-5 text-subtle" />
          <input
            type="text"
            value={pageQuery}
            onChange={(e) => setPageQuery(e.target.value)}
            placeholder="Enter website to crawl (e.g. archive.org/details/..., moviebite.org) or direct stream URL..."
            style={{ backgroundColor: "#11141D", color: "#EEF2F8" }}
            className="w-full pl-12 pr-44 sm:pr-48 py-3.5 bg-panel border border-border rounded-xl text-sm text-bright placeholder:text-subtle focus:outline-none focus:border-accent shadow-inner transition-colors"
          />
          <div className="absolute right-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={handlePageCrawl}
              disabled={!pageQuery.trim() || isCrawling}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-accent text-void hover:bg-accent-glow disabled:opacity-40 disabled:hover:bg-accent transition-all flex items-center gap-1.5 shadow"
              title="Crawl this page or collection for all playable media files and episodes"
            >
              {isCrawling ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Compass className="w-3.5 h-3.5" />
              )}
              <span>Crawl</span>
            </button>
            <button
              type="button"
              onClick={handlePageInspectStream}
              disabled={!pageQuery.trim() || isCrawling}
              className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-void border border-border text-subtle hover:text-bright hover:border-accent disabled:opacity-40 transition-all flex items-center gap-1"
              title="Inspect as a single direct media stream"
            >
              <Play className="w-3 h-3 fill-current" />
              <span className="hidden sm:inline">Stream</span>
            </button>
          </div>
        </form>

        {/* Section 1: User Custom Bookmarks */}
        {visibleUserBookmarks.length > 0 && (
          <div className="space-y-3 pt-2">
            <h2 className="text-sm font-bold text-subtle uppercase tracking-wider flex items-center gap-2">
              <Star className="w-4 h-4 text-accent" />
              <span>Your Saved Streams ({visibleUserBookmarks.length})</span>
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {visibleUserBookmarks.map((bm) => {
                const isSite = bm.bookmarkType === "site" || !isSpecificStreamOrFile(bm.url);
                return (
                  <motion.div
                    key={bm.id}
                    whileHover={{ scale: 1.02 }}
                    onClick={() => handlePlayUserBookmark(bm)}
                    className="group relative flex items-center justify-between p-3.5 rounded-xl bg-panel border border-border hover:border-accent/60 cursor-pointer shadow-sm hover:shadow-md transition-all"
                  >
                    <div className="flex items-center gap-3 min-w-0 pr-2">
                      <div className="w-8 h-8 rounded-lg bg-void border border-border flex items-center justify-center shrink-0 text-accent group-hover:bg-accent group-hover:text-void transition-colors">
                        {isSite ? (
                          <Globe className="w-4 h-4" />
                        ) : (
                          <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-bold text-bright truncate group-hover:text-accent transition-colors">
                            {bm.title}
                          </p>
                          <span className={`text-[9px] font-mono px-1 py-0.5 rounded uppercase ${
                            isSite ? "bg-accent/20 text-accent" : "bg-white/10 text-subtle"
                          }`}>
                            {isSite ? "Portal" : "Stream"}
                          </span>
                        </div>
                        <p className="text-[11px] text-subtle truncate mt-0.5">
                          {bm.url.replace(/^https?:\/\//, "")}
                        </p>
                      </div>
                    </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={(e) => handleDeleteUserBookmark(bm.id, e)}
                      className="p-1 rounded-md text-subtle hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 transition-all"
                      title="Delete Bookmark"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <ArrowRight className="w-4 h-4 text-subtle group-hover:text-accent transition-colors" />
                  </div>
                </motion.div>
                );
              })}
            </div>
          </div>
        )}

        {/* Section 2: Example Portals */}
        <div className="space-y-4 pt-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-bright tracking-tight flex items-center gap-2">
                <Compass className="w-4 h-4 text-accent" />
                <span>Example Portals</span>
              </h2>
              <p className="text-xs text-subtle">
                Preselected portals with built-in feed discovery and direct playback.
              </p>
            </div>

            {/* Category Filter Pills */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 max-w-full">
              {categories.map((cat) => {
                const Icon = cat.icon;
                const isSelected = selectedCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
                      isSelected
                        ? "bg-accent text-void shadow"
                        : "bg-panel text-subtle hover:text-bright border border-border hover:border-muted"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{cat.label}</span>
                  </button>
                );
              })}
              {adultSettings.hidden && !adultSettings.pinEnabled && (
                <button
                  type="button"
                  onClick={() => setAdultHidden(false)}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-pink-500/10 border border-pink-500/30 text-pink-300 hover:bg-pink-500/20 whitespace-nowrap transition-colors"
                >
                  Show Adult Portals (Balbums)
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredExampleBookmarks.map((bm) => (
              <motion.div
                key={bm.id}
                whileHover={{ y: -4 }}
                onClick={() => handleExampleBookmarkClick(bm)}
                className="group relative flex flex-col justify-between p-4 rounded-xl bg-panel border border-border hover:border-accent/60 cursor-pointer shadow-sm hover:shadow-xl transition-all"
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="px-2 py-0.5 text-[10px] font-bold rounded-md bg-void text-accent border border-border">
                      {bm.category.toUpperCase().replace("_", " & ")}
                    </span>
                    <span className="text-[10px] text-teal font-semibold flex items-center gap-1">
                      ● Active
                    </span>
                  </div>

                  <h3 className="text-sm font-bold text-bright group-hover:text-accent transition-colors flex items-center gap-1.5">
                    {bm.title}
                  </h3>

                  <p className="text-xs text-subtle mt-1 line-clamp-2 leading-relaxed">
                    {bm.description}
                  </p>
                </div>

                <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/50 text-xs">
                  <span className="text-[11px] text-subtle truncate max-w-[170px]">
                    {new URL(bm.url).hostname}
                  </span>
                  <div className="flex items-center gap-1 text-accent font-semibold text-xs group-hover:translate-x-0.5 transition-transform">
                    <span>{bm.requiresSearch ? "Search" : "Scrape"}</span>
                    <ArrowRight className="w-3 h-3" />
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>

      {/* Add Custom Bookmark Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="relative w-full max-w-md bg-panel border border-border rounded-2xl shadow-2xl p-6 space-y-4">
            <h3 className="text-lg font-bold text-bright">Add Bookmark or Portal</h3>
            <p className="text-xs text-subtle leading-relaxed">
              Add a crawlable website (e.g. Archive.org collections, forums, feeds) to browse on-demand releases, or save a single direct stream.
            </p>

            {/* Type selector */}
            <div className="grid grid-cols-2 gap-2 p-1 bg-void rounded-xl border border-border">
              <button
                type="button"
                onClick={() => setCustomBookmarkType("site")}
                className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-semibold transition-all ${
                  customBookmarkType === "site"
                    ? "bg-accent text-void shadow"
                    : "text-subtle hover:text-bright"
                }`}
              >
                <Globe className="w-3.5 h-3.5" />
                <span>Crawlable Site</span>
              </button>
              <button
                type="button"
                onClick={() => setCustomBookmarkType("stream")}
                className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-semibold transition-all ${
                  customBookmarkType === "stream"
                    ? "bg-accent text-void shadow"
                    : "text-subtle hover:text-bright"
                }`}
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Single Stream</span>
              </button>
            </div>

            <form onSubmit={handleAddCustomBookmark} className="space-y-3">
              <div>
                <label className="block text-xs text-subtle mb-1">
                  {customBookmarkType === "site" ? "Website or Collection URL" : "Direct Stream URL"}
                </label>
                <input
                  type="text"
                  required
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder={customBookmarkType === "site" ? "https://archive.org/details/... or site URL" : "https://... (.mp4, .m3u8, Streamtape)"}
                  style={{ backgroundColor: "#0E1117", color: "#EEF2F8" }}
                  className="w-full px-3 py-2 text-sm bg-void border border-border rounded-lg text-bright placeholder:text-subtle focus:outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="block text-xs text-subtle mb-1">Display Title (Optional)</label>
                <input
                  type="text"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="Auto-detected if left blank"
                  style={{ backgroundColor: "#0E1117", color: "#EEF2F8" }}
                  className="w-full px-3 py-2 text-sm bg-void border border-border rounded-lg text-bright placeholder:text-subtle focus:outline-none focus:border-accent"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-void border border-border text-subtle hover:text-bright"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!customUrl.trim() || isSavingCustom}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-accent text-void hover:bg-accent-glow disabled:opacity-40"
                >
                  {isSavingCustom ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Inspecting...</span>
                    </>
                  ) : (
                    <span>{customBookmarkType === "site" ? "Save Site Portal" : "Save Stream"}</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Search Prompt Modal for Search-Dependent Portals */}
      {showSearchModal && activeSearchBookmark && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="relative w-full max-w-md bg-panel border border-border rounded-2xl shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-bright flex items-center gap-2">
                <Search className="w-5 h-5 text-accent" />
                <span>{activeSearchBookmark.title}</span>
              </h3>
              <button
                onClick={() => setShowSearchModal(false)}
                className="p-1 rounded-lg text-subtle hover:text-bright"
              >
                ×
              </button>
            </div>
            <p className="text-xs text-subtle leading-relaxed">
              {activeSearchBookmark.description}
            </p>
            <form onSubmit={(e) => handleSearchSubmit(e)} className="space-y-4">
              <div>
                <input
                  type="text"
                  autoFocus
                  required
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={activeSearchBookmark.searchPlaceholder || "Type search query..."}
                  style={{ backgroundColor: "#0E1117", color: "#EEF2F8" }}
                  className="w-full px-3.5 py-2.5 text-sm bg-void border border-border rounded-lg text-bright placeholder:text-subtle focus:outline-none focus:border-accent shadow-inner"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowSearchModal(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-void border border-border text-subtle hover:text-bright"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-accent text-void hover:bg-accent-glow shadow"
                >
                  <Search className="w-3.5 h-3.5" />
                  <span>Search</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Discovery Drawer */}
      <SiteDiscoveryDrawer
        isOpen={isDiscoveryOpen}
        feed={discoveryFeed}
        isLoading={isCrawling}
        error={discoveryError}
        onClose={() => setIsDiscoveryOpen(false)}
        onSelectRelease={handleSelectRelease}
        onInstantPlay={handleInstantPlayRelease}
        onRetry={() => {
          if (activeSearchBookmark) {
            void handleSearchSubmit(undefined, searchQuery);
          } else {
            const target = lastCrawlUrl || discoveryFeed?.site_url || pageQuery;
            if (target.trim()) {
              void handleCrawl(target);
            }
          }
        }}
        onSearch={(q) => {
          if (activeSearchBookmark) {
            void handleSearchSubmit(undefined, q);
          } else {
            const currentUrl = lastCrawlUrl || discoveryFeed?.site_url || "";
            if (currentUrl.includes("iheart")) {
              void handleSearchIheart(q);
            } else if (currentUrl.includes("baddieseast")) {
              void handleCrawl(`https://baddieseast.com.co/search/${encodeURIComponent(q)}`);
            } else if (currentUrl.includes("yomi")) {
              void handleCrawl(`https://yomi.to/browse?query=${encodeURIComponent(q)}`);
            } else if (currentUrl.includes("balbums")) {
              void handleCrawl(`https://balbums.st/?search=${encodeURIComponent(q.trim())}&mode=broad&sort=latest`);
            } else if (currentUrl.includes("sxyprn")) {
              const tag = encodeURIComponent(q.trim().replace(/\s+/g, "-"));
              void handleCrawl(`https://www.sxyprn.com/${tag}.html`);
            } else if (currentUrl.includes("pornhub")) {
              void handleCrawl(`https://www.pornhub.com/video/search?search=${encodeURIComponent(q)}`);
            } else if (currentUrl) {
              void handleCrawl(`${currentUrl.replace(/\/$/, "")}/?s=${encodeURIComponent(q)}`);
            }
          }
        }}
        searchPlaceholder={activeSearchBookmark?.searchPlaceholder}
      />

      {/* Action Card / Bookmark Modal */}
      <AddStreamBookmarkModal
        isOpen={isActionModalOpen}
        onClose={() => {
          setIsActionModalOpen(false);
          setSelectedRelease(null);
        }}
        initialUrl={actionUrl}
        initialTitle={selectedRelease?.title}
        initialPoster={selectedRelease?.thumbnail || undefined}
        defaultLibraryType={
          selectedRelease?.media_type === "music" || activeSearchBookmark?.category === "radio"
            ? "music"
            : selectedRelease?.media_type === "adult" || activeSearchBookmark?.category === "adult"
            ? "adult"
            : selectedRelease?.media_type === "tv" || activeSearchBookmark?.category === "anime"
            ? "tv"
            : "movies"
        }
        autoInspect={true}
      />
    </div>
  );
}
