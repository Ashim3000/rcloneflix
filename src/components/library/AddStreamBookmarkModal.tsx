import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  X, Globe, Link2, Sparkles, Film, Tv, Music, BookOpen,
  CheckCircle2, AlertCircle, Loader2, ArrowRight, HardDrive,
  DownloadCloud, Star, Play, Copy, Check, Search, ExternalLink, Zap,
} from "lucide-react";
import { CloudTranscodeModal } from "./CloudTranscodeModal";
import {
  useAppStore,
  type LibraryType,
  type Library,
  type MediaItem,
} from "../../store/appStore";
import {
  fetchWebStreamInfo,
  matchMetadataForStream,
  downloadWebStream,
  type WebStreamInfo,
  type MatchedMetadata,
} from "../../lib/streamResolver";
import { persistItems } from "../../lib/libraryDb";
import { useToastStore } from "../../store/toastStore";
import { isDropmbUrl, resolveDropmbShareTracks } from "../../lib/dropmbOffload";
import { searchScenesByFragment, parseAdultSceneFragment } from "../../lib/stashBox";
import { dispatchCloudTask } from "../../lib/cloudWorkerRouter";
import { useCloudTransferStore } from "../../lib/kaggleTransfer";

const LOCALHOST_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i;
const IP_BOUND_HOSTS = [
  "streamed.pk", "embedsports", "moviebite", "yomi.to", "cinextream", "bunkr", "sxyprn",
  "ok.ru", "vk.com", "vkuser", "tapecontent.net",
];

