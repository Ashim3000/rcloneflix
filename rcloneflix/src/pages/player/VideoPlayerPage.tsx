import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  SkipBack, SkipForward, ChevronLeft, Subtitles, Settings as SettingsIcon,
  Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
};

export function VideoPlayerPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { item, resumeAt } = (location.state ?? {}) as {
    item: MediaItem;
    resumeAt?: number;
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef(`session-${Date.now()}`);

  const { rcloneConfigPath, updateWatchProgress, watchProgress, libraries } = useAppStore();

  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [ps, setPs] = useState<PlayerState>({
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    fullscreen: false,
    buffering: true,
    showControls: true,
  });

  // Start rclone serve session
  useEffect(() => {
    if (!item) return;

    const library = libraries.find((l) => l.id === item.libraryId);
    if (!library) return;

    const remoteParts = item.remotePath.split("/");
    const remoteRoot = library.remotePath;
    // File path relative to the library root
    const libraryRootParts = remoteRoot.split("/");
    const relPath = remoteParts.slice(libraryRootParts.length).join("/");

    invoke<{ session_id: string; serve_url: string; file_url: string }>(
      "start_stream_session",
      {
        configPath: rcloneConfigPath,
        remoteRoot,
        filePath: relPath,
        sessionId: sessionIdRef.current,
      }
    )
      .then((session) => {
        setStreamUrl(session.file_url);
        setSessionReady(true);
      })
      .catch((e) => setLoadError(String(e)));

    return () => {
      invoke("stop_stream_session", { sessionId: sessionIdRef.current }).catch(() => {});
    };
  }, [item?.id]);

  // Set resume position once video is ready
  useEffect(() => {
    if (!sessionReady || !videoRef.current) return;
    const existing = item ? watchProgress[item.id] : null;
    const startAt = resumeAt ?? existing?.position ?? 0;
    if (startAt > 5) {
      videoRef.current.currentTime = startAt;
    }
  }, [sessionReady]);

  // Save progress every 10 seconds
  useEffect(() => {
    if (!item) return;
    progressSaveTimerRef.current = setInterval(() => {
      const video = videoRef.current;
      if (!video || !ps.duration) return;
      updateWatchProgress({
        itemId: item.id,
        position: video.currentTime,
        duration: video.duration || ps.duration,
        completed: video.currentTime / (video.duration || 1) > 0.9,
        lastWatchedAt: Date.now(),
      });
    }, 10000);
    return () => {
      if (progressSaveTimerRef.current) clearInterval(progressSaveTimerRef.current);
    };
  }, [item?.id, ps.duration]);

  // Auto-hide controls
  const showControlsTemp = useCallback(() => {
    setPs((s) => ({ ...s, showControls: true }));
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      setPs((s) => ({ ...s, showControls: false }));
    }, 3000);
  }, []);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPs((s) => ({ ...s, playing: true })); }
    else { v.pause(); setPs((s) => ({ ...s, playing: false })); }
    showControlsTemp();
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const t = parseFloat(e.target.value);
    v.currentTime = t;
    setPs((s) => ({ ...s, currentTime: t }));
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const vol = parseFloat(e.target.value);
    v.volume = vol;
    setPs((s) => ({ ...s, volume: vol, muted: vol === 0 }));
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setPs((s) => ({ ...s, muted: v.muted }));
  };

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

  const skipBy = (secs: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + secs));
    showControlsTemp();
  };

  const handleBack = () => {
    // Save progress before leaving
    const v = videoRef.current;
    if (v && item) {
      updateWatchProgress({
        itemId: item.id,
        position: v.currentTime,
        duration: v.duration || ps.duration,
        completed: v.currentTime / (v.duration || 1) > 0.9,
        lastWatchedAt: Date.now(),
      });
    }
    navigate(-1);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.code) {
        case "Space": e.preventDefault(); togglePlay(); break;
        case "ArrowRight": skipBy(10); break;
        case "ArrowLeft": skipBy(-10); break;
        case "KeyF": toggleFullscreen(); break;
        case "KeyM": toggleMute(); break;
        case "Escape": if (!document.fullscreenElement) handleBack(); break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const formatTime = (s: number) => {
    if (isNaN(s)) return "0:00";
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
      className="fixed inset-0 bg-black flex items-center justify-center"
      onMouseMove={showControlsTemp}
      style={{ cursor: ps.showControls ? "default" : "none" }}
    >
      {/* Loading state */}
      {!sessionReady && !loadError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10">
          <Loader2 size={40} className="text-accent animate-spin" />
          <p className="text-white/70 font-body text-sm">Starting stream...</p>
        </div>
      )}

      {/* Error state */}
      {loadError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10">
          <p className="text-danger font-body">{loadError}</p>
          <button onClick={handleBack} className="btn-secondary">Go Back</button>
        </div>
      )}

      {/* Video element */}
      {streamUrl && (
        <video
          ref={videoRef}
          src={streamUrl}
          className="w-full h-full object-contain"
          onClick={togglePlay}
          onTimeUpdate={(e) => setPs((s) => ({ ...s, currentTime: e.currentTarget.currentTime }))}
          onDurationChange={(e) => setPs((s) => ({ ...s, duration: e.currentTarget.duration }))}
          onWaiting={() => setPs((s) => ({ ...s, buffering: true }))}
          onCanPlay={() => setPs((s) => ({ ...s, buffering: false }))}
          onPlay={() => setPs((s) => ({ ...s, playing: true }))}
          onPause={() => setPs((s) => ({ ...s, playing: false }))}
          onEnded={() => {
            if (item) updateWatchProgress({
              itemId: item.id,
              position: ps.duration,
              duration: ps.duration,
              completed: true,
              lastWatchedAt: Date.now(),
            });
          }}
          autoPlay
        />
      )}

      {/* Buffering spinner */}
      {ps.buffering && sessionReady && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 size={48} className="text-white/60 animate-spin" />
        </div>
      )}

      {/* Controls overlay */}
      <AnimatePresence>
        {ps.showControls && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 pointer-events-none"
          >
            {/* Top gradient + back button */}
            <div className="absolute top-0 left-0 right-0 h-24 bg-gradient-to-b from-black/80 to-transparent pointer-events-auto">
              <div className="flex items-center gap-3 px-6 py-5">
                <button onClick={handleBack} className="text-white/80 hover:text-white transition-colors">
                  <ChevronLeft size={24} />
                </button>
                <div>
                  <p className="text-white font-body font-semibold text-sm leading-tight">{item.title}</p>
                  {item.season && item.episode && (
                    <p className="text-white/60 font-body text-xs">
                      S{String(item.season).padStart(2, "0")}E{String(item.episode).padStart(2, "0")}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom gradient + controls */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent pt-12 px-6 pb-6 pointer-events-auto">
              {/* Seek bar */}
              <div className="relative mb-3 group">
                <input
                  type="range"
                  min={0}
                  max={ps.duration || 100}
                  value={ps.currentTime}
                  onChange={handleSeek}
                  className="w-full h-1 appearance-none bg-white/20 rounded-full cursor-pointer
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 
                    [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full 
                    [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:opacity-0
                    group-hover:[&::-webkit-slider-thumb]:opacity-100"
                  style={{
                    background: `linear-gradient(to right, #E8A020 ${progressPct}%, rgba(255,255,255,0.2) ${progressPct}%)`,
                  }}
                />
              </div>

              {/* Control buttons row */}
              <div className="flex items-center gap-4">
                {/* Skip back */}
                <button onClick={() => skipBy(-10)} className="text-white/80 hover:text-white transition-colors">
                  <SkipBack size={20} />
                </button>

                {/* Play/Pause */}
                <button onClick={togglePlay} className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors">
                  {ps.playing
                    ? <Pause size={20} className="text-white" />
                    : <Play size={20} className="text-white ml-0.5" fill="white" />}
                </button>

                {/* Skip forward */}
                <button onClick={() => skipBy(10)} className="text-white/80 hover:text-white transition-colors">
                  <SkipForward size={20} />
                </button>

                {/* Time */}
                <span className="text-white/70 font-mono text-xs">
                  {formatTime(ps.currentTime)} / {formatTime(ps.duration)}
                </span>

                <div className="flex-1" />

                {/* Volume */}
                <div className="flex items-center gap-2">
                  <button onClick={toggleMute} className="text-white/80 hover:text-white transition-colors">
                    {ps.muted || ps.volume === 0
                      ? <VolumeX size={18} />
                      : <Volume2 size={18} />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={ps.muted ? 0 : ps.volume}
                    onChange={handleVolume}
                    className="w-20 h-1 appearance-none bg-white/20 rounded-full cursor-pointer
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3
                      [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full
                      [&::-webkit-slider-thumb]:bg-white"
                  />
                </div>

                {/* Fullscreen */}
                <button onClick={toggleFullscreen} className="text-white/80 hover:text-white transition-colors">
                  {ps.fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
