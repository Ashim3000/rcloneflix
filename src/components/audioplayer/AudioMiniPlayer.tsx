import { useEffect, useRef, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  ChevronDown, Music, Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type MediaItem } from "../../store/appStore";

type Props = {
  playlist: MediaItem[];
  playlistIndex: number;
  onClose: () => void;
};

export function AudioMiniPlayer({ playlist, playlistIndex: initialIndex, onClose }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { rcloneConfigPath, updateWatchProgress } = useAppStore();

  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  const currentTrack = playlist[currentIndex] ?? null;

  // Cache of pre-downloaded file:// URLs: trackId → url
  const cachedUrls = useRef<Map<string, string>>(new Map());
  const prefetchingIds = useRef<Set<string>>(new Set());

  const downloadTrack = useCallback(
    async (track: MediaItem): Promise<string> => {
      const cached = cachedUrls.current.get(track.id);
      if (cached) return cached;
      const url = await invoke<string>("download_book_to_temp", {
        configPath: rcloneConfigPath,
        remotePath: track.remotePath,
        sessionId: `audio-${track.id}`,
      });
      cachedUrls.current.set(track.id, url);
      return url;
    },
    [rcloneConfigPath]
  );

  const prefetchTrack = useCallback(
    (track: MediaItem) => {
      if (cachedUrls.current.has(track.id)) return;
      if (prefetchingIds.current.has(track.id)) return;
      prefetchingIds.current.add(track.id);
      downloadTrack(track)
        .catch(() => {})
        .finally(() => prefetchingIds.current.delete(track.id));
    },
    [downloadTrack]
  );

  // Cleanup all temp files on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      cachedUrls.current.forEach((_, trackId) => {
        invoke("cleanup_book_temp", { sessionId: `audio-${trackId}` }).catch(() => {});
      });
    };
  }, []);

  // Download (or serve from cache) when track index changes
  useEffect(() => {
    if (!currentTrack) return;

    audioRef.current?.pause();
    setCurrentTime(0);
    setDuration(0);

    const cached = cachedUrls.current.get(currentTrack.id);
    if (cached) {
      // Already pre-fetched — instant start, no spinner
      setCurrentUrl(cached);
      setDownloading(false);
    } else {
      setCurrentUrl(null);
      setDownloading(true);
      downloadTrack(currentTrack)
        .then((url) => { setCurrentUrl(url); setDownloading(false); })
        .catch(() => setDownloading(false));
    }
  }, [currentIndex]);

  // Start playback when URL is ready; wire up event listeners; kick off prefetch
  useEffect(() => {
    if (!currentUrl || !currentTrack) return;

    if (!audioRef.current) audioRef.current = new Audio();
    const audio = audioRef.current;
    audio.src = currentUrl;
    audio.volume = muted ? 0 : volume;
    audio.play().then(() => setPlaying(true)).catch(() => {});

    // Pre-download the next track while this one plays
    const next = playlist[currentIndex + 1];
    if (next) prefetchTrack(next);

    const onTime     = () => setCurrentTime(audio.currentTime);
    const onDuration = () => setDuration(audio.duration);
    const onPlay     = () => setPlaying(true);
    const onPause    = () => setPlaying(false);
    const onEnded    = () => {
      updateWatchProgress({
        itemId: currentTrack.id,
        position: audio.duration,
        duration: audio.duration,
        completed: true,
        lastWatchedAt: Date.now(),
      });
      if (currentIndex + 1 < playlist.length) {
        setCurrentIndex((i) => i + 1);
      } else {
        setPlaying(false);
      }
    };

    audio.addEventListener("timeupdate",     onTime);
    audio.addEventListener("durationchange", onDuration);
    audio.addEventListener("play",           onPlay);
    audio.addEventListener("pause",          onPause);
    audio.addEventListener("ended",          onEnded);

    return () => {
      audio.removeEventListener("timeupdate",     onTime);
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("play",           onPlay);
      audio.removeEventListener("pause",          onPause);
      audio.removeEventListener("ended",          onEnded);
    };
  }, [currentUrl]);

  // Sync volume / mute to the audio element independently of track changes
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = muted ? 0 : volume;
  }, [volume, muted]);

  // Persist progress every 10 s
  useEffect(() => {
    if (!currentTrack) return;
    const id = setInterval(() => {
      const audio = audioRef.current;
      if (!audio || !audio.duration) return;
      updateWatchProgress({
        itemId: currentTrack.id,
        position: audio.currentTime,
        duration: audio.duration,
        completed: false,
        lastWatchedAt: Date.now(),
      });
    }, 10_000);
    return () => clearInterval(id);
  }, [currentTrack?.id]);

  // ── Controls ────────────────────────────────────────────────────────────────

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play(); else a.pause();
  };

  const goNext = () => {
    if (currentIndex + 1 < playlist.length) setCurrentIndex((i) => i + 1);
  };

  // If past 3 s in the track: restart. Otherwise: go to previous track.
  const goPrev = () => {
    const a = audioRef.current;
    if (a && a.currentTime > 3) { a.currentTime = 0; return; }
    if (currentIndex > 0) setCurrentIndex((i) => i - 1);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
  };

  const fmt = (s: number) => {
    if (!s || isNaN(s)) return "0:00";
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };

  const pct = duration ? (currentTime / duration) * 100 : 0;

  if (!currentTrack) return null;

  const prevDisabled = currentIndex === 0 && currentTime <= 3;
  const nextDisabled = currentIndex >= playlist.length - 1;

  return (
    <motion.div
      initial={{ y: 80 }}
      animate={{ y: 0 }}
      exit={{ y: 80 }}
      className="fixed bottom-0 left-56 right-0 bg-surface border-t border-border z-40 px-6 py-3"
    >
      {/* Seekable progress bar */}
      <div
        className="absolute top-0 left-0 right-0 h-1 bg-muted cursor-pointer group"
        onClick={handleSeek}
      >
        <div
          className="h-full bg-accent group-hover:bg-accent-glow transition-colors"
          style={{ width: `${pct}%`, transition: "width 1s linear" }}
        />
      </div>

      <div className="flex items-center gap-4">
        {/* Artwork */}
        <div className="w-10 h-10 rounded-lg overflow-hidden bg-panel border border-border flex-shrink-0">
          {currentTrack.posterUrl ? (
            <img src={currentTrack.posterUrl} alt={currentTrack.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Music size={18} className="text-subtle" />
            </div>
          )}
        </div>

        {/* Track info */}
        <div className="flex-1 min-w-0">
          <p className="text-text font-body text-sm font-medium truncate">{currentTrack.title}</p>
          <p className="text-subtle font-body text-xs truncate">
            {currentTrack.artist ?? currentTrack.author ?? ""}
            {playlist.length > 1 && (
              <span className="ml-2 opacity-50">{currentIndex + 1} / {playlist.length}</span>
            )}
          </p>
        </div>

        {/* Controls: Prev | Play/Pause | Next */}
        <div className="flex items-center gap-3">
          <button
            onClick={goPrev}
            disabled={prevDisabled}
            className="text-subtle hover:text-text transition-colors disabled:opacity-30"
          >
            <SkipBack size={16} />
          </button>

          <button
            onClick={togglePlay}
            disabled={downloading}
            className="w-8 h-8 rounded-full bg-accent hover:bg-accent-glow flex items-center justify-center transition-colors disabled:opacity-50"
          >
            {downloading
              ? <Loader2 size={14} className="text-void animate-spin" />
              : playing
              ? <Pause size={14} className="text-void" />
              : <Play size={14} className="text-void ml-0.5" fill="currentColor" />
            }
          </button>

          <button
            onClick={goNext}
            disabled={nextDisabled}
            className="text-subtle hover:text-text transition-colors disabled:opacity-30"
          >
            <SkipForward size={16} />
          </button>
        </div>

        {/* Time */}
        <span className="text-subtle font-mono text-xs w-24 text-center">
          {fmt(currentTime)} / {fmt(duration)}
        </span>

        {/* Volume */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMuted((m) => !m)}
            className="text-subtle hover:text-text transition-colors"
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <input
            type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
            onChange={(e) => { setVolume(parseFloat(e.target.value)); setMuted(false); }}
            className="w-20 h-1 appearance-none bg-muted rounded-full cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3
              [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full
              [&::-webkit-slider-thumb]:bg-accent"
          />
        </div>

        {/* Close */}
        <button onClick={onClose} className="text-subtle hover:text-text transition-colors ml-2">
          <ChevronDown size={18} />
        </button>
      </div>
    </motion.div>
  );
}