/** Cloud save is only safe for plain, re-fetchable direct media URLs. */
export function classifyCloudSaveEligibility(info: WebStreamInfo | null): { eligible: boolean; url: string; reason: string } {
  if (!info) return { eligible: false, url: "", reason: "Inspect a stream first." };
  const candidate = ((info.direct_stream_url || "").trim() && !LOCALHOST_RE.test((info.direct_stream_url || "").trim())
    ? (info.direct_stream_url || "").trim()
    : (info.original_url || "").trim());
  const lower = candidate.toLowerCase();
  if (!/^https?:\/\//i.test(candidate)) return { eligible: false, url: candidate, reason: "Not an HTTP(S) URL." };
  if (LOCALHOST_RE.test(candidate)) return { eligible: false, url: candidate, reason: "Local stream (127.0.0.1) is only reachable from this device." };
  if (IP_BOUND_HOSTS.some((d) => lower.includes(d))) return { eligible: false, url: candidate, reason: "IP-bound or short-lived portal link — must download locally." };
  if (lower.includes(".m3u8") || lower.includes(".mpd")) return { eligible: false, url: candidate, reason: "Segmented stream — stitched locally via yt-dlp." };
  if (!info.is_direct_media) return { eligible: false, url: candidate, reason: "Not a direct media file." };
  return { eligible: true, url: candidate, reason: "Direct file — can be transferred by a Kaggle worker with zero local bandwidth." };
}

type Props = {
  isOpen: boolean;
  onClose: () => void;
  defaultLibraryType?: LibraryType;
  defaultLibraryId?: string;
  initialUrl?: string;
  initialTitle?: string;
  initialPoster?: string;
  autoInspect?: boolean;
};

type FixMatchResult = {
  id: string;
  title: string;
  year?: number;
  posterUrl?: string;
  backdropUrl?: string;
  overview?: string;
  rating?: number;
  genres?: string[];
  source: "cinemeta" | "tmdb" | "theporndb" | "stashbox";
};

export function AddStreamBookmarkModal({
  isOpen,
  onClose,
  defaultLibraryType = "movies",
  defaultLibraryId,
  initialUrl,
  initialTitle,
  initialPoster,
  autoInspect,
}: Props) {
  const navigate = useNavigate();
  const { libraries, addLibrary, upsertMediaItem, tmdbApiKey, thePornDbApiKey, rcloneConfigPath, stashBoxProviders, kaggleUsername, kaggleKey } = useAppStore();
  const addToast = useToastStore((s) => s.addToast);

  const [url, setUrl] = useState(initialUrl || "");
  const [isInspecting, setIsInspecting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [copiedUrl, setCopiedUrl] = useState(false);

  const [streamInfo, setStreamInfo] = useState<WebStreamInfo | null>(null);
  const [matchedMeta, setMatchedMeta] = useState<MatchedMetadata | null>(null);
  const [editableTitle, setEditableTitle] = useState("");
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>("");
  const [libraryType, setLibraryType] = useState<LibraryType>(defaultLibraryType);
  const [ingestMode, setIngestMode] = useState<"bookmark" | "download_local" | "download_remote">("bookmark");
  const [localDownloadPath, setLocalDownloadPath] = useState<string>("~/Downloads/RcloneFlix");
  const [selectedRemotePath, setSelectedRemotePath] = useState<string>("");
  const [showCloudTranscode, setShowCloudTranscode] = useState(false);

  const kaggleReady = Boolean(kaggleUsername?.trim() && kaggleKey?.trim());
  const cloudEligibility = useMemo(() => classifyCloudSaveEligibility(streamInfo), [streamInfo]);
  const [useCloudWorker, setUseCloudWorker] = useState(true);
  const canUseCloud = kaggleReady && cloudEligibility.eligible;

  // Fix Match Drawer state
  const [showFixMatch, setShowFixMatch] = useState(false);
  const [fixMatchQuery, setFixMatchQuery] = useState("");
  const [fixMatchResults, setFixMatchResults] = useState<FixMatchResult[]>([]);
  const [isSearchingFixMatch, setIsSearchingFixMatch] = useState(false);

  const runInspect = async (targetUrl: string) => {
    const trimmed = targetUrl.trim();
    if (!trimmed) {
      setErrorMsg("Please enter or paste a valid web URL or media stream link.");
      return;
    }

    setIsInspecting(true);
    setErrorMsg("");
    setSuccessMsg("");
    setStreamInfo(null);
    setMatchedMeta(null);
    setShowFixMatch(false);

    try {
      const info = await fetchWebStreamInfo(trimmed);
      setStreamInfo(info);

      // Auto-switch library type if detected
      let targetType = libraryType;
      const isAudioDetected =
        info.media_type === "music" ||
        info.media_type === "audio" ||
        /\.(mp3|flac|m4a|opus|ogg|wav|aac)(?:$|\?)/i.test(trimmed) ||
        trimmed.includes("iheart") ||
        trimmed.includes("ihrhls") ||
        trimmed.includes("revma") ||
        trimmed.includes("saavn");

      const isSportsDetected =
        info.media_type === "sports" ||
        info.provider?.toLowerCase().includes("sports") ||
        trimmed.includes("streamed.pk") ||
        trimmed.includes("streamed");

      const isAdultDetected =
        info.media_type === "adult" ||
        trimmed.includes("bunkr.") ||
        trimmed.includes("bunkrr.") ||
        trimmed.includes("sxyprn");

      if (isAdultDetected) {
        targetType = "adult";
        setLibraryType("adult");
        const match = libraries.find((l) => l.type === "adult");
        if (match) {
          setSelectedLibraryId(match.id);
          if (match.remotePaths?.length) setSelectedRemotePath(match.remotePaths[0]);
        }
      } else if (isAudioDetected) {
        targetType = "music";
        setLibraryType("music");
        const match = libraries.find((l) => l.type === "music");
        if (match) {
          setSelectedLibraryId(match.id);
          if (match.remotePaths?.length) setSelectedRemotePath(match.remotePaths[0]);
        }
      } else if (info.media_type === "comics" || info.media_type === "comic_series") {
        targetType = "comics";
        setLibraryType("comics");
        const match = libraries.find((l) => l.type === "comics");
        if (match) {
          setSelectedLibraryId(match.id);
          if (match.remotePaths?.length) setSelectedRemotePath(match.remotePaths[0]);
        }
      } else if (info.media_type === "tv" || info.media_type === "adult") {
        targetType = info.media_type as LibraryType;
        setLibraryType(targetType);
        const match = libraries.find((l) => l.type === targetType);
        if (match) {
          setSelectedLibraryId(match.id);
          if (match.remotePaths?.length) setSelectedRemotePath(match.remotePaths[0]);
        }
      }

      if (isSportsDetected) {
        // Sports streams retain their clean live event title directly without Cinemeta/TMDB movie matching
        const sportsTitle = initialTitle || info.clean_title;
        const sportsPoster = initialPoster || info.poster_url || undefined;
        setMatchedMeta({
          title: sportsTitle,
          posterUrl: sportsPoster,
          overview: info.description || "Live Sports Broadcast",
          metadataSource: "manual",
          genres: ["Sports"],
        });
        setEditableTitle(sportsTitle);
        setFixMatchQuery(sportsTitle);
      } else if (
        targetType === "books" ||
        targetType === "photos" ||
        targetType === "music" ||
        targetType === "audiobooks" ||
        targetType === "adult" ||
        info.media_type === "archive" ||
        info.media_type === "document" ||
        info.media_type === "photo" ||
        info.media_type === "audio" ||
        info.media_type === "adult"
      ) {
        // Do not query Cinemeta / TMDB for adult or non-video media types
        const directTitle = initialTitle || info.clean_title || info.raw_title || "Media Stream";
        setMatchedMeta({
          title: directTitle,
          metadataSource: "manual",
          posterUrl: info.poster_url || undefined,
          overview: info.description || undefined,
        });
        setEditableTitle(directTitle);
        setFixMatchQuery(directTitle);
      } else {
        // Query Cinemeta / TMDB for rich metadata
        const meta = await matchMetadataForStream(
          info.clean_title,
          targetType,
          info.year,
          tmdbApiKey
        );
        setMatchedMeta(meta);
        setEditableTitle(meta.title || info.clean_title);
        setFixMatchQuery(meta.title || info.clean_title);
      }
    } catch (err: any) {
      console.error("Inspect error:", err);
      setErrorMsg(err.message || String(err) || "Failed to inspect URL");
    } finally {
      setIsInspecting(false);
    }
  };

  useEffect(() => {
    if (isOpen && initialUrl) {
      setUrl(initialUrl);
      if (initialTitle) {
        setEditableTitle(initialTitle);
      }
      if (autoInspect) {
        runInspect(initialUrl);
      }
    } else if (!isOpen) {
      setUrl("");
      setStreamInfo(null);
      setMatchedMeta(null);
      setErrorMsg("");
      setSuccessMsg("");
    }
  }, [isOpen, initialUrl, initialTitle, autoInspect]);

  // Sync library selection
  useEffect(() => {
    if (defaultLibraryId) {
      setSelectedLibraryId(defaultLibraryId);
      const found = libraries.find((l) => l.id === defaultLibraryId);
      if (found) {
        setLibraryType(found.type);
        if (found.remotePaths?.length) setSelectedRemotePath(found.remotePaths[0]);
      }
    } else if (defaultLibraryType) {
      setLibraryType(defaultLibraryType);
      const match =
        libraries.find((l) => l.type === defaultLibraryType && !l.isSharedPass) ||
        libraries.find((l) => l.type === defaultLibraryType);
      if (match) {
        setSelectedLibraryId(match.id);
        if (match.remotePaths?.length) setSelectedRemotePath(match.remotePaths[0]);
      }
    } else if (libraries.length > 0) {
      setSelectedLibraryId(libraries[0].id);
      setLibraryType(libraries[0].type);
      if (libraries[0].remotePaths?.length) setSelectedRemotePath(libraries[0].remotePaths[0]);
    }
  }, [defaultLibraryId, defaultLibraryType, libraries, isOpen]);

  if (!isOpen) return null;

  const handleInspectUrl = () => {
    runInspect(url);
  };

  // Instant Playback without adding to Library
  const handleInstantPlay = async () => {
    if (!streamInfo) return;

    const streamLocation = streamInfo.direct_stream_url || streamInfo.original_url;
    const isSports =
      streamInfo.media_type === "sports" ||
      streamInfo.provider?.toLowerCase().includes("sports") ||
      streamInfo.original_url.includes("streamed");
    const title = editableTitle.trim() || streamInfo.clean_title || (isSports ? "Live Sports Stream" : "DirectPlay Stream");

    // DropMB multi-track album playback
    if (isDropmbUrl(streamInfo.original_url)) {
      try {
        const allTracks = await resolveDropmbShareTracks(streamInfo.original_url);
        if (allTracks && allTracks.length > 1) {
          let artistName = "";
          let albumName = title;
          if (title.includes(" - ")) {
            const split = title.split(" - ");
            artistName = split[0].trim();
            albumName = split.slice(1).join(" - ").trim();
          }
          const playlistItems: MediaItem[] = allTracks.map((t, idx) => ({
            id: `dp-instant-${Date.now()}-${idx}`,
            libraryId: "directplay",
            libraryType: "music",
            remotePath: t.proxiedUrl || t.streamUrl,
            filename: t.filename,
            title: t.title.replace(/^(\d+[\s._-]+)/, "").replace(/[_.]+/g, " ").trim(),
            artist: artistName || undefined,
            album: albumName,
            trackNumber: idx + 1,
            posterUrl: matchedMeta?.posterUrl || streamInfo.poster_url || undefined,
            addedAt: Date.now(),
            lastScannedAt: Date.now(),
            isSourceBookmark: true,
            sourceUrl: streamInfo.original_url,
            sourceProvider: "dropmb",
          }));
          onClose();
          window.dispatchEvent(
            new CustomEvent("rcloneflix:play-audio", {
              detail: { playlist: playlistItems, playlistIndex: 0 },
            })
          );
          return;
        }
      } catch (err) {
        console.warn("Failed resolving dropmb tracks for instant play:", err);
      }
    }
    const isTv = !isSports && (libraryType === "tv" || streamInfo.season != null || streamInfo.episode != null);
    const seasonNum = streamInfo.season || 1;
    const episodeNum = streamInfo.episode || 1;

    const instantItem: MediaItem = {
      id: `dp-instant-${Date.now()}`,
      libraryId: selectedLibraryId || "directplay",
      libraryType,
      remotePath: streamLocation,
      filename: `${title}.${streamInfo.format || "mp4"}`,
      title,
      year: matchedMeta?.year ?? streamInfo.year ?? undefined,
      posterUrl: matchedMeta?.posterUrl || streamInfo.poster_url || undefined,
      backdropUrl: matchedMeta?.backdropUrl || undefined,
      overview: matchedMeta?.overview || streamInfo.description || (isSports ? "Live Sports Stream" : undefined),
      rating: matchedMeta?.rating ?? undefined,
      genres: isSports ? (matchedMeta?.genres || ["Sports"]) : matchedMeta?.genres,
      metadataSource: matchedMeta?.metadataSource || "manual",
      metadataId: matchedMeta?.metadataId,
      addedAt: Date.now(),
      lastScannedAt: Date.now(),
      isSourceBookmark: true,
      sourceUrl: streamInfo.original_url,
      sourceProvider: streamInfo.provider,
      ...(isTv ? {
        season: seasonNum,
        episode: episodeNum,
        episodeTitle: streamInfo.raw_title,
        showTitle: matchedMeta?.title || streamInfo.clean_title,
        showId: matchedMeta?.metadataId || streamInfo.clean_title,
      } : {}),
    };

    onClose();

    // STRICTLY SITE-SPECIFIC AUDIO ROUTING:
    // Only iHeartRadio stations (.m3u8 audio) and direct audio files (.mp3, .m4a, JioSaavn)
    // route to AudioMiniPlayer. All other streams (HLS .m3u8 video, mp4, etc.) route to VLC.
    const isIheartStream =
      streamInfo.original_url.includes("iheart") ||
      streamInfo.original_url.includes("ihrhls") ||
      streamInfo.original_url.includes("revma") ||
      (streamInfo.direct_stream_url != null && (
        streamInfo.direct_stream_url.includes("iheart") ||
        streamInfo.direct_stream_url.includes("ihrhls") ||
        streamInfo.direct_stream_url.includes("revma")
      ));

    const isDirectAudioFile =
      streamLocation.endsWith(".mp3") ||
      streamLocation.endsWith(".flac") ||
      streamLocation.endsWith(".m4a") ||
      streamLocation.endsWith(".aac") ||
      streamLocation.endsWith(".ogg") ||
      streamLocation.endsWith(".wav") ||
      streamInfo.original_url.includes("saavn");

    const isAudio =
      isIheartStream ||
      (streamInfo.media_type === "music" && isDirectAudioFile) ||
      streamInfo.media_type === "audio" ||
      isDirectAudioFile;

    const isBook =
      streamInfo.media_type === "books" ||
      streamInfo.media_type === "document" ||
      libraryType === "books" ||
      streamLocation.endsWith(".epub") ||
      streamLocation.endsWith(".pdf") ||
      streamLocation.endsWith(".cbr") ||
      streamLocation.endsWith(".cbz");

    if (isAudio) {
      window.dispatchEvent(
        new CustomEvent("rcloneflix:play-audio", {
          detail: { playlist: [instantItem], playlistIndex: 0 },
        })
      );
    } else if (isBook || libraryType === "comics") {
      if (streamLocation.endsWith(".pdf")) {
        navigate("/play/pdf", { state: { item: instantItem } });
      } else if (
        streamLocation.endsWith(".cbz") ||
        streamLocation.endsWith(".cbr") ||
        streamLocation.endsWith(".cb7") ||
        streamLocation.endsWith(".cbt") ||
        libraryType === "comics"
      ) {
        navigate("/play/comic", { state: { item: instantItem } });
      } else {
        navigate("/play/epub", { state: { item: instantItem } });
      }
    } else {
      navigate("/play/video", { state: { item: instantItem } });
    }
  };

  // Fix Match search handler
  const handleSearchFixMatch = async () => {
    if (!fixMatchQuery.trim()) return;
    setIsSearchingFixMatch(true);
    setFixMatchResults([]);

    try {
      const results: FixMatchResult[] = [];
      const q = fixMatchQuery.trim();

      if (libraryType === "movies" || libraryType === "tv") {
        const cType = libraryType === "tv" ? "series" : "movie";
        // 1. Cinemeta
        try {
          const res = await fetch(
            `https://v3-cinemeta.strem.io/catalog/${cType}/top/search=${encodeURIComponent(q)}.json`
          );
          if (res.ok) {
            const data = await res.json();
            (data.metas ?? []).slice(0, 8).forEach((m: any) => {
              const rawYear = m.year || m.releaseInfo;
              const y = rawYear ? parseInt(String(rawYear).split("-")[0]) : undefined;
              results.push({
                id: m.id || "",
                title: m.name || q,
                year: isNaN(y as number) ? undefined : y,
                posterUrl: m.poster,
                backdropUrl: m.background,
                overview: m.description,
                rating: typeof m.imdbRating === "number" ? m.imdbRating : parseFloat(m.imdbRating) || undefined,
                genres: Array.isArray(m.genres) ? m.genres : undefined,
                source: "cinemeta",
              });
            });
          }
        } catch {}

        // 2. TMDB if key configured
        if (results.length === 0 && tmdbApiKey) {
          const tmdbType = libraryType === "tv" ? "tv" : "movie";
          const res = await fetch(
            `https://api.themoviedb.org/3/search/${tmdbType}?query=${encodeURIComponent(q)}&language=en-US&page=1`,
            { headers: { Authorization: `Bearer ${tmdbApiKey}` } }
          );
          if (res.ok) {
            const data = await res.json();
            (data.results ?? []).slice(0, 8).forEach((r: any) => {
              const dateStr = r.release_date || r.first_air_date;
              const y = dateStr ? parseInt(dateStr.split("-")[0]) : undefined;
              results.push({
                id: String(r.id),
                title: r.title || r.name || q,
                year: isNaN(y as number) ? undefined : y,
                posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : undefined,
                backdropUrl: r.backdrop_path ? `https://image.tmdb.org/t/p/original${r.backdrop_path}` : undefined,
                overview: r.overview,
                rating: typeof r.vote_average === "number" ? r.vote_average : undefined,
                source: "tmdb",
              });
            });
          }
        }
      } else if (libraryType === "adult") {
        // Stash-Box providers first
        const frag = parseAdultSceneFragment(q);
        const sbProviders = (stashBoxProviders ?? []).filter((p) => p.enabled && p.endpoint?.trim());
        const sbGroups = await Promise.all(
          sbProviders.map((p) => searchScenesByFragment(p, frag, undefined).catch(() => []))
        );
        const seenSb = new Set<string>();
        for (const group of sbGroups) {
          for (const s of group) {
            if (s.source !== "stashbox") continue;
            const key = `stashbox:${s.id}`;
            if (seenSb.has(key)) continue;
            seenSb.add(key);
            results.push({
              id: s.id,
              title: s.title,
              year: s.date ? parseInt(s.date.substring(0, 4), 10) || undefined : undefined,
              genres: s.tags.length ? s.tags : undefined,
              posterUrl: s.posterUrl,
              overview: [
                s.date ? `Released: ${s.date}` : "",
                s.studio ? `Studio: ${s.studio}` : "",
                s.performers.length ? `Performers: ${s.performers.join(", ")}` : "",
                s.details || "",
              ].filter(Boolean).join(" • "),
              source: "stashbox",
            });
          }
        }
        if (thePornDbApiKey) {
          try {
            const res = await fetch(
              `https://api.theporndb.net/scenes?q=${encodeURIComponent(q)}`,
              { headers: { Authorization: `Bearer ${thePornDbApiKey}` } }
            );
            if (res.ok) {
              const data = await res.json();
              (data.data ?? []).slice(0, 8).forEach((scene: any) => {
                const poster = scene.poster || scene.posters?.large || scene.posters?.medium;
                const y = scene.date ? parseInt(scene.date.substring(0, 4), 10) : undefined;
                results.push({
                  id: String(scene.id),
                  title: scene.title || q,
                  year: isNaN(y as number) ? undefined : y,
                  posterUrl: poster,
                  overview: scene.description,
                  source: "theporndb",
                });
              });
            }
          } catch {}
        }
      }

      setFixMatchResults(results);
    } catch (err) {
      console.warn("Fix match search error:", err);
    } finally {
      setIsSearchingFixMatch(false);
    }
  };

  const handleApplyFixMatch = (res: FixMatchResult) => {
    setMatchedMeta({
      title: res.title,
      year: res.year,
      overview: res.overview,
      posterUrl: res.posterUrl,
      backdropUrl: res.backdropUrl,
      rating: res.rating,
      genres: res.genres,
      metadataSource: res.source === "theporndb" ? "manual" : res.source,
      metadataId: res.id,
    });
    setEditableTitle(res.title);
    setShowFixMatch(false);
  };

  // Add Bookmark or Trigger yt-dlp Download
  const handleSaveAction = async () => {
    if (!streamInfo) return;

    const isSports =
      streamInfo.media_type === "sports" ||
      streamInfo.provider?.toLowerCase().includes("sports") ||
      streamInfo.original_url.includes("streamed");
    const title = editableTitle.trim() || streamInfo.clean_title || (isSports ? "Live Sports Stream" : "Web Stream");
    const streamLocation = streamInfo.direct_stream_url || streamInfo.original_url;

    if (ingestMode === "download_remote" && canUseCloud && useCloudWorker && selectedRemotePath.trim()) {
      const ext = streamInfo.format || cloudEligibility.url.match(/\.([a-z0-9]{2,5})(?:$|\?)/i)?.[1]?.toLowerCase() || "mp4";
      const safe = title.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
      const filename = safe.toLowerCase().endsWith(`.${ext}`) ? safe : `${safe}.${ext}`;
      try {
        const jobId = `url-xfer-${Date.now()}`;
        const res = await dispatchCloudTask({
          jobType: "rclone_transfer",
          payload: {
            job_id: jobId,
            operation: "copy",
            source: cloudEligibility.url,
            destination: selectedRemotePath.trim(),
            dest_filename: filename,
            transfers: 4,
            checkers: 8,
            rclone_config_snippet: useAppStore.getState().rcloneConfigContent || undefined,
          },
          title: filename,
          providerOverride: "kaggle",
        });
        useCloudTransferStore.getState().addJob({
          id: jobId,
          title: filename,
          operation: "copy",
          source: cloudEligibility.url,
          destination: selectedRemotePath.trim(),
          kernelSlug: res.kernelSlug || res.jobId,
          kernelUrl: res.url,
          status: "queued",
          createdAt: Date.now(),
          provider: "kaggle",
        });
        addToast(`Dispatched "${filename}" to Kaggle cloud worker`, "success", 5000);
        onClose();
      } catch (err: any) {
        setErrorMsg(`Failed dispatching cloud transfer: ${err?.message || String(err)}`);
      }
      return;
    }

    if (ingestMode === "download_local" || ingestMode === "download_remote") {
      // Trigger yt-dlp download & remux to .mp4
      const downloadId = `stream-dl-${Date.now()}`;
      const filename = `${title}.${streamInfo.format || "mp4"}`;

      try {
        await downloadWebStream({
          download_id: downloadId,
          stream_url: streamLocation,
          original_url: streamInfo.original_url,
          filename,
          destination_dir: ingestMode === "download_local" ? localDownloadPath : undefined,
          remote_upload_path: ingestMode === "download_remote" ? selectedRemotePath : undefined,
          config_path: rcloneConfigPath,
        });

        addToast(
          `Queued ${ingestMode === "download_local" ? "local download" : "cloud upload"} for "${title}"`,
          "info",
          5000
        );
        onClose();
      } catch (err: any) {
        setErrorMsg(`Failed starting stream download: ${err.message || String(err)}`);
      }
      return;
    }

    // Bookmark to Library (0 MB)
    let targetLibId = selectedLibraryId;
    if (!targetLibId) {
      const newLib: Library = {
        id: `lib-web-${Date.now()}`,
        name: `Web Streams (${libraryType})`,
        type: libraryType,
        remotePaths: ["web:"],
      };
      addLibrary(newLib);
      targetLibId = newLib.id;
    }

    // Check if DropMB multi-track album
    if (isDropmbUrl(streamInfo.original_url)) {
      try {
        const allTracks = await resolveDropmbShareTracks(streamInfo.original_url);
        if (allTracks && allTracks.length > 1) {
          let artistName = "";
          let albumName = title;
          if (title.includes(" - ")) {
            const split = title.split(" - ");
            artistName = split[0].trim();
            albumName = split.slice(1).join(" - ").trim();
          } else if (allTracks[0].album && allTracks[0].album.includes(" - ")) {
            const split = allTracks[0].album.split(" - ");
            artistName = split[0].trim();
            albumName = split.slice(1).join(" - ").trim();
          }

          const itemsToSave: MediaItem[] = allTracks.map((t, idx) => {
            let trackTitle = t.title;
            if (t.filename.includes(" - ")) {
              const fSplit = t.filename.replace(/\.[^/.]+$/, "").split(" - ");
              trackTitle = fSplit.slice(1).join(" - ").trim() || t.title;
            }
            trackTitle = trackTitle.replace(/^(\d+[\s._-]+)/, "").replace(/[_.]+/g, " ").trim();

            return {
              id: `bm-dropmb-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
              libraryId: targetLibId,
              libraryType: "music" as LibraryType,
              remotePath: t.proxiedUrl || t.streamUrl,
              filename: t.filename,
              title: trackTitle,
              artist: artistName || undefined,
              album: albumName,
              trackNumber: idx + 1,
              posterUrl: matchedMeta?.posterUrl || streamInfo.poster_url || undefined,
              metadataSource: "manual",
              addedAt: Date.now() + idx,
              lastScannedAt: Date.now(),
              isSourceBookmark: true,
              sourceUrl: streamInfo.original_url,
              sourceProvider: "dropmb",
              groupType: "album",
            };
          });

          for (const item of itemsToSave) {
            upsertMediaItem(item);
          }
          await persistItems(itemsToSave);
          setSuccessMsg(`Added album "${albumName}" (${itemsToSave.length} tracks) to your music library! (0 MB Storage)`);
          setTimeout(() => {
            onClose();
          }, 1000);
          return;
        }
      } catch (err) {
        console.warn("Failed resolving dropmb share tracks for bookmark:", err);
      }
    }

    const itemId = `bm-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const isTv = !isSports && (libraryType === "tv" || streamInfo.season != null || streamInfo.episode != null);
    const seasonNum = streamInfo.season || 1;
    const episodeNum = streamInfo.episode || 1;

    const newItem: MediaItem = {
      id: itemId,
      libraryId: targetLibId,
      libraryType,
      remotePath: streamLocation,
      filename: `${title}.${streamInfo.format || "mp4"}`,
      title,
      year: matchedMeta?.year ?? streamInfo.year ?? undefined,
      posterUrl: matchedMeta?.posterUrl || streamInfo.poster_url || undefined,
      backdropUrl: matchedMeta?.backdropUrl || undefined,
      overview: matchedMeta?.overview || streamInfo.description || (isSports ? "Live Sports Stream" : undefined),
      rating: matchedMeta?.rating ?? undefined,
      genres: isSports ? (matchedMeta?.genres || ["Sports"]) : matchedMeta?.genres,
      metadataSource: matchedMeta?.metadataSource || "manual",
      metadataId: matchedMeta?.metadataId,
      addedAt: Date.now(),
      lastScannedAt: Date.now(),
      isSourceBookmark: true,
      sourceUrl: streamInfo.original_url,
      sourceProvider: streamInfo.provider,
      ...(isTv ? {
        season: seasonNum,
        episode: episodeNum,
        episodeTitle: streamInfo.raw_title,
        showTitle: matchedMeta?.title || streamInfo.clean_title,
        showId: matchedMeta?.metadataId || streamInfo.clean_title,
        showPosterUrl: matchedMeta?.posterUrl || streamInfo.poster_url || undefined,
        showBackdropUrl: matchedMeta?.backdropUrl || undefined,
        showOverview: matchedMeta?.overview || streamInfo.description || undefined,
      } : {}),
    };

    try {
      upsertMediaItem(newItem);
      await persistItems([newItem]);
      setSuccessMsg(`Added "${title}" to your ${libraryType} library! (0 MB Storage)`);

      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err: any) {
      setErrorMsg(`Failed to save stream bookmark: ${err.message || String(err)}`);
    }
  };

  const handleCopyUrl = () => {
    if (!streamInfo) return;
    const direct = streamInfo.direct_stream_url || streamInfo.original_url;
    navigator.clipboard.writeText(direct);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-void/90 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        className="bg-panel border border-border rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-surface/30">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
              <Globe className="text-accent" size={20} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text">DirectPlay & Web Streams</h2>
              <p className="text-xs text-subtle">
                Stream on-demand ad-free, match metadata, or bookmark with 0 MB storage
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-surface flex items-center justify-center text-subtle hover:text-text transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {/* Error Banner */}
          {errorMsg && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-3.5 rounded-xl bg-red-950/40 border border-red-800/40 flex items-start gap-3"
            >
              <AlertCircle size={18} className="text-red-400 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-red-200 leading-relaxed font-body">
                {errorMsg}
              </div>
            </motion.div>
          )}

          {/* Success Banner */}
          {successMsg && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-3.5 rounded-xl bg-teal-950/40 border border-teal-800/40 flex items-center gap-3 text-teal-200 text-xs font-medium"
            >
              <CheckCircle2 size={18} className="text-teal" />
              <span>{successMsg}</span>
            </motion.div>
          )}

          {/* URL Input Form */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-wider text-subtle">
              DirectPlay Stream Link or Web Video URL
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Link2
                  size={16}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none"
                />
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleInspectUrl();
                  }}
                  placeholder="https://moviebite.org/watch/..., streamtape, doodstream, or .m3u8/.mp4"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-surface border border-border focus:border-accent focus:outline-none text-sm text-text font-mono"
                  disabled={isInspecting}
                />
              </div>
              <button
                onClick={handleInspectUrl}
                disabled={isInspecting || !url.trim()}
                className="btn-accent px-4 py-2.5 text-xs font-medium flex items-center gap-2 disabled:opacity-50 flex-shrink-0"
              >
                {isInspecting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    <span>Resolving…</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={14} />
                    <span>Inspect Stream</span>
                  </>
                )}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[11px] text-subtle">
              <span>Resolves:</span>
              <span className="px-1.5 py-0.5 rounded bg-surface border border-border/80 font-mono text-[10px]">MovieBite</span>
              <span className="px-1.5 py-0.5 rounded bg-surface border border-border/80 font-mono text-[10px]">Streamtape</span>
              <span className="px-1.5 py-0.5 rounded bg-surface border border-border/80 font-mono text-[10px]">Doodstream</span>
              <span className="px-1.5 py-0.5 rounded bg-surface border border-border/80 font-mono text-[10px]">Mixdrop</span>
              <span className="px-1.5 py-0.5 rounded bg-surface border border-border/80 font-mono text-[10px]">Bunkr</span>
              <span className="px-1.5 py-0.5 rounded bg-surface border border-border/80 font-mono text-[10px]">Archive.org</span>
              <span className="px-1.5 py-0.5 rounded bg-surface border border-border/80 font-mono text-[10px]">HLS .m3u8</span>
              <span className="px-1.5 py-0.5 rounded bg-surface border border-border/80 font-mono text-[10px]">MP4</span>
            </div>
          </div>

          {/* Live Stream & Metadata Preview */}
          <AnimatePresence>
            {streamInfo && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="space-y-4 pt-1"
              >
                {/* Main Media Card */}
                <div className="p-4 rounded-xl bg-surface/50 border border-border/80 flex gap-4 relative">
                  {/* Poster Thumbnail */}
                  <div className="w-24 h-36 rounded-lg bg-surface flex-shrink-0 overflow-hidden relative border border-border/60 shadow-md">
                    {(matchedMeta?.posterUrl || streamInfo.poster_url) ? (
                      <img
                        src={matchedMeta?.posterUrl || streamInfo.poster_url || ""}
                        alt="Poster preview"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-subtle gap-1 p-2 text-center">
                        <Film size={24} />
                        <span className="text-[10px]">No Poster</span>
                      </div>
                    )}
                    {/* Provider Tag */}
                    <div className="absolute bottom-1.5 left-1.5 right-1.5 px-1 py-0.5 rounded bg-black/85 text-[9px] font-bold text-accent text-center truncate shadow">
                      {streamInfo.provider === "real-debrid"
                        ? "⚡ Real-Debrid"
                        : streamInfo.provider === "premiumize"
                        ? "⭐ Premiumize"
                        : streamInfo.provider === "offcloud"
                        ? "☁️ Offcloud"
                        : streamInfo.provider}
                    </div>
                  </div>

                  {/* Metadata fields */}
                  <div className="flex-1 space-y-2.5 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <label className="block text-[10px] font-semibold uppercase tracking-wider text-subtle mb-1">
                          Media Title
                        </label>
                        <input
                          type="text"
                          value={editableTitle}
                          onChange={(e) => setEditableTitle(e.target.value)}
                          className="w-full px-3 py-1.5 rounded-lg bg-surface border border-border text-sm text-text font-medium focus:border-accent focus:outline-none"
                        />
                      </div>

                      {/* Fix Match Trigger */}
                      <button
                        type="button"
                        onClick={() => {
                          setShowFixMatch(!showFixMatch);
                          if (!showFixMatch) handleSearchFixMatch();
                        }}
                        className="mt-5 px-3 py-1.5 rounded-lg bg-accent/15 border border-accent/30 text-accent text-xs font-medium flex items-center gap-1.5 hover:bg-accent/25 transition-all flex-shrink-0"
                        title="Search Cinemeta/TMDB to fix metadata and artwork"
                      >
                        <Sparkles size={13} />
                        <span>Fix Match</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-3 text-xs text-subtle flex-wrap">
                      {(matchedMeta?.year ?? streamInfo.year) && (
                        <span className="font-semibold text-text">
                          {matchedMeta?.year ?? streamInfo.year}
                        </span>
                      )}
                      {matchedMeta?.rating && (
                        <div className="flex items-center gap-1 text-amber-400 font-semibold">
                          <Star size={12} fill="currentColor" />
                          <span>{matchedMeta.rating.toFixed(1)}</span>
                        </div>
                      )}
                      {matchedMeta?.genres && (
                        <span className="truncate max-w-[200px]">
                          {matchedMeta.genres.slice(0, 3).join(", ")}
                        </span>
                      )}
                      {matchedMeta?.metadataSource === "cinemeta" && (
                        <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 text-[10px] font-mono">
                          Cinemeta
                        </span>
                      )}
                      {matchedMeta?.metadataSource === "tmdb" && (
                        <span className="px-1.5 py-0.5 rounded bg-teal-500/20 text-teal text-[10px] font-mono">
                          TMDB
                        </span>
                      )}
                    </div>

                    {(matchedMeta?.overview || streamInfo.description) && (
                      <p className="text-xs text-subtle line-clamp-2 leading-relaxed">
                        {matchedMeta?.overview || streamInfo.description}
                      </p>
                    )}

                    {/* Direct stream URL info and Copy action */}
                    <div className="pt-1 flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded-md bg-accent/15 text-accent text-[10px] font-mono font-bold tracking-wider">
                        {streamInfo.format?.toUpperCase() || "STREAM"}
                      </span>
                      {(streamInfo.provider === "real-debrid" || streamInfo.provider === "premiumize" || streamInfo.provider === "offcloud") && (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] font-mono font-bold tracking-wider flex items-center gap-1">
                          <Zap size={10} />
                          <span>CACHED</span>
                        </span>
                      )}
                      <span className="text-[11px] text-subtle font-mono truncate max-w-[260px]">
                        {streamInfo.direct_stream_url || streamInfo.original_url}
                      </span>
                      <button
                        type="button"
                        onClick={handleCopyUrl}
                        className="text-subtle hover:text-accent transition-colors ml-auto p-1 rounded hover:bg-surface flex items-center gap-1 text-[11px]"
                        title="Copy direct stream URL"
                      >
                        {copiedUrl ? <Check size={13} className="text-teal" /> : <Copy size={13} />}
                        <span>{copiedUrl ? "Copied" : "Copy"}</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Fix Match Search Panel (Expandable) */}
                <AnimatePresence>
                  {showFixMatch && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="p-4 rounded-xl bg-panel border border-accent/30 space-y-3 shadow-inner"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Search size={14} className="text-accent" />
                          <span className="text-xs font-semibold text-text">Fix Match / Search Cinemeta & TMDB</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowFixMatch(false)}
                          className="text-subtle hover:text-text text-xs"
                        >
                          Close
                        </button>
                      </div>

                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={fixMatchQuery}
                          onChange={(e) => setFixMatchQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSearchFixMatch();
                          }}
                          placeholder="Search title, e.g. Inception, Breaking Bad..."
                          className="flex-1 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-text focus:border-accent focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={handleSearchFixMatch}
                          disabled={isSearchingFixMatch}
                          className="btn-accent px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 disabled:opacity-50"
                        >
                          {isSearchingFixMatch ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                          <span>Search</span>
                        </button>
                      </div>

                      {/* Results List */}
                      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                        {fixMatchResults.map((res) => (
                          <div
                            key={`${res.source}-${res.id}`}
                            onClick={() => handleApplyFixMatch(res)}
                            className="p-2 rounded-lg bg-surface/60 hover:bg-surface border border-border/60 hover:border-accent/50 cursor-pointer transition-all flex items-center gap-3 group"
                          >
                            <div className="w-9 h-12 rounded bg-panel overflow-hidden flex-shrink-0">
                              {res.posterUrl ? (
                                <img src={res.posterUrl} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-subtle">
                                  <Film size={14} />
                                </div>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-text group-hover:text-accent truncate">
                                  {res.title}
                                </span>
                                {res.year && (
                                  <span className="text-[11px] text-subtle font-medium">({res.year})</span>
                                )}
                                <span className="px-1.5 py-0.2 rounded bg-black/40 text-[9px] font-mono uppercase text-subtle ml-auto">
                                  {res.source}
                                </span>
                              </div>
                              {res.overview && (
                                <p className="text-[11px] text-subtle line-clamp-1 mt-0.5">
                                  {res.overview}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                        {fixMatchResults.length === 0 && !isSearchingFixMatch && (
                          <div className="text-center py-3 text-xs text-subtle">
                            No matches found. Try searching with a different title.
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Ingestion & Storage Options */}
                <div className="p-3.5 rounded-xl bg-surface/40 border border-border space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <HardDrive size={15} className="text-accent" />
                      <span className="text-xs font-semibold text-text">Ingestion Action</span>
                    </div>
                    <span className="text-[11px] text-teal font-medium">
                      {ingestMode === "bookmark"
                        ? "0 MB Storage Overhead"
                        : ingestMode === "download_local"
                        ? "Saves directly to computer"
                        : "yt-dlp uploads to remote cloud"}
                    </span>
                  </div>

                  {/* 4 Explicit Action Tabs */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <button
                      type="button"
                      onClick={() => setIngestMode("bookmark")}
                      className={`p-2.5 rounded-lg border text-left transition-all ${
                        ingestMode === "bookmark"
                          ? "bg-accent/15 border-accent text-accent shadow-sm"
                          : "bg-surface border-border text-subtle hover:text-text hover:bg-surface/80"
                      }`}
                    >
                      <div className="text-xs font-semibold flex items-center gap-1.5">
                        <HardDrive size={13} />
                        <span>Source Bookmark</span>
                      </div>
                      <div className="text-[10px] opacity-80 mt-0.5">
                        Stream on demand (0 MB)
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setIngestMode("download_local")}
                      className={`p-2.5 rounded-lg border text-left transition-all ${
                        ingestMode === "download_local"
                          ? "bg-accent/15 border-accent text-accent shadow-sm"
                          : "bg-surface border-border text-subtle hover:text-text hover:bg-surface/80"
                      }`}
                    >
                      <div className="text-xs font-semibold flex items-center gap-1.5">
                        <DownloadCloud size={13} />
                        <span>Download Local</span>
                      </div>
                      <div className="text-[10px] opacity-80 mt-0.5">
                        Save .mp4 to computer
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setIngestMode("download_remote")}
                      className={`p-2.5 rounded-lg border text-left transition-all ${
                        ingestMode === "download_remote"
                          ? "bg-accent/15 border-accent text-accent shadow-sm"
                          : "bg-surface border-border text-subtle hover:text-text hover:bg-surface/80"
                      }`}
                    >
                      <div className="text-xs font-semibold flex items-center gap-1.5">
                        <Globe size={13} />
                        <span>Save to Remote</span>
                      </div>
                      <div className="text-[10px] opacity-80 mt-0.5">
                        Upload to cloud remote
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowCloudTranscode(true)}
                      className="p-2.5 rounded-lg border text-left transition-all bg-accent/10 hover:bg-accent/20 border-accent/30 text-accent hover:border-accent"
                      title="Encode stream to AV1 on Kaggle cloud and archive to odrivecrypt"
                    >
                      <div className="text-xs font-semibold flex items-center gap-1.5">
                        <Zap size={13} />
                        <span>Cloud Transcode</span>
                      </div>
                      <div className="text-[10px] opacity-80 mt-0.5">
                        Kaggle 4-vCPU AV1 Archive
                      </div>
                    </button>
                  </div>

                  {/* Bookmark library selection */}
                  {ingestMode === "bookmark" && (
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div>
                        <label className="block text-[11px] font-medium text-subtle mb-1">
                          Target Library
                        </label>
                        <select
                          value={selectedLibraryId}
                          onChange={(e) => {
                            setSelectedLibraryId(e.target.value);
                            const found = libraries.find((l) => l.id === e.target.value);
                            if (found) setLibraryType(found.type);
                          }}
                          className="w-full px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-text focus:border-accent focus:outline-none"
                        >
                          {libraries.map((lib) => (
                            <option key={lib.id} value={lib.id}>
                              {lib.name} ({lib.type})
                            </option>
                          ))}
                          {libraries.length === 0 && (
                            <option value="">Create Web Streams library</option>
                          )}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-subtle mb-1">
                          Media Category
                        </label>
                        <select
                          value={libraryType}
                          onChange={(e) => setLibraryType(e.target.value as LibraryType)}
                          className="w-full px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-text focus:border-accent focus:outline-none"
                        >
                          <option value="movies">Movies</option>
                          <option value="tv">TV Series</option>
                          <option value="music">Music</option>
                          <option value="audiobooks">Audiobooks</option>
                          <option value="books">Books</option>
                          <option value="comics">Comics</option>
                          <option value="photos">Photos</option>
                          <option value="adult">Adult</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Download to Local Folder selection */}
                  {ingestMode === "download_local" && (
                    <div className="pt-1">
                      <label className="block text-[11px] font-medium text-subtle mb-1">
                        Local Save Directory
                      </label>
                      <input
                        type="text"
                        value={localDownloadPath}
                        onChange={(e) => setLocalDownloadPath(e.target.value)}
                        placeholder="~/Downloads/RcloneFlix"
                        className="w-full px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-text font-mono focus:border-accent focus:outline-none"
                      />
                      <p className="text-[10px] text-subtle mt-1">
                        {streamInfo?.media_type === "archive" || streamInfo?.media_type === "document" || streamInfo?.media_type === "photo" || streamInfo?.media_type === "books"
                          ? "Downloads original binary file directly to local storage."
                          : "Stitches stream into standalone .mp4 using bundled yt-dlp."}
                      </p>
                    </div>
                  )}

                  {/* Save to Cloud Remote selection */}
                  {ingestMode === "download_remote" && (
                    <div className="pt-1 space-y-2">
                      <label
                        className={`flex items-center gap-2 text-[11px] ${canUseCloud ? "text-text" : "text-subtle opacity-60"}`}
                        title={canUseCloud ? cloudEligibility.reason : !kaggleReady ? "Configure Kaggle in Settings" : cloudEligibility.reason}
                      >
                        <input
                          type="checkbox"
                          disabled={!canUseCloud}
                          checked={canUseCloud && useCloudWorker}
                          onChange={(e) => setUseCloudWorker(e.target.checked)}
                        />
                        Run on Kaggle cloud worker (no local bandwidth)
                        {!canUseCloud && (
                          <span className="text-[10px] text-amber-400/90 ml-1">
                            — {!kaggleReady ? "Kaggle not configured" : cloudEligibility.reason}
                          </span>
                        )}
                      </label>
                      <label className="block text-[11px] font-medium text-subtle mb-1">
                        Destination Cloud Remote Directory
                      </label>
                      <input
                        type="text"
                        value={selectedRemotePath}
                        onChange={(e) => setSelectedRemotePath(e.target.value)}
                        placeholder="e.g. drivemine:Movies or odrivecrypt:TV Shows"
                        className="w-full px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-text font-mono focus:border-accent focus:outline-none"
                      />
                      <p className="text-[10px] text-subtle mt-1">
                        {streamInfo?.media_type === "archive" || streamInfo?.media_type === "document" || streamInfo?.media_type === "photo" || streamInfo?.media_type === "books"
                          ? "Downloads and uploads original file directly to remote cloud via Rclone."
                          : "Remuxes stream and uploads encrypted to cloud via Rclone."}
                      </p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-border flex items-center justify-between bg-surface/30">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-medium text-subtle hover:text-text transition-colors"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2.5">
            {/* Play / Preview Now (Instant stream without saving) */}
            {streamInfo && (
              <>
                {streamInfo.media_type !== "archive" &&
                  streamInfo.media_type !== "document" &&
                  streamInfo.media_type !== "photo" &&
                  streamInfo.media_type !== "books" &&
                  streamInfo.media_type !== "audio" &&
                  streamInfo.media_type !== "music" && (
                    <button
                      type="button"
                      onClick={() => setShowCloudTranscode(true)}
                      className="px-4 py-2 rounded-xl bg-accent/15 hover:bg-accent/25 border border-accent/40 text-accent text-xs font-semibold flex items-center gap-2 transition-all shadow-md"
                      title="Encode stream to AV1 on Kaggle cloud and save to odrivecrypt"
                    >
                      <Zap size={14} />
                      <span>Cloud Transcode</span>
                    </button>
                  )}
                {streamInfo.media_type !== "archive" && (
                  <button
                    type="button"
                    onClick={handleInstantPlay}
                    className="px-4 py-2 rounded-xl bg-teal/15 hover:bg-teal/25 border border-teal/40 text-teal text-xs font-semibold flex items-center gap-2 transition-all shadow-md"
                    title="Open media immediately without saving to library"
                  >
                    <Play size={14} fill="currentColor" />
                    <span>
                      {streamInfo.media_type === "books" || streamInfo.media_type === "document" || libraryType === "books"
                        ? "Open Reader"
                        : streamInfo.media_type === "photo" || libraryType === "photos"
                        ? "View Photo"
                        : streamInfo.media_type === "audio" || libraryType === "music"
                        ? "Play Audio"
                        : "Play Now"}
                    </span>
                  </button>
                )}
              </>
            )}

            {/* Save / Ingest action */}
            <button
              onClick={handleSaveAction}
              disabled={!streamInfo || !!successMsg}
              className="btn-accent px-5 py-2 text-xs font-medium flex items-center gap-2 disabled:opacity-40 shadow-lg shadow-accent/20"
            >
              {ingestMode === "bookmark" ? (
                <>
                  <HardDrive size={14} />
                  <span>Bookmark (0 MB)</span>
                </>
              ) : ingestMode === "download_local" ? (
                <>
                  <DownloadCloud size={14} />
                  <span>Download Local (.mp4)</span>
                </>
              ) : (
                <>
                  <Globe size={14} />
                  <span>Upload to Remote</span>
                </>
              )}
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </motion.div>

      {/* Cloud Transcode Modal */}
      {showCloudTranscode && (
        <CloudTranscodeModal
          isOpen={true}
          onClose={() => {
            setShowCloudTranscode(false);
            onClose();
          }}
          sourceInput={streamInfo ? (streamInfo.direct_stream_url || streamInfo.original_url) : url}
          initialTitle={editableTitle || streamInfo?.clean_title || initialTitle}
          initialPoster={matchedMeta?.posterUrl || streamInfo?.poster_url || initialPoster}
          mediaType={libraryType}
        />
      )}
    </div>
  );
}
