import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  ChevronDown, Music,
} from "lucide-react";
import { useAppStore, type MediaItem } from "../../store/appStore";

// Global audio player state — singleton outside React so it persists across navigation
let globalAudio: HTMLAudioElement | null = null;
let currentItemId: string | null = null;

export function useAudioPlayer() {
  return {
    play: (url: string, item: MediaItem, startAt = 0) => {
      if (!globalAudio) globalAudio = new Audio();
      if (currentItemId !== item.id) {
        globalAudio.src = url;
        globalAudio.currentTime = startAt;
        currentItemId = item.id;
      }
      globalAudio.play();
    },
    pause: () => globalAudio?.pause(),
    getAudio: () => globalAudio,
    getCurrentItemId: () => currentItemId,
  };
}

type Props = {
  item: MediaItem | null;
  streamUrl: string | null;
  onClose: () => void;
  // onExpand: () => void; -- reserved for future use
};

export function AudioMiniPlayer({ item, streamUrl, onClose }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { updateWatchProgress } = useAppStore();

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (!streamUrl) return;

    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    const audio = audioRef.current;
    audio.src = streamUrl;
    audio.volume = volume;

    audio.play().then(() => setPlaying(true)).catch(() => {});

    const onTime = () => setCurrentTime(audio.currentTime);
    const onDuration = () => setDuration(audio.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      if (item) {
        updateWatchProgress({
          itemId: item.id,
          position: audio.duration,
          duration: audio.duration,
          completed: true,
          lastWatchedAt: Date.now(),
        });
      }
      setPlaying(false);
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("durationchange", onDuration);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [streamUrl]);

  // Save progress every 10s
  useEffect(() => {
    if (!item) return;
    const interval = setInterval(() => {
      const audio = audioRef.current;
      if (!audio || !audio.duration) return;
      updateWatchProgress({
        itemId: item.id,
        position: audio.currentTime,
        duration: audio.duration,
        completed: false,
        lastWatchedAt: Date.now(),
      });
    }, 10000);
    return () => clearInterval(interval);
  }, [item?.id]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play(); else audio.pause();
  };

  const skipBy = (s: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + s));
  };

  const formatTime = (s: number) => {
    if (isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const pct = duration ? (currentTime / duration) * 100 : 0;

  if (!item || !streamUrl) return null;

  return (
    <motion.div
      initial={{ y: 80 }}
      animate={{ y: 0 }}
      exit={{ y: 80 }}
      className="fixed bottom-0 left-56 right-0 bg-surface border-t border-border z-40 px-6 py-3"
    >
      {/* Progress bar across full width */}
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-muted">
        <div
          className="h-full bg-accent transition-all duration-1000"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center gap-4">
        {/* Artwork */}
        <div className="w-10 h-10 rounded-lg overflow-hidden bg-panel border border-border flex-shrink-0">
          {item.posterUrl ? (
            <img src={item.posterUrl} alt={item.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Music size={18} className="text-subtle" />
            </div>
          )}
        </div>

        {/* Title */}
        <div className="flex-1 min-w-0">
          <p className="text-text font-body text-sm font-medium truncate">{item.title}</p>
          <p className="text-subtle font-body text-xs truncate">
            {item.artist ?? item.author ?? ""}
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          <button onClick={() => skipBy(-15)} className="text-subtle hover:text-text transition-colors">
            <SkipBack size={16} />
          </button>
          <button
            onClick={togglePlay}
            className="w-8 h-8 rounded-full bg-accent hover:bg-accent-glow flex items-center justify-center transition-colors"
          >
            {playing
              ? <Pause size={14} className="text-void" />
              : <Play size={14} className="text-void ml-0.5" fill="currentColor" />}
          </button>
          <button onClick={() => skipBy(15)} className="text-subtle hover:text-text transition-colors">
            <SkipForward size={16} />
          </button>
        </div>

        {/* Time */}
        <span className="text-subtle font-mono text-xs w-24 text-center">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        {/* Volume */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const audio = audioRef.current;
              if (!audio) return;
              audio.muted = !audio.muted;
              setMuted(audio.muted);
            }}
            className="text-subtle hover:text-text transition-colors"
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <input
            type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setVolume(v);
              if (audioRef.current) audioRef.current.volume = v;
            }}
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
