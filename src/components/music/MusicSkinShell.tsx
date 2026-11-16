import { useState, useEffect, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Play, Pause, SkipBack, SkipForward, Disc, Loader2,
  Shuffle, Repeat, Repeat1, ListMusic, Mic2, Pin, PinOff,
  AppWindow, Search, Volume2, VolumeX, RotateCcw, RotateCw,
  Gauge, Moon, ArrowUp, ArrowDown, Trash2, ChevronLeft, Plus, SlidersHorizontal, X as EqCloseIcon,
  Square, BookOpen, Disc3
} from "lucide-react";
import { fetchAlbumLinerNotes, type AlbumLinerNotes } from "../../lib/musicCredits";
import { playNeedleDropEffect } from "../../lib/audioEffects";
import {
  useAppStore,
  selectMusicArtists,
  type MediaItem,
  type MusicArtist,
  type MusicAlbum,
} from "../../store/appStore";
import { useArtwork } from "../../lib/artwork";
import { fetchTrackLyrics, type LyricsResult } from "../../lib/lrclib";
import { FavoriteButton } from "../common/FavoriteButton";
import { AddToPlaylistButton } from "../playlist/AddToPlaylistButton";
import { SpectrumCanvas } from "./SpectrumCanvas";

const isAndroid = typeof window !== "undefined" && Boolean((window as any).AndroidBridge);

