import { useState, useMemo, useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Star, Play, ChevronDown, ChevronUp, Download, Trash2, CheckCircle2, Wrench, Copy, Check, Info, Globe, Bell, BellRing, RefreshCw, Sparkles, Radio, Settings2 } from "lucide-react";
import { useAppStore, selectTvShows, type TvShow, type TvEpisode, type MediaItem } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { downloadSingleItem, downloadSeason } from "../../lib/downloadManager";
import { FavoriteButton } from "../../components/common/FavoriteButton";
import { UserTagsEditor } from "../../components/common/UserTagsEditor";
import { AddToPlaylistButton } from "../../components/playlist/AddToPlaylistButton";
import { FixMatchModal } from "../../components/library/FixMatchModal";
import { EasynewsSearchModal } from "../../components/discovery/EasynewsSearchModal";
import { StremioStreamsModal } from "../../components/discovery/StremioStreamsModal";
import { InfiniDyskSearchModal } from "../../components/discovery/InfiniDyskSearchModal";
import { SubscribeModal } from "../../components/tv/SubscribeModal";
import { MediaShelf } from "../../components/library/MediaShelf";
import { fetchMoreLikeThis } from "../../lib/recommendations";
import { resolveDiscoveryCardNavigation } from "../../lib/discoveryMatching";
import { fetchCanonicalSeriesEpisodes, formatEpisodeAirDate, type CanonicalEpisode, type CanonicalSeries } from "../../lib/tvMetadata";
import { checkSingleTvSubscription } from "../../lib/tvSubscriptionEngine";

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function getEpisodeMediaSpecs(ep: TvEpisode) {
  const container = ep.container || ep.filename.split(".").pop()?.toUpperCase() || "";
  let resolution = ep.resolution;
  if (!resolution) {
    const fn = ep.filename.toLowerCase();
    if (fn.includes("2160p") || fn.includes("4k") || fn.includes("uhd")) resolution = "4K";
    else if (fn.includes("1080p") || fn.includes("1080i") || fn.includes("fhd")) resolution = "1080p";
    else if (fn.includes("720p") || fn.includes("hd")) resolution = "720p";
    else if (fn.includes("480p") || fn.includes("576p") || fn.includes("sd")) resolution = "480p";
  }
  let codec = ep.videoCodec;
  if (!codec) {
    const fn = ep.filename.toLowerCase();
    if (fn.includes("x265") || fn.includes("h265") || fn.includes("hevc")) codec = "HEVC";
    else if (fn.includes("x264") || fn.includes("h264") || fn.includes("avc")) codec = "H.264";
    else if (fn.includes("av1")) codec = "AV1";
    else if (fn.includes("vp9")) codec = "VP9";
  }
  const size = formatFileSize(ep.sizeBytes);
  return { container, resolution, codec, size };
}

