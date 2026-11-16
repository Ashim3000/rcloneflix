import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Loader2,
  BookOpen,
  ScrollText,
  Columns,
  ArrowLeftRight,
  Eye,
  EyeOff,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { MediaItem } from "../../store/appStore";
import { useAppStore } from "../../store/appStore";
import { getDownloadedFilePath } from "../../lib/downloadManager";
import { isComicExtension } from "../../lib/mediaTypes";
import type { ComicIssuePagesPayload, DiscoveredRelease } from "../../lib/streamResolver";

interface RemoteZipPageEntry {
  name: string;
  compression_method: number;
  compressed_size: number;
  uncompressed_size: number;
  local_header_offset: number;
}

type ReaderMode = "single" | "webtoon" | "spread";
type ReadingDirection = "ltr" | "rtl";

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "avif") return "image/avif";
  if (ext === "bmp") return "image/bmp";
  return "image/jpeg";
}

export function ComicReaderPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { item: initialItem, seriesIssues: passedSeriesIssues } = (location.state ?? {}) as {
    item?: MediaItem;
    seriesIssues?: (MediaItem | DiscoveredRelease)[];
  };

  const { rcloneConfigPath, mediaItems, updateWatchProgress, watchProgress } = useAppStore();

  const [item, setItem] = useState<MediaItem | undefined>(initialItem);
  const sessionId = useRef(`comic-${Date.now()}`);

  // Page backing sources
  const streamUrlRef = useRef<string | null>(null);
  const remoteEntriesRef = useRef<RemoteZipPageEntry[]>([]);
  const directWebUrlsRef = useRef<string[]>([]);
  const diskPagesRef = useRef<string[]>([]);
  const pageDataCacheRef = useRef<Map<number, string>>(new Map());
  // Progressive (streaming) download of compressed .cbr archives
  const progressivePollRef = useRef<number | null>(null);
  const progressiveActiveRef = useRef(false);

  const [statusText, setStatusText] = useState("Opening comic stream...");
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [spreadSecondUrl, setSpreadSecondUrl] = useState<string | null>(null);
  const [webtoonUrls, setWebtoonUrls] = useState<Record<number, string>>({});

  // Reader settings inspired by ReadComicsOnline
  const [readerMode, setReaderMode] = useState<ReaderMode>(
    () => (localStorage.getItem("rcloneflix_comic_mode") as ReaderMode) || "single"
  );
  const [direction, setDirection] = useState<ReadingDirection>(
    () => (localStorage.getItem("rcloneflix_comic_dir") as ReadingDirection) || "ltr"
  );
  const [fitMode, setFitMode] = useState<"screen" | "width">("screen");
  const [zoom, setZoom] = useState(1);
  const [hudVisible, setHudVisible] = useState(true);

  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Normalize sibling issues for the in-reader Issue Quick-Switcher
  const siblingIssues = useMemo<MediaItem[]>(() => {
    if (passedSeriesIssues && passedSeriesIssues.length > 1) {
      return passedSeriesIssues.map((cand, idx) => {
        if ("filename" in cand && "remotePath" in cand) {
          return cand as MediaItem;
        }
        const rel = cand as DiscoveredRelease;
        return {
          id: `dp-comic-${rel.post_url}`,
          libraryId: "directplay",
          libraryType: "comics",
          remotePath: rel.post_url,
          filename: `${rel.title || `Issue ${idx + 1}`}.cbz`,
          title: rel.title || `Issue #${rel.episode ?? idx + 1}`,
          posterUrl: rel.thumbnail || undefined,
          overview: "DirectPlay Comic Issue",
          metadataSource: "manual",
          addedAt: Date.now(),
          lastScannedAt: Date.now(),
          isSourceBookmark: true,
          sourceUrl: rel.post_url,
          sourceProvider: rel.site_domain,
          season: rel.season ?? 1,
          episode: rel.episode ?? idx + 1,
        };
      });
    }

    if (!item) return [];
    const seriesKey = (item.showTitle || item.album || "").toLowerCase().trim();
    const parentDir = item.remotePath.includes("/")
      ? item.remotePath.slice(0, item.remotePath.lastIndexOf("/"))
      : "";

    const candidates = Object.values(mediaItems).filter((m) => {
      if (m.libraryId !== item.libraryId) return false;
      if (!isComicExtension(m.filename) && m.libraryType !== "comics") return false;
      if (seriesKey && (m.showTitle || m.album || "").toLowerCase().trim() === seriesKey) {
        return true;
      }
      if (parentDir && m.remotePath.startsWith(parentDir + "/")) {
        return true;
      }
      return false;
    });

    return candidates.sort((a, b) => {
      if (a.episode !== undefined && b.episode !== undefined && a.episode !== b.episode) {
        return a.episode - b.episode;
      }
      return a.filename.localeCompare(b.filename, undefined, { numeric: true });
    });
  }, [item, mediaItems, passedSeriesIssues]);

  const currentIssueIdx = useMemo(
    () => (item ? siblingIssues.findIndex((i) => i.id === item.id || i.remotePath === item.remotePath) : -1),
    [siblingIssues, item]
  );

  const prevIssue = currentIssueIdx > 0 ? siblingIssues[currentIssueIdx - 1] : undefined;
  const nextIssue =
    currentIssueIdx >= 0 && currentIssueIdx < siblingIssues.length - 1
      ? siblingIssues[currentIssueIdx + 1]
      : undefined;

  const changeReaderMode = (m: ReaderMode) => {
    setReaderMode(m);
    localStorage.setItem("rcloneflix_comic_mode", m);
  };

  const toggleDirection = () => {
    const next: ReadingDirection = direction === "ltr" ? "rtl" : "ltr";
    setDirection(next);
    localStorage.setItem("rcloneflix_comic_dir", next);
  };

  // Resolve a single page (1-indexed) from cache, web URL, remote HTTP-Range ZIP, or local disk.
  // In-flight requests are deduped: on slow remotes a page takes seconds to arrive, and
  // without this, navigating onto a page that is still preloading refetched its full 1-2 MB.
  const pageFetchInFlightRef = useRef<Map<number, Promise<string | null>>>(new Map());
  const resolveSinglePageUrl = useCallback(async (pageNum: number): Promise<string | null> => {
    if (pageNum < 1) return null;
    const cached = pageDataCacheRef.current.get(pageNum);
    if (cached) return cached;
    const inflight = pageFetchInFlightRef.current.get(pageNum);
    if (inflight) return inflight;
    const task = resolvePageUncached(pageNum);
    pageFetchInFlightRef.current.set(pageNum, task);
    try {
      return await task;
    } finally {
      pageFetchInFlightRef.current.delete(pageNum);
    }
  }, []);

  const resolvePageUncached = async (pageNum: number): Promise<string | null> => {
    if (directWebUrlsRef.current.length >= pageNum) {
      const url = directWebUrlsRef.current[pageNum - 1];
      pageDataCacheRef.current.set(pageNum, url);
      return url;
    }

    if (remoteEntriesRef.current.length >= pageNum && streamUrlRef.current) {
      const entry = remoteEntriesRef.current[pageNum - 1];
      const dataUri = await invoke<string>("fetch_remote_comic_page", {
        streamUrl: streamUrlRef.current,
        entry,
      });
      pageDataCacheRef.current.set(pageNum, dataUri);
      // Sliding-window eviction: keep ~16 pages around the cursor.
      if (pageDataCacheRef.current.size > 16) {
        for (const k of pageDataCacheRef.current.keys()) {
          if (Math.abs(k - pageNum) > 8) {
            const v = pageDataCacheRef.current.get(k);
            if (v?.startsWith("blob:")) URL.revokeObjectURL(v);
            pageDataCacheRef.current.delete(k);
            if (pageDataCacheRef.current.size <= 16) break;
          }
        }
      }
      return dataUri;
    }

    if (diskPagesRef.current.length >= pageNum) {
      const imgPath = diskPagesRef.current[pageNum - 1];
      const buf = await invoke<ArrayBuffer>("read_binary_file", { filePath: imgPath });
      const blobUrl = URL.createObjectURL(new Blob([buf], { type: mimeFromName(imgPath) }));
      pageDataCacheRef.current.set(pageNum, blobUrl);
      // Sliding-window eviction: keep ~16 pages around the cursor.
      if (pageDataCacheRef.current.size > 16) {
        for (const k of pageDataCacheRef.current.keys()) {
          if (Math.abs(k - pageNum) > 8) {
            const v = pageDataCacheRef.current.get(k);
            if (v?.startsWith("blob:")) URL.revokeObjectURL(v);
            pageDataCacheRef.current.delete(k);
            if (pageDataCacheRef.current.size <= 16) break;
          }
        }
      }
      return blobUrl;
    }

    return null;
  };

  // Initialize comic stream / manifest when `item` changes
  useEffect(() => {
    if (!item) return;
    let cancelled = false;

    // Reset state for new issue
    streamUrlRef.current = null;
    remoteEntriesRef.current = [];
    directWebUrlsRef.current = [];
    diskPagesRef.current = [];
    pageDataCacheRef.current.forEach((v) => {
      if (v.startsWith("blob:")) URL.revokeObjectURL(v);
    });
    pageDataCacheRef.current.clear();
    setWebtoonUrls({});
    setPageUrl(null);
    setSpreadSecondUrl(null);
    setError(null);
    setLoading(true);

    (async () => {
      try {
        const remoteTarget = (item.sourceUrl || item.remotePath || "").trim();
        const isHttpUrl = /^https?:\/\//i.test(remoteTarget) || remoteTarget.startsWith("mangadex://");
        const isDirectArchiveUrl = /\.(cbz|cbr|cb7|cbt|zip)(\?|$)/i.test(remoteTarget);

        // PATH A: Online Comic Portal Stream (ReadComicsOnline / MangaDex)
        if (isHttpUrl && !isDirectArchiveUrl) {
          setStatusText("Streaming comic issue pages...");
          const payload = await invoke<ComicIssuePagesPayload>("extract_comic_issue_pages", {
            url: remoteTarget,
          });
          if (cancelled) return;
          directWebUrlsRef.current = payload.pages;
          const count = payload.pages.length;
          setTotalPages(count);
          const existing = watchProgress[item.id];
          const startPage = existing?.position ? Math.floor(existing.position) : 1;
          setCurrentPage(Math.min(Math.max(1, startPage), count));
          setLoading(false);
          return;
        }

        // PATH B: Instant HTTP-Range ZIP/CBZ Streaming (Cloud Remotes & Archive.org direct .cbz URLs)
        const downloadedLocal = await getDownloadedFilePath(item);
        if (!downloadedLocal) {
          let candidateStreamUrl = item.streamUrl || (isHttpUrl ? remoteTarget : "");
          if (!candidateStreamUrl && remoteTarget.includes(":")) {
            setStatusText("Connecting to cloud stream...");
            const colonIdx = remoteTarget.indexOf(":");
            const remoteName = remoteTarget.slice(0, colonIdx);
            const relPath = remoteTarget.slice(colonIdx + 1);
            try {
              const sessionRes = await invoke<{ file_url: string; local_path: string | null }>(
                "start_stream_session",
                {
                  configPath: rcloneConfigPath,
                  remoteRoot: `${remoteName}:`,
                  filePath: relPath,
                  sessionId: sessionId.current,
                }
              );
              candidateStreamUrl = sessionRes.file_url;
            } catch {
              // Fallback to download below if stream session fails
            }
          }

          if (candidateStreamUrl && !cancelled) {
            try {
              setStatusText("Reading comic page index (instant stream)...");
              const entries = await invoke<RemoteZipPageEntry[]>("fetch_remote_comic_manifest", {
                streamUrl: candidateStreamUrl,
              });
              if (cancelled) return;
              if (entries && entries.length > 0) {
                streamUrlRef.current = candidateStreamUrl;
                remoteEntriesRef.current = entries;
                const count = entries.length;
                setTotalPages(count);
                const existing = watchProgress[item.id];
                const startPage = existing?.position ? Math.floor(existing.position) : 1;
                setCurrentPage(Math.min(Math.max(1, startPage), count));
                setLoading(false);
                return;
              }
            } catch (manifestErr: any) {
              // PATH B2: compressed .cbr (or other non-range-streamable archive that the
              // server CAN range-serve) — stream the archive down progressively and show
              // pages as they are extracted, instead of blocking on the full download.
              const msg = String(manifestErr?.message || manifestErr || "");
              const progressiveEligible = /compressed RAR|not a standard ZIP/i.test(msg);
              if (progressiveEligible && !cancelled) {
                try {
                  await invoke("start_progressive_comic_download", {
                    streamUrl: candidateStreamUrl,
                    sessionId: sessionId.current,
                  });
                  progressiveActiveRef.current = true;
                  setStatusText("Streaming comic archive — first pages appear as they unpack...");
                  let shownFirstPages = false;
                  await new Promise<void>((resolve, reject) => {
                    let busy = false;
                    progressivePollRef.current = window.setInterval(async () => {
                      if (cancelled) {
                        if (progressivePollRef.current) window.clearInterval(progressivePollRef.current);
                        resolve();
                        return;
                      }
                      if (busy) return;
                      busy = true;
                      try {
                        const st = await invoke<{
                          downloaded: number;
                          total: number | null;
                          done: boolean;
                          error: string | null;
                          pages: string[];
                        }>("comic_progressive_status", { sessionId: sessionId.current });
                        if (st.error) {
                          if (progressivePollRef.current) window.clearInterval(progressivePollRef.current);
                          reject(new Error(st.error));
                          return;
                        }
                        if (st.pages && st.pages.length > 0) {
                          diskPagesRef.current = st.pages;
                          setTotalPages(st.pages.length);
                          if (!shownFirstPages) {
                            shownFirstPages = true;
                            const existing = watchProgress[item.id];
                            const startPage = existing?.position ? Math.floor(existing.position) : 1;
                            setCurrentPage(Math.min(Math.max(1, startPage), st.pages.length));
                            setLoading(false);
                          }
                        } else if (st.total) {
                          const pct = Math.min(99, Math.round((st.downloaded / st.total) * 100));
                          setStatusText(`Streaming comic archive — ${pct}% buffered, unpacking first pages...`);
                        }
                        if (st.done) {
                          if (progressivePollRef.current) window.clearInterval(progressivePollRef.current);
                          resolve();
                        }
                      } catch (pollErr) {
                        if (progressivePollRef.current) window.clearInterval(progressivePollRef.current);
                        reject(pollErr);
                      } finally {
                        busy = false;
                      }
                    }, 1200);
                  });
                  if (cancelled) return;
                  if (diskPagesRef.current.length > 0) {
                    return; // progressive stream delivered the book — done
                  }
                } catch {
                  // Progressive streaming failed — fall through to the classic full download
                  progressiveActiveRef.current = false;
                }
              }
            }
          }
        }

        // PATH C: Fallback Local / Temp Archive Extraction (for downloaded files or RAR .cbr archives)
        setStatusText("Downloading & unpacking comic archive...");
        let localPath = downloadedLocal;
        if (!localPath) {
          localPath = await invoke<string>("download_book_to_temp", {
            configPath: rcloneConfigPath,
            remotePath: item.remotePath,
            sessionId: sessionId.current,
          });
        }
        if (cancelled) return;

        setStatusText("Extracting comic pages...");
        const extractedPaths = await invoke<string[]>("extract_comic_pages", {
          archivePath: localPath,
          sessionId: sessionId.current,
        });
        if (cancelled) return;

        if (!extractedPaths || extractedPaths.length === 0) {
          throw new Error("No comic image pages found in archive.");
        }

        diskPagesRef.current = extractedPaths;
        const count = extractedPaths.length;
        setTotalPages(count);
        const existing = watchProgress[item.id];
        const startPage = existing?.position ? Math.floor(existing.position) : 1;
        setCurrentPage(Math.min(Math.max(1, startPage), count));
        setLoading(false);
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (progressivePollRef.current) {
        window.clearInterval(progressivePollRef.current);
        progressivePollRef.current = null;
      }
      if (progressiveActiveRef.current) {
        invoke("cancel_progressive_comic", { sessionId: sessionId.current }).catch(() => {});
      }
      invoke("cleanup_book_temp", { sessionId: sessionId.current }).catch(() => {});
    };
  }, [item?.id, item?.remotePath]);

  // Load current page (and preload next 2 pages) in Single / Spread mode
  useEffect(() => {
    if (loading || totalPages === 0 || !item) return;
    let cancelled = false;

    if (readerMode === "webtoon") {
      // In Webtoon mode, load pages around currentPage CONCURRENTLY — on slow remotes
      // each page costs seconds, and serial loading left the strip blank for ~30s.
      const start = Math.max(1, currentPage - 1);
      const end = Math.min(totalPages, currentPage + 4);
      for (let p = start; p <= end; p++) {
        void resolveSinglePageUrl(p)
          .then((u) => {
            if (u && !cancelled) {
              setWebtoonUrls((prev) => (prev[p] ? prev : { ...prev, [p]: u }));
            }
          })
          .catch(() => {});
      }
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        setPageLoading(true);
        // Spread mode fetches both halves in parallel — each page is seconds on slow remotes
        const [primaryUrl, secondaryUrl] = await Promise.all([
          resolveSinglePageUrl(currentPage),
          readerMode === "spread" && currentPage + 1 <= totalPages
            ? resolveSinglePageUrl(currentPage + 1)
            : Promise.resolve<string | null>(null),
        ]);
        if (cancelled) return;
        setPageUrl(primaryUrl);
        setSpreadSecondUrl(secondaryUrl);
        setPageLoading(false);

        if (viewportRef.current) {
          viewportRef.current.scrollTop = 0;
        }

        updateWatchProgress({
          itemId: item.id,
          position: currentPage,
          duration: totalPages,
          completed: currentPage >= totalPages,
          lastWatchedAt: Date.now(),
        });

        // Preload next 2 pages in background for instant page turns
        const preloadStart = readerMode === "spread" ? currentPage + 2 : currentPage + 1;
        for (let p = preloadStart; p <= Math.min(totalPages, preloadStart + 1); p++) {
          void resolveSinglePageUrl(p).catch(() => {});
        }
      } catch (err: any) {
        if (!cancelled) {
          setPageLoading(false);
          setError(err?.message || String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentPage, loading, totalPages, item?.id, readerMode, resolveSinglePageUrl, updateWatchProgress]);

  const stepSize = readerMode === "spread" ? 2 : 1;

  const prevPage = useCallback(() => {
    setCurrentPage((p) => Math.max(1, p - stepSize));
  }, [stepSize]);

  const nextPage = useCallback(() => {
    setCurrentPage((p) => Math.min(totalPages, p + stepSize));
  }, [totalPages, stepSize]);

  const handleLeftAction = useCallback(() => {
    if (direction === "rtl") nextPage();
    else prevPage();
  }, [direction, nextPage, prevPage]);

  const handleRightAction = useCallback(() => {
    if (direction === "rtl") prevPage();
    else nextPage();
  }, [direction, nextPage, prevPage]);

  // Keyboard & Android TV Remote Navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        handleRightAction();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handleLeftAction();
      } else if (e.key === " ") {
        if (readerMode !== "webtoon") {
          e.preventDefault();
          nextPage();
        }
      } else if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        changeReaderMode(readerMode === "webtoon" ? "single" : "webtoon");
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        changeReaderMode(readerMode === "spread" ? "single" : "spread");
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        setFitMode((m) => (m === "screen" ? "width" : "screen"));
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleDirection();
      } else if (e.key === "h" || e.key === "H" || e.key === "Enter") {
        setHudVisible((v) => !v);
      } else if (e.key === "PageUp" && prevIssue) {
        e.preventDefault();
        setItem(prevIssue);
      } else if (e.key === "PageDown" && nextIssue) {
        e.preventDefault();
        setItem(nextIssue);
      } else if (e.key === "Escape" || e.key === "Backspace") {
        navigate(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleLeftAction, handleRightAction, nextPage, readerMode, prevIssue, nextIssue, navigate]);

  // Viewport tap/click zone handler (Left 25% = left action, Right 25% = right action, Center 50% = toggle HUD)
  const handleViewportClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, select, input")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    if (readerMode === "webtoon") {
      setHudVisible((v) => !v);
      return;
    }
    if (relX < 0.25) {
      handleLeftAction();
    } else if (relX > 0.75) {
      handleRightAction();
    } else {
      setHudVisible((v) => !v);
    }
  };

  if (!item) {
    return (
      <div className="h-screen bg-void flex items-center justify-center text-subtle">
        No comic selected.
      </div>
    );
  }

  return (
    <div className="h-screen bg-void flex flex-col select-none overflow-hidden">
      {/* Top Bar (ReadComicsOnline-style Header) */}
      {hudVisible && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-6 py-2.5 bg-panel/95 backdrop-blur border-b border-border flex-shrink-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => navigate(-1)}
              className="text-subtle hover:text-white transition-colors p-1.5 rounded-lg hover:bg-surface"
              title="Back (Esc)"
            >
              <ArrowLeft size={18} />
            </button>
            <span className="font-heading font-semibold text-white text-sm truncate max-w-xs sm:max-w-md">
              {item.title}
            </span>

            {/* In-Reader Issue Quick-Switcher */}
            {siblingIssues.length > 1 && (
              <div className="flex items-center gap-1 ml-2">
                <button
                  onClick={() => prevIssue && setItem(prevIssue)}
                  disabled={!prevIssue}
                  className="px-2 py-1 text-xs rounded bg-surface border border-border text-subtle hover:text-white disabled:opacity-30"
                  title="Previous Issue (PageUp)"
                >
                  Prev Issue
                </button>
                <select
                  value={item.id}
                  onChange={(e) => {
                    const found = siblingIssues.find((s) => s.id === e.target.value);
                    if (found) setItem(found);
                  }}
                  className="bg-surface border border-border rounded px-2 py-1 text-xs text-bright max-w-[180px] truncate outline-none focus:border-accent"
                >
                  {siblingIssues.map((iss, idx) => (
                    <option key={iss.id} value={iss.id}>
                      {iss.episode ? `Issue #${iss.episode}` : iss.title || `Issue ${idx + 1}`}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => nextIssue && setItem(nextIssue)}
                  disabled={!nextIssue}
                  className="px-2 py-1 text-xs rounded bg-surface border border-border text-subtle hover:text-white disabled:opacity-30"
                  title="Next Issue (PageDown)"
                >
                  Next Issue
                </button>
              </div>
            )}
          </div>

          {/* Reader Mode & Viewport Controls */}
          <div className="flex items-center gap-2 flex-wrap">
            {totalPages > 0 && readerMode !== "webtoon" && (
              <div className="flex items-center gap-1.5 bg-surface px-2 py-1 rounded-lg border border-border">
                <button
                  onClick={handleLeftAction}
                  disabled={direction === "ltr" ? currentPage <= 1 : currentPage >= totalPages}
                  className="text-subtle hover:text-white disabled:opacity-30"
                >
                  <ChevronLeft size={16} />
                </button>
                <select
                  value={currentPage}
                  onChange={(e) => setCurrentPage(Number(e.target.value))}
                  className="bg-transparent text-bright font-mono text-xs outline-none cursor-pointer"
                >
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <option key={p} value={p} className="bg-panel text-bright">
                      Page {p} / {totalPages}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleRightAction}
                  disabled={direction === "ltr" ? currentPage >= totalPages : currentPage <= 1}
                  className="text-subtle hover:text-white disabled:opacity-30"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}

            {/* Single / Webtoon / Spread Switcher */}
            <div className="flex items-center bg-surface rounded-lg border border-border p-0.5">
              <button
                onClick={() => changeReaderMode("single")}
                className={`px-2 py-1 rounded text-xs flex items-center gap-1 transition-colors ${
                  readerMode === "single" ? "bg-accent text-void font-semibold" : "text-subtle hover:text-white"
                }`}
                title="Single Page Mode"
              >
                <BookOpen size={13} />
                <span className="hidden md:inline">Single</span>
              </button>
              <button
                onClick={() => changeReaderMode("webtoon")}
                className={`px-2 py-1 rounded text-xs flex items-center gap-1 transition-colors ${
                  readerMode === "webtoon" ? "bg-accent text-void font-semibold" : "text-subtle hover:text-white"
                }`}
                title="Webtoon Vertical Scroll Mode (W)"
              >
                <ScrollText size={13} />
                <span className="hidden md:inline">Webtoon</span>
              </button>
              <button
                onClick={() => changeReaderMode("spread")}
                className={`px-2 py-1 rounded text-xs flex items-center gap-1 transition-colors ${
                  readerMode === "spread" ? "bg-accent text-void font-semibold" : "text-subtle hover:text-white"
                }`}
                title="2-Page Spread Mode (S)"
              >
                <Columns size={13} />
                <span className="hidden md:inline">Spread</span>
              </button>
            </div>

            {readerMode !== "webtoon" && (
              <button
                onClick={toggleDirection}
                className="btn-secondary text-xs py-1 px-2 flex items-center gap-1"
                title="Toggle Western (LTR) vs Manga (RTL) reading direction (M)"
              >
                <ArrowLeftRight size={13} />
                <span>{direction === "ltr" ? "LTR" : "Manga RTL"}</span>
              </button>
            )}

            <button
              onClick={() => setFitMode((m) => (m === "screen" ? "width" : "screen"))}
              className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
              title="Toggle Fit Mode (F)"
            >
              <Maximize2 size={13} />
              <span>{fitMode === "screen" ? "Fit Screen" : "Fit Width"}</span>
            </button>

            <div className="flex items-center gap-1">
              <button
                onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.2).toFixed(1)))}
                className="text-subtle hover:text-white p-1"
                title="Zoom Out"
              >
                <ZoomOut size={15} />
              </button>
              <span className="text-subtle font-mono text-xs w-11 text-center">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(1)))}
                className="text-subtle hover:text-white p-1"
                title="Zoom In"
              >
                <ZoomIn size={15} />
              </button>
            </div>

            <button
              onClick={() => setHudVisible(false)}
              className="text-subtle hover:text-white p-1"
              title="Hide Controls (Click center of screen to restore)"
            >
              <EyeOff size={15} />
            </button>
          </div>
        </div>
      )}

      {/* Floating Restore HUD Button when hidden */}
      {!hudVisible && (
        <button
          onClick={() => setHudVisible(true)}
          className="fixed top-3 right-4 z-30 p-2 rounded-full bg-panel/80 border border-border text-subtle hover:text-white shadow-lg"
          title="Show Reader Controls"
        >
          <Eye size={16} />
        </button>
      )}

      {/* Main Comic Viewport */}
      <div
        ref={viewportRef}
        onClick={handleViewportClick}
        className="flex-1 overflow-auto flex items-center justify-center p-2 sm:p-4 bg-void relative cursor-pointer"
      >
        {loading && (
          <div className="flex flex-col items-center justify-center gap-3">
            <Loader2 size={28} className="text-accent animate-spin" />
            <p className="text-subtle font-body text-sm">{statusText}</p>
          </div>
        )}

        {error && (
          <div className="text-center max-w-md bg-panel border border-border rounded-xl p-6">
            <p className="text-red-400 font-body text-sm mb-4">{error}</p>
            <button onClick={() => navigate(-1)} className="btn-secondary text-sm">
              Go Back
            </button>
          </div>
        )}

        {/* Webtoon Continuous Vertical Strip Mode */}
        {!loading && !error && readerMode === "webtoon" && (
          <div className="w-full h-full overflow-y-auto flex flex-col items-center gap-1">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => (
              <WebtoonPageItem
                key={pageNum}
                pageNum={pageNum}
                url={webtoonUrls[pageNum]}
                zoom={zoom}
                resolvePage={resolveSinglePageUrl}
                onLoaded={(u) => setWebtoonUrls((prev) => (prev[pageNum] ? prev : { ...prev, [pageNum]: u }))}
                onVisible={(p) => {
                  setCurrentPage(p);
                  updateWatchProgress({
                    itemId: item.id,
                    position: p,
                    duration: totalPages,
                    completed: p >= totalPages,
                    lastWatchedAt: Date.now(),
                  });
                }}
              />
            ))}

            {/* End of Issue Next Issue Banner */}
            {nextIssue && (
              <div className="py-8 flex justify-center">
                <button
                  onClick={() => setItem(nextIssue)}
                  className="btn-primary px-6 py-3 text-sm font-semibold flex items-center gap-2"
                >
                  <span>Continue to {nextIssue.title}</span>
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Single Page & 2-Page Spread Modes */}
        {!loading && !error && readerMode !== "webtoon" && pageUrl && (
          <div
            className={`relative flex items-center justify-center w-full h-full gap-2 ${
              direction === "rtl" ? "flex-row-reverse" : "flex-row"
            }`}
          >
            {pageLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-void/40 z-10 pointer-events-none">
                <Loader2 size={24} className="text-accent animate-spin" />
              </div>
            )}
            <img
              src={pageUrl}
              alt={`Page ${currentPage}`}
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: "top center",
              }}
              className={
                fitMode === "screen"
                  ? "max-h-full max-w-full object-contain shadow-2xl transition-transform"
                  : "w-full max-w-4xl h-auto object-contain shadow-2xl transition-transform"
              }
            />
            {readerMode === "spread" && spreadSecondUrl && (
              <img
                src={spreadSecondUrl}
                alt={`Page ${currentPage + 1}`}
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: "top center",
                }}
                className={
                  fitMode === "screen"
                    ? "max-h-full max-w-full object-contain shadow-2xl transition-transform"
                    : "w-full max-w-4xl h-auto object-contain shadow-2xl transition-transform"
                }
              />
            )}
          </div>
        )}
      </div>

      {/* Bottom Scrubber */}
      {hudVisible && !loading && !error && totalPages > 1 && (
        <div className="px-6 py-2 bg-panel/95 backdrop-blur border-t border-border flex items-center gap-4 z-20">
          <span className="text-xs font-mono text-subtle w-20">
            Page {currentPage}
          </span>
          <input
            type="range"
            min={1}
            max={totalPages}
            value={currentPage}
            onChange={(e) => setCurrentPage(Number(e.target.value))}
            className="flex-1 accent-amber-400 cursor-pointer"
          />
          <span className="text-xs font-mono text-subtle w-16 text-right">
            {totalPages}
          </span>
          {currentPage >= totalPages && nextIssue && (
            <button
              onClick={() => setItem(nextIssue)}
              className="px-3 py-1 bg-accent text-void font-semibold rounded-lg hover:bg-accent/90 transition-colors text-xs flex items-center gap-1"
            >
              <span>Next Issue</span>
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function WebtoonPageItem({
  pageNum,
  url,
  zoom,
  resolvePage,
  onLoaded,
  onVisible,
}: {
  pageNum: number;
  url?: string;
  zoom: number;
  resolvePage: (p: number) => Promise<string | null>;
  onLoaded: (u: string) => void;
  onVisible: (p: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onVisible(pageNum);
            if (!url) {
              void resolvePage(pageNum).then((u) => {
                if (u) onLoaded(u);
              });
            }
          }
        }
      },
      { rootMargin: "600px 0px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [pageNum, url, resolvePage, onLoaded, onVisible]);

  return (
    <div
      ref={ref}
      style={{ width: `${Math.round(zoom * 100)}%`, maxWidth: `${Math.round(900 * zoom)}px` }}
      className="min-h-[420px] flex items-center justify-center bg-panel/20"
    >
      {url ? (
        <img src={url} alt={`Page ${pageNum}`} loading="lazy" className="w-full h-auto block" />
      ) : (
        <div className="flex items-center gap-2 text-subtle text-xs py-24">
          <Loader2 size={16} className="animate-spin text-accent" />
          <span>Loading page {pageNum}...</span>
        </div>
      )}
    </div>
  );
}
