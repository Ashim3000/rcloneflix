import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Tv,
  Film,
  Star,
  Search,
  Download,
  CloudLightning,
  BookmarkPlus,
  ExternalLink,
  Settings,
  Play,
  RefreshCw,
  Check,
  AlertCircle,
  Sparkles,
  Radio,
  Layers,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
} from "lucide-react";
import { useAppStore, type MediaItem } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { persistItems } from "../../lib/libraryDb";
import {
  fetchIptvPlaylist,
  buildApolloUrls,
  buildXtreamUrls,
  checkXtreamAccount,
  getCinemetaPosterUrl,
  type IptvItem,
  type IptvPlaylist,
} from "../../lib/iptv";
import { CloudTranscodeModal } from "../../components/library/CloudTranscodeModal";
import { downloadWebStream } from "../../lib/streamResolver";

const ITEMS_PER_PAGE = 48;

export function LiveTvPage() {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const { iptvConfig, setIptvConfig, toggleIptvFavorite, libraries } = useAppStore();

  const [activeTab, setActiveTab] = useState<"live" | "movies" | "series" | "settings">("live");

  // Playlists data
  const [livePlaylist, setLivePlaylist] = useState<IptvPlaylist | null>(null);
  const [moviesPlaylist, setMoviesPlaylist] = useState<IptvPlaylist | null>(null);
  const [seriesPlaylist, setSeriesPlaylist] = useState<IptvPlaylist | null>(null);

  // Loading states
  const [loadingLive, setLoadingLive] = useState(false);
  const [loadingMovies, setLoadingMovies] = useState(false);
  const [loadingSeries, setLoadingSeries] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [currentPage, setCurrentPage] = useState(1);

  // Account Form State
  const [provider, setProvider] = useState<"apollo" | "generic" | "xtream">(iptvConfig.provider || "apollo");
  const [username, setUsername] = useState(iptvConfig.username || "");
  const [password, setPassword] = useState(iptvConfig.password || "");
  const [domain, setDomain] = useState(iptvConfig.domain || "tvnow.best");
  const [serverUrl, setServerUrl] = useState(iptvConfig.serverUrl || "http://proxpanel.me:8080");
  const [outputFormat, setOutputFormat] = useState<"ts" | "m3u8">(iptvConfig.outputFormat || "ts");
  const [genericM3u, setGenericM3u] = useState(iptvConfig.m3uUrl || "");
  const [genericEpg, setGenericEpg] = useState(iptvConfig.epgUrl || "");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [xtreamAccount, setXtreamAccount] = useState<any>(null);
  const [isTestingXtream, setIsTestingXtream] = useState(false);

  // Cloud Transcode Modal State
  const [transcodeModalOpen, setTranscodeModalOpen] = useState(false);
  const [transcodeTarget, setTranscodeTarget] = useState<{
    url: string;
    title: string;
    type: "movies" | "tv";
  } | null>(null);

  // Compute Active URLs based on configuration
  const resolvedUrls = useMemo(() => {
    if (iptvConfig.provider === "apollo") {
      const u = iptvConfig.username || "";
      const p = iptvConfig.password || "";
      const d = iptvConfig.domain || "tvnow.best";
      return buildApolloUrls(u, p, d);
    }
    if (iptvConfig.provider === "xtream") {
      const s = iptvConfig.serverUrl || "http://proxpanel.me:8080";
      const u = iptvConfig.username || "";
      const p = iptvConfig.password || "";
      const out = iptvConfig.outputFormat || "ts";
      return buildXtreamUrls(s, u, p, out);
    }
    return {
      liveTv: iptvConfig.m3uUrl || "",
      movies: "",
      tvShows: "",
      epg: iptvConfig.epgUrl || "",
    };
  }, [iptvConfig]);

  // Load Live TV on mount or URL change
  useEffect(() => {
    if (activeTab === "live" && !livePlaylist && resolvedUrls.liveTv) {
      loadLiveTv(false);
    } else if (activeTab === "movies" && !moviesPlaylist && resolvedUrls.movies) {
      loadMovies(false);
    } else if (activeTab === "series" && !seriesPlaylist && resolvedUrls.tvShows) {
      loadSeries(false);
    }
  }, [activeTab, resolvedUrls]);

  // Reset page when tab, category, or search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, selectedCategory, searchQuery]);

  const loadLiveTv = async (force: boolean = false) => {
    if (!resolvedUrls.liveTv) return;
    setLoadingLive(true);
    setErrorMsg(null);
    try {
      const data = await fetchIptvPlaylist(resolvedUrls.liveTv, force);
      setLivePlaylist(data);
    } catch (err: any) {
      console.error("Failed loading Live TV:", err);
      setErrorMsg(String(err));
      addToast(`Failed loading Live TV: ${err}`, "error");
    } finally {
      setLoadingLive(false);
    }
  };

  const loadMovies = async (force: boolean = false) => {
    if (!resolvedUrls.movies) return;
    setLoadingMovies(true);
    setErrorMsg(null);
    try {
      const data = await fetchIptvPlaylist(resolvedUrls.movies, force);
      setMoviesPlaylist(data);
    } catch (err: any) {
      console.error("Failed loading Movies VOD:", err);
      setErrorMsg(String(err));
      addToast(`Failed loading Movies VOD: ${err}`, "error");
    } finally {
      setLoadingMovies(false);
    }
  };

  const loadSeries = async (force: boolean = false) => {
    if (!resolvedUrls.tvShows) return;
    setLoadingSeries(true);
    setErrorMsg(null);
    try {
      const data = await fetchIptvPlaylist(resolvedUrls.tvShows, force);
      setSeriesPlaylist(data);
    } catch (err: any) {
      console.error("Failed loading Series VOD:", err);
      setErrorMsg(String(err));
      addToast(`Failed loading Series VOD: ${err}`, "error");
    } finally {
      setLoadingSeries(false);
    }
  };

  const handleSaveSettings = () => {
    setIptvConfig({
      provider,
      username: username.trim(),
      password: password.trim(),
      domain: domain.trim(),
      serverUrl: serverUrl.trim(),
      outputFormat,
      m3uUrl: genericM3u.trim(),
      epgUrl: genericEpg.trim(),
    });
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2500);
    addToast("IPTV settings saved successfully!", "success");

    // Invalidate in-memory caches so re-fetch uses new settings
    setLivePlaylist(null);
    setMoviesPlaylist(null);
    setSeriesPlaylist(null);
  };

  const handleTestXtream = async () => {
    if (!serverUrl || !username || !password) {
      addToast("Please enter server URL, username, and password", "error");
      return;
    }
    setIsTestingXtream(true);
    try {
      const data = await checkXtreamAccount(serverUrl, username, password);
      if (data?.user_info?.auth === 1 || data?.user_info?.status === "Active") {
        setXtreamAccount(data);
        addToast(`Xtream Connection Successful! Status: ${data.user_info.status}`, "success");
      } else {
        const msg = data?.user_info?.message || "Authentication failed";
        addToast(`Xtream Connection Failed: ${msg}`, "error");
      }
    } catch (err: any) {
      addToast(`Connection error: ${err.message || String(err)}`, "error");
    } finally {
      setIsTestingXtream(false);
    }
  };

  const handleForceRefreshAll = async () => {
    addToast("Refreshed IPTV playlists from source...", "info");
    if (activeTab === "live") await loadLiveTv(true);
    else if (activeTab === "movies") await loadMovies(true);
    else if (activeTab === "series") await loadSeries(true);
    else {
      await loadLiveTv(true);
    }
  };

  // ── Tuning into Live Stream / VOD Playback ──────────────────────────────────
  const handlePlayItem = (item: IptvItem, type: "live" | "movie" | "series") => {
    const isLive = type === "live";
    const mediaItem: MediaItem = {
      id: `iptv-${item.id}`,
      libraryId: isLive ? "iptv-live" : type === "movie" ? "iptv-movies" : "iptv-tv",
      libraryType: type === "movie" ? "movies" : "tv",
      remotePath: item.stream_url,
      filename: `${item.name}.${isLive ? "m3u8" : "mp4"}`,
      title: item.name,
      year: item.year,
      posterUrl: item.logo || getCinemetaPosterUrl(item.imdb_id),
      overview: isLive
        ? `Live Channel • Category: ${item.group}`
        : `${type === "movie" ? "Movie" : "Series"} • ${item.group}`,
      metadataSource: item.imdb_id ? "cinemeta" : "manual",
      metadataId: item.imdb_id,
      addedAt: Date.now(),
      lastScannedAt: Date.now(),
      isSourceBookmark: true,
      sourceUrl: item.stream_url,
      sourceProvider: iptvConfig.provider === "apollo" ? "Apollo Group TV" : "IPTV",
      ...(type === "series"
        ? {
            season: item.season || 1,
            episode: item.episode || 1,
            showTitle: item.group || item.name,
            showId: item.imdb_id || item.group || item.name,
          }
        : {}),
    };

    navigate("/play/video", { state: { item: mediaItem } });
  };

  // ── Bookmark VOD or Live Channel to Library (0 MB) ──────────────────────────
  const handleBookmarkToLibrary = async (item: IptvItem, type: "movies" | "tv") => {
    const targetLib =
      libraries.find((l) => l.type === type) ||
      libraries[0] || { id: `default-${type}`, name: `${type.toUpperCase()} Library` };

    const newItem: MediaItem = {
      id: `iptv-${item.id}-${Date.now()}`,
      libraryId: targetLib.id,
      libraryType: type,
      remotePath: item.stream_url,
      filename: `${item.name}.mp4`,
      title: item.name,
      year: item.year,
      posterUrl: item.logo || getCinemetaPosterUrl(item.imdb_id),
      overview: `On-Demand ${type === "movies" ? "Movie" : "Series"} • ${item.group}`,
      metadataSource: item.imdb_id ? "cinemeta" : "manual",
      metadataId: item.imdb_id,
      addedAt: Date.now(),
      lastScannedAt: Date.now(),
      isSourceBookmark: true,
      sourceUrl: item.stream_url,
      sourceProvider: iptvConfig.provider === "apollo" ? "Apollo Group TV" : "IPTV",
      ...(type === "tv"
        ? {
            season: item.season || 1,
            episode: item.episode || 1,
            showTitle: item.group || item.name,
            showId: item.imdb_id || item.group || item.name,
          }
        : {}),
    };

    try {
      useAppStore.getState().upsertMediaItem(newItem);
      await persistItems([newItem]);
      addToast(`Bookmarked "${item.name}" to ${targetLib.name} (0 MB)`, "success");
    } catch (err: any) {
      console.error("Failed bookmarking item:", err);
      addToast(`Failed bookmarking item: ${err}`, "error");
    }
  };

  // ── Local Download via yt-dlp ───────────────────────────────────────────────
  const handleDownloadItem = async (item: IptvItem) => {
    addToast(`Starting local download for "${item.name}"...`, "info");
    try {
      const savedPath = await downloadWebStream({
        download_id: `iptv-${item.id}-${Date.now()}`,
        stream_url: item.stream_url,
        original_url: item.stream_url,
        filename: `${item.name.replace(/[/\\?%*:|"<>]/g, "_")}.mp4`,
      });
      addToast(`Downloaded to: ${savedPath}`, "success");
    } catch (err: any) {
      console.error("Download failed:", err);
      addToast(`Download failed: ${err}`, "error");
    }
  };

  // Active playlist for current tab
  const currentPlaylist =
    activeTab === "live"
      ? livePlaylist
      : activeTab === "movies"
      ? moviesPlaylist
      : activeTab === "series"
      ? seriesPlaylist
      : null;

  // Filter items by category & search query
  const filteredItems = useMemo(() => {
    if (!currentPlaylist) return [];
    let list = currentPlaylist.items;

    if (selectedCategory === "favorites") {
      const favSet = new Set(iptvConfig.favoriteChannels || []);
      list = list.filter((it) => favSet.has(it.id));
    } else if (selectedCategory !== "all") {
      list = list.filter((it) => it.group.toLowerCase() === selectedCategory.toLowerCase());
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          it.group.toLowerCase().includes(q) ||
          (it.imdb_id && it.imdb_id.toLowerCase().includes(q))
      );
    }

    return list;
  }, [currentPlaylist, selectedCategory, searchQuery, iptvConfig.favoriteChannels]);

  // Pagination slice
  const totalPages = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
  const paginatedItems = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredItems.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredItems, currentPage]);

  const favoritesCount = useMemo(() => {
    if (!livePlaylist) return 0;
    const favSet = new Set(iptvConfig.favoriteChannels || []);
    return livePlaylist.items.filter((it) => favSet.has(it.id)).length;
  }, [livePlaylist, iptvConfig.favoriteChannels]);

  return (
    <div className="flex flex-col h-full bg-void overflow-hidden">
      {/* ── Top Header & Tab Navigation ──────────────────────────────────── */}
      <div className="flex-shrink-0 bg-surface border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <Tv size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold font-display text-text flex items-center gap-2">
                Live TV & IPTV
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-normal border border-amber-500/40">
                  Apollo Addon
                </span>
              </h1>
              <p className="text-xs text-subtle">
                {livePlaylist
                  ? `${livePlaylist.total_count.toLocaleString()} Live Channels • 50k+ VOD Titles • Native VLC Stream`
                  : "Connect your IPTV playlist or Apollo Group TV subscription"}
              </p>
            </div>
          </div>

          {/* Tab buttons */}
          <div className="flex items-center gap-1.5 p-1 bg-panel rounded-xl border border-border">
            <button
              onClick={() => setActiveTab("live")}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === "live"
                  ? "bg-amber-500 text-void font-semibold shadow-md"
                  : "text-subtle hover:text-text hover:bg-surface/60"
              }`}
            >
              <Radio size={14} />
              <span>Live Channels</span>
              {livePlaylist && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-void/30">
                  {livePlaylist.total_count}
                </span>
              )}
            </button>

            {iptvConfig.provider === "apollo" && (
              <>
                <button
                  onClick={() => setActiveTab("movies")}
                  className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    activeTab === "movies"
                      ? "bg-amber-500 text-void font-semibold shadow-md"
                      : "text-subtle hover:text-text hover:bg-surface/60"
                  }`}
                >
                  <Film size={14} />
                  <span>Movies (VOD)</span>
                  {moviesPlaylist && (
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-void/30">
                      {moviesPlaylist.total_count}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => setActiveTab("series")}
                  className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    activeTab === "series"
                      ? "bg-amber-500 text-void font-semibold shadow-md"
                      : "text-subtle hover:text-text hover:bg-surface/60"
                  }`}
                >
                  <Layers size={14} />
                  <span>Series (VOD)</span>
                  {seriesPlaylist && (
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-void/30">
                      {seriesPlaylist.total_count}
                    </span>
                  )}
                </button>
              </>
            )}

            <button
              onClick={() => setActiveTab("settings")}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === "settings"
                  ? "bg-amber-500 text-void font-semibold shadow-md"
                  : "text-subtle hover:text-text hover:bg-surface/60"
              }`}
            >
              <Settings size={14} />
              <span>Account & Setup</span>
            </button>
          </div>
        </div>

        {/* ── Partner Affiliate Callout ──────────────────────────────────── */}
        <div className="mt-3 relative overflow-hidden rounded-xl border border-amber-500/20 bg-gradient-to-r from-amber-500/10 via-panel/80 to-surface/90 p-3 shadow-inner">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <div className="p-1.5 mt-0.5 rounded-lg bg-amber-500/20 text-amber-400 flex-shrink-0">
                <Sparkles size={16} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-amber-300 uppercase tracking-wider">
                    Official Addon Partner
                  </span>
                  <span className="text-[10px] text-muted">• Full RcloneFlix Integration</span>
                </div>
                <p className="text-xs text-text/90 mt-0.5">
                  <strong>Apollo Group TV</strong> powers 1,000+ Premium Live Channels (ESPN, Bally Sports, RedZone, Locals) & 50,000+ On-Demand Titles with zero buffering and multi-screen support.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => window.open("https://apollogroup.cc", "_blank")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-void text-xs font-semibold shadow-sm transition-all"
              >
                <span>Get Apollo Group TV</span>
                <ExternalLink size={12} />
              </button>
              <button
                onClick={handleForceRefreshAll}
                title="Force refresh playlist from server (bypasses local disk cache)"
                className="p-1.5 rounded-lg bg-panel hover:bg-surface border border-border text-subtle hover:text-text text-xs transition-all"
              >
                <RefreshCw size={14} className={loadingLive || loadingMovies || loadingSeries ? "animate-spin" : ""} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Main Tab Content ──────────────────────────────────────────────── */}
      {activeTab === "settings" ? (
        <div className="flex-1 overflow-y-auto p-6 max-w-4xl mx-auto w-full">
          <div className="bg-surface rounded-2xl border border-border p-6 shadow-sm space-y-6">
            <div>
              <h2 className="text-lg font-bold text-text flex items-center gap-2">
                <Settings size={20} className="text-amber-400" />
                IPTV & Provider Configuration
              </h2>
              <p className="text-xs text-subtle mt-1">
                Configure your Apollo Group TV trial/subscription credentials or supply your own custom M3U playlist.
              </p>
            </div>

            {/* Provider selector */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <button
                onClick={() => setProvider("xtream")}
                className={`p-4 rounded-xl border text-left transition-all ${
                  provider === "xtream"
                    ? "border-amber-500/80 bg-amber-500/10 text-text ring-1 ring-amber-500/50"
                    : "border-border bg-panel/50 text-subtle hover:border-border/80"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-sm text-text">Xtream Codes API</span>
                  {provider === "xtream" && <Check size={16} className="text-amber-400" />}
                </div>
                <p className="text-xs text-muted">
                  Connect via Server URL, Username & Password (proxpanel, standard XC panels).
                </p>
              </button>

              <button
                onClick={() => setProvider("apollo")}
                className={`p-4 rounded-xl border text-left transition-all ${
                  provider === "apollo"
                    ? "border-amber-500/80 bg-amber-500/10 text-text ring-1 ring-amber-500/50"
                    : "border-border bg-panel/50 text-subtle hover:border-border/80"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-sm text-text">Apollo Group TV</span>
                  {provider === "apollo" && <Check size={16} className="text-amber-400" />}
                </div>
                <p className="text-xs text-muted">
                  Automatic Live TV, VOD Movies, TV Series & EPG parsing via Apollo API edge.
                </p>
              </button>

              <button
                onClick={() => setProvider("generic")}
                className={`p-4 rounded-xl border text-left transition-all ${
                  provider === "generic"
                    ? "border-amber-500/80 bg-amber-500/10 text-text ring-1 ring-amber-500/50"
                    : "border-border bg-panel/50 text-subtle hover:border-border/80"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-sm text-text">Generic M3U Playlist</span>
                  {provider === "generic" && <Check size={16} className="text-amber-400" />}
                </div>
                <p className="text-xs text-muted">
                  Use any custom direct M3U/M3U8 URL or local file path with optional EPG XML.
                </p>
              </button>
            </div>

            {/* Xtream Codes Form */}
            {provider === "xtream" ? (
              <div className="space-y-4 pt-2">
                <div className="p-3.5 rounded-xl bg-amber-500/5 border border-amber-500/20 text-xs text-text/80 space-y-1">
                  <p className="font-semibold text-amber-400 flex items-center gap-1.5">
                    <Info size={14} />
                    Xtream Codes API Connection
                  </p>
                  <p>
                    Enter your IPTV panel host (e.g. <code>http://proxpanel.me:8080</code>), username, and password. Live TV channels, VOD movies, and TV series playlists are generated automatically.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text mb-1.5">
                    Server URL / Host
                  </label>
                  <input
                    type="text"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    placeholder="http://proxpanel.me:8080"
                    className="w-full px-3.5 py-2 rounded-xl bg-panel border border-border text-sm text-text focus:outline-none focus:border-amber-500"
                  />
                  <p className="text-[11px] text-muted mt-1">
                    Include the protocol and port (e.g. <code>http://proxpanel.me:8080</code>).
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-text mb-1.5">
                      Username
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="e.g. diazbents4258"
                      className="w-full px-3.5 py-2 rounded-xl bg-panel border border-border text-sm text-text focus:outline-none focus:border-amber-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-text mb-1.5">
                      Password
                    </label>
                    <input
                      type="text"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="e.g. talktow180"
                      className="w-full px-3.5 py-2 rounded-xl bg-panel border border-border text-sm text-text focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text mb-1.5">
                    Stream Output Format
                  </label>
                  <div className="flex gap-4 items-center">
                    <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
                      <input
                        type="radio"
                        name="outputFormat"
                        value="ts"
                        checked={outputFormat === "ts"}
                        onChange={() => setOutputFormat("ts")}
                        className="text-amber-500 focus:ring-amber-400"
                      />
                      <span>MPEG-TS (<code>output=ts</code> - Recommended for live streams)</span>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-text cursor-pointer">
                      <input
                        type="radio"
                        name="outputFormat"
                        value="m3u8"
                        checked={outputFormat === "m3u8"}
                        onChange={() => setOutputFormat("m3u8")}
                        className="text-amber-500 focus:ring-amber-400"
                      />
                      <span>HLS (<code>output=m3u8</code>)</span>
                    </label>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <button
                    type="button"
                    onClick={handleTestXtream}
                    disabled={isTestingXtream}
                    className="px-4 py-2 rounded-xl bg-panel hover:bg-white/5 border border-border text-text text-xs font-semibold flex items-center gap-2 transition-colors disabled:opacity-50"
                  >
                    {isTestingXtream ? (
                      <>
                        <Loader2 size={14} className="animate-spin text-amber-400" />
                        <span>Testing Connection...</span>
                      </>
                    ) : (
                      <>
                        <RefreshCw size={14} className="text-amber-400" />
                        <span>Test Connection</span>
                      </>
                    )}
                  </button>

                  {xtreamAccount && xtreamAccount.user_info && (
                    <div className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                      <Check size={14} />
                      <span>
                        Status: <strong>{xtreamAccount.user_info.status}</strong> · Max Cons: <strong>{xtreamAccount.user_info.max_connections || "1"}</strong>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ) : provider === "apollo" ? (
              /* Apollo Credentials Form */
              <div className="space-y-4 pt-2">
                <div className="p-3.5 rounded-xl bg-amber-500/5 border border-amber-500/20 text-xs text-text/80 space-y-1">
                  <p className="font-semibold text-amber-400 flex items-center gap-1.5">
                    <Info size={14} />
                    Apollo Group TV Edge Connection
                  </p>
                  <p>
                    Connecting via the official Apollo edge domain (<code>tvnow.best</code>). The full catalog of 1,000+ live channels and 50,000+ movies/shows parses automatically.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-text mb-1.5">
                      Username / Email
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="e.g. akatwhitty"
                      className="w-full px-3.5 py-2 rounded-xl bg-panel border border-border text-sm text-text focus:outline-none focus:border-amber-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-text mb-1.5">
                      Password / Access Code
                    </label>
                    <input
                      type="text"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="e.g. 143532"
                      className="w-full px-3.5 py-2 rounded-xl bg-panel border border-border text-sm text-text focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text mb-1.5">
                    Edge Domain
                  </label>
                  <input
                    type="text"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="tvnow.best"
                    className="w-full px-3.5 py-2 rounded-xl bg-panel border border-border text-sm text-text focus:outline-none focus:border-amber-500"
                  />
                  <p className="text-[11px] text-muted mt-1">
                    Default edge server is <code>tvnow.best</code> (official Apollo Group TV endpoint).
                  </p>
                </div>
              </div>
            ) : (
              /* Generic M3U Form */
              <div className="space-y-4 pt-2">
                <div>
                  <label className="block text-xs font-semibold text-text mb-1.5">
                    M3U / M3U8 Playlist URL
                  </label>
                  <input
                    type="text"
                    value={genericM3u}
                    onChange={(e) => setGenericM3u(e.target.value)}
                    placeholder="https://example.com/playlist.m3u8"
                    className="w-full px-3.5 py-2 rounded-xl bg-panel border border-border text-sm text-text focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text mb-1.5">
                    EPG XML URL (Optional)
                  </label>
                  <input
                    type="text"
                    value={genericEpg}
                    onChange={(e) => setGenericEpg(e.target.value)}
                    placeholder="https://example.com/epg.xml.gz"
                    className="w-full px-3.5 py-2 rounded-xl bg-panel border border-border text-sm text-text focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center justify-between pt-4 border-t border-border">
              <div className="text-xs text-subtle">
                {livePlaylist && (
                  <span>
                    Loaded {livePlaylist.total_count.toLocaleString()} channels across {livePlaylist.categories.length} categories.
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                {saveSuccess && (
                  <span className="text-xs text-teal flex items-center gap-1">
                    <Check size={14} /> Saved!
                  </span>
                )}
                <button
                  onClick={handleSaveSettings}
                  className="px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-void text-xs font-bold transition-all shadow-md"
                >
                  Save & Apply Settings
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ── Live / Movies / Series Catalog Views ──────────────────────────── */
        <div className="flex-1 flex overflow-hidden">
          {/* Category Sidebar */}
          <aside className="w-60 flex-shrink-0 bg-surface/50 border-r border-border flex flex-col h-full overflow-hidden">
            <div className="p-3 border-b border-border">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-2.5 text-subtle" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={`Search ${activeTab === "live" ? "channels" : "titles"}...`}
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-panel border border-border text-xs text-text placeholder-subtle focus:outline-none focus:border-amber-500"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
              <button
                onClick={() => setSelectedCategory("all")}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                  selectedCategory === "all"
                    ? "bg-amber-500/15 text-amber-400 font-semibold border-l-2 border-amber-500"
                    : "text-subtle hover:text-text hover:bg-panel/60"
                }`}
              >
                <span>All Categories</span>
                {currentPlaylist && (
                  <span className="text-[10px] text-muted">{currentPlaylist.total_count}</span>
                )}
              </button>

              {activeTab === "live" && favoritesCount > 0 && (
                <button
                  onClick={() => setSelectedCategory("favorites")}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                    selectedCategory === "favorites"
                      ? "bg-amber-500/15 text-amber-400 font-semibold border-l-2 border-amber-500"
                      : "text-subtle hover:text-text hover:bg-panel/60"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <Star size={12} className="text-amber-400 fill-amber-400" />
                    <span>Favorites</span>
                  </span>
                  <span className="text-[10px] text-muted">{favoritesCount}</span>
                </button>
              )}

              {currentPlaylist?.categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-xs transition-all text-left truncate ${
                    selectedCategory.toLowerCase() === cat.toLowerCase()
                      ? "bg-amber-500/15 text-amber-400 font-semibold border-l-2 border-amber-500"
                      : "text-subtle hover:text-text hover:bg-panel/60"
                  }`}
                >
                  <span className="truncate">{cat}</span>
                </button>
              ))}
            </div>
          </aside>

          {/* Main Grid View */}
          <main className="flex-1 flex flex-col h-full overflow-hidden bg-void">
            {/* Loading Spinner */}
            {(loadingLive || loadingMovies || loadingSeries) && (
              <div className="flex-1 flex flex-col items-center justify-center gap-3">
                <RefreshCw size={28} className="animate-spin text-amber-400" />
                <p className="text-xs text-subtle">
                  Loading {activeTab === "live" ? "Live TV Channels" : activeTab === "movies" ? "Movies Catalog" : "TV Series"}...
                </p>
              </div>
            )}

            {/* Error Display */}
            {errorMsg && !(loadingLive || loadingMovies || loadingSeries) && (
              <div className="p-6">
                <div className="p-4 rounded-xl bg-crimson/10 border border-crimson/30 text-crimson text-xs flex items-center gap-3">
                  <AlertCircle size={18} />
                  <div className="flex-1">
                    <p className="font-semibold">Unable to load playlist</p>
                    <p className="opacity-90">{errorMsg}</p>
                  </div>
                  <button
                    onClick={() => {
                      if (activeTab === "live") loadLiveTv(true);
                      else if (activeTab === "movies") loadMovies(true);
                      else loadSeries(true);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-crimson/20 hover:bg-crimson/30 font-semibold transition-all"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}

            {/* Empty State */}
            {!loadingLive && !loadingMovies && !loadingSeries && filteredItems.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                <Tv size={36} className="text-muted mb-3" />
                <h3 className="text-sm font-semibold text-text">No items found</h3>
                <p className="text-xs text-subtle mt-1 max-w-sm">
                  {searchQuery
                    ? `No matches for "${searchQuery}". Try a different keyword.`
                    : "Configure your IPTV playlist URL in the Account & Setup tab to get started."}
                </p>
                <button
                  onClick={() => setActiveTab("settings")}
                  className="mt-4 px-4 py-2 rounded-xl bg-amber-500 text-void font-semibold text-xs shadow-md"
                >
                  Configure Account
                </button>
              </div>
            )}

            {/* Grid Content */}
            {!loadingLive && !loadingMovies && !loadingSeries && paginatedItems.length > 0 && (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                  {activeTab === "live" ? (
                    /* ── Live Channel Cards Grid ──────────────────────── */
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
                      {paginatedItems.map((ch) => {
                        const isFav = iptvConfig.favoriteChannels?.includes(ch.id);
                        return (
                          <div
                            key={ch.id}
                            className="group relative bg-surface border border-border/80 hover:border-amber-500/50 rounded-xl p-3 flex flex-col justify-between transition-all hover:shadow-lg hover:bg-panel/60"
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-panel border border-border text-subtle truncate max-w-[120px]">
                                {ch.group}
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleIptvFavorite(ch.id);
                                }}
                                className="p-1 rounded hover:bg-surface text-subtle hover:text-amber-400 transition-all"
                                title={isFav ? "Remove from Favorites" : "Add to Favorites"}
                              >
                                <Star
                                  size={13}
                                  className={isFav ? "text-amber-400 fill-amber-400" : ""}
                                />
                              </button>
                            </div>

                            <div
                              onClick={() => handlePlayItem(ch, "live")}
                              className="cursor-pointer flex flex-col items-center text-center py-2"
                            >
                              {ch.logo ? (
                                <img
                                  src={ch.logo}
                                  alt={ch.name}
                                  loading="lazy"
                                  onError={(e) => {
                                    (e.target as HTMLElement).style.display = "none";
                                  }}
                                  className="h-12 w-auto max-w-[120px] object-contain mb-2 filter drop-shadow"
                                />
                              ) : (
                                <div className="h-12 w-12 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 font-bold text-xs mb-2">
                                  {ch.name.slice(0, 3).toUpperCase()}
                                </div>
                              )}
                              <h4 className="text-xs font-semibold text-text line-clamp-2 group-hover:text-amber-400 transition-colors">
                                {ch.name}
                              </h4>
                            </div>

                            <button
                              onClick={() => handlePlayItem(ch, "live")}
                              className="mt-2 w-full py-1.5 rounded-lg bg-panel group-hover:bg-amber-500 text-subtle group-hover:text-void text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
                            >
                              <Play size={12} className="fill-current" />
                              <span>Tune In</span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    /* ── VOD Movies / Series Cards Grid ─────────────────── */
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3 sm:gap-4">
                      {paginatedItems.map((vod) => {
                        const poster = getCinemetaPosterUrl(vod.imdb_id) || vod.logo;
                        return (
                          <div
                            key={vod.id}
                            className="group relative bg-surface border border-border/80 hover:border-amber-500/60 rounded-xl overflow-hidden flex flex-col transition-all hover:shadow-xl"
                          >
                            {/* Poster Aspect Ratio Container */}
                            <div
                              onClick={() =>
                                handlePlayItem(
                                  vod,
                                  activeTab === "movies" ? "movie" : "series"
                                )
                              }
                              className="relative aspect-[2/3] bg-panel cursor-pointer overflow-hidden"
                            >
                              {poster ? (
                                <img
                                  src={poster}
                                  alt={vod.name}
                                  loading="lazy"
                                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                  onError={(e) => {
                                    (e.target as HTMLElement).style.display = "none";
                                  }}
                                />
                              ) : (
                                <div className="w-full h-full flex flex-col items-center justify-center p-3 text-center bg-panel/80">
                                  <Film size={24} className="text-muted mb-2" />
                                  <span className="text-[10px] text-subtle font-medium line-clamp-3">
                                    {vod.name}
                                  </span>
                                </div>
                              )}

                              {/* Hover Overlay with Action Buttons */}
                              <div className="absolute inset-0 bg-void/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2 p-2 backdrop-blur-xs">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handlePlayItem(
                                      vod,
                                      activeTab === "movies" ? "movie" : "series"
                                    )
                                  }}
                                  className="w-full py-1.5 px-2 rounded-lg bg-amber-500 text-void font-bold text-xs flex items-center justify-center gap-1 shadow-md hover:bg-amber-400 transition-all"
                                >
                                  <Play size={12} className="fill-current" />
                                  <span>Play Now</span>
                                </button>

                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleBookmarkToLibrary(
                                      vod,
                                      activeTab === "movies" ? "movies" : "tv"
                                    );
                                  }}
                                  className="w-full py-1.5 px-2 rounded-lg bg-panel hover:bg-surface border border-border text-text font-medium text-[11px] flex items-center justify-center gap-1 transition-all"
                                  title="Add to permanent Library (0 MB storage)"
                                >
                                  <BookmarkPlus size={12} className="text-amber-400" />
                                  <span>Bookmark (0 MB)</span>
                                </button>

                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setTranscodeTarget({
                                      url: vod.stream_url,
                                      title: vod.name,
                                      type: activeTab === "movies" ? "movies" : "tv",
                                    });
                                    setTranscodeModalOpen(true);
                                  }}
                                  className="w-full py-1 px-2 rounded-lg bg-panel hover:bg-surface border border-border text-subtle hover:text-teal font-medium text-[10px] flex items-center justify-center gap-1 transition-all"
                                  title="Cloud transcode and upload to Rclone remotes via Kaggle GPU"
                                >
                                  <CloudLightning size={11} className="text-teal" />
                                  <span>Kaggle Transcode</span>
                                </button>

                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDownloadItem(vod);
                                  }}
                                  className="w-full py-1 px-2 rounded-lg bg-panel hover:bg-surface border border-border text-subtle hover:text-text font-medium text-[10px] flex items-center justify-center gap-1 transition-all"
                                  title="Download to local disk via yt-dlp"
                                >
                                  <Download size={11} />
                                  <span>Download</span>
                                </button>
                              </div>
                            </div>

                            {/* Title & Metadata Footer */}
                            <div className="p-2 flex flex-col justify-between flex-1 bg-surface">
                              <h4
                                title={vod.name}
                                className="text-xs font-semibold text-text truncate group-hover:text-amber-400 transition-colors"
                              >
                                {vod.name}
                              </h4>
                              <div className="flex items-center justify-between text-[10px] text-muted mt-1">
                                <span>{vod.year || vod.group}</span>
                                {vod.imdb_id && (
                                  <span className="px-1 py-0.2 rounded bg-panel border border-border text-amber-300 font-mono">
                                    IMDb
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* ── Pagination Footer ────────────────────────────────────── */}
                {totalPages > 1 && (
                  <div className="flex-shrink-0 bg-surface border-t border-border px-6 py-3 flex items-center justify-between text-xs text-subtle">
                    <div>
                      Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1}–
                      {Math.min(currentPage * ITEMS_PER_PAGE, filteredItems.length)} of{" "}
                      {filteredItems.length.toLocaleString()} items
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        className="p-1.5 rounded-lg bg-panel hover:bg-surface border border-border text-text disabled:opacity-40 disabled:pointer-events-none transition-all"
                      >
                        <ChevronLeft size={16} />
                      </button>

                      <span className="font-semibold text-text px-2">
                        Page {currentPage} of {totalPages}
                      </span>

                      <button
                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                        className="p-1.5 rounded-lg bg-panel hover:bg-surface border border-border text-text disabled:opacity-40 disabled:pointer-events-none transition-all"
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
      )}

      {/* ── Kaggle GPU Cloud Transcode Modal ──────────────────────────────── */}
      {transcodeModalOpen && transcodeTarget && (
        <CloudTranscodeModal
          isOpen={transcodeModalOpen}
          onClose={() => {
            setTranscodeModalOpen(false);
            setTranscodeTarget(null);
          }}
          sourceInput={transcodeTarget.url}
          initialTitle={transcodeTarget.title}
          mediaType={transcodeTarget.type}
        />
      )}
    </div>
  );
}