const SKIN_EQ_FREQS = ["32", "64", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"] as const;
const SKIN_EQ_PRESETS: Record<string, { label: string; gains: number[] }> = {
  flat: { label: "Flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass_boost: { label: "Bass Boost", gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  vocal: { label: "Vocal / Podcast", gains: [-2, -2, -1, 1, 4, 5, 4, 2, 0, -1] },
  rock: { label: "Rock", gains: [4, 3, 1, -1, -2, 0, 2, 4, 5, 5] },
  electronic: { label: "Electronic", gains: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5] },
  acoustic: { label: "Acoustic", gains: [3, 3, 2, 0, 1, 1, 3, 4, 3, 2] },
  podcast: { label: "Speech Clarity", gains: [-4, -3, -1, 2, 4, 5, 4, 2, 0, -2] },
};

export function MusicSkinShell() {
  const {
    audioState,
    setMusicSkinMode,
    musicSkinTab,
    setMusicSkinTab,
    isSkinPinnedOnTop,
    setSkinPinnedOnTop,
    toggleAudioShuffle,
    cycleAudioRepeat,
    reorderAudioQueue,
    removeFromAudioQueue,
    enqueueAudioNext,
    enqueueAudioEnd,
    mediaItems,
    libraries,
    setAudioState,
  } = useAppStore();

  const playlist = audioState?.playlist ?? [];
  const currentIndex = audioState?.playlistIndex ?? 0;
  const currentTrack = playlist[currentIndex] ?? null;
  const isShuffle = Boolean(audioState?.shuffle);
  const repeatMode = audioState?.repeatMode ?? "off";

  const posterSrc = useArtwork(currentTrack?.posterUrl);

  // Initialize playback state from AudioMiniPlayer's live snapshot if available
  const initialSnap = (typeof window !== "undefined" && (window as any).__rcloneflix_audio_state) || {};
  const [playing, setPlaying] = useState<boolean>(Boolean(initialSnap.playing));
  const [loading, setLoading] = useState<boolean>(Boolean(initialSnap.loading));
  const [currentTime, setCurrentTime] = useState<number>(Number(initialSnap.currentTime) || 0);
  const [duration, setDuration] = useState<number>(Number(initialSnap.duration) || currentTrack?.duration || 0);
  const [volume, setVolume] = useState<number>(typeof initialSnap.volume === "number" ? initialSnap.volume : 1);
  const [muted, setMuted] = useState<boolean>(Boolean(initialSnap.muted));
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(Number(initialSnap.playbackSpeed) || 1.0);
  const [sleepTimerMode, setSleepTimerMode] = useState<string | number>(initialSnap.sleepTimerMode ?? "off");
  const [sleepTimerRemainingSec, setSleepTimerRemainingSec] = useState<number | null>(
    typeof initialSnap.sleepTimerRemainingSec === "number" ? initialSnap.sleepTimerRemainingSec : null
  );
  const [activeSourceLabel, setActiveSourceLabel] = useState<string>(initialSnap.sourceLabel || "Cloud Stream");

  // Synced Lyrics state
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [loadingLyrics, setLoadingLyrics] = useState(false);
  const lyricsContainerRef = useRef<HTMLDivElement>(null);

  // Liner Notes (MusicBrainz credits) for the current track's album
  const [linerNotes, setLinerNotes] = useState<AlbumLinerNotes | null>(null);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [notesError, setNotesError] = useState("");

  // Vinyl Mode: needle-drop on track start (AudioMiniPlayer reads the same key)
  const [vinylMode, setVinylMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem("rcloneflix_vinyl_mode") === "1";
    } catch {
      return false;
    }
  });
  const toggleVinylMode = () => {
    const next = !vinylMode;
    setVinylMode(next);
    try {
      localStorage.setItem("rcloneflix_vinyl_mode", next ? "1" : "0");
    } catch {
      // per-viewer convenience only; losing it is harmless
    }
    if (next) playNeedleDropEffect(0.3);
  };

  // In-Skin Music Library Browser drill-down state
  const [librarySearch, setLibrarySearch] = useState("");
  const [selectedArtist, setSelectedArtist] = useState<MusicArtist | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<MusicAlbum | null>(null);

  // 10-band EQ panel (state mirrors AudioMiniPlayer via window.__rcloneflix_eq + "rcloneflix:set-eq")
  const eqSnap = (typeof window !== "undefined" && (window as any).__rcloneflix_eq) || null;
  const [showEq, setShowEq] = useState(false);
  const [eqGains, setEqGains] = useState<number[]>(
    Array.isArray(eqSnap?.gains) && eqSnap.gains.length === 10 ? eqSnap.gains : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
  const [eqPreset, setEqPreset] = useState<string>(eqSnap?.preset || "flat");
  const applyEq = (gains: number[], preset: string) => {
    setEqGains(gains);
    setEqPreset(preset);
    window.dispatchEvent(new CustomEvent("rcloneflix:set-eq", { detail: { gains, preset } }));
  };

  // Subscribe to both live audio state sync events and Whispersync ticks
  useEffect(() => {
    const syncFromDetail = (d: any) => {
      if (!d) return;
      if (typeof d.currentTime === "number") setCurrentTime(d.currentTime);
      if (typeof d.duration === "number" && d.duration > 0) setDuration(d.duration);
      if (typeof d.playing === "boolean") setPlaying(d.playing);
      if (typeof d.loading === "boolean") setLoading(d.loading);
      if (typeof d.volume === "number") setVolume(d.volume);
      if (typeof d.muted === "boolean") setMuted(d.muted);
      if (typeof d.playbackSpeed === "number") setPlaybackSpeed(d.playbackSpeed);
      if (d.sleepTimerMode !== undefined) setSleepTimerMode(d.sleepTimerMode);
      if (d.sleepTimerRemainingSec !== undefined) setSleepTimerRemainingSec(d.sleepTimerRemainingSec);
      if (typeof d.sourceLabel === "string") setActiveSourceLabel(d.sourceLabel);
    };

    // Pull immediate snapshot on mount
    if ((window as any).__rcloneflix_audio_state) {
      syncFromDetail((window as any).__rcloneflix_audio_state);
    }

    const onSync = (e: Event) => syncFromDetail((e as CustomEvent).detail);
    window.addEventListener("rcloneflix:audio-state-sync", onSync);
    window.addEventListener("rcloneflix:whispersync-audio-tick", onSync);
    return () => {
      window.removeEventListener("rcloneflix:audio-state-sync", onSync);
      window.removeEventListener("rcloneflix:whispersync-audio-tick", onSync);
    };
  }, []);

  // Fetch Synced Lyrics on track change
  useEffect(() => {
    if (!currentTrack) {
      setLyrics(null);
      return;
    }
    let cancelled = false;
    setLoadingLyrics(true);
    fetchTrackLyrics({
      title: currentTrack.title,
      artist: currentTrack.artist || currentTrack.author,
      album: currentTrack.album,
      duration: currentTrack.duration || duration,
    })
      .then((res) => {
        if (!cancelled) setLyrics(res);
      })
      .finally(() => {
        if (!cancelled) setLoadingLyrics(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentTrack?.id, currentTrack?.title, currentTrack?.artist, currentTrack?.album]);

  // Fetch MusicBrainz liner notes when the Notes tab is open for the current album.
  // fetchAlbumLinerNotes caches per artist+album, so tab switches are free after the first load.
  useEffect(() => {
    if (musicSkinTab !== "notes") return;
    const artist = currentTrack?.artist?.trim();
    const album = currentTrack?.album?.trim();
    if (!artist && !album) {
      setLinerNotes(null);
      setNotesError("No artist/album metadata on the current track.");
      return;
    }
    let cancelled = false;
    setLoadingNotes(true);
    setNotesError("");
    (async () => {
      try {
        const res = await fetchAlbumLinerNotes(artist || "", album || "");
        if (!cancelled) setLinerNotes(res);
      } catch (e: any) {
        if (!cancelled) {
          setLinerNotes(null);
          setNotesError(e?.message || "Could not load album credits.");
        }
      } finally {
        if (!cancelled) setLoadingNotes(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [musicSkinTab, currentTrack?.artist, currentTrack?.album]);

  // Active lyric calculation
  const activeLyricIndex = useMemo(() => {
    if (!lyrics?.synced?.length) return -1;
    let idx = -1;
    for (let i = 0; i < lyrics.synced.length; i++) {
      if (currentTime + 0.25 >= lyrics.synced[i].time) {
        idx = i;
      } else {
        break;
      }
    }
    return idx;
  }, [lyrics, currentTime]);

  // Auto-scroll lyrics to active line
  useEffect(() => {
    if (activeLyricIndex >= 0 && lyricsContainerRef.current) {
      const activeEl = lyricsContainerRef.current.querySelector(`[data-lyric-idx="${activeLyricIndex}"]`);
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [activeLyricIndex, musicSkinTab]);

  // Transport dispatchers to AudioMiniPlayer engine
  const dispatchControl = (action: string, val?: any) => {
    (window as any).__rcloneflix_media_control?.(action, val);
  };

  const handleSeek = (secs: number) => {
    dispatchControl("seek", secs);
    setCurrentTime(secs);
  };

  const handleSkipTime = (delta: number) => {
    const target = Math.max(0, Math.min(duration || 0, currentTime + delta));
    handleSeek(target);
  };

  const handleCycleSpeed = () => {
    const speeds = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    const idx = speeds.findIndex((s) => Math.abs(s - playbackSpeed) < 0.05);
    const next = speeds[(idx + 1) % speeds.length];
    setPlaybackSpeed(next);
    dispatchControl("speed", next);
  };

  const handleCycleSleepTimer = () => {
    const modes: Array<"off" | 15 | 30 | 60 | "end_of_track"> = ["off", 15, 30, 60, "end_of_track"];
    const idx = modes.indexOf(sleepTimerMode as any);
    const next = modes[(idx + 1) % modes.length];
    setSleepTimerMode(next);
    dispatchControl("sleep", next);
  };

  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return "0:00";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  // In-Skin Music Library grouping (Music + Audiobooks)
  const musicArtists = useMemo(() => {
    const audioLibIds = new Set(
      libraries.filter((l) => l.type === "music" || l.type === "audiobooks").map((l) => l.id)
    );
    const items = Object.fromEntries(
      Object.entries(mediaItems).filter(
        ([_, i]) => audioLibIds.has(i.libraryId) || i.libraryType === "music" || i.libraryType === "audiobooks"
      )
    );
    return selectMusicArtists(items);
  }, [mediaItems, libraries]);

  const filteredArtists = useMemo(() => {
    if (!librarySearch.trim()) return musicArtists;
    const q = librarySearch.toLowerCase();
    return musicArtists.filter((a) => {
      if (a.name.toLowerCase().includes(q)) return true;
      return Object.values(a.albums).some(
        (alb) =>
          alb.name.toLowerCase().includes(q) ||
          alb.tracks.some((t) => t.title.toLowerCase().includes(q))
      );
    });
  }, [musicArtists, librarySearch]);

  const matchingTracks = useMemo(() => {
    if (!librarySearch.trim()) return [];
    const q = librarySearch.toLowerCase();
    const results: MediaItem[] = [];
    for (const artist of musicArtists) {
      for (const alb of Object.values(artist.albums)) {
        for (const t of alb.tracks) {
          if (
            t.title.toLowerCase().includes(q) ||
            (t.artist && t.artist.toLowerCase().includes(q)) ||
            (t.album && t.album.toLowerCase().includes(q))
          ) {
            results.push(t);
            if (results.length >= 25) return results;
          }
        }
      }
    }
    return results;
  }, [musicArtists, librarySearch]);

  const playTracks = (tracks: MediaItem[], startIndex = 0) => {
    if (tracks.length === 0) return;
    setAudioState({
      playlist: tracks,
      playlistIndex: startIndex,
      playToken: Date.now(),
      expanded: false,
    });
    setMusicSkinTab("playing");
  };

  const nextTrackInQueue = playlist[currentIndex + 1] ?? null;

  return (
    <div className="w-full h-screen bg-void select-none flex flex-col overflow-hidden text-white relative font-body">
      {showEq && (
        <div className="absolute inset-0 z-40 bg-void flex flex-col p-4 gap-3 overflow-y-auto">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-heading font-bold text-white flex items-center gap-2">
              <SlidersHorizontal size={14} className="text-accent" /> Equalizer
            </h3>
            <button
              type="button"
              onClick={() => setShowEq(false)}
              className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white cursor-pointer"
              title="Close equalizer"
            >
              <EqCloseIcon size={14} />
            </button>
          </div>
          <select
            value={SKIN_EQ_PRESETS[eqPreset] ? eqPreset : "custom"}
            onChange={(e) => {
              const p = SKIN_EQ_PRESETS[e.target.value];
              if (p) applyEq([...p.gains], e.target.value);
            }}
            className="w-full bg-panel border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white"
          >
            {Object.entries(SKIN_EQ_PRESETS).map(([key, p]) => (
              <option key={key} value={key}>{p.label}</option>
            ))}
            {!SKIN_EQ_PRESETS[eqPreset] && <option value="custom">Custom</option>}
          </select>
          <div className="flex flex-col gap-1.5">
            {SKIN_EQ_FREQS.map((label, idx) => {
              const gain = eqGains[idx] ?? 0;
              return (
                <div key={label} className="flex items-center gap-2 text-[10px] font-mono">
                  <span className="w-7 text-right text-white/60">{label}</span>
                  <input
                    type="range"
                    min={-12}
                    max={12}
                    step={1}
                    value={gain}
                    onChange={(e) => {
                      const next = [...eqGains];
                      next[idx] = parseFloat(e.target.value);
                      applyEq(next, "custom");
                    }}
                    className="flex-1 h-1 appearance-none rounded-full cursor-pointer bg-white/20 accent-accent"
                  />
                  <span className={`w-7 text-right ${gain > 0 ? "text-accent font-semibold" : gain < 0 ? "text-rose-400" : "text-white/50"}`}>
                    {gain > 0 ? `+${gain}` : `${gain}`}
                  </span>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => applyEq([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "flat")}
            className="mt-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs text-white cursor-pointer self-start"
          >
            Reset to Flat
          </button>
        </div>
      )}
      {/* Ambient Blurred Artwork Backdrop */}
      {posterSrc && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-35 z-0">
          <img
            src={posterSrc}
            alt=""
            className="w-full h-full object-cover scale-150 blur-3xl saturate-150"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-void/50 via-void/85 to-void" />
        </div>
      )}

      {/* Top Header & Drag Region (Winamp / Plexamp Compact Bar) */}
      <header
        data-tauri-drag-region
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest("button, a, input, select, nav, [data-no-drag]")) {
            return;
          }
          if (!isAndroid) {
            getCurrentWindow().startDragging().catch(() => {});
          }
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, a, input, select, nav, [data-no-drag]")) {
            return;
          }
          setMusicSkinMode(false);
        }}
        className="relative z-20 flex-shrink-0 h-12 bg-black/50 backdrop-blur-md border-b border-white/10 px-3 flex items-center justify-between cursor-move"
      >
        <div className="flex items-center gap-1.5">
          {/* Return to Full RcloneFlix Application */}
          <button
            type="button"
            onClick={() => setMusicSkinMode(false)}
            title="Exit Music Skin and return to Full RcloneFlix App"
            className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/90 hover:text-white transition-colors flex items-center gap-1.5 text-[11px] font-semibold cursor-pointer"
          >
            <AppWindow size={13} className="text-accent" />
            <span>Full App</span>
          </button>

          {/* Stop & Dismiss Active Album */}
          <button
            type="button"
            onClick={() => {
              dispatchControl("stop");
              setAudioState(null);
            }}
            title="Stop & Dismiss Album"
            className="p-1.5 rounded-lg bg-white/5 hover:bg-rose-500/20 text-white/60 hover:text-rose-400 transition-colors flex items-center justify-center cursor-pointer"
          >
            <Square size={13} />
          </button>

          {!isAndroid && (
            <button
              type="button"
              onClick={() => setSkinPinnedOnTop(!isSkinPinnedOnTop)}
              title={isSkinPinnedOnTop ? "Unpin Always-on-Top" : "Pin Always-on-Top (Winamp Mini Mode)"}
              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                isSkinPinnedOnTop
                  ? "bg-accent/20 text-accent border border-accent/40"
                  : "bg-white/5 hover:bg-white/15 text-white/60 hover:text-white"
              }`}
            >
              {isSkinPinnedOnTop ? <Pin size={14} /> : <PinOff size={14} />}
            </button>
          )}
        </div>

        {/* View Switcher Pills (Now Playing | Synced Lyrics | Queue | Music Library) */}
        <nav className="flex items-center gap-1 bg-black/60 p-1 rounded-xl border border-white/10">
          <button
            type="button"
            onClick={() => setMusicSkinTab("playing")}
            title="Now Playing"
            className={`px-2 py-1 rounded-lg text-[11px] transition-colors flex items-center gap-1 cursor-pointer ${
              musicSkinTab === "playing"
                ? "bg-accent text-black font-bold"
                : "text-white/60 hover:text-white"
            }`}
          >
            <Disc size={13} />
            <span className="inline text-[10px]">Play</span>
          </button>
          <button
            type="button"
            onClick={() => setMusicSkinTab("lyrics")}
            title="Synced Lyrics"
            className={`px-2 py-1 rounded-lg text-[11px] transition-colors flex items-center gap-1 cursor-pointer ${
              musicSkinTab === "lyrics"
                ? "bg-accent text-black font-bold"
                : "text-white/60 hover:text-white"
            }`}
          >
            <Mic2 size={13} />
            <span className="inline text-[10px]">Lyrics</span>
          </button>
          <button
            type="button"
            onClick={() => setMusicSkinTab("queue")}
            title={`Up Next Queue (${playlist.length})`}
            className={`px-2 py-1 rounded-lg text-[11px] transition-colors flex items-center gap-1 cursor-pointer ${
              musicSkinTab === "queue"
                ? "bg-accent text-black font-bold"
                : "text-white/60 hover:text-white"
            }`}
          >
            <ListMusic size={13} />
            <span className="inline text-[10px]">{playlist.length}</span>
          </button>
          <button
            type="button"
            onClick={() => setMusicSkinTab("library")}
            title="Browse Music Library"
            className={`px-2 py-1 rounded-lg text-[11px] transition-colors flex items-center gap-1 cursor-pointer ${
              musicSkinTab === "library"
                ? "bg-accent text-black font-bold"
                : "text-white/60 hover:text-white"
            }`}
          >
            <Search size={13} />
            <span className="inline text-[10px]">Library</span>
          </button>
          <button
            type="button"
            onClick={() => setMusicSkinTab("notes")}
            title="Album Liner Notes & Credits (MusicBrainz)"
            className={`px-2 py-1 rounded-lg text-[11px] transition-colors flex items-center gap-1 cursor-pointer ${
              musicSkinTab === "notes"
                ? "bg-accent text-black font-bold"
                : "text-white/60 hover:text-white"
            }`}
          >
            <BookOpen size={13} />
            <span className="inline text-[10px]">Notes</span>
          </button>
        </nav>
      </header>

      {/* Main Content Area */}
      <main className="relative z-10 flex-1 overflow-hidden flex flex-col p-3.5">
        {/* TAB 1: NOW PLAYING */}
        {musicSkinTab === "playing" && (
          <div className="flex-1 flex flex-col items-center justify-between overflow-y-auto max-w-sm mx-auto w-full gap-3 py-1">
            {currentTrack ? (
              <>
                {/* Square Album Artwork */}
                <div className="w-48 h-48 sm:w-56 sm:h-56 max-h-[34vh] aspect-square rounded-2xl bg-white/5 border border-white/15 shadow-2xl overflow-hidden flex items-center justify-center flex-shrink-0 relative">
                  {posterSrc ? (
                    <img
                      src={posterSrc}
                      alt={currentTrack.title}
                      className={`w-full h-full object-cover transition-all duration-700 ${
                        playing ? "rounded-full scale-95 shadow-inner animate-spin-slow ring-4 ring-black/60" : "rounded-2xl"
                      }`}
                    />
                  ) : (
                    <Disc size={68} className={`text-accent ${playing ? "animate-spin-slow" : ""}`} />
                  )}
                  <div className="absolute top-2 left-2 flex items-center gap-1 z-10">
                    <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-black/70 backdrop-blur-md text-accent border border-accent/30">
                      {activeSourceLabel}
                    </span>
                    {currentTrack.container && (
                      <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 rounded bg-black/70 backdrop-blur-md text-white/80 border border-white/15">
                        {currentTrack.container}
                      </span>
                    )}
                  </div>
                </div>

                {/* Track Info & Quick Actions */}
                <div className="w-full flex items-start justify-between gap-2 px-1">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-heading font-bold text-white truncate leading-snug">
                      {currentTrack.title}
                    </h2>
                    <button
                      type="button"
                      onClick={() => {
                        const artistName = currentTrack.artist || currentTrack.author;
                        if (artistName) {
                          const found = musicArtists.find(
                            (a) => a.name.toLowerCase() === artistName.toLowerCase()
                          );
                          if (found) {
                            setSelectedArtist(found);
                            setSelectedAlbum(null);
                            setMusicSkinTab("library");
                          }
                        }
                      }}
                      className="text-xs text-accent hover:underline font-medium mt-0.5 truncate text-left block cursor-pointer"
                    >
                      {currentTrack.artist || currentTrack.author || "Unknown Artist"}
                    </button>
                    {currentTrack.album && (
                      <button
                        type="button"
                        onClick={() => {
                          const artistName = currentTrack.artist || currentTrack.author;
                          if (artistName && currentTrack.album) {
                            const foundArtist = musicArtists.find(
                              (a) => a.name.toLowerCase() === artistName.toLowerCase()
                            );
                            if (foundArtist) {
                              const foundAlbum = Object.values(foundArtist.albums).find(
                                (alb) => alb.name.toLowerCase() === currentTrack.album!.toLowerCase()
                              );
                              if (foundAlbum) {
                                setSelectedArtist(foundArtist);
                                setSelectedAlbum(foundAlbum);
                                setMusicSkinTab("library");
                              }
                            }
                          }
                        }}
                        className="text-[11px] text-white/50 hover:text-white/80 hover:underline mt-0.5 truncate text-left block cursor-pointer"
                      >
                        {currentTrack.album} {currentTrack.year ? `• ${currentTrack.year}` : ""}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 pt-0.5">
                    <FavoriteButton itemId={currentTrack.id} size="sm" />
                    <AddToPlaylistButton items={currentTrack} size="sm" />
                  </div>
                </div>

                {/* Real-time Spectrum Visualizer */}
                <div className="w-full px-1">
                  <SpectrumCanvas className="w-full h-8 opacity-75" isPlaying={playing} />
                </div>

                {/* Scrubber Progress Bar */}
                <div className="w-full flex flex-col gap-1 px-1">
                  <input
                    type="range"
                    min={0}
                    max={duration || 100}
                    step={0.5}
                    value={currentTime}
                    onChange={(e) => handleSeek(parseFloat(e.target.value))}
                    className="w-full h-1.5 appearance-none rounded-full cursor-pointer bg-white/20"
                    style={{
                      background: `linear-gradient(to right, #E8A020 ${progressPct}%, rgba(255,255,255,0.2) ${progressPct}%)`,
                    }}
                  />
                  <div className="flex items-center justify-between text-[10px] font-mono text-white/55">
                    <span>{formatTime(currentTime)}</span>
                    <span>-{formatTime(Math.max(0, duration - currentTime))}</span>
                  </div>
                </div>

                {/* Primary Transport Controls */}
                <div className="w-full flex items-center justify-between px-1">
                  <button
                    type="button"
                    onClick={toggleAudioShuffle}
                    title={isShuffle ? "Shuffle On" : "Shuffle Off"}
                    className={`p-2 rounded-full transition-colors cursor-pointer ${
                      isShuffle ? "bg-accent/20 text-accent" : "text-white/45 hover:text-white"
                    }`}
                  >
                    <Shuffle size={15} />
                  </button>

                  <button
                    type="button"
                    onClick={() => handleSkipTime(-15)}
                    title="Rewind 15s"
                    className="p-1.5 rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <RotateCcw size={16} />
                  </button>

                  <button
                    type="button"
                    onClick={() => dispatchControl("prev")}
                    title="Previous Track"
                    className="p-2 rounded-full text-white/90 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <SkipBack size={21} />
                  </button>

                  <button
                    type="button"
                    onClick={() => dispatchControl(playing ? "pause" : "play")}
                    disabled={loading}
                    className="w-14 h-14 rounded-full bg-accent text-black flex items-center justify-center shadow-xl hover:scale-105 active:scale-95 transition-transform cursor-pointer"
                  >
                    {loading ? (
                      <Loader2 size={24} className="animate-spin text-black" />
                    ) : playing ? (
                      <Pause size={24} className="fill-black" />
                    ) : (
                      <Play size={24} className="fill-black ml-0.5" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => dispatchControl("next")}
                    title="Next Track"
                    className="p-2 rounded-full text-white/90 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <SkipForward size={21} />
                  </button>

                  <button
                    type="button"
                    onClick={() => handleSkipTime(30)}
                    title="Fast-Forward 30s"
                    className="p-1.5 rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <RotateCw size={16} />
                  </button>

                  <button
                    type="button"
                    onClick={cycleAudioRepeat}
                    title={`Repeat: ${repeatMode}`}
                    className={`p-2 rounded-full transition-colors cursor-pointer ${
                      repeatMode !== "off" ? "bg-accent/20 text-accent" : "text-white/45 hover:text-white"
                    }`}
                  >
                    {repeatMode === "one" ? <Repeat1 size={15} /> : <Repeat size={15} />}
                  </button>
                </div>

                {/* Secondary Utility Row: Volume, Speed, Sleep Timer */}
                <div className="w-full flex items-center justify-between gap-2 pt-2 border-t border-white/10 px-1">
                  <div className="flex items-center gap-1.5 flex-1 max-w-[140px]">
                    <button
                      type="button"
                      onClick={() => dispatchControl("mute")}
                      className="text-white/60 hover:text-white transition-colors cursor-pointer"
                      title={muted ? "Unmute" : "Mute"}
                    >
                      {muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={muted ? 0 : volume}
                      onChange={(e) => dispatchControl("volume", parseFloat(e.target.value))}
                      className="w-full h-1 appearance-none rounded-full cursor-pointer bg-white/20 accent-accent"
                    />
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setShowEq(true)}
                      title="10-Band Equalizer"
                      className={`px-2 py-1 rounded-lg text-[10px] font-mono font-semibold border transition-colors flex items-center gap-1 cursor-pointer ${
                        eqGains.some((g) => g !== 0)
                          ? "bg-accent/20 border-accent/40 text-accent"
                          : "bg-white/5 border-white/10 text-white/65 hover:text-white"
                      }`}
                    >
                      <SlidersHorizontal size={11} />
                      <span>EQ</span>
                    </button>

                    <button
                      type="button"
                      onClick={toggleVinylMode}
                      title={vinylMode ? "Vinyl Mode on — needle-drop & crackle on each track start" : "Vinyl Mode off"}
                      className={`px-2 py-1 rounded-lg text-[10px] font-mono font-semibold border transition-colors flex items-center gap-1 cursor-pointer ${
                        vinylMode
                          ? "bg-accent/20 border-accent/40 text-accent"
                          : "bg-white/5 border-white/10 text-white/65 hover:text-white"
                      }`}
                    >
                      <Disc3 size={11} className={vinylMode ? "animate-spin-slow" : ""} />
                      <span>Vinyl</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleCycleSpeed}
                      title="Cycle Playback Speed"
                      className={`px-2 py-1 rounded-lg text-[10px] font-mono font-semibold border transition-colors flex items-center gap-1 cursor-pointer ${
                        playbackSpeed !== 1
                          ? "bg-accent/20 border-accent/40 text-accent"
                          : "bg-white/5 border-white/10 text-white/65 hover:text-white"
                      }`}
                    >
                      <Gauge size={11} />
                      <span>{playbackSpeed}x</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleCycleSleepTimer}
                      title="Cycle Sleep Timer (Off / 15m / 30m / 60m / End of Track)"
                      className={`px-2 py-1 rounded-lg text-[10px] font-mono font-semibold border transition-colors flex items-center gap-1 cursor-pointer ${
                        sleepTimerMode !== "off"
                          ? "bg-accent/20 border-accent/40 text-accent"
                          : "bg-white/5 border-white/10 text-white/65 hover:text-white"
                      }`}
                    >
                      <Moon size={11} />
                      <span>
                        {sleepTimerMode === "off"
                          ? "Sleep"
                          : sleepTimerMode === "end_of_track"
                          ? "End"
                          : sleepTimerRemainingSec
                          ? `${Math.ceil(sleepTimerRemainingSec / 60)}m`
                          : `${sleepTimerMode}m`}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Up Next Preview Pill */}
                {nextTrackInQueue && (
                  <button
                    type="button"
                    onClick={() => setMusicSkinTab("queue")}
                    className="w-full bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-left transition-colors cursor-pointer"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="text-[9px] uppercase tracking-wider text-accent font-bold block">
                        Up Next ({currentIndex + 2} of {playlist.length})
                      </span>
                      <p className="text-xs text-white/85 truncate font-medium">
                        {nextTrackInQueue.title}
                      </p>
                    </div>
                    <ListMusic size={14} className="text-white/40 flex-shrink-0" />
                  </button>
                )}
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 px-4">
                <div className="w-16 h-16 rounded-2xl bg-accent/15 border border-accent/30 flex items-center justify-center">
                  <Disc size={32} className="text-accent" />
                </div>
                <div>
                  <h3 className="text-sm font-heading font-bold text-white">No Track Playing</h3>
                  <p className="text-xs text-white/50 mt-1">
                    Browse your music library to start listening in compact skin mode.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setMusicSkinTab("library")}
                  className="px-4 py-2 rounded-xl bg-accent text-black font-semibold text-xs hover:opacity-90 transition-opacity cursor-pointer"
                >
                  Browse Music Library
                </button>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: SYNCED LYRICS */}
        {musicSkinTab === "lyrics" && (
          <div
            ref={lyricsContainerRef}
            className="flex-1 overflow-y-auto px-2 py-4 space-y-3.5 text-center"
          >
            {loadingLyrics ? (
              <div className="py-24 flex flex-col items-center gap-3 text-white/50">
                <Loader2 size={24} className="animate-spin text-accent" />
                <span className="text-xs">Searching synced lyrics on LRCLIB…</span>
              </div>
            ) : lyrics?.synced && lyrics.synced.length > 0 ? (
              lyrics.synced.map((line, i) => {
                const active = i === activeLyricIndex;
                return (
                  <button
                    type="button"
                    key={i}
                    data-lyric-idx={i}
                    onClick={() => handleSeek(line.time)}
                    className={`block w-full text-center transition-all duration-200 px-3 py-1.5 rounded-lg cursor-pointer ${
                      active
                        ? "text-accent font-bold text-base sm:text-lg scale-[1.03] bg-accent/10"
                        : "text-white/45 hover:text-white/80 text-xs"
                    }`}
                  >
                    {line.text}
                  </button>
                );
              })
            ) : lyrics?.plain ? (
              <pre className="whitespace-pre-wrap font-body text-xs text-white/80 leading-relaxed text-left p-2">
                {lyrics.plain}
              </pre>
            ) : (
              <div className="py-24 text-white/40 text-xs">
                No synced lyrics found for "{currentTrack?.title || "this track"}".
              </div>
            )}
          </div>
        )}

        {/* TAB 3: UP NEXT QUEUE */}
        {musicSkinTab === "notes" && (
          <div className="flex-1 overflow-y-auto px-3 py-4 space-y-4">
            {loadingNotes ? (
              <div className="py-24 flex flex-col items-center gap-3 text-white/50">
                <Loader2 size={24} className="animate-spin text-accent" />
                <span className="text-xs">Fetching album credits from MusicBrainz…</span>
              </div>
            ) : notesError ? (
              <div className="py-24 flex flex-col items-center gap-2 text-white/45 text-center px-4">
                <BookOpen size={22} />
                <span className="text-xs">{notesError}</span>
              </div>
            ) : linerNotes ? (
              <>
                <div className="space-y-0.5">
                  <h3 className="text-sm font-bold text-white">{linerNotes.albumTitle}</h3>
                  <p className="text-xs text-accent">{linerNotes.artistName}</p>
                  <p className="text-[10px] text-white/45 font-mono">
                    {[linerNotes.label, linerNotes.releaseDate, linerNotes.country]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>

                {linerNotes.credits.length > 0 && (
                  <div>
                    <h4 className="text-[10px] uppercase tracking-wider text-white/50 font-mono mb-1.5">
                      Personnel & Production
                    </h4>
                    <div className="space-y-1">
                      {linerNotes.credits.map((c, i) => (
                        <div key={i} className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="text-white/55 capitalize shrink-0">{c.role}</span>
                          <span className="text-white/90 text-right">{c.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {linerNotes.tracks.length > 0 && (
                  <div>
                    <h4 className="text-[10px] uppercase tracking-wider text-white/50 font-mono mb-1.5">
                      Tracklist
                    </h4>
                    <div className="space-y-0.5">
                      {linerNotes.tracks.map((t) => (
                        <div key={t.position} className="flex items-baseline gap-2 text-xs">
                          <span className="text-white/40 font-mono w-5 text-right shrink-0">{t.position}</span>
                          <span className="text-white/85 truncate flex-1">{t.title}</span>
                          {typeof t.lengthMs === "number" && t.lengthMs > 0 && (
                            <span className="text-white/40 font-mono shrink-0">
                              {Math.floor(t.lengthMs / 60000)}:{String(Math.floor((t.lengthMs % 60000) / 1000)).padStart(2, "0")}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {linerNotes.credits.length === 0 && (
                  <p className="text-[11px] text-white/40 text-center pt-2">
                    MusicBrainz has no personnel relationships recorded for this release.
                  </p>
                )}
              </>
            ) : (
              <div className="py-24 flex flex-col items-center gap-2 text-white/45">
                <BookOpen size={22} />
                <span className="text-xs">Play a track to see its album's liner notes.</span>
              </div>
            )}
          </div>
        )}

        {musicSkinTab === "queue" && (
          <div className="flex-1 overflow-y-auto space-y-1 pr-1">
            <div className="flex items-center justify-between pb-2 mb-1 border-b border-white/10 px-1 text-xs text-white/50">
              <div className="flex items-center gap-2">
                <span>Playing Queue ({playlist.length})</span>
                {playlist.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (currentTrack) {
                        setAudioState({
                          playlist: [currentTrack],
                          playlistIndex: 0,
                          playToken: audioState?.playToken ?? Date.now(),
                          shuffle: audioState?.shuffle,
                          repeatMode: audioState?.repeatMode,
                          expanded: audioState?.expanded,
                        });
                      }
                    }}
                    className="text-[10px] text-rose-400 hover:text-rose-300 underline cursor-pointer"
                  >
                    Clear Queue
                  </button>
                )}
              </div>
              {playlist.length > 0 && (
                <span className="text-accent">
                  Track {currentIndex + 1} of {playlist.length}
                </span>
              )}
            </div>
            {playlist.length > 0 ? (
              playlist.map((track, idx) => {
                const isCurrent = idx === currentIndex;
                return (
                  <div
                    key={`${track.id}-${idx}`}
                    className={`flex items-center justify-between gap-2 p-2 rounded-xl text-xs transition-colors ${
                      isCurrent
                        ? "bg-accent/20 border border-accent/40 text-accent font-semibold"
                        : "hover:bg-white/5 text-white/80"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => dispatchControl("jump", idx)}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                    >
                      <span className="w-5 text-[10px] font-mono text-white/40 text-center">
                        {idx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate">{track.title}</p>
                        <p className="text-[10px] text-white/45 truncate">
                          {track.artist || track.author || track.album}
                        </p>
                      </div>
                    </button>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => reorderAudioQueue(idx, idx - 1)}
                        disabled={idx === 0}
                        className="p-1 text-white/40 hover:text-white disabled:opacity-20 cursor-pointer"
                        title="Move Up"
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => reorderAudioQueue(idx, idx + 1)}
                        disabled={idx === playlist.length - 1}
                        className="p-1 text-white/40 hover:text-white disabled:opacity-20 cursor-pointer"
                        title="Move Down"
                      >
                        <ArrowDown size={12} />
                      </button>
                      {playlist.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeFromAudioQueue(idx)}
                          className="p-1 text-white/40 hover:text-red-400 cursor-pointer"
                          title="Remove from Queue"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="py-20 text-center text-white/40 text-xs">
                Queue is empty. Select tracks from the Library tab.
              </div>
            )}
          </div>
        )}

        {/* TAB 4: IN-SKIN MUSIC LIBRARY BROWSER */}
        {musicSkinTab === "library" && (
          <div className="flex-1 flex flex-col overflow-hidden gap-2">
            {/* Search Bar & Back Navigation */}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {(selectedArtist || selectedAlbum) && (
                <button
                  type="button"
                  onClick={() => {
                    if (selectedAlbum) setSelectedAlbum(null);
                    else setSelectedArtist(null);
                  }}
                  className="p-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-white transition-colors cursor-pointer"
                  title="Back"
                >
                  <ChevronLeft size={15} />
                </button>
              )}
              <div className="relative flex-1">
                <Search size={13} className="absolute left-2.5 top-2 text-white/40" />
                <input
                  type="text"
                  placeholder="Search artists, albums, or songs…"
                  value={librarySearch}
                  onChange={(e) => {
                    setLibrarySearch(e.target.value);
                    if (e.target.value.trim()) {
                      setSelectedArtist(null);
                      setSelectedAlbum(null);
                    }
                  }}
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder-white/35 focus:outline-none focus:border-accent"
                />
              </div>
            </div>

            {/* Drill-down Content */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {selectedAlbum ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl p-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-heading font-bold text-white truncate">
                        {selectedAlbum.name}
                      </p>
                      <p className="text-[10px] text-accent truncate">
                        {selectedAlbum.artistName} • {selectedAlbum.tracks.length} tracks
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => playTracks(selectedAlbum.tracks, 0)}
                      className="px-2.5 py-1 rounded-lg bg-accent text-black font-bold text-[11px] flex items-center gap-1 flex-shrink-0 cursor-pointer"
                    >
                      <Play size={11} className="fill-black" />
                      <span>Play All</span>
                    </button>
                  </div>

                  {selectedAlbum.tracks.map((track, idx) => (
                    <div
                      key={track.id}
                      className="flex items-center justify-between gap-2 p-2 rounded-xl hover:bg-white/5 border border-transparent hover:border-white/10 text-xs transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => playTracks(selectedAlbum.tracks, idx)}
                        className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                      >
                        <span className="w-5 text-[10px] font-mono text-white/40 text-center">
                          {track.trackNumber ?? idx + 1}
                        </span>
                        <span className="truncate text-white/90">{track.title}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => enqueueAudioEnd(track)}
                        title="Add to Queue"
                        className="p-1 rounded hover:bg-white/10 text-white/45 hover:text-accent cursor-pointer"
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : selectedArtist ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl p-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-heading font-bold text-white truncate">
                        {selectedArtist.name}
                      </p>
                      <p className="text-[10px] text-white/50">
                        {selectedArtist.albumCount} albums • {selectedArtist.trackCount} tracks
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const allTracks = Object.values(selectedArtist.albums).flatMap(
                          (a) => a.tracks
                        );
                        playTracks(allTracks, 0);
                      }}
                      className="px-2.5 py-1 rounded-lg bg-accent text-black font-bold text-[11px] flex items-center gap-1 flex-shrink-0 cursor-pointer"
                    >
                      <Play size={11} className="fill-black" />
                      <span>Play Artist</span>
                    </button>
                  </div>

                  {Object.values(selectedArtist.albums).map((alb) => (
                    <div
                      key={alb.name}
                      className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedAlbum(alb)}
                        className="min-w-0 flex-1 text-left cursor-pointer"
                      >
                        <p className="font-semibold text-white truncate">{alb.name}</p>
                        <p className="text-[10px] text-white/45">
                          {alb.tracks.length} tracks {alb.year ? `• ${alb.year}` : ""}
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => playTracks(alb.tracks, 0)}
                        className="px-2.5 py-1 rounded-lg bg-accent/20 hover:bg-accent text-accent hover:text-black font-bold text-[10px] transition-colors cursor-pointer"
                      >
                        Play
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  {/* Direct Track Matches when searching */}
                  {matchingTracks.length > 0 && (
                    <div className="space-y-1 mb-3">
                      <p className="text-[10px] uppercase tracking-wider font-bold text-accent px-1">
                        Songs ({matchingTracks.length})
                      </p>
                      {matchingTracks.map((t, idx) => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between gap-2 p-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs"
                        >
                          <button
                            type="button"
                            onClick={() => playTracks(matchingTracks, idx)}
                            className="min-w-0 flex-1 text-left cursor-pointer"
                          >
                            <p className="font-medium text-white truncate">{t.title}</p>
                            <p className="text-[10px] text-white/45 truncate">
                              {t.artist || t.author} {t.album ? `• ${t.album}` : ""}
                            </p>
                          </button>
                          <button
                            type="button"
                            onClick={() => enqueueAudioNext(t)}
                            title="Play Next in Queue"
                            className="p-1 rounded hover:bg-white/10 text-white/50 hover:text-accent cursor-pointer"
                          >
                            <Plus size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Artists List */}
                  <p className="text-[10px] uppercase tracking-wider font-bold text-white/45 px-1">
                    Artists ({filteredArtists.length})
                  </p>
                  {filteredArtists.length > 0 ? (
                    filteredArtists.map((artist) => {
                      const albumsList = Object.values(artist.albums);
                      return (
                        <div
                          key={artist.name}
                          className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                        >
                          <button
                            type="button"
                            onClick={() => setSelectedArtist(artist)}
                            className="min-w-0 flex-1 text-left cursor-pointer"
                          >
                            <p className="text-xs font-heading font-bold text-white truncate">
                              {artist.name}
                            </p>
                            <p className="text-[10px] text-white/45">
                              {albumsList.length} {albumsList.length === 1 ? "album" : "albums"} •{" "}
                              {artist.trackCount} tracks
                            </p>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const allTracks = albumsList.flatMap((a) => a.tracks);
                              playTracks(allTracks, 0);
                            }}
                            className="px-2.5 py-1 rounded-lg bg-accent/20 hover:bg-accent text-accent hover:text-black font-bold text-[10px] transition-colors cursor-pointer"
                          >
                            Play
                          </button>
                        </div>
                      );
                    })
                  ) : (
                    <div className="py-16 text-center text-white/40 text-xs">
                      No music artists found.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Persistent Compact Mini-Transport Footer when viewing Lyrics, Queue, or Library */}
      {musicSkinTab !== "playing" && currentTrack && (
        <footer className="relative z-20 flex-shrink-0 bg-black/70 backdrop-blur-md border-t border-white/10 px-3 py-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setMusicSkinTab("playing")}
            className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
          >
            <div className="w-8 h-8 rounded-lg bg-white/10 overflow-hidden flex-shrink-0 flex items-center justify-center">
              {posterSrc ? (
                <img src={posterSrc} alt="" className="w-full h-full object-cover" />
              ) : (
                <Disc size={16} className="text-accent" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-white truncate">{currentTrack.title}</p>
              <p className="text-[10px] text-accent truncate">
                {currentTrack.artist || currentTrack.author || "Unknown Artist"}
              </p>
            </div>
          </button>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => dispatchControl(playing ? "pause" : "play")}
              className="w-8 h-8 rounded-full bg-accent text-black flex items-center justify-center cursor-pointer"
            >
              {playing ? (
                <Pause size={14} className="fill-black" />
              ) : (
                <Play size={14} className="fill-black ml-0.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => dispatchControl("next")}
              className="p-1.5 text-white/75 hover:text-white cursor-pointer"
            >
              <SkipForward size={16} />
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
