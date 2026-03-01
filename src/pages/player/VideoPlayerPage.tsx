import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  SkipBack, SkipForward, ChevronLeft, Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, type MediaItem } from "../../store/appStore";

type PlayerState = {
  playing: boolean;
  currentTime: number;  // seconds
  duration: number;     // seconds
  volume: number;       // 0-1
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

  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seekRafRef = useRef<number | null>(null);
  // Track current time via ref so progress interval doesn't need stale closure
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);

  const { rcloneConfigPath, libraries, updateWatchProgress, watchProgress } = useAppStore();

  const [loading, setLoading] = useState(true);
  const [rcloneStatus, setRcloneStatus] = useState<{ state: string; message: string }>({
    state: "idle",
    message: "",
  });
  const [ps, setPs] = useState<PlayerState>({
    playing: false, currentTime: 0, duration: 0,
    volume: 1, muted: false, fullscreen: false,
    buffering: true, showControls: true, error: null,
  });

  // ── Start playback ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!item) return;

    const library = libraries.find((l) => l.id === item.libraryId);
    if (!library) {
      setPs((s) => ({ ...s, error: "Library not found", buffering: false }));
      setLoading(false);
      return;
    }

    const libRoot = library.remotePath.replace(/\/$/, "");
    const relPath = item.remotePath.startsWith(libRoot + "/")
      ? item.remotePath.slice(libRoot.length + 1)
      : item.remotePath.split("/").pop() ?? item.filename;

    const existing = watchProgress[item.id];
    const startMs = Math.round((resumeAt ?? existing?.position ?? 0) * 1000);

    invoke("open_media", {
      configPath: rcloneConfigPath,
      remoteRoot: library.remotePath,
      filePath: relPath,
      startMs,
    })
      .then(() => setLoading(false))
      .catch((e) => {
        setPs((s) => ({ ...s, error: String(e), buffering: false }));
        setLoading(false);
      });

    return () => {
      invoke("player_stop").catch(() => {});
    };
  }, [item?.id]);

  // ── VLC event listeners ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!item) return;
    const unlisteners: Array<() => void> = [];

    listen<{ time_ms: number; duration_ms: number }>("vlc:time", (ev) => {
      const secs = ev.payload.time_ms / 1000;
      const dur = ev.payload.duration_ms / 1000;
      currentTimeRef.current = secs;
      durationRef.current = dur;
      // Batch the seek bar update into the next animation frame so it doesn't
      // force a synchronous React re-render on the VLC event thread.
      if (seekRafRef.current !== null) cancelAnimationFrame(seekRafRef.current);
      seekRafRef.current = requestAnimationFrame(() => {
        seekRafRef.current = null;
        setPs((s) => ({ ...s, currentTime: secs, duration: dur }));
      });
    }).then((fn) => unlisteners.push(fn));

    listen<{ playing: boolean; buffering: boolean; ended: boolean }>(
      "vlc:state",
      (ev) => {
        setPs((s) => ({
          ...s,
          playing: ev.payload.playing,
          buffering: ev.payload.buffering,
        }));
        if (ev.payload.ended && item) {
          updateWatchProgress({
            itemId: item.id,
            position: durationRef.current,
            duration: durationRef.current,
            completed: true,
            lastWatchedAt: Date.now(),
          });
        }
      },
    ).then((fn) => unlisteners.push(fn));

    listen<{ message: string }>("vlc:error", (ev) => {
      setPs((s) => ({ ...s, error: ev.payload.message, buffering: false }));
    }).then((fn) => unlisteners.push(fn));

    listen<{ state: string; message: string }>("rclone:status", (ev) => {
      setRcloneStatus({ state: ev.payload.state, message: ev.payload.message });
    }).then((fn) => unlisteners.push(fn));

    return () => {
      unlisteners.forEach((fn) => fn());
      if (seekRafRef.current !== null) cancelAnimationFrame(seekRafRef.current);
    };
  }, [item?.id]);

  // ── Progress saving every 10 s ──────────────────────────────────────────────

  useEffect(() => {
    if (!item) return;
    progressTimerRef.current = setInterval(() => {
      const pos = currentTimeRef.current;
      const dur = durationRef.current;
      if (!dur) return;
      updateWatchProgress({
        itemId: item.id,
        position: pos,
        duration: dur,
        completed: dur > 0 && pos / dur > 0.9,
        lastWatchedAt: Date.now(),
      });
    }, 10000);
    return () => {
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    };
  }, [item?.id]);

  // ── Controls helpers ────────────────────────────────────────────────────────

  const showControlsTemp = useCallback(() => {
    setPs((s) => ({ ...s, showControls: true }));
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      setPs((s) => ({ ...s, showControls: s.playing ? false : true }));
    }, 3000);
  }, []);

  const togglePlay = useCallback(() => {
    setPs((s) => {
      if (s.playing) {
        invoke("player_pause").catch(() => {});
        return { ...s, playing: false };
      } else {
        invoke("player_play").catch(() => {});
        return { ...s, playing: true };
      }
    });
    showControlsTemp();
  }, [showControlsTemp]);

  const skipBy = useCallback((secs: number) => {
    setPs((s) => {
      const next = Math.max(0, Math.min(s.duration, s.currentTime + secs));
      invoke("player_seek", { ms: Math.round(next * 1000) }).catch(() => {});
      return { ...s, currentTime: next };
    });
    showControlsTemp();
  }, [showControlsTemp]);

  const handleBack = useCallback(() => {
    if (item) {
      updateWatchProgress({
        itemId: item.id,
        position: currentTimeRef.current,
        duration: durationRef.current || ps.duration,
        completed:
          durationRef.current > 0 &&
          currentTimeRef.current / durationRef.current > 0.9,
        lastWatchedAt: Date.now(),
      });
    }
    navigate(-1);
  }, [item, ps.duration]);

  const setVolume = useCallback((vol: number, muted: boolean) => {
    const effective = muted ? 0 : vol;
    invoke("player_set_volume", { vol: Math.round(effective * 100) }).catch(() => {});
    setPs((s) => ({ ...s, volume: vol, muted }));
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => {});
      setPs((s) => ({ ...s, fullscreen: true }));
    } else {
      document.exitFullscreen().catch(() => {});
      setPs((s) => ({ ...s, fullscreen: false }));
    }
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          skipBy(10);
          break;
        case "ArrowLeft":
          skipBy(-10);
          break;
        case "ArrowUp":
          setPs((s) => {
            const v = Math.min(1, s.volume + 0.1);
            invoke("player_set_volume", { vol: Math.round(v * 100) }).catch(() => {});
            return { ...s, volume: v, muted: false };
          });
          break;
        case "ArrowDown":
          setPs((s) => {
            const v = Math.max(0, s.volume - 0.1);
            invoke("player_set_volume", { vol: Math.round(v * 100) }).catch(() => {});
            return { ...s, volume: v };
          });
          break;
        case "KeyF":
          toggleFullscreen();
          break;
        case "KeyM":
          setPs((s) => {
            const muted = !s.muted;
            invoke("player_set_volume", {
              vol: muted ? 0 : Math.round(s.volume * 100),
            }).catch(() => {});
            return { ...s, muted };
          });
          break;
        case "Escape":
          if (!document.fullscreenElement) handleBack();
          break;
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [togglePlay, skipBy, toggleFullscreen, handleBack]);

  // ── Seek bar ────────────────────────────────────────────────────────────────

  const handleSeek = useCallback((seconds: number) => {
    currentTimeRef.current = seconds;
    setPs((s) => ({ ...s, currentTime: seconds }));
    invoke("player_seek", { ms: Math.round(seconds * 1000) }).catch(() => {});
  }, []);

  // ── Misc ────────────────────────────────────────────────────────────────────

  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return "0:00";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0)
      return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
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
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-4 z-10">
          <Loader2 size={40} className="text-accent animate-spin" />
          <p className="text-white/70 font-body text-sm">
            {rcloneStatus.state === "starting"
              ? "Connecting to remote…"
              : rcloneStatus.state === "ready"
              ? "Initialising player…"
              : "Starting stream…"}
          </p>
          {rcloneStatus.state === "ready" && (
            <p className="text-white/30 font-body text-xs">rclone serve ready</p>
          )}
        </div>
      )}

      {/* Error */}
      {ps.error && (
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-4 z-10 px-8">
          <p className="text-danger font-body text-center">{ps.error}</p>
          <p className="text-white/50 font-body text-sm text-center">
            Make sure rclone can access this remote and the file exists.
          </p>
          <button onClick={handleBack} className="btn-secondary mt-2">
            Go Back
          </button>
        </div>
      )}

      {/* Buffering spinner */}
      {ps.buffering && !loading && !ps.error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <Loader2 size={48} className="text-white/50 animate-spin" />
        </div>
      )}

      {/* Click overlay for play/pause */}
      {!ps.error && (
        <div className="absolute inset-0 z-20" onClick={togglePlay} />
      )}

      {/* Controls */}
      <AnimatePresence>
        {ps.showControls && !ps.error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 pointer-events-none z-30"
          >
            {/* Top bar */}
            <div className="absolute top-0 left-0 right-0 h-20 bg-gradient-to-b from-black/80 to-transparent pointer-events-auto">
              <div className="flex items-center gap-3 px-5 py-4">
                <button
                  onClick={handleBack}
                  className="text-white/80 hover:text-white transition-colors p-1"
                >
                  <ChevronLeft size={24} />
                </button>
                <div>
                  <p className="text-white font-body font-semibold text-sm">
                    {item.showTitle ?? item.title}
                  </p>
                  {item.season && item.episode && (
                    <p className="text-white/60 font-body text-xs">
                      S{String(item.season).padStart(2, "0")}E
                      {String(item.episode).padStart(2, "0")}
                      {item.episodeTitle ? ` · ${item.episodeTitle}` : ""}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom controls */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent pt-16 px-5 pb-5 pointer-events-auto">
              {/* Seek bar */}
              <div className="relative mb-3 group/seek">
                <input
                  type="range"
                  min={0}
                  max={ps.duration || 100}
                  value={ps.currentTime}
                  onChange={(e) => handleSeek(parseFloat(e.target.value))}
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
                <button
                  onClick={() => skipBy(-10)}
                  className="text-white/70 hover:text-white transition-colors"
                >
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
                <button
                  onClick={() => skipBy(10)}
                  className="text-white/70 hover:text-white transition-colors"
                >
                  <SkipForward size={19} />
                </button>
                <span className="text-white/60 font-mono text-xs ml-1">
                  {formatTime(ps.currentTime)} / {formatTime(ps.duration)}
                </span>

                <div className="flex-1" />

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setVolume(ps.volume, !ps.muted)}
                    className="text-white/70 hover:text-white transition-colors"
                  >
                    {ps.muted || ps.volume === 0
                      ? <VolumeX size={17} />
                      : <Volume2 size={17} />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={ps.muted ? 0 : ps.volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value), false)}
                    className="w-20 h-1 appearance-none bg-white/25 rounded-full cursor-pointer
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3
                      [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full
                      [&::-webkit-slider-thumb]:bg-white"
                  />
                </div>

                <button
                  onClick={toggleFullscreen}
                  className="text-white/70 hover:text-white transition-colors ml-1"
                >
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
