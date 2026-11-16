import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, ArrowLeft, Sun, Moon, Type, BookOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { MediaItem } from "../../store/appStore";
import { useAppStore } from "../../store/appStore";

// epub.js is loaded via CDN in index.html for simplicity
declare const ePub: (url: string) => {
  renderTo: (el: Element, options?: object) => {
    display: (cfi?: string) => Promise<void>;
    next: () => Promise<void>;
    prev: () => Promise<void>;
    on: (event: string, cb: (cfi: string) => void) => void;
    themes: { fontSize: (s: string) => void; select: (name: string) => void; register: (name: string, styles: object) => void };
    location: { start: { cfi: string } };
  };
};

type ReaderSettings = {
  fontSize: number;
  theme: "dark" | "sepia" | "light";
};

export function EpubReaderPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { item } = (location.state ?? {}) as { item: MediaItem };
  const { rcloneConfigPath, libraries, updateWatchProgress, watchProgress } = useAppStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<ReturnType<ReturnType<typeof ePub>["renderTo"]> | null>(null);

  const [settings, setSettings] = useState<ReaderSettings>({ fontSize: 16, theme: "dark" });
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);

  const sessionId = useRef(`epub-${Date.now()}`);

  // Start stream session to get the file URL
  useEffect(() => {
    if (!item) return;
    const library = libraries.find((l) => l.id === item.libraryId);
    if (!library) return;

    const remoteRoot = library.remotePath;
    const relPath = item.remotePath
      .replace(remoteRoot.replace(/\/$/, "") + "/", "");

    invoke<{ file_url: string }>("start_stream_session", {
      configPath: rcloneConfigPath,
      remoteRoot,
      filePath: relPath,
      sessionId: sessionId.current,
    })
      .then((s) => setStreamUrl(s.file_url))
      .catch((e) => setError(String(e)));

    return () => {
      invoke("stop_stream_session", { sessionId: sessionId.current }).catch(() => {});
    };
  }, [item?.id]);

  // Init epub.js once URL is ready
  useEffect(() => {
    if (!streamUrl || !containerRef.current) return;

    // epub.js must be loaded; check if available
    if (typeof (window as unknown as Record<string, unknown>)["ePub"] === "undefined") {
      setError("epub.js not loaded. Please check your internet connection.");
      return;
    }

    const epubFn = (window as unknown as Record<string, unknown>)["ePub"] as typeof ePub;
    const book = epubFn(streamUrl);
    const rendition = book.renderTo(containerRef.current!, {
      width: "100%",
      height: "100%",
      spread: "none",
    });

    renditionRef.current = rendition;

    // Register themes
    rendition.themes.register("dark", {
      "body": { background: "#080A0F", color: "#C8D0DC" },
      "p": { "line-height": "1.8" },
    });
    rendition.themes.register("sepia", {
      "body": { background: "#F4ECD8", color: "#3B2D1A" },
    });
    rendition.themes.register("light", {
      "body": { background: "#FFFFFF", color: "#1A1A2E" },
    });
    rendition.themes.select(settings.theme);
    rendition.themes.fontSize(`${settings.fontSize}px`);

    // Restore position
    const existing = watchProgress[item.id];
    rendition.display(existing?.position ? String(existing.position) : undefined)
      .then(() => setLoading(false))
      .catch(() => setLoading(false));

    // Save position on page turn
    rendition.on("relocated", (location: string) => {
      updateWatchProgress({
        itemId: item.id,
        position: location as unknown as number,
        duration: 0,
        completed: false,
        lastWatchedAt: Date.now(),
      });
    });

    return () => {
      renditionRef.current = null;
    };
  }, [streamUrl]);

  // Apply theme/font changes
  useEffect(() => {
    const r = renditionRef.current;
    if (!r) return;
    r.themes.select(settings.theme);
    r.themes.fontSize(`${settings.fontSize}px`);
  }, [settings]);

  const themeColors = {
    dark: { bg: "#080A0F", text: "#C8D0DC" },
    sepia: { bg: "#F4ECD8", text: "#3B2D1A" },
    light: { bg: "#FFFFFF", text: "#1A1A2E" },
  };

  const colors = themeColors[settings.theme];

  if (!item) return null;

  return (
    <div
      className="fixed inset-0 flex flex-col"
      style={{ background: colors.bg, color: colors.text }}
    >
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-6 py-3 border-b"
        style={{ borderColor: "rgba(128,128,128,0.2)", background: colors.bg }}
      >
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 opacity-60 hover:opacity-100 transition-opacity"
        >
          <ArrowLeft size={18} />
          <span className="font-body text-sm">Back</span>
        </button>
        <div className="flex items-center gap-2">
          <BookOpen size={16} className="opacity-50" />
          <span className="font-body text-sm font-medium truncate max-w-xs">{item.title}</span>
        </div>
        <button
          onClick={() => setShowSettings((s) => !s)}
          className="opacity-60 hover:opacity-100 transition-opacity"
        >
          <Type size={18} />
        </button>
      </div>

      {/* Settings panel */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="absolute top-12 right-4 z-20 bg-panel border border-border rounded-xl p-4 shadow-card-hover min-w-[220px]"
          >
            <p className="text-text font-body text-xs font-semibold uppercase tracking-wider mb-3">
              Reading Settings
            </p>

            {/* Font size */}
            <div className="mb-4">
              <p className="text-subtle font-body text-xs mb-2">Font Size: {settings.fontSize}px</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSettings((s) => ({ ...s, fontSize: Math.max(12, s.fontSize - 2) }))}
                  className="w-7 h-7 rounded bg-muted hover:bg-border text-text text-sm flex items-center justify-center"
                >A-</button>
                <div className="flex-1 h-1 bg-muted rounded-full">
                  <div
                    className="h-full bg-accent rounded-full transition-all"
                    style={{ width: `${((settings.fontSize - 12) / 16) * 100}%` }}
                  />
                </div>
                <button
                  onClick={() => setSettings((s) => ({ ...s, fontSize: Math.min(28, s.fontSize + 2) }))}
                  className="w-7 h-7 rounded bg-muted hover:bg-border text-text text-sm flex items-center justify-center"
                >A+</button>
              </div>
            </div>

            {/* Theme */}
            <div>
              <p className="text-subtle font-body text-xs mb-2">Theme</p>
              <div className="flex gap-2">
                {(["dark", "sepia", "light"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setSettings((s) => ({ ...s, theme: t }))}
                    className={`flex-1 py-2 rounded-lg text-xs font-body border transition-all ${
                      settings.theme === t ? "border-accent text-accent" : "border-border text-subtle"
                    }`}
                    style={{
                      background: themeColors[t].bg,
                      color: themeColors[t].text,
                    }}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reader area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Prev page */}
        <button
          onClick={() => renditionRef.current?.prev()}
          className="w-14 flex items-center justify-center opacity-20 hover:opacity-60 transition-opacity flex-shrink-0"
        >
          <ChevronLeft size={24} />
        </button>

        {/* Content */}
        <div className="flex-1 relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="font-body text-sm opacity-50">Loading book...</p>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="font-body text-sm text-danger">{error}</p>
            </div>
          )}
          <div ref={containerRef} className="w-full h-full" />
        </div>

        {/* Next page */}
        <button
          onClick={() => renditionRef.current?.next()}
          className="w-14 flex items-center justify-center opacity-20 hover:opacity-60 transition-opacity flex-shrink-0"
        >
          <ChevronRight size={24} />
        </button>
      </div>
    </div>
  );
}
