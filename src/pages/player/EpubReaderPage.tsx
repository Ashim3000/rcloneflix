import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
  Type,
  BookOpen,
  Loader2,
  Bookmark,
  BookmarkPlus,
  Trash2,
  Check,
  X,
  Headphones,
  Sparkles,
  Link2,
  Cpu,
} from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { MediaItem } from "../../store/appStore";
import { useAppStore } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { getDownloadedFilePath } from "../../lib/downloadManager";
import { ReadAlongEngine } from "../../lib/readalongEngine";
import { parseBookMediaOverlays, type SmilOverlayCollection } from "../../lib/smilParser";
import { PairAudiobookModal } from "../../components/audiobooks/PairAudiobookModal";
import { KaggleAlignModal } from "../../components/audiobooks/KaggleAlignModal";
import { findMatchingAudiobook } from "../../lib/whispersync";
import ePub from "epubjs";

interface EpubRendition {
  display(target?: string): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  on(event: string, cb: (...args: any[]) => void): void;
  currentLocation(): unknown;
  themes: {
    fontSize(s: string): void;
    font(name: string): void;
    select(name: string): void;
    register(name: string, styles: Record<string, unknown>): void;
    default(styles: Record<string, unknown>): void;
  };
  hooks: {
    content: {
      register(cb: (contents: any) => void): void;
    };
  };
  destroy(): void;
}

interface EpubBook {
  renderTo(el: Element, options?: Record<string, unknown>): EpubRendition;
  destroy(): void;
  on(event: string, callback: (...args: any[]) => void): void;
  archive?: any;
  loaded: {
    navigation: Promise<{
      toc: Array<{
        id: string;
        href: string;
        label: string;
        subitems?: Array<{ id: string; href: string; label: string }>;
      }>;
    }>;
  };
}

type ReaderSettings = {
  fontSize: number;
  theme: "dark" | "sepia" | "light" | "amoled";
  fontFamily: "sans" | "serif" | "opendyslexic" | "mono";
  lineHeight: number;
  margin: number;
};

type ReaderBookmark = {
  id: string;
  cfi: string;
  chapterTitle?: string;
  percentage?: number;
  createdAt: number;
};

interface EpubLocation {
  start: { cfi: string };
}

const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 16,
  theme: "dark",
  fontFamily: "sans",
  lineHeight: 1.8,
  margin: 32,
};

