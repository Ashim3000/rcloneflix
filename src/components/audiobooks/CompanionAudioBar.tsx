import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Gauge,
  X,
  ChevronDown,
  ChevronUp,
  Headphones,
  ArrowRightLeft,
  BookOpen,
  Link,
  Loader2,
  Check,
  RefreshCw,
  SkipBack,
  SkipForward,
  Layers,
} from "lucide-react";
import type { MediaItem } from "../../store/appStore";
import { useAppStore } from "../../store/appStore";
import { useArtwork } from "../../lib/artwork";
import {
  resolveAudiobookStreamUrl,
  syncAudioTimeToEpub,
  syncEpubPercentageToAudio,
  type WhispersyncAlignment,
  type AlignedChapter,
} from "../../lib/whispersync";
import { ChapterAlignmentModal } from "./ChapterAlignmentModal";

type Props = {
  audiobook: MediaItem;
  initialPercentage?: number;
  onSyncPageToAudio?: (percentage: number, cfi?: string) => void;
  getCurrentReaderPercentage: () => number;
  onClose: () => void;
  onOpenPairModal?: () => void;
  alignment: WhispersyncAlignment | null;
  onReScanAlignment?: () => void;
  isScanningAlignment?: boolean;
  onOpenKaggleAlign?: () => void;
};

const SPEED_OPTIONS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const remSec = s % 60;
  if (m < 60) {
    return `${m}:${remSec.toString().padStart(2, "0")}`;
  }
  const h = Math.floor(m / 60);
  const remMin = m % 60;
  return `${h}:${remMin.toString().padStart(2, "0")}:${remSec.toString().padStart(2, "0")}`;
}