export function TvShowPage() {
  const params = useParams<{ showId?: string; "*"?: string }>();
  const showId = params.showId || params["*"];
  const location = useLocation();
  const navigate = useNavigate();
  const { mediaItems, watchProgress, markMultipleCompleted, tvSubscriptions, upsertTvSubscription, removeTvSubscription, libraries } = useAppStore();

  const show = useMemo(() => {
    const locShow = location.state?.show as TvShow | undefined;
    if (locShow && (!showId || locShow.showId === showId)) {
      return locShow;
    }
    if (showId) {
      const shows = selectTvShows(mediaItems);
      const decoded = decodeURIComponent(showId);
      const found = shows.find(
        (s) =>
          s.showId === showId ||
          s.showId === decoded ||
          s.title.toLowerCase() === decoded.toLowerCase()
      );
      if (found) return found;
    }
    return locShow;
  }, [showId, location.state, mediaItems]);

  const [canonicalSeries, setCanonicalSeries] = useState<CanonicalSeries | null>(null);
  const [loadingCanonical, setLoadingCanonical] = useState(false);
  const [easynewsTargetQuery, setEasynewsTargetQuery] = useState<string | null>(null);
  const [infiniDyskTargetQuery, setInfiniDyskTargetQuery] = useState<string | null>(null);
  const [subscribeModalOpen, setSubscribeModalOpen] = useState(false);
  const [stremioTargetItem, setStremioTargetItem] = useState<MediaItem | null>(null);
  const [stremioTargetSeason, setStremioTargetSeason] = useState<number | undefined>(undefined);
  const [stremioTargetEpisode, setStremioTargetEpisode] = useState<number | undefined>(undefined);

  const firstEpisode = useMemo(() => {
    if (!show) return undefined;
    for (const s of Object.values(show.seasons)) {
      if (s.episodes.length > 0) return s.episodes[0];
    }
    return undefined;
  }, [show]);

  const inferredSeriesFolderPath = useMemo(() => {
    const isEphemeralRemote = (p: string) =>
      /^(?:shared_)?(?:streamtape|dropmb|catbox|doodstream):/i.test(p.trim());

    const rp = firstEpisode?.remotePath || "";
    if (rp && !isEphemeralRemote(rp)) {
      const lastSlash = rp.lastIndexOf("/");
      if (lastSlash !== -1) {
        const parent = rp.slice(0, lastSlash);
        // If parent ends in "/Season X", go one level up to the series root folder
        if (/\/season\s*\d+$/i.test(parent)) {
          const grandSlash = parent.lastIndexOf("/");
          if (grandSlash !== -1) return parent.slice(0, grandSlash);
        }
        return parent;
      }
    }
    const tvLib =
      libraries.find((l) => l.id === show?.libraryId && !l.isSharedPass && l.remotePaths.some((p) => !isEphemeralRemote(p))) ||
      libraries.find((l) => l.type === "tv" && !l.isSharedPass && l.remotePaths.some((p) => !isEphemeralRemote(p)));
    const base = tvLib?.remotePaths.find((p) => !isEphemeralRemote(p))?.replace(/\/+$/, "");
    if (base && show?.title) {
      const safeTitle = show.title.replace(/[/\\?%*:|"<>]/g, "").trim();
      return `${base}/${safeTitle}`;
    }
    return "";
  }, [firstEpisode, libraries, show?.libraryId, show?.title]);

  useEffect(() => {
    if (!show?.title) return;
    let isMounted = true;
    setLoadingCanonical(true);

    const imdbId = show.showId?.startsWith("tt") ? show.showId : undefined;
    fetchCanonicalSeriesEpisodes(show.title, imdbId)
      .then((res) => {
        if (isMounted && res) {
          setCanonicalSeries(res);
        }
      })
      .finally(() => {
        if (isMounted) setLoadingCanonical(false);
      });

    return () => {
      isMounted = false;
    };
  }, [show?.title, show?.showId]);

  type DisplaySeason = {
    seasonNumber: number;
    localEpisodes: TvEpisode[];
    canonicalEpisodes: CanonicalEpisode[];
    missingAiredCount: number;
  };

  const displaySeasons = useMemo<DisplaySeason[]>(() => {
    if (!show) return [];

    const seasonMap = new Map<number, {
      seasonNumber: number;
      localEpisodes: TvEpisode[];
      canonicalEpisodes: CanonicalEpisode[];
    }>();

    // 1. Populate local scanned seasons
    for (const s of Object.values(show.seasons)) {
      seasonMap.set(s.seasonNumber, {
        seasonNumber: s.seasonNumber,
        localEpisodes: [...s.episodes].sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0)),
        canonicalEpisodes: [],
      });
    }

    // 2. Merge canonical episodes if fetched from Cinemeta/TMDB
    if (canonicalSeries) {
      for (const ep of canonicalSeries.episodes) {
        if (!seasonMap.has(ep.season)) {
          seasonMap.set(ep.season, {
            seasonNumber: ep.season,
            localEpisodes: [],
            canonicalEpisodes: [],
          });
        }
        seasonMap.get(ep.season)!.canonicalEpisodes.push(ep);
      }
    }

    // Sort seasons: Season 1..N first, Season 0 (specials) last
    return Array.from(seasonMap.values())
      .sort((a, b) => {
        if (a.seasonNumber === 0) return 1;
        if (b.seasonNumber === 0) return -1;
        return a.seasonNumber - b.seasonNumber;
      })
      .map((s) => {
        const localEpNums = new Set(s.localEpisodes.map((e) => e.episode));
        const missingAiredCount = s.canonicalEpisodes.filter(
          (c) => !localEpNums.has(c.episode) && c.hasAired
        ).length;
        return {
          seasonNumber: s.seasonNumber,
          localEpisodes: s.localEpisodes,
          canonicalEpisodes: s.canonicalEpisodes,
          missingAiredCount,
        };
      });
  }, [show, canonicalSeries]);

  const totalMissingEpisodes = useMemo(() => {
    return displaySeasons.reduce((acc, s) => acc + s.missingAiredCount, 0);
  }, [displaySeasons]);

  const allEpisodes = useMemo(() => {
    if (!show) return [];
    // Sort seasons 1..N first, then Season 0 (specials)
    const sortedSeasons = Object.values(show.seasons).sort((a, b) => {
      if (a.seasonNumber === 0) return 1;
      if (b.seasonNumber === 0) return -1;
      return a.seasonNumber - b.seasonNumber;
    });
    return sortedSeasons.flatMap((s) => s.episodes);
  }, [show]);

  const watchNext = useMemo(() => {
    if (!allEpisodes.length) return null;

    // 1. Look for in-progress episode
    const inProgress = allEpisodes.find((ep) => {
      const p = watchProgress[ep.id];
      return p && !p.completed && p.position > 10 && (p.duration <= 0 || p.position < p.duration - 15);
    });

    if (inProgress) {
      const p = watchProgress[inProgress.id];
      return {
        episode: inProgress,
        isResume: true,
        position: p?.position ?? 0,
        allCompleted: false,
      };
    }

    // 2. Look for first unwatched episode
    const unwatched = allEpisodes.find((ep) => {
      const p = watchProgress[ep.id];
      return !p || !p.completed;
    });

    if (unwatched) {
      return {
        episode: unwatched,
        isResume: false,
        position: 0,
        allCompleted: false,
      };
    }

    // 3. Fallback: all completed
    return {
      episode: allEpisodes[0],
      isResume: false,
      position: 0,
      allCompleted: true,
    };
  }, [allEpisodes, watchProgress]);

  const [expandedSeason, setExpandedSeason] = useState<number | null>(null);

  useEffect(() => {
    if (expandedSeason === null && show) {
      if (watchNext?.episode?.season !== undefined) {
        setExpandedSeason(watchNext.episode.season);
      } else {
        const sortedNums = Object.keys(show.seasons).map(Number).sort((a, b) => a - b);
        setExpandedSeason(sortedNums[0] ?? null);
      }
    }
  }, [show, watchNext, expandedSeason]);

  const [posterError, setPosterError] = useState(false);
  const [showFixMatch, setShowFixMatch] = useState(false);

  const seriesGenres = useMemo(() => {
    return Array.from(new Set(allEpisodes.flatMap((e) => e.genres || [])));
  }, [allEpisodes]);

  const representativeItem = useMemo<MediaItem | null>(() => {
    if (!show) return null;
    const baseEp = allEpisodes[0];
    return {
      ...(baseEp || {
        id: `tv-rep-${show.showId}`,
        libraryId: show.libraryId || "discovery",
        libraryType: "tv" as const,
        remotePath: "",
        filename: "",
        addedAt: Date.now(),
        lastScannedAt: Date.now(),
      }),
      title: show.title,
      showTitle: show.title,
      showId: show.showId,
      posterUrl: show.posterUrl || baseEp?.showPosterUrl || baseEp?.posterUrl,
      backdropUrl: show.backdropUrl || baseEp?.showBackdropUrl || baseEp?.backdropUrl,
      overview: show.overview || baseEp?.showOverview || baseEp?.overview,
      year: show.year || baseEp?.year,
      genres: seriesGenres.length > 0 ? seriesGenres : canonicalSeries?.genres,
      metadataId: canonicalSeries?.imdbId || show.showId,
      groupType: "show",
    };
  }, [allEpisodes, show, seriesGenres, canonicalSeries]);

  const [recommendations, setRecommendations] = useState<MediaItem[]>([]);

  useEffect(() => {
    if (!representativeItem?.title) {
      setRecommendations([]);
      return;
    }
    let active = true;
    fetchMoreLikeThis(representativeItem).then((recs) => {
      if (active) setRecommendations(recs);
    });
    return () => {
      active = false;
    };
  }, [representativeItem?.title, representativeItem?.metadataId]);

  if (!show) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-subtle font-body text-base">Show not found.</p>
        <button onClick={() => navigate("/tv")} className="btn-secondary text-xs py-2 px-4">
          Back to TV Shows
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Backdrop hero */}
      <div className="relative h-72 flex-shrink-0">
        {show.backdropUrl ? (
          <img src={show.backdropUrl} alt={show.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-panel to-muted" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-void via-void/70 to-transparent" />

        {/* Back button */}
        <button
          onClick={() => navigate(-1)}
          className="absolute top-4 left-6 flex items-center gap-2 text-white/80 hover:text-white transition-colors"
        >
          <ArrowLeft size={20} />
          <span className="font-body text-sm">TV Shows</span>
        </button>

        {/* Show info overlay */}
        <div className="absolute bottom-4 left-6 right-6 flex items-end justify-between gap-4">
          <div className="flex items-end gap-4 min-w-0">
            {show.posterUrl && !posterError ? (
              <img
                src={show.posterUrl}
                alt=""
                className="w-24 rounded-lg border border-border shadow-2xl flex-shrink-0 -mb-8 object-cover aspect-[2/3] bg-panel"
                onError={() => setPosterError(true)}
              />
            ) : null}
            <div className="pb-1 min-w-0">
              <h1 className="font-display text-3xl sm:text-4xl text-white tracking-wide truncate">{show.title.toUpperCase()}</h1>
              <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                {show.year && <span className="text-white/60 font-body text-sm">{show.year}</span>}
                {show.rating && (
                  <span className="flex items-center gap-1 text-white/60 font-body text-sm">
                    <Star size={12} className="text-accent" fill="currentColor" />
                    {show.rating.toFixed(1)}
                  </span>
                )}
                <span className="text-white/60 font-body text-sm">
                  {displaySeasons.length} Season{displaySeasons.length !== 1 ? "s" : ""} · {show.episodeCount} Episodes in Library
                </span>
              </div>
            </div>
          </div>

          {/* Hero Action Buttons (Watch Next #1 priority, Details, Fix Match, Search Easynews) */}
          <div className="flex items-center gap-2.5 shrink-0 pb-1 flex-wrap">
            {watchNext && (
              <button
                data-tv-autofocus="true"
                autoFocus
                onClick={() =>
                  navigate("/play/video", {
                    state: {
                      item: watchNext.episode,
                      resumeAt: watchNext.isResume ? watchNext.position : 0,
                      seriesEpisodes: allEpisodes,
                    },
                  })
                }
                className="btn-primary flex items-center gap-2.5 px-5 py-3 shadow-xl shadow-accent/25 hover:scale-[1.03] transition-all cursor-pointer focus:ring-4 focus:ring-accent focus:outline-none"
                title={watchNext.isResume ? "Resume playback" : "Start next episode"}
              >
                <Play size={18} fill="currentColor" />
                <div className="text-left font-body">
                  <div className="font-bold text-sm leading-none">
                    {watchNext.isResume
                      ? `Resume S${String(watchNext.episode.season ?? 1).padStart(2, "0")}E${String(watchNext.episode.episode ?? 1).padStart(2, "0")}`
                      : watchNext.allCompleted
                      ? "Watch Again (S01E01)"
                      : `Watch Next: S${String(watchNext.episode.season ?? 1).padStart(2, "0")}E${String(watchNext.episode.episode ?? 1).padStart(2, "0")}`}
                  </div>
                  {watchNext.episode.episodeTitle && (
                    <div className="text-[11px] text-void/80 truncate max-w-[220px] mt-0.5 leading-none">
                      {watchNext.episode.episodeTitle}
                    </div>
                  )}
                </div>
              </button>
            )}

            {representativeItem && (
              <button
                onClick={() =>
                  navigate("/detail", {
                    state: { item: representativeItem },
                  })
                }
                className="btn-secondary flex items-center gap-2 px-3.5 py-3 rounded-xl border border-border/80 text-xs font-semibold text-white/90 hover:text-white hover:border-accent transition-all cursor-pointer shadow-lg bg-surface/80 hover:bg-surface focus:ring-2 focus:ring-accent focus:outline-none"
                title="View Full Series Details, Trailer & Metadata"
              >
                <Info size={15} className="text-accent" />
                <span>Show Details</span>
              </button>
            )}

            <button
              onClick={() => setShowFixMatch(true)}
              className="btn-secondary flex items-center gap-2 px-3.5 py-3 rounded-xl border border-border/80 text-xs font-semibold text-white/90 hover:text-white hover:border-accent transition-all cursor-pointer shadow-lg bg-surface/80 hover:bg-surface focus:ring-2 focus:ring-accent focus:outline-none"
              title="Fix series metadata match"
            >
              <Wrench size={15} className="text-accent" />
              <span>Fix Match</span>
            </button>

            <div className="w-full pt-2">
              <UserTagsEditor
                itemIds={allEpisodes.map((e) => e.id)}
                tags={Array.from(new Set(allEpisodes.flatMap((e) => e.userTags || [])))}
                libraryType="tv"
                libraryRoute="/tv"
              />
            </div>

            {totalMissingEpisodes > 0 ? (
              <button
                onClick={() => {
                  const cleanTitle = show.title.replace(/["':]/g, " ").replace(/\s+/g, " ").trim();
                  setEasynewsTargetQuery(cleanTitle);
                }}
                className="btn-secondary flex items-center gap-2 px-3.5 py-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs font-semibold text-amber-300 hover:text-white hover:bg-amber-500/20 hover:border-amber-400 transition-all cursor-pointer shadow-lg"
                title={`Find ${totalMissingEpisodes} missing aired episodes on Easynews Usenet`}
              >
                <Globe size={15} className="text-amber-400" />
                <span>Find Missing ({totalMissingEpisodes})</span>
              </button>
            ) : (
              <button
                onClick={() => {
                  const cleanTitle = show.title.replace(/["':]/g, " ").replace(/\s+/g, " ").trim();
                  setEasynewsTargetQuery(cleanTitle);
                }}
                className="btn-secondary flex items-center gap-2 px-3.5 py-3 rounded-xl border border-border/80 text-xs font-semibold text-white/90 hover:text-white hover:border-accent transition-all cursor-pointer shadow-lg bg-surface/80 hover:bg-surface"
                title="Search Easynews Usenet for full series releases, seasons, or packs"
              >
                <Globe size={15} className="text-accent" />
                <span>Search Easynews</span>
              </button>
            )}

            <button
              onClick={() => {
                const cleanTitle = show.title.replace(/["':]/g, " ").replace(/\s+/g, " ").trim();
                setInfiniDyskTargetQuery(cleanTitle);
              }}
              className="btn-secondary flex items-center gap-2 px-3.5 py-3 rounded-xl border border-cyan-500/40 bg-cyan-500/10 text-xs font-semibold text-cyan-300 hover:text-white hover:bg-cyan-500/20 hover:border-cyan-400 transition-all cursor-pointer shadow-lg"
              title="Search InfiniDysk Usenet indexers and stream-mount releases instantly"
            >
              <Radio size={15} className="text-cyan-400" />
              <span>InfiniDysk</span>
            </button>

            <button
              onClick={() => {
                const synthesized: MediaItem = {
                  id: show.showId,
                  libraryId: show.libraryId || "tv-shows",
                  metadataId: canonicalSeries?.imdbId || show.showId,
                  title: show.title,
                  showTitle: show.title,
                  libraryType: "tv",
                  remotePath: "",
                  filename: "",
                  season: 1,
                  episode: 1,
                  addedAt: Date.now(),
                  lastScannedAt: Date.now(),
                };
                setStremioTargetItem(synthesized);
                setStremioTargetSeason(1);
                setStremioTargetEpisode(1);
              }}
              className="btn-secondary flex items-center gap-2 px-3.5 py-3 rounded-xl border border-accent/40 bg-accent/10 text-xs font-semibold text-accent hover:text-void hover:bg-accent hover:border-accent transition-all cursor-pointer shadow-lg"
              title="Search Stremio Addons & Multi-Tracker Debrid streams for this series"
            >
              <Sparkles size={15} />
              <span>Stremio Streams</span>
            </button>

            {allEpisodes.length > 0 && (
              <button
                onClick={() => {
                  const allWatched = allEpisodes.every((ep) => watchProgress[ep.id]?.completed);
                  const epIds = allEpisodes.map((ep) => ep.id);
                  markMultipleCompleted(epIds, !allWatched);
                  useToastStore.getState().addToast(
                    !allWatched
                      ? `Marked all ${allEpisodes.length} episodes of "${show.title}" as watched`
                      : `Marked "${show.title}" as unwatched`,
                    "info"
                  );
                }}
                className={`btn-secondary flex items-center gap-2 px-3.5 py-3 rounded-xl border text-xs font-semibold transition-all cursor-pointer shadow-lg ${
                  allEpisodes.every((ep) => watchProgress[ep.id]?.completed)
                    ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                    : "border-border/80 text-white/90 hover:text-white hover:border-emerald-400 bg-surface/80 hover:bg-surface"
                }`}
                title={allEpisodes.every((ep) => watchProgress[ep.id]?.completed) ? "Mark Entire Series Unwatched" : "Mark Entire Series Watched"}
              >
                <Check size={15} className={allEpisodes.every((ep) => watchProgress[ep.id]?.completed) ? "text-emerald-400" : "text-subtle"} />
                <span>{allEpisodes.every((ep) => watchProgress[ep.id]?.completed) ? "Series Watched" : "Mark Series Watched"}</span>
              </button>
            )}

            {show && inferredSeriesFolderPath && (
              <div className="flex items-center gap-2">
                {tvSubscriptions?.[show.showId] ? (
                  <>
                    <button
                      onClick={async () => {
                        const sub = tvSubscriptions[show.showId];
                        useToastStore.getState().addToast(`Checking missing episodes for ${show.title}...`, "info");
                        const res = await checkSingleTvSubscription(sub, 2);
                        if (res.grabbed.length === 0) {
                          useToastStore
                            .getState()
                            .addToast(`No new aired missing episodes found on configured sources.`, "info");
                        }
                      }}
                      className="btn-secondary flex items-center gap-1.5 px-3.5 py-3 rounded-xl border text-xs font-semibold transition-all cursor-pointer shadow-lg border-emerald-500/40 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                      title={`Subscribed! Routing new episodes to ${tvSubscriptions[show.showId].destinationRemotePath}. Click to check now.`}
                    >
                      <BellRing size={15} className="text-emerald-400" />
                      <span>Subscribed (Check Now)</span>
                    </button>
                    <button
                      onClick={() => setSubscribeModalOpen(true)}
                      className="btn-secondary px-2.5 py-3 rounded-xl border border-border/80 text-xs font-semibold text-subtle hover:text-accent hover:border-accent/50 transition-colors cursor-pointer"
                      title="Edit subscription settings (quality, release groups, sources, conversion)"
                    >
                      <Settings2 size={15} />
                    </button>
                    <button
                      onClick={() => {
                        removeTvSubscription(show.showId);
                        useToastStore.getState().addToast(`Unsubscribed from "${show.title}"`, "info");
                      }}
                      className="btn-secondary px-2.5 py-3 rounded-xl border border-border/80 text-xs font-semibold text-subtle hover:text-danger hover:border-danger/40 transition-colors"
                      title="Unsubscribe from automatic episode catch-up"
                    >
                      Unsubscribe
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setSubscribeModalOpen(true)}
                    className="btn-secondary flex items-center gap-1.5 px-3.5 py-3 rounded-xl border border-border/80 text-xs font-semibold text-white/90 hover:text-accent hover:border-accent bg-surface/80 hover:bg-surface transition-all cursor-pointer shadow-lg"
                    title="Subscribe: choose quality, release groups, search sources and conversion, then auto-grab missing episodes into this series folder"
                  >
                    <Bell size={15} />
                    <span>Subscribe</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Overview & Genres */}
      <div className={`px-6 ${show.posterUrl ? "pt-10" : "pt-4"} pb-4`}>
        {show.overview && (
          <p className="text-subtle font-body text-sm leading-relaxed max-w-2xl">{show.overview}</p>
        )}
        {seriesGenres.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
            {seriesGenres.map((genre) => (
              <span
                key={genre}
                className="px-2 py-0.5 rounded-full bg-panel border border-border/80 text-[11px] font-body text-subtle"
              >
                {genre}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Seasons */}
      <div className="px-6 pb-12 space-y-3">
        {displaySeasons.map((season) => {
          const localEpNums = new Set(season.localEpisodes.map((e) => e.episode));
          const missingCanonical = season.canonicalEpisodes.filter(
            (c) => !localEpNums.has(c.episode)
          );

          type UnifiedEpisode =
            | { type: "local"; episode: TvEpisode; epNum: number }
            | { type: "missing"; canonical: CanonicalEpisode; epNum: number };

          const unifiedEpisodes: UnifiedEpisode[] = [
            ...season.localEpisodes.map((ep) => ({
              type: "local" as const,
              episode: ep,
              epNum: ep.episode ?? 1,
            })),
            ...missingCanonical.map((c) => ({
              type: "missing" as const,
              canonical: c,
              epNum: c.episode,
            })),
          ].sort((a, b) => a.epNum - b.epNum);

          return (
            <div key={season.seasonNumber} className="bg-panel border border-border rounded-xl overflow-hidden shadow-sm">
              {/* Season header */}
              <button
                onClick={() =>
                  setExpandedSeason(
                    expandedSeason === season.seasonNumber ? null : season.seasonNumber
                  )
                }
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-muted transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-body font-semibold text-bright text-sm">
                    {season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`}
                  </span>
                  <span className="text-subtle font-body text-xs">
                    {season.localEpisodes.length > 0
                      ? `${season.localEpisodes.length} in library`
                      : "Unacquired"}
                  </span>
                  {season.missingAiredCount > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-[10px] font-mono text-amber-400 font-semibold flex items-center gap-1">
                      <span>{season.missingAiredCount} Missing</span>
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  {season.localEpisodes.length > 0 && (
                    <>
                      {(() => {
                        const allSeasonWatched = season.localEpisodes.every(
                          (ep) => watchProgress[ep.id]?.completed
                        );
                        return (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const epIds = season.localEpisodes.map((ep) => ep.id);
                              markMultipleCompleted(epIds, !allSeasonWatched);
                              useToastStore.getState().addToast(
                                !allSeasonWatched
                                  ? `Marked all episodes in ${season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`} as watched`
                                  : `Marked ${season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`} as unwatched`,
                                "info"
                              );
                            }}
                            title={allSeasonWatched ? "Mark Season Unwatched" : "Mark Season as Watched"}
                            className={`btn-secondary text-xs py-1 px-2.5 flex items-center gap-1.5 transition-colors ${
                              allSeasonWatched
                                ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                                : "hover:text-emerald-400"
                            }`}
                          >
                            <Check size={12} className={allSeasonWatched ? "text-emerald-400" : "text-subtle"} />
                            <span>{allSeasonWatched ? "Season Watched" : "Mark Season Watched"}</span>
                          </button>
                        );
                      })()}
                      <AddToPlaylistButton
                        items={season.localEpisodes}
                        size="sm"
                        showLabel
                        label="Add Season"
                      />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadSeason(season.localEpisodes, show.title, season.seasonNumber);
                        }}
                        title={`Download ${season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`}`}
                        className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1.5 hover:text-accent transition-colors"
                      >
                        <Download size={12} />
                        Download Season
                      </button>
                    </>
                  )}

                  {season.missingAiredCount > 0 ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const cleanTitle = show.title.replace(/["':]/g, " ").replace(/\s+/g, " ").trim();
                        setEasynewsTargetQuery(`${cleanTitle} S${String(season.seasonNumber).padStart(2, "0")}`);
                      }}
                      className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1.5 text-amber-300 border-amber-500/40 bg-amber-500/10 hover:border-amber-400 hover:bg-amber-500/20 transition-colors"
                      title={`Search Easynews Usenet for ${season.missingAiredCount} missing episodes in Season ${season.seasonNumber}`}
                    >
                      <Globe size={12} className="text-amber-400" />
                      <span>Search Missing ({season.missingAiredCount})</span>
                    </button>
                  ) : season.localEpisodes.length === 0 ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const cleanTitle = show.title.replace(/["':]/g, " ").replace(/\s+/g, " ").trim();
                        setEasynewsTargetQuery(`${cleanTitle} S${String(season.seasonNumber).padStart(2, "0")}`);
                      }}
                      className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1.5 text-accent border-accent/40 hover:border-accent hover:bg-accent/10 transition-colors"
                      title={`Search Easynews Usenet for full Season ${season.seasonNumber}`}
                    >
                      <Globe size={12} />
                      <span>Search Season</span>
                    </button>
                  ) : null}

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const cleanTitle = show.title.replace(/["':]/g, " ").replace(/\s+/g, " ").trim();
                      setInfiniDyskTargetQuery(`${cleanTitle} S${String(season.seasonNumber).padStart(2, "0")}`);
                    }}
                    className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1.5 text-cyan-300 border-cyan-500/40 bg-cyan-500/10 hover:border-cyan-400 hover:bg-cyan-500/20 transition-colors"
                    title={`Search InfiniDysk Usenet for Season ${season.seasonNumber} releases (instant stream mount)`}
                  >
                    <Radio size={12} className="text-cyan-400" />
                    <span>InfiniDysk</span>
                  </button>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const synthesized: MediaItem = {
                        id: `${show.showId}-s${season.seasonNumber}`,
                        libraryId: show.libraryId || "tv-shows",
                        metadataId: canonicalSeries?.imdbId || show.showId,
                        title: show.title,
                        showTitle: show.title,
                        libraryType: "tv",
                        remotePath: "",
                        filename: "",
                        season: season.seasonNumber,
                        episode: 1,
                        addedAt: Date.now(),
                        lastScannedAt: Date.now(),
                      };
                      setStremioTargetItem(synthesized);
                      setStremioTargetSeason(season.seasonNumber);
                      setStremioTargetEpisode(1);
                    }}
                    className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1.5 text-accent border-accent/40 bg-accent/10 hover:border-accent hover:bg-accent/20 transition-colors"
                    title={`Search Stremio Addons & Debrid streams for Season ${season.seasonNumber}`}
                  >
                    <Sparkles size={12} />
                    <span>Stremio Streams</span>
                  </button>

                  {expandedSeason === season.seasonNumber ? (
                    <ChevronUp size={16} className="text-subtle" />
                  ) : (
                    <ChevronDown size={16} className="text-subtle" />
                  )}
                </div>
              </button>

              {/* Episode list */}
              <AnimatePresence>
                {expandedSeason === season.seasonNumber && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden border-t border-border divide-y divide-border/30"
                  >
                    {unifiedEpisodes.map((item, i) =>
                      item.type === "local" ? (
                        <EpisodeRow
                          key={item.episode.id}
                          episode={item.episode}
                          index={i}
                          progress={watchProgress[item.episode.id]}
                          allEpisodes={allEpisodes}
                          onSearchStremio={(ep) => {
                            setStremioTargetItem(ep);
                            setStremioTargetSeason(ep.season);
                            setStremioTargetEpisode(ep.episode);
                          }}
                        />
                      ) : (
                        <MissingEpisodeRow
                          key={item.canonical.id}
                          canonical={item.canonical}
                          showTitle={show.title}
                          seasonNumber={season.seasonNumber}
                          index={i}
                          onSearchEasynews={(query) => setEasynewsTargetQuery(query)}
                          onSearchInfiniDysk={(query) => setInfiniDyskTargetQuery(query)}
                          onSearchStremio={(can, sNum) => {
                            const synthesized: MediaItem = {
                              id: `missing-${can.id}`,
                              libraryId: show.libraryId || "tv-shows",
                              metadataId: canonicalSeries?.imdbId || show.showId,
                              title: can.title,
                              showTitle: show.title,
                              season: sNum,
                              episode: can.episode,
                              libraryType: "tv",
                              remotePath: "",
                              filename: "",
                              addedAt: Date.now(),
                              lastScannedAt: Date.now(),
                            };
                            setStremioTargetItem(synthesized);
                            setStremioTargetSeason(sNum);
                            setStremioTargetEpisode(can.episode);
                          }}
                        />
                      )
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {recommendations.length > 0 && (
        <div className="pb-12">
          <MediaShelf
            title="More Like This"
            items={recommendations}
            progressMap={watchProgress}
            onItemClick={(recItem) =>
              resolveDiscoveryCardNavigation(recItem, mediaItems, navigate)
            }
          />
        </div>
      )}

      {showFixMatch && representativeItem && (
        <FixMatchModal
          item={representativeItem}
          onClose={() => setShowFixMatch(false)}
        />
      )}

      {stremioTargetItem && (
        <StremioStreamsModal
          isOpen={Boolean(stremioTargetItem)}
          onClose={() => {
            setStremioTargetItem(null);
            setStremioTargetSeason(undefined);
            setStremioTargetEpisode(undefined);
          }}
          item={stremioTargetItem}
          overrideSeason={stremioTargetSeason}
          overrideEpisode={stremioTargetEpisode}
        />
      )}

      {easynewsTargetQuery && (
        <EasynewsSearchModal
          isOpen={Boolean(easynewsTargetQuery)}
          onClose={() => setEasynewsTargetQuery(null)}
          initialQuery={easynewsTargetQuery}
          initialFileType="video"
        />
      )}

      {infiniDyskTargetQuery && (
        <InfiniDyskSearchModal
          isOpen={Boolean(infiniDyskTargetQuery)}
          onClose={() => setInfiniDyskTargetQuery(null)}
          initialQuery={infiniDyskTargetQuery}
          item={representativeItem}
        />
      )}

      {subscribeModalOpen && show && inferredSeriesFolderPath && (
        <SubscribeModal
          isOpen={subscribeModalOpen}
          onClose={() => setSubscribeModalOpen(false)}
          seed={{
            seriesId: show.showId,
            imdbId: canonicalSeries?.imdbId || (show.showId.startsWith("tt") ? show.showId : undefined),
            seriesTitle: show.title,
            posterUrl: show.posterUrl,
            libraryId: show.libraryId,
            destinationRemotePath: inferredSeriesFolderPath,
          }}
          existing={tvSubscriptions?.[show.showId] || null}
        />
      )}
    </div>
  );
}

function MissingEpisodeRow({
  canonical,
  showTitle,
  seasonNumber,
  index,
  onSearchEasynews,
  onSearchInfiniDysk,
  onSearchStremio,
}: {
  canonical: CanonicalEpisode;
  showTitle: string;
  seasonNumber: number;
  index: number;
  onSearchEasynews: (query: string) => void;
  onSearchInfiniDysk: (query: string) => void;
  onSearchStremio: (canonical: CanonicalEpisode, seasonNumber: number) => void;
}) {
  const [thumbError, setThumbError] = useState(false);
  const airDateStr = formatEpisodeAirDate(canonical.airDate);
  const cleanTitle = showTitle.replace(/["':]/g, " ").replace(/\s+/g, " ").trim();
  const targetQuery = `${cleanTitle} S${String(seasonNumber).padStart(2, "0")}E${String(canonical.episode).padStart(2, "0")}`;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: index * 0.02 }}
      tabIndex={0}
      role="button"
      aria-label={`Missing episode ${canonical.episode}: ${canonical.title}. Press Enter to search streams.`}
      className="media-card flex items-start gap-4 px-5 py-4 bg-surface/20 hover:bg-panel/60 focus:bg-panel/80 focus:ring-2 focus:ring-accent focus:outline-none transition-colors border-b border-border/40 last:border-0 group cursor-pointer"
      onClick={() => onSearchStremio(canonical, seasonNumber)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSearchStremio(canonical, seasonNumber);
        }
      }}
    >
      {/* Thumbnail with Stremio indicator */}
      <div className="relative w-28 h-16 rounded-lg overflow-hidden bg-panel flex-shrink-0 border border-border/50">
        {canonical.thumbnail && !thumbError ? (
          <img
            src={canonical.thumbnail}
            alt=""
            className="w-full h-full object-cover opacity-60 group-hover:opacity-85 transition-opacity"
            onError={() => setThumbError(true)}
          />
        ) : (
          <div className="w-full h-full bg-panel flex items-center justify-center text-subtle/50">
            <Sparkles size={20} className="text-accent/60" />
          </div>
        )}
        <div className="absolute inset-0 bg-void/40 flex items-center justify-center group-hover:bg-void/10 transition-colors">
          <Sparkles size={16} className="text-accent group-hover:scale-110 transition-transform" />
        </div>
      </div>

      {/* Episode Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-subtle font-mono text-xs font-semibold">
            E{String(canonical.episode).padStart(2, "0")}
          </span>
          <span className="text-bright/90 font-body text-sm font-medium truncate">
            {canonical.title}
          </span>
          {canonical.hasAired ? (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-[10px] font-mono text-amber-400 font-semibold">
              Missing from Library
            </span>
          ) : (
            <span className="px-1.5 py-0.5 rounded bg-blue-500/15 border border-blue-500/30 text-[10px] font-mono text-blue-400 font-medium">
              Upcoming
            </span>
          )}
          {airDateStr && (
            <span className="text-[11px] font-body text-subtle">
              {canonical.hasAired ? `Aired ${airDateStr}` : `Airs ${airDateStr}`}
            </span>
          )}
        </div>

        {canonical.overview && (
          <p className="text-xs font-body text-subtle/80 line-clamp-2 leading-relaxed mb-2">
            {canonical.overview}
          </p>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2 flex-shrink-0 self-center" tabIndex={-1} data-tv-skip="true">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSearchStremio(canonical, seasonNumber);
          }}
          className="px-3 py-1.5 rounded-xl bg-accent/20 hover:bg-accent text-accent hover:text-void border border-accent/40 hover:border-accent font-body text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm"
          title={`Find instant torrent & Debrid streams via Stremio addons for S${seasonNumber}E${canonical.episode}`}
        >
          <Sparkles size={13} />
          <span>Stremio Streams</span>
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSearchEasynews(targetQuery);
          }}
          className="px-3 py-1.5 rounded-xl bg-panel hover:bg-muted text-subtle hover:text-bright border border-border/80 font-body text-xs font-medium flex items-center gap-1.5 transition-all shadow-sm"
          title={`Search Easynews Usenet for ${targetQuery}`}
        >
          <Globe size={13} />
          <span>Search Easynews</span>
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSearchInfiniDysk(targetQuery);
          }}
          className="px-3 py-1.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 hover:text-white border border-cyan-500/40 hover:border-cyan-400 font-body text-xs font-medium flex items-center gap-1.5 transition-all shadow-sm"
          title={`Search InfiniDysk Usenet for ${targetQuery} (instant stream mount)`}
        >
          <Radio size={13} className="text-cyan-400" />
          <span>InfiniDysk</span>
        </button>
      </div>
    </motion.div>
  );
}

function EpisodeRow({
  episode,
  index,
  progress,
  allEpisodes,
  onSearchStremio,
}: {
  episode: TvEpisode;
  index: number;
  progress?: { position: number; duration: number; completed: boolean };
  allEpisodes?: TvEpisode[];
  onSearchStremio: (episode: TvEpisode) => void;
}) {
  const navigate = useNavigate();
  const removeMediaItem = useAppStore((s) => s.removeMediaItem);
  const toggleWatchCompleted = useAppStore((s) => s.toggleWatchCompleted);
  const addToast = useToastStore((s) => s.addToast);
  const pct = progress && progress.duration ? (progress.position / progress.duration) * 100 : 0;
  const isCompleted = progress?.completed || (progress && progress.duration > 0 && progress.position / progress.duration > 0.9);
  const [thumbError, setThumbError] = useState(false);
  const [showFixMatch, setShowFixMatch] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);

  const { container, resolution, codec, size } = getEpisodeMediaSpecs(episode);

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(episode.remotePath || episode.filename);
    setCopiedPath(true);
    addToast("Copied file path to clipboard", "success");
    setTimeout(() => setCopiedPath(false), 2000);
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: index * 0.03 }}
        tabIndex={0}
        role="button"
        aria-label={`Episode ${episode.episode}: ${episode.episodeTitle ?? episode.title}. Press Enter to play.`}
        className="media-card flex items-start gap-4 px-5 py-4 hover:bg-muted focus:bg-muted focus:ring-2 focus:ring-accent focus:outline-none transition-colors cursor-pointer border-b border-border/50 last:border-0 group"
        onClick={() =>
          navigate("/play/video", {
            state: {
              item: episode,
              resumeAt: progress?.position,
              seriesEpisodes: allEpisodes,
            },
          })
        }
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigate("/play/video", {
              state: {
                item: episode,
                resumeAt: progress?.position,
                seriesEpisodes: allEpisodes,
              },
            });
          }
        }}
      >
        {/* Thumbnail */}
        <div className="relative w-28 h-16 rounded-lg overflow-hidden bg-muted flex-shrink-0">
          {episode.thumbUrl && !thumbError ? (
            <img
              src={episode.thumbUrl}
              alt=""
              className="w-full h-full object-cover"
              onError={() => setThumbError(true)}
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-panel to-muted flex items-center justify-center">
              <Play size={20} className="text-subtle" />
            </div>
          )}
          {/* Completed indicator */}
          {isCompleted && (
            <div className="absolute top-1.5 right-1.5 z-10 p-0.5 rounded-full bg-black/70 text-emerald-400 backdrop-blur-sm border border-emerald-500/30">
              <CheckCircle2 size={13} />
            </div>
          )}
          {/* Progress bar */}
          {pct > 0 && !isCompleted && (
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

          {/* Technical Specs Badges */}
          <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
            {container && (
              <span className="px-1.5 py-0.5 rounded bg-panel border border-border/80 text-[10px] font-mono uppercase text-subtle font-medium">
                {container}
              </span>
            )}
            {resolution && (
              <span className="px-1.5 py-0.5 rounded bg-accent/15 border border-accent/30 text-[10px] font-mono text-accent font-semibold">
                {resolution}
              </span>
            )}
            {codec && (
              <span className="px-1.5 py-0.5 rounded bg-panel border border-border/80 text-[10px] font-mono text-subtle">
                {codec}
              </span>
            )}
            {size && (
              <span className="px-1.5 py-0.5 rounded bg-panel border border-border/80 text-[10px] font-mono text-subtle">
                {size}
              </span>
            )}
            {episode.remotePath && (
              <button
                type="button"
                tabIndex={-1}
                data-tv-skip="true"
                onClick={handleCopyPath}
                title={`Full path: ${episode.remotePath} (Click to copy)`}
                className="inline-flex items-center gap-1 text-[10px] font-mono text-subtle/70 hover:text-white transition-colors max-w-[200px] truncate"
              >
                {copiedPath ? <Check size={10} className="text-emerald-400 shrink-0" /> : <Copy size={10} className="shrink-0" />}
                <span className="truncate">{episode.remotePath.split("/").pop()}</span>
              </button>
            )}
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

        {/* Episode actions */}
        <div className="flex items-center gap-1.5 self-center pl-2 opacity-0 group-hover:opacity-100 transition-opacity" tabIndex={-1} data-tv-skip="true">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigate("/detail", { state: { item: episode } });
            }}
            title={`View details for E${episode.episode ?? ""}: ${episode.episodeTitle ?? episode.title}`}
            className="p-2 rounded-lg bg-surface/80 hover:bg-surface text-subtle hover:text-accent transition-colors"
          >
            <Info size={14} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSearchStremio(episode);
            }}
            title={`Search Stremio Addons & Debrid streams for E${episode.episode ?? ""}: ${episode.episodeTitle ?? episode.title}`}
            className="p-2 rounded-lg bg-surface/80 hover:bg-surface text-subtle hover:text-accent transition-colors"
          >
            <Sparkles size={14} className="text-accent" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowFixMatch(true);
            }}
            title={`Fix Match for E${episode.episode ?? ""}: ${episode.episodeTitle ?? episode.title}`}
            className="p-2 rounded-lg bg-surface/80 hover:bg-surface text-subtle hover:text-accent transition-colors"
          >
            <Wrench size={14} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const isComp = progress?.completed;
              const nextState = toggleWatchCompleted(episode.id, !isComp);
              addToast(
                nextState
                  ? `Marked E${episode.episode ?? ""}: ${episode.episodeTitle ?? episode.title} as watched`
                  : `Marked E${episode.episode ?? ""}: ${episode.episodeTitle ?? episode.title} as unwatched`,
                "info"
              );
            }}
            title={progress?.completed ? "Mark Unwatched" : "Mark as Watched"}
            className={`p-2 rounded-lg transition-colors ${
              progress?.completed
                ? "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30"
                : "bg-surface/80 hover:bg-surface text-subtle hover:text-emerald-400"
            }`}
          >
            <Check size={14} className={progress?.completed ? "text-emerald-400" : ""} />
          </button>
          <FavoriteButton itemId={episode.id} size="sm" />
          <AddToPlaylistButton items={episode} size="sm" />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              downloadSingleItem(episode);
            }}
            title={`Download E${episode.episode ?? ""}: ${episode.episodeTitle ?? episode.title}`}
            className="p-2 rounded-lg bg-surface/80 hover:bg-surface text-subtle hover:text-accent transition-colors"
          >
            <Download size={15} />
          </button>
          {episode.isSourceBookmark && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeMediaItem(episode.id);
                addToast(`Deleted bookmark "${episode.episodeTitle ?? episode.title}"`, "info");
              }}
              title="Delete Bookmark"
              className="p-2 rounded-lg bg-surface/80 hover:bg-danger/20 text-subtle hover:text-danger transition-colors"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </motion.div>

      {showFixMatch && (
        <FixMatchModal
          item={episode}
          onClose={() => setShowFixMatch(false)}
        />
      )}
    </>
  );
}
