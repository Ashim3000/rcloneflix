import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  SkipBack, SkipForward, ChevronLeft, Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type MediaItem } from "../../store/appStore";

type PlayerState = {
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  buffering: boolean;
  showControls: boolean;
  error: string | null;
};

export function VideoPlayerPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { item, resumeAt } = (location.state ?? {}) as { item: MediaItem; resumeAt?: number };

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef(`session-${Date.now()}`);

  const { rcloneConfigPath, libraries, updateWatchProgress, watchProgress } = useAppStore();

  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [ps, setPs] = useState<PlayerState>({
    playing: false, currentTime: 0, duration: 0,
    volume: 1, muted: false, fullscreen: false,
    buffering: true, showControls: true, error: null,
  });

  // Start stream session
  useEffect(() => {
    if (!item) return;

    const library = libraries.find((l) => l.id === item.libraryId);
    if (!library) {
      setPs((s) => ({ ...s, error: "Library not found", buffering: false }));
      setLoading(false);
      return;
    }

    // Build relative path from library root
    const libRoot = library.remotePath.replace(/\/$/, "");
    const relPath = item.remotePath.startsWith(libRoot + "/")
      ? item.remotePath.slice(libRoot.length + 1)
      : item.remotePath.split("/").pop() ?? item.filename;

    invoke<{ session_id: string; serve_url: string; file_url: string }>(
      "start_stream_session",
      {
        configPath: rcloneConfigPath,
        remoteRoot: library.remotePath,
        filePath: relPath,
        sessionId: sessionIdRef.current,
      }
    )
      .then((session) => {
        setStreamUrl(session.file_url);
        setLoading(false);
      })
      .catch((e) => {
        setPs((s) => ({ ...s, error: String(e), buffering: false }));
        setLoading(false);
      });

    return () => {
      invoke("stop_stream_session", { sessionId: sessionIdRef.current }).catch(() => {});
    };
  }, [item?.id]);

  // Resume position
  useEffect(() => {
    if (!streamUrl || !videoRef.current) return;
    const existing = item ? watchProgress[item.id] : null;
    const startAt = resumeAt ?? existing?.position ?? 0;
    if (startAt > 5) videoRef.current.currentTime = startAt;
  }, [streamUrl]);

  // Progress saving
  useEffect(() => {
    if (!item) return;
    progressTimerRef.current = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.duration) return;
      updateWatchProgress({
        itemId: item.id,
        position: v.currentTime,
        duration: v.duration,
        completed: v.currentTime / v.duration > 0.9,
        lastWatchedAt: Date.now(),
      });
    }, 10000);
    return () => { if (progressTimerRef.current) clearInterval(progressTimerRef.current); };
  }, [item?.id]);

  const showControlsTemp = useCallback(() => {
    setPs((s) => ({ ...s, showControls: true }));
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      setPs((s) => ({ ...s, showControls: s.playing ? false : true }));
    }, 3000);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play(); else v.pause();
    showControlsTemp();
  }, [showControlsTemp]);

  const skipBy = useCallback((secs: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + secs));
    showControlsTemp();
  }, [showControlsTemp]);

  const handleBack = useCallback(() => {
    const v = videoRef.current;
    if (v && item) {
      updateWatchProgress({
        itemId: item.id, position: v.currentTime,
        duration: v.duration || ps.duration,
        completed: ps.duration > 0 && v.currentTime / ps.duration > 0.9,
        lastWatchedAt: Date.now(),
      });
    }
    navigate(-1);
  }, [item, ps.duration]);

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen();
      setPs((s) => ({ ...s, fullscreen: true }));
    } else {
      document.exitFullscreen();
      setPs((s) => ({ ...s, fullscreen: false }));
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      switch (e.code) {
        case "Space": e.preventDefault(); togglePlay(); break;
        case "ArrowRight": skipBy(10); break;
        case "ArrowLeft": skipBy(-10); break;
        case "ArrowUp": {
          const v = videoRef.current;
          if (v) { v.volume = Math.min(1, v.volume + 0.1); setPs(s => ({...s, volume: v.volume})); }
          break;
        }
        case "ArrowDown": {
          const v = videoRef.current;
          if (v) { v.volume = Math.max(0, v.volume - 0.1); setPs(s => ({...s, volume: v.volume})); }
          break;
        }
        case "KeyF": toggleFullscreen(); break;
        case "KeyM": {
          const v = videoRef.current;
          if (v) { v.muted = !v.muted; setPs(s => ({...s, muted: v.muted})); }
          break;
        }
        case "Escape": if (!document.fullscreenElement) handleBack(); break;
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [togglePlay, skipBy, handleBack]);

  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return "0:00";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const progressPct = ps.duration ? (ps.currentTime / ps.duration) * 100 : 0;

  if (!item) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <p className="text-white font-body">No media selected.</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 bg-black flex items-center justify-center select-none"
      onMouseMove={showControlsTemp}
      style={{ cursor: ps.showControls ? "default" : "none" }}
    >
      {/* Loading */}
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10">
          <Loader2 size={40} className="text-accent animate-spin" />
          <p className="text-white/70 font-body text-sm">Starting stream...</p>
        </div>
      )}

      {/* Error */}
      {ps.error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10 px-8">
          <p className="text-danger font-body text-center">{ps.error}</p>
          <p className="text-white/50 font-body text-sm text-center">
            Make sure rclone can access this remote and the file exists.
          </p>
          <button onClick={handleBack} className="btn-secondary mt-2">Go Back</button>
        </div>
      )}

      {/* Video */}
      {streamUrl && (
        <video
          ref={videoRef}
          src={streamUrl}
          className="w-full h-full object-contain"
          onClick={togglePlay}
          onTimeUpdate={(e) => setPs((s) => ({ ...s, currentTime: e.currentTarget.currentTime }))}
          onDurationChange={(e) => setPs((s) => ({ ...s, duration: e.currentTarget.duration }))}
          onWaiting={() => setPs((s) => ({ ...s, buffering: true }))}
          onPlaying={() => setPs((s) => ({ ...s, buffering: false }))}
          onCanPlay={() => setPs((s) => ({ ...s, buffering: false }))}
          onPlay={() => setPs((s) => ({ ...s, playing: true }))}
          onPause={() => setPs((s) => ({ ...s, playing: false }))}
          onError={(e) => {
            const err = e.currentTarget.error;
            const msg = err ? `Video error: ${err.message || `code ${err.code}`}` : "Failed to load video";
            setPs((s) => ({ ...s, error: msg, buffering: false }));
          }}
          onEnded={() => {
            if (item) updateWatchProgress({
              itemId: item.id, position: ps.duration, duration: ps.duration,
              completed: true, lastWatchedAt: Date.now(),
            });
          }}
          autoPlay
          playsInline
        />
      )}

      {/* Buffering spinner */}
      {ps.buffering && !loading && !ps.error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 size={48} className="text-white/50 animate-spin" />
        </div>
      )}

      {/* Controls */}
      <AnimatePresence>
        {ps.showControls && !ps.error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 pointer-events-none"
          >
            {/* Top bar */}
            <div className="absolute top-0 left-0 right-0 h-20 bg-gradient-to-b from-black/80 to-transparent pointer-events-auto">
              <div className="flex items-center gap-3 px-5 py-4">
                <button onClick={handleBack} className="text-white/80 hover:text-white transition-colors p-1">
                  <ChevronLeft size={24} />
                </button>
                <div>
                  <p className="text-white font-body font-semibold text-sm">{item.showTitle ?? item.title}</p>
                  {item.season && item.episode && (
                    <p className="text-white/60 font-body text-xs">
                      S{String(item.season).padStart(2, "0")}E{String(item.episode).padStart(2, "0")}
                      {item.episodeTitle ? ` · ${item.episodeTitle}` : ""}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom controls */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent pt-16 px-5 pb-5 pointer-events-auto">
              {/* Seek */}
              <div className="relative mb-3 group/seek">
                <input
                  type="range" min={0} max={ps.duration || 100} value={ps.currentTime}
                  onChange={(e) => {
                    const v = videoRef.current;
                    const t = parseFloat(e.target.value);
                    if (v) v.currentTime = t;
                    setPs((s) => ({ ...s, currentTime: t }));
                  }}
                  className="w-full h-1 appearance-none rounded-full cursor-pointer
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3
                    [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full
                    [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:opacity-0
                    group-hover/seek:[&::-webkit-slider-thumb]:opacity-100"
                  style={{
                    background: `linear-gradient(to right, #E8A020 ${progressPct}%, rgba(255,255,255,0.25) ${progressPct}%)`,
                  }}
                />
              </div>

              <div className="flex items-center gap-3">
                <button onClick={() => skipBy(-10)} className="text-white/70 hover:text-white transition-colors">
                  <SkipBack size={19} />
                </button>
                <button
                  onClick={togglePlay}
                  className="w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
                >
                  {ps.playing
                    ? <Pause size={18} className="text-white" />
                    : <Play size={18} className="text-white ml-0.5" fill="white" />}
                </button>
                <button onClick={() => skipBy(10)} className="text-white/70 hover:text-white transition-colors">
                  <SkipForward size={19} />
                </button>
                <span className="text-white/60 font-mono text-xs ml-1">
                  {formatTime(ps.currentTime)} / {formatTime(ps.duration)}
                </span>

                <div className="flex-1" />

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const v = videoRef.current;
                      if (v) { v.muted = !v.muted; setPs(s => ({...s, muted: v.muted})); }
                    }}
                    className="text-white/70 hover:text-white transition-colors"
                  >
                    {ps.muted || ps.volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
                  </button>
                  <input
                    type="range" min={0} max={1} step={0.05} value={ps.muted ? 0 : ps.volume}
                    onChange={(e) => {
                      const v = videoRef.current;
                      const vol = parseFloat(e.target.value);
                      if (v) v.volume = vol;
                      setPs((s) => ({ ...s, volume: vol, muted: vol === 0 }));
                    }}
                    className="w-20 h-1 appearance-none bg-white/25 rounded-full cursor-pointer
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3
                      [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full
                      [&::-webkit-slider-thumb]:bg-white"
                  />
                </div>

                <button onClick={toggleFullscreen} className="text-white/70 hover:text-white transition-colors ml-1">
                  {ps.fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