export function CompanionAudioBar({
  audiobook,
  initialPercentage,
  onSyncPageToAudio,
  getCurrentReaderPercentage,
  onClose,
  onOpenPairModal,
  alignment,
  onReScanAlignment,
  isScanningAlignment = false,
  onOpenKaggleAlign,
}: Props) {
  const { rcloneConfigPath, libraries, updateWatchProgress, watchProgress } = useAppStore();

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const posterSrc = useArtwork(audiobook.posterUrl);

  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(audiobook.duration || 0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1.0);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [showAlignmentModal, setShowAlignmentModal] = useState(false);

  const lastSavedTimeRef = useRef(0);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerNotice = useCallback((msg: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setSyncNotice(msg);
    noticeTimerRef.current = setTimeout(() => setSyncNotice(null), 3500);
  }, []);

  // Compute active chapter based on current playback time and alignment
  const activeChapter = useMemo(() => {
    if (!alignment || !alignment.chapters || alignment.chapters.length === 0) return null;
    return (
      alignment.chapters.find((ch) => currentTime >= ch.audioStartSec && currentTime < ch.audioEndSec) ||
      alignment.chapters[0]
    );
  }, [alignment, currentTime]);

  // 1. Resolve audiobook stream URL
  useEffect(() => {
    let active = true;
    setLoading(true);

    resolveAudiobookStreamUrl(audiobook, rcloneConfigPath, libraries)
      .then((url) => {
        if (!active) return;
        setStreamUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        console.warn("Failed resolving companion audiobook stream:", err);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [audiobook.id, rcloneConfigPath, libraries]);

  // 2. Initial position positioning
  useEffect(() => {
    if (!audioRef.current || !streamUrl) return;
    const existing = watchProgress[audiobook.id];
    const totalDur = audiobook.duration || existing?.duration || duration || 0;

    let targetSec = 0;
    if (initialPercentage !== undefined && initialPercentage > 0 && totalDur > 0) {
      targetSec = Math.round(initialPercentage * totalDur);
    } else if (existing?.position && existing.position > 0) {
      targetSec = existing.position;
    }

    if (targetSec > 0) {
      audioRef.current.currentTime = targetSec;
      setCurrentTime(targetSec);
    }
  }, [streamUrl, audiobook.id]);

  // 3. Audio event handlers
  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const curr = audio.currentTime;
    setCurrentTime(curr);

    // Throttle progress persistence to Zustand store (at most once every 10 seconds)
    const now = Date.now();
    if (now - lastSavedTimeRef.current >= 10000) {
      lastSavedTimeRef.current = now;
      saveProgress(curr, audio.duration || duration);
    }
  };

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.duration && !isNaN(audio.duration) && audio.duration > 0) {
      setDuration(audio.duration);
    }
    setLoading(false);
  };

  // 4. Save progress helper
  const saveProgress = useCallback(
    (timeSec: number, durSec: number) => {
      if (!audiobook || timeSec < 0) return;
      const effectiveDur = durSec > 0 ? durSec : duration;
      const pct = effectiveDur > 0 ? Math.max(0, Math.min(1, timeSec / effectiveDur)) : 0;

      updateWatchProgress({
        itemId: audiobook.id,
        position: Math.round(timeSec),
        duration: Math.round(effectiveDur),
        percentage: pct,
        completed: pct >= 0.95,
        lastWatchedAt: Date.now(),
      });
    },
    [audiobook, duration, updateWatchProgress]
  );

  // Save on unmount or pause
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        saveProgress(audioRef.current.currentTime, audioRef.current.duration);
      }
    };
  }, [saveProgress]);

  // Controls
  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().then(() => setPlaying(true)).catch((e) => console.warn("Audio play prevented:", e));
    } else {
      audio.pause();
      setPlaying(false);
      saveProgress(audio.currentTime, audio.duration);
    }
  };

  const skipSeconds = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = Math.max(0, Math.min(audio.duration || duration, audio.currentTime + delta));
    audio.currentTime = next;
    setCurrentTime(next);
  };

  const skipToPrevChapter = () => {
    if (!alignment || !alignment.chapters || alignment.chapters.length === 0 || !audioRef.current) return;
    const currIdx = alignment.chapters.findIndex(
      (ch) => currentTime >= ch.audioStartSec && currentTime < ch.audioEndSec
    );
    if (currIdx > 0) {
      const prevCh = alignment.chapters[currIdx - 1];
      audioRef.current.currentTime = prevCh.audioStartSec;
      setCurrentTime(prevCh.audioStartSec);
      triggerNotice(`Jumped to "${prevCh.title}"`);
    } else if (currIdx === 0) {
      audioRef.current.currentTime = alignment.chapters[0].audioStartSec;
      setCurrentTime(alignment.chapters[0].audioStartSec);
    }
  };

  const skipToNextChapter = () => {
    if (!alignment || !alignment.chapters || alignment.chapters.length === 0 || !audioRef.current) return;
    const currIdx = alignment.chapters.findIndex(
      (ch) => currentTime >= ch.audioStartSec && currentTime < ch.audioEndSec
    );
    if (currIdx >= 0 && currIdx + 1 < alignment.chapters.length) {
      const nextCh = alignment.chapters[currIdx + 1];
      audioRef.current.currentTime = nextCh.audioStartSec;
      setCurrentTime(nextCh.audioStartSec);
      triggerNotice(`Jumped to "${nextCh.title}"`);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const val = parseFloat(e.target.value);
    audio.currentTime = val;
    setCurrentTime(val);
  };

  const handleSpeedSelect = (s: number) => {
    setSpeed(s);
    if (audioRef.current) audioRef.current.playbackRate = s;
    setShowSpeedMenu(false);
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = !muted;
    setMuted(next);
    audio.muted = next;
  };

  // Sync Actions: Chapter-Aligned Precision
  const handleSyncPageToAudio = () => {
    const audio = audioRef.current;
    const dur = audio?.duration || duration || audiobook.duration || 0;
    if (dur <= 0 || !onSyncPageToAudio) return;

    if (alignment && alignment.chapters.length > 0) {
      const res = syncAudioTimeToEpub(currentTime, alignment);
      if (res) {
        onSyncPageToAudio(res.targetPercentage, res.targetCfi);
        triggerNotice(`Synced reader to "${res.activeChapter.title}" (${Math.round(res.targetPercentage * 100)}%)`);
        return;
      }
    }

    const pct = currentTime / dur;
    onSyncPageToAudio(pct);
    triggerNotice(`Jumped reader to narrator (${formatTime(currentTime)})`);
  };

  const handleSyncAudioToPage = () => {
    const audio = audioRef.current;
    const dur = audio?.duration || duration || audiobook.duration || 0;
    if (!audio || dur <= 0) return;

    const pagePct = getCurrentReaderPercentage();
    if (pagePct >= 0 && pagePct <= 1) {
      if (alignment && alignment.chapters.length > 0) {
        const res = syncEpubPercentageToAudio(pagePct, alignment);
        if (res) {
          audio.currentTime = res.targetAudioSec;
          setCurrentTime(res.targetAudioSec);
          triggerNotice(`Narrator set to "${res.activeChapter.title}" (${formatTime(res.targetAudioSec)})`);
          return;
        }
      }

      const targetSec = Math.round(pagePct * dur);
      audio.currentTime = targetSec;
      setCurrentTime(targetSec);
      triggerNotice(`Narrator set to page position (${Math.round(pagePct * 100)}%)`);
    }
  };

  return (
    <>
      {/* Hidden Native Audio Element */}
      {streamUrl && (
        <audio
          ref={audioRef}
          src={streamUrl}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            if (audioRef.current) saveProgress(audioRef.current.currentTime, audioRef.current.duration);
          }}
          onError={(e) => console.warn("Audiobook stream error:", e)}
          preload="metadata"
        />
      )}

      {/* Sync Notification Toast */}
      <AnimatePresence>
        {syncNotice && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="fixed bottom-28 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-xl bg-accent text-void font-semibold text-xs shadow-xl flex items-center gap-2 pointer-events-none"
          >
            <ArrowRightLeft size={14} />
            <span>{syncNotice}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chapter Alignment Modal */}
      <ChapterAlignmentModal
        isOpen={showAlignmentModal}
        onClose={() => setShowAlignmentModal(false)}
        alignment={alignment}
        onReScan={() => {
          onReScanAlignment?.();
        }}
        isScanning={isScanningAlignment}
        onOpenKaggleAlign={onOpenKaggleAlign}
        onJumpToChapter={(ch) => {
          if (audioRef.current) {
            audioRef.current.currentTime = ch.audioStartSec;
            setCurrentTime(ch.audioStartSec);
          }
          if (onSyncPageToAudio) {
            onSyncPageToAudio(ch.epubPercentage, ch.epubCfi);
          }
          setShowAlignmentModal(false);
          triggerNotice(`Jumped to "${ch.title}"`);
        }}
      />

      {/* Minimized Capsule Bar */}
      {isMinimized ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2.5 px-3 py-2 rounded-full bg-card/90 backdrop-blur-md border border-white/15 shadow-2xl"
        >
          <div className="w-6 h-6 rounded-full overflow-hidden bg-white/10 flex-shrink-0">
            {posterSrc ? (
              <img src={posterSrc} alt="" className="w-full h-full object-cover" />
            ) : (
              <Headphones size={12} className="text-white/60 m-auto mt-1.5" />
            )}
          </div>
          <button
            onClick={togglePlay}
            disabled={loading}
            className="p-1 rounded-full bg-accent text-void hover:bg-accent/80 transition-colors"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : playing ? <Pause size={12} /> : <Play size={12} />}
          </button>
          <span className="text-[11px] font-mono text-white/80">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <button
            onClick={() => setIsMinimized(false)}
            title="Expand immersion audio player"
            className="p-1 text-white/60 hover:text-white transition-colors"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={onClose}
            title="Close companion audiobook"
            className="p-1 text-white/40 hover:text-white transition-colors"
          >
            <X size={14} />
          </button>
        </motion.div>
      ) : (
        /* Full Companion Audio Bar */
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 30 }}
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 w-[94%] max-w-3xl rounded-2xl bg-card/95 backdrop-blur-lg border border-white/15 shadow-2xl p-3.5 flex flex-col gap-2.5 text-text"
        >
          {/* Top Bar: Audiobook Metadata & Quick Sync Actions */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-lg overflow-hidden bg-white/10 flex-shrink-0 relative">
                {posterSrc ? (
                  <img src={posterSrc} alt="" className="w-full h-full object-cover" />
                ) : (
                  <Headphones size={18} className="text-white/40 m-auto mt-2" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-accent flex items-center gap-1">
                    <Headphones size={10} />
                    Immersion Audio
                  </span>

                  {/* Alignment Status Badge */}
                  {alignment && alignment.chapters.length > 0 ? (
                    <button
                      onClick={() => setShowAlignmentModal(true)}
                      title="Click to view chapter alignment map"
                      className="flex items-center gap-1 px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold hover:bg-emerald-500/30 transition-all"
                    >
                      <Check size={10} />
                      <span>{alignment.chapters.length} Chs Aligned</span>
                    </button>
                  ) : (
                    <button
                      onClick={onReScanAlignment}
                      disabled={isScanningAlignment}
                      title="Scan and align audiobook chapters to EPUB Table of Contents"
                      className="flex items-center gap-1 px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-semibold hover:bg-amber-500/30 transition-all disabled:opacity-50"
                    >
                      <RefreshCw size={9} className={isScanningAlignment ? "animate-spin" : ""} />
                      <span>{isScanningAlignment ? "Aligning…" : "Align Chapters"}</span>
                    </button>
                  )}

                  {onOpenPairModal && (
                    <button
                      onClick={onOpenPairModal}
                      title="Change or unpair companion audiobook"
                      className="text-[10px] text-white/40 hover:text-white flex items-center gap-0.5 hover:underline"
                    >
                      <Link size={10} />
                      <span>Switch</span>
                    </button>
                  )}
                </div>

                {/* Chapter Title or Audiobook Title */}
                <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                  {activeChapter ? (
                    <p className="text-xs font-semibold text-white truncate max-w-xs sm:max-w-md">
                      <span className="text-accent mr-1">📖</span>
                      {activeChapter.title}
                    </p>
                  ) : (
                    <h4 className="text-xs font-semibold truncate text-white max-w-xs sm:max-w-md">
                      {audiobook.title}
                    </h4>
                  )}
                </div>
              </div>
            </div>

            {/* Sync Buttons & Minimize/Close */}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                onClick={handleSyncPageToAudio}
                title="Jump ebook reader to the audio narrator's current sentence/page"
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-accent/20 hover:bg-accent/30 text-accent font-semibold text-[11px] border border-accent/40 transition-all shadow-sm"
              >
                <BookOpen size={12} />
                <span className="hidden sm:inline">Sync Page</span>
              </button>

              <button
                onClick={handleSyncAudioToPage}
                title="Seek audio narrator to the page you are currently viewing"
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white font-medium text-[11px] transition-all"
              >
                <RotateCw size={11} />
                <span className="hidden sm:inline">Sync Audio</span>
              </button>

              <button
                onClick={() => setIsMinimized(true)}
                title="Minimize audio bar"
                className="p-1 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors ml-1"
              >
                <ChevronDown size={16} />
              </button>

              <button
                onClick={onClose}
                title="Close companion audio"
                className="p-1 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Progress Slider */}
          <div className="flex items-center gap-2.5 text-[11px] font-mono text-white/60">
            <span className="w-12 text-right">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={1}
              value={currentTime}
              onChange={handleSeek}
              className="flex-1 h-1.5 rounded-lg bg-white/15 accent-accent cursor-pointer transition-all hover:h-2"
            />
            <span className="w-12">{formatTime(duration)}</span>
          </div>

          {/* Bottom Control Bar */}
          <div className="flex items-center justify-between">
            {/* Speed Selector */}
            <div className="relative">
              <button
                onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-white/80 text-xs font-mono transition-colors"
              >
                <Gauge size={13} />
                <span>{speed}x</span>
              </button>

              <AnimatePresence>
                {showSpeedMenu && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute bottom-9 left-0 w-24 bg-card border border-white/15 rounded-xl shadow-2xl p-1.5 z-40 flex flex-col gap-0.5"
                  >
                    {SPEED_OPTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => handleSpeedSelect(s)}
                        className={`px-2 py-1 rounded text-left text-xs font-mono transition-colors ${
                          speed === s ? "bg-accent text-void font-bold" : "text-white/80 hover:bg-white/10"
                        }`}
                      >
                        {s}x
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Core Playback Controls (with Chapter Skip) */}
            <div className="flex items-center gap-2 sm:gap-3">
              {alignment && alignment.chapters.length > 1 && (
                <button
                  onClick={skipToPrevChapter}
                  title="Previous Chapter"
                  className="p-1.5 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-colors"
                >
                  <SkipBack size={15} />
                </button>
              )}

              <button
                onClick={() => skipSeconds(-15)}
                title="Rewind 15 seconds"
                className="p-1.5 rounded-full hover:bg-white/10 text-white/80 hover:text-white transition-colors"
              >
                <RotateCcw size={16} />
              </button>

              <button
                onClick={togglePlay}
                disabled={loading}
                className="p-2.5 rounded-full bg-accent text-void hover:bg-accent/80 transition-all shadow-md active:scale-95 disabled:opacity-50"
              >
                {loading ? <Loader2 size={18} className="animate-spin" /> : playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
              </button>

              <button
                onClick={() => skipSeconds(30)}
                title="Skip 30 seconds"
                className="p-1.5 rounded-full hover:bg-white/10 text-white/80 hover:text-white transition-colors"
              >
                <RotateCw size={16} />
              </button>

              {alignment && alignment.chapters.length > 1 && (
                <button
                  onClick={skipToNextChapter}
                  title="Next Chapter"
                  className="p-1.5 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-colors"
                >
                  <SkipForward size={15} />
                </button>
              )}
            </div>

            {/* View Alignment / Mute */}
            <div className="flex items-center gap-1.5">
              {alignment && alignment.chapters.length > 0 && (
                <button
                  onClick={() => setShowAlignmentModal(true)}
                  title="View Chapter Alignment Map"
                  className="p-1.5 rounded-lg hover:bg-white/10 text-white/60 hover:text-white transition-colors"
                >
                  <Layers size={15} />
                </button>
              )}

              <button
                onClick={toggleMute}
                className="p-1.5 rounded-lg hover:bg-white/10 text-white/60 hover:text-white transition-colors"
              >
                {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </>
  );
}
