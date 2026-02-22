import { useEffect } from "react";
import { motion } from "framer-motion";
import { useAppStore, selectInProgress, selectRecentlyAdded } from "../store/appStore";
import { MediaShelf } from "../components/library/MediaShelf";
import { ScanBar } from "../components/common/ScanBar";
import { scanAllLibraries } from "../lib/scanner";

const LIBRARY_LABELS: Record<string, string> = {
  movies: "Movies",
  tv: "TV Shows",
  music: "Music",
  audiobooks: "Audiobooks",
  books: "Books",
  adult: "Adult",
};

export function HomePage() {
  const {
    libraries,
    mediaItems,
    watchProgress,
    scanState,
    tmdbApiKey,
    thePornDbApiKey,
    adultSettings,
  } = useAppStore();

  // Run partial scan on startup (only if never scanned or last scan > 1hr ago)
  useEffect(() => {
    const oneHour = 60 * 60 * 1000;
    const shouldScan =
      !scanState.lastScanAt ||
      Date.now() - scanState.lastScanAt > oneHour;

    if (shouldScan && scanState.status === "idle" && libraries.length > 0) {
      scanAllLibraries();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const inProgress = selectInProgress(mediaItems, watchProgress);

  // Filter out adult if hidden
  const visibleLibraries = libraries.filter(
    (lib) => !(lib.type === "adult" && adultSettings.hidden)
  );

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const hasAnyContent = Object.keys(mediaItems).length > 0;

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
                onClick={() =>
                  scanAllLibraries()
                }
                className="text-accent hover:text-accent-glow underline underline-offset-2 transition-colors"
              >
                scan now
              </button>
              .
            </p>
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
            />
          </motion.div>
        )}

        {/* Recently Added rows per library */}
        {visibleLibraries.map((lib, i) => {
          const recent = selectRecentlyAdded(mediaItems, lib.id);
          if (recent.length === 0) return null;
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
              />
            </motion.div>
          );
        })}

        <div className="h-8" />
      </div>
    </div>
  );
}
