import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, BookOpen, Sparkles, Clock, Music, Layers,
  Check, Loader2, Plus, Trash2, AlertCircle, FileAudio, CheckCircle2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { downloadDir } from "@tauri-apps/api/path";
import { useAppStore, type MediaItem } from "../../store/appStore";
import { getDownloadedFilePath } from "../../lib/downloadManager";

export type ChapterEntry = {
  start: number;
  end: number;
  title: string;
};

type Props = {
  items: MediaItem[]; // 1 or more tracks representing the audiobook
  onClose: () => void;
  onSuccess?: (outputPath: string) => void;
};

export function AudiobookConverterModal({ items, onClose, onSuccess }: Props) {
  const { rcloneConfigPath, libraries } = useAppStore();

  const firstItem = items[0];
  const initialTitle = firstItem?.album || firstItem?.title || "Audiobook";
  const initialAuthor = firstItem?.author || firstItem?.artist || "";
  const initialCover = firstItem?.posterUrl || "";

  const [title, setTitle] = useState(initialTitle);
  const [author, setAuthor] = useState(initialAuthor);
  const [coverImage, setCoverImage] = useState(initialCover);
  const [bitrate, setBitrate] = useState<"64k" | "128k">("64k");

  // Chapter strategy:
  // "files": 1 chapter per file (if multi-file)
  // "silence": ffmpeg silence detection (for single long files)
  // "interval": fixed interval chapters (e.g. 15 mins, Storyleaf style)
  // "embedded": read embedded ID3v2/MP4 chapters
  const isMultiFile = items.length > 1;
  const [strategy, setStrategy] = useState<"files" | "silence" | "interval" | "embedded">(
    isMultiFile ? "files" : "interval"
  );
  const [intervalMinutes, setIntervalMinutes] = useState(15);
  const [minSilenceDuration, setMinSilenceDuration] = useState(1.5);
  const [noiseDb, setNoiseDb] = useState(-30);

  const [chapters, setChapters] = useState<ChapterEntry[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [progressMsg, setProgressMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resultPath, setResultPath] = useState<string | null>(null);

  // Helper to format seconds into HH:MM:SS
  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return "0:00";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  // Resolve stream or local file path for an item
  const resolveFilePath = async (item: MediaItem): Promise<string> => {
    const local = await getDownloadedFilePath(item);
    if (local) return local;

    if (item.remotePath.startsWith("http://") || item.remotePath.startsWith("https://")) {
      return item.remotePath;
    }

    let matchingRoot = "";
    let relPath = "";

    const colonIdx = item.remotePath.indexOf(":");
    if (colonIdx > 0) {
      const remoteName = item.remotePath.slice(0, colonIdx);
      const afterColon = item.remotePath.slice(colonIdx + 1).replace(/^\/+/, "");
      const library = libraries.find((l) => l.id === item.libraryId);
      matchingRoot =
        library?.remotePaths.find((p) =>
          item.remotePath.startsWith(p.replace(/\/$/, "") + "/")
        ) ?? `${remoteName}:`;

      const libRoot = matchingRoot.replace(/\/$/, "");
      relPath = item.remotePath.startsWith(libRoot + "/")
        ? item.remotePath.slice(libRoot.length + 1)
        : afterColon;
    } else {
      const library = libraries.find((l) => l.id === item.libraryId);
      matchingRoot = library?.remotePaths[0] ?? "";
      relPath = item.remotePath.split("/").pop() ?? item.filename;
    }

    const res = await invoke<{ file_url: string }>("start_stream_session", {
      configPath: rcloneConfigPath,
      remoteRoot: matchingRoot,
      filePath: relPath,
      sessionId: `convert-${item.id}`,
    });
    return res.file_url;
  };

  // Build chapter list based on strategy
  const buildChapters = async () => {
    if (!firstItem) return;
    setDetecting(true);
    setError(null);
    try {
      if (strategy === "files" && isMultiFile) {
        // Multi-file: each file is a chapter
        // We will approximate or probe each track duration
        const newChapters: ChapterEntry[] = [];
        let runningTime = 0;
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          // Try to get duration or assume 0 until probed
          const trackDuration = 1800; // placeholder, or probed
          const chTitle = it.title || `Chapter ${i + 1}`;
          newChapters.push({
            start: runningTime,
            end: runningTime + trackDuration,
            title: chTitle,
          });
          runningTime += trackDuration;
        }
        setChapters(newChapters);
      } else if (strategy === "embedded") {
        // Read embedded ID3v2/MP4 chapters
        const fileUrl = await resolveFilePath(firstItem);
        const embedded = await invoke<Array<{ id: number; start: number; end: number; title: string }>>(
          "get_audio_chapters",
          { fileUrl }
        );
        if (embedded && embedded.length > 0) {
          setChapters(
            embedded.map((e) => ({
              start: e.start,
              end: e.end,
              title: e.title,
            }))
          );
        } else {
          setError("No embedded chapter tags found in source file.");
        }
      } else if (strategy === "silence") {
        // Detect silences with ffmpeg
        const fileUrl = await resolveFilePath(firstItem);
        const silences = await invoke<number[]>("detect_audio_silences", {
          fileUrl,
          minDurationSec: minSilenceDuration,
          noiseDb: noiseDb,
        });

        if (silences && silences.length > 0) {
          const newChapters: ChapterEntry[] = [];
          let lastStart = 0;
          for (let i = 0; i < silences.length; i++) {
            const splitTime = silences[i];
            newChapters.push({
              start: lastStart,
              end: splitTime,
              title: `Chapter ${i + 1}`,
            });
            lastStart = splitTime;
          }
          newChapters.push({
            start: lastStart,
            end: lastStart + 3600, // end marker
            title: `Chapter ${silences.length + 1}`,
          });
          setChapters(newChapters);
        } else {
          setError("No silences detected with current settings. Try lowering minimum silence duration.");
        }
      } else if (strategy === "interval") {
        // Fixed interval chapters (Storyleaf fallback)
        const totalDuration = 3600 * 5; // default 5h or probe
        const intervalSec = intervalMinutes * 60;
        const count = Math.ceil(totalDuration / intervalSec);
        const newChapters: ChapterEntry[] = [];
        for (let i = 0; i < count; i++) {
          newChapters.push({
            start: i * intervalSec,
            end: (i + 1) * intervalSec,
            title: `Chapter ${i + 1}`,
          });
        }
        setChapters(newChapters);
      }
    } catch (err) {
      console.error("Chapter generation failed:", err);
      setError(`Detection failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    buildChapters();
  }, [strategy, intervalMinutes]);

  const handleUpdateChapterTitle = (idx: number, newTitle: string) => {
    setChapters((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, title: newTitle } : c))
    );
  };

  const handleRemoveChapter = (idx: number) => {
    setChapters((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleAddChapter = () => {
    const last = chapters[chapters.length - 1];
    const newStart = last ? last.end : 0;
    setChapters((prev) => [
      ...prev,
      {
        start: newStart,
        end: newStart + 900,
        title: `Chapter ${prev.length + 1}`,
      },
    ]);
  };

  const handleStartConversion = async () => {
    if (!firstItem) return;
    setConverting(true);
    setProgressMsg("Resolving source files...");
    setError(null);

    try {
      const inputFiles: string[] = [];
      for (let i = 0; i < items.length; i++) {
        setProgressMsg(`Preparing file ${i + 1} of ${items.length}...`);
        const p = await resolveFilePath(items[i]);
        inputFiles.push(p);
      }

      // Output directory: save in download directory
      const cleanTitle = title.replace(/[/\\?%*:|"<>]/g, "_").trim();
      let dlDir = "";
      try {
        dlDir = await downloadDir();
      } catch {}
      const outputPath = dlDir
        ? `${dlDir.replace(/[/\\]+$/, "")}/${cleanTitle}.m4b`
        : `${cleanTitle}.m4b`;

      let resolvedCover: string | null = null;
      if (coverImage && coverImage.trim()) {
        if (coverImage.startsWith("http://") || coverImage.startsWith("https://") || coverImage.startsWith("/")) {
          resolvedCover = coverImage;
        } else {
          try {
            const dummyItem: MediaItem = {
              id: "cover-img",
              title: "Cover",
              libraryId: "explorer",
              libraryType: "audiobooks",
              remotePath: coverImage,
              filename: coverImage.split("/").pop() || "cover.jpg",
              addedAt: Date.now(),
              lastScannedAt: Date.now(),
            };
            resolvedCover = await resolveFilePath(dummyItem);
          } catch (e) {
            console.warn("Could not resolve cover URL:", e);
          }
        }
      }

      setProgressMsg("Encoding AAC audio & writing M4B chapters with FFmpeg...");
      const res = await invoke<string>("convert_audiobook_m4b_local", {
        req: {
          input_files: inputFiles,
          chapters: chapters.map((c) => ({
            start: c.start,
            end: c.end,
            title: c.title,
          })),
          output_path: outputPath,
          title: title,
          author: author ? author : null,
          cover_image: resolvedCover ? resolvedCover : (coverImage ? coverImage : null),
          bitrate: bitrate || "64k",
        },
      });

      setResultPath(res);
      setProgressMsg("Conversion complete!");
      if (onSuccess) {
        onSuccess(res);
      }
    } catch (err) {
      console.error("M4B conversion failed:", err);
      setError(`Conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        className="bg-panel border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden text-text"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-card/60">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent/20 border border-accent/40 flex items-center justify-center text-accent">
              <BookOpen size={18} />
            </div>
            <div>
              <h2 className="text-base font-heading font-semibold text-white">
                Audiobook M4B Converter & Smart Chapterizer
              </h2>
              <p className="text-xs text-subtle font-body">
                Convert MP3 audiobooks into standard chapterized Apple/iPod M4B format
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/10 text-subtle hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-400 flex items-start gap-2.5">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {resultPath ? (
            <div className="py-8 text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center mx-auto">
                <CheckCircle2 size={28} />
              </div>
              <div>
                <h3 className="text-lg font-heading font-bold text-white">Conversion Successful!</h3>
                <p className="text-xs text-subtle mt-1 font-mono break-all max-w-md mx-auto">
                  {resultPath}
                </p>
              </div>
              <p className="text-xs text-subtle">
                The audiobook has been compiled into a single M4B file with embedded QuickTime chapters and metadata.
              </p>
              <button
                onClick={onClose}
                className="px-5 py-2 rounded-xl bg-accent text-void font-semibold text-xs hover:bg-accent/90 transition-colors"
              >
                Close & Return
              </button>
            </div>
          ) : (
            <>
              {/* Metadata Inputs */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-subtle mb-1">
                    Book Title
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full px-3 py-2 bg-card border border-border rounded-xl text-xs text-text focus:outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-subtle mb-1">
                    Author / Narrator
                  </label>
                  <input
                    type="text"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    className="w-full px-3 py-2 bg-card border border-border rounded-xl text-xs text-text focus:outline-none focus:border-accent"
                  />
                </div>
              </div>

              {/* Cover & Quality */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-subtle mb-1">
                    Cover Art URL / Path
                  </label>
                  <input
                    type="text"
                    placeholder="https://... or /path/to/cover.jpg"
                    value={coverImage}
                    onChange={(e) => setCoverImage(e.target.value)}
                    className="w-full px-3 py-2 bg-card border border-border rounded-xl text-xs text-text focus:outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-subtle mb-1">
                    Audio Quality (AAC)
                  </label>
                  <select
                    value={bitrate}
                    onChange={(e) => setBitrate(e.target.value as any)}
                    className="w-full px-3 py-2 bg-card border border-border rounded-xl text-xs text-text focus:outline-none focus:border-accent"
                  >
                    <option value="64k">64 kbps (Standard Speech - Compact Size)</option>
                    <option value="128k">128 kbps (High Fidelity Audiobook)</option>
                  </select>
                </div>
              </div>

              {/* Chapter Strategy */}
              <div className="space-y-3">
                <label className="block text-xs font-semibold text-subtle">
                  Smart Chapterization Strategy
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {isMultiFile && (
                    <button
                      type="button"
                      onClick={() => setStrategy("files")}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        strategy === "files"
                          ? "bg-accent/15 border-accent text-accent"
                          : "bg-card border-border text-subtle hover:text-text hover:bg-muted"
                      }`}
                    >
                      <Layers size={16} className="mb-1.5" />
                      <p className="text-xs font-semibold">Per-File Chapters</p>
                      <p className="text-[10px] opacity-75 mt-0.5">{items.length} tracks</p>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setStrategy("interval")}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      strategy === "interval"
                        ? "bg-accent/15 border-accent text-accent"
                        : "bg-card border-border text-subtle hover:text-text hover:bg-muted"
                    }`}
                  >
                    <Clock size={16} className="mb-1.5" />
                    <p className="text-xs font-semibold">Fixed Interval</p>
                    <p className="text-[10px] opacity-75 mt-0.5">Every {intervalMinutes}m</p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setStrategy("silence")}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      strategy === "silence"
                        ? "bg-accent/15 border-accent text-accent"
                        : "bg-card border-border text-subtle hover:text-text hover:bg-muted"
                    }`}
                  >
                    <Sparkles size={16} className="mb-1.5" />
                    <p className="text-xs font-semibold">Silence Detect</p>
                    <p className="text-[10px] opacity-75 mt-0.5">Pause timestamps</p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setStrategy("embedded")}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      strategy === "embedded"
                        ? "bg-accent/15 border-accent text-accent"
                        : "bg-card border-border text-subtle hover:text-text hover:bg-muted"
                    }`}
                  >
                    <Music size={16} className="mb-1.5" />
                    <p className="text-xs font-semibold">Embedded ID3</p>
                    <p className="text-[10px] opacity-75 mt-0.5">Parse tags</p>
                  </button>
                </div>

                {/* Sub-options for strategy */}
                {strategy === "interval" && (
                  <div className="flex items-center gap-3 p-3 bg-card/60 border border-border rounded-xl">
                    <span className="text-xs text-subtle">Chapter Interval:</span>
                    {[10, 15, 20, 30].map((m) => (
                      <button
                        key={m}
                        onClick={() => setIntervalMinutes(m)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                          intervalMinutes === m
                            ? "bg-accent text-void"
                            : "bg-muted text-subtle hover:text-text"
                        }`}
                      >
                        {m} min
                      </button>
                    ))}
                  </div>
                )}

                {strategy === "silence" && (
                  <div className="flex items-center gap-4 p-3 bg-card/60 border border-border rounded-xl text-xs">
                    <div>
                      <span className="text-subtle mr-2">Min Pause:</span>
                      <input
                        type="number"
                        step="0.5"
                        min="0.5"
                        max="5.0"
                        value={minSilenceDuration}
                        onChange={(e) => setMinSilenceDuration(parseFloat(e.target.value) || 1.5)}
                        className="w-16 px-2 py-1 bg-panel border border-border rounded text-text"
                      />
                      <span className="text-subtle ml-1">sec</span>
                    </div>
                    <div>
                      <span className="text-subtle mr-2">Threshold:</span>
                      <input
                        type="number"
                        step="5"
                        min="-60"
                        max="-10"
                        value={noiseDb}
                        onChange={(e) => setNoiseDb(parseInt(e.target.value) || -30)}
                        className="w-16 px-2 py-1 bg-panel border border-border rounded text-text"
                      />
                      <span className="text-subtle ml-1">dB</span>
                    </div>
                    <button
                      onClick={buildChapters}
                      disabled={detecting}
                      className="px-3 py-1 bg-accent/20 hover:bg-accent/30 text-accent rounded-lg font-semibold ml-auto"
                    >
                      {detecting ? "Scanning..." : "Re-Detect"}
                    </button>
                  </div>
                )}
              </div>

              {/* Chapters Preview Table */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-subtle flex items-center gap-2">
                    <span>Chapters Preview ({chapters.length})</span>
                    {detecting && <Loader2 size={13} className="animate-spin text-accent" />}
                  </label>
                  <button
                    onClick={handleAddChapter}
                    className="flex items-center gap-1 text-[11px] text-accent hover:underline"
                  >
                    <Plus size={12} /> Add Chapter
                  </button>
                </div>

                <div className="max-h-48 overflow-y-auto border border-border rounded-xl divide-y divide-border bg-card/40">
                  {chapters.length === 0 ? (
                    <div className="p-4 text-center text-xs text-subtle">
                      No chapters generated yet.
                    </div>
                  ) : (
                    chapters.map((ch, idx) => (
                      <div key={idx} className="p-2 flex items-center gap-3 text-xs">
                        <span className="w-8 font-mono text-[10px] text-subtle text-right">
                          #{idx + 1}
                        </span>
                        <input
                          type="text"
                          value={ch.title}
                          onChange={(e) => handleUpdateChapterTitle(idx, e.target.value)}
                          className="flex-1 px-2 py-1 bg-panel border border-border rounded text-xs text-text focus:outline-none focus:border-accent"
                        />
                        <span className="text-[10px] font-mono text-subtle">
                          {formatTime(ch.start)} - {formatTime(ch.end)}
                        </span>
                        <button
                          onClick={() => handleRemoveChapter(idx)}
                          className="p-1 text-subtle hover:text-red-400 rounded"
                          title="Remove chapter"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer Actions */}
        {!resultPath && (
          <div className="px-6 py-4 border-t border-border bg-card/60 flex items-center justify-between">
            <span className="text-xs text-subtle">
              {converting ? progressMsg : `${items.length} source file(s) ready`}
            </span>
            <div className="flex items-center gap-3">
              <button
                onClick={onClose}
                disabled={converting}
                className="px-4 py-2 text-xs font-semibold text-subtle hover:text-text transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleStartConversion}
                disabled={converting || chapters.length === 0}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-accent text-void font-semibold text-xs hover:bg-accent/90 disabled:opacity-50 transition-colors"
              >
                {converting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    <span>Converting...</span>
                  </>
                ) : (
                  <>
                    <BookOpen size={14} />
                    <span>Convert to M4B</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
