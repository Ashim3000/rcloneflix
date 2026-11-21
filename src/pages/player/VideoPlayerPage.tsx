import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  SkipBack, SkipForward, ChevronLeft, Loader2, Headphones, Languages, X, Download, Check,
  ShieldCheck, RotateCw, Cast, PictureInPicture2,
} from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, PhysicalPosition, currentMonitor } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, type MediaItem } from "../../store/appStore";
import { downloadSingleItem, getDownloadedFilePath, useDownloadStore } from "../../lib/downloadManager";
import { FavoriteButton } from "../../components/common/FavoriteButton";
import { AddToPlaylistButton } from "../../components/playlist/AddToPlaylistButton";
import { resolveWebStreamUrl } from "../../lib/streamResolver";
import { simklScrobble } from "../../lib/simkl";
import { useToastStore } from "../../store/toastStore";
import { useCastStore, initCastPoller } from "../../lib/cast";
import { CastModal } from "../../components/player/CastModal";
import {
  pickDefaultPlaybackVersion,
  getNextFallbackVersion,
  type MediaSourceVersion,
} from "../../lib/multiVersion";
import { isTvEnvironment } from "../../lib/tvNavigation";
import Hls from "hls.js";

function formatTime(s: number) {
  if (!s || isNaN(s)) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function scrobblePlayback(action: "start" | "pause" | "stop", item: MediaItem, pct: number) {
  simklScrobble(action, item, pct);
}

type PlayerState = {
  playing: boolean;
  currentTime: number; // seconds
  duration: number; // seconds
  volume: number; // 0-1
  muted: boolean;
  fullscreen: boolean;
  buffering: boolean;
  showControls: boolean;
  error: string | null;
};

/// A libVLC track. `id` is a libVLC track id (not an ffprobe stream index) and
/// is what player_set_audio_track / player_set_subtitle_track expect.
type VlcTrack = {
  id: number;
  name: string;
};

/** Maps a preference like "eng"/"en"/"english" onto substrings libVLC may use. */
const LANGUAGE_ALIASES: Record<string, string[]> = {
  eng: ["english", "eng", "[en]"],
  en: ["english", "eng", "[en]"],
  english: ["english", "eng", "[en]"],
  jpn: ["japanese", "jpn", "[ja]"],
  ja: ["japanese", "jpn", "[ja]"],
  japanese: ["japanese", "jpn", "[ja]"],
  spa: ["spanish", "spa", "espa", "[es]"],
  es: ["spanish", "spa", "espa", "[es]"],
  fra: ["french", "fre", "fra", "[fr]"],
  fr: ["french", "fre", "fra", "[fr]"],
  deu: ["german", "ger", "deu", "[de]"],
  de: ["german", "ger", "deu", "[de]"],
};

const isWindows = typeof navigator !== "undefined" && /win/i.test(navigator.platform || navigator.userAgent);
const isAndroid = typeof window !== "undefined" && Boolean((window as any).AndroidBridge);

/** Detects if a filename or stream URL indicates codecs/containers requiring native VLC */
function shouldForceVlc(filename?: string, streamUrl?: string, sourceUrl?: string): boolean {
  if (isAndroid) return false;
  if (isWindows) {
    if (streamUrl) {
      const sLower = streamUrl.toLowerCase();
      // On Windows, Chromium + hls.js handles .m3u8, direct MP4, WebM, etc.
      // Only force VLC for non-HTTP proprietary protocols
      if (sLower.startsWith("rtmp://") || sLower.startsWith("rtsp://") || sLower.startsWith("mms://")) {
        return true;
      }
    }
    if (!filename) return false;
    const lower = filename.toLowerCase();
    // Only force VLC on Windows for legacy containers Chromium cannot demux at all
    if (
      lower.endsWith(".avi") ||
      lower.endsWith(".wmv") ||
      lower.endsWith(".vob") ||
      lower.endsWith(".flv") ||
      lower.endsWith(".ts") ||
      lower.endsWith(".m2ts")
    ) {
      return true;
    }
    // Only force VLC for unsupported audio codecs (DTS, TrueHD)
    if (lower.includes("truehd") || lower.includes("dts")) {
      return true;
    }
    return false;
  }

  // Linux WebKitGTK path
  if (streamUrl) {
    const sLower = streamUrl.toLowerCase();
    // Do NOT force VLC on HLS manifests or web streams — hls.js handles them cleanly
    // (Exception: if it's a raw file stream via 127.0.0.1/stream?, still check filename below so .mkv/HEVC/AC3 uses VLC)
    if (
      sLower.includes(".m3u8") ||
      sLower.includes("%2em3u8") ||
      sLower.includes(".m3u") ||
      sLower.includes("/hls/") ||
      sLower.includes("manifest") ||
      sLower.includes("playlist") ||
      sLower.includes("googlevideo.com") ||
      sLower.includes("/videoplayback") ||
      sLower.includes("moviebite") ||
      sLower.includes("streamtape") ||
      sLower.includes("baddieseast") ||
      sLower.includes("ok.ru")
    ) {
      return false;
    }
  }
  if (!filename) return false;
  const lower = filename.toLowerCase();
  // Containers incompatible or unstable in Linux WebKitGTK
  if (
    lower.endsWith(".mkv") ||
    lower.endsWith(".avi") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".m2ts") ||
    lower.endsWith(".vob") ||
    lower.endsWith(".flv") ||
    lower.endsWith(".wmv")
  ) {
    return true;
  }
  // Codecs requiring native VLC's dav1d / libavcodec decoders
  if (
    lower.includes("av1") ||
    lower.includes(".av1") ||
    lower.includes("_av1") ||
    lower.includes("hevc") ||
    lower.includes("h265") ||
    lower.includes("h.265") ||
    lower.includes("x265") ||
    lower.includes("10bit")
  ) {
    return true;
  }
  // Audio codecs that fail in WebKitGTK
  if (
    lower.includes("truehd") ||
    lower.includes("atmos") ||
    lower.includes("dts") ||
    lower.includes("ddp") ||
    lower.includes("eac3") ||
    lower.includes("ac3")
  ) {
    return true;
  }
  return false;
}

