import { useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  useAppStore,
  selectInProgress,
  selectRecentlyAddedGrouped,
  selectFavoriteItems,
  selectTvShows,
  AUDIO_EXTENSIONS,
  type MediaItem,
} from "../store/appStore";
import { MediaShelf } from "../components/library/MediaShelf";
import { ScanBar } from "../components/common/ScanBar";
import { scanAllLibraries } from "../lib/scanner";
import { refreshSimklDiscovery } from "../lib/simkl";
import { annotateWithLibraryMatch, resolveDiscoveryCardNavigation } from "../lib/discoveryMatching";
import { OvernightDigestBanner } from "../components/library/OvernightDigestBanner";

export function HomePage() {
  const navigate = useNavigate();
  const {
    libraries,
    mediaItems,
    watchProgress,
    favorites,
    scanState,
    adultSettings,
    simklSettings: rawSimklSettings,
    traktSettings: rawTraktSettings,
  } = useAppStore();

  const simklSettings = rawSimklSettings || rawTraktSettings;

  const inProgress = selectInProgress(mediaItems, watchProgress);
  const favoriteItems = selectFavoriteItems(mediaItems, favorites);

  const recommendedItems = useMemo(() => {
    return Object.values(mediaItems).filter(
      (item) => Boolean(item.recommendationBadge || item.isRecommended)
    );
  }, [mediaItems]);

  const annotatedTrendingMovies = useMemo(
    () => annotateWithLibraryMatch(simklSettings?.trendingMovies, mediaItems),
    [simklSettings?.trendingMovies, mediaItems]
  );
  const annotatedTrendingShows = useMemo(
    () => annotateWithLibraryMatch(simklSettings?.trendingShows, mediaItems),
    [simklSettings?.trendingShows, mediaItems]
  );
  const annotatedAnticipatedMovies = useMemo(
    () => annotateWithLibraryMatch(simklSettings?.anticipatedMovies, mediaItems),
    [simklSettings?.anticipatedMovies, mediaItems]
  );
  const annotatedAnticipatedShows = useMemo(
    () => annotateWithLibraryMatch(simklSettings?.anticipatedShows, mediaItems),
    [simklSettings?.anticipatedShows, mediaItems]
  );

  // Check discovery window (Simkl 100% free)
  useEffect(() => {
    if (simklSettings?.enabled || simklSettings?.discoveryShelvesEnabled !== false) {
      const needsFetch =
        !simklSettings?.trendingMovies ||
        simklSettings.trendingMovies.length === 0;
      refreshSimklDiscovery(needsFetch);
    }
  }, [simklSettings?.clientId, simklSettings?.enabled]);

  // Filter out adult if hidden
  const visibleLibraries = libraries.filter(
    (lib) => !(lib.type === "adult" && adultSettings.hidden)
  );

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const hasAnyContent = Object.keys(mediaItems).length > 0;

  const handleCardClick = (item: MediaItem) => {
    if (item.id?.startsWith("trakt-") || item.id?.startsWith("simkl-") || item.libraryId === "discovery") {
      resolveDiscoveryCardNavigation(item, mediaItems, navigate);
      return;
    }

    if (item.groupType === "show") {
      const allShows = selectTvShows(mediaItems, item.libraryId);
      const matchedShow = allShows.find(
        (s) => s.showId === item.showId || s.title.toLowerCase() === item.title.toLowerCase()
      );
      if (matchedShow) {
        navigate(`/tv/show/${encodeURIComponent(matchedShow.showId)}`, {
          state: { show: matchedShow },
        });
      } else {
        navigate("/tv");
      }
      return;
    }

    const ext = item.filename?.split(".").pop()?.toLowerCase() ?? "";
    if (item.groupType === "album" || item.libraryType === "music" || (AUDIO_EXTENSIONS.includes(ext) && item.libraryType !== "audiobooks")) {
      navigate("/music", {
        state: {
          artistName: item.artist,
          albumName: item.album,
          trackId: item.id,
        },
      });
      return;
    }

    if (item.groupType === "book" || item.libraryType === "audiobooks") {
      navigate("/audiobooks");
      return;
    }

    if (item.libraryType === "books") {
      navigate("/books");
      return;
    }

    // Default: detail page for movies or standard video
    navigate("/detail", { state: { item } });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Scan status bar */}
      <ScanBar />

      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="px-8 pt-8 pb-6"
        >
          <h1 className="font-display text-5xl text-bright tracking-wide mb-1">
            {greeting}
          </h1>
          <p className="text-subtle font-body text-sm">
            {visibleLibraries.length} librar{visibleLibraries.length === 1 ? "y" : "ies"} ·{" "}
            {Object.keys(mediaItems).length} items
          </p>
        </motion.div>

        {!hasAnyContent && scanState.status !== "scanning" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="px-8 py-12 text-center"
          >
            <p className="text-subtle font-body">
              No media found yet. A scan will run automatically, or you can{" "}
              <button
                onClick={() => scanAllLibraries()}
                className="text-accent hover:text-accent-glow underline underline-offset-2 transition-colors"
              >
                scan now
              </button>
              .
            </p>
          </motion.div>
        )}

        <OvernightDigestBanner />

        {/* Recommended Titles Shelf (Always Topmost) */}
        {recommendedItems.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="mb-8"
          >
            <MediaShelf
              title="⭐ Recommended Titles"
              items={recommendedItems}
              progressMap={watchProgress}
              showProgress
              onItemClick={handleCardClick}
            />
          </motion.div>
        )}

        {/* Continue Watching */}
        {inProgress.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="mb-8"
          >
            <MediaShelf
              title="Continue Watching"
              items={inProgress}
              progressMap={watchProgress}
              showProgress
              onItemClick={handleCardClick}
            />
          </motion.div>
        )}

        {/* Favorites */}
        {favoriteItems.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="mb-8"
          >
            <MediaShelf
              title="Favorites"
              items={favoriteItems}
              progressMap={watchProgress}
              showProgress
              onItemClick={handleCardClick}
            />
          </motion.div>
        )}

        {/* Recently Added rows per library (Grouped Cards with Recommended Titles to furthest left) */}
        {visibleLibraries.map((lib, i) => {
          const rawRecent = selectRecentlyAddedGrouped(mediaItems, lib);
          if (rawRecent.length === 0) return null;
          // Sort recommended items to furthest left
          const recent = [...rawRecent].sort((a, b) => {
            const aRec = Boolean(a.recommendationBadge || a.isRecommended);
            const bRec = Boolean(b.recommendationBadge || b.isRecommended);
            if (aRec && !bRec) return -1;
            if (!aRec && bRec) return 1;
            return 0;
          });
          return (
            <motion.div
              key={lib.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 + i * 0.07 }}
              className="mb-8"
            >
              <MediaShelf
                title={`Recently Added · ${lib.name}`}
                items={recent}
                progressMap={watchProgress}
                showProgress
                onItemClick={handleCardClick}
              />
            </motion.div>
          );
        })}

        {/* Discovery Shelves (Simkl 100% Free) */}
        {(simklSettings?.discoveryShelvesEnabled !== false) && (
          <>
            {annotatedTrendingMovies && annotatedTrendingMovies.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-8"
              >
                <MediaShelf
                  title="Trending Movies · Discovery"
                  items={annotatedTrendingMovies}
                  onItemClick={handleCardClick}
                />
              </motion.div>
            )}

            {annotatedTrendingShows && annotatedTrendingShows.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-8"
              >
                <MediaShelf
                  title="Trending TV Shows · Discovery"
                  items={annotatedTrendingShows}
                  onItemClick={handleCardClick}
                />
              </motion.div>
            )}

            {annotatedAnticipatedMovies && annotatedAnticipatedMovies.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-8"
              >
                <MediaShelf
                  title="Anticipated Movies · Discovery"
                  items={annotatedAnticipatedMovies}
                  onItemClick={handleCardClick}
                />
              </motion.div>
            )}

            {annotatedAnticipatedShows && annotatedAnticipatedShows.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-8"
              >
                <MediaShelf
                  title="Anticipated TV Shows · Discovery"
                  items={annotatedAnticipatedShows}
                  onItemClick={handleCardClick}
                />
              </motion.div>
            )}
          </>
        )}

        <div className="h-8" />
      </div>
    </div>
  );
}
