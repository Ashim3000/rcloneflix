import { motion, AnimatePresence } from "framer-motion";
import { RefreshCw, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { scanAllLibraries, scanLibrary } from "../../lib/scanner";

type Props = {
  libraryId?: string; // if provided, scans only this library; otherwise scans all
  compact?: boolean;
};

export function ScanBar({ libraryId, compact = false }: Props) {
  const { scanState, libraries, tmdbApiKey, thePornDbApiKey } = useAppStore();
  const isScanning = scanState.status === "scanning";

  const handleScan = async () => {
    if (isScanning) return;
    const apiKeys = { tmdb: tmdbApiKey, theporndb: thePornDbApiKey };

    if (libraryId) {
      const lib = libraries.find((l) => l.id === libraryId);
      if (lib) await scanLibrary(lib, apiKeys);
    } else {
      await scanAllLibraries();
    }
  };

  const lastScanText = scanState.lastScanAt
    ? `Last scan: ${formatRelativeTime(scanState.lastScanAt)}`
    : "Never scanned";

  if (compact) {
    return (
      <button
        onClick={handleScan}
        disabled={isScanning}
        className="flex items-center gap-2 text-subtle hover:text-text transition-colors text-xs font-body disabled:opacity-50"
        title={lastScanText}
      >
        {isScanning ? (
          <Loader2 size={13} className="animate-spin text-accent" />
        ) : (
          <RefreshCw size={13} />
        )}
        {isScanning
          ? scanState.currentLibrary
            ? `Scanning ${scanState.currentLibrary}...`
            : "Scanning..."
          : "Scan"}
      </button>
    );
  }

  return (
    <AnimatePresence>
      {(isScanning || scanState.lastScanAt || scanState.status === "error") && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="flex items-center gap-3 px-4 py-2.5 bg-panel border-b border-border text-xs font-body"
        >
          {scanState.status === "scanning" && (
            <>
              <Loader2 size={13} className="animate-spin text-accent flex-shrink-0" />
              <span className="text-text">
                Scanning{" "}
                <span className="text-accent font-medium">
                  {scanState.currentLibrary ?? "libraries"}
                </span>
                {scanState.progress !== undefined && ` · ${scanState.progress}%`}
              </span>
              {scanState.progress !== undefined && (
                <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden max-w-xs">
                  <motion.div
                    className="h-full bg-accent rounded-full"
                    animate={{ width: `${scanState.progress}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              )}
            </>
          )}

          {scanState.status === "idle" && scanState.lastScanAt && (
            <>
              <CheckCircle2 size={13} className="text-teal flex-shrink-0" />
              <span className="text-subtle">{lastScanText}</span>
              {scanState.newItemsFound > 0 && (
                <span className="text-teal font-medium">
                  +{scanState.newItemsFound} new item{scanState.newItemsFound !== 1 ? "s" : ""}
                </span>
              )}
              <div className="flex-1" />
              <button
                onClick={handleScan}
                className="text-subtle hover:text-accent transition-colors flex items-center gap-1"
              >
                <RefreshCw size={11} />
                Scan now
              </button>
            </>
          )}

          {scanState.status === "error" && (
            <>
              <AlertCircle size={13} className="text-danger flex-shrink-0" />
              <span className="text-danger">
                Scan failed: {scanState.lastError}
              </span>
              <div className="flex-1" />
              <button
                onClick={handleScan}
                className="text-subtle hover:text-text transition-colors"
              >
                Retry
              </button>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}
