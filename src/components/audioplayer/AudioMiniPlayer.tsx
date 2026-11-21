import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  ChevronDown, ChevronUp, Disc, Loader2, Download, Moon,
  BookOpen, Bookmark, BookmarkPlus, RotateCcw, RotateCw,
  Gauge, X, Trash2, Check, Edit3, Headphones, Cast, Share2,
  Shuffle, Repeat, Repeat1, ListMusic, Mic2, ArrowUp, ArrowDown, Maximize2,
  SlidersHorizontal, Zap,
} from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import Hls from "hls.js";
import { useAppStore, type MediaItem, type AudioBookmark } from "../../store/appStore";
import { fetchTrackLyrics, type LyricsResult } from "../../lib/lrclib";
import { useArtwork } from "../../lib/artwork";
import { downloadSingleItem, getDownloadedFilePath } from "../../lib/downloadManager";
import { findMatchingEbook, isAudiobookItem } from "../../lib/whispersync";
import { pickDefaultPlaybackVersion } from "../../lib/multiVersion";
import { FavoriteButton } from "../common/FavoriteButton";
import { AddToPlaylistButton } from "../playlist/AddToPlaylistButton";
import { FixMatchModal } from "../library/FixMatchModal";
import { useCastStore } from "../../lib/cast";
import { CastModal } from "../player/CastModal";
import { PairAudiobookModal } from "../audiobooks/PairAudiobookModal";
import { isDropmbUrl, extractDropmbShareId } from "../../lib/dropmbOffload";
import { useToastStore } from "../../store/toastStore";
import { playNeedleDropEffect } from "../../lib/audioEffects";
import { attachAudioElementToGraph, setSharedAnalyser } from "../../lib/audioGraph";
import { SpectrumCanvas } from "../music/SpectrumCanvas";

export type AudioChapter = {
  id: number;
  start: number;
  end: number;
  title: string;
};

type Props = {
  playlist: MediaItem[];
  playlistIndex: number;
  playToken?: number;
  onClose: () => void;
};

