import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Zap,
  HardDrive,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Film,
  Tv,
  Sliders,
  Edit3,
  Search,
  Check,
  RotateCcw,
  Cpu,
  GitBranch,
  FolderOpen,
} from "lucide-react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore, type LibraryType, type Library } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import {
  useCloudTranscodeStore,
  initCloudTranscodePoller,
} from "../../lib/kaggleTranscode";
import {
  dispatchCloudTask,
  getActiveKaggleJobCount,
  type ProviderSelection,
} from "../../lib/cloudWorkerRouter";
import { matchMetadataForStream, type MatchedMetadata } from "../../lib/streamResolver";
import { RemoteBrowser } from "../common/RemoteBrowser";

const safeFetch = typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ ? tauriFetch : fetch;

export type BatchTranscodeSourceItem = {
  path: string;
  title: string;
  isDir?: boolean;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  sourceInput: string;
  sourceItems?: BatchTranscodeSourceItem[];
  initialTitle?: string;
  initialPoster?: string;
  mediaType?: LibraryType;
  lockTitle?: boolean;
};

/**
 * Returns true if the remote is an offload service (Streamtape / Telegram)
 * that requires an empty destination folder path (uploads directly to root/channel).
 */
export function isOffloadDestinationRemote(remoteName: string): boolean {
  const lower = (remoteName || "").trim().toLowerCase().replace(/:.*$/, "");
  return (
    lower === "streamtape" ||
    lower === "telegram" ||
    lower === "telegram-drive" ||
    lower === "tg-native"
  );
}

/**
 * Ensures any destination folder input (e.g. "/Converted_Videos/" or "Converted_Videos")
 * is consistently formatted as `remote:/Subfolder/` using the selected remote dropdown.
 * For offload remotes (streamtape, telegram, telegram-drive), returns "" so destination path is always empty.
 */
export function normalizeDestinationRemoteFolder(rawFolder: string, selectedRemote: string): string {
  const activeRemote = selectedRemote.trim().replace(/:.*$/, "") || "odrivecrypt";
  if (isOffloadDestinationRemote(activeRemote)) {
    return "";
  }
  const trimmed = rawFolder.trim();
  if (!trimmed) {
    return `${activeRemote}:/Converted_Videos/`;
  }
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx !== -1) {
    const subPart = trimmed.slice(colonIdx + 1).replace(/^\/+|\/+$/g, "");
    return subPart ? `${activeRemote}:/${subPart}/` : `${activeRemote}:/`;
  }
  const cleanSub = trimmed.replace(/^\/+|\/+$/g, "");
  return cleanSub ? `${activeRemote}:/${cleanSub}/` : `${activeRemote}:/`;
}

type TranscodeSearchResult = {
  id: string;
  title: string;
  year?: number;
  posterUrl?: string;
  backdropUrl?: string;
  overview?: string;
  genres?: string[];
  source: "cinemeta" | "tmdb";
  type: "movie" | "series";
};