const fontFamilies: Record<ReaderSettings["fontFamily"], string> = {
  sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
  opendyslexic: '"OpenDyslexic", "Comic Sans MS", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

export function EpubReaderPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { item, startChapterIndex, startChapterTitle, intraRatio: initialIntraRatio } =
    (location.state ?? {}) as {
      item: MediaItem;
      startChapterIndex?: number;
      startChapterTitle?: string;
      intraRatio?: number;
    };
  const {
    rcloneConfigPath,
    updateWatchProgress,
    watchProgress,
    audioState,
    setAudioState,
    mediaItems,
    whispersyncPairs,
  } = useAppStore();

  const [showPairModal, setShowPairModal] = useState(false);
  const [showKaggleAlign, setShowKaggleAlign] = useState(false);

  const allMedia = useMemo(() => Object.values(mediaItems), [mediaItems]);
  const companion = useMemo(() => {
    if (!item) return undefined;
    return findMatchingAudiobook(item, allMedia, whispersyncPairs);
  }, [item, allMedia, whispersyncPairs]);

  const isAudiobookActive = useMemo(() => {
    if (!audioState) return false;
    const currentTrack = audioState.playlist?.[audioState.playlistIndex];
    if (!currentTrack) return false;
    return (
      currentTrack.libraryType === "audiobooks" ||
      currentTrack.filename.toLowerCase().endsWith(".m4b") ||
      (companion && currentTrack.id === companion.id) ||
      (item && currentTrack.title?.toLowerCase() === item.title?.toLowerCase())
    );
  }, [audioState, companion, item]);

  // If music or internet radio was playing, stop it upon opening the reader
  useEffect(() => {
    if (audioState && !isAudiobookActive) {
      setAudioState(null);
      window.dispatchEvent(new CustomEvent("rcloneflix:stop-audio"));
    }
  }, [audioState, isAudiobookActive, setAudioState]);

  const containerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<EpubRendition | null>(null);
  const tocRef = useRef<Array<{ id: string; href: string; label: string }>>([]);
  const readAlongEngineRef = useRef<ReadAlongEngine | null>(null);
  const smilOverlaysRef = useRef<SmilOverlayCollection | null>(null);
  const lastAudChapterRef = useRef<{ index?: number; title?: string }>({});
  const [readAlongEnabled, setReadAlongEnabled] = useState(true);

  const [settings, setSettings] = useState<ReaderSettings>(() => {
    try {
      const saved = localStorage.getItem("rcloneflix_epub_settings");
      if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    } catch {}
    return DEFAULT_SETTINGS;
  });

  const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>(() => {
    if (!item?.id) return [];
    try {
      const raw = localStorage.getItem(`rcloneflix_epub_bookmarks_${item.id}`);
      if (raw) return JSON.parse(raw);
    } catch {}
    return [];
  });

  const [currentLocationInfo, setCurrentLocationInfo] = useState<{
    cfi: string;
    chapterTitle?: string;
    percentage?: number;
  } | null>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sessionId = useRef(`epub-${Date.now()}`);

  // Sync bookmarks from storage on item change
  useEffect(() => {
    if (!item?.id) return;
    try {
      const raw = localStorage.getItem(`rcloneflix_epub_bookmarks_${item.id}`);
      if (raw) setBookmarks(JSON.parse(raw));
      else setBookmarks([]);
    } catch {
      setBookmarks([]);
    }
  }, [item?.id]);

  const applyThemes = useCallback((rendition: EpubRendition, s: ReaderSettings) => {
    rendition.themes.register("dark", {
      body: { background: "#080A0F !important", color: "#C8D0DC !important" },
      p: { "line-height": `${s.lineHeight} !important` },
    });
    rendition.themes.register("amoled", {
      body: { background: "#000000 !important", color: "#D1D5DB !important" },
      p: { "line-height": `${s.lineHeight} !important` },
    });
    rendition.themes.register("sepia", {
      body: { background: "#F4ECD8 !important", color: "#3B2D1A !important" },
      p: { "line-height": `${s.lineHeight} !important` },
    });
    rendition.themes.register("light", {
      body: { background: "#FFFFFF !important", color: "#1A1A2E !important" },
      p: { "line-height": `${s.lineHeight} !important` },
    });
    rendition.themes.select(s.theme);
    rendition.themes.fontSize(`${s.fontSize}px`);
    rendition.themes.font(fontFamilies[s.fontFamily]);
  }, []);

  // Re-apply themes and persist whenever settings change
  useEffect(() => {
    if (renditionRef.current) {
      applyThemes(renditionRef.current, settings);
    }
    try {
      localStorage.setItem("rcloneflix_epub_settings", JSON.stringify(settings));
    } catch {}
  }, [settings, applyThemes]);

  // Download EPUB file and initialize ePub with ArrayBuffer in memory
  useEffect(() => {
    if (!item) return;

    let mounted = true;

    (async () => {
      try {
        let localPath = await getDownloadedFilePath(item);
        if (!localPath) {
          localPath = await invoke<string>("download_book_to_temp", {
            configPath: rcloneConfigPath,
            remotePath: item.remotePath,
            sessionId: sessionId.current,
          });
        }
        if (!mounted) return;
        setDownloading(false);

        let arrayBuffer: ArrayBuffer | null = null;
        try {
          const raw = await invoke<any>("read_binary_file", { filePath: localPath });
          if (raw instanceof ArrayBuffer) {
            arrayBuffer = raw;
          } else if (raw instanceof Uint8Array) {
            arrayBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
          } else if (Array.isArray(raw)) {
            arrayBuffer = new Uint8Array(raw).buffer;
          } else if (raw && typeof raw === "object" && "data" in raw && Array.isArray((raw as any).data)) {
            arrayBuffer = new Uint8Array((raw as any).data).buffer;
          } else if (raw && typeof raw === "object" && "body" in raw && Array.isArray((raw as any).body)) {
            arrayBuffer = new Uint8Array((raw as any).body).buffer;
          }
        } catch (ipcErr) {
          console.warn("read_binary_file IPC invoke failed, attempting asset protocol fallback:", ipcErr);
        }

        if (!arrayBuffer) {
          const assetUrl = convertFileSrc(localPath);
          const resp = await fetch(assetUrl);
          if (!resp.ok) {
            throw new Error(`Failed to read EPUB file via asset protocol: HTTP ${resp.status}`);
          }
          arrayBuffer = await resp.arrayBuffer();
        }

        if (!mounted || !containerRef.current) return;

        const book = ePub(arrayBuffer) as EpubBook;
        const rendition = book.renderTo(containerRef.current, {
          width: "100%",
          height: "100%",
          spread: "none",
        });

        renditionRef.current = rendition;

        // Initialize Storyteller-grade Read-Along Immersion Reading Engine
        const engine = new ReadAlongEngine(rendition);
        engine.setEnabled(readAlongEnabled);
        readAlongEngineRef.current = engine;

        // Asynchronously discover EPUB 3 Media Overlays (SMIL) if present
        parseBookMediaOverlays(book)
          .then((overlays) => {
            if (!mounted) return;
            smilOverlaysRef.current = overlays;
            if (overlays.totalPars > 0) {
              console.log(`[ImmersionReading] Loaded ${overlays.totalPars} Media Overlay SMIL alignment points`);
            }
          })
          .catch(() => {});

        // Register content hook for every chapter rendered
        rendition.hooks.content.register((contents: any) => {
          try {
            const section = contents?.section;
            const href = section?.href || "";
            const baseHref = href.split("#")[0].split("/").pop() || href;
            let chIdx = -1;
            let chTitle = "";
            if (tocRef.current && tocRef.current.length > 0) {
              chIdx = tocRef.current.findIndex((t) => {
                const tBase = t.href.split("#")[0].split("/").pop();
                return tBase === baseHref || href.includes(t.href) || t.href.includes(href);
              });
              if (chIdx >= 0) chTitle = tocRef.current[chIdx].label;
            }
            const pars = smilOverlaysRef.current?.chapterMap.get(baseHref) || [];
            engine.attachContents(contents, href, pars, chIdx, chTitle, tocRef.current?.length || 0);
          } catch (hookErr) {
            console.warn("ReadAlongEngine hook registration warning:", hookErr);
          }
        });

        // Apply initial themes, fonts, and sizing
        applyThemes(rendition, settings);

        // Index TOC in background without blocking initial render
        try {
          const nav = await book.loaded.navigation;
          if (nav?.toc) {
            const flat: Array<{ id: string; href: string; label: string }> = [];
            const flatten = (items: typeof nav.toc) => {
              for (const it of items) {
                if (it.label?.trim() && it.href) {
                  flat.push({ id: it.id, href: it.href, label: it.label.trim() });
                }
                if (it.subitems && it.subitems.length > 0) {
                  flatten(it.subitems);
                }
              }
            };
            flatten(nav.toc);
            tocRef.current = flat;
          }
        } catch {}

        let targetToDisplay: string | undefined = undefined;

        if (typeof startChapterIndex === "number" && tocRef.current[startChapterIndex]) {
          targetToDisplay = tocRef.current[startChapterIndex].href;
        } else if (startChapterTitle && tocRef.current.length > 0) {
          const cleanTitle = startChapterTitle.toLowerCase().replace(/[^\w\s]/g, "").trim();
          const match = tocRef.current.find((t) => {
            const cleanLabel = t.label.toLowerCase().replace(/[^\w\s]/g, "").trim();
            return cleanLabel.includes(cleanTitle) || cleanTitle.includes(cleanLabel);
          });
          if (match) targetToDisplay = match.href;
        }

        const existing = watchProgress[item.id];
        if (!targetToDisplay && existing?.cfi) {
          targetToDisplay = existing.cfi;
        }

        try {
          if (targetToDisplay) {
            await rendition.display(targetToDisplay);
          } else {
            await rendition.display();
          }
        } catch (dispErr) {
          console.warn("Failed displaying target CFI/href, falling back to start of book:", dispErr);
          await rendition.display();
        }

        if (targetToDisplay && initialIntraRatio && initialIntraRatio > 0 && initialIntraRatio < 1) {
          try {
            const loc = rendition.currentLocation() as any;
            const total = loc?.start?.displayed?.total;
            if (total && total > 1) {
              const targetPage = Math.max(1, Math.min(total, Math.round(total * initialIntraRatio)));
              for (let i = 1; i < targetPage; i++) {
                await rendition.next();
              }
            }
          } catch {}
        }
        setLoading(false);

        rendition.on("relocated", (loc: EpubLocation) => {
          if (loc?.start?.cfi && item) {
            updateWatchProgress({
              itemId: item.id,
              position: 0,
              duration: 0,
              cfi: loc.start.cfi,
              completed: false,
              lastWatchedAt: Date.now(),
            });

            const startLoc = loc.start as any;
            let matchedTocIndex = -1;
            let matchedTocTitle = "";
            if (startLoc?.href && tocRef.current.length > 0) {
              const baseHref = startLoc.href.split("#")[0].split("/").pop();
              const idx = tocRef.current.findIndex((t) => {
                const tBase = t.href.split("#")[0].split("/").pop();
                return (
                  tBase === baseHref ||
                  startLoc.href.includes(t.href) ||
                  t.href.includes(startLoc.href)
                );
              });
              if (idx >= 0) {
                matchedTocIndex = idx;
                matchedTocTitle = tocRef.current[idx].label;
              }
            }

            const pct = startLoc?.percentage != null ? Math.round(startLoc.percentage * 100) : undefined;
            setCurrentLocationInfo({
              cfi: loc.start.cfi,
              chapterTitle: matchedTocTitle || undefined,
              percentage: pct,
            });

            window.dispatchEvent(
              new CustomEvent("rcloneflix:reader-location", {
                detail: {
                  cfi: loc.start.cfi,
                  href: startLoc?.href,
                  displayedPage: startLoc?.displayed?.page,
                  displayedTotal: startLoc?.displayed?.total,
                  tocIndex: matchedTocIndex,
                  tocTitle: matchedTocTitle,
                  tocCount: tocRef.current.length,
                },
              })
            );
          }
        });
      } catch (e) {
        if (!mounted) return;
        console.error("EPUB load error:", e);
        setError(`Failed to load EPUB: ${e instanceof Error ? e.message : String(e)}`);
        setDownloading(false);
        setLoading(false);
      }
    })();

    return () => {
      mounted = false;
      if (readAlongEngineRef.current) {
        readAlongEngineRef.current.destroy();
        readAlongEngineRef.current = null;
      }
      if (renditionRef.current) {
        try {
          renditionRef.current.destroy();
        } catch {}
      }
      invoke("cleanup_book_temp", { sessionId: sessionId.current }).catch(() => {});
    };
  }, [item?.id]);

  // Decoupled Read-Along Audio Tick Listener (Zero React Re-render)
  useEffect(() => {
    const onTick = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;

      if (readAlongEngineRef.current) {
        readAlongEngineRef.current.onAudioTick(detail);
      }

      // Auto-advance EPUB chapter when companion audio transitions to a new chapter
      if (detail.playing && renditionRef.current && tocRef.current && tocRef.current.length > 0) {
        const prev = lastAudChapterRef.current;
        const indexChanged = typeof detail.chapterIndex === "number" && detail.chapterIndex >= 0 && detail.chapterIndex !== prev.index;
        const titleChanged = !!(detail.chapterTitle && detail.chapterTitle !== prev.title);

        if (indexChanged || titleChanged) {
          lastAudChapterRef.current = { index: detail.chapterIndex, title: detail.chapterTitle };

          let targetHref: string | undefined;
          if (detail.chapterTitle) {
            const cleanAudio = detail.chapterTitle.toLowerCase().replace(/[^\w\s]/g, "").trim();
            const match = tocRef.current.find((t) => {
              const cleanToc = t.label.toLowerCase().replace(/[^\w\s]/g, "").trim();
              return cleanToc.includes(cleanAudio) || cleanAudio.includes(cleanToc);
            });
            if (match) targetHref = match.href;
          }
          if (!targetHref && typeof detail.chapterIndex === "number" && tocRef.current[detail.chapterIndex]) {
            targetHref = tocRef.current[detail.chapterIndex].href;
          }

          if (targetHref) {
            const curLoc = renditionRef.current.currentLocation() as any;
            const curHref = curLoc?.start?.href || "";
            const cleanTargetBase = targetHref.split("#")[0].split("/").pop() || "";
            if (cleanTargetBase && !curHref.includes(cleanTargetBase)) {
              renditionRef.current.display(targetHref).catch(() => {});
            }
          }
        }
      }
    };
    window.addEventListener("rcloneflix:whispersync-audio-tick", onTick);
    return () => window.removeEventListener("rcloneflix:whispersync-audio-tick", onTick);
  }, []);

  // Decoupled Whispersync seek listener
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || !renditionRef.current) return;

      try {
        const { chapterIndex, chapterTitle, intraRatio, targetHref } = detail;
        let target = targetHref;

        if (!target && tocRef.current.length > 0) {
          if (typeof chapterIndex === "number" && tocRef.current[chapterIndex]) {
            target = tocRef.current[chapterIndex].href;
          } else if (chapterTitle) {
            const cleanTitle = chapterTitle.toLowerCase().replace(/[^\w\s]/g, "").trim();
            const match = tocRef.current.find((t) => {
              const cleanLabel = t.label.toLowerCase().replace(/[^\w\s]/g, "").trim();
              return cleanLabel.includes(cleanTitle) || cleanTitle.includes(cleanLabel);
            });
            if (match) target = match.href;
          }
        }

        if (target) {
          await renditionRef.current.display(target);

          if (intraRatio && intraRatio > 0 && intraRatio < 1) {
            const loc = renditionRef.current.currentLocation() as any;
            const total = loc?.start?.displayed?.total;
            if (total && total > 1) {
              const targetPage = Math.max(1, Math.min(total, Math.round(total * intraRatio)));
              for (let i = 1; i < targetPage; i++) {
                await renditionRef.current.next();
              }
            }
          }
        }
      } catch (err) {
        console.warn("Whispersync seek gracefully skipped on error:", err);
      }
    };

    window.addEventListener("rcloneflix:whispersync-seek", handler);
    return () => window.removeEventListener("rcloneflix:whispersync-seek", handler);
  }, []);

  const changeFontSize = (delta: number) => {
    const next = Math.max(12, Math.min(32, settings.fontSize + delta));
    setSettings((s) => ({ ...s, fontSize: next }));
  };

  const changeTheme = (theme: ReaderSettings["theme"]) => {
    setSettings((s) => ({ ...s, theme }));
  };

  const changeFontFamily = (fontFamily: ReaderSettings["fontFamily"]) => {
    setSettings((s) => ({ ...s, fontFamily }));
  };

  const changeLineHeight = (lineHeight: number) => {
    setSettings((s) => ({ ...s, lineHeight }));
  };

  const changeMargin = (margin: number) => {
    setSettings((s) => ({ ...s, margin }));
  };

  const isCurrentBookmarked = !!currentLocationInfo && bookmarks.some((b) => b.cfi === currentLocationInfo.cfi);

  const toggleBookmark = () => {
    if (!currentLocationInfo || !item?.id) return;
    if (isCurrentBookmarked) {
      const next = bookmarks.filter((b) => b.cfi !== currentLocationInfo.cfi);
      setBookmarks(next);
      localStorage.setItem(`rcloneflix_epub_bookmarks_${item.id}`, JSON.stringify(next));
      useToastStore.getState().addToast("Bookmark removed", "info");
    } else {
      const newBm: ReaderBookmark = {
        id: `bm-${Date.now()}`,
        cfi: currentLocationInfo.cfi,
        chapterTitle: currentLocationInfo.chapterTitle || "Bookmark",
        percentage: currentLocationInfo.percentage,
        createdAt: Date.now(),
      };
      const next = [newBm, ...bookmarks];
      setBookmarks(next);
      localStorage.setItem(`rcloneflix_epub_bookmarks_${item.id}`, JSON.stringify(next));
      useToastStore.getState().addToast("Bookmark saved", "success");
    }
  };

  const removeBookmark = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!item?.id) return;
    const next = bookmarks.filter((b) => b.id !== id);
    setBookmarks(next);
    localStorage.setItem(`rcloneflix_epub_bookmarks_${item.id}`, JSON.stringify(next));
    useToastStore.getState().addToast("Bookmark deleted", "info");
  };

  const jumpToBookmark = async (bm: ReaderBookmark) => {
    if (renditionRef.current) {
      await renditionRef.current.display(bm.cfi);
      setShowBookmarks(false);
    }
  };

  const bgStyle =
    settings.theme === "amoled"
      ? "bg-black text-[#D1D5DB]"
      : settings.theme === "dark"
      ? "bg-[#080A0F] text-[#C8D0DC]"
      : settings.theme === "sepia"
      ? "bg-[#F4ECD8] text-[#3B2D1A]"
      : "bg-white text-black";

  if (!item) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <p className="text-white font-body">No book selected.</p>
      </div>
    );
  }

  return (
    <div className={`fixed inset-0 flex flex-col select-none transition-colors duration-300 ${bgStyle}`}>
      {/* Top Navigation */}
      <div className="h-16 border-b border-white/10 flex items-center justify-between px-6 z-20">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-2 rounded-full hover:bg-white/10 text-white/80 hover:text-white transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="font-heading font-semibold text-sm truncate max-w-md">{item.title}</h1>
            {item.author && <p className="text-xs text-subtle font-body">{item.author}</p>}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Active Companion Audiobook Controls */}
          {isAudiobookActive && (
            <>
              {/* Whispersync Audio Sync Button */}
              <button
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("rcloneflix:request-whispersync-audio-seek"));
                  useToastStore.getState().addToast("Requested sync with companion audio", "info");
                }}
                title="Sync reader with companion audiobook narrator"
                className="px-2.5 py-1.5 rounded-lg bg-accent/20 hover:bg-accent/30 text-accent font-semibold text-xs border border-accent/40 flex items-center gap-1.5 transition-colors"
              >
                <Headphones size={15} />
                <span className="hidden md:inline">Sync Audio</span>
              </button>

              {/* Storyteller Immersion Reading & Read-Along Highlighting Toggle */}
              <button
                onClick={() => {
                  const next = !readAlongEnabled;
                  setReadAlongEnabled(next);
                  readAlongEngineRef.current?.setEnabled(next);
                  useToastStore
                    .getState()
                    .addToast(
                      next ? "Read-along karaoke highlight enabled" : "Read-along highlight paused",
                      "info"
                    );
                }}
                title={readAlongEnabled ? "Disable Read-Along Highlight" : "Enable Read-Along Highlight"}
                className={`px-2.5 py-1.5 rounded-lg font-semibold text-xs border flex items-center gap-1.5 transition-colors ${
                  readAlongEnabled
                    ? "bg-amber-500/25 border-amber-500/50 text-amber-300 shadow-sm shadow-amber-500/20"
                    : "bg-white/5 border-white/10 text-white/60 hover:text-white hover:bg-white/10"
                }`}
              >
                <Sparkles size={15} className={readAlongEnabled ? "text-amber-400" : ""} />
                <span className="hidden md:inline">Read Along</span>
              </button>

              {/* Quick Pair Management */}
              <button
                onClick={() => setShowPairModal(true)}
                title={`Paired with "${companion?.title || "Audiobook"}". Click to re-pair.`}
                className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-accent transition-colors"
              >
                <Link2 size={18} />
              </button>
            </>
          )}

          {/* Inactive Companion: 1-Click Launch or Pair */}
          {!isAudiobookActive && (
            <>
              {companion ? (
                <button
                  onClick={() => {
                    setAudioState({
                      playlist: [companion],
                      playlistIndex: 0,
                      playToken: Date.now(),
                    });
                    setReadAlongEnabled(true);
                    readAlongEngineRef.current?.setEnabled(true);
                    useToastStore
                      .getState()
                      .addToast(`Playing companion audiobook "${companion.title}"`, "success");
                  }}
                  title={`Start companion audiobook "${companion.title}" for Immersion Reading`}
                  className="px-2.5 py-1.5 rounded-lg bg-accent/20 hover:bg-accent/30 text-accent font-semibold text-xs border border-accent/40 flex items-center gap-1.5 transition-colors"
                >
                  <Headphones size={15} />
                  <span className="hidden sm:inline">
                    Listen ({companion.title.length > 20 ? companion.title.slice(0, 18) + "…" : companion.title})
                  </span>
                </button>
              ) : null}

              <button
                onClick={() => setShowPairModal(true)}
                title={
                  companion
                    ? `Paired with "${companion.title}". Click to switch companion audiobook.`
                    : "Pair a companion audiobook for Whispersync Immersion Reading"
                }
                className={`px-2.5 py-1.5 rounded-lg font-semibold text-xs border flex items-center gap-1.5 transition-colors ${
                  companion
                    ? "bg-white/5 border-white/10 text-white/80 hover:bg-white/10"
                    : "bg-accent/15 border-accent/30 text-accent hover:bg-accent/25"
                }`}
              >
                <Headphones size={15} />
                <span className="hidden md:inline">{companion ? "Change Pair" : "Pair Audiobook"}</span>
              </button>
            </>
          )}

          {/* Kaggle T4 GPU Whisper Alignment Button */}
          {companion && (
            <button
              onClick={() => setShowKaggleAlign(true)}
              title={`Align "${item?.title}" with companion "${companion.title}" via Kaggle T4 GPU (Whisper SMIL)`}
              className="p-2 rounded-lg bg-white/5 hover:bg-amber-500/20 text-amber-400 hover:text-amber-300 transition-colors"
            >
              <Cpu size={18} />
            </button>
          )}

          {/* Quick Bookmark Toggle Button */}
          <button
            onClick={toggleBookmark}
            disabled={!currentLocationInfo}
            title={isCurrentBookmarked ? "Remove Bookmark" : "Bookmark this page"}
            className={`p-2 rounded-lg transition-colors border ${
              isCurrentBookmarked
                ? "bg-accent/20 border-accent text-accent"
                : "bg-white/5 border-transparent hover:bg-white/10 text-white/80"
            }`}
          >
            <Bookmark size={18} className={isCurrentBookmarked ? "fill-accent" : ""} />
          </button>

          {/* Bookmarks Drawer Toggle */}
          <button
            onClick={() => setShowBookmarks(!showBookmarks)}
            title="Saved Bookmarks"
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/80 transition-colors relative"
          >
            <BookOpen size={18} />
            {bookmarks.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-accent text-[10px] font-bold text-white rounded-full h-4 w-4 flex items-center justify-center">
                {bookmarks.length}
              </span>
            )}
          </button>

          {/* Typography Settings Button */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            title="Reader Typography & Theme"
            className={`p-2 rounded-lg transition-colors ${
              showSettings ? "bg-accent text-white" : "bg-white/5 hover:bg-white/10 text-white/80"
            }`}
          >
            <Type size={18} />
          </button>
        </div>
      </div>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute right-6 top-20 w-80 bg-card border border-white/15 rounded-xl shadow-2xl p-5 z-30 flex flex-col gap-4 max-h-[calc(100vh-100px)] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="font-heading font-semibold text-sm text-white">Typography & Theme</span>
              <button onClick={() => setShowSettings(false)} className="text-white/60 hover:text-white">
                <X size={16} />
              </button>
            </div>

            {/* Font Size */}
            <div>
              <p className="text-xs font-mono uppercase tracking-wider text-white/40 mb-2">Font Size</p>
              <div className="flex items-center justify-between bg-white/5 rounded-lg p-2">
                <button
                  onClick={() => changeFontSize(-2)}
                  className="px-3 py-1 bg-white/10 hover:bg-white/20 rounded font-semibold text-white transition-colors"
                >
                  -
                </button>
                <span className="text-sm font-mono text-white font-medium">{settings.fontSize}px</span>
                <button
                  onClick={() => changeFontSize(2)}
                  className="px-3 py-1 bg-white/10 hover:bg-white/20 rounded font-semibold text-white transition-colors"
                >
                  +
                </button>
              </div>
            </div>

            {/* Font Family */}
            <div>
              <p className="text-xs font-mono uppercase tracking-wider text-white/40 mb-2">Font Family</p>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { id: "sans", label: "Sans-Serif" },
                    { id: "serif", label: "Serif" },
                    { id: "opendyslexic", label: "OpenDyslexic" },
                    { id: "mono", label: "Monospace" },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    onClick={() => changeFontFamily(f.id)}
                    className={`py-1.5 px-2 text-xs font-medium rounded-lg border text-center transition-all ${
                      settings.fontFamily === f.id
                        ? "border-accent bg-accent/20 text-accent font-bold"
                        : "border-white/10 hover:bg-white/5 text-white/70"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Line Height */}
            <div>
              <p className="text-xs font-mono uppercase tracking-wider text-white/40 mb-2">Line Spacing</p>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { val: 1.4, label: "Compact" },
                    { val: 1.8, label: "Normal" },
                    { val: 2.2, label: "Relaxed" },
                  ] as const
                ).map((lh) => (
                  <button
                    key={lh.val}
                    onClick={() => changeLineHeight(lh.val)}
                    className={`py-1.5 text-xs font-medium rounded-lg border text-center transition-all ${
                      settings.lineHeight === lh.val
                        ? "border-accent bg-accent/20 text-accent font-bold"
                        : "border-white/10 hover:bg-white/5 text-white/70"
                    }`}
                  >
                    {lh.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Margins */}
            <div>
              <p className="text-xs font-mono uppercase tracking-wider text-white/40 mb-2">Page Margin</p>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { val: 16, label: "Slim" },
                    { val: 32, label: "Normal" },
                    { val: 56, label: "Wide" },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.val}
                    onClick={() => changeMargin(m.val)}
                    className={`py-1.5 text-xs font-medium rounded-lg border text-center transition-all ${
                      settings.margin === m.val
                        ? "border-accent bg-accent/20 text-accent font-bold"
                        : "border-white/10 hover:bg-white/5 text-white/70"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Theme */}
            <div>
              <p className="text-xs font-mono uppercase tracking-wider text-white/40 mb-2">Theme</p>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { id: "dark", label: "Dark" },
                    { id: "amoled", label: "AMOLED Void" },
                    { id: "sepia", label: "Sepia" },
                    { id: "light", label: "Light" },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => changeTheme(t.id)}
                    className={`py-2 text-xs font-medium rounded-lg capitalize border transition-all ${
                      settings.theme === t.id
                        ? "border-accent bg-accent/20 text-accent font-bold"
                        : "border-white/10 hover:bg-white/5 text-white/70"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bookmarks Drawer */}
      <AnimatePresence>
        {showBookmarks && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowBookmarks(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30"
            />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-80 max-w-full bg-[#0d1117] border-l border-white/15 z-40 p-5 flex flex-col shadow-2xl"
            >
              <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-4">
                <div className="flex items-center gap-2">
                  <Bookmark size={18} className="text-accent" />
                  <span className="font-heading font-semibold text-sm text-white">
                    Bookmarks ({bookmarks.length})
                  </span>
                </div>
                <button
                  onClick={() => setShowBookmarks(false)}
                  className="p-1 rounded-lg hover:bg-white/10 text-white/60 hover:text-white"
                >
                  <X size={18} />
                </button>
              </div>

              {bookmarks.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-subtle">
                  <BookmarkPlus size={40} className="text-white/20 mb-3" />
                  <p className="text-sm font-medium text-white/80">No bookmarks yet</p>
                  <p className="text-xs text-white/50 mt-1">
                    Click the bookmark icon in the top toolbar to save your reading spot.
                  </p>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                  {bookmarks.map((bm) => (
                    <div
                      key={bm.id}
                      onClick={() => jumpToBookmark(bm)}
                      className="group p-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-accent/40 cursor-pointer transition-all flex items-start justify-between gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-white truncate">
                          {bm.chapterTitle || "Bookmark"}
                        </p>
                        <div className="flex items-center gap-2 mt-1 text-[11px] text-white/50">
                          {bm.percentage != null && (
                            <span className="font-mono text-accent">{bm.percentage}%</span>
                          )}
                          <span>•</span>
                          <span>{new Date(bm.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => removeBookmark(bm.id, e)}
                        title="Delete Bookmark"
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-danger/20 text-white/40 hover:text-danger transition-all"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main EPUB Reader View */}
      <div
        className="flex-1 relative flex items-center justify-center overflow-hidden"
        style={{ paddingBottom: audioState ? "72px" : "0" }}
      >
        {downloading && (
          <div className="flex flex-col items-center gap-3">
            <Loader2 size={32} className="text-accent animate-spin" />
            <p className="text-xs font-body text-subtle">Downloading EPUB from remote…</p>
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center gap-3 px-8 text-center">
            <p className="text-danger font-body text-sm">{error}</p>
            <button onClick={() => navigate(-1)} className="btn-secondary text-xs mt-2">Go Back</button>
          </div>
        )}

        {/* EPUB DOM Container */}
        <div
          ref={containerRef}
          className="w-full h-full py-8 max-w-4xl mx-auto transition-all"
          style={{ paddingLeft: `${settings.margin}px`, paddingRight: `${settings.margin}px` }}
        />

        {/* Page Nav Arrows */}
        {!loading && !downloading && !error && (
          <>
            <button
              onClick={() => renditionRef.current?.prev()}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 hover:bg-black/70 text-white transition-colors"
            >
              <ChevronLeft size={24} />
            </button>
            <button
              onClick={() => renditionRef.current?.next()}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/40 hover:bg-black/70 text-white transition-colors"
            >
              <ChevronRight size={24} />
            </button>
          </>
        )}
      </div>

      {showPairModal && item && (
        <PairAudiobookModal
          isOpen={showPairModal}
          item={item}
          currentPair={companion}
          onClose={() => setShowPairModal(false)}
        />
      )}

      {showKaggleAlign && item && companion && (
        <KaggleAlignModal
          isOpen={showKaggleAlign}
          onClose={() => setShowKaggleAlign(false)}
          epubItem={item}
          audioItem={companion}
        />
      )}
    </div>
  );
}