export function AudioMiniPlayer({ playlist, playlistIndex: initialIndex, playToken, onClose }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const isEpubReaderActive = location.pathname === "/play/epub";

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const prefetchAudioRef = useRef<HTMLAudioElement | null>(null);
  const prefetchTrackIdRef = useRef<string | null>(null);
  const prefetchUrlRef = useRef<string | null>(null);

  const lastReaderLocationRef = useRef<{
    cfi?: string;
    href?: string;
    displayedPage?: number;
    displayedTotal?: number;
    tocIndex?: number;
    tocTitle?: string;
    tocCount?: number;
  } | null>(null);

  useEffect(() => {
    const onReaderLocation = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        lastReaderLocationRef.current = detail;
      }
    };
    window.addEventListener("rcloneflix:reader-location", onReaderLocation);
    return () => window.removeEventListener("rcloneflix:reader-location", onReaderLocation);
  }, []);

  useEffect(() => {
    const onStopAudio = () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }
      if (prefetchAudioRef.current) {
        prefetchAudioRef.current.pause();
        prefetchAudioRef.current.src = "";
      }
      try {
        (window as any).AndroidBridge?.stopMediaSession?.();
      } catch {}
      onClose();
    };
    window.addEventListener("rcloneflix:stop-audio", onStopAudio);
    return () => window.removeEventListener("rcloneflix:stop-audio", onStopAudio);
  }, [onClose]);
  const {
    rcloneConfigPath,
    libraries,
    updateWatchProgress,
    watchProgress,
    audioBookmarks,
    addAudioBookmark,
    removeAudioBookmark,
    mediaItems,
    whispersyncPairs,
    audioState,
    removeFromAudioQueue,
    reorderAudioQueue,
    toggleAudioShuffle,
    cycleAudioRepeat,
    setAudioExpanded,
    setAudioPlaylistIndex,
    isMusicSkinMode,
    setMusicSkinMode,
  } = useAppStore();

  const isShuffle = Boolean(audioState?.shuffle);
  const repeatMode = audioState?.repeatMode ?? "off";
  const isExpanded = Boolean(audioState?.expanded);

  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  // Synchronize index whenever a new track, playlist, or album is selected externally
  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex, playlist, playToken]);

  // Keep store audioState.playlistIndex synced when tracks advance internally without circular trigger
  useEffect(() => {
    const currentStoreIdx = useAppStore.getState().audioState?.playlistIndex;
    if (currentStoreIdx !== undefined && currentStoreIdx !== currentIndex) {
      setAudioPlaylistIndex(currentIndex);
    }
  }, [currentIndex, setAudioPlaylistIndex]);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLocal, setIsLocal] = useState(false);
  const [activeSourceType, setActiveSourceType] = useState<"local" | "dropmb" | "remote">("remote");
  const [activeRemoteName, setActiveRemoteName] = useState<string>("");
  const [dropmbShareUrl, setDropmbShareUrl] = useState<string | null>(null);

  // Chapters & Bookmarks drawer state
  const [chapters, setChapters] = useState<AudioChapter[]>([]);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [showChapterDrawer, setShowChapterDrawer] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"chapters" | "bookmarks">("chapters");
  const [showAddBookmark, setShowAddBookmark] = useState(false);
  const [newBookmarkTitle, setNewBookmarkTitle] = useState("");
  const [newBookmarkNote, setNewBookmarkNote] = useState("");
  const [showFixMatch, setShowFixMatch] = useState(false);
  const [showPairModal, setShowPairModal] = useState(false);
  const chaptersRef = useRef<AudioChapter[]>(chapters);
  chaptersRef.current = chapters;

  // Playback speed state (0.75x, 1x, 1.25x, 1.5x, 1.75x, 2x, 2.5x)
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const speedOptions = [0.75, 1.0, 1.2, 1.25, 1.5, 1.75, 2.0, 2.5];

  // 10-Band Web Audio Equalizer & Silence Skipper state
  const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
  const EQ_PRESETS: Record<string, { label: string; gains: number[] }> = {
    flat: { label: "Flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    bass_boost: { label: "Bass Boost", gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
    vocal: { label: "Vocal / Podcast", gains: [-2, -2, -1, 1, 4, 5, 4, 2, 0, -1] },
    rock: { label: "Rock", gains: [4, 3, 1, -1, -2, 0, 2, 4, 5, 5] },
    electronic: { label: "Electronic", gains: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5] },
    acoustic: { label: "Acoustic", gains: [3, 3, 2, 0, 1, 1, 3, 4, 3, 2] },
    podcast: { label: "Speech Clarity", gains: [-4, -3, -1, 2, 4, 5, 4, 2, 0, -2] },
  };
  const [eqPreset, setEqPreset] = useState<string>("flat");
  const [eqGains, setEqGains] = useState<number[]>([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const [skipSilence, setSkipSilence] = useState(false);
  const [showEqModal, setShowEqModal] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const eqFiltersRef = useRef<BiquadFilterNode[]>([]);
  const preampGainRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaSourceMapRef = useRef<WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>>(new WeakMap());

  // Audio sleep timer state (15m, 30m, 45m, 60m, end of track, end of chapter)
  const [sleepTimerMode, setSleepTimerMode] = useState<"off" | 15 | 30 | 45 | 60 | "end_of_track" | "end_of_chapter">("off");
  const [sleepTimerRemainingSec, setSleepTimerRemainingSec] = useState<number | null>(null);
  const [showSleepMenu, setShowSleepMenu] = useState(false);
  const sleepTimerModeRef = useRef(sleepTimerMode);
  sleepTimerModeRef.current = sleepTimerMode;

  useEffect(() => {
    return () => {
      setSharedAnalyser(null);
    };
  }, []);

  // Google Cast / Chromecast state
  const { status: castStatus, selectedDevice: castDevice } = useCastStore();
  const [showCastModal, setShowCastModal] = useState(false);

  // Platform check: Linux Desktop WebKitGTK disconnects native GStreamer sink when createMediaElementSource is invoked.
  // Exclude Android because Android's User-Agent contains "Linux; Android" and supports Web Audio natively.
  const isLinuxDesktop =
    typeof navigator !== "undefined" &&
    /linux/i.test(navigator.userAgent || navigator.platform || "") &&
    !/android/i.test(navigator.userAgent || "");

  const applyVolume = useCallback((vol: number, isMuted: boolean) => {
    const effectiveVol = isMuted ? 0 : vol;
    if (audioRef.current) {
      audioRef.current.volume = Math.max(0, Math.min(1, effectiveVol));
      audioRef.current.muted = isMuted;
    }
  }, []);

  const attachWebAudio = useCallback((audio: HTMLAudioElement, forceAttach = false) => {
    applyVolume(volume, muted);
    if (isLinuxDesktop) return;
    const isDspRequested = forceAttach || skipSilence || eqGains.some((g) => g !== 0);
    if (!isDspRequested && !mediaSourceMapRef.current.has(audio)) return;
    const isLocalProxy = Boolean(audio.src && (audio.src.startsWith("http://127.0.0.1") || audio.src.startsWith("blob:")));
    if (!isLocalProxy && !audio.crossOrigin) return;

    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) {
        const ctx = new Ctx();
        const preamp = ctx.createGain();
        const filters = EQ_FREQUENCIES.map((freq) => {
          const f = ctx.createBiquadFilter();
          f.type = "peaking";
          f.frequency.value = freq;
          f.Q.value = 1.4;
          f.gain.value = 0;
          return f;
        });
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;

        preamp.connect(filters[0]);
        for (let i = 0; i < filters.length - 1; i++) {
          filters[i].connect(filters[i + 1]);
        }
        filters[filters.length - 1].connect(analyser);
        analyser.connect(ctx.destination);

        audioCtxRef.current = ctx;
        preampGainRef.current = preamp;
        eqFiltersRef.current = filters;
        analyserRef.current = analyser;
        setSharedAnalyser(analyser);
      }

      if (audioCtxRef.current.state === "suspended") {
        void audioCtxRef.current.resume();
      }

      if (!mediaSourceMapRef.current.has(audio) && preampGainRef.current) {
        const srcNode = audioCtxRef.current.createMediaElementSource(audio);
        srcNode.connect(preampGainRef.current);
        mediaSourceMapRef.current.set(audio, srcNode);
      }
    } catch {
      // Fallback to direct HTML5 audio if element is already bound or restricted
    }
  }, [applyVolume, volume, muted, isLinuxDesktop]);

  useEffect(() => {
    if ((skipSilence || eqGains.some((g) => g !== 0)) && audioRef.current) {
      attachWebAudio(audioRef.current, true);
    }
    eqFiltersRef.current.forEach((f, idx) => {
      f.gain.value = eqGains[idx] ?? 0;
    });
    if (preampGainRef.current) {
      const maxBoost = Math.max(0, ...eqGains);
      preampGainRef.current.gain.value = Math.pow(10, (-maxBoost * 0.45) / 20);
    }
  }, [eqGains, skipSilence, attachWebAudio]);

  // Music Mode (MusicSkinShell) remote control for the EQ + live snapshot for its initial state.
  useEffect(() => {
    const onSetEq = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (Array.isArray(d.gains) && d.gains.length === 10) {
        setEqGains(d.gains.map((g: unknown) => Math.max(-12, Math.min(12, Number(g) || 0))));
      }
      if (typeof d.preset === "string") setEqPreset(d.preset);
    };
    window.addEventListener("rcloneflix:set-eq", onSetEq);
    return () => window.removeEventListener("rcloneflix:set-eq", onSetEq);
  }, []);

  useEffect(() => {
    (window as any).__rcloneflix_eq = { gains: eqGains, preset: eqPreset };
  }, [eqGains, eqPreset]);

  useEffect(() => {
    if (!skipSilence || isLinuxDesktop) {
      if (audioRef.current) audioRef.current.playbackRate = playbackSpeed;
      return;
    }
    const buf = new Float32Array(1024);
    const timer = setInterval(() => {
      const analyser = analyserRef.current;
      const audio = audioRef.current;
      if (!analyser || !audio || audio.paused) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      audio.playbackRate = rms < 0.006 ? Math.min(2.5, playbackSpeed + 0.6) : playbackSpeed;
    }, 120);
    return () => clearInterval(timer);
  }, [skipSilence, playbackSpeed, isLinuxDesktop]);

  useEffect(() => {
    if (typeof sleepTimerMode === "number") {
      setSleepTimerRemainingSec(sleepTimerMode * 60);
    } else {
      setSleepTimerRemainingSec(null);
      applyVolume(volume, muted);
    }
  }, [sleepTimerMode, muted, volume, applyVolume]);

  useEffect(() => {
    if (sleepTimerRemainingSec === null) return;
    if (sleepTimerRemainingSec <= 0) {
      if (audioRef.current) {
        audioRef.current.pause();
        applyVolume(volume, muted);
      }
      setPlaying(false);
      setSleepTimerMode("off");
      setSleepTimerRemainingSec(null);
      return;
    }

    const interval = setInterval(() => {
      setSleepTimerRemainingSec((prev) => {
        if (prev === null || prev <= 1) {
          if (audioRef.current) {
            audioRef.current.pause();
            applyVolume(volume, muted);
          }
          setPlaying(false);
          setSleepTimerMode("off");
          return null;
        }

        const next = prev - 1;
        // Smooth 30-second volume fade-out before stopping
        if (next <= 30 && audioRef.current && !muted) {
          const fadeRatio = Math.max(0, next / 30);
          applyVolume(volume * fadeRatio, muted);
        }
        return next;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [sleepTimerRemainingSec, volume, muted, applyVolume]);

  const currentTrack = playlist[currentIndex] ?? null;
  const posterSrc = useArtwork(currentTrack?.posterUrl);

  // Vinyl Mode: needle-drop + surface crackle on each track start. Uses a standalone
  // AudioContext (audioEffects.ts), NOT a media-element tap, so it works on Linux
  // desktop where WebAudio DSP on the <audio> element is architecturally unavailable.
  // Toggled from the Music Skin; read at trigger time so no cross-window sync needed.
  useEffect(() => {
    if (!currentTrack || isAudiobookItem(currentTrack)) return;
    let vinyl = false;
    try {
      vinyl = localStorage.getItem("rcloneflix_vinyl_mode") === "1";
    } catch {
      // localStorage can be unavailable (private mode); vinyl stays off
    }
    if (vinyl) playNeedleDropEffect();
  }, [currentTrack?.id]);

  const allMediaItems = useMemo(() => Object.values(mediaItems), [mediaItems]);
  const matchingEbook = useMemo(() => {
    if (!currentTrack || !isAudiobookItem(currentTrack)) return undefined;
    return findMatchingEbook(currentTrack, allMediaItems, whispersyncPairs);
  }, [currentTrack, allMediaItems, whispersyncPairs]);

  const [expandedTab, setExpandedTab] = useState<"playing" | "queue" | "lyrics" | "chapters">("playing");
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [loadingLyrics, setLoadingLyrics] = useState(false);

  useEffect(() => {
    if (!currentTrack || isAudiobookItem(currentTrack)) {
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

  // Stream URL fetcher: checks local download first (< 0.2ms), then DropMB 100-day edge cache (< 1s), then rclone HTTP daemon
  const getStreamUrlForTrack = useCallback(
    async (track: MediaItem, options?: { isPrefetch?: boolean }): Promise<string> => {
      // 0. Check multi-version priority (1=local, 2=dropmb/streamtape, 3=cloud remote)
      const defVersion = pickDefaultPlaybackVersion(track);

      // 1. Direct local download check
      const localPath = await getDownloadedFilePath(track);
      if (localPath) {
        if (!options?.isPrefetch) {
          setIsLocal(true);
          setActiveSourceType("local");
          setActiveRemoteName("Local Disk");
          setDropmbShareUrl(null);
        }
        try {
          const res = await invoke<{ file_url: string }>("start_local_file_stream", {
            filePath: localPath,
          });
          return res.file_url;
        } catch {
          return convertFileSrc(localPath);
        }
      }

      // 2. DropMB 100-Day Cloud Edge Cache Check (Priority 2)
      const isDropmb =
        defVersion.remoteName === "dropmb" ||
        isDropmbUrl(defVersion.remotePath) ||
        isDropmbUrl(track.remotePath) ||
        track.versions?.some((v) => v.remoteName === "dropmb" || isDropmbUrl(v.remotePath));

      if (isDropmb) {
        const dropmbVer = track.versions?.find((v) => v.remoteName === "dropmb" || isDropmbUrl(v.remotePath));
        const targetUrl = dropmbVer?.remotePath || (isDropmbUrl(defVersion.remotePath) ? defVersion.remotePath : track.remotePath);
        const shareId = extractDropmbShareId(targetUrl);

        if (!options?.isPrefetch) {
          setIsLocal(false);
          setActiveSourceType("dropmb");
          setActiveRemoteName("DropMB Cloud");
          if (shareId) {
            setDropmbShareUrl(`https://dropmb.com/share/${shareId}`);
          }
        }

        try {
          const proxied = await invoke<string>("get_stream_proxy_url", {
            url: targetUrl,
            referer: shareId ? `https://dropmb.com/share/${shareId}` : "https://dropmb.com",
          });
          if (proxied) return proxied;
        } catch (e) {
          console.warn("Failed to proxy DropMB stream:", e);
        }
        return targetUrl;
      }

      // 2b. Catbox.moe public hotlink
      const catboxVer = track.versions?.find(
        (v) =>
          (v.sourceType === ("catbox" as any) || v.remoteName === "catbox") &&
          v.shareUrl?.startsWith("https://files.catbox.moe/")
      );
      if (catboxVer?.shareUrl) {
        if (!options?.isPrefetch) {
          setIsLocal(false);
          setActiveSourceType("remote");
          setActiveRemoteName("Catbox.moe");
          setDropmbShareUrl(null);
        }
        return catboxVer.shareUrl;
      }

      // 3. Direct web stream / Internet radio / audio bookmark
      const effectivePath = defVersion.remotePath || track.remotePath;
      if (effectivePath.startsWith("http://") || effectivePath.startsWith("https://")) {
        if (!options?.isPrefetch) {
          setIsLocal(false);
          setActiveSourceType("remote");
          setActiveRemoteName("Web Stream");
          setDropmbShareUrl(null);
        }
        try {
          const direct = await invoke<string>("resolve_web_stream_url", { url: effectivePath });
          return direct || effectivePath;
        } catch {
          return effectivePath;
        }
      }

      // 4. Primary Cloud Remote Daemon (rclone)
      if (!options?.isPrefetch) {
        setIsLocal(false);
        setActiveSourceType("remote");
        setDropmbShareUrl(null);
      }

      const rName =
        defVersion.remoteName && defVersion.remoteName !== "remote"
          ? defVersion.remoteName
          : track.remotePath.includes(":")
          ? track.remotePath.split(":")[0]
          : "Cloud Remote";
      if (!options?.isPrefetch) {
        setActiveRemoteName(rName);
      }

      const library = libraries.find((l) => l.id === track.libraryId);
      // Special remotes (Telegram etc.) are NOT library roots: derive root/path from the path itself
      // instead of mis-routing them to the library's first remote.
      const audioCleanLower = track.remotePath.toLowerCase().replace(/^shared_/, "");
      const isSpecialAudioRemote = [
        "streamtape:",
        "telegram-drive:",
        "telegram:",
        "tg-native:",
        "tg-serverless:",
        "udrop:",
        "usenet-drive:",
      ].some((p) => audioCleanLower.startsWith(p));

      let matchingRoot: string;
      let relPath: string;
      if (isSpecialAudioRemote) {
        const specialColon = track.remotePath.indexOf(":");
        matchingRoot = track.remotePath.slice(0, specialColon + 1);
        relPath = track.remotePath.slice(specialColon + 1).replace(/^\/+/, "");
      } else {
        matchingRoot =
          library?.remotePaths.find((p) => {
            const r = p.replace(/\/+$/, "");
            return track.remotePath.startsWith(r + "/") || (r.endsWith(":") && track.remotePath.startsWith(r));
          }) ?? library?.remotePaths[0] ?? "";

        const rootTrimmed = matchingRoot.replace(/\/+$/, "");
        if (track.remotePath.startsWith(rootTrimmed + "/")) {
          relPath = track.remotePath.slice(rootTrimmed.length + 1);
        } else if (rootTrimmed.endsWith(":") && track.remotePath.startsWith(rootTrimmed)) {
          relPath = track.remotePath.slice(rootTrimmed.length).replace(/^\/+/, "");
        } else {
          relPath = track.remotePath.split("/").pop() ?? track.filename;
        }
      }

      const res = await invoke<{ file_url: string }>("start_stream_session", {
        configPath: rcloneConfigPath,
        remoteRoot: matchingRoot,
        filePath: relPath,
        sessionId: `audio-${track.id}`,
      });
      return res.file_url;
    },
    [rcloneConfigPath, libraries]
  );

  // Prefetch helper for the next track in the playlist
  const prefetchNextTrack = useCallback(
    (track: MediaItem | undefined) => {
      if (!track) {
        if (prefetchAudioRef.current) {
          prefetchAudioRef.current.pause();
          prefetchAudioRef.current.src = "";
          prefetchAudioRef.current = null;
        }
        prefetchTrackIdRef.current = null;
        prefetchUrlRef.current = null;
        return;
      }

      // Avoid re-fetching if already prefetching this track
      if (prefetchTrackIdRef.current === track.id) return;

      prefetchTrackIdRef.current = track.id;

      getStreamUrlForTrack(track, { isPrefetch: true })
        .then((url) => {
          if (prefetchTrackIdRef.current !== track.id) return;
          prefetchUrlRef.current = url;

          if (!prefetchAudioRef.current) {
            prefetchAudioRef.current = new Audio();
          }
          const pAudio = prefetchAudioRef.current;
          pAudio.preload = "auto";
          if (url.startsWith("http://127.0.0.1")) {
            pAudio.crossOrigin = "anonymous";
          } else {
            pAudio.removeAttribute("crossorigin");
          }
          pAudio.src = url;
          pAudio.load();
        })
        .catch((err) => {
          console.warn("Next-track prefetch error:", err);
          prefetchTrackIdRef.current = null;
          prefetchUrlRef.current = null;
        });
    },
    [getStreamUrlForTrack]
  );

  // Global unmount cleanup: STOP active & prefetch playback immediately when closed
  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
      if (prefetchAudioRef.current) {
        prefetchAudioRef.current.pause();
        prefetchAudioRef.current.src = "";
        prefetchAudioRef.current = null;
      }
      prefetchTrackIdRef.current = null;
      prefetchUrlRef.current = null;
      try {
        (window as any).AndroidBridge?.stopMediaSession?.();
      } catch {}
    };
  }, []);

  const getStreamUrlForTrackRef = useRef(getStreamUrlForTrack);
  getStreamUrlForTrackRef.current = getStreamUrlForTrack;

  // Track playback effect
  useEffect(() => {
    if (!currentTrack) return;

    let mounted = true;

    const saved = watchProgress[currentTrack.id];
    const initialPos = saved?.position ?? 0;

    // Attach event listeners directly to the active audio element
    const onTimeUpdate = () => {
      if (mounted && audioRef.current) {
        const cur = audioRef.current.currentTime;
        setCurrentTime(cur);

        const ch = chaptersRef.current.find(
          (c) => cur >= c.start && (c.end > c.start ? cur < c.end : true)
        );
        const chIdx = ch ? chaptersRef.current.indexOf(ch) : -1;

        window.dispatchEvent(
          new CustomEvent("rcloneflix:whispersync-audio-tick", {
            detail: {
              currentTime: cur,
              duration: audioRef.current.duration || 0,
              chapterIndex: chIdx >= 0 ? chIdx : currentIndex,
              chapterStart: ch ? ch.start : 0,
              chapterEnd: ch && ch.end > ch.start ? ch.end : (audioRef.current.duration || 0),
              chapterTitle: ch?.title || currentTrack.title,
              playing: !audioRef.current.paused,
            },
          })
        );

        if (sleepTimerModeRef.current === "end_of_chapter") {
          if (ch && cur >= ch.end - 0.5) {
            audioRef.current.pause();
            setPlaying(false);
            setSleepTimerMode("off");
            setSleepTimerRemainingSec(null);
          }
        }
      }
    };
    const onLoadedMetadata = () => {
      if (!mounted || !audioRef.current) return;
      audioRef.current.playbackRate = playbackSpeed;
      setDuration(audioRef.current.duration);
      if (initialPos > 5 && initialPos < audioRef.current.duration - 5) {
        audioRef.current.currentTime = initialPos;
      }
    };
    const onEnded = () => {
      if (!mounted) return;
      setPlaying(false);
      if (audioRef.current) {
        updateWatchProgress({
          itemId: currentTrack.id,
          position: audioRef.current.duration,
          duration: audioRef.current.duration,
          completed: true,
          lastWatchedAt: Date.now(),
        });
      }
      if (sleepTimerModeRef.current === "end_of_track") {
        setSleepTimerMode("off");
        setSleepTimerRemainingSec(null);
        return;
      }
      if (repeatMode === "one" && audioRef.current) {
        audioRef.current.currentTime = 0;
        audioRef.current.play().then(() => setPlaying(true)).catch(() => {});
        return;
      }
      if (isShuffle && playlist.length > 1) {
        let nextIdx = Math.floor(Math.random() * playlist.length);
        if (nextIdx === currentIndex) nextIdx = (currentIndex + 1) % playlist.length;
        setCurrentIndex(nextIdx);
      } else if (currentIndex < playlist.length - 1) {
        setCurrentIndex((i) => i + 1);
      } else if (repeatMode === "all" && playlist.length > 0) {
        setCurrentIndex(0);
      } else {
        try {
          (window as any).AndroidBridge?.updateMediaSession?.(
            currentTrack.title || "RcloneFlix",
            currentTrack.artist || currentTrack.author || "",
            currentTrack.album || "",
            duration || 0,
            duration || 0,
            false,
            posterSrc || ""
          );
        } catch {}
      }
    };
    const onError = (e: Event) => {
      if (!mounted) return;
      const audioEl = e.target as HTMLAudioElement;
      const err = audioEl?.error;
      const rawSrc = audioEl?.getAttribute("src") || audioEl?.src || "";
      // Ignore spurious or synthetic empty-src errors triggered by resetting audio elements or route navigation
      if (
        !rawSrc ||
        rawSrc === window.location.href ||
        rawSrc === window.location.origin + "/" ||
        rawSrc.endsWith("/settings")
      ) {
        return;
      }
      console.error("Audio playback error:", err ? { code: err.code, message: err.message } : null, "src:", rawSrc);
      setError(`Playback error: ${err?.message || "Unsupported format"}`);
      setLoading(false);
      setPlaying(false);
    };

    // Check if this track was already preloaded by the background prefetcher
    const isPreloaded =
      prefetchAudioRef.current &&
      prefetchTrackIdRef.current === currentTrack.id &&
      prefetchUrlRef.current;

    if (isPreloaded && prefetchAudioRef.current) {
      // Swap active audio element with preloaded one immediately!
      const oldAudio = audioRef.current;
      if (oldAudio) {
        oldAudio.pause();
        oldAudio.removeAttribute("src");
        oldAudio.load();
      }

      const audio = prefetchAudioRef.current;
      audioRef.current = audio;
      prefetchAudioRef.current = null;
      prefetchTrackIdRef.current = null;
      const preloadedUrl = prefetchUrlRef.current!;
      prefetchUrlRef.current = null;

      setCurrentUrl(preloadedUrl);
      setLoading(false);
      setError(null);
      setCurrentTime(0);
      setDuration(audio.duration || 0);

      audio.addEventListener("timeupdate", onTimeUpdate);
      audio.addEventListener("loadedmetadata", onLoadedMetadata);
      if (audio.readyState >= 1) {
        onLoadedMetadata();
      }
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);

      audio.playbackRate = playbackSpeed;
      attachWebAudio(audio);
      audio
        .play()
        .then(() => {
          if (mounted) setPlaying(true);
        })
        .catch((err) => {
          if (mounted) {
            console.warn("Autoplay error or blocked on preloaded track:", err);
            setLoading(false);
          }
        });

      // Prefetching of next track will happen once this track is playing smoothly

      return () => {
        mounted = false;
        audio.removeEventListener("timeupdate", onTimeUpdate);
        audio.removeEventListener("loadedmetadata", onLoadedMetadata);
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
      };
    }

    // Normal path (first track or non-preloaded track jump)
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    const audio = audioRef.current;
    audio.pause();
    audio.volume = Math.max(0, Math.min(1, muted ? 0 : volume));
    audio.muted = muted;

    setLoading(true);
    setCurrentTime(0);
    setDuration(0);
    setError(null);

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    getStreamUrlForTrackRef.current(currentTrack)
      .then((url) => {
        if (!mounted) return;
        setCurrentUrl(url);

        // STRICTLY SITE-SPECIFIC: Only attach HLS to iHeartRadio streams.
        // General .m3u8 video streams must NEVER be handled here (they route to VLC).
        const isIheartAudio =
          url.includes("iheart") ||
          url.includes("ihrhls") ||
          url.includes("revma") ||
          Boolean(currentTrack?.sourceUrl?.includes("iheart")) ||
          Boolean(currentTrack?.remotePath?.includes("ihrhls"));

        // If iHeart provides an .m3u8, direct AAC shoutcast stream is available by stripping /hls.m3u8
        // which plays natively in HTML5 audio across all browsers without HLS chunking/manifest issues.
        const effectiveUrl =
          isIheartAudio && url.includes("/hls.m3u8")
            ? url.replace(/\/hls\.m3u8.*$/i, "")
            : url;

        if (effectiveUrl.includes(".m3u8")) {
          if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
          }
          if (Hls.isSupported()) {
            const hls = new Hls({
              enableWorker: false,
              lowLatencyMode: true,
            });
            hlsRef.current = hls;
            hls.loadSource(effectiveUrl);
            hls.attachMedia(audio);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              if (mounted) {
                audio.playbackRate = playbackSpeed;
                attachWebAudio(audio);
                audio
                  .play()
                  .then(() => {
                    if (mounted) {
                      setPlaying(true);
                      setLoading(false);
                    }
                  })
                  .catch((err) => {
                    if (mounted) {
                      console.warn("Autoplay blocked for HLS stream:", err);
                      setLoading(false);
                    }
                  });
              }
            });
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal) {
                console.error("Audio HLS fatal error:", data);
                if (mounted) {
                  // If it was an iHeart stream, try fallback to direct stream
                  if (isIheartAudio && url.includes("/hls.m3u8")) {
                    console.log("HLS failed, falling back to direct AAC stream:", url.replace(/\/hls\.m3u8.*$/i, ""));
                    hls.destroy();
                    hlsRef.current = null;
                    const directUrl = url.replace(/\/hls\.m3u8.*$/i, "");
                    audio.src = directUrl;
                    audio.playbackRate = playbackSpeed;
                    attachWebAudio(audio);
                    audio
                      .play()
                      .then(() => {
                        if (mounted) {
                          setPlaying(true);
                          setLoading(false);
                        }
                      })
                      .catch(() => {
                        if (mounted) {
                          setError(`HLS error: ${data.details}`);
                          setLoading(false);
                          setPlaying(false);
                        }
                      });
                    return;
                  }
                  setError(`HLS error: ${data.details}`);
                  setLoading(false);
                  setPlaying(false);
                }
              }
            });
          } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
            if (effectiveUrl.startsWith("http://127.0.0.1")) {
              audio.crossOrigin = "anonymous";
            } else {
              audio.removeAttribute("crossorigin");
            }
            audio.src = effectiveUrl;
            audio.playbackRate = playbackSpeed;
            attachWebAudio(audio);
            audio
              .play()
              .then(() => {
                if (mounted) {
                  setPlaying(true);
                  setLoading(false);
                }
              })
              .catch(() => setLoading(false));
          } else {
            setError("HLS audio playback is not supported in this environment");
            setLoading(false);
          }
        } else {
          if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
          }
          if (effectiveUrl.startsWith("http://127.0.0.1")) {
            audio.crossOrigin = "anonymous";
          } else {
            audio.removeAttribute("crossorigin");
          }
          audio.src = effectiveUrl;
          audio.playbackRate = playbackSpeed;
          attachWebAudio(audio);

          audio
            .play()
            .then(() => {
              if (mounted) {
                setPlaying(true);
                setLoading(false);
              }
            })
            .catch((err) => {
              if (mounted) {
                console.warn("Autoplay error or blocked:", err);
                setLoading(false);
              }
            });
        }

        // Next track prefetching will trigger once current track is comfortably playing
      })
      .catch((e) => {
        if (!mounted) return;
        console.error("Audio stream URL fetch error:", e);
        setError(`Stream failed: ${e instanceof Error ? e.message : String(e)}`);
        setLoading(false);
      });

    return () => {
      mounted = false;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, [currentIndex, currentTrack?.id, playToken]);

  // Only prefetch the next track once the current track has been playing smoothly for 15s
  useEffect(() => {
    if (playing && currentTime > 15 && playlist[currentIndex + 1]) {
      prefetchNextTrack(playlist[currentIndex + 1]);
    }
  }, [playing, currentTime, currentIndex, playlist, prefetchNextTrack]);

  // Extract chapters whenever audio stream URL changes (strictly for audiobooks, debounced to avoid startup contention)
  useEffect(() => {
    if (!currentUrl || !currentTrack) {
      setChapters([]);
      return;
    }

    const isAudiobook =
      currentTrack.libraryType === "audiobooks" ||
      currentTrack.filename.toLowerCase().endsWith(".m4b");

    if (!isAudiobook) {
      setChapters([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setLoadingChapters(true);
      invoke<AudioChapter[]>("get_audio_chapters", { fileUrl: currentUrl })
        .then((chs) => {
          if (!cancelled) {
            setChapters(chs || []);
          }
        })
        .catch((err) => {
          console.warn("Failed to probe audio chapters:", err);
          if (!cancelled) setChapters([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingChapters(false);
        });
    }, 2500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [currentUrl, currentTrack?.id, currentTrack?.libraryType, currentTrack?.filename]);

  // Periodic progress persistence
  useEffect(() => {
    if (!currentTrack) return;
    const interval = setInterval(() => {
      if (audioRef.current && duration > 0) {
        updateWatchProgress({
          itemId: currentTrack.id,
          position: audioRef.current.currentTime,
          duration: duration,
          completed: audioRef.current.currentTime / duration > 0.9,
          lastWatchedAt: Date.now(),
        });
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [currentTrack?.id, duration]);

  // Synthetic chapters generator fallback (inspired by Storyleaf)
  const generateSyntheticChapters = (intervalMinutes = 15) => {
    if (!duration || duration <= 0) return;
    const intervalSec = intervalMinutes * 60;
    const count = Math.ceil(duration / intervalSec);
    const synth: AudioChapter[] = [];
    for (let i = 0; i < count; i++) {
      const start = i * intervalSec;
      const end = Math.min((i + 1) * intervalSec, duration);
      synth.push({
        id: i,
        start,
        end,
        title: `Chapter ${i + 1}`,
      });
    }
    setChapters(synth);
  };

  // Active chapter computation
  const activeChapterIndex = chapters.findIndex(
    (ch) => currentTime >= ch.start && (ch.end > ch.start ? currentTime < ch.end : true)
  );
  const activeChapter = activeChapterIndex >= 0 ? chapters[activeChapterIndex] : null;

  const handlePrevChapter = () => {
    if (chapters.length > 0) {
      if (activeChapterIndex > 0) {
        if (activeChapter && currentTime - activeChapter.start > 3) {
          handleSeek(activeChapter.start);
        } else {
          handleSeek(chapters[activeChapterIndex - 1].start);
        }
      } else if (activeChapter) {
        handleSeek(activeChapter.start);
      }
      return;
    }
    if (playlist.length > 1 && currentIndex > 0) {
      setCurrentIndex((i) => i - 1);
    }
  };

  const handleNextChapter = () => {
    if (chapters.length > 0) {
      if (activeChapterIndex >= 0 && activeChapterIndex < chapters.length - 1) {
        handleSeek(chapters[activeChapterIndex + 1].start);
      }
      return;
    }
    if (playlist.length > 1 && currentIndex < playlist.length - 1) {
      setCurrentIndex((i) => i + 1);
    }
  };

  const handleSkipTime = (deltaSeconds: number) => {
    if (!audioRef.current) return;
    const newPos = Math.max(0, Math.min(duration || Infinity, currentTime + deltaSeconds));
    handleSeek(newPos);
  };

  const handleSpeedChange = (speed: number) => {
    setPlaybackSpeed(speed);
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
    setShowSpeedMenu(false);
  };

  // Bookmarks for current track
  const currentTrackBookmarks = (currentTrack ? audioBookmarks?.[currentTrack.id] : []) || [];

  const handleSaveBookmark = () => {
    if (!currentTrack) return;
    const defaultTitle = activeChapter
      ? `${activeChapter.title} (${formatTime(currentTime)})`
      : `Bookmark at ${formatTime(currentTime)}`;
    addAudioBookmark({
      id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      itemId: currentTrack.id,
      timestamp: currentTime,
      title: newBookmarkTitle.trim() || defaultTitle,
      note: newBookmarkNote.trim() || undefined,
      createdAt: Date.now(),
    });
    setNewBookmarkTitle("");
    setNewBookmarkNote("");
    setShowAddBookmark(false);
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      attachWebAudio(audio);
      audio.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  const handleSeek = (seconds: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds;
      setCurrentTime(seconds);

      const ch = chaptersRef.current.find(
        (c) => seconds >= c.start && (c.end > c.start ? seconds < c.end : true)
      );
      const chIdx = ch ? chaptersRef.current.indexOf(ch) : -1;

      window.dispatchEvent(
        new CustomEvent("rcloneflix:whispersync-audio-tick", {
          detail: {
            currentTime: seconds,
            duration: audioRef.current.duration || 0,
            chapterIndex: chIdx >= 0 ? chIdx : currentIndex,
            chapterStart: ch ? ch.start : 0,
            chapterEnd: ch && ch.end > ch.start ? ch.end : (audioRef.current.duration || 0),
            chapterTitle: ch?.title || currentTrack?.title,
            playing: !audioRef.current.paused,
          },
        })
      );
    }
  };

  const playNextTrack = useCallback(() => {
    if (playlist.length === 0) return;
    if (repeatMode === "one" && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().then(() => setPlaying(true)).catch(() => {});
      return;
    }
    if (isShuffle && playlist.length > 1) {
      let nextIdx = Math.floor(Math.random() * playlist.length);
      if (nextIdx === currentIndex) {
        nextIdx = (currentIndex + 1) % playlist.length;
      }
      setCurrentIndex(nextIdx);
      return;
    }
    if (currentIndex < playlist.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else if (repeatMode === "all") {
      setCurrentIndex(0);
    }
  }, [playlist.length, repeatMode, isShuffle, currentIndex]);

  const playPrevTrack = useCallback(() => {
    if (audioRef.current && audioRef.current.currentTime > 4) {
      handleSeek(0);
      return;
    }
    if (currentIndex > 0) {
      setCurrentIndex((i) => i - 1);
    } else if (repeatMode === "all" && playlist.length > 0) {
      setCurrentIndex(playlist.length - 1);
    }
  }, [currentIndex, repeatMode, playlist.length]);

  // Synchronize Android Foreground MediaPlaybackService & Desktop/Web MediaSession API
  useEffect(() => {
    if (!currentTrack) return;
    const title = currentTrack.title || currentTrack.filename || "RcloneFlix";
    const artist = currentTrack.artist || currentTrack.author || "Unknown Artist";
    const album = currentTrack.album || "";
    const artUrl = posterSrc || currentTrack.posterUrl || "";

    try {
      (window as any).AndroidBridge?.updateMediaSession?.(
        title,
        artist,
        album,
        duration || currentTrack.duration || 0,
        currentTime || 0,
        playing,
        artUrl
      );
    } catch {}

    // On Android, MediaPlaybackService owns the native MediaSession via AndroidBridge.
    // Activating navigator.mediaSession inside Android WebView registers a competing
    // Chromium MediaSession that conflicts with MediaPlaybackService and AudioFocus.
    if (typeof navigator !== "undefined" && "mediaSession" in navigator && !(window as any).AndroidBridge) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title,
          artist,
          album,
          artwork: artUrl ? [{ src: artUrl, sizes: "512x512", type: "image/jpeg" }] : [],
        });
        navigator.mediaSession.playbackState = playing ? "playing" : "paused";
        if (duration > 0 && typeof (navigator.mediaSession as any).setPositionState === "function") {
          (navigator.mediaSession as any).setPositionState({
            duration: Math.max(0, duration),
            playbackRate: playbackSpeed,
            position: Math.max(0, Math.min(duration, currentTime)),
          });
        }
      } catch {}
    }
  }, [currentTrack?.id, currentTrack?.title, currentTrack?.artist, currentTrack?.album, posterSrc, playing, duration, playbackSpeed]);

  // Broadcast live audio state snapshot for MusicSkinShell
  useEffect(() => {
    const sourceLabel =
      activeSourceType === "local" || isLocal
        ? "Local Direct"
        : activeSourceType === "dropmb"
        ? "DropMB Edge"
        : activeRemoteName || "Cloud Stream";
    const detail = {
      playing,
      loading,
      currentTime,
      duration,
      volume,
      muted,
      playbackSpeed,
      sleepTimerMode,
      sleepTimerRemainingSec,
      currentIndex,
      sourceLabel,
    };
    (window as any).__rcloneflix_audio_state = detail;
    window.dispatchEvent(new CustomEvent("rcloneflix:audio-state-sync", { detail }));
  }, [
    playing,
    loading,
    currentTime,
    duration,
    volume,
    muted,
    playbackSpeed,
    sleepTimerMode,
    sleepTimerRemainingSec,
    currentIndex,
    activeSourceType,
    activeRemoteName,
    isLocal,
  ]);

  useEffect(() => {
    (window as any).__rcloneflix_media_control = (action: string, val?: any) => {
      const audio = audioRef.current;
      if (action === "jump" && typeof val === "number") {
        if (val >= 0 && val < playlist.length) {
          setCurrentIndex(val);
        }
        return;
      }
      if (action === "volume" && typeof val === "number") {
        const clamped = Math.max(0, Math.min(1, val));
        setVolume(clamped);
        setMuted(clamped === 0);
        applyVolume(clamped, clamped === 0);
        return;
      }
      if (action === "mute") {
        const nextMuted = !muted;
        setMuted(nextMuted);
        applyVolume(volume, nextMuted);
        return;
      }
      if (action === "speed" && typeof val === "number") {
        setPlaybackSpeed(val);
        if (audio) audio.playbackRate = val;
        return;
      }
      if (action === "sleep" && val !== undefined) {
        setSleepTimerMode(val);
        return;
      }
      if (!audio) return;
      if (action === "play") {
        audio.play().then(() => setPlaying(true)).catch(() => {});
      } else if (action === "pause") {
        audio.pause();
        setPlaying(false);
      } else if (action === "toggle") {
        if (audio.paused) {
          audio.play().then(() => setPlaying(true)).catch(() => {});
        } else {
          audio.pause();
          setPlaying(false);
        }
      } else if (action === "next") {
        playNextTrack();
      } else if (action === "prev") {
        playPrevTrack();
      } else if (action === "seek" && typeof val === "number") {
        handleSeek(val);
      } else if (action === "stop") {
        audio.pause();
        setPlaying(false);
        onClose();
      }
    };

    if (typeof navigator !== "undefined" && "mediaSession" in navigator && !(window as any).AndroidBridge) {
      try {
        navigator.mediaSession.setActionHandler("play", () => (window as any).__rcloneflix_media_control?.("play"));
        navigator.mediaSession.setActionHandler("pause", () => (window as any).__rcloneflix_media_control?.("pause"));
        navigator.mediaSession.setActionHandler("nexttrack", () => (window as any).__rcloneflix_media_control?.("next"));
        navigator.mediaSession.setActionHandler("previoustrack", () => (window as any).__rcloneflix_media_control?.("prev"));
        navigator.mediaSession.setActionHandler("seekto", (details) => {
          if (typeof details.seekTime === "number") {
            (window as any).__rcloneflix_media_control?.("seek", details.seekTime);
          }
        });
      } catch {}
    }

    const handleMediaControlEvent = (e: any) => {
      const { action, value } = e.detail || {};
      (window as any).__rcloneflix_media_control?.(action, value);
    };
    window.addEventListener("rcloneflix:media-control", handleMediaControlEvent);

    return () => {
      delete (window as any).__rcloneflix_media_control;
      window.removeEventListener("rcloneflix:media-control", handleMediaControlEvent);
    };
  }, [playNextTrack, playPrevTrack, onClose, playlist.length, muted, volume, applyVolume]);

  const syncPageToAudio = useCallback(() => {
    let intraRatio = 0;
    if (activeChapter && activeChapter.end > activeChapter.start) {
      intraRatio = Math.max(0, Math.min(1, (currentTime - activeChapter.start) / (activeChapter.end - activeChapter.start)));
    } else if (duration > 0) {
      intraRatio = Math.max(0, Math.min(1, currentTime / duration));
    }

    window.dispatchEvent(
      new CustomEvent("rcloneflix:whispersync-seek", {
        detail: {
          chapterIndex: activeChapterIndex >= 0 ? activeChapterIndex : currentIndex,
          chapterTitle: activeChapter?.title || currentTrack?.title,
          intraRatio,
        },
      })
    );
  }, [activeChapter, currentTime, duration, activeChapterIndex, currentIndex, currentTrack?.title]);

  useEffect(() => {
    const onRequestSeek = () => {
      syncPageToAudio();
    };
    const onSeekDirect = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail?.time === "number") {
        handleSeek(detail.time);
      }
    };
    const onSeekRatio = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail?.ratio !== "number") return;

      const rLoc = lastReaderLocationRef.current;
      const targetTitle = detail.chapterTitle || rLoc?.tocTitle;
      const targetIndex = typeof detail.chapterIndex === "number" ? detail.chapterIndex : rLoc?.tocIndex;

      let matchedChapter: AudioChapter | null = null;
      let matchedTrackIdx = -1;

      // 1. Match audio chapter by title
      if (targetTitle && chapters.length > 0) {
        const cleanTarget = targetTitle.toLowerCase().replace(/[^\w\s]/g, "").trim();
        matchedChapter = chapters.find((c) => {
          const cleanCh = c.title.toLowerCase().replace(/[^\w\s]/g, "").trim();
          return cleanCh.includes(cleanTarget) || cleanTarget.includes(cleanCh);
        }) ?? null;
      }

      // 2. Match audio chapter by index
      if (!matchedChapter && typeof targetIndex === "number" && targetIndex >= 0 && chapters.length > 0) {
        if (chapters[targetIndex]) {
          matchedChapter = chapters[targetIndex];
        }
      }

      // 3. Match multi-track playlist by index
      if (!matchedChapter && typeof targetIndex === "number" && targetIndex >= 0 && playlist.length > 1) {
        if (playlist[targetIndex]) {
          matchedTrackIdx = targetIndex;
        }
      }

      if (matchedChapter) {
        const chDuration = matchedChapter.end > matchedChapter.start ? matchedChapter.end - matchedChapter.start : 0;
        const targetSeek = matchedChapter.start + detail.ratio * chDuration;
        handleSeek(targetSeek);
      } else if (matchedTrackIdx >= 0) {
        if (matchedTrackIdx !== currentIndex) {
          setCurrentIndex(matchedTrackIdx);
        }
        if (duration > 0) {
          handleSeek(detail.ratio * duration);
        }
      } else if (activeChapter && activeChapter.end > activeChapter.start) {
        handleSeek(activeChapter.start + detail.ratio * (activeChapter.end - activeChapter.start));
      } else if (duration > 0) {
        const totalCh = detail.totalChapters || rLoc?.tocCount;
        if (typeof targetIndex === "number" && targetIndex >= 0 && totalCh && totalCh > 0) {
          const overallRatio = (targetIndex + detail.ratio) / totalCh;
          handleSeek(Math.max(0, Math.min(duration, overallRatio * duration)));
        } else {
          handleSeek(Math.max(0, Math.min(duration, detail.ratio * duration)));
        }
      }

      if (audioRef.current && audioRef.current.paused) {
        audioRef.current.play().catch(() => {});
      }
    };

    window.addEventListener("rcloneflix:request-whispersync-audio-seek", onRequestSeek);
    window.addEventListener("rcloneflix:whispersync-seek-audio", onSeekDirect);
    window.addEventListener("rcloneflix:whispersync-seek-to-ratio", onSeekRatio);
    return () => {
      window.removeEventListener("rcloneflix:request-whispersync-audio-seek", onRequestSeek);
      window.removeEventListener("rcloneflix:whispersync-seek-audio", onSeekDirect);
      window.removeEventListener("rcloneflix:whispersync-seek-to-ratio", onSeekRatio);
    };
  }, [syncPageToAudio, activeChapter, duration, chapters, playlist, currentIndex]);

  const syncAudioToPage = useCallback(() => {
    const rLoc = lastReaderLocationRef.current;
    if (!rLoc) return;

    let targetChapter: AudioChapter | null = null;
    let targetIndex = -1;

    // 1. Try matching by tocTitle
    if (rLoc.tocTitle && chapters.length > 0) {
      const cleanReader = rLoc.tocTitle.toLowerCase().replace(/[^\w\s]/g, "").trim();
      targetChapter = chapters.find((c) => {
        const cleanCh = c.title.toLowerCase().replace(/[^\w\s]/g, "").trim();
        return cleanCh.includes(cleanReader) || cleanReader.includes(cleanCh);
      }) ?? null;
    }

    // 2. Try matching by tocIndex with chapters
    if (!targetChapter && typeof rLoc.tocIndex === "number" && rLoc.tocIndex >= 0 && chapters.length > 0) {
      if (chapters[rLoc.tocIndex]) {
        targetChapter = chapters[rLoc.tocIndex];
      }
    }

    // 3. Try matching by tocIndex with multi-track playlist
    if (!targetChapter && typeof rLoc.tocIndex === "number" && rLoc.tocIndex >= 0 && playlist.length > 1) {
      if (playlist[rLoc.tocIndex]) {
        targetIndex = rLoc.tocIndex;
      }
    }

    // Calculate intra-chapter ratio if available
    let ratio = 0;
    if (rLoc.displayedPage && rLoc.displayedTotal && rLoc.displayedTotal > 1) {
      ratio = Math.max(0, Math.min(1, (rLoc.displayedPage - 1) / (rLoc.displayedTotal - 1)));
    }

    if (targetChapter) {
      const chDuration = targetChapter.end > targetChapter.start ? targetChapter.end - targetChapter.start : 0;
      const targetSeek = targetChapter.start + ratio * chDuration;
      handleSeek(targetSeek);
    } else if (targetIndex >= 0 && targetIndex !== currentIndex) {
      setCurrentIndex(targetIndex);
    } else if (duration > 0) {
      if (typeof rLoc.tocIndex === "number" && rLoc.tocIndex >= 0 && rLoc.tocCount && rLoc.tocCount > 0) {
        const overallRatio = (rLoc.tocIndex + ratio) / rLoc.tocCount;
        handleSeek(Math.max(0, Math.min(duration, overallRatio * duration)));
      } else if (rLoc.displayedPage && rLoc.displayedTotal) {
        handleSeek(Math.max(0, Math.min(duration, ratio * duration)));
      }
    }
  }, [chapters, playlist, duration, currentIndex]);

  const handleVolumeChange = (vol: number) => {
    const effective = isLinuxDesktop ? Math.max(0, Math.min(1, vol)) : vol;
    setVolume(effective);
    setMuted(effective === 0);
    applyVolume(effective, effective === 0);
  };

  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return "0:00";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const progressPct = duration ? (currentTime / duration) * 100 : 0;

  if (!currentTrack) return null;

  if (isMusicSkinMode) {
    return <div className="hidden" aria-hidden="true" />;
  }

  return (
    <motion.div
      initial={{ y: 80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 80, opacity: 0 }}
      className="fixed bottom-0 left-0 right-0 z-40 bg-card/95 backdrop-blur-xl border-t border-white/10 shadow-2xl"
    >
      {isExpanded && (
        <div className="fixed inset-0 z-50 bg-void/95 backdrop-blur-3xl flex flex-col overflow-hidden select-none">
          {/* Dynamic Ambient Blurred Album Artwork Background */}
          {posterSrc && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-35">
              <img
                src={posterSrc}
                alt=""
                className="w-full h-full object-cover scale-150 blur-3xl saturate-150"
              />
              <div className="absolute inset-0 bg-gradient-to-b from-void/60 via-void/80 to-void" />
            </div>
          )}

          {/* Top Bar */}
          <div className="relative z-10 flex items-center justify-between px-6 pt-5 pb-3 border-b border-white/10">
            <button
              onClick={() => setAudioExpanded(false)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-semibold transition-colors"
            >
              <ChevronDown size={16} />
              <span>Minimize Player</span>
            </button>

            {/* View Switcher Pills (Now Playing | Up Next Queue | Synced Lyrics | Chapters) */}
            <div className="flex items-center gap-1.5 bg-black/40 p-1 rounded-xl border border-white/10">
              <button
                onClick={() => setExpandedTab("playing")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                  expandedTab === "playing" ? "bg-accent text-black" : "text-white/70 hover:text-white"
                }`}
              >
                <Disc size={13} />
                <span>Now Playing</span>
              </button>
              <button
                onClick={() => setExpandedTab("queue")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                  expandedTab === "queue" ? "bg-accent text-black" : "text-white/70 hover:text-white"
                }`}
              >
                <ListMusic size={13} />
                <span>Queue ({playlist.length})</span>
              </button>
              {!isAudiobookItem(currentTrack) && (
                <button
                  onClick={() => setExpandedTab("lyrics")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                    expandedTab === "lyrics" ? "bg-accent text-black" : "text-white/70 hover:text-white"
                  }`}
                >
                  <Mic2 size={13} />
                  <span>Lyrics</span>
                </button>
              )}
              {(chapters.length > 0 || isAudiobookItem(currentTrack)) && (
                <button
                  onClick={() => setExpandedTab("chapters")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                    expandedTab === "chapters" ? "bg-accent text-black" : "text-white/70 hover:text-white"
                  }`}
                >
                  <BookOpen size={13} />
                  <span>Chapters</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <FavoriteButton itemId={currentTrack.id} size="sm" />
              <AddToPlaylistButton items={currentTrack} size="sm" />
            </div>
          </div>

          {/* Main Content Body */}
          <div className="relative z-10 flex-1 overflow-y-auto px-6 py-6 flex flex-col items-center justify-center max-w-5xl mx-auto w-full">
            {expandedTab === "playing" && (
              <div className="flex flex-col md:flex-row items-center gap-8 w-full justify-center">
                {/* Large Album Artwork */}
                <div className="w-64 h-64 sm:w-80 sm:h-80 rounded-3xl bg-white/5 border border-white/15 shadow-2xl overflow-hidden flex items-center justify-center flex-shrink-0">
                  {posterSrc ? (
                    <img src={posterSrc} alt={currentTrack.title} className="w-full h-full object-cover" />
                  ) : (
                    <Disc size={96} className="text-accent animate-spin-slow" />
                  )}
                </div>

                {/* Track Info & Big Transport Controls */}
                <div className="flex-1 max-w-md w-full flex flex-col gap-5 text-center md:text-left">
                  <div>
                    <div className="flex items-center justify-center md:justify-start gap-2 mb-2">
                      {activeSourceType === "local" || isLocal ? (
                        <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                          Local Direct
                        </span>
                      ) : activeSourceType === "dropmb" ? (
                        <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                          DropMB Cloud Edge
                        </span>
                      ) : (
                        <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">
                          {activeRemoteName || "Cloud Stream"}
                        </span>
                      )}
                      {currentTrack.container && (
                        <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-white/10 text-white/70">
                          {currentTrack.container}
                        </span>
                      )}
                    </div>
                    <h2 className="text-2xl sm:text-3xl font-heading font-bold text-white leading-tight line-clamp-2">
                      {currentTrack.title}
                    </h2>
                    <p className="text-base text-accent font-medium mt-1 truncate">
                      {currentTrack.artist || currentTrack.author || "Unknown Artist"}
                    </p>
                    {currentTrack.album && (
                      <p className="text-xs text-white/60 mt-0.5 truncate">
                        {currentTrack.album} {currentTrack.year ? `• ${currentTrack.year}` : ""}
                      </p>
                    )}
                  </div>

                  {/* Full Scrubber */}
                  <div className="w-full flex flex-col gap-1.5">
                    <input
                      type="range"
                      min={0}
                      max={duration || 100}
                      value={currentTime}
                      onChange={(e) => handleSeek(parseFloat(e.target.value))}
                      className="w-full h-2 appearance-none rounded-full cursor-pointer bg-white/20"
                      style={{
                        background: `linear-gradient(to right, #E8A020 ${progressPct}%, rgba(255,255,255,0.2) ${progressPct}%)`,
                      }}
                    />
                    <div className="flex items-center justify-between text-xs font-mono text-white/60">
                      <span>{formatTime(currentTime)}</span>
                      <span>-{formatTime(Math.max(0, duration - currentTime))}</span>
                    </div>
                  </div>

                  {/* Transport Buttons */}
                  <div className="flex items-center justify-center md:justify-between gap-4">
                    <button
                      onClick={toggleAudioShuffle}
                      title={isShuffle ? "Shuffle On" : "Shuffle Off"}
                      className={`p-2.5 rounded-full transition-colors ${
                        isShuffle ? "bg-accent/20 text-accent" : "text-white/50 hover:text-white hover:bg-white/10"
                      }`}
                    >
                      <Shuffle size={18} />
                    </button>

                    <button
                      onClick={() => handleSkipTime(-15)}
                      title="Rewind 15s"
                      className="p-2.5 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                    >
                      <RotateCcw size={20} />
                    </button>

                    <button
                      onClick={playPrevTrack}
                      title="Previous Track"
                      className="p-2.5 rounded-full text-white hover:bg-white/10 transition-colors"
                    >
                      <SkipBack size={26} />
                    </button>

                    <button
                      onClick={togglePlay}
                      disabled={loading}
                      className="w-16 h-16 rounded-full bg-accent text-black flex items-center justify-center shadow-xl hover:scale-105 transition-transform"
                    >
                      {loading ? (
                        <Loader2 size={28} className="animate-spin text-black" />
                      ) : playing ? (
                        <Pause size={28} className="fill-black" />
                      ) : (
                        <Play size={28} className="fill-black ml-1" />
                      )}
                    </button>

                    <button
                      onClick={playNextTrack}
                      title="Next Track"
                      className="p-2.5 rounded-full text-white hover:bg-white/10 transition-colors"
                    >
                      <SkipForward size={26} />
                    </button>

                    <button
                      onClick={() => handleSkipTime(30)}
                      title="Fast-forward 30s"
                      className="p-2.5 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                    >
                      <RotateCw size={20} />
                    </button>

                    <button
                      onClick={cycleAudioRepeat}
                      title={`Repeat: ${repeatMode}`}
                      className={`p-2.5 rounded-full transition-colors ${
                        repeatMode !== "off" ? "bg-accent/20 text-accent" : "text-white/50 hover:text-white hover:bg-white/10"
                      }`}
                    >
                      {repeatMode === "one" ? <Repeat1 size={18} /> : <Repeat size={18} />}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {expandedTab === "queue" && (
              <div className="w-full max-w-2xl bg-black/40 border border-white/10 rounded-2xl p-4 max-h-[65vh] overflow-y-auto space-y-1.5">
                <div className="flex items-center justify-between px-2 pb-2 border-b border-white/10">
                  <span className="text-xs font-heading font-bold uppercase tracking-wider text-white/70">
                    Playing Queue ({playlist.length} Tracks)
                  </span>
                  <span className="text-xs text-accent">
                    Track {currentIndex + 1} of {playlist.length}
                  </span>
                </div>
                {playlist.map((track, idx) => {
                  const isCurrent = idx === currentIndex;
                  return (
                    <div
                      key={`${track.id}-${idx}`}
                      className={`flex items-center justify-between gap-3 p-2.5 rounded-xl border transition-colors ${
                        isCurrent
                          ? "bg-accent/15 border-accent/40 text-accent"
                          : "border-transparent hover:bg-white/5 text-white/85"
                      }`}
                    >
                      <button
                        onClick={() => setCurrentIndex(idx)}
                        className="flex items-center gap-3 min-w-0 flex-1 text-left"
                      >
                        <span className="w-6 text-xs font-mono text-center text-white/50">
                          {idx + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate">{track.title}</p>
                          <p className="text-xs text-white/50 truncate">
                            {track.artist || track.author || track.album || track.filename}
                          </p>
                        </div>
                      </button>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => reorderAudioQueue(idx, idx - 1)}
                          disabled={idx === 0}
                          className="p-1 rounded hover:bg-white/10 text-white/50 hover:text-white disabled:opacity-20"
                          title="Move Up"
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          onClick={() => reorderAudioQueue(idx, idx + 1)}
                          disabled={idx === playlist.length - 1}
                          className="p-1 rounded hover:bg-white/10 text-white/50 hover:text-white disabled:opacity-20"
                          title="Move Down"
                        >
                          <ArrowDown size={14} />
                        </button>
                        {playlist.length > 1 && (
                          <button
                            onClick={() => removeFromAudioQueue(idx)}
                            className="p-1 rounded hover:bg-red-500/20 text-white/50 hover:text-red-400"
                            title="Remove from Queue"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {expandedTab === "lyrics" && (
              <div className="w-full max-w-2xl bg-black/40 border border-white/10 rounded-2xl p-6 max-h-[65vh] overflow-y-auto text-center">
                {loadingLyrics ? (
                  <div className="py-16 flex flex-col items-center gap-3 text-white/60">
                    <Loader2 size={28} className="animate-spin text-accent" />
                    <span className="text-sm">Searching synced lyrics on LRCLIB…</span>
                  </div>
                ) : lyrics?.synced && lyrics.synced.length > 0 ? (
                  <div className="space-y-4 py-6">
                    {lyrics.synced.map((line, i) => {
                      const active = i === activeLyricIndex;
                      return (
                        <button
                          key={i}
                          onClick={() => handleSeek(line.time)}
                          className={`block w-full text-center transition-all duration-200 px-4 py-1 rounded-lg ${
                            active
                              ? "text-accent text-xl sm:text-2xl font-bold scale-105"
                              : "text-white/45 hover:text-white/80 text-base"
                          }`}
                        >
                          {line.text}
                        </button>
                      );
                    })}
                  </div>
                ) : lyrics?.plain ? (
                  <pre className="whitespace-pre-wrap font-body text-sm text-white/85 leading-relaxed">
                    {lyrics.plain}
                  </pre>
                ) : (
                  <div className="py-16 text-white/50 text-sm">
                    No synced lyrics found for "{currentTrack.title}".
                  </div>
                )}
              </div>
            )}

            {expandedTab === "chapters" && (
              <div className="w-full max-w-2xl bg-black/40 border border-white/10 rounded-2xl p-4 max-h-[65vh] overflow-y-auto space-y-1.5">
                {chapters.length > 0 ? (
                  chapters.map((ch, idx) => {
                    const isActive = idx === activeChapterIndex;
                    return (
                      <button
                        key={ch.id ?? idx}
                        onClick={() => handleSeek(ch.start)}
                        className={`w-full text-left p-3 rounded-xl text-xs flex items-center justify-between ${
                          isActive ? "bg-accent/20 text-accent font-bold" : "hover:bg-white/5 text-white/80"
                        }`}
                      >
                        <span>{idx + 1}. {ch.title}</span>
                        <span className="font-mono">{formatTime(ch.start)}</span>
                      </button>
                    );
                  })
                ) : (
                  <div className="py-12 text-center">
                    <p className="text-sm text-white/70 mb-3">No embedded chapters found.</p>
                    <button
                      onClick={() => generateSyntheticChapters(15)}
                      className="px-4 py-2 rounded-xl bg-accent text-black text-xs font-bold"
                    >
                      Generate 15-Min Chapters
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between gap-6">
        {/* Track Info */}
        <div
          onClick={() => setMusicSkinMode(true)}
          className="flex items-center gap-4 min-w-0 w-64 cursor-pointer group"
          title="Switch to Compact Music Player Skin (Plexamp / Winamp Mode)"
        >
          <div className="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center overflow-hidden flex-shrink-0 border border-white/10 relative">
            {posterSrc ? (
              <img src={posterSrc} alt={currentTrack.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
            ) : (
              <Disc size={24} className="text-accent animate-spin-slow" />
            )}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
              <ChevronUp size={18} className="text-white" />
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="text-sm font-heading font-semibold text-white truncate group-hover:text-accent transition-colors">{currentTrack.title}</p>
              {activeSourceType === "local" || isLocal ? (
                <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex-shrink-0">
                  Local
                </span>
              ) : activeSourceType === "dropmb" ? (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                    DropMB Cloud
                  </span>
                  {dropmbShareUrl && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(dropmbShareUrl);
                        useToastStore.getState().addToast("DropMB share link copied to clipboard!", "success");
                      }}
                      title={`Copy DropMB share link: ${dropmbShareUrl}`}
                      className="p-1 rounded hover:bg-white/10 text-cyan-400/80 hover:text-cyan-300 transition-colors"
                    >
                      <Share2 size={11} />
                    </button>
                  )}
                </div>
              ) : activeRemoteName ? (
                <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.2 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 flex-shrink-0">
                  {activeRemoteName}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-subtle font-body truncate">
              {currentTrack.author || currentTrack.artist || currentTrack.album || "Unknown Artist"}
            </p>
          </div>
        </div>

        {/* Center Controls & Seek Bar */}
        <div className="flex-1 max-w-xl flex flex-col items-center gap-1">
          {error ? (
            <span className="text-xs text-red-400">{error}</span>
          ) : (
            <>
              <div className="flex items-center gap-3">
                {/* Shuffle */}
                <button
                  onClick={toggleAudioShuffle}
                  title={isShuffle ? "Shuffle On" : "Shuffle Off"}
                  className={`p-1.5 rounded-full transition-colors ${
                    isShuffle ? "text-accent bg-accent/20" : "text-white/40 hover:text-white"
                  }`}
                >
                  <Shuffle size={14} />
                </button>

                {/* Previous Chapter button (if chapters or multi-track exist) */}
                {(chapters.length > 0 || playlist.length > 1) && (
                  <button
                    onClick={handlePrevChapter}
                    title="Previous Chapter"
                    className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors flex items-center gap-0.5"
                  >
                    <SkipBack size={13} />
                    <span className="text-[10px] font-bold">Ch</span>
                  </button>
                )}

                {/* Rewind 15s */}
                <button
                  onClick={() => handleSkipTime(-15)}
                  title="Rewind 15s"
                  className="p-1.5 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-colors"
                >
                  <RotateCcw size={15} />
                </button>

                {/* Previous Track in playlist */}
                <button
                  onClick={playPrevTrack}
                  disabled={currentIndex === 0 && repeatMode !== "all"}
                  title="Previous Track"
                  className="text-white/60 hover:text-white disabled:opacity-30 transition-colors"
                >
                  <SkipBack size={18} />
                </button>

                {/* Play / Pause button */}
                <button
                  onClick={togglePlay}
                  disabled={loading}
                  className="w-9 h-9 rounded-full bg-accent text-black flex items-center justify-center hover:scale-105 transition-transform"
                >
                  {loading ? (
                    <Loader2 size={18} className="animate-spin text-black" />
                  ) : playing ? (
                    <Pause size={18} className="fill-black" />
                  ) : (
                    <Play size={18} className="fill-black ml-0.5" />
                  )}
                </button>

                {/* Next Track in playlist */}
                <button
                  onClick={playNextTrack}
                  disabled={currentIndex === playlist.length - 1 && repeatMode !== "all" && !isShuffle}
                  title="Next Track"
                  className="text-white/60 hover:text-white disabled:opacity-30 transition-colors"
                >
                  <SkipForward size={18} />
                </button>

                {/* Fast-Forward 30s */}
                <button
                  onClick={() => handleSkipTime(30)}
                  title="Fast-forward 30s"
                  className="p-1.5 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-colors"
                >
                  <RotateCw size={15} />
                </button>

                {/* Next Chapter button (if chapters or multi-track exist) */}
                {(chapters.length > 0 || playlist.length > 1) && (
                  <button
                    onClick={handleNextChapter}
                    title="Next Chapter"
                    className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors flex items-center gap-0.5"
                  >
                    <span className="text-[10px] font-bold">Ch</span>
                    <SkipForward size={13} />
                  </button>
                )}

                {/* Repeat */}
                <button
                  onClick={cycleAudioRepeat}
                  title={`Repeat: ${repeatMode}`}
                  className={`p-1.5 rounded-full transition-colors ${
                    repeatMode !== "off" ? "text-accent bg-accent/20" : "text-white/40 hover:text-white"
                  }`}
                >
                  {repeatMode === "one" ? <Repeat1 size={14} /> : <Repeat size={14} />}
                </button>
              </div>

              {/* Seek Bar with Chapter Title Subtitle */}
              <div className="w-full flex flex-col gap-0.5">
                <div className="w-full flex items-center gap-3">
                  <span className="text-[11px] font-mono text-white/50">{formatTime(currentTime)}</span>
                  <input
                    type="range"
                    min={0}
                    max={duration || 100}
                    value={currentTime}
                    onChange={(e) => handleSeek(parseFloat(e.target.value))}
                    className="flex-1 h-1 appearance-none rounded-full cursor-pointer bg-white/20"
                    style={{
                      background: `linear-gradient(to right, #E8A020 ${progressPct}%, rgba(255,255,255,0.2) ${progressPct}%)`,
                    }}
                  />
                  <span className="text-[11px] font-mono text-white/50">{formatTime(duration)}</span>
                </div>
                {(activeChapter || playlist.length > 1) && (
                  <div className="flex items-center justify-between text-[10px] text-accent/80 px-8 truncate">
                    <span className="truncate font-semibold">
                      {activeChapter?.title || currentTrack?.title || `Track ${currentIndex + 1}`}
                    </span>
                    {activeChapter && (
                      <span className="font-mono flex-shrink-0 ml-2 text-white/50">
                        {formatTime(currentTime - activeChapter.start)} / {formatTime(activeChapter.end - activeChapter.start)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right Volume & Actions */}
        <div className="flex items-center gap-3 w-80 justify-end">
          <SpectrumCanvas
            className="hidden md:block w-12 h-[18px] flex-shrink-0 opacity-90"
            barCount={14}
            isPlaying={playing}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleVolumeChange(muted ? (volume > 0 ? volume : 1.0) : 0)}
              className="text-white/70 hover:text-white"
            >
              {muted || volume === 0 ? (
                <VolumeX size={16} />
              ) : (
                <Volume2 size={16} />
              )}
            </button>
            <div className="flex items-center gap-1.5">
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={muted ? 0 : volume}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                className="w-20 h-1 appearance-none bg-white/20 rounded-full cursor-pointer accent-accent"
                title={`Volume: ${Math.round((muted ? 0 : volume) * 100)}%`}
              />
              <span className="text-[10px] font-mono min-w-[32px] text-right text-white/60">
                {Math.round((muted ? 0 : volume) * 100)}%
              </span>
            </div>
          </div>
          {currentTrack && (
            <div className="flex items-center gap-1.5">
              {/* Playback Speed selector */}
              <div className="relative">
                <button
                  onClick={() => setShowSpeedMenu((s) => !s)}
                  title="Playback Speed"
                  className={`px-1.5 py-1 rounded text-[11px] font-mono font-bold transition-colors border ${
                    playbackSpeed !== 1.0
                      ? "border-accent bg-accent/20 text-accent"
                      : "border-white/10 hover:bg-white/10 text-white/70 hover:text-white"
                  }`}
                >
                  {playbackSpeed}×
                </button>
                {showSpeedMenu && (
                  <>
                    <div className="fixed inset-0 z-50" onClick={() => setShowSpeedMenu(false)} />
                    <div className="absolute bottom-10 right-0 z-50 bg-panel border border-border rounded-xl shadow-card-hover py-1 w-28">
                      <div className="px-3 py-1 text-[10px] font-semibold text-subtle border-b border-border">
                        Speed
                      </div>
                      {speedOptions.map((spd) => (
                        <button
                          key={spd}
                          onClick={() => handleSpeedChange(spd)}
                          className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between ${
                            playbackSpeed === spd
                              ? "text-accent font-semibold bg-accent/10"
                              : "text-text hover:bg-muted"
                          }`}
                        >
                          <span>{spd}×</span>
                          {playbackSpeed === spd && <Check size={12} className="text-accent" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* 10-Band Equalizer & Silence Skipper */}
              <div className="relative">
                <button
                  onClick={() => setShowEqModal((s) => !s)}
                  title="10-Band Equalizer & Silence Skipper"
                  className={`p-1.5 rounded-lg border transition-colors relative ${
                    showEqModal || eqGains.some((g) => g !== 0) || skipSilence
                      ? "border-accent bg-accent/20 text-accent font-semibold"
                      : "border-white/10 hover:bg-white/10 text-white/60 hover:text-white"
                  }`}
                >
                  <SlidersHorizontal size={14} />
                  {(eqGains.some((g) => g !== 0) || skipSilence) && (
                    <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-accent" />
                  )}
                </button>

                {showEqModal && (
                  <>
                    <div className="fixed inset-0 z-50" onClick={() => setShowEqModal(false)} />
                    <div className="absolute bottom-11 right-0 z-50 bg-panel/95 backdrop-blur-xl border border-border rounded-2xl shadow-2xl p-4 w-80 text-white font-body space-y-4">
                      <div className="flex items-center justify-between border-b border-border pb-2.5">
                        <div className="flex items-center gap-2">
                          <SlidersHorizontal size={15} className="text-accent" />
                          <span className="text-xs font-bold tracking-wide">10-Band Equalizer</span>
                        </div>
                        <button
                          onClick={() => {
                            setEqGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
                            setEqPreset("flat");
                          }}
                          className="text-[10px] text-subtle hover:text-white transition-colors"
                        >
                          Reset
                        </button>
                      </div>

                      {/* Preset selector */}
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-subtle font-medium">Preset</span>
                        <select
                          value={eqPreset}
                          onChange={(e) => {
                            const val = e.target.value;
                            setEqPreset(val);
                            if (EQ_PRESETS[val]) {
                              setEqGains([...EQ_PRESETS[val].gains]);
                            }
                          }}
                          className="input-field text-xs py-1 px-2 rounded-lg bg-surface border border-border"
                        >
                          {Object.entries(EQ_PRESETS).map(([key, p]) => (
                            <option key={key} value={key}>
                              {p.label}
                            </option>
                          ))}
                          {eqPreset === "custom" && <option value="custom">Custom</option>}
                        </select>
                      </div>

                      {/* Silence Skipper Switch */}
                      <div className="flex items-center justify-between p-2 rounded-xl bg-surface/50 border border-border">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <Zap size={13} className={skipSilence ? "text-accent" : "text-subtle"} />
                            <span className="text-xs font-semibold">Skip Silence</span>
                          </div>
                          <span className="text-[10px] text-subtle block">Auto-skip quiet pauses in speech</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSkipSilence((s) => !s)}
                          className={`w-9 h-5 rounded-full transition-colors relative ${
                            skipSilence ? "bg-accent" : "bg-white/20"
                          }`}
                        >
                          <div
                            className={`w-3.5 h-3.5 rounded-full bg-white absolute top-0.5 transition-transform ${
                              skipSilence ? "translate-x-4" : "translate-x-1"
                            }`}
                          />
                        </button>
                      </div>

                      {/* 10 Sliders */}
                      <div className="space-y-1.5 pt-1">
                        <div className="flex items-center justify-between text-[10px] text-subtle font-mono px-1 pb-1">
                          <span>Band</span>
                          <span>Gain (-12 to +12 dB)</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                          {EQ_FREQUENCIES.map((freq, idx) => {
                            const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
                            const gain = eqGains[idx] ?? 0;
                            return (
                              <div key={freq} className="flex items-center gap-1.5 text-[10px] font-mono">
                                <span className="w-6 text-subtle text-right">{label}</span>
                                <input
                                  type="range"
                                  min={-12}
                                  max={12}
                                  step={1}
                                  value={gain}
                                  onChange={(e) => {
                                    const next = [...eqGains];
                                    next[idx] = parseFloat(e.target.value);
                                    setEqGains(next);
                                    setEqPreset("custom");
                                  }}
                                  className="flex-1 h-1 appearance-none bg-white/20 rounded-full cursor-pointer accent-accent"
                                />
                                <span className={`w-7 text-right ${gain > 0 ? "text-accent font-semibold" : gain < 0 ? "text-rose-400" : "text-subtle"}`}>
                                  {gain > 0 ? `+${gain}` : `${gain}`}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Chapters & Bookmarks Drawer Toggle */}
              <button
                onClick={() => setShowChapterDrawer((s) => !s)}
                title="Chapters & Bookmarks"
                className={`p-1.5 rounded-lg border transition-colors relative ${
                  showChapterDrawer
                    ? "border-accent bg-accent/20 text-accent font-semibold"
                    : chapters.length > 0 || currentTrackBookmarks.length > 0
                    ? "border-white/20 bg-white/5 text-white hover:bg-white/10"
                    : "border-white/10 hover:bg-white/10 text-white/60 hover:text-white"
                }`}
              >
                <BookOpen size={14} />
                {(chapters.length > 0 || currentTrackBookmarks.length > 0) && (
                  <span className="absolute -top-1.5 -right-1.5 px-1 py-0.2 rounded-full bg-accent text-void text-[9px] font-bold">
                    {chapters.length > 0 ? chapters.length : currentTrackBookmarks.length}
                  </span>
                )}
              </button>

              {isEpubReaderActive ? (
                <div className="flex items-center gap-1 bg-white/5 p-0.5 rounded-lg border border-accent/30">
                  <button
                    onClick={syncPageToAudio}
                    title="Jump book page to current audio playback position"
                    className="flex items-center gap-1 px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent font-semibold text-xs transition-colors"
                  >
                    <BookOpen size={12} />
                    <span className="hidden sm:inline">Sync Page</span>
                  </button>
                  <button
                    onClick={syncAudioToPage}
                    title="Jump audio playback to current book reading position"
                    className="flex items-center gap-1 px-2 py-1 rounded hover:bg-white/10 text-white/80 hover:text-white font-semibold text-xs transition-colors"
                  >
                    <Headphones size={12} />
                    <span className="hidden sm:inline">Sync Audio</span>
                  </button>
                </div>
              ) : matchingEbook ? (
                <>
                  <button
                    onClick={() => {
                      let intraRatio = 0;
                      if (activeChapter && activeChapter.end > activeChapter.start) {
                        intraRatio = Math.max(0, Math.min(1, (currentTime - activeChapter.start) / (activeChapter.end - activeChapter.start)));
                      } else if (duration > 0) {
                        intraRatio = Math.max(0, Math.min(1, currentTime / duration));
                      }
                      navigate("/play/epub", {
                        state: {
                          item: matchingEbook,
                          startChapterIndex: activeChapterIndex >= 0 ? activeChapterIndex : currentIndex,
                          startChapterTitle: activeChapter?.title || currentTrack?.title,
                          startPercentage: duration > 0 ? currentTime / duration : undefined,
                          intraRatio,
                        },
                      });
                    }}
                    title={`Read along with "${matchingEbook.title}" (Whispersync)`}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent/20 hover:bg-accent/30 text-accent font-semibold text-xs border border-accent/40 transition-all shadow-sm"
                  >
                    <BookOpen size={13} />
                    <span className="hidden sm:inline">Read Along</span>
                  </button>
                  <button
                    onClick={() => setShowPairModal(true)}
                    title={`Paired with "${matchingEbook.title}" (Click to change companion book)`}
                    className="p-1.5 rounded-lg border border-accent/30 bg-accent/10 hover:bg-accent/20 text-accent text-xs transition-colors"
                  >
                    <BookOpen size={13} />
                  </button>
                </>
              ) : isAudiobookItem(currentTrack) ? (
                <button
                  onClick={() => setShowPairModal(true)}
                  title="Pair with companion ebook (Whispersync)"
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 hover:bg-white/10 text-white/70 hover:text-white text-xs transition-colors"
                >
                  <BookOpen size={13} />
                  <span className="hidden sm:inline">Pair Book</span>
                </button>
              ) : null}

              <FavoriteButton itemId={currentTrack.id} size="sm" />
              <AddToPlaylistButton items={currentTrack} size="sm" />
              <button
                onClick={() => downloadSingleItem(currentTrack)}
                title={`Download "${currentTrack.title}"`}
                className="p-1.5 rounded-lg border border-white/10 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
              >
                <Download size={14} />
              </button>
              <button
                onClick={() => setShowFixMatch(true)}
                title={`Edit / Fix Metadata for "${currentTrack.title}"`}
                className="p-1.5 rounded-lg border border-white/10 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
              >
                <Edit3 size={14} />
              </button>
              <button
                onClick={() => setShowCastModal(true)}
                title={castStatus.connected ? `Casting to ${castDevice?.name || "device"}` : "Cast to Chromecast / Smart Speaker"}
                className={`p-1.5 rounded-lg border transition-colors ${
                  castStatus.connected
                    ? "border-accent bg-accent/20 text-accent font-semibold"
                    : "border-white/10 hover:bg-white/10 text-white/60 hover:text-white"
                }`}
              >
                <Cast size={14} />
              </button>

              {/* Sleep timer */}
              <div className="relative">
                <button
                  onClick={() => setShowSleepMenu((s) => !s)}
                  title={
                    sleepTimerMode !== "off"
                      ? `Sleep timer: ${
                          sleepTimerRemainingSec
                            ? `${Math.ceil(sleepTimerRemainingSec / 60)}m`
                            : sleepTimerMode === "end_of_chapter"
                            ? "End of chapter"
                            : "End of track"
                        }`
                      : "Sleep timer"
                  }
                  className={`p-1.5 rounded-lg border transition-colors relative ${
                    sleepTimerMode !== "off"
                      ? "border-accent bg-accent/20 text-accent font-semibold"
                      : "border-white/10 hover:bg-white/10 text-white/60 hover:text-white"
                  }`}
                >
                  <Moon size={14} />
                  {sleepTimerRemainingSec && (
                    <span className="absolute -top-1.5 -right-1.5 px-1 py-0.2 rounded-full bg-accent text-void text-[9px] font-bold">
                      {Math.ceil(sleepTimerRemainingSec / 60)}m
                    </span>
                  )}
                  {sleepTimerMode === "end_of_track" && (
                    <span className="absolute -top-1.5 -right-1.5 px-1 py-0.2 rounded-full bg-accent text-void text-[9px] font-bold">
                      1
                    </span>
                  )}
                  {sleepTimerMode === "end_of_chapter" && (
                    <span className="absolute -top-1.5 -right-1.5 px-1 py-0.2 rounded-full bg-accent text-void text-[9px] font-bold">
                      Ch
                    </span>
                  )}
                </button>

                {showSleepMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-50"
                      onClick={() => setShowSleepMenu(false)}
                    />
                    <div className="absolute bottom-10 right-0 z-50 bg-panel border border-border rounded-xl shadow-card-hover py-1 w-48">
                      <div className="px-3 py-1.5 text-xs font-semibold text-subtle border-b border-border">
                        Sleep Timer
                      </div>
                      {[
                        { label: "Off", val: "off" },
                        { label: "15 minutes", val: 15 },
                        { label: "30 minutes", val: 30 },
                        { label: "45 minutes", val: 45 },
                        { label: "60 minutes", val: 60 },
                        ...(chapters.length > 0
                          ? [{ label: "End of current chapter", val: "end_of_chapter" }]
                          : []),
                        { label: "End of track", val: "end_of_track" },
                      ].map((opt) => (
                        <button
                          key={String(opt.val)}
                          onClick={() => {
                            setSleepTimerMode(opt.val as any);
                            setShowSleepMenu(false);
                          }}
                          className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between ${
                            sleepTimerMode === opt.val
                              ? "text-accent font-semibold bg-accent/10"
                              : "text-text hover:bg-muted"
                          }`}
                        >
                          <span>{opt.label}</span>
                          {sleepTimerMode === opt.val && <span className="text-accent">✓</span>}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          <button
            onClick={() => setMusicSkinMode(true)}
            title="Switch to Compact Music Player Skin (Plexamp / Winamp Mode)"
            className="p-1.5 rounded-lg border border-white/10 hover:bg-white/10 text-white/60 hover:text-white transition-colors ml-1"
          >
            <Maximize2 size={15} />
          </button>
          <button
            onClick={() => {
              if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
              }
              if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.src = "";
              }
              if (prefetchAudioRef.current) {
                prefetchAudioRef.current.pause();
                prefetchAudioRef.current.src = "";
              }
              onClose();
            }}
            className="p-1.5 rounded-lg hover:bg-white/10 text-white/50 hover:text-white transition-colors ml-1"
            title="Close audio player"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Chapters & Bookmarks Floating Drawer */}
      {showChapterDrawer && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-xs"
            onClick={() => setShowChapterDrawer(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: 15, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 15, scale: 0.98 }}
            className="absolute bottom-full right-6 mb-3 w-[420px] max-h-[520px] bg-panel/95 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden z-50 text-text"
          >
            {/* Header Tabs */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card/60">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setDrawerTab("chapters")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    drawerTab === "chapters"
                      ? "bg-accent/20 text-accent border border-accent/40"
                      : "text-subtle hover:text-text hover:bg-white/5"
                  }`}
                >
                  <BookOpen size={14} />
                  <span>Chapters</span>
                  {(chapters.length > 0 ? chapters.length : playlist.length > 1 ? playlist.length : 0) > 0 && (
                    <span className="ml-1 px-1.5 py-0.2 rounded-full bg-accent/30 text-accent text-[10px]">
                      {chapters.length > 0 ? chapters.length : playlist.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setDrawerTab("bookmarks")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    drawerTab === "bookmarks"
                      ? "bg-accent/20 text-accent border border-accent/40"
                      : "text-subtle hover:text-text hover:bg-white/5"
                  }`}
                >
                  <Bookmark size={14} />
                  <span>Bookmarks</span>
                  {currentTrackBookmarks.length > 0 && (
                    <span className="ml-1 px-1.5 py-0.2 rounded-full bg-accent/30 text-accent text-[10px]">
                      {currentTrackBookmarks.length}
                    </span>
                  )}
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                {isEpubReaderActive ? (
                  <div className="flex items-center gap-1 bg-white/5 p-0.5 rounded-lg border border-accent/30">
                    <button
                      onClick={syncPageToAudio}
                      title="Jump book page to current audio playback position"
                      className="px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent font-semibold text-xs transition-colors flex items-center gap-1"
                    >
                      <BookOpen size={12} />
                      <span>Sync Page</span>
                    </button>
                    <button
                      onClick={syncAudioToPage}
                      title="Jump audio playback to current book reading position"
                      className="px-2 py-1 rounded hover:bg-white/10 text-subtle hover:text-white font-semibold text-xs transition-colors flex items-center gap-1"
                    >
                      <Headphones size={12} />
                      <span>Sync Audio</span>
                    </button>
                  </div>
                ) : matchingEbook ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        let intraRatio = 0;
                        if (activeChapter && activeChapter.end > activeChapter.start) {
                          intraRatio = Math.max(0, Math.min(1, (currentTime - activeChapter.start) / (activeChapter.end - activeChapter.start)));
                        } else if (duration > 0) {
                          intraRatio = Math.max(0, Math.min(1, currentTime / duration));
                        }
                        navigate("/play/epub", {
                          state: {
                            item: matchingEbook,
                            startChapterIndex: activeChapterIndex >= 0 ? activeChapterIndex : currentIndex,
                            startChapterTitle: activeChapter?.title || currentTrack?.title,
                            startPercentage: duration > 0 ? currentTime / duration : undefined,
                            intraRatio,
                          },
                        });
                      }}
                      title={`Read along with "${matchingEbook.title}" (Whispersync)`}
                      className="px-2.5 py-1 rounded-lg bg-accent/20 hover:bg-accent/30 text-accent font-semibold text-xs border border-accent/40 transition-all flex items-center gap-1 shadow-sm"
                    >
                      <BookOpen size={12} />
                      <span>Read Along</span>
                    </button>
                    <button
                      onClick={() => setShowPairModal(true)}
                      title={`Paired with "${matchingEbook.title}" - click to change`}
                      className="px-2 py-1 rounded-lg hover:bg-white/10 text-subtle hover:text-accent transition-colors flex items-center gap-1 text-xs border border-white/5"
                    >
                      <span>Change Pair</span>
                    </button>
                  </div>
                ) : isAudiobookItem(currentTrack) ? (
                  <button
                    onClick={() => setShowPairModal(true)}
                    title="Pair with companion ebook (Whispersync)"
                    className="px-2.5 py-1 rounded-lg hover:bg-white/10 text-subtle hover:text-accent transition-colors flex items-center gap-1 text-xs font-medium border border-white/5 hover:border-accent/30"
                  >
                    <BookOpen size={12} />
                    <span>Pair Book</span>
                  </button>
                ) : null}
                <button
                  onClick={() => setShowFixMatch(true)}
                  title="Edit / Fix Book Metadata"
                  className="px-2.5 py-1 rounded-lg hover:bg-white/10 text-subtle hover:text-accent transition-colors flex items-center gap-1 text-xs font-medium border border-white/5 hover:border-accent/30"
                >
                  <Edit3 size={12} />
                  <span>Edit Match</span>
                </button>
                <button
                  onClick={() => setShowChapterDrawer(false)}
                  className="p-1 rounded-lg hover:bg-white/10 text-subtle hover:text-text transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Tab Body */}
            <div className="flex-1 overflow-y-auto p-3 max-h-[440px]">
              {drawerTab === "chapters" ? (
                <div>
                  {loadingChapters ? (
                    <div className="py-12 flex flex-col items-center justify-center gap-2 text-subtle">
                      <Loader2 size={24} className="animate-spin text-accent" />
                      <span className="text-xs">Extracting chapters from audio...</span>
                    </div>
                  ) : chapters.length > 0 ? (
                    <div className="space-y-1">
                      {chapters.map((ch, idx) => {
                        const isActive = idx === activeChapterIndex;
                        const chDuration = ch.end > ch.start ? ch.end - ch.start : 0;
                        return (
                          <button
                            key={ch.id ?? idx}
                            onClick={() => handleSeek(ch.start)}
                            className={`w-full text-left p-2.5 rounded-xl text-xs transition-colors flex items-center justify-between gap-3 group ${
                              isActive
                                ? "bg-accent/15 border border-accent/30 text-accent font-semibold shadow-xs"
                                : "hover:bg-white/5 text-text border border-transparent"
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span
                                className={`w-5 text-[10px] font-mono text-center flex-shrink-0 ${
                                  isActive ? "text-accent font-bold" : "text-subtle"
                                }`}
                              >
                                {idx + 1}
                              </span>
                              <div className="min-w-0">
                                <p
                                  className={`truncate ${
                                    isActive ? "text-accent font-bold" : "text-text group-hover:text-white"
                                  }`}
                                >
                                  {ch.title || `Chapter ${idx + 1}`}
                                </p>
                                <p className="text-[10px] text-subtle">
                                  {formatTime(ch.start)} {chDuration > 0 && `• ${formatTime(chDuration)}`}
                                </p>
                              </div>
                            </div>
                            {isActive && (
                              <div className="flex items-center gap-1 text-[10px] text-accent flex-shrink-0">
                                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                                <span>Playing</span>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : playlist.length > 1 ? (
                    <div className="space-y-1">
                      <div className="px-2 py-1 text-[11px] font-semibold text-subtle">
                        Audiobook Tracks & Chapters ({playlist.length})
                      </div>
                      {playlist.map((track, idx) => {
                        const isActive = idx === currentIndex;
                        return (
                          <button
                            key={track.id}
                            onClick={() => setCurrentIndex(idx)}
                            className={`w-full text-left p-2.5 rounded-xl text-xs transition-colors flex items-center justify-between gap-3 group ${
                              isActive
                                ? "bg-accent/15 border border-accent/30 text-accent font-semibold shadow-xs"
                                : "hover:bg-white/5 text-text border border-transparent"
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span
                                className={`w-5 text-[10px] font-mono text-center flex-shrink-0 ${
                                  isActive ? "text-accent font-bold" : "text-subtle"
                                }`}
                              >
                                {track.trackNumber ?? idx + 1}
                              </span>
                              <div className="min-w-0">
                                <p
                                  className={`truncate ${
                                    isActive ? "text-accent font-bold" : "text-text group-hover:text-white"
                                  }`}
                                >
                                  {track.title || track.filename}
                                </p>
                                <p className="text-[10px] text-subtle">
                                  {track.duration ? formatTime(track.duration) : track.filename}
                                </p>
                              </div>
                            </div>
                            {isActive && (
                              <div className="flex items-center gap-1 text-[10px] text-accent flex-shrink-0">
                                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                                <span>Playing</span>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="py-8 text-center px-4">
                      <BookOpen size={32} className="mx-auto text-subtle/50 mb-2" />
                      <p className="text-sm font-semibold text-text">No Embedded Chapters</p>
                      <p className="text-xs text-subtle mt-1 mb-4">
                        This audio file doesn't have embedded chapter metadata. You can generate synthetic 15-minute chapters to easily seek and navigate.
                      </p>
                      <button
                        onClick={() => generateSyntheticChapters(15)}
                        className="px-3.5 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent border border-accent/30 rounded-lg text-xs font-semibold transition-colors"
                      >
                        Generate 15-Min Chapters
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  {/* Bookmarks Tab */}
                  <div className="mb-3">
                    {!showAddBookmark ? (
                      <button
                        onClick={() => {
                          setShowAddBookmark(true);
                          setNewBookmarkTitle(
                            activeChapter
                              ? `${activeChapter.title} (${formatTime(currentTime)})`
                              : `Bookmark at ${formatTime(currentTime)}`
                          );
                        }}
                        className="w-full py-2 px-3 rounded-xl bg-accent/20 hover:bg-accent/30 text-accent border border-accent/30 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
                      >
                        <BookmarkPlus size={14} />
                        <span>Add Bookmark at {formatTime(currentTime)}</span>
                      </button>
                    ) : (
                      <div className="p-3 bg-muted/60 border border-border rounded-xl space-y-2">
                        <div className="flex items-center justify-between text-xs font-semibold">
                          <span>New Bookmark at {formatTime(currentTime)}</span>
                          <button
                            onClick={() => setShowAddBookmark(false)}
                            className="text-subtle hover:text-text"
                          >
                            <X size={14} />
                          </button>
                        </div>
                        <input
                          type="text"
                          placeholder="Bookmark Title..."
                          value={newBookmarkTitle}
                          onChange={(e) => setNewBookmarkTitle(e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-panel border border-border rounded-lg text-xs text-text focus:outline-none focus:border-accent"
                        />
                        <textarea
                          rows={2}
                          placeholder="Optional notes or quotes..."
                          value={newBookmarkNote}
                          onChange={(e) => setNewBookmarkNote(e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-panel border border-border rounded-lg text-xs text-text focus:outline-none focus:border-accent resize-none"
                        />
                        <div className="flex justify-end gap-2 pt-1">
                          <button
                            onClick={() => setShowAddBookmark(false)}
                            className="px-2.5 py-1 text-xs text-subtle hover:text-text"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSaveBookmark}
                            className="px-3 py-1 bg-accent text-void rounded-lg text-xs font-semibold hover:bg-accent/90"
                          >
                            Save Bookmark
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {currentTrackBookmarks.length === 0 ? (
                    <div className="py-8 text-center px-4">
                      <Bookmark size={32} className="mx-auto text-subtle/50 mb-2" />
                      <p className="text-sm font-semibold text-text">No Bookmarks Saved</p>
                      <p className="text-xs text-subtle mt-1">
                        Save favorite quotes, important sections, or timestamps while listening.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {currentTrackBookmarks.map((bm) => (
                        <div
                          key={bm.id}
                          className="p-2.5 bg-card/60 hover:bg-card border border-border rounded-xl text-xs flex items-start justify-between gap-3 group transition-colors"
                        >
                          <div
                            className="flex-1 min-w-0 cursor-pointer"
                            onClick={() => handleSeek(bm.timestamp)}
                          >
                            <div className="flex items-center gap-2">
                              <span className="px-1.5 py-0.2 rounded bg-accent/20 text-accent font-mono text-[10px] font-bold">
                                {formatTime(bm.timestamp)}
                              </span>
                              <p className="font-semibold text-text truncate group-hover:text-accent transition-colors">
                                {bm.title || `Bookmark at ${formatTime(bm.timestamp)}`}
                              </p>
                            </div>
                            {bm.note && (
                              <p className="text-[11px] text-subtle mt-1 line-clamp-2 italic">
                                "{bm.note}"
                              </p>
                            )}
                            <p className="text-[9px] text-subtle/70 mt-1">
                              {new Date(bm.createdAt).toLocaleDateString()}
                            </p>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeAudioBookmark(currentTrack.id, bm.id);
                            }}
                            className="p-1 rounded text-subtle hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            title="Delete bookmark"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}

      {showFixMatch && currentTrack && (
        <FixMatchModal
          item={currentTrack}
          onClose={() => setShowFixMatch(false)}
        />
      )}

      {/* Cast Device Modal */}
      <CastModal
        isOpen={showCastModal}
        onClose={() => setShowCastModal(false)}
        mediaToCast={
          currentTrack && currentUrl
            ? {
                streamUrl: currentUrl,
                title: currentTrack.title,
                posterUrl: posterSrc || undefined,
                currentTime,
              }
            : undefined
        }
      />

      {/* Whispersync Pair Audiobook Modal */}
      {showPairModal && currentTrack && (
        <PairAudiobookModal
          item={currentTrack}
          currentPair={matchingEbook}
          isOpen={showPairModal}
          onClose={() => setShowPairModal(false)}
        />
      )}
    </motion.div>
  );
}