export function CloudTranscodeModal({
  isOpen,
  onClose,
  sourceInput,
  sourceItems,
  initialTitle,
  initialPoster,
  mediaType = "movies",
  lockTitle = false,
}: Props) {
  const {
    remotes,
    libraries,
    rcloneConfigPath,
    tmdbApiKey,
    kaggleUsername,
    kaggleKey,
    rcloneConfigContent,
    ghaConfig,
    telegramConfig,
    streamtapeConfig,
  } = useAppStore();
  const addToast = useToastStore((s) => s.addToast);
  const addCloudJob = useCloudTranscodeStore((s) => s.addJob);

  const isBatchMode = useMemo(() => {
    return Boolean(sourceItems && (sourceItems.length > 1 || sourceItems[0]?.isDir));
  }, [sourceItems]);

  const [workerProvider, setWorkerProvider] = useState<ProviderSelection>("auto");
  const activeKaggleJobs = getActiveKaggleJobCount();
  const isGhaConfigured = Boolean(
    ghaConfig?.enabled && ghaConfig?.token?.trim() && ghaConfig?.owner?.trim() && ghaConfig?.repo?.trim()
  );
  const isKaggleConfigured = Boolean(kaggleUsername?.trim() && kaggleKey?.trim());
  const rawSourceTitleRef = useRef<string>("");

  const [loadingMeta, setLoadingMeta] = useState(false);
  const [matchedMeta, setMatchedMeta] = useState<MatchedMetadata | null>(null);
  const [cleanTitle, setCleanTitle] = useState("");
  const [outputFilename, setOutputFilename] = useState("");
  const [selectedRemote, setSelectedRemote] = useState<string>("odrivecrypt");
  const [destFolder, setDestFolder] = useState<string>("odrivecrypt:/Converted_Videos/");
  const [showDestBrowser, setShowDestBrowser] = useState<boolean>(false);
  const [autoRouteLibrary, setAutoRouteLibrary] = useState<Library | null>(null);
  const [deleteOriginal, setDeleteOriginal] = useState<boolean>(true);
  const [crf, setCrf] = useState<number>(27);
  const [preset, setPreset] = useState<number>(9);
  const [maxHeight, setMaxHeight] = useState<number>(1080);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Metadata Edit / Fix Match states
  const [currentMediaType, setCurrentMediaType] = useState<LibraryType>(mediaType);
  const [showFixMatch, setShowFixMatch] = useState(false);
  const [fixMatchTab, setFixMatchTab] = useState<"search" | "manual">("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<TranscodeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Manual Edit fields
  const [manualTitle, setManualTitle] = useState("");
  const [manualYear, setManualYear] = useState("");
  const [manualPoster, setManualPoster] = useState("");
  const [manualOverview, setManualOverview] = useState("");
  const [manualType, setManualType] = useState<LibraryType>(mediaType);
  const [manualSeason, setManualSeason] = useState("1");
  const [manualEpisode, setManualEpisode] = useState("1");

  // Check if input is a cloud remote file (e.g. drivemine:...) or direct web stream
  const isCloudRemoteSource = useMemo(() => {
    return (
      sourceInput.includes(":") &&
      !sourceInput.startsWith("http://") &&
      !sourceInput.startsWith("https://")
    );
  }, [sourceInput]);

  // Route destination folder & matching library
  const routeDestination = useCallback(
    (
      metaTitle: string,
      metaYear?: number,
      targetType: LibraryType = currentMediaType,
      targetRemote: string = selectedRemote,
      seasonNum?: number
    ): string => {
      const cleanTargetRemote = targetRemote.trim().replace(/:.*$/, "") || "odrivecrypt";
      if (isOffloadDestinationRemote(cleanTargetRemote)) {
        const offloadLib = libraries.find(
          (l) =>
            l.type === targetType &&
            l.remotePaths.some((p) => p.toLowerCase().startsWith(cleanTargetRemote.toLowerCase() + ":"))
        );
        setAutoRouteLibrary(offloadLib || null);
        return "";
      }

      const fullTitle = metaYear ? `${metaTitle} (${metaYear})` : metaTitle;
      const prefixLower = cleanTargetRemote.toLowerCase() + ":";
      const matchingLib =
        libraries.find(
          (l) => l.type === targetType && l.remotePaths.some((p) => p.toLowerCase().startsWith(prefixLower))
        ) || libraries.find((l) => l.type === targetType);

      if (matchingLib && matchingLib.remotePaths.length > 0) {
        setAutoRouteLibrary(matchingLib);
        // Pick the path belonging to targetRemote if present; otherwise strip foreign remote prefix and apply targetRemote
        const matchedRemotePath =
          matchingLib.remotePaths.find((p) => p.toLowerCase().startsWith(prefixLower)) ||
          matchingLib.remotePaths[0];
        const strippedSub = matchedRemotePath
          .replace(/^[a-zA-Z0-9_-]+:\/*/, "")
          .replace(/^\/+|\/+$/g, "");
        const baseRemotePath = strippedSub
          ? `${cleanTargetRemote}:/${strippedSub}`
          : `${cleanTargetRemote}:`;

        if (targetType === "movies") {
          return `${baseRemotePath}/${fullTitle}/`;
        } else if (targetType === "tv") {
          const sNum = seasonNum !== undefined ? seasonNum : 1;
          const sPad = String(sNum).padStart(2, "0");
          return `${baseRemotePath}/${metaTitle}/Season ${sPad}/`;
        } else {
          return `${baseRemotePath}/`;
        }
      } else {
        setAutoRouteLibrary(null);
        return `${cleanTargetRemote}:/Converted_Videos/`;
      }
    },
    [libraries, currentMediaType, selectedRemote]
  );

  // Generate safe filename helper
  const generateFilename = (
    title: string,
    targetType: LibraryType,
    season?: number,
    episode?: number
  ) => {
    let base = title.replace(/[/\\?%*:|"<>]/g, "");
    if (targetType === "tv" && season !== undefined && episode !== undefined) {
      const sPad = String(season).padStart(2, "0");
      const ePad = String(episode).padStart(2, "0");
      if (!base.match(/[sS]\d+[eE]\d+/)) {
        base = `${base} S${sPad}E${ePad}`;
      }
    }
    return `${base}_AV1.mp4`;
  };

  const initializedSessionRef = useRef<string | null>(null);

  // Default destination remote selection: Prefer odrivecrypt if available
  useEffect(() => {
    if (!selectedRemote && remotes.length > 0) {
      const hasOdrivecrypt = remotes.some((r) => r.name.toLowerCase() === "odrivecrypt");
      if (hasOdrivecrypt) {
        setSelectedRemote("odrivecrypt");
      } else {
        setSelectedRemote(remotes[0].name);
      }
    }
  }, [remotes, selectedRemote]);

  // Initial title & filename parsing
  useEffect(() => {
    if (!isOpen || !sourceInput) {
      initializedSessionRef.current = null;
      return;
    }

    const sessionKey = `${sourceInput}_${sourceItems?.length ?? 0}`;
    if (initializedSessionRef.current === sessionKey) {
      return;
    }
    initializedSessionRef.current = sessionKey;

    // MULTI-FILE BATCH OR FOLDER MODE: Skip metadata auto-matching, preserve original filenames + _AV1.mp4
    if (isBatchMode && sourceItems && sourceItems.length > 0) {
      setLoadingMeta(false);
      setMatchedMeta(null);
      setAutoRouteLibrary(null);
      setErrorMsg("");

      const batchLabel =
        sourceItems.length === 1 && sourceItems[0].isDir
          ? `Folder: ${sourceItems[0].title}`
          : `Batch (${sourceItems.length} files)`;
      setCleanTitle(batchLabel);
      setOutputFilename("<original_filename>_AV1.mp4");

      // Default destination to the origin folder of the first selected item
      const firstPath = sourceItems[0].path;
      const colonIdx = firstPath.indexOf(":");
      if (colonIdx !== -1) {
        const originRemote = firstPath.slice(0, colonIdx);
        setSelectedRemote(originRemote);
        if (sourceItems.length === 1 && sourceItems[0].isDir) {
          setDestFolder(normalizeDestinationRemoteFolder(firstPath, originRemote));
        } else {
          const lastSlash = firstPath.lastIndexOf("/");
          const parentPath = lastSlash > colonIdx ? firstPath.slice(0, lastSlash) : `${originRemote}:/Converted_Videos/`;
          setDestFolder(normalizeDestinationRemoteFolder(parentPath, originRemote));
        }
      } else {
        const defRem = remotes.some((r) => r.name.toLowerCase() === "odrivecrypt")
          ? "odrivecrypt"
          : remotes[0]?.name || "odrivecrypt";
        setSelectedRemote(defRem);
        setDestFolder(normalizeDestinationRemoteFolder(`${defRem}:/Converted_Videos/`, defRem));
      }
      return;
    }

    let rawName = initialTitle || "";
    if (!rawName) {
      if (isCloudRemoteSource) {
        const parts = sourceInput.split(/[/:]/);
        rawName = parts[parts.length - 1] || "";
      } else {
        try {
          const u = new URL(sourceInput);
          rawName = decodeURIComponent(u.pathname.split("/").pop() || "");
        } catch {
          rawName = sourceInput;
        }
      }
    }

    rawSourceTitleRef.current = rawName;

    const isAdultSource =
      mediaType === "adult" ||
      sourceInput.toLowerCase().includes("bunkr.") ||
      sourceInput.toLowerCase().includes("bunkrr.") ||
      sourceInput.toLowerCase().includes("sxyprn");

    // Clean stem: strip extensions, quality tags, brackets
    const stem = rawName.replace(/\.[^/.]+$/, "");
    const cleaned = stem
      .replace(/\{tmdb-\d+\}/gi, "")
      .replace(/\{imdb-tt\d+\}/gi, "")
      .replace(/\[\d+p\]/gi, "")
      .replace(/\b(1080p|720p|2160p|4k|bluray|web-dl|x264|x265|hevc|av1)\b/gi, "")
      .replace(/[_.]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    const titleCandidate = (lockTitle && initialTitle) ? initialTitle : (cleaned || stem || "Video");
    setCleanTitle(titleCandidate);

    // Season & Episode detection for TV
    const sMatch = stem.match(/[sS](\d+)[eE](\d+)/) || stem.match(/(\d+)x(\d+)/);
    const parsedSeason = sMatch ? parseInt(sMatch[1], 10) : undefined;
    const parsedEpisode = sMatch ? parseInt(sMatch[2], 10) : undefined;
    const detectedType: LibraryType = isAdultSource
      ? "adult"
      : parsedSeason !== undefined || mediaType === "tv"
      ? "tv"
      : "movies";
    setCurrentMediaType(detectedType);
    setManualType(detectedType);
    if (parsedSeason !== undefined) setManualSeason(String(parsedSeason));
    if (parsedEpisode !== undefined) setManualEpisode(String(parsedEpisode));

    const safeFilename = generateFilename(titleCandidate, detectedType, parsedSeason, parsedEpisode);
    setOutputFilename(safeFilename);

    // Initial manual state values
    setManualTitle(titleCandidate);
    setSearchQuery(titleCandidate);

    if (detectedType === "adult") {
      setMatchedMeta(null);
      const dest = routeDestination(titleCandidate, undefined, "adult", selectedRemote);
      setDestFolder(normalizeDestinationRemoteFolder(dest, selectedRemote));
      setLoadingMeta(false);
      return;
    }

    // Auto-detect metadata & library routing
    setLoadingMeta(true);
    setErrorMsg("");

    // Detect year if present
    const yearMatch = stem.match(/[[(]?(19\d\d|20\d\d)[\])]?/);
    const parsedYear = yearMatch ? parseInt(yearMatch[1], 10) : undefined;
    if (parsedYear) setManualYear(String(parsedYear));

    matchMetadataForStream(titleCandidate, detectedType, parsedYear, tmdbApiKey)
      .then((meta) => {
        setMatchedMeta(meta);
        if (meta.title) {
          const fullTitle = meta.year ? `${meta.title} (${meta.year})` : meta.title;
          setCleanTitle(fullTitle);
          setManualTitle(meta.title);
          if (meta.year) setManualYear(String(meta.year));
          if (meta.posterUrl) setManualPoster(meta.posterUrl);
          if (meta.overview) setManualOverview(meta.overview);

          const fname = generateFilename(fullTitle, detectedType, parsedSeason, parsedEpisode);
          setOutputFilename(fname);

          const dest = routeDestination(
            meta.title,
            meta.year,
            detectedType,
            selectedRemote,
            parsedSeason
          );
          setDestFolder(normalizeDestinationRemoteFolder(dest, selectedRemote));
        } else {
          setDestFolder(
            normalizeDestinationRemoteFolder(
              routeDestination(titleCandidate, parsedYear, detectedType, selectedRemote, parsedSeason),
              selectedRemote
            )
          );
        }
      })
      .catch((e) => {
        console.warn("Metadata lookup skipped:", e);
        setDestFolder(
          normalizeDestinationRemoteFolder(
            routeDestination(titleCandidate, parsedYear, detectedType, selectedRemote, parsedSeason),
            selectedRemote
          )
        );
      })
      .finally(() => {
        setLoadingMeta(false);
      });
  }, [isOpen, sourceInput, isBatchMode, sourceItems, isCloudRemoteSource, initialTitle, mediaType, libraries, tmdbApiKey, routeDestination]);

  if (!isOpen) return null;

  // Search online via Cinemeta and TMDB
  const handleSearchOnline = async (searchQ?: string) => {
    if (currentMediaType === "adult") {
      addToast("Online metadata matching is disabled for Adult content.", "info");
      return;
    }
    const q = (searchQ !== undefined ? searchQ : searchQuery).trim();
    if (!q) return;
    setSearching(true);
    setSearchResults([]);

    try {
      const list: TranscodeSearchResult[] = [];

      // Query Cinemeta (movie & series)
      const cinemetaTypes = currentMediaType === "tv" ? ["series", "movie"] : ["movie", "series"];
      for (const cType of cinemetaTypes) {
        try {
          const res = await safeFetch(
            `https://v3-cinemeta.strem.io/catalog/${cType}/top/search=${encodeURIComponent(q)}.json`
          );
          if (res && res.ok) {
            const data = await res.json();
            (data.metas || []).slice(0, 8).forEach((m: any) => {
              const rawYear = (m.year as string) || (m.releaseInfo as string);
              const y = rawYear ? parseInt(String(rawYear).split("-")[0], 10) : undefined;
              list.push({
                id: m.id || `${cType}-${m.name}`,
                title: m.name || q,
                year: isNaN(y as number) ? undefined : y,
                posterUrl: m.poster as string | undefined,
                backdropUrl: m.background as string | undefined,
                overview: m.description as string | undefined,
                genres: Array.isArray(m.genres) ? m.genres : undefined,
                source: "cinemeta",
                type: cType === "series" ? "series" : "movie",
              });
            });
          }
        } catch (err) {
          console.warn(`Cinemeta search failed for ${cType}:`, err);
        }
      }

      // Query TMDB if API key is configured
      if (tmdbApiKey) {
        const tmdbTypes = currentMediaType === "tv" ? ["tv", "movie"] : ["movie", "tv"];
        for (const tType of tmdbTypes) {
          try {
            const res = await safeFetch(
              `https://api.themoviedb.org/3/search/${tType}?query=${encodeURIComponent(q)}&language=en-US&page=1`,
              { headers: { Authorization: `Bearer ${tmdbApiKey}` } }
            );
            if (res && res.ok) {
              const data = await res.json();
              (data.results || []).slice(0, 6).forEach((r: any) => {
                const date = r.release_date || r.first_air_date || "";
                const y = date ? parseInt(date.split("-")[0], 10) : undefined;
                list.push({
                  id: `tmdb-${r.id}`,
                  title: r.title || r.name || q,
                  year: isNaN(y as number) ? undefined : y,
                  posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : undefined,
                  backdropUrl: r.backdrop_path ? `https://image.tmdb.org/t/p/original${r.backdrop_path}` : undefined,
                  overview: r.overview || undefined,
                  source: "tmdb",
                  type: tType === "tv" ? "series" : "movie",
                });
              });
            }
          } catch (err) {
            console.warn(`TMDB search failed for ${tType}:`, err);
          }
        }
      }

      setSearchResults(list);
    } catch (err) {
      console.error("Search error in transcode modal:", err);
    } finally {
      setSearching(false);
    }
  };

  // Apply an online search match
  const handleApplyMatch = (result: TranscodeSearchResult) => {
    const targetType: LibraryType = result.type === "series" ? "tv" : "movies";
    setCurrentMediaType(targetType);

    const updatedMeta: MatchedMetadata = {
      title: result.title,
      year: result.year,
      overview: result.overview,
      posterUrl: result.posterUrl,
      backdropUrl: result.backdropUrl,
      genres: result.genres,
      metadataSource: result.source,
      metadataId: result.id,
    };
    setMatchedMeta(updatedMeta);

    const fullTitle = result.year ? `${result.title} (${result.year})` : result.title;
    setCleanTitle(fullTitle);

    const sNum = manualSeason ? parseInt(manualSeason, 10) : 1;
    const eNum = manualEpisode ? parseInt(manualEpisode, 10) : 1;
    const fname = generateFilename(
      result.title,
      targetType,
      targetType === "tv" ? sNum : undefined,
      targetType === "tv" ? eNum : undefined
    );
    setOutputFilename(fname);

    const newDest = routeDestination(
      result.title,
      result.year,
      targetType,
      selectedRemote,
      targetType === "tv" ? sNum : undefined
    );
    setDestFolder(newDest);

    // Sync manual fields
    setManualTitle(result.title);
    setManualYear(result.year ? String(result.year) : "");
    setManualPoster(result.posterUrl || "");
    setManualOverview(result.overview || "");
    setManualType(targetType);

    setShowFixMatch(false);
    addToast(`Matched metadata to "${fullTitle}"`, "success");
  };

  // Save manual edit
  const handleSaveManual = () => {
    const t = manualTitle.trim() || cleanTitle;
    const y = manualYear.trim() ? parseInt(manualYear.trim(), 10) : undefined;
    const validYear = isNaN(y as number) ? undefined : y;
    const targetType = manualType;
    setCurrentMediaType(targetType);

    const sNum = manualSeason.trim() ? parseInt(manualSeason.trim(), 10) : 1;
    const eNum = manualEpisode.trim() ? parseInt(manualEpisode.trim(), 10) : 1;

    const updatedMeta: MatchedMetadata = {
      title: t,
      year: validYear,
      overview: manualOverview.trim() || undefined,
      posterUrl: manualPoster.trim() || undefined,
      metadataSource: "manual",
      ...(targetType === "tv"
        ? {
            season: isNaN(sNum) ? 1 : sNum,
            episode: isNaN(eNum) ? 1 : eNum,
            showTitle: t,
          }
        : {}),
    };
    setMatchedMeta(updatedMeta);

    const fullTitle = validYear ? `${t} (${validYear})` : t;
    setCleanTitle(fullTitle);

    const fname = generateFilename(
      t,
      targetType,
      targetType === "tv" ? sNum : undefined,
      targetType === "tv" ? eNum : undefined
    );
    setOutputFilename(fname);

    const newDest = routeDestination(
      t,
      validYear,
      targetType,
      selectedRemote,
      targetType === "tv" ? sNum : undefined
    );
    setDestFolder(newDest);

    setShowFixMatch(false);
    addToast(`Manual metadata saved for "${fullTitle}"`, "success");
  };

  // Reset to original filename stem
  const handleResetToFilename = () => {
    let rawName = rawSourceTitleRef.current || initialTitle || "";
    if (!rawName) {
      if (isCloudRemoteSource) {
        const parts = sourceInput.split(/[/:]/);
        rawName = parts[parts.length - 1] || "";
      } else {
        try {
          const u = new URL(sourceInput);
          rawName = decodeURIComponent(u.pathname.split("/").pop() || "");
        } catch {
          rawName = sourceInput;
        }
      }
    }
    const stem = rawName.replace(/\.[^/.]+$/, "");
    const cleaned =
      stem
        .replace(/\{tmdb-\d+\}/gi, "")
        .replace(/\{imdb-tt\d+\}/gi, "")
        .replace(/\[\d+p\]/gi, "")
        .replace(/\b(1080p|720p|2160p|4k|bluray|web-dl|x264|x265|hevc|av1)\b/gi, "")
        .replace(/[_.]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim() || stem || "Video";

    setMatchedMeta(null);
    setCleanTitle(cleaned);
    setOutputFilename(`${cleaned.replace(/[/\\?%*:|"<>]/g, "")}_AV1.mp4`);
    const dest = routeDestination(cleaned, undefined, currentMediaType, selectedRemote);
    setDestFolder(normalizeDestinationRemoteFolder(dest, selectedRemote));

    setManualTitle(cleaned);
    setManualYear("");
    setManualPoster("");
    setManualOverview("");

    setShowFixMatch(false);
    addToast(`Reset metadata to clean filename "${cleaned}"`, "info");
  };

  // Launch Cloud Transcode (Single or Batch)
  const handleLaunch = async () => {
    if (workerProvider === "kaggle" && !isKaggleConfigured) {
      setErrorMsg("Kaggle username and API key are required. Please configure them in Settings -> Cloud Transcoder.");
      return;
    }
    if (workerProvider === "github_actions" && !isGhaConfigured) {
      setErrorMsg("GitHub Actions runner is not configured. Please configure it in Settings -> GitHub Actions.");
      return;
    }
    if (workerProvider === "auto" && !isKaggleConfigured && !isGhaConfigured) {
      setErrorMsg("Please configure either Kaggle or GitHub Actions in Settings before dispatching.");
      return;
    }

    const isOffloadDest = isOffloadDestinationRemote(selectedRemote);
    if (!isOffloadDest && !destFolder.trim()) {
      setErrorMsg("Please specify a valid destination remote folder.");
      return;
    }

    setIsSubmitting(true);
    setErrorMsg("");

    const jobId = `transcode-${Date.now()}`;
    const cleanDestFolder = isOffloadDest
      ? `${selectedRemote.trim().replace(/:.*$/, "")}:`
      : normalizeDestinationRemoteFolder(destFolder, selectedRemote);
    const targetFile = isBatchMode ? "" : (outputFilename.trim() || `${cleanTitle}_AV1.mp4`);

    const sNum = manualSeason ? parseInt(manualSeason, 10) : 1;
    const eNum = manualEpisode ? parseInt(manualEpisode, 10) : 1;

    const finalMeta: MatchedMetadata = {
      ...(matchedMeta || { title: cleanTitle }),
      title: matchedMeta?.title || cleanTitle,
      ...(currentMediaType === "tv" && !isBatchMode
        ? {
            season: isNaN(sNum) ? 1 : sNum,
            episode: isNaN(eNum) ? 1 : eNum,
            showTitle: matchedMeta?.title || cleanTitle,
          }
        : {}),
    };

    const batchPaths =
      isBatchMode && sourceItems && sourceItems.length > 0
        ? sourceItems.map((it) => it.path.trim()).filter(Boolean)
        : undefined;

    try {
      const dispatchRes = await dispatchCloudTask({
        jobType: "video_transcode",
        payload: {
          job_id: jobId,
          source_input: sourceInput.trim(),
          source_items: batchPaths,
          dest_remote_folder: cleanDestFolder,
          delete_original: isCloudRemoteSource ? deleteOriginal : false,
          output_filename: isBatchMode ? undefined : targetFile,
          crf,
          preset,
          max_height: maxHeight,
          rclone_config_snippet: rcloneConfigContent || undefined,
          telegram_bot_token: telegramConfig?.botToken?.trim() || undefined,
          telegram_chat_id: telegramConfig?.chatId?.trim() || undefined,
          telegram_api_id: telegramConfig?.apiId?.trim() || undefined,
          telegram_api_hash: telegramConfig?.apiHash?.trim() || undefined,
          streamtape_api_login: streamtapeConfig?.apiLogin?.trim() || undefined,
          streamtape_api_key: streamtapeConfig?.apiKey?.trim() || undefined,
        },
        title: cleanTitle,
        providerOverride: workerProvider,
      });

      // Save job in cloud transcode store
      addCloudJob({
        id: jobId,
        title: cleanTitle,
        kernelSlug: dispatchRes.kernelSlug || dispatchRes.jobId,
        kernelUrl: dispatchRes.url,
        sourceInput: sourceInput.trim(),
        destRemoteFolder: cleanDestFolder,
        targetFilename: targetFile,
        targetLibraryId: autoRouteLibrary?.id,
        targetLibraryType: currentMediaType,
        matchedMetadata: finalMeta,
        deleteOriginal: isCloudRemoteSource ? deleteOriginal : false,
        status: "queued",
        startedAt: Date.now(),
        provider: dispatchRes.provider,
      });

      // Ensure background poller is running if Kaggle
      if (dispatchRes.provider === "kaggle") {
        initCloudTranscodePoller();
      }

      const workerLabel = dispatchRes.provider === "github_actions" ? "GitHub Actions Runner" : "Kaggle Cloud Transcoder (4-vCPU AV1)";
      addToast(
        `🚀 Dispatched "${cleanTitle}" to ${workerLabel}!`,
        "success",
        6000
      );

      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || String(err) || "Failed to dispatch Kaggle job");
    } finally {
      setIsSubmitting(false);
    }
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
            <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
              <Zap size={20} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text">Cloud Transcode to SVT-AV1</h2>
              <p className="text-xs text-subtle">
                {workerProvider === "github_actions"
                  ? "GitHub Actions Runner • Auto Library Routing • Archival to OdriveCrypt"
                  : workerProvider === "kaggle"
                  ? "Kaggle 4-vCPU Cloud Worker • Auto Library Routing • Archival to OdriveCrypt"
                  : "Auto Multi-Cloud Worker • Auto Library Routing • Archival to OdriveCrypt"}
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
          {/* Missing Credentials Notice */}
          {workerProvider === "kaggle" && !isKaggleConfigured && (
            <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-800/40 flex items-start gap-3">
              <AlertCircle size={18} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-200 leading-relaxed">
                <strong>Kaggle Credentials Required:</strong> Please configure Kaggle in <strong>Settings → Cloud Transcoder</strong> before dispatching to Kaggle.
              </div>
            </div>
          )}
          {workerProvider === "github_actions" && !isGhaConfigured && (
            <div className="p-3.5 rounded-xl bg-purple-950/40 border border-purple-800/40 flex items-start gap-3">
              <AlertCircle size={18} className="text-purple-400 shrink-0 mt-0.5" />
              <div className="text-xs text-purple-200 leading-relaxed">
                <strong>GitHub Actions Runner Required:</strong> Please configure your token, repo owner, and repo name in <strong>Settings → GitHub Actions</strong> before dispatching.
              </div>
            </div>
          )}
          {workerProvider === "auto" && !isKaggleConfigured && !isGhaConfigured && (
            <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-800/40 flex items-start gap-3">
              <AlertCircle size={18} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-200 leading-relaxed">
                <strong>Cloud Credentials Required:</strong> Please set up either Kaggle or GitHub Actions in <strong>Settings</strong> to enable offloaded cloud transcoding.
              </div>
            </div>
          )}

          {/* Error Banner */}
          {errorMsg && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-3.5 rounded-xl bg-red-950/40 border border-red-800/40 flex items-start gap-3"
            >
              <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-200 leading-relaxed">{errorMsg}</p>
            </motion.div>
          )}

          {/* Source Preview Card & Inline Metadata Editor */}
          <div className="p-4 rounded-xl bg-surface/40 border border-border/80 flex flex-col gap-3">
            <div className="flex items-start gap-4">
              {matchedMeta?.posterUrl || initialPoster ? (
                <img
                  src={matchedMeta?.posterUrl || initialPoster}
                  alt={cleanTitle}
                  className="w-16 h-24 object-cover rounded-lg shadow-md shrink-0 bg-void"
                />
              ) : (
                <div className="w-16 h-24 rounded-lg bg-panel border border-border flex items-center justify-center shrink-0 text-subtle">
                  {currentMediaType === "tv" ? <Tv size={24} /> : <Film size={24} />}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-accent/15 text-accent border border-accent/20">
                    {isCloudRemoteSource ? "Cloud Remote Source" : "Web Stream"}
                  </span>
                  <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-panel text-subtle border border-border">
                    {currentMediaType === "tv" ? "TV Series" : "Movie"}
                  </span>
                  {loadingMeta && <Loader2 size={12} className="animate-spin text-accent" />}
                  <button
                    type="button"
                    onClick={() => {
                      const next = !showFixMatch;
                      setShowFixMatch(next);
                      if (next && searchResults.length === 0) {
                        const q = cleanTitle.replace(/\s*\(\d{4}\)$/, "").trim();
                        setSearchQuery(q);
                        handleSearchOnline(q);
                      }
                    }}
                    className="ml-auto px-2.5 py-1 rounded-lg bg-accent/15 hover:bg-accent/25 text-accent text-xs font-medium flex items-center gap-1.5 transition-colors border border-accent/20 shrink-0"
                    title="Edit or fix metadata match"
                  >
                    <Edit3 size={13} />
                    <span>{showFixMatch ? "Close Edit" : "Edit Match"}</span>
                  </button>
                </div>
                <h3 className="text-sm font-semibold text-text mt-1.5 truncate">
                  {cleanTitle}
                </h3>
                <p className="text-[11px] font-mono text-subtle truncate mt-0.5">
                  {sourceInput}
                </p>
                {matchedMeta?.overview && (
                  <p className="text-xs text-subtle/80 line-clamp-2 mt-1.5 font-body">
                    {matchedMeta.overview}
                  </p>
                )}
              </div>
            </div>

            {/* Expandable Fix Match Panel */}
            <AnimatePresence>
              {showFixMatch && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="pt-3 border-t border-border/60 space-y-3"
                >
                  {/* Tab Navigation */}
                  <div className="flex border-b border-border bg-panel/40 rounded-t-xl px-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setFixMatchTab("search")}
                      className={`flex items-center gap-1.5 pb-2 px-3 text-xs font-semibold border-b-2 transition-all ${
                        fixMatchTab === "search"
                          ? "border-accent text-accent"
                          : "border-transparent text-subtle hover:text-text"
                      }`}
                    >
                      <Search size={12} />
                      Search Online
                    </button>
                    <button
                      type="button"
                      onClick={() => setFixMatchTab("manual")}
                      className={`flex items-center gap-1.5 pb-2 px-3 text-xs font-semibold border-b-2 transition-all ${
                        fixMatchTab === "manual"
                          ? "border-accent text-accent"
                          : "border-transparent text-subtle hover:text-text"
                      }`}
                    >
                      <Edit3 size={12} />
                      Manual Edit
                    </button>
                  </div>

                  {fixMatchTab === "search" ? (
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handleSearchOnline()}
                          placeholder="Search movie or TV title..."
                          className="flex-1 bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-text focus:outline-none focus:border-accent"
                        />
                        <button
                          type="button"
                          onClick={() => handleSearchOnline()}
                          disabled={searching}
                          className="px-3 py-1.5 bg-accent text-void rounded-xl text-xs font-semibold flex items-center gap-1.5 hover:bg-accent/90 disabled:opacity-50"
                        >
                          {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                          <span>Search</span>
                        </button>
                      </div>

                      {/* Results List */}
                      <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                        {searchResults.length === 0 && !searching && (
                          <div className="text-center py-4 text-xs text-subtle space-y-2">
                            <p>No matches found. You can edit fields manually or reset to raw filename.</p>
                            <div className="flex items-center justify-center gap-2">
                              <button
                                type="button"
                                onClick={() => setFixMatchTab("manual")}
                                className="px-3 py-1 rounded-lg bg-surface border border-border text-xs text-text hover:bg-panel flex items-center gap-1.5"
                              >
                                <Edit3 size={12} />
                                <span>Manual Edit</span>
                              </button>
                              <button
                                type="button"
                                onClick={handleResetToFilename}
                                className="px-3 py-1 rounded-lg bg-surface border border-border text-xs text-text hover:bg-panel flex items-center gap-1.5"
                              >
                                <RotateCcw size={12} />
                                <span>Reset to Filename</span>
                              </button>
                            </div>
                          </div>
                        )}

                        {searchResults.map((res) => (
                          <div
                            key={res.id}
                            className="p-2.5 rounded-xl bg-panel/70 border border-border/70 hover:border-accent/50 flex items-start gap-3 transition-colors"
                          >
                            <div className="w-10 h-14 rounded-lg overflow-hidden bg-void flex-shrink-0 border border-border/50">
                              {res.posterUrl ? (
                                <img src={res.posterUrl} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-subtle text-[10px]">
                                  No Art
                                </div>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-text truncate">{res.title}</span>
                                {res.year && <span className="text-[11px] text-subtle">({res.year})</span>}
                                <span className="px-1.5 py-0.5 rounded bg-surface text-[9px] font-mono uppercase text-subtle ml-auto border border-border/40">
                                  {res.source}
                                </span>
                              </div>
                              {res.overview && (
                                <p className="text-[11px] text-subtle/80 line-clamp-1 mt-0.5">{res.overview}</p>
                              )}
                              <div className="flex items-center gap-2 mt-2">
                                <button
                                  type="button"
                                  onClick={() => handleApplyMatch(res)}
                                  className="px-2.5 py-1 rounded-lg bg-accent text-void font-semibold text-[11px] flex items-center gap-1 hover:bg-accent/90"
                                >
                                  <Check size={11} />
                                  <span>Apply Match</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setManualTitle(res.title);
                                    setManualYear(res.year ? String(res.year) : "");
                                    setManualPoster(res.posterUrl || "");
                                    setManualOverview(res.overview || "");
                                    setManualType(res.type === "series" ? "tv" : "movies");
                                    setFixMatchTab("manual");
                                  }}
                                  className="px-2.5 py-1 rounded-lg bg-surface border border-border text-subtle hover:text-text text-[11px] flex items-center gap-1"
                                >
                                  <Edit3 size={11} />
                                  <span>Customize</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    /* Manual Edit Tab */
                    <div className="space-y-3">
                      <div className="grid grid-cols-3 gap-2">
                        <div className="col-span-2 space-y-1">
                          <label className="text-[11px] text-subtle block">Title</label>
                          <input
                            type="text"
                            value={manualTitle}
                            onChange={(e) => setManualTitle(e.target.value)}
                            placeholder="e.g. Inception"
                            className="w-full bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-text focus:outline-none focus:border-accent"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[11px] text-subtle block">Release Year</label>
                          <input
                            type="number"
                            value={manualYear}
                            onChange={(e) => setManualYear(e.target.value)}
                            placeholder="e.g. 2010"
                            className="w-full bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-text focus:outline-none focus:border-accent"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        <div className="space-y-1">
                          <label className="text-[11px] text-subtle block">Media Type</label>
                          <select
                            value={manualType}
                            onChange={(e) => setManualType(e.target.value as LibraryType)}
                            className="w-full bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-text focus:outline-none focus:border-accent"
                          >
                            <option value="movies">Movie</option>
                            <option value="tv">TV Series</option>
                          </select>
                        </div>
                        {manualType === "tv" && (
                          <>
                            <div className="space-y-1">
                              <label className="text-[11px] text-subtle block">Season</label>
                              <input
                                type="number"
                                min={1}
                                value={manualSeason}
                                onChange={(e) => setManualSeason(e.target.value)}
                                placeholder="1"
                                className="w-full bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-text focus:outline-none focus:border-accent"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[11px] text-subtle block">Episode</label>
                              <input
                                type="number"
                                min={1}
                                value={manualEpisode}
                                onChange={(e) => setManualEpisode(e.target.value)}
                                placeholder="1"
                                className="w-full bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-text focus:outline-none focus:border-accent"
                              />
                            </div>
                          </>
                        )}
                      </div>

                      <div className="space-y-1">
                        <label className="text-[11px] text-subtle block">Poster Image URL</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={manualPoster}
                            onChange={(e) => setManualPoster(e.target.value)}
                            placeholder="https://image.tmdb.org/t/p/w500/..."
                            className="flex-1 bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-text focus:outline-none focus:border-accent"
                          />
                          {manualPoster && (
                            <div className="w-8 h-8 rounded-lg overflow-hidden border border-border shrink-0 bg-void">
                              <img src={manualPoster} alt="" className="w-full h-full object-cover" />
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[11px] text-subtle block">Overview / Synopsis</label>
                        <textarea
                          rows={2}
                          value={manualOverview}
                          onChange={(e) => setManualOverview(e.target.value)}
                          placeholder="Plot summary..."
                          className="w-full bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-text focus:outline-none focus:border-accent resize-none"
                        />
                      </div>

                      <div className="flex items-center justify-between pt-1">
                        <button
                          type="button"
                          onClick={handleResetToFilename}
                          className="px-3 py-1.5 rounded-xl border border-border text-xs text-subtle hover:text-text hover:bg-surface flex items-center gap-1.5 transition-colors"
                        >
                          <RotateCcw size={12} />
                          <span>Reset to Filename</span>
                        </button>

                        <button
                          type="button"
                          onClick={handleSaveManual}
                          className="px-4 py-1.5 rounded-xl bg-accent text-void font-semibold text-xs flex items-center gap-1.5 hover:bg-accent/90 transition-all shadow-md shadow-accent/20"
                        >
                          <Check size={13} />
                          <span>Save & Apply Metadata</span>
                        </button>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Destination & Library Auto-Routing */}
          <div className="space-y-3">
            <label className="text-xs font-semibold text-text flex items-center gap-2">
              <HardDrive size={14} className="text-accent" />
              Destination Remote & Auto-Routing
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <span className="text-[11px] text-subtle">Remote Storage</span>
                <select
                  value={selectedRemote}
                  onChange={(e) => {
                    const r = e.target.value;
                    setSelectedRemote(r);
                    if (isOffloadDestinationRemote(r)) {
                      setDestFolder("");
                    } else if (isBatchMode) {
                      const sub = destFolder.includes(":") ? destFolder.slice(destFolder.indexOf(":") + 1) : destFolder;
                      setDestFolder(normalizeDestinationRemoteFolder(sub || "/Converted_Videos/", r));
                    } else {
                      const newDest = routeDestination(
                        matchedMeta?.title || cleanTitle,
                        matchedMeta?.year,
                        currentMediaType,
                        r,
                        manualSeason ? parseInt(manualSeason, 10) : undefined
                      );
                      setDestFolder(normalizeDestinationRemoteFolder(newDest, r));
                    }
                  }}
                  className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-xs text-text focus:outline-none focus:border-accent"
                >
                  <optgroup label="Cloud Storage Remotes">
                    {remotes.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name} {r.name.toLowerCase() === "odrivecrypt" ? "(Archival Default)" : `(${r.type})`}
                      </option>
                    ))}
                    {remotes.length === 0 && (
                      <option value="odrivecrypt">odrivecrypt (Default)</option>
                    )}
                  </optgroup>
                  <optgroup label="Direct Cloud Offload Services">
                    {!remotes.some((r) => r.name.toLowerCase() === "telegram") && (
                      <option value="telegram">
                        ✈️ telegram (Direct MTProto / Channel Offload)
                      </option>
                    )}
                    {!remotes.some((r) => r.name.toLowerCase() === "streamtape") && (
                      <option value="streamtape">
                        📼 streamtape (Direct Cloud Edge Offload)
                      </option>
                    )}
                  </optgroup>
                </select>
              </div>

              <div className="sm:col-span-2 space-y-1">
                <span className="text-[11px] text-subtle">
                  {isOffloadDestinationRemote(selectedRemote) ? (
                    <>
                      Target Destination Folder (<code className="text-accent">Empty — uploads directly to {selectedRemote} root</code>)
                    </>
                  ) : (
                    <>
                      Target Destination Folder (Normalized: <code className="text-accent">{normalizeDestinationRemoteFolder(destFolder, selectedRemote)}</code>)
                    </>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={isOffloadDestinationRemote(selectedRemote) ? "" : destFolder}
                    disabled={isOffloadDestinationRemote(selectedRemote)}
                    onChange={(e) => setDestFolder(e.target.value)}
                    onBlur={() => setDestFolder(normalizeDestinationRemoteFolder(destFolder, selectedRemote))}
                    placeholder={
                      isOffloadDestinationRemote(selectedRemote)
                        ? "Root upload (destination path is always empty for this remote)"
                        : `${selectedRemote}:/Converted_Videos/`
                    }
                    className="flex-1 bg-surface border border-border rounded-xl px-3 py-2 text-xs font-mono text-text focus:outline-none focus:border-accent disabled:opacity-60 disabled:cursor-not-allowed"
                  />
                  {!isOffloadDestinationRemote(selectedRemote) && (
                    <button
                      type="button"
                      onClick={() => setShowDestBrowser(true)}
                      className="px-3 py-2 rounded-xl bg-panel hover:bg-surface border border-border text-xs font-body text-bright flex items-center gap-1.5 shrink-0 transition-colors"
                      title="Browse cloud remote folders"
                    >
                      <FolderOpen size={13} className="text-accent" />
                      <span>Browse</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {selectedRemote === "telegram" ? (
              <div className="p-2.5 rounded-lg bg-surface/30 border border-border/40 text-[11px] text-subtle space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white/90">Telegram MTProto Offloader (Telethon)</span>
                  {telegramConfig?.botToken ? (
                    <span className="text-emerald-400 font-mono text-[10px]">● Bot Configured</span>
                  ) : (
                    <span className="text-amber-400 font-mono text-[10px]">⚠️ Bot Token Missing in Settings</span>
                  )}
                </div>
                <p>
                  Transcoded AV1 video is directly offloaded to your Telegram channel (up to <strong>2,000 MB / 2 GB</strong>) without using local bandwidth.
                </p>
              </div>
            ) : selectedRemote === "streamtape" ? (
              <div className="p-2.5 rounded-lg bg-surface/30 border border-border/40 text-[11px] text-subtle space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white/90">Streamtape Direct Cloud Upload</span>
                  {streamtapeConfig?.apiKey ? (
                    <span className="text-emerald-400 font-mono text-[10px]">● API Ready</span>
                  ) : (
                    <span className="text-amber-400 font-mono text-[10px]">⚠️ API Key Missing in Settings</span>
                  )}
                </div>
                <p>
                  Transcoded AV1 video is uploaded directly to Streamtape CDN servers. Watch link and playable embed will be saved automatically.
                </p>
              </div>
            ) : null}

            {showDestBrowser && (
              <RemoteBrowser
                remoteName={selectedRemote}
                remoteType={remotes.find((r) => r.name === selectedRemote)?.type || "drive"}
                rcloneConfigPath={rcloneConfigPath}
                initialPath={normalizeDestinationRemoteFolder(destFolder, selectedRemote)}
                availableRemotes={remotes}
                onRemoteChange={(newRem) => {
                  setSelectedRemote(newRem);
                  setDestFolder(`${newRem}:/`);
                }}
                selectLabel="Use Destination Folder"
                onSelect={(pickedPath) => {
                  const colon = pickedPath.indexOf(":");
                  if (colon !== -1) {
                    const pickedRemote = pickedPath.slice(0, colon);
                    setSelectedRemote(pickedRemote);
                    setDestFolder(normalizeDestinationRemoteFolder(pickedPath, pickedRemote));
                  } else {
                    setDestFolder(normalizeDestinationRemoteFolder(pickedPath, selectedRemote));
                  }
                  setShowDestBrowser(false);
                }}
                onClose={() => setShowDestBrowser(false)}
              />
            )}

            {autoRouteLibrary && (
              <div className="p-2.5 rounded-xl bg-accent/5 border border-accent/20 flex items-center gap-2 text-xs text-accent">
                <CheckCircle2 size={14} />
                <span>
                  Auto-routing to <strong>{autoRouteLibrary.name}</strong> library on completion!
                </span>
              </div>
            )}
          </div>

          {/* Worker Execution Provider Selection */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-text flex items-center gap-2">
              <Zap size={14} className="text-accent" />
              Worker Execution Provider
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 font-mono text-xs">
              {/* Auto */}
              <button
                type="button"
                onClick={() => setWorkerProvider("auto")}
                className={`p-3 rounded-xl border text-left transition-all ${
                  workerProvider === "auto"
                    ? "bg-accent/15 border-accent text-bright shadow-sm ring-1 ring-accent"
                    : "bg-surface/30 border-border/70 hover:bg-surface/60 text-subtle hover:text-bright"
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1 font-semibold text-bright">
                  <Zap size={14} className="text-accent" />
                  <span>Auto Rotate</span>
                </div>
                <p className="text-[10px] text-subtle font-body leading-tight">
                  Kaggle 4-vCPU ({activeKaggleJobs}/2 active) with automatic overflow to GitHub Actions.
                </p>
              </button>

              {/* GitHub Actions */}
              <button
                type="button"
                onClick={() => setWorkerProvider("github_actions")}
                className={`p-3 rounded-xl border text-left transition-all ${
                  workerProvider === "github_actions"
                    ? "bg-purple-500/15 border-purple-500 text-bright shadow-sm ring-1 ring-purple-500"
                    : "bg-surface/30 border-border/70 hover:bg-surface/60 text-subtle hover:text-bright"
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1 font-semibold text-bright">
                  <GitBranch size={14} className="text-purple-400" />
                  <span>GitHub Actions</span>
                </div>
                <p className="text-[10px] text-subtle font-body leading-tight">
                  {isGhaConfigured
                    ? `${ghaConfig?.owner}/${ghaConfig?.repo} runner.`
                    : "Configure in Settings."}
                </p>
              </button>

              {/* Kaggle 4-vCPU */}
              <button
                type="button"
                onClick={() => setWorkerProvider("kaggle")}
                className={`p-3 rounded-xl border text-left transition-all ${
                  workerProvider === "kaggle"
                    ? "bg-teal/15 border-teal text-bright shadow-sm ring-1 ring-teal"
                    : "bg-surface/30 border-border/70 hover:bg-surface/60 text-subtle hover:text-bright"
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1 font-semibold text-bright">
                  <Cpu size={14} className="text-teal" />
                  <span>Kaggle 4-vCPU</span>
                </div>
                <p className="text-[10px] text-subtle font-body leading-tight">
                  {isKaggleConfigured
                    ? `@${kaggleUsername} (${activeKaggleJobs}/2 active, zero GPU quota).`
                    : "Missing credentials."}
                </p>
              </button>
            </div>
          </div>

          {/* Output Filename */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-text">Output Filename</label>
            <input
              type="text"
              value={outputFilename}
              onChange={(e) => setOutputFilename(e.target.value)}
              className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-xs font-mono text-text focus:outline-none focus:border-accent"
            />
          </div>

          {/* Options */}
          <div className="pt-2 border-t border-border/60 space-y-2.5">
            {isCloudRemoteSource && (
              <label className="flex items-center gap-2.5 cursor-pointer text-xs text-text hover:text-bright select-none">
                <input
                  type="checkbox"
                  checked={deleteOriginal}
                  onChange={(e) => setDeleteOriginal(e.target.checked)}
                  className="rounded border-border bg-surface text-accent focus:ring-0 w-4 h-4 cursor-pointer"
                />
                <span className="flex items-center gap-1.5">
                  <Trash2 size={13} className="text-red-400" />
                  Delete uncompressed source file from remote once verified (frees cloud space)
                </span>
              </label>
            )}

            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1.5 text-xs text-subtle hover:text-text transition-colors mt-2"
            >
              <Sliders size={13} />
              <span>{showAdvanced ? "Hide Advanced Settings" : "Configure Codec & Quality Options"}</span>
            </button>

            {showAdvanced && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="p-3.5 rounded-xl bg-surface/20 border border-border grid grid-cols-3 gap-3 text-xs"
              >
                <div>
                  <span className="text-[11px] text-subtle block mb-1">Preset (Speed)</span>
                  <select
                    value={preset}
                    onChange={(e) => setPreset(Number(e.target.value))}
                    className="w-full bg-surface border border-border rounded-lg px-2.5 py-1.5 text-xs text-text"
                  >
                    <option value={7}>Preset 7 (Slower, Highest Compression)</option>
                    <option value={8}>Preset 8 (Balanced Efficiency)</option>
                    <option value={9}>Preset 9 (Fast - Recommended)</option>
                    <option value={10}>Preset 10 (Ultra Fast)</option>
                  </select>
                </div>

                <div>
                  <span className="text-[11px] text-subtle block mb-1">CRF (Quality)</span>
                  <input
                    type="number"
                    min={18}
                    max={36}
                    value={crf}
                    onChange={(e) => setCrf(Number(e.target.value))}
                    className="w-full bg-surface border border-border rounded-lg px-2.5 py-1.5 text-xs text-text"
                  />
                </div>

                <div>
                  <span className="text-[11px] text-subtle block mb-1">Max Resolution</span>
                  <select
                    value={maxHeight}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setMaxHeight(val);
                      if (val === 1081) {
                        // Intelligent 720p -> 1080p Upscale preset
                        setPreset(8);
                        setCrf(22);
                      }
                    }}
                    className="w-full bg-surface border border-border rounded-lg px-2.5 py-1.5 text-xs text-text"
                  >
                    <option value={720}>720p Max</option>
                    <option value={1080}>1080p Max (Smart Cap)</option>
                    <option value={1081}>✨ Intelligent Upscale (720p ➔ 1080p CAS)</option>
                    <option value={2160}>4K (No Cap · 10-bit AV1)</option>
                  </select>
                </div>
              </motion.div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex items-center justify-between bg-surface/30">
          <div className="text-[11px] text-subtle flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            {workerProvider === "github_actions"
              ? "Runs in GitHub Actions Ubuntu Runner (0% local CPU)"
              : "Runs in isolated Kaggle 4-vCPU VM (0% local CPU)"}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl border border-border text-xs text-subtle hover:text-text hover:bg-surface transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleLaunch}
              disabled={
                isSubmitting ||
                (workerProvider === "kaggle" && !isKaggleConfigured) ||
                (workerProvider === "github_actions" && !isGhaConfigured) ||
                (workerProvider === "auto" && !isKaggleConfigured && !isGhaConfigured)
              }
              className="px-5 py-2 rounded-xl bg-accent text-void font-semibold text-xs flex items-center gap-2 hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-accent/20"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>
                    {workerProvider === "github_actions"
                      ? "Dispatching to GitHub Actions..."
                      : workerProvider === "kaggle"
                      ? "Dispatching to Kaggle..."
                      : "Dispatching Cloud Job..."}
                  </span>
                </>
              ) : (
                <>
                  <Zap size={14} />
                  <span>
                    {workerProvider === "github_actions"
                      ? "Dispatch to GitHub Actions"
                      : "Dispatch Cloud Transcode"}
                  </span>
                </>
              )}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