/** Check media streams via fast ffprobe with max 1.8s timeout in Rust */
async function checkMediaRequiresVlc(fileUrl: string): Promise<boolean> {
  try {
    const info = await invoke<{
      streams?: Array<{ codec_type?: string; codec_name?: string }>;
      timed_out?: boolean;
    }>("get_media_info", { fileUrl });

    if (info?.timed_out) {
      // If remote probe took > 1.8s, don't stall — only hand off to VLC on Linux
      return !isWindows;
    }

    const streams = info?.streams ?? [];
    const audioStreams = streams.filter((s) => s.codec_type === "audio");

    if (isWindows) {
      // On Windows, Chromium handles AAC, MP3, Opus, Vorbis, FLAC, AC3, EAC3.
      // Only force VLC for codecs Chromium genuinely cannot decode (DTS, TrueHD).
      if (audioStreams.some((s) => ["dts", "truehd"].includes(s.codec_name?.toLowerCase() || ""))) {
        return true;
      }
      return false;
    }

    if (audioStreams.length > 1) return true;

    // Audio codecs unsupported by WebKitGTK
    if (audioStreams.some((s) => ["ac3", "eac3", "dts", "truehd", "flac"].includes(s.codec_name?.toLowerCase() || ""))) {
      return true;
    }

    // Video codecs unsupported by WebKitGTK
    const videoStream = streams.find((s) => s.codec_type === "video");
    if (videoStream && ["av1", "hevc", "h265", "vp9"].includes(videoStream.codec_name?.toLowerCase() || "")) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

type VlcTrackList = {
  audio: VlcTrack[];
  subtitle: VlcTrack[];
  current_audio: number;
  current_subtitle: number;
};

export function VideoPlayerPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { item, resumeAt, selectedVersion } = (location.state ?? {}) as {
    item: MediaItem;
    resumeAt?: number;
    selectedVersion?: MediaSourceVersion;
  };

  const [activeVersion, setActiveVersion] = useState<MediaSourceVersion | null>(() => {
    if (selectedVersion) return selectedVersion;
    if (item) return pickDefaultPlaybackVersion(item);
    return null;
  });

  useEffect(() => {
    if (selectedVersion) {
      setActiveVersion(selectedVersion);
    } else if (item) {
      setActiveVersion(pickDefaultPlaybackVersion(item));
    }
  }, [item?.id, selectedVersion]);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);

  const { rcloneConfigPath, libraries, updateWatchProgress, watchProgress, playback, mediaItems, setAudioState } =
    useAppStore();

  const triggerSilentFallback = useCallback(
    (failedRemotePath: string): boolean => {
      if (!item) return false;
      const fallback = getNextFallbackVersion(item, failedRemotePath);
      if (fallback) {
        console.warn(`[multiVersion] Fallback triggered from ${failedRemotePath} to ${fallback.remoteName} (${fallback.remotePath})`);
        setActiveVersion(fallback);

        // When Streamtape fails and we fall back to DoodStream (Tier 2),
        // auto-heal Streamtape in the background with an iterated DMCA filename
        if (
          failedRemotePath.toLowerCase().includes("streamtape") &&
          (fallback.sourceType === "doodstream" || fallback.remoteName.toLowerCase().includes("dood"))
        ) {
          import("../../lib/doodstreamOffload").then(({ cloneDoodstreamToStreamtape }) => {
            cloneDoodstreamToStreamtape(item).catch((err) => {
              console.warn("Background auto-healing to Streamtape failed:", err);
            });
          });
        }

        return true;
      }
      return false;
    },
    [item]
  );

  // Stop background music/radio when starting video playback
  useEffect(() => {
    setAudioState(null);
    window.dispatchEvent(new CustomEvent("rcloneflix:stop-audio"));
  }, [setAudioState]);

  const parentLib = useMemo(
    () => libraries.find((l) => l.id === item?.libraryId),
    [libraries, item?.libraryId]
  );

  // Guard: If this item belongs to an expired shared pass library, immediately block playback
  useEffect(() => {
    if (!item?.libraryId) return;
    if (
      parentLib?.isSharedPass &&
      (parentLib.isExpired || (parentLib.expiresAt && Date.now() >= parentLib.expiresAt))
    ) {
      useToastStore.getState().addToast("This access pass has expired.", "error");
      navigate(-1);
    }
  }, [item?.libraryId, libraries, navigate]);

  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [useHtml5Video, setUseHtml5Video] = useState(true);

  const [rcloneStatus, setRcloneStatus] = useState<{
    state: string;
    message: string;
  }>({ state: "idle", message: "" });

  const [ps, setPs] = useState<PlayerState>({
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    fullscreen: false,
    buffering: true,
    showControls: true,
    error: null,
  });

  // Mirror of `ps` for event handlers that must not close over stale state.
  const psRef = useRef(ps);
  psRef.current = ps;

  // Track selection state. Only populated on the native VLC path — WebKitGTK's
  // <video> gives us no way to switch audio or subtitle tracks.
  const [audioTracks, setAudioTracks] = useState<VlcTrack[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<VlcTrack[]>([]);
  const [activeAudioIndex, setActiveAudioIndex] = useState<number | null>(null);
  const [activeSubtitleIndex, setActiveSubtitleIndex] = useState<number | null>(null);
  const [showTrackMenu, setShowTrackMenu] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const html5TimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const downloads = useDownloadStore((s) => s.downloads);
  const isDownloading = Object.values(downloads).some(
    (d) =>
      d.status === "downloading" &&
      (d.currentFile === item?.filename || d.title === (item?.showTitle ?? item?.title))
  );

  // ── Google Cast / Chromecast ───────────────────────────────────────────────
  const {
    status: castStatus,
    selectedDevice: castDevice,
  } = useCastStore();
  const [showCastModal, setShowCastModal] = useState(false);
  const [preparedCastStream, setPreparedCastStream] = useState<string | null>(null);

  useEffect(() => {
    initCastPoller();
  }, []);

  const openCastModal = async () => {
    if (!item) return;
    if (!streamUrl && !item.isSourceBookmark) {
      try {
        const library = libraries.find((l) => l.id === item.libraryId);
        const matchingRoot =
          library?.remotePaths.find((p) =>
            item.remotePath.startsWith(p.replace(/\/$/, "") + "/")
          ) ?? library?.remotePaths[0] ?? "";
        const libRoot = matchingRoot.replace(/\/$/, "");
        const relPath = item.remotePath.startsWith(libRoot + "/")
          ? item.remotePath.slice(libRoot.length + 1)
          : item.remotePath.split("/").pop() ?? item.filename;

        const res = await invoke<{ file_url: string }>("start_stream_session", {
          configPath: rcloneConfigPath || "",
          remoteRoot: matchingRoot,
          filePath: relPath,
          sessionId: `cast-${item.id}`,
        });
        if (res?.file_url) {
          setPreparedCastStream(res.file_url);
        }
      } catch (e) {
        console.warn("Failed preparing stream for cast:", e);
      }
    }
    setShowCastModal(true);
  };

  const mediaToCast = useMemo(() => {
    if (!item) return undefined;
    const url =
      streamUrl ||
      preparedCastStream ||
      (item.isSourceBookmark ? (item.sourceUrl || item.remotePath) : null);
    if (!url) return undefined;
    return {
      streamUrl: url,
      title: item.title,
      posterUrl: item.posterUrl || item.showPosterUrl,
      currentTime: ps.currentTime,
    };
  }, [item, streamUrl, preparedCastStream, ps.currentTime]);

  // ── Start playback & resolve stream URL ────────────────────────────────────

  // Where this item lives, kept so the <video> onError fallback can hand off to
  // VLC without recomputing it.
  const sourceRef = useRef<{ remoteRoot: string; relPath: string; startMs: number } | null>(null);
  const localPathRef = useRef<string | null>(null);
  const vlcStartedRef = useRef(false);
  const [isLocalPlayback, setIsLocalPlayback] = useState(false);

  // ── Next Episode & Up Next Overlay ─────────────────────────────────────────
  const [showUpNext, setShowUpNext] = useState(false);
  const [upNextCountdown, setUpNextCountdown] = useState(10);
  const hasDismissedUpNextRef = useRef(false);
  const upNextTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── HUD Feedback Overlay (D-Pad Seeking & Volume on TV/Desktop) ──────────
  const [hudNotice, setHudNotice] = useState<{ text: string; icon: "seek-fwd" | "seek-back" | "volume" } | null>(null);
  const hudTimeoutRef = useRef<number | null>(null);
  const showHudNotice = useCallback((text: string, icon: "seek-fwd" | "seek-back" | "volume") => {
    if (hudTimeoutRef.current) clearTimeout(hudTimeoutRef.current);
    setHudNotice({ text, icon });
    hudTimeoutRef.current = window.setTimeout(() => setHudNotice(null), 1500);
  }, []);

  const nextEpisode = useMemo<MediaItem | null>(() => {
    if (!item) return null;

    // 1. Explicit series episodes queue from navigation
    const customQueue = (location.state?.seriesEpisodes || location.state?.playlist) as MediaItem[] | undefined;
    if (customQueue && customQueue.length > 1) {
      const idx = customQueue.findIndex(
        (x) =>
          x.id === item.id ||
          (x.sourceUrl && item.sourceUrl && x.sourceUrl === item.sourceUrl) ||
          (x.remotePath && item.remotePath && x.remotePath === item.remotePath)
      );
      if (idx >= 0 && idx + 1 < customQueue.length) {
        return customQueue[idx + 1];
      }
    }

    // 2. Library TV show episodes
    const isTv = item.libraryType === "tv" || item.season !== undefined || item.episode !== undefined;
    if (!isTv) return null;

    const allItems = Object.values(mediaItems);
    const siblings = allItems.filter((i) => {
      if (i.libraryType !== "tv") return false;
      if (item.showId && i.showId) return i.showId === item.showId;
      if (item.showTitle && i.showTitle) {
        return i.showTitle.toLowerCase().trim() === item.showTitle.toLowerCase().trim();
      }
      return false;
    });

    if (siblings.length <= 1) return null;

    siblings.sort((a, b) => {
      const sA = a.season ?? 1;
      const sB = b.season ?? 1;
      if (sA !== sB) return sA - sB;
      const eA = a.episode ?? 0;
      const eB = b.episode ?? 0;
      return eA - eB;
    });

    const currentIdx = siblings.findIndex((s) => s.id === item.id);
    if (currentIdx >= 0 && currentIdx + 1 < siblings.length) {
      return siblings[currentIdx + 1];
    }

    return null;
  }, [item, location.state, mediaItems]);

  const getReturnTarget = useCallback(() => {
    if (!item) return "/";
    if (item.libraryType === "tv" || item.season !== undefined || item.episode !== undefined) {
      if (item.showId) {
        return `/tv/show/${encodeURIComponent(item.showId)}`;
      }
      return "/tv";
    }
    if (item.libraryType === "movies") return "/movies";
    if (item.libraryType === "music") return "/music";
    if (item.isSourceBookmark || item.libraryId === "directplay") return "/directplay";
    return "/";
  }, [item]);

  const playNextItem = useCallback((targetItem: MediaItem) => {
    if (upNextTimerRef.current) {
      clearInterval(upNextTimerRef.current);
      upNextTimerRef.current = null;
    }
    setShowUpNext(false);
    hasDismissedUpNextRef.current = false;
    setUpNextCountdown(10);

    if (useHtml5Video && videoRef.current) {
      videoRef.current.pause();
    } else {
      invoke("player_stop").catch(() => {});
    }

    navigate("/play/video", {
      replace: true,
      state: {
        item: targetItem,
        resumeAt: 0,
        seriesEpisodes: location.state?.seriesEpisodes,
        playlist: location.state?.playlist,
      },
    });
  }, [useHtml5Video, navigate, location.state]);

  useEffect(() => {
    setShowUpNext(false);
    setUpNextCountdown(10);
    hasDismissedUpNextRef.current = false;
  }, [item?.id]);

  useEffect(() => {
    if (showUpNext && nextEpisode) {
      upNextTimerRef.current = setInterval(() => {
        setUpNextCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(upNextTimerRef.current!);
            upNextTimerRef.current = null;
            playNextItem(nextEpisode);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (upNextTimerRef.current) {
        clearInterval(upNextTimerRef.current);
        upNextTimerRef.current = null;
      }
    }
    return () => {
      if (upNextTimerRef.current) {
        clearInterval(upNextTimerRef.current);
        upNextTimerRef.current = null;
      }
    };
  }, [showUpNext, nextEpisode, playNextItem]);

  const handlePlaybackEnded = useCallback(() => {
    if (!item) return;
    const dur = durationRef.current || psRef.current.duration;
    updateWatchProgress({
      itemId: item.id,
      position: dur,
      duration: dur,
      completed: true,
      lastWatchedAt: Date.now(),
    });
    if (dur > 0) {
      scrobblePlayback("stop", item, 100);
    }

    if (nextEpisode) {
      setShowUpNext(true);
      setUpNextCountdown(10);
    } else {
      // No next episode -> Cleanly navigate back to series page or library
      if (useHtml5Video && videoRef.current) {
        videoRef.current.pause();
      } else {
        invoke("player_stop").catch(() => {});
      }
      if (window.history.state && window.history.state.idx > 0) {
        navigate(-1);
      } else {
        navigate(getReturnTarget(), { replace: true });
      }
    }
  }, [item, nextEpisode, getReturnTarget, navigate, updateWatchProgress, useHtml5Video]);

  const handleBack = useCallback(() => {
    if (item) {
      const pos = currentTimeRef.current;
      const dur = durationRef.current;
      updateWatchProgress({
        itemId: item.id,
        position: pos,
        duration: dur,
        completed: dur > 0 && pos / dur > 0.9,
        lastWatchedAt: Date.now(),
      });
      if (dur > 0) {
        scrobblePlayback("stop", item, (pos / dur) * 100);
      }
    }
    if (window.history.state && window.history.state.idx > 0) {
      navigate(-1);
    } else {
      navigate(getReturnTarget(), { replace: true });
    }
  }, [item, navigate, getReturnTarget, updateWatchProgress]);



  /**
   * Pick the track whose name matches the user's preferred language.
   * libVLC names look like "Track 1 - [English]" or "English"; ffprobe-style
   * codes ("eng") are matched through a small alias table.
   */
  const findPreferredTrack = useCallback(
    (tracks: VlcTrack[], preference: string): VlcTrack | undefined => {
      const pref = preference.trim().toLowerCase();
      if (!pref || tracks.length === 0) return undefined;
      const aliases = LANGUAGE_ALIASES[pref] ?? [pref];
      return tracks.find((t) => {
        const name = t.name.toLowerCase();
        return t.id !== -1 && aliases.some((a) => name.includes(a));
      });
    },
    []
  );

  const loadVlcTracks = useCallback(async () => {
    try {
      const tracks = await invoke<VlcTrackList>("player_get_tracks");
      setAudioTracks(tracks.audio);
      setSubtitleTracks(tracks.subtitle);

      // Honour the preferred audio language so dual-audio releases don't
      // default to whatever track the muxer happened to put first.
      const validAudio = tracks.audio.filter((t) => t.id > 0);
      const preferred = findPreferredTrack(tracks.audio, playback.preferredAudioLanguage);
      const chosenAudio =
        preferred ?? (tracks.current_audio <= 0 && validAudio.length > 0 ? validAudio[0] : null);

      if (chosenAudio && chosenAudio.id !== tracks.current_audio) {
        await invoke("player_set_audio_track", { trackId: chosenAudio.id }).catch(() => {});
        setActiveAudioIndex(chosenAudio.id);
      } else {
        setActiveAudioIndex(tracks.current_audio);
      }

      const preferredSub = findPreferredTrack(
        tracks.subtitle,
        playback.preferredSubtitleLanguage
      );
      if (preferredSub) {
        await invoke("player_set_subtitle_track", { trackId: preferredSub.id }).catch(() => {});
        setActiveSubtitleIndex(preferredSub.id);
      } else {
        setActiveSubtitleIndex(
          tracks.current_subtitle === -1 ? null : tracks.current_subtitle
        );
      }
      return tracks;
    } catch {
      return null;
    }
  }, [findPreferredTrack, playback.preferredAudioLanguage, playback.preferredSubtitleLanguage]);

  const startVlcPlayback = useCallback(async (customLocalPath?: string) => {
    const src = sourceRef.current;
    const localFile = customLocalPath ?? localPathRef.current;
    if ((!src && !localFile) || vlcStartedRef.current) return;
    vlcStartedRef.current = true;
    try {
      const currentSec = currentTimeRef.current;
      const startMs = currentSec > 5 ? Math.round(currentSec * 1000) : (src?.startMs ?? 0);
      if (localFile) {
        await invoke("open_local_media", {
          filePath: localFile,
          startMs,
        });
      } else if (src) {
        await invoke("open_media", {
          configPath: rcloneConfigPath,
          remoteRoot: src.remoteRoot,
          filePath: src.relPath,
          startMs,
        });
      }
      const initialVol = psRef.current.muted ? 0 : Math.round((psRef.current.volume ?? 1) * 100);
      await invoke("player_set_volume", { vol: initialVol }).catch(() => {});

      setUseHtml5Video(false);
      setStreamUrl(null);
      setLoading(false);
      setPs((s) => ({ ...s, error: null }));

      // libVLC only knows the track list once the media is actually open, and
      // there is no "media parsed" event exposed here — poll briefly instead.
      for (const delay of [900, 1800, 3200]) {
        await new Promise((r) => setTimeout(r, delay));
        const tracks = await loadVlcTracks();
        if (tracks && tracks.audio.length > 0) break;
      }
    } catch (err) {
      const currentPath = activeVersion?.remotePath || item?.remotePath || "";
      if (triggerSilentFallback(currentPath)) return;
      vlcStartedRef.current = false;
      setPs((s) => ({ ...s, error: String(err), buffering: false }));
      setLoading(false);
    }
  }, [rcloneConfigPath, loadVlcTracks, triggerSilentFallback, activeVersion, item]);

  useEffect(() => {
    if (!item) return;

    const targetPath = activeVersion?.remotePath || item.remotePath;
    const targetLower = targetPath.toLowerCase();
    // Guest passes rewrite cyberlocker paths to `shared_<remote>:...`. Strip that prefix for matching,
    // and allow Streamtape's public shareUrl on desktop ONLY for those guest paths (owners keep AList).
    const shareCleanLower = targetLower.replace(/^shared_/, "");
    const isGuestSharedPath = targetLower.startsWith("shared_");
    const directShareUrl =
      targetLower.startsWith("http://") || targetLower.startsWith("https://")
        ? targetPath
        : activeVersion?.shareUrl &&
            (shareCleanLower.startsWith("doodstream:") ||
              shareCleanLower.startsWith("dropmb:") ||
              shareCleanLower.startsWith("catbox:") ||
              shareCleanLower.startsWith("streamtape:"))
          ? activeVersion.shareUrl
          : null;

    // 0. Handle Web Stream Bookmarks & Direct CDN Offload URLs (DoodStream, DropMB, Streamtape shareUrl)
    if (item.isSourceBookmark || directShareUrl) {
      const existing = watchProgress[item.id];
      const startMs = Math.round((resumeAt ?? existing?.position ?? 0) * 1000);
      const rawUrl = directShareUrl || item.sourceUrl || item.remotePath;
      vlcStartedRef.current = false;
      sourceRef.current = null;
      setIsLocalPlayback(false);

      resolveWebStreamUrl(rawUrl).then(async (resolvedStream) => {
        localPathRef.current = resolvedStream;
        sourceRef.current = { remoteRoot: "", relPath: resolvedStream, startMs };

        if (playback.videoEngine === "vlc" || shouldForceVlc(item.filename, resolvedStream, rawUrl)) {
          void startVlcPlayback(resolvedStream);
          return;
        }

        // Try HTML5 video (clean direct web stream)
        setStreamUrl(resolvedStream);
        setLoading(false);
      }).catch((err) => {
        console.error("Failed resolving stream bookmark:", err);
        sourceRef.current = { remoteRoot: "", relPath: rawUrl, startMs };
        void startVlcPlayback(rawUrl);
      });

      return () => {
        invoke("player_stop").catch(() => {});
        invoke("stop_stream_session", { sessionId: "player-" + item.id }).catch(() => {});
        invoke("stop_stream_session", { sessionId: "cast-" + item.id }).catch(() => {});
      };
    }

    // Explorer file preview or standalone stream without a persistent library
    if (item.libraryId === "explorer" || (!libraries.some((l) => l.id === item.libraryId) && item.streamUrl)) {
      const activeStream = item.streamUrl || "";
      if (!activeStream) {
        setPs((s) => ({ ...s, error: "Stream URL not available for file preview", buffering: false }));
        setLoading(false);
        return;
      }
      // Arm the VLC fallback: startVlcPlayback() with no args reads these refs.
      // An http(s) URL in localPathRef is played via open_local_media →
      // vlc::Media::new_location, same as the bookmark branch (line ~747).
      const existingExp = watchProgress[item.id];
      sourceRef.current = {
        remoteRoot: "",
        relPath: activeStream,
        startMs: Math.round((resumeAt ?? existingExp?.position ?? 0) * 1000),
      };
      localPathRef.current = activeStream;
      vlcStartedRef.current = false;

      if (playback.videoEngine === "vlc" || shouldForceVlc(item.filename, activeStream)) {
        void startVlcPlayback(activeStream);
      } else {
        setStreamUrl(activeStream);
        setLoading(false);
      }
      return () => {
        invoke("player_stop").catch(() => {});
        invoke("stop_stream_session", { sessionId: "player-" + item.id }).catch(() => {});
      };
    }

    const cleanTargetLower = targetLower.replace(/^shared_/, "");
    const isSpecialRemote =
      cleanTargetLower.startsWith("streamtape:") ||
      cleanTargetLower.startsWith("telegram-drive:") ||
      cleanTargetLower.startsWith("telegram:") ||
      cleanTargetLower.startsWith("tg-native:") ||
      cleanTargetLower.startsWith("tg-serverless:") ||
      cleanTargetLower.startsWith("udrop:");

    let matchingRoot: string;
    let relPath: string;

    const library = libraries.find((l) => l.id === (activeVersion?.libraryId || item.libraryId));
    const matchedLibRoot = !isSpecialRemote
      ? library?.remotePaths.find((p) => {
          const r = p.replace(/\/+$/, "");
          return targetPath.startsWith(r + "/") || (r.endsWith(":") && targetPath.startsWith(r));
        })
      : undefined;

    if (isSpecialRemote || !matchedLibRoot) {
      const colonIdx = targetPath.indexOf(":");
      if (colonIdx === -1) {
        if (targetPath.startsWith("/")) {
          // Absolute local path (Android /storage/..., /sdcard/..., Linux/ChromeOS paths):
          // serve its parent directory; downloaded/FUSE checks below still run first.
          const lastSlash = targetPath.lastIndexOf("/");
          matchingRoot = lastSlash > 0 ? targetPath.slice(0, lastSlash) : "/";
          relPath = targetPath.slice(lastSlash + 1);
        } else if (library?.remotePaths?.[0]) {
          // Relative path stored under a library: resolve against that library's first root.
          matchingRoot = library.remotePaths[0];
          relPath = targetPath.replace(/^\/+/, "");
        } else {
          setPs((s) => ({ ...s, error: "Invalid remote path", buffering: false }));
          setLoading(false);
          return;
        }
      } else {
        matchingRoot = targetPath.slice(0, colonIdx + 1);
        relPath = targetPath.slice(colonIdx + 1).replace(/^\/+/, "");
      }
    } else {
      matchingRoot = matchedLibRoot;
      const rootTrimmed = matchingRoot.replace(/\/+$/, "");
      if (targetPath.startsWith(rootTrimmed + "/")) {
        relPath = targetPath.slice(rootTrimmed.length + 1);
      } else if (rootTrimmed.endsWith(":") && targetPath.startsWith(rootTrimmed)) {
        relPath = targetPath.slice(rootTrimmed.length).replace(/^\/+/, "");
      } else {
        relPath = targetPath.split("/").pop() || item.filename;
      }
    }

    const existing = watchProgress[item.id];
    const startMs = Math.round((resumeAt ?? existing?.position ?? 0) * 1000);

    sourceRef.current = { remoteRoot: matchingRoot, relPath, startMs };
    vlcStartedRef.current = false;

    // 1. Check if downloaded locally first (< 0.2ms)
    getDownloadedFilePath(item).then(async (localPath) => {
      if (localPath) {
        localPathRef.current = localPath;
        setIsLocalPlayback(true);

        if (playback.videoEngine === "vlc" || shouldForceVlc(item.filename)) {
          void startVlcPlayback(localPath);
          return;
        }

        if (playback.videoEngine === "auto") {
          setProbing(true);
          const requiresVlc = await checkMediaRequiresVlc(localPath);
          setProbing(false);
          if (requiresVlc) {
            await startVlcPlayback(localPath);
            return;
          }
        }

        try {
          const res = await invoke<{ file_url: string }>("start_local_file_stream", {
            filePath: localPath,
          });
          setStreamUrl(res.file_url);
        } catch {
          await startVlcPlayback(localPath);
        }
        setLoading(false);
        return;
      }

      // 2. Check if directly accessible through an active local FUSE mount (< 0.5ms)
      const fusePath = await invoke<string | null>("check_fuse_path", {
        remoteRoot: matchingRoot,
        filePath: relPath,
      }).catch(() => null);

      if (fusePath) {
        localPathRef.current = fusePath;
        setIsLocalPlayback(true);

        if (playback.videoEngine === "vlc" || shouldForceVlc(item.filename)) {
          void startVlcPlayback(fusePath);
          return;
        }

        if (playback.videoEngine === "auto") {
          setProbing(true);
          const requiresVlc = await checkMediaRequiresVlc(fusePath);
          setProbing(false);
          if (requiresVlc) {
            await startVlcPlayback(fusePath);
            return;
          }
        }

        try {
          const res = await invoke<{ file_url: string }>("start_local_file_stream", {
            filePath: fusePath,
          });
          setStreamUrl(res.file_url);
        } catch {
          await startVlcPlayback(fusePath);
        }
        setLoading(false);
        return;
      }

      // 3. Fallback to remote cloud stream
      localPathRef.current = null;
      setIsLocalPlayback(false);

      if (playback.videoEngine === "vlc" || shouldForceVlc(item.filename)) {
        void startVlcPlayback();
        return;
      }

      // Get HTTP stream session URL for flicker-free HTML5 video playback
      invoke<{ file_url: string; local_path?: string | null }>("start_stream_session", {
        configPath: rcloneConfigPath,
        remoteRoot: matchingRoot,
        filePath: relPath,
        sessionId: `player-${item.id}`,
      })
        .then(async (res) => {
          if (res.local_path) {
            localPathRef.current = res.local_path;
            setIsLocalPlayback(true);
          }

          if (playback.videoEngine === "auto") {
            const ext = item.filename.split(".").pop()?.toLowerCase() || "";
            const isStandardWeb = ["mp4", "m4v", "webm"].includes(ext);
            if (!isStandardWeb) {
              setProbing(true);
              const requiresVlc = await checkMediaRequiresVlc(res.file_url);
              setProbing(false);
              if (requiresVlc) {
                await startVlcPlayback(res.local_path ?? undefined);
                return;
              }
            }
          }
          setStreamUrl(res.file_url);
          setLoading(false);
        })
        .catch(async () => {
          if (activeVersion?.shareUrl) {
            try {
              const resolved = await resolveWebStreamUrl(activeVersion.shareUrl);
              if (resolved) {
                setStreamUrl(resolved);
                setLoading(false);
                return;
              }
            } catch {}
          }
          if (triggerSilentFallback(targetPath)) return;
          // HTTP stream unavailable — hand straight off to native VLC.
          void startVlcPlayback();
        });
    });

    return () => {
      invoke("player_stop").catch(() => {});
      invoke("stop_stream_session", { sessionId: "player-" + item.id }).catch(() => {});
      invoke("stop_stream_session", { sessionId: "cast-" + item.id }).catch(() => {});
    };
  }, [item?.id, activeVersion?.remotePath, playback.videoEngine]);

  // ── Native VLC playback events (only active on the VLC path) ───────────────

  useEffect(() => {
    if (useHtml5Video) return;

    const unlisteners: Array<() => void> = [];

    listen<{ time_ms: number; duration_ms: number }>("vlc:time", (ev) => {
      const timeS = ev.payload.time_ms / 1000;
      const durS = ev.payload.duration_ms / 1000;
      currentTimeRef.current = timeS;
      if (durS > 0) durationRef.current = durS;
      setPs((s) => ({
        ...s,
        currentTime: timeS,
        duration: durS > 0 ? durS : s.duration,
      }));

      if (
        nextEpisode &&
        !hasDismissedUpNextRef.current &&
        durS > 60 &&
        timeS >= durS - 15
      ) {
        setShowUpNext(true);
      }
    }).then((fn) => unlisteners.push(fn));

    listen<{ playing: boolean; buffering: boolean; ended: boolean }>("vlc:state", (ev) => {
      const { playing, buffering, ended } = ev.payload;
      setPs((s) => ({ ...s, playing, buffering, ...(ended ? { playing: false } : {}) }));
      if (ended) {
        handlePlaybackEnded();
      }
    }).then((fn) => unlisteners.push(fn));

    listen<{ message: string }>("vlc:error", (ev) => {
      let msg = ev.payload.message;
      if (
        item?.sourceProvider === "Apollo Group TV" ||
        item?.sourceUrl?.includes("tvnow.best") ||
        item?.sourceUrl?.includes("starlite.best") ||
        item?.remotePath?.includes("tvnow.best")
      ) {
        msg = "Apollo Group Notice: Stream playback requires an active paid subscription (Apollo returns 'For subscriptions only' on trial accounts). The channel catalog and EPG guide are fully loaded.";
      }
      setPs((s) => ({ ...s, error: msg, buffering: false }));
    }).then((fn) => unlisteners.push(fn));

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [useHtml5Video]);

  // ── HTML5 Video Handlers ───────────────────────────────────────────────────

  const isHls = Boolean(
    streamUrl &&
      (streamUrl.includes(".m3u8") ||
        streamUrl.includes("/hls/") ||
        streamUrl.includes("m3u8") ||
        (streamUrl.includes("/stream?") &&
          (streamUrl.toLowerCase().includes(".m3u8") ||
            streamUrl.toLowerCase().includes("%2em3u8"))))
  );

  // HLS stream handler
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl || !useHtml5Video) {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      return;
    }

    if (isHls && Hls.isSupported()) {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
      const hls = new Hls({
        enableWorker: false,
        lowLatencyMode: true,
      });
      hlsRef.current = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLoading(false);
        setPs((s) => ({ ...s, buffering: false }));
        video.play().then(() => {
          setPs((s) => ({ ...s, playing: true }));
        }).catch((e) => console.warn("HLS autoplay prevented:", e));
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.error("HLS video fatal error:", data);
          hls.destroy();
          hlsRef.current = null;
          // Fallback to VLC on Linux WebKitGTK only (avoid Windows airspace overdraw)
          if (!isWindows && !isAndroid) {
            setStreamUrl(null);
            void startVlcPlayback();
          } else {
            setPs((s) => ({
              ...s,
              error: `Stream error: ${data.details || "Failed to load stream"}. Please try another server mirror.`,
              buffering: false,
            }));
          }
        }
      });

      return () => {
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }
      };
    } else if (isHls && video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = streamUrl;
    }
  }, [streamUrl, useHtml5Video, isHls, startVlcPlayback]);

  // Slow remotes (cyberlocker ticket waits, MTProto round-trips, NNTP
  // assembly) legitimately take >10s to first byte — give them 28s.
  const stallTimeoutMs = useMemo(() => {
    const p = (activeVersion?.remotePath || item?.remotePath || "").toLowerCase();
    const s = (streamUrl || "").toLowerCase();
    const slowMarkers = [
      "streamtape", "tapecontent", "telegram", "tg-native", "tg-serverless",
      "usenet-drive", "udrop", ":8553", ":8552", ":5244", "dood", "mixdrop",
    ];
    return slowMarkers.some((k) => p.includes(k) || s.includes(k)) ? 28000 : 10000;
  }, [activeVersion?.remotePath, item?.remotePath, streamUrl]);

  // HTML5 stall watchdog: remote-aware timeout, then switch to native VLC (Linux only)
  useEffect(() => {
    if (useHtml5Video && streamUrl && !isWindows && !isAndroid) {
      if (html5TimeoutRef.current) clearTimeout(html5TimeoutRef.current);
      html5TimeoutRef.current = setTimeout(() => {
        if (loading || psRef.current.buffering) {
          console.warn(`HTML5 video stream stalled after ${stallTimeoutMs / 1000}s — falling back to native VLC`);
          setStreamUrl(null);
          void startVlcPlayback();
        }
      }, stallTimeoutMs);
    }
    return () => {
      if (html5TimeoutRef.current) clearTimeout(html5TimeoutRef.current);
    };
  }, [useHtml5Video, streamUrl, loading, startVlcPlayback, stallTimeoutMs]);

  const handleVideoLoadedMetadata = () => {
    if (html5TimeoutRef.current) {
      clearTimeout(html5TimeoutRef.current);
      html5TimeoutRef.current = null;
    }
    const video = videoRef.current;
    if (!video) return;
    durationRef.current = video.duration;

    const existing = item ? watchProgress[item.id] : undefined;
    const initialTime = resumeAt ?? existing?.position ?? 0;
    if (initialTime > 5) video.currentTime = initialTime;

    setLoading(false);
    setPs((s) => ({
      ...s,
      duration: video.duration,
      buffering: false,
    }));
    video.play().then(() => setPs((s) => ({ ...s, playing: true }))).catch(() => {});
  };

  const handleVideoTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    currentTimeRef.current = video.currentTime;
    setPs((s) => ({ ...s, currentTime: video.currentTime }));

    if (
      nextEpisode &&
      !hasDismissedUpNextRef.current &&
      video.duration > 60 &&
      video.currentTime >= video.duration - 15
    ) {
      setShowUpNext(true);
    }
  };

  // ── Track Selector ─────────────────────────────────────────────────────────

  const handleSelectAudioTrack = (trackId: number) => {
    setActiveAudioIndex(trackId);
    invoke("player_set_audio_track", { trackId }).catch((e) =>
      setPs((s) => ({ ...s, error: `Could not switch audio track: ${e}` }))
    );
  };

  const handleSelectSubtitleTrack = (trackId: number | null) => {
    setActiveSubtitleIndex(trackId);
    invoke("player_set_subtitle_track", { trackId: trackId ?? -1 }).catch((e) =>
      setPs((s) => ({ ...s, error: `Could not switch subtitles: ${e}` }))
    );
  };

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
      const pos = currentTimeRef.current;
      const dur = durationRef.current;
      if (dur > 0) {
        updateWatchProgress({
          itemId: item.id,
          position: pos,
          duration: dur,
          completed: pos / dur > 0.9,
          lastWatchedAt: Date.now(),
        });
        scrobblePlayback("stop", item, (pos / dur) * 100);
      }
    };
  }, [item?.id]);

  // Keep focus on window so keyboard shortcuts remain interactive
  useEffect(() => {
    window.focus();
  }, []);

  const showControlsTemp = useCallback(() => {
    window.focus();
    setPs((s) => ({ ...s, showControls: true }));
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      setPs((s) => ({ ...s, showControls: s.playing ? false : true }));
    }, 3000);
  }, []);

  const togglePlay = useCallback(() => {
    const curPct = durationRef.current > 0 ? (currentTimeRef.current / durationRef.current) * 100 : 0;
    if (useHtml5Video && videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play();
        setPs((s) => ({ ...s, playing: true }));
        if (item) scrobblePlayback("start", item, curPct);
      } else {
        videoRef.current.pause();
        setPs((s) => ({ ...s, playing: false }));
        if (item) scrobblePlayback("pause", item, curPct);
      }
    } else {
      setPs((s) => {
        if (s.playing) {
          invoke("player_pause").catch(() => {});
          if (item) scrobblePlayback("pause", item, curPct);
          return { ...s, playing: false };
        } else {
          invoke("player_play").catch(() => {});
          if (item) scrobblePlayback("start", item, curPct);
          return { ...s, playing: true };
        }
      });
    }
    showControlsTemp();
  }, [useHtml5Video, showControlsTemp, item]);

  const skipBy = useCallback(
    (secs: number) => {
      let targetSec = 0;
      if (useHtml5Video && videoRef.current) {
        const next = Math.max(0, Math.min(durationRef.current, videoRef.current.currentTime + secs));
        videoRef.current.currentTime = next;
        targetSec = next;
        setPs((s) => ({ ...s, currentTime: next }));
      } else {
        setPs((s) => {
          const next = Math.max(0, Math.min(s.duration, s.currentTime + secs));
          targetSec = next;
          invoke("player_seek", { ms: Math.round(next * 1000) }).catch(() => {});
          return { ...s, currentTime: next };
        });
      }
      showHudNotice(
        secs > 0 ? `+${secs}s (${formatTime(targetSec)})` : `${secs}s (${formatTime(targetSec)})`,
        secs > 0 ? "seek-fwd" : "seek-back"
      );
      showControlsTemp();
    },
    [useHtml5Video, showControlsTemp, showHudNotice]
  );

  const setVolume = useCallback(
    (vol: number, muted: boolean) => {
      const effective = muted ? 0 : vol;
      if (useHtml5Video && videoRef.current) {
        videoRef.current.volume = effective;
        videoRef.current.muted = muted;
      } else {
        invoke("player_set_volume", { vol: Math.round(effective * 100) }).catch(() => {});
      }
      setPs((s) => ({ ...s, volume: vol, muted }));
    },
    [useHtml5Video]
  );

  const [isInPip, setIsInPip] = useState(false);
  const prevWindowBoundsRef = useRef<{
    width: number;
    height: number;
    x: number;
    y: number;
  } | null>(null);

  // Inform Android native layer whether video is eligible for auto-PiP on Home swipe/press
  useEffect(() => {
    if (!isAndroid) return;
    const v = videoRef.current;
    const w = v?.videoWidth || 16;
    const h = v?.videoHeight || 9;
    try {
      (window as any).AndroidBridge?.setPipEligible?.(Boolean(ps.playing && !ps.error), w, h);
    } catch {}
  }, [ps.playing, ps.error]);

  useEffect(() => {
    if (!isAndroid) return;
    const onPipChanged = (e: Event) => {
      const inPip = Boolean((e as CustomEvent)?.detail?.isInPip);
      setIsInPip(inPip);
    };
    window.addEventListener("rcloneflix:pip-changed", onPipChanged);
    return () => {
      window.removeEventListener("rcloneflix:pip-changed", onPipChanged);
      try {
        (window as any).AndroidBridge?.setPipEligible?.(false, 16, 9);
      } catch {}
    };
  }, []);

  const restoreDesktopWindowFromPip = useCallback(async () => {
    if (isAndroid) return;
    try {
      const win = getCurrentWindow();
      await win.setAlwaysOnTop(false);
      await win.setDecorations(true);
      if (prevWindowBoundsRef.current) {
        const b = prevWindowBoundsRef.current;
        await win.setSize(new LogicalSize(b.width, b.height));
        await win.setPosition(new PhysicalPosition(b.x, b.y));
        prevWindowBoundsRef.current = null;
      }
    } catch (e) {
      console.warn("Failed to restore desktop window from PiP:", e);
    }
    setIsInPip(false);
  }, []);

  const togglePip = useCallback(async () => {
    if (isAndroid) {
      const v = videoRef.current;
      const w = v?.videoWidth || 16;
      const h = v?.videoHeight || 9;
      try {
        (window as any).AndroidBridge?.enterPip?.(w, h);
      } catch {}
      return;
    }

    // Desktop (Windows & Linux) Compact Always-On-Top Floating Window
    try {
      const win = getCurrentWindow();
      if (isInPip) {
        await restoreDesktopWindowFromPip();
        return;
      }

      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
      if (psRef.current.fullscreen) {
        await invoke("plugin:window|set_fullscreen", { label: "main", value: false }).catch(() => {});
        setPs((s) => ({ ...s, fullscreen: false }));
      }

      const factor = (await win.scaleFactor().catch(() => 1)) || 1;
      const innerSize = await win.innerSize().catch(() => ({ width: 1280, height: 720 }));
      const outerPos = await win.outerPosition().catch(() => ({ x: 100, y: 100 }));
      prevWindowBoundsRef.current = {
        width: Math.round(innerSize.width / factor),
        height: Math.round(innerSize.height / factor),
        x: outerPos.x,
        y: outerPos.y,
      };

      const pipWidth = 480;
      const pipHeight = 270;
      await win.setDecorations(false);
      await win.setAlwaysOnTop(true);
      await win.setSize(new LogicalSize(pipWidth, pipHeight));

      const mon = await currentMonitor().catch(() => null);
      if (mon) {
        const monScale = mon.scaleFactor || factor;
        const targetX = Math.max(0, mon.position.x + mon.size.width - Math.round(pipWidth * monScale) - 24);
        const targetY = Math.max(0, mon.position.y + mon.size.height - Math.round(pipHeight * monScale) - 64);
        await win.setPosition(new PhysicalPosition(targetX, targetY));
      }
      setIsInPip(true);
    } catch (e) {
      console.warn("Desktop PiP toggle failed:", e);
    }
  }, [isInPip, restoreDesktopWindowFromPip]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current as any;
    const currentlyFullscreen = Boolean(document.fullscreenElement || psRef.current.fullscreen);
    const nextFullscreen = !currentlyFullscreen;

    if (nextFullscreen) {
      if (el) {
        const reqFn = el.requestFullscreen || el.webkitRequestFullscreen;
        if (typeof reqFn === "function") {
          Promise.resolve(reqFn.call(el)).catch(() => {});
        }
      }
      try {
        (window as any).AndroidBridge?.setFullscreen?.(true);
      } catch {}
      invoke("plugin:window|set_fullscreen", { label: "main", value: true }).catch(() => {});
      setPs((s) => ({ ...s, fullscreen: true }));
    } else {
      const exitFn = document.exitFullscreen || (document as any).webkitExitFullscreen;
      if (document.fullscreenElement && typeof exitFn === "function") {
        Promise.resolve(exitFn.call(document)).catch(() => {});
      }
      try {
        (window as any).AndroidBridge?.setFullscreen?.(false);
      } catch {}
      invoke("plugin:window|set_fullscreen", { label: "main", value: false }).catch(() => {});
      setPs((s) => ({ ...s, fullscreen: false }));
    }
  }, []);

  useEffect(() => {
    return () => {
      try {
        (window as any).AndroidBridge?.setFullscreen?.(false);
        (window as any).AndroidBridge?.setPipEligible?.(false, 16, 9);
      } catch {}
      invoke("plugin:window|set_fullscreen", { label: "main", value: false }).catch(() => {});
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      if (!isAndroid && prevWindowBoundsRef.current) {
        const b = prevWindowBoundsRef.current;
        const win = getCurrentWindow();
        win.setAlwaysOnTop(false).catch(() => {});
        win.setDecorations(true).catch(() => {});
        win.setSize(new LogicalSize(b.width, b.height)).catch(() => {});
        win.setPosition(new PhysicalPosition(b.x, b.y)).catch(() => {});
      }
    };
  }, []);

  const handleSeek = useCallback(
    (seconds: number) => {
      currentTimeRef.current = seconds;
      if (useHtml5Video && videoRef.current) {
        videoRef.current.currentTime = seconds;
      } else {
        invoke("player_seek", { ms: Math.round(seconds * 1000) }).catch(() => {});
      }
      setPs((s) => ({ ...s, currentTime: seconds }));
    },
    [useHtml5Video]
  );

  // ── Keyboard shortcuts & Android TV D-Pad Control Bar Navigation ──────────

  useEffect(() => {
    const getVisiblePlayerButtons = (): HTMLElement[] => {
      if (!containerRef.current) return [];
      return Array.from(
        containerRef.current.querySelectorAll<HTMLElement>("button:not([disabled])")
      ).filter((el) => {
        if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
      });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Don't hijack typing in a field (there are none today, but the player
      // is a full-screen surface and this is cheap insurance).
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const isTv = isTvEnvironment();

      const activeBtn =
        document.activeElement instanceof HTMLElement &&
        document.activeElement.tagName === "BUTTON" &&
        containerRef.current?.contains(document.activeElement)
          ? document.activeElement
          : null;

      switch (e.key) {
        case " ":
        case "k":
        case "K":
        case "Enter":
          if (e.key === "Enter" && activeBtn) {
            if (!e.isTrusted) {
              e.preventDefault();
              activeBtn.click();
            }
            showControlsTemp();
            return;
          }
          if (isTv && !psRef.current.showControls) {
            e.preventDefault();
            showControlsTemp();
            setTimeout(() => {
              const playBtn = containerRef.current?.querySelector<HTMLElement>("[data-player-play='true']");
              playBtn?.focus();
            }, 50);
            return;
          }
          e.preventDefault();
          togglePlay();
          break;

        case "ArrowRight":
          if (activeBtn && psRef.current.showControls) {
            const btns = getVisiblePlayerButtons();
            const idx = btns.indexOf(activeBtn);
            if (idx >= 0 && idx + 1 < btns.length) {
              e.preventDefault();
              btns[idx + 1].focus();
              showControlsTemp();
              return;
            }
          }
          e.preventDefault();
          skipBy(10);
          break;

        case "l":
        case "L":
          e.preventDefault();
          skipBy(10);
          break;

        case "ArrowLeft":
          if (activeBtn && psRef.current.showControls) {
            const btns = getVisiblePlayerButtons();
            const idx = btns.indexOf(activeBtn);
            if (idx > 0) {
              e.preventDefault();
              btns[idx - 1].focus();
              showControlsTemp();
              return;
            }
          }
          e.preventDefault();
          skipBy(-10);
          break;

        case "j":
        case "J":
          e.preventDefault();
          skipBy(-10);
          break;

        case "ArrowUp":
          e.preventDefault();
          if (isTv) {
            if (!psRef.current.showControls) {
              showControlsTemp();
              setTimeout(() => {
                const backBtn = containerRef.current?.querySelector<HTMLElement>("[data-player-back='true']");
                backBtn?.focus();
              }, 50);
              return;
            }
            // Navigate to top controls (Back / Audio & Subtitles)
            const topBtn = containerRef.current?.querySelector<HTMLElement>("[data-player-back='true'], [data-player-tracks='true']");
            if (topBtn) topBtn.focus();
            showControlsTemp();
            return;
          }
          if (activeBtn) {
            activeBtn.blur();
            showControlsTemp();
            return;
          }
          setVolume(Math.min(1, Math.round((psRef.current.volume + 0.05) * 100) / 100), false);
          break;

        case "ArrowDown":
          e.preventDefault();
          if (isTv) {
            if (!psRef.current.showControls) {
              showControlsTemp();
              setTimeout(() => {
                const playBtn = containerRef.current?.querySelector<HTMLElement>("[data-player-play='true']");
                playBtn?.focus();
              }, 50);
              return;
            }
            // Navigate down to bottom controls (Play/Pause)
            const playBtn = containerRef.current?.querySelector<HTMLElement>("[data-player-play='true']");
            if (playBtn) playBtn.focus();
            showControlsTemp();
            return;
          }
          if (activeBtn) {
            activeBtn.blur();
            showControlsTemp();
            return;
          }
          setVolume(Math.max(0, Math.round((psRef.current.volume - 0.05) * 100) / 100), false);
          break;

        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;

        case "m":
        case "M":
          e.preventDefault();
          setVolume(psRef.current.volume, !psRef.current.muted);
          break;

        case "Escape":
        case "GoBack":
        case "Backspace":
          e.preventDefault();
          if (activeBtn) {
            activeBtn.blur();
          }
          if (psRef.current.showControls) {
            setPs((s) => ({ ...s, showControls: false }));
            return;
          }
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
            setPs((s) => ({ ...s, fullscreen: false }));
          } else {
            handleBack();
          }
          break;

        default:
          return;
      }
      showControlsTemp();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, skipBy, toggleFullscreen, setVolume, handleBack, showControlsTemp]);

  // ── Hardware Remote Media Control Handling (Play / Pause / Next / Prev) ──
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent)?.detail;
      const action = detail?.action;
      const value = detail?.value;
      if (!action) return;
      switch (action) {
        case "play":
          if (!psRef.current.playing) togglePlay();
          break;
        case "pause":
          if (psRef.current.playing) togglePlay();
          break;
        case "play-pause":
        case "toggle":
          togglePlay();
          break;
        case "stop":
          handleBack();
          break;
        case "next":
          if (nextEpisode) playNextItem(nextEpisode);
          break;
        case "prev":
          handleSeek(0);
          break;
        case "seek":
          if (typeof value === "number") handleSeek(value);
          break;
      }
    };
    window.addEventListener("rcloneflix:media-control", handler);
    return () => window.removeEventListener("rcloneflix:media-control", handler);
  }, [togglePlay, handleBack, nextEpisode, playNextItem, handleSeek]);

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
      className="fixed inset-0 bg-black flex items-center justify-center select-none overflow-hidden"
      onMouseMove={showControlsTemp}
      style={{ cursor: ps.showControls ? "default" : "none" }}
    >
      {/* HTML5 Video Element (Primary Engine - Flicker Free) */}
      {useHtml5Video && streamUrl && (
        <video
          ref={videoRef}
          src={isHls && Hls.isSupported() ? undefined : streamUrl}
          className="w-full h-full object-contain"
          onLoadedMetadata={handleVideoLoadedMetadata}
          onTimeUpdate={handleVideoTimeUpdate}
          onWaiting={() => setPs((s) => ({ ...s, buffering: true }))}
          onPlaying={() => setPs((s) => ({ ...s, buffering: false, playing: true }))}
          onPause={() => setPs((s) => ({ ...s, playing: false }))}
          onEnded={handlePlaybackEnded}
          onError={() => {
            if (isHls && Hls.isSupported()) return;
            const currentPath = activeVersion?.remotePath || item.remotePath;
            if (triggerSilentFallback(currentPath)) return;
            if (isAndroid) {
              const handled = (window as any).AndroidBridge?.openInExternalPlayer?.(
                streamUrl || currentPath,
                item.showTitle ? `${item.showTitle} - ${item.title}` : item.title
              );
              if (handled) {
                handleBack();
                return;
              }
              setLoading(false);
              setPs((s) => ({
                ...s,
                error: "Playback error: Stream unavailable or unsupported video codec. Install VLC or Just Player for external playback.",
                buffering: false,
              }));
              return;
            }
            // Codec the webview can't decode (HEVC, AC3/DTS…) — hand off to VLC.
            if (hlsRef.current) {
              hlsRef.current.destroy();
              hlsRef.current = null;
            }
            setStreamUrl(null);
            void startVlcPlayback();
          }}
        />
      )}

      {/* Loading */}
      {loading && (
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-4 z-10">
          <Loader2 size={40} className="text-accent animate-spin" />
          <p className="text-white/70 font-body text-sm">
            {probing ? "Checking audio tracks…" : "Loading media stream…"}
          </p>
        </div>
      )}

      {/* Error */}
      {ps.error && (
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-4 z-10 px-8">
          <p className="text-danger font-body text-center">{ps.error}</p>
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

      {/* On-Screen Seek / Volume HUD Notice Pill (TV and Desktop) */}
      <AnimatePresence>
        {hudNotice && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.15 }}
            className="absolute top-20 left-1/2 -translate-x-1/2 z-40 px-5 py-2.5 rounded-full bg-black/85 backdrop-blur-md border border-white/20 text-white font-mono font-bold text-sm flex items-center gap-2.5 shadow-2xl pointer-events-none"
          >
            {hudNotice.icon === "seek-fwd" ? (
              <SkipForward size={18} className="text-accent" />
            ) : hudNotice.icon === "seek-back" ? (
              <SkipBack size={18} className="text-accent" />
            ) : (
              <Volume2 size={18} className="text-accent" />
            )}
            <span>{hudNotice.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Desktop Compact PiP Floating Drag Header */}
      {!isAndroid && isInPip && (
        <div
          data-tauri-drag-region
          onMouseDown={() => {
            getCurrentWindow().startDragging().catch(() => {});
          }}
          className="absolute top-0 left-0 right-0 h-9 bg-gradient-to-b from-black/90 to-transparent z-40 flex items-center justify-between px-3 cursor-move opacity-0 hover:opacity-100 transition-opacity"
        >
          <span className="text-[11px] font-heading font-semibold text-white/90 truncate pointer-events-none">
            {item.showTitle ?? item.title}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                void togglePip();
              }}
              className="px-2 py-0.5 rounded bg-accent text-black text-[10px] font-bold hover:bg-accent-hover cursor-pointer"
              title="Restore Full Window"
            >
              Restore
            </button>
          </div>
        </div>
      )}

      {/* Controls Overlay */}
      <AnimatePresence>
        {ps.showControls && !ps.error && !(isAndroid && isInPip) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 pointer-events-none z-30 flex flex-col justify-between"
          >
            {/* Top Bar */}
            <div className="h-24 bg-gradient-to-b from-black/90 via-black/50 to-transparent pointer-events-auto flex items-center justify-between px-6">
              <div className="flex items-center gap-4">
                <button
                  data-player-back="true"
                  onClick={handleBack}
                  className="p-2 rounded-full hover:bg-white/10 text-white/80 hover:text-white transition-colors focus:ring-2 focus:ring-accent focus:outline-none"
                  aria-label="Back"
                >
                  <ChevronLeft size={26} />
                </button>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-white font-body font-semibold text-base">
                      {item.showTitle ?? item.title}
                    </p>
                    {isLocalPlayback ? (
                      <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                        Local File
                      </span>
                    ) : parentLib?.isSharedPass ? (
                      <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                        Cloud Fast Stream
                      </span>
                    ) : activeVersion?.sourceType === "streamtape" ? (
                      <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                        Streamtape CDN
                      </span>
                    ) : activeVersion?.sourceType === "doodstream" ? (
                      <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                        DoodStream CDN
                      </span>
                    ) : activeVersion?.remoteName ? (
                      <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">
                        {activeVersion.remoteName}
                      </span>
                    ) : null}
                  </div>
                  {item.season && item.episode && (
                    <p className="text-white/60 font-body text-xs">
                      S{String(item.season).padStart(2, "0")}E
                      {String(item.episode).padStart(2, "0")}
                      {item.episodeTitle ? ` · ${item.episodeTitle}` : ""}
                    </p>
                  )}
                </div>
              </div>

              {(audioTracks.length > 0 || subtitleTracks.length > 0) && (
                <div className="relative">
                  <button
                    data-player-tracks="true"
                    onClick={() => setShowTrackMenu(!showTrackMenu)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors focus:ring-2 focus:ring-accent focus:outline-none ${
                      showTrackMenu
                        ? "bg-accent border-accent text-black font-medium"
                        : "bg-white/10 hover:bg-white/20 border-white/15 text-white"
                    }`}
                  >
                    <Headphones size={16} />
                    <span className="text-xs font-body">Audio & Subtitles</span>
                  </button>

                  {/* Tracks Popover Menu */}
                  {showTrackMenu && (
                    <div className="absolute right-0 top-12 w-64 bg-card border border-white/15 rounded-xl shadow-2xl p-3 z-50 flex flex-col gap-3">
                      <div className="flex items-center justify-between border-b border-white/10 pb-2">
                        <span className="text-xs font-heading font-semibold text-white">Audio & Subtitles</span>
                        <button onClick={() => setShowTrackMenu(false)} className="text-white/50 hover:text-white">
                          <X size={14} />
                        </button>
                      </div>

                      {/* Audio Tracks */}
                      {audioTracks.length > 0 && (
                        <div>
                          <p className="text-[10px] font-mono uppercase tracking-wider text-white/40 mb-1.5">Audio Tracks</p>
                          <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                            {audioTracks.map((tr) => (
                              <button
                                key={tr.id}
                                onClick={() => handleSelectAudioTrack(tr.id)}
                                className={`text-left text-xs px-2.5 py-1.5 rounded-md flex items-center justify-between transition-colors ${
                                  activeAudioIndex === tr.id
                                    ? "bg-accent/20 text-accent font-medium"
                                    : "hover:bg-white/5 text-white/80"
                                }`}
                              >
                                <span>{tr.name || `Track ${tr.id}`}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Subtitle Tracks */}
                      {subtitleTracks.length > 0 && (
                        <div>
                          <p className="text-[10px] font-mono uppercase tracking-wider text-white/40 mb-1.5">Subtitles</p>
                          <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                            <button
                              onClick={() => handleSelectSubtitleTrack(null)}
                              className={`text-left text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                                activeSubtitleIndex === null
                                  ? "bg-accent/20 text-accent font-medium"
                                  : "hover:bg-white/5 text-white/80"
                              }`}
                            >
                              Off
                            </button>
                            {subtitleTracks
                              .filter((tr) => tr.id !== -1)
                              .map((tr) => (
                                <button
                                  key={tr.id}
                                  onClick={() => handleSelectSubtitleTrack(tr.id)}
                                  className={`text-left text-xs px-2.5 py-1.5 rounded-md flex items-center justify-between transition-colors ${
                                    activeSubtitleIndex === tr.id
                                      ? "bg-accent/20 text-accent font-medium"
                                      : "hover:bg-white/5 text-white/80"
                                  }`}
                                >
                                  <span>{tr.name || `Subtitle ${tr.id}`}</span>
                                </button>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Bottom Controls Bar (Detached Floating Glass Capsule) */}
            <div className="px-4 pb-5 pt-10 bg-gradient-to-t from-black/80 via-black/30 to-transparent pointer-events-auto">
              <div className="mx-auto max-w-5xl rounded-2xl bg-black/65 backdrop-blur-2xl border border-white/[0.12] px-6 py-4 shadow-2xl">
                  {/* Seek Bar */}
                  <div className="relative mb-3 group/seek">
                    <input
                      type="range"
                      min={0}
                      max={ps.duration || 100}
                      value={ps.currentTime}
                      onChange={(e) => handleSeek(parseFloat(e.target.value))}
                      className="w-full h-1.5 appearance-none rounded-full cursor-pointer
                        [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5
                        [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
                        [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:opacity-0
                        group-hover/seek:[&::-webkit-slider-thumb]:opacity-100 transition-all"
                      style={{
                        background: `linear-gradient(to right, rgb(var(--color-accent)) ${progressPct}%, rgba(255,255,255,0.2) ${progressPct}%)`,
                        boxShadow: "0 0 12px rgb(var(--color-accent) / 0.45)",
                      }}
                    />
                  </div>

                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => skipBy(-10)}
                      className="text-white/70 hover:text-white transition-colors focus:ring-2 focus:ring-accent focus:outline-none p-1.5 rounded-lg"
                      aria-label="Skip backward 10 seconds"
                    >
                      <SkipBack size={20} />
                    </button>
                    <button
                      data-player-play="true"
                      onClick={togglePlay}
                      className="w-10 h-10 rounded-full bg-accent hover:bg-accent-hover text-black flex items-center justify-center transition-transform hover:scale-105 focus:ring-4 focus:ring-accent focus:outline-none"
                      aria-label={ps.playing ? "Pause" : "Play"}
                    >
                      {ps.playing ? (
                        <Pause size={20} className="fill-black" />
                      ) : (
                        <Play size={20} className="fill-black ml-0.5" />
                      )}
                    </button>
                    <button
                      onClick={() => skipBy(10)}
                      className="text-white/70 hover:text-white transition-colors focus:ring-2 focus:ring-accent focus:outline-none p-1.5 rounded-lg"
                      aria-label="Skip forward 10 seconds"
                    >
                      <SkipForward size={20} />
                    </button>
                    <span className="text-white/70 font-mono text-xs ml-2">
                      {formatTime(ps.currentTime)} / {formatTime(ps.duration)}
                    </span>

                    <div className="flex-1" />

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setVolume(ps.volume, !ps.muted)}
                        className="text-white/70 hover:text-white transition-colors"
                      >
                        {ps.muted || ps.volume === 0 ? (
                          <VolumeX size={20} />
                        ) : (
                          <Volume2 size={20} />
                        )}
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

                    {item && (
                      <div className="flex items-center gap-1.5 ml-2">
                        <FavoriteButton itemId={item.id} size="sm" />
                        <AddToPlaylistButton items={item} size="sm" />
                        <button
                          onClick={async () => {
                            if (!item || isDownloading) return;
                            await downloadSingleItem(item);
                            setDownloadSuccess(true);
                            setTimeout(() => setDownloadSuccess(false), 4000);
                          }}
                          title={
                            isLocalPlayback
                              ? "Stored locally on your device"
                              : isDownloading
                              ? "Downloading to device…"
                              : downloadSuccess
                              ? "Download started!"
                              : "Download media"
                          }
                          className={`p-1.5 rounded-lg border transition-colors ${
                            isLocalPlayback
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                              : isDownloading
                              ? "border-accent/40 bg-accent/10 text-accent"
                              : downloadSuccess
                              ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-300"
                              : "border-white/10 hover:bg-white/10 text-white/70 hover:text-white"
                          }`}
                        >
                          {isDownloading ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : isLocalPlayback || downloadSuccess ? (
                            <Check size={16} />
                          ) : (
                            <Download size={16} />
                          )}
                        </button>
                      </div>
                    )}

                    <button
                      onClick={openCastModal}
                      title={castStatus.connected ? `Casting to ${castDevice?.name || "device"}` : "Cast to Chromecast / Google TV"}
                      className={`p-1.5 rounded-lg border transition-colors ml-1 ${
                        castStatus.connected
                          ? "border-accent bg-accent/20 text-accent font-semibold"
                          : "border-white/10 hover:bg-white/10 text-white/70 hover:text-white"
                      }`}
                    >
                      <Cast size={16} />
                    </button>

                    {useHtml5Video && (
                      <button
                        onClick={() => {
                          if (hlsRef.current) {
                            hlsRef.current.destroy();
                            hlsRef.current = null;
                          }
                          setStreamUrl(null);
                          void startVlcPlayback();
                        }}
                        title="Switch to Native VLC Player (Fixes audio-only or video codec issues)"
                        className="p-1.5 rounded-lg border border-white/10 hover:bg-white/10 text-white/70 hover:text-white transition-colors ml-1"
                      >
                        <ShieldCheck size={16} className="text-accent" />
                      </button>
                    )}

                    <button
                      onClick={() => void togglePip()}
                      title={isInPip ? "Exit Picture-in-Picture" : "Picture-in-Picture"}
                      className={`p-1.5 rounded-lg border transition-colors ml-1 ${
                        isInPip
                          ? "border-accent bg-accent/20 text-accent"
                          : "border-white/10 hover:bg-white/10 text-white/70 hover:text-white"
                      }`}
                    >
                      <PictureInPicture2 size={16} />
                    </button>

                    <button
                      onClick={toggleFullscreen}
                      className="text-white/70 hover:text-white transition-colors ml-2"
                    >
                      {ps.fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
                    </button>
                  </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Up Next / Auto-Advance Card Overlay */}
      <AnimatePresence>
        {showUpNext && nextEpisode && !(isAndroid && isInPip) && (
          <motion.div
            initial={{ opacity: 0, y: 30, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.25 }}
            className="absolute bottom-24 right-8 z-50 w-80 bg-panel/95 backdrop-blur-md border border-accent/40 rounded-2xl shadow-2xl p-4 overflow-hidden select-none font-body pointer-events-auto"
          >
            {/* Header with Countdown */}
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[11px] uppercase font-bold tracking-wider text-accent flex items-center gap-1.5">
                <span>Up Next in {upNextCountdown}s</span>
              </span>
              <button
                onClick={() => {
                  setShowUpNext(false);
                  hasDismissedUpNextRef.current = true;
                }}
                className="p-1 rounded-md text-subtle hover:text-white hover:bg-surface/50 transition-colors cursor-pointer"
                title="Dismiss"
              >
                <X size={15} />
              </button>
            </div>

            {/* Next Episode Details */}
            <div className="flex items-center gap-3 mb-3.5">
              <div className="w-16 h-12 rounded-lg bg-surface/60 overflow-hidden flex-shrink-0 relative border border-border/60">
                {nextEpisode.posterUrl ? (
                  <img
                    src={nextEpisode.posterUrl}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-subtle">
                    <Play size={16} />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold text-accent uppercase">
                  {nextEpisode.season !== undefined && nextEpisode.episode !== undefined
                    ? `S${String(nextEpisode.season).padStart(2, "0")}E${String(nextEpisode.episode).padStart(2, "0")}`
                    : "Next Item"}
                </div>
                <div className="text-xs font-medium text-white truncate">
                  {nextEpisode.episodeTitle ?? nextEpisode.title}
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => playNextItem(nextEpisode)}
                className="flex-1 btn-primary text-xs py-2 px-3 flex items-center justify-center gap-1.5 font-bold shadow-lg cursor-pointer"
              >
                <Play size={14} fill="currentColor" /> Play Now
              </button>
              <button
                onClick={() => {
                  setShowUpNext(false);
                  hasDismissedUpNextRef.current = true;
                }}
                className="btn-secondary text-xs py-2 px-3 text-subtle hover:text-white cursor-pointer"
              >
                Dismiss
              </button>
            </div>

            {/* Countdown progress bar */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-surface">
              <div
                className="h-full bg-accent transition-all duration-1000 ease-linear"
                style={{ width: `${(upNextCountdown / 10) * 100}%` }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Cast Status Pill */}
      {castStatus.connected && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 z-40 bg-black/85 backdrop-blur-md border border-accent/40 rounded-full py-1 px-3.5 flex items-center gap-2 shadow-2xl pointer-events-auto">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-medium text-white flex items-center gap-1.5 font-body">
            <Cast size={13} className="text-accent" />
            <span>Casting to {castDevice?.name || "Chromecast"}</span>
          </span>
          <button
            onClick={() => setShowCastModal(true)}
            className="text-[11px] text-accent hover:underline font-semibold ml-1 cursor-pointer"
          >
            Manage
          </button>
        </div>
      )}

      {/* Cast Device Connection & Control Modal */}
      <CastModal
        isOpen={showCastModal}
        onClose={() => setShowCastModal(false)}
        mediaToCast={mediaToCast}
      />
    </div>
  );
}
