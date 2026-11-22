import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Folder, FolderDown, Download, HardDrive, Search, FileText,
  Film, Music, FileArchive, FileImage, File, ArrowLeft, ChevronRight,
  ExternalLink, CheckCircle2, Loader2, RefreshCw, FolderOpen,
  CloudDownload, AlertCircle, Zap, BookOpen, ArrowRightLeft,
  Pencil, Trash2, Plus, Info, Copy, Check, Eye, Play, X, Wrench, Sparkles,
  ArrowUpDown, ArrowUp, ArrowDown, Globe, CloudUpload, Upload, FolderUp, Share2, ArchiveRestore
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, type MediaItem } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { startFolderDownload } from "../../lib/tauri";
import { CloudTranscodeModal } from "../../components/library/CloudTranscodeModal";
import { AudiobookConverterModal } from "../../components/audiobooks/AudiobookConverterModal";
import { CloudTransferModal } from "../../components/explorer/CloudTransferModal";
import { CloudTransferDrawer } from "../../components/explorer/CloudTransferDrawer";
import { FolderMatchModal } from "../../components/explorer/FolderMatchModal";
import { ShareStreamLinkModal } from "../../components/common/ShareStreamLinkModal";
import { useCloudTransferStore } from "../../lib/kaggleTransfer";
import {
  offloadRemotePathToDropmb,
  offloadRemoteFolderToDropmb,
  isDropmbEligibleExtension,
} from "../../lib/dropmbOffload";
import { offloadExplorerItemToTelegram } from "../../lib/telegramOffload";
import { RcloneSuiteToolbar, VerifyChecksumButton } from "../../components/explorer/RcloneSuiteToolbar";
import {
  restoreFromRcloneFlixAppTrash,
  inspectAppTrashPath,
  classifyDeleteItems,
  checkRemoteFreeSpaceWarning,
  notifyRemoteMutated,
  isAndroidRuntime,
} from "../../lib/rcloneNative";

type RcloneListItem = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mime_type?: string;
  mod_time?: string;
};

type DownloadProgress = {
  download_id: string;
  total_files: number;
  completed_files: number;
  current_file: string;
  destination_path: string;
  status: string; // "downloading" | "completed" | "error"
  error?: string;
};

function formatSize(bytes: number): string {
  if (bytes <= 0) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(isoString?: string): string {
  if (!isoString) return "--";
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "--";
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "--";
  }
}

function getFileIcon(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "mkv", "avi", "mov", "webm", "m4v"].includes(ext)) return Film;
  if (["mp3", "flac", "m4a", "wav", "aac", "ogg"].includes(ext)) return Music;
  if (["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"].includes(ext)) return FileImage;
  if (["zip", "tar", "gz", "7z", "rar"].includes(ext)) return FileArchive;
  if (["pdf", "epub", "txt", "md", "json"].includes(ext)) return FileText;
  return File;
}

const AUDIO_EXTS = ["mp3", "m4a", "aac", "flac", "ogg", "wav", "wma", "opus", "aiff"];

export function CloudExplorerPage() {
  const { remotes, rcloneConfigPath, libraries } = useAppStore();

  // Strictly exclude Guest Pass scoped remotes (shared_*) from Cloud Explorer
  const personalRemotes = useMemo(
    () => remotes.filter((r) => !r.name.startsWith("shared_")),
    [remotes]
  );

  const localLibraryPaths = useMemo(() => {
    const list: Array<{ label: string; path: string }> = [];
    const seen = new Set<string>();
    for (const lib of libraries) {
      if (lib.isSharedPass) continue;
      for (const p of lib.remotePaths || []) {
        const clean = p.trim();
        const isLocal =
          clean.startsWith("/") ||
          clean.startsWith("\\") ||
          /^[a-zA-Z]:[/\\]/.test(clean) ||
          clean.startsWith("local:");
        if (isLocal && !seen.has(clean)) {
          seen.add(clean);
          list.push({
            label: `${lib.name} (${clean})`,
            path: clean.startsWith("local:") ? clean.replace(/^local:/, "") : clean,
          });
        }
      }
    }
    return list;
  }, [libraries]);

  const explorerLastRemote = useAppStore((s) => s.explorerLastRemote);
  const explorerLastSegments = useAppStore((s) => s.explorerLastSegments);
  const setExplorerNavigationState = useAppStore((s) => s.setExplorerNavigationState);

  const [selectedRemote, setSelectedRemote] = useState<string>(() => {
    if (
      explorerLastRemote &&
      !explorerLastRemote.startsWith("shared_") &&
      (personalRemotes.some((r) => r.name === explorerLastRemote) ||
        localLibraryPaths.some((l) => l.path === explorerLastRemote))
    ) {
      return explorerLastRemote;
    }
    return personalRemotes.length > 0
      ? personalRemotes[0].name
      : localLibraryPaths.length > 0
      ? localLibraryPaths[0].path
      : "";
  });

  const [segments, setSegments] = useState<string[]>(() => {
    if (explorerLastRemote && explorerLastRemote === selectedRemote && Array.isArray(explorerLastSegments)) {
      return explorerLastSegments;
    }
    return [];
  });

  useEffect(() => {
    const isValidRemote =
      Boolean(selectedRemote) &&
      !selectedRemote.startsWith("shared_") &&
      (personalRemotes.some((r) => r.name === selectedRemote) ||
        localLibraryPaths.some((l) => l.path === selectedRemote));

    if (!isValidRemote) {
      if (
        explorerLastRemote &&
        (personalRemotes.some((r) => r.name === explorerLastRemote) ||
          localLibraryPaths.some((l) => l.path === explorerLastRemote))
      ) {
        setSelectedRemote(explorerLastRemote);
        setSegments(explorerLastSegments || []);
        return;
      }
      const fallback =
        personalRemotes.length > 0
          ? personalRemotes[0].name
          : localLibraryPaths.length > 0
          ? localLibraryPaths[0].path
          : "";
      if (fallback && fallback !== selectedRemote) {
        setSelectedRemote(fallback);
        setSegments([]);
      }
    }
  }, [selectedRemote, personalRemotes, localLibraryPaths, explorerLastRemote, explorerLastSegments]);

  useEffect(() => {
    if (selectedRemote) {
      setExplorerNavigationState(selectedRemote, segments);
    }
  }, [selectedRemote, segments, setExplorerNavigationState]);
  const [items, setItems] = useState<RcloneListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<"name" | "size" | "date">("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [activeDownloads, setActiveDownloads] = useState<Record<string, DownloadProgress>>({});
  const [transcodeTarget, setTranscodeTarget] = useState<{
    sourceInput: string;
    title: string;
    sourceItems?: Array<{ path: string; title: string; isDir?: boolean }>;
  } | null>(null);
  const [showAudiobookConverter, setShowAudiobookConverter] = useState(false);
  const [selectedBookForConvert, setSelectedBookForConvert] = useState<MediaItem[]>([]);
  const [folderConverting, setFolderConverting] = useState<string | null>(null);
  const [selectedItemNames, setSelectedItemNames] = useState<Set<string>>(new Set());
  const [transferTarget, setTransferTarget] = useState<{
    items: RcloneListItem[];
    isSingle: boolean;
    isUrl?: boolean;
    initialOperation?: "copy" | "move";
    initialWorker?: "local" | "auto";
  } | null>(null);
  const [showTransferDrawer, setShowTransferDrawer] = useState<boolean>(false);
  const [shareModalTarget, setShareModalTarget] = useState<{
    remoteName: string;
    filePath: string;
    fileName: string;
    fileSize?: number;
  } | null>(null);
  const navigate = useNavigate();

  // File Upload State
  const fileUploadRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgressMsg, setUploadProgressMsg] = useState("");

  // File Operations & Preview States
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);

  const [renameTarget, setRenameTarget] = useState<{ item: RcloneListItem; newName: string } | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<RcloneListItem[] | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [fileInfoTarget, setFileInfoTarget] = useState<{ item: RcloneListItem; fullPath: string; streamUrl?: string } | null>(null);
  const [copiedStreamUrl, setCopiedStreamUrl] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const activeSessionIdRef = useRef<string | null>(null);

  const stopActiveSession = useCallback(() => {
    if (activeSessionIdRef.current) {
      invoke("stop_stream_session", { sessionId: activeSessionIdRef.current }).catch(() => {});
      activeSessionIdRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopActiveSession();
    };
  }, [stopActiveSession]);

  const closeFileInfo = () => {
    stopActiveSession();
    setFileInfoTarget(null);
    setCopiedStreamUrl(false);
    setCopiedPath(false);
  };

  const [imagePreview, setImagePreview] = useState<{ url: string; title: string; size: number } | null>(null);
  const [imageBlobUrl, setImageBlobUrl] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<{ content: string; title: string; loading: boolean } | null>(null);
  const [folderMatchTarget, setFolderMatchTarget] = useState<{ folderPath: string; folderName: string } | null>(null);
  const [dropmbOffloadingItem, setDropmbOffloadingItem] = useState<string | null>(null);
  const [dropmbProgress, setDropmbProgress] = useState<{ pct: number; msg: string } | null>(null);
  const [telegramOffloadingItem, setTelegramOffloadingItem] = useState<string | null>(null);

  const handleOffloadSingleTelegram = async (item: RcloneListItem) => {
    const remoteFilePath = getItemFullPath(item.name);
    setTelegramOffloadingItem(item.name);
    try {
      await offloadExplorerItemToTelegram(
        selectedRemote,
        remoteFilePath,
        item.name,
        item.size
      );
    } catch (err: any) {
      console.error("Telegram offload error:", err);
    } finally {
      setTelegramOffloadingItem(null);
    }
  };

  const handleOffloadSingleDropmb = async (item: RcloneListItem) => {
    const remoteFilePath = getItemFullPath(item.name);

    setDropmbOffloadingItem(item.name);
    setDropmbProgress({ pct: 5, msg: `Initializing DropMB offload for ${item.name}...` });

    try {
      if (item.is_dir) {
        await offloadRemoteFolderToDropmb(
          rcloneConfigPath || "",
          selectedRemote,
          remoteFilePath,
          item.name,
          (pct, msg) => setDropmbProgress({ pct, msg })
        );
      } else {
        await offloadRemotePathToDropmb(
          rcloneConfigPath || "",
          selectedRemote,
          remoteFilePath,
          item.name,
          item.size,
          (pct, msg) => setDropmbProgress({ pct, msg })
        );
      }
    } finally {
      setDropmbOffloadingItem(null);
      setTimeout(() => setDropmbProgress(null), 3500);
    }
  };

  const handleOffloadBatchDropmb = async () => {
    if (selectedItemNames.size === 0) return;
    const selectedList = items.filter((it) => selectedItemNames.has(it.name));
    const eligibleList = selectedList.filter((it) => it.is_dir || isDropmbEligibleExtension(it.name));

    if (eligibleList.length === 0) {
      useToastStore.getState().addToast("No eligible files or folders selected for DropMB offload.", "info");
      return;
    }

    setDropmbOffloadingItem("batch");
    try {
      for (let i = 0; i < eligibleList.length; i++) {
        const item = eligibleList[i];
        const remoteFilePath = getItemFullPath(item.name);

        setDropmbProgress({
          pct: Math.round((i / eligibleList.length) * 100),
          msg: `[${i + 1}/${eligibleList.length}] Offloading "${item.name}" to DropMB...`,
        });

        if (item.is_dir) {
          await offloadRemoteFolderToDropmb(
            rcloneConfigPath || "",
            selectedRemote,
            remoteFilePath,
            item.name,
            (pct, msg) => setDropmbProgress({ pct: Math.round(((i + pct / 100) / eligibleList.length) * 100), msg })
          );
        } else {
          await offloadRemotePathToDropmb(
            rcloneConfigPath || "",
            selectedRemote,
            remoteFilePath,
            item.name,
            item.size,
            (pct, msg) => setDropmbProgress({ pct: Math.round(((i + pct / 100) / eligibleList.length) * 100), msg })
          );
        }
      }
      useToastStore.getState().addToast(`Batch offload to DropMB completed for ${eligibleList.length} item(s)!`, "success");
      setSelectedItemNames(new Set());
    } finally {
      setDropmbOffloadingItem(null);
      setTimeout(() => setDropmbProgress(null), 3500);
    }
  };

  const cloudTransferJobs = useCloudTransferStore((s) => s.jobs);
  const activeTransferCount = useMemo(() => {
    return Object.values(cloudTransferJobs).filter(
      (j) => j.status === "queued" || j.status === "running"
    ).length;
  }, [cloudTransferJobs]);

  const isLocalRemote = useMemo(() => {
    if (!selectedRemote) return false;
    return (
      selectedRemote.startsWith("/") ||
      selectedRemote.startsWith("\\") ||
      /^[a-zA-Z]:[/\\]/.test(selectedRemote) ||
      selectedRemote.startsWith("local:")
    );
  }, [selectedRemote]);

  // Current remote or local path (e.g. "odrivecrypt:/Movies" or "/home/user/Movies/Action")
  const currentPath = useMemo(() => {
    if (!selectedRemote) return "";
    if (isLocalRemote) {
      const cleanRoot = selectedRemote.replace(/^local:/, "");
      return segments.length > 0
        ? `${cleanRoot}/${segments.join("/")}`.replace(/\/+/g, "/")
        : cleanRoot;
    }
    return segments.length > 0
      ? `${selectedRemote}:/${segments.join("/")}`
      : `${selectedRemote}:`;
  }, [selectedRemote, segments, isLocalRemote]);

  const getItemFullPath = useCallback(
    (name: string) => {
      if (isLocalRemote) {
        const cleanRoot = selectedRemote.replace(/^local:/, "");
        return segments.length > 0
          ? `${cleanRoot}/${segments.join("/")}/${name}`.replace(/\/+/g, "/")
          : `${cleanRoot}/${name}`.replace(/\/+/g, "/");
      }
      return segments.length > 0
        ? `${selectedRemote}:/${segments.join("/")}/${name}`
        : `${selectedRemote}:${name}`;
    },
    [isLocalRemote, selectedRemote, segments]
  );

  // Audio files in the currently viewed folder
  const currentFolderAudioFiles = useMemo(() => {
    return items
      .filter(
        (it) =>
          !it.is_dir &&
          AUDIO_EXTS.includes(it.name.split(".").pop()?.toLowerCase() || "")
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      );
  }, [items]);

  // Listen to download progress events from Tauri backend
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    listen<DownloadProgress>("download-progress", (event) => {
      const payload = event.payload;
      setActiveDownloads((prev) => ({
        ...prev,
        [payload.download_id]: payload,
      }));

      if (payload.status === "completed") {
        useToastStore.getState().addToast(`Downloaded: ${payload.current_file}`, "success");
      } else if (payload.status === "error") {
        useToastStore.getState().addToast(`Download failed: ${payload.error || "Unknown error"}`, "error");
      }
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // Fetch directory listing whenever currentPath or remote changes
  const fetchDirectory = useCallback(() => {
    if (!selectedRemote || selectedRemote.startsWith("shared_")) return;

    setLoading(true);
    setError(null);

    invoke<RcloneListItem[]>("list_remote_path", {
      configPath: rcloneConfigPath || "",
      remotePath: currentPath,
    })
      .then((result) => {
        // Sort directories first, then alphabetically
        const sorted = [...result].sort((a, b) => {
          if (a.is_dir && !b.is_dir) return -1;
          if (!a.is_dir && b.is_dir) return 1;
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        });
        setItems(sorted);
        setSelectedItemNames(new Set());
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, [selectedRemote, rcloneConfigPath, currentPath]);

  useEffect(() => {
    fetchDirectory();
  }, [fetchDirectory]);

  // Helper to map RcloneListItems into audiobook MediaItem structures
  const buildMediaItemsFromRcloneFiles = (
    folderName: string,
    folderRemotePath: string,
    files: RcloneListItem[]
  ): MediaItem[] => {
    const audioFiles = files
      .filter(
        (f) =>
          !f.is_dir &&
          AUDIO_EXTS.includes(f.name.split(".").pop()?.toLowerCase() || "")
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      );

    const coverFile = files.find(
      (f) => !f.is_dir && /^cover\.(jpe?g|png|webp)$/i.test(f.name)
    );
    let coverUrl: string | undefined = undefined;
    if (coverFile) {
      coverUrl = `${folderRemotePath.replace(/\/$/, "")}/${coverFile.name}`;
    }

    let author = "";
    let title = folderName;
    if (folderName.includes(" - ")) {
      const parts = folderName.split(" - ");
      author = parts[0].trim();
      title = parts.slice(1).join(" - ").replace(/\s*audiobook$/i, "").trim();
    } else {
      title = folderName.replace(/\s*audiobook$/i, "").trim();
    }

    const now = Date.now();
    return audioFiles.map((file, idx) => {
      const remoteFilePath = `${folderRemotePath.replace(/\/$/, "")}/${file.name}`;
      const withoutExt = file.name.replace(/\.[^/.]+$/, "");
      let trackTitle = withoutExt;
      const dashParts = withoutExt.split(" - ");
      if (dashParts.length > 1) {
        const lastPart = dashParts[dashParts.length - 1].trim();
        if (/^\d+$/.test(lastPart)) {
          trackTitle = `Chapter ${parseInt(lastPart, 10)}`;
        } else {
          trackTitle = lastPart;
        }
      }

      return {
        id: `cloud-audio-${idx}-${encodeURIComponent(remoteFilePath)}`,
        title: trackTitle,
        album: title,
        author: author || undefined,
        artist: author || undefined,
        posterUrl: coverUrl,
        libraryId: "explorer",
        remotePath: remoteFilePath,
        filename: file.name,
        libraryType: "audiobooks",
        groupType: "book",
        addedAt: now,
        lastScannedAt: now,
      };
    });
  };

  const handleConvertCurrentFolder = () => {
    if (currentFolderAudioFiles.length === 0) {
      useToastStore.getState().addToast("No audio files (.mp3, .m4a, etc.) found in this folder.", "error");
      return;
    }
    const folderName = segments.length > 0 ? segments[segments.length - 1] : selectedRemote;
    const mediaItems = buildMediaItemsFromRcloneFiles(folderName, currentPath, items);
    setSelectedBookForConvert(mediaItems);
    setShowAudiobookConverter(true);
  };

  const handleConvertSubfolder = async (folderName: string) => {
    const subfolderRemotePath = getItemFullPath(folderName);

    setFolderConverting(folderName);
    try {
      const files = await invoke<RcloneListItem[]>("list_remote_path", {
        configPath: rcloneConfigPath || "",
        remotePath: subfolderRemotePath,
      });

      const audioFiles = files.filter(
        (f) => !f.is_dir && AUDIO_EXTS.includes(f.name.split(".").pop()?.toLowerCase() || "")
      );

      if (audioFiles.length === 0) {
        useToastStore.getState().addToast(
          `No audio files found in "${folderName}".`,
          "error"
        );
        return;
      }

      const mediaItems = buildMediaItemsFromRcloneFiles(folderName, subfolderRemotePath, files);
      setSelectedBookForConvert(mediaItems);
      setShowAudiobookConverter(true);
    } catch (err: any) {
      useToastStore.getState().addToast(
        `Failed to scan folder: ${err?.message || String(err)}`,
        "error"
      );
    } finally {
      setFolderConverting(null);
    }
  };

  const handleConvertSingleFile = (file: RcloneListItem) => {
    const folderName = segments.length > 0 ? segments[segments.length - 1] : selectedRemote;
    const mediaItems = buildMediaItemsFromRcloneFiles(folderName, currentPath, [file]);
    setSelectedBookForConvert(mediaItems);
    setShowAudiobookConverter(true);
  };

  // Upload handlers
  const handleUploadFiles = async (files?: FileList | null) => {
    if (selectedRemote.startsWith("shared_")) {
      useToastStore.getState().addToast("Upload is disabled on shared access pass remotes.", "error");
      return;
    }
    if (files && files.length > 0) {
      setIsUploading(true);
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          setUploadProgressMsg(`Uploading [${i + 1}/${files.length}]: ${file.name}...`);
          const buf = await file.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buf));
          const dest = getItemFullPath(file.name);
          await invoke("rclone_upload_bytes", {
            configPath: rcloneConfigPath || "",
            remotePath: dest,
            bytes,
          });
        }
        useToastStore.getState().addToast(`Uploaded ${files.length} file(s)!`, "success");
        notifyRemoteMutated(selectedRemote);
        fetchDirectory();
      } catch (err: any) {
        useToastStore.getState().addToast(`Upload failed: ${err?.message || err}`, "error");
      } finally {
        setIsUploading(false);
        setUploadProgressMsg("");
      }
      return;
    }

    if (typeof (window as any).__TAURI_INTERNALS__ !== "undefined" && !("AndroidBridge" in window)) {
      try {
        const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
        const selected = await openDialog({
          multiple: true,
          directory: false,
          title: "Select Files to Upload",
        });
        if (!selected) return;
        const paths = Array.isArray(selected) ? selected : [selected];
        if (paths.length === 0) return;
        setIsUploading(true);
        for (let i = 0; i < paths.length; i++) {
          const localPath = paths[i];
          const fileName = localPath.split(/[/\\]/).pop() || "file";
          setUploadProgressMsg(`Uploading [${i + 1}/${paths.length}]: ${fileName}...`);
          const dest = getItemFullPath(fileName);
          await invoke("rclone_upload_file", {
            configPath: rcloneConfigPath || "",
            localPath,
            remotePath: dest,
          });
        }
        useToastStore.getState().addToast(`Uploaded ${paths.length} file(s)!`, "success");
        notifyRemoteMutated(selectedRemote);
        fetchDirectory();
      } catch (err: any) {
        useToastStore.getState().addToast(`Upload failed: ${err?.message || err}`, "error");
      } finally {
        setIsUploading(false);
        setUploadProgressMsg("");
      }
    } else {
      fileUploadRef.current?.click();
    }
  };

  const handleUploadFolder = async () => {
    if (selectedRemote.startsWith("shared_")) {
      useToastStore.getState().addToast("Upload is disabled on shared access pass remotes.", "error");
      return;
    }
    if (typeof (window as any).__TAURI_INTERNALS__ !== "undefined" && !("AndroidBridge" in window)) {
      try {
        const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
        const selected = await openDialog({
          multiple: false,
          directory: true,
          title: "Select Folder to Upload",
        });
        if (!selected || typeof selected !== "string") return;
        const folderName = selected.split(/[/\\]/).filter(Boolean).pop() || "folder";
        setIsUploading(true);
        setUploadProgressMsg(`Uploading folder "${folderName}"...`);
        const dest = getItemFullPath(folderName);
        await invoke("rclone_upload_file", {
          configPath: rcloneConfigPath || "",
          localPath: selected,
          remotePath: dest,
        });
        useToastStore.getState().addToast(`Folder "${folderName}" uploaded!`, "success");
        notifyRemoteMutated(selectedRemote);
        fetchDirectory();
      } catch (err: any) {
        useToastStore.getState().addToast(`Folder upload failed: ${err?.message || err}`, "error");
      } finally {
        setIsUploading(false);
        setUploadProgressMsg("");
      }
    } else {
      useToastStore.getState().addToast("Folder upload via dialog is only available on desktop.", "info");
    }
  };

  // Filter and sort items by query, sortField, and sortDirection
  const filteredItems = useMemo(() => {
    let list = items;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((item) => item.name.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      // Keep directories together at the top
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;

      let cmp = 0;
      if (sortField === "size") {
        cmp = (a.size || 0) - (b.size || 0);
      } else if (sortField === "date") {
        const timeA = a.mod_time ? new Date(a.mod_time).getTime() : 0;
        const timeB = b.mod_time ? new Date(b.mod_time).getTime() : 0;
        cmp = timeA - timeB;
      } else {
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      }

      return sortDirection === "asc" ? cmp : -cmp;
    });
  }, [items, searchQuery, sortField, sortDirection]);

  const [extractingPath, setExtractingPath] = useState<string | null>(null);
  const [mountedRemotes, setMountedRemotes] = useState<Array<{ name: string; mount_point: string; managed: boolean }>>([]);
  const [mountingRemote, setMountingRemote] = useState(false);

  const refreshMountedRemotes = useCallback(async () => {
    try {
      const list = await invoke<Array<{ name: string; mount_point: string; managed: boolean }>>("list_mounted_remotes");
      setMountedRemotes(Array.isArray(list) ? list : []);
    } catch {
      setMountedRemotes([]);
    }
  }, []);

  useEffect(() => {
    void refreshMountedRemotes();
    const onFocus = () => void refreshMountedRemotes();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshMountedRemotes]);

  const activeMount = useMemo(() => {
    if (!selectedRemote || isLocalRemote) return undefined;
    const clean = selectedRemote.replace(/:$/, "").toLowerCase();
    return mountedRemotes.find((m) => m.name.toLowerCase() === clean);
  }, [mountedRemotes, selectedRemote, isLocalRemote]);

  const handleToggleFuseMount = async () => {
    if (!selectedRemote || isLocalRemote) return;
    if (activeMount && !activeMount.managed) return;
    setMountingRemote(true);
    try {
      if (activeMount?.managed) {
        await invoke("unmount_remote", { remoteName: selectedRemote });
        useToastStore.getState().addToast(`Unmounted ${selectedRemote}`, "success");
      } else {
        const mp = await invoke<string>("mount_remote", {
          configPath: rcloneConfigPath || "",
          remoteName: selectedRemote,
        });
        useToastStore.getState().addToast(`Mounted ${selectedRemote} at ${mp}`, "success");
      }
      await refreshMountedRemotes();
    } catch (err: any) {
      useToastStore.getState().addToast(`${err?.message || err}`, "error");
    } finally {
      setMountingRemote(false);
    }
  };

  const handleExtractHere = async (item: RcloneListItem) => {
    if (!selectedRemote || selectedRemote.startsWith("shared_")) {
      useToastStore.getState().addToast("Guest pass remotes are read-only.", "error");
      return;
    }
    const remotePrefix = isLocalRemote
      ? selectedRemote.replace(/^local:/, "").replace(/\/$/, "")
      : `${selectedRemote}:`;
    const itemRel = (item.path || item.name).replace(/^\/+/, "");
    const sourceRemotePath = isLocalRemote
      ? `${remotePrefix}/${itemRel}`
      : `${selectedRemote}:${itemRel}`;
    const destRemoteDir = isLocalRemote
      ? currentPath
      : `${selectedRemote}:${currentPath}`;
    setExtractingPath(sourceRemotePath);
    if (!isLocalRemote && item.size > 0) {
      void checkRemoteFreeSpaceWarning(selectedRemote, item.size, "archive extraction").then((spaceWarn) => {
        if (spaceWarn) useToastStore.getState().addToast(spaceWarn, "info");
      });
    }
    useToastStore.getState().addToast(`Extracting ${item.name}...`, "info");
    try {
      const target = await invoke<string>("extract_remote_archive_to_remote", {
        configPath: rcloneConfigPath || "",
        sourceRemotePath,
        destRemoteDir,
      });
      useToastStore.getState().addToast(`Extracted to ${target}`, "success");
      notifyRemoteMutated(selectedRemote);
      fetchDirectory();
    } catch (err: any) {
      useToastStore.getState().addToast(`Extraction failed: ${err?.message || err}`, "error");
    } finally {
      setExtractingPath(null);
    }
  };

  const handleDownloadFile = async (item: RcloneListItem) => {
    const downloadId = `dl-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const remoteFilePath = getItemFullPath(item.name);

    try {
      useToastStore.getState().addToast(`Starting download: ${item.name}`, "info");
      await invoke("start_download", {
        configPath: rcloneConfigPath || "",
        downloadId,
        items: [
          {
            remote_path: remoteFilePath,
            filename: item.name,
            subfolder: null,
          },
        ],
        destinationDir: null,
      });
    } catch (err: any) {
      useToastStore.getState().addToast(`Failed to start download: ${err.message || String(err)}`, "error");
    }
  };

  const handleDownloadFolder = async (folderName?: string) => {
    const targetFolder = folderName || (segments.length > 0 ? segments[segments.length - 1] : selectedRemote);
    const targetRemotePath = folderName ? getItemFullPath(folderName) : currentPath;

    const downloadId = `dl-folder-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

    try {
      useToastStore.getState().addToast(`Downloading folder: ${targetFolder}`, "info");
      await startFolderDownload(
        rcloneConfigPath || "",
        downloadId,
        targetRemotePath,
        targetFolder
      );
    } catch (err: any) {
      useToastStore.getState().addToast(`Failed to download folder: ${err.message || String(err)}`, "error");
    }
  };

  const handleOpenDownloadsFolder = () => {
    invoke("open_download_folder", { path: null }).catch(() => {});
  };

  const handleDownloadBatch = async () => {
    if (selectedItemNames.size === 0) return;
    const selectedList = items.filter((it) => selectedItemNames.has(it.name));
    if (selectedList.length === 0) return;

    useToastStore.getState().addToast(`Starting download of ${selectedList.length} item(s)...`, "info");
    for (const item of selectedList) {
      const fullPath = getItemFullPath(item.name);
      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      if (item.is_dir) {
        startFolderDownload(
          rcloneConfigPath || "",
          downloadId,
          fullPath,
          item.name
        ).catch((err: any) => {
          useToastStore.getState().addToast(`Failed to download folder ${item.name}: ${err?.message || err}`, "error");
        });
      } else {
        invoke("start_download", {
          configPath: rcloneConfigPath || "",
          downloadId,
          items: [{ remote_path: fullPath, filename: item.name, subfolder: null }],
          destinationDir: null,
        }).catch((err: any) => {
          useToastStore.getState().addToast(`Failed to download ${item.name}: ${err?.message || err}`, "error");
        });
      }
    }
    setSelectedItemNames(new Set());
  };

  const handleOpenTransferBatch = () => {
    const selectedList = items.filter((it) => selectedItemNames.has(it.name));
    if (selectedList.length === 0) return;
    setTransferTarget({
      items: selectedList,
      isSingle: false,
    });
  };

  const handleOpenTransferSingle = (item: RcloneListItem) => {
    setTransferTarget({
      items: [item],
      isSingle: true,
    });
  };

  const handleOpenCopyMoveSingle = (item: RcloneListItem, operation: "copy" | "move" = "copy") => {
    setTransferTarget({
      items: [item],
      isSingle: true,
      initialOperation: operation,
      initialWorker: "local",
    });
  };

  const handleOpenCopyMoveBatch = (operation: "copy" | "move" = "copy") => {
    const selectedList = items.filter((it) => selectedItemNames.has(it.name));
    if (selectedList.length === 0) return;
    setTransferTarget({
      items: selectedList,
      isSingle: false,
      initialOperation: operation,
      initialWorker: "local",
    });
  };

  const handleOpenTransferFolder = () => {
    setTransferTarget({
      items: [],
      isSingle: false,
    });
  };

  const handleOpenTransferUrl = () => {
    setTransferTarget({
      items: [],
      isSingle: false,
      isUrl: true,
    });
  };

  const handlePreviewFile = async (item: RcloneListItem) => {
    if (item.is_dir) {
      setSegments([...segments, item.name]);
      setSearchQuery("");
      return;
    }

    const ext = item.name.split(".").pop()?.toLowerCase() || "";
    const remoteFilePath = getItemFullPath(item.name);
    const relativeFilePath = segments.length > 0
      ? `${segments.join("/")}/${item.name}`
      : item.name;
    const remoteRoot = isLocalRemote ? selectedRemote : `${selectedRemote}:`;

    try {
      stopActiveSession();
      useToastStore.getState().addToast(`Opening ${item.name}...`, "info");
      const sid = `preview-${Date.now()}`;
      activeSessionIdRef.current = sid;
      const res: any = await invoke("start_stream_session", {
        configPath: rcloneConfigPath || "",
        remoteRoot,
        filePath: relativeFilePath,
        sessionId: sid,
      });

      const fileUrl = res?.file_url;
      if (!fileUrl) {
        throw new Error("Failed to initialize stream server for preview");
      }

      if (["mp4", "mkv", "avi", "mov", "webm", "m4v", "ts", "m2ts"].includes(ext)) {
        navigate("/play/video", {
          state: {
            item: {
              id: `cloud-${remoteFilePath}`,
              libraryId: "explorer",
              libraryType: "movies",
              remotePath: remoteFilePath,
              filename: item.name,
              title: item.name.replace(/\.[^/.]+$/, ""),
              streamUrl: fileUrl,
              addedAt: Date.now(),
              lastScannedAt: Date.now(),
            },
          },
        });
      } else if (AUDIO_EXTS.includes(ext)) {
        const track: MediaItem = {
          id: `cloud-${remoteFilePath}`,
          libraryId: "explorer",
          libraryType: "music",
          remotePath: remoteFilePath,
          filename: item.name,
          title: item.name.replace(/\.[^/.]+$/, ""),
          streamUrl: fileUrl,
          addedAt: Date.now(),
          lastScannedAt: Date.now(),
        };
        window.dispatchEvent(
          new CustomEvent("rcloneflix:play-audio", {
            detail: { playlist: [track], playlistIndex: 0 },
          })
        );
        useToastStore.getState().addToast(`Playing: ${track.title}`, "success");
      } else if (ext === "epub") {
        navigate("/play/epub", {
          state: {
            item: {
              id: `cloud-${remoteFilePath}`,
              libraryId: "explorer",
              libraryType: "books",
              remotePath: remoteFilePath,
              filename: item.name,
              title: item.name.replace(/\.[^/.]+$/, ""),
              streamUrl: fileUrl,
              addedAt: Date.now(),
              lastScannedAt: Date.now(),
            },
          },
        });
      } else if (ext === "pdf") {
        navigate("/play/pdf", {
          state: {
            item: {
              id: `cloud-${remoteFilePath}`,
              libraryId: "explorer",
              libraryType: "books",
              remotePath: remoteFilePath,
              filename: item.name,
              title: item.name.replace(/\.[^/.]+$/, ""),
              streamUrl: fileUrl,
              addedAt: Date.now(),
              lastScannedAt: Date.now(),
            },
          },
        });
      } else if (ext === "cbz" || ext === "cbr" || ext === "cb7" || ext === "cbt") {
        navigate("/play/comic", {
          state: {
            item: {
              id: `cloud-${remoteFilePath}`,
              libraryId: "explorer",
              libraryType: "comics",
              remotePath: remoteFilePath,
              filename: item.name,
              title: item.name.replace(/\.[^/.]+$/, ""),
              streamUrl: fileUrl,
              addedAt: Date.now(),
              lastScannedAt: Date.now(),
            },
          },
        });
      } else if (["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "svg"].includes(ext)) {
        setImagePreview({ url: fileUrl, title: item.name, size: item.size });
      } else if (["txt", "nfo", "srt", "vtt", "json", "log", "md", "xml", "yaml", "yml"].includes(ext)) {
        setTextPreview({ content: "Loading text contents...", title: item.name, loading: true });
        try {
          const textResp = await fetch(fileUrl);
          const text = await textResp.text();
          setTextPreview({ content: text.slice(0, 100000), title: item.name, loading: false });
        } catch (err: any) {
          setTextPreview({ content: `Failed to load text: ${err?.message || String(err)}`, title: item.name, loading: false });
        }
      } else {
        setFileInfoTarget({ item, fullPath: remoteFilePath, streamUrl: fileUrl });
      }
    } catch (err: any) {
      useToastStore.getState().addToast(`Preview error: ${err?.message || String(err)}`, "error");
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    setIsCreatingFolder(true);
    try {
      const targetDir = getItemFullPath(newFolderName.trim());
      await invoke("rclone_mkdir", {
        configPath: rcloneConfigPath || "",
        remotePath: targetDir,
      });
      useToastStore.getState().addToast(`Created folder "${newFolderName.trim()}"`, "success");
      setShowNewFolderModal(false);
      setNewFolderName("");
      fetchDirectory();
    } catch (err: any) {
      useToastStore.getState().addToast(`Failed to create folder: ${err?.message || String(err)}`, "error");
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleRename = async () => {
    if (!renameTarget || !renameTarget.newName.trim()) return;
    setIsRenaming(true);
    try {
      const fromPath = getItemFullPath(renameTarget.item.name);
      const toPath = getItemFullPath(renameTarget.newName.trim());
      await invoke("rclone_rename_file", {
        configPath: rcloneConfigPath || "",
        fromPath,
        toPath,
      });

      // Synchronize in-channel tracking database if renamed on telegram-drive
      if (fromPath.startsWith("telegram-drive:")) {
        const store = useAppStore.getState();
        const items = Object.values(store.mediaItems);
        for (const it of items) {
          if (it.remotePath === fromPath || it.versions?.some((v) => v.remotePath === fromPath)) {
            const updatedVersions = it.versions?.map((v) =>
              v.remotePath === fromPath ? { ...v, remotePath: toPath } : v
            );
            const updatedItem = {
              ...it,
              remotePath: it.remotePath === fromPath ? toPath : it.remotePath,
              versions: updatedVersions,
            };
            store.upsertMediaItem(updatedItem);
            import("../../lib/libraryDb")
              .then((m) => m.persistItems([updatedItem]))
              .catch(() => {});
          }
        }
      }

      useToastStore.getState().addToast(`Renamed to "${renameTarget.newName.trim()}"`, "success");
      setRenameTarget(null);
      fetchDirectory();
    } catch (err: any) {
      useToastStore.getState().addToast(`Rename failed: ${err?.message || String(err)}`, "error");
    } finally {
      setIsRenaming(false);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget || deleteTarget.length === 0) return;
    const delClass = classifyDeleteItems(
      selectedRemote,
      currentPath,
      deleteTarget.map((it) => it.name),
      isLocalRemote
    );
    if (delClass.mode === "mixed") {
      useToastStore
        .getState()
        .addToast(`Select the App Trash folder (${delClass.trashDir}) separately from other items.`, "error");
      return;
    }
    setIsDeleting(true);
    let successCount = 0;
    try {
      for (const it of deleteTarget) {
        const remotePath = getItemFullPath(it.name);
        await invoke("rclone_delete_item", {
          configPath: rcloneConfigPath || "",
          remotePath,
          isDir: it.is_dir,
        });
        successCount++;
      }
      useToastStore.getState().addToast(
        delClass.mode === "soft"
          ? deleteTarget.length === 1
            ? `Moved "${deleteTarget[0].name}" to App Trash (${delClass.trashDir})`
            : `Moved ${successCount} items to App Trash (${delClass.trashDir})`
          : deleteTarget.length === 1
          ? `Deleted "${deleteTarget[0].name}"`
          : `Deleted ${successCount} items`,
        "info"
      );
      notifyRemoteMutated(selectedRemote);
      setDeleteTarget(null);
      setSelectedItemNames(new Set());
      fetchDirectory();
    } catch (err: any) {
      useToastStore.getState().addToast(`Delete failed: ${err?.message || String(err)}`, "error");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleShareItem = async (item: RcloneListItem) => {
    const cleanRemote = selectedRemote.replace(/:+$/, "");
    const relPath = getItemFullPath(item.name).replace(/^[^:]+:/, "").replace(/^\/+/, "");

    // 1. If remote is uDrop, resolve direct link instantly via uDrop API
    if (cleanRemote === "udrop") {
      try {
        const { getUdropDirectLinkForFile } = await import("../../lib/udrop");
        const link = await getUdropDirectLinkForFile(item.name);
        if (link) {
          await navigator.clipboard.writeText(link);
          useToastStore.getState().addToast("Copied uDrop direct streaming link to clipboard!", "success");
          return;
        }
      } catch (e: any) {
        console.warn("uDrop direct link lookup warning:", e);
      }
    }

    // 2. Default for supported cloud remotes: use rclone's built-in link function
    try {
      useToastStore.getState().addToast(`Generating public share link for "${item.name}"...`, "info");
      const link = await invoke<string>("get_rclone_link", {
        configPath: rcloneConfigPath || "",
        remoteName: cleanRemote,
        filePath: relPath,
      });
      await navigator.clipboard.writeText(link);
      useToastStore.getState().addToast("Copied public share link to clipboard!", "success");
    } catch (err: any) {
      // 3. Fallback: Open uDrop Share & Cloud Transfer modal
      setShareModalTarget({
        remoteName: cleanRemote,
        filePath: relPath,
        fileName: item.name,
        fileSize: item.size > 0 ? item.size : undefined,
      });
    }
  };

  const handleShowFileInfo = async (item: RcloneListItem) => {
    const remoteFilePath = getItemFullPath(item.name);
    const relativeFilePath = segments.length > 0
      ? `${segments.join("/")}/${item.name}`
      : item.name;
    const remoteRoot = isLocalRemote ? selectedRemote : `${selectedRemote}:`;

    let streamUrl: string | undefined;
    if (!item.is_dir) {
      try {
        stopActiveSession();
        const sid = `info-${Date.now()}`;
        activeSessionIdRef.current = sid;
        const res: any = await invoke("start_stream_session", {
          configPath: rcloneConfigPath || "",
          remoteRoot,
          filePath: relativeFilePath,
          sessionId: sid,
        });
        streamUrl = res?.file_url;
      } catch {}
    }
    setFileInfoTarget({ item, fullPath: remoteFilePath, streamUrl });
  };

  if (personalRemotes.length === 0 && localLibraryPaths.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full bg-void text-center p-8">
        <div className="w-16 h-16 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent mb-4">
          <AlertCircle size={32} />
        </div>
        <h2 className="font-display text-2xl text-bright tracking-wide mb-2">
          CLOUD EXPLORER RESTRICTED
        </h2>
        <p className="text-subtle font-body text-sm max-w-md mb-6">
          Direct Cloud Explorer access to underlying remotes is disabled for Guest Pass libraries to protect the library owner&apos;s storage.
        </p>
        <button
          onClick={() => navigate("/home")}
          className="btn-primary text-xs px-5 py-2.5 rounded-lg"
        >
          Return to Home
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-void">
      {/* Header Toolbar */}
      <div className="px-8 py-6 border-b border-border/60 bg-surface/40 backdrop-blur-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
              <CloudDownload size={20} />
            </div>
            <h1 className="font-display text-2xl text-bright tracking-wide">
              CLOUD EXPLORER
            </h1>
          </div>
          <p className="text-subtle font-body text-xs mt-1">
            Browse any personal cloud remote directly and download files or entire folders
          </p>
        </div>

        {/* Remote Selector & Action Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 bg-panel border border-border rounded-xl px-3 py-1.5">
            <HardDrive size={14} className="text-accent" />
            <select
              value={selectedRemote}
              onChange={(e) => {
                setSelectedRemote(e.target.value);
                setSegments([]);
              }}
              className="bg-transparent text-bright font-mono text-xs focus:outline-none cursor-pointer"
            >
              {personalRemotes.length > 0 && (
                <optgroup label="Cloud Remotes">
                  {personalRemotes.map((r) => (
                    <option key={r.name} value={r.name} className="bg-surface text-bright">
                      ☁️ {r.name} ({r.type})
                    </option>
                  ))}
                </optgroup>
              )}
              {localLibraryPaths.length > 0 && (
                <optgroup label="Local Library Pathways">
                  {localLibraryPaths.map((loc) => (
                    <option key={loc.path} value={loc.path} className="bg-surface text-bright">
                      📁 Local: {loc.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <button
            onClick={fetchDirectory}
            disabled={loading}
            className="p-2 rounded-xl bg-panel border border-border text-subtle hover:text-bright hover:bg-surface transition-all disabled:opacity-50"
            title="Refresh current folder"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>

          {selectedRemote && !isLocalRemote && (
            activeMount && !activeMount.managed ? (
              <span
                title={`Mounted externally at ${activeMount.mount_point} (external mounts are not auto-refreshed by RcloneFlix)`}
                className="px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-mono flex items-center gap-1.5"
              >
                <HardDrive size={13} />
                <span>Mounted (external)</span>
              </span>
            ) : (
              <button
                onClick={handleToggleFuseMount}
                disabled={mountingRemote}
                title={activeMount?.managed ? `Unmount ${activeMount.mount_point} (auto-refreshed via RC)` : `Mount ${selectedRemote}: via FUSE to ~/RcloneFlixMounts/${selectedRemote}`}
                className={`px-3 py-1.5 rounded-xl border text-xs font-mono flex items-center gap-1.5 transition-all disabled:opacity-50 ${
                  activeMount?.managed
                    ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-rose-500/15 hover:border-rose-500/30 hover:text-rose-300"
                    : "bg-panel border-border text-subtle hover:text-bright hover:bg-surface"
                }`}
              >
                {mountingRemote ? <Loader2 size={13} className="animate-spin" /> : <HardDrive size={13} />}
                <span>{activeMount?.managed ? "Mounted (Unmount)" : "Mount FUSE"}</span>
              </button>
            )
          )}

          <RcloneSuiteToolbar
            selectedRemote={selectedRemote}
            currentPath={currentPath}
            isLocalRemote={isLocalRemote}
            onMutated={fetchDirectory}
          />

          <input
            ref={fileUploadRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleUploadFiles(e.target.files)}
          />

          <button
            onClick={() => { setNewFolderName(""); setShowNewFolderModal(true); }}
            className="px-3 py-2 rounded-xl bg-panel border border-border text-subtle hover:text-bright hover:border-accent/40 font-body text-xs flex items-center gap-1.5 transition-all"
            title="Create a new folder in this remote"
          >
            <Plus size={14} className="text-accent" />
            <span>New Folder</span>
          </button>

          <button
            onClick={() => handleUploadFiles()}
            disabled={isUploading}
            className="px-3 py-2 rounded-xl bg-panel border border-border text-subtle hover:text-bright hover:border-accent/40 font-body text-xs flex items-center gap-1.5 transition-all disabled:opacity-50"
            title="Upload local files to current cloud folder"
          >
            {isUploading ? (
              <Loader2 size={14} className="animate-spin text-accent" />
            ) : (
              <Upload size={14} className="text-accent" />
            )}
            <span>Upload Files</span>
          </button>

          <button
            onClick={handleUploadFolder}
            disabled={isUploading}
            className="px-3 py-2 rounded-xl bg-panel border border-border text-subtle hover:text-bright hover:border-accent/40 font-body text-xs flex items-center gap-1.5 transition-all disabled:opacity-50 hidden sm:flex"
            title="Upload local folder to current cloud folder"
          >
            <FolderUp size={14} className="text-accent" />
            <span>Upload Folder</span>
          </button>

          <button
            onClick={handleOpenDownloadsFolder}
            className="px-3 py-2 rounded-xl bg-panel border border-border text-subtle hover:text-bright hover:border-accent/40 font-body text-xs flex items-center gap-1.5 transition-all"
            title="Open default ~/Downloads/RcloneFlix folder"
          >
            <FolderOpen size={14} className="text-teal" />
            <span>Downloads</span>
          </button>

          <button
            onClick={() => handleOpenTransferUrl()}
            className="px-3 py-2 rounded-xl bg-accent/15 hover:bg-accent/25 text-accent border border-accent/30 font-body text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm"
            title="Offload any direct HTTP/HTTPS web link off-device using cloud worker"
          >
            <Globe size={14} />
            <span>Offload URL</span>
          </button>

          <button
            onClick={() => setShowTransferDrawer(true)}
            className="px-3 py-2 rounded-xl bg-panel border border-border text-subtle hover:text-bright hover:border-accent/40 font-body text-xs flex items-center gap-1.5 transition-all relative"
            title="Open Cloud Transfers Panel"
          >
            <ArrowRightLeft size={14} className="text-accent" />
            <span>Transfers</span>
            {activeTransferCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-accent text-void font-mono text-[10px] font-bold animate-pulse">
                {activeTransferCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Breadcrumb & Filter Bar */}
      <div className="px-8 py-3 border-b border-border/40 bg-surface/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {/* Breadcrumb Navigation */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-xs font-mono text-subtle py-1">
          {segments.length > 0 && (
            <button
              onClick={() => setSegments(segments.slice(0, -1))}
              className="p-1 rounded-md hover:text-bright hover:bg-panel transition-colors mr-1"
              title="Go up one folder"
            >
              <ArrowLeft size={14} />
            </button>
          )}

          <button
            onClick={() => setSegments([])}
            className={`hover:text-accent transition-colors ${
              segments.length === 0 ? "text-bright font-bold" : "text-subtle"
            }`}
          >
            {selectedRemote}:
          </button>

          {segments.map((seg, idx) => {
            const isLast = idx === segments.length - 1;
            return (
              <div key={idx} className="flex items-center gap-1.5 flex-shrink-0">
                <ChevronRight size={12} className="text-border" />
                <button
                  onClick={() => setSegments(segments.slice(0, idx + 1))}
                  className={`hover:text-accent transition-colors ${
                    isLast ? "text-bright font-bold" : "text-subtle"
                  }`}
                >
                  {seg}
                </button>
              </div>
            );
          })}
        </div>

        {/* Search & Download Folder button */}
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter items..."
              className="pl-8 pr-3 py-1.5 rounded-xl bg-panel border border-border text-bright placeholder-subtle/50 text-xs font-body focus:outline-none focus:border-accent w-48 sm:w-56 transition-all"
            />
          </div>

          {/* Sort Controls */}
          <div className="flex items-center gap-1 bg-panel border border-border rounded-xl p-0.5 text-xs text-subtle">
            <button
              type="button"
              onClick={() => setSortField("name")}
              className={`px-2 py-1 rounded-lg transition-colors flex items-center gap-1 ${
                sortField === "name" ? "bg-accent/15 text-accent font-semibold" : "hover:text-bright"
              }`}
              title="Sort by Name"
            >
              <span>Name</span>
            </button>
            <button
              type="button"
              onClick={() => setSortField("size")}
              className={`px-2 py-1 rounded-lg transition-colors flex items-center gap-1 ${
                sortField === "size" ? "bg-accent/15 text-accent font-semibold" : "hover:text-bright"
              }`}
              title="Sort by Size"
            >
              <span>Size</span>
            </button>
            <button
              type="button"
              onClick={() => setSortField("date")}
              className={`px-2 py-1 rounded-lg transition-colors flex items-center gap-1 ${
                sortField === "date" ? "bg-accent/15 text-accent font-semibold" : "hover:text-bright"
              }`}
              title="Sort by Date Modified"
            >
              <span>Date</span>
            </button>
            <div className="w-[1px] h-3.5 bg-border/60 mx-0.5" />
            <button
              type="button"
              onClick={() => setSortDirection((d) => (d === "asc" ? "desc" : "asc"))}
              className="px-2 py-1 rounded-lg transition-colors flex items-center gap-1 text-accent font-medium hover:bg-accent/10"
              title={`Sort Direction: ${sortDirection === "asc" ? "Ascending (Old-New / A-Z)" : "Descending (New-Old / Z-A)"}`}
            >
              <ArrowUpDown size={12} />
              <span>{sortDirection === "asc" ? "Asc (↑)" : "Desc (↓)"}</span>
            </button>
          </div>

          {currentFolderAudioFiles.length > 0 && (
            <button
              onClick={handleConvertCurrentFolder}
              className="px-3 py-1.5 rounded-xl bg-purple-500/15 hover:bg-purple-500/25 text-purple-400 border border-purple-500/30 font-body text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm"
              title={`Convert ${currentFolderAudioFiles.length} audio file(s) into a chapterized M4B audiobook`}
            >
              <BookOpen size={13} />
              <span>Convert to M4B ({currentFolderAudioFiles.length})</span>
            </button>
          )}

          {segments.length > 0 && (
            <>
              <button
                onClick={() => handleDownloadFolder()}
                className="px-3 py-1.5 rounded-xl bg-teal/10 hover:bg-teal/20 text-teal border border-teal/30 font-body text-xs font-semibold flex items-center gap-1.5 transition-all"
                title="Download entire current folder"
              >
                <FolderDown size={13} />
                <span>Download Folder</span>
              </button>

              <button
                onClick={() => {
                  setFolderMatchTarget({
                    folderPath: currentPath,
                    folderName: segments[segments.length - 1],
                  });
                }}
                className="px-3 py-1.5 rounded-xl bg-accent/10 hover:bg-accent/20 text-accent border border-accent/30 font-body text-xs font-semibold flex items-center gap-1.5 transition-all"
                title="Match metadata for current folder and propagate to library"
              >
                <Wrench size={13} />
                <span>Match Folder</span>
              </button>

              <button
                onClick={() => handleOpenTransferFolder()}
                className="px-3 py-1.5 rounded-xl bg-accent/10 hover:bg-accent/20 text-accent border border-accent/30 font-body text-xs font-semibold flex items-center gap-1.5 transition-all"
                title="Transfer entire current folder to another remote via Kaggle"
              >
                <ArrowRightLeft size={13} />
                <span>Transfer Folder</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main Listing Area */}
      <div className="flex-1 overflow-y-auto p-8">
        {loading ? (
          <div className="h-64 flex flex-col items-center justify-center gap-3 text-subtle">
            <Loader2 size={36} className="text-accent animate-spin" />
            <span className="font-body text-xs">Listing files on {currentPath}...</span>
          </div>
        ) : error ? (
          <div className="p-6 rounded-2xl bg-danger/10 border border-danger/30 text-danger max-w-lg mx-auto text-center space-y-2 mt-12">
            <AlertCircle size={28} className="mx-auto" />
            <p className="font-body text-sm font-semibold">Failed to read directory</p>
            <p className="font-mono text-xs text-danger/80">{error}</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center gap-2 text-subtle text-center">
            <Folder size={40} className="text-subtle/40" />
            <p className="font-body text-sm font-medium text-bright">
              {searchQuery ? "No matching files or folders" : "This directory is empty"}
            </p>
            <p className="font-body text-xs">
              {searchQuery ? "Try refining your search filter" : "No items found in this cloud folder"}
            </p>
          </div>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                handleUploadFiles(e.dataTransfer.files);
              }
            }}
            className="border border-border/80 rounded-2xl overflow-hidden bg-surface/30"
          >
            {isUploading && (
              <div className="p-3 bg-accent/10 border-b border-accent/20 flex items-center gap-3 text-accent text-xs font-mono">
                <Loader2 size={15} className="animate-spin flex-shrink-0" />
                <span>{uploadProgressMsg || "Uploading to current cloud directory..."}</span>
              </div>
            )}

            {/* Table Header */}
            <div className="grid grid-cols-12 px-5 py-3 border-b border-border/60 bg-panel/60 text-subtle font-mono text-[11px] uppercase tracking-wider items-center select-none">
              <div className="col-span-6 sm:col-span-5 flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={filteredItems.length > 0 && filteredItems.every((it) => selectedItemNames.has(it.name))}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedItemNames(new Set(filteredItems.map((it) => it.name)));
                    } else {
                      setSelectedItemNames(new Set());
                    }
                  }}
                  className="w-3.5 h-3.5 rounded accent-accent cursor-pointer"
                  title="Select all items in folder"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (sortField === "name") {
                      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
                    } else {
                      setSortField("name");
                      setSortDirection("asc");
                    }
                  }}
                  className="flex items-center gap-1.5 hover:text-bright transition-colors uppercase tracking-wider font-mono text-[11px]"
                >
                  <span>Name</span>
                  {sortField === "name" && (
                    <span className="text-accent">{sortDirection === "asc" ? "↑" : "↓"}</span>
                  )}
                </button>
              </div>
              <div className="hidden sm:block sm:col-span-3 text-right">
                <button
                  type="button"
                  onClick={() => {
                    if (sortField === "date") {
                      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
                    } else {
                      setSortField("date");
                      setSortDirection("desc");
                    }
                  }}
                  className="inline-flex items-center gap-1.5 hover:text-bright transition-colors uppercase tracking-wider font-mono text-[11px]"
                >
                  <span>Modified</span>
                  {sortField === "date" && (
                    <span className="text-accent">{sortDirection === "asc" ? "↑" : "↓"}</span>
                  )}
                </button>
              </div>
              <div className="col-span-2 sm:col-span-1 text-right">
                <button
                  type="button"
                  onClick={() => {
                    if (sortField === "size") {
                      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
                    } else {
                      setSortField("size");
                      setSortDirection("desc");
                    }
                  }}
                  className="inline-flex items-center gap-1.5 hover:text-bright transition-colors uppercase tracking-wider font-mono text-[11px]"
                >
                  <span>Size</span>
                  {sortField === "size" && (
                    <span className="text-accent">{sortDirection === "asc" ? "↑" : "↓"}</span>
                  )}
                </button>
              </div>
              <div className="col-span-4 sm:col-span-3 text-right pr-2">Actions</div>
            </div>

            {/* Table Rows */}
            <div className="divide-y divide-border/30">
              {filteredItems.map((item) => {
                const Icon = item.is_dir ? Folder : getFileIcon(item.name);
                const isSelected = selectedItemNames.has(item.name);
                return (
                  <div
                    key={item.name}
                    className={`grid grid-cols-12 px-5 py-3 items-center transition-colors group cursor-default ${
                      isSelected ? "bg-accent/10 border-l-2 border-accent" : "hover:bg-panel/40"
                    }`}
                  >
                    {/* Name, Checkbox & Icon */}
                    <div className="col-span-6 sm:col-span-5 flex items-center gap-3 min-w-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          e.stopPropagation();
                          const next = new Set(selectedItemNames);
                          if (e.target.checked) {
                            next.add(item.name);
                          } else {
                            next.delete(item.name);
                          }
                          setSelectedItemNames(next);
                        }}
                        className="w-3.5 h-3.5 rounded accent-accent cursor-pointer flex-shrink-0"
                      />
                      <div
                        onClick={() => {
                          if (item.is_dir) {
                            setSegments([...segments, item.name]);
                            setSearchQuery("");
                          } else {
                            handlePreviewFile(item);
                          }
                        }}
                        className="flex items-center gap-3 min-w-0 truncate cursor-pointer"
                        title={item.is_dir ? `Open folder ${item.name}` : `Preview ${item.name}`}
                      >
                        <Icon
                          size={18}
                          className={
                            item.is_dir
                              ? "text-accent flex-shrink-0 group-hover:scale-110 transition-transform"
                              : "text-subtle flex-shrink-0 group-hover:text-accent transition-colors"
                          }
                        />
                        <span
                          className={`font-body text-sm truncate ${
                            item.is_dir
                              ? "text-bright font-medium group-hover:text-accent transition-colors"
                              : "text-bright/90 group-hover:text-bright"
                          }`}
                        >
                          {item.name}
                        </span>
                      </div>
                    </div>

                    {/* Date Modified */}
                    <div className="hidden sm:block sm:col-span-3 text-right font-mono text-xs text-subtle/80 truncate">
                      {formatDate(item.mod_time)}
                    </div>

                    {/* Size */}
                    <div className="col-span-2 sm:col-span-1 text-right font-mono text-xs text-subtle">
                      {item.is_dir ? "--" : formatSize(item.size)}
                    </div>

                    {/* Actions */}
                    <div className="col-span-4 sm:col-span-3 flex items-center justify-end gap-1 flex-wrap">
                      {item.is_dir ? (
                        <div className="flex items-center gap-1 opacity-100 sm:opacity-85 sm:group-hover:opacity-100 transition-opacity flex-wrap justify-end">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenCopyMoveSingle(item);
                            }}
                            className="p-1.5 rounded-lg bg-panel hover:bg-surface text-subtle hover:text-bright border border-border/50 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                            title={`Direct local or server-side Copy / Move folder "${item.name}"`}
                          >
                            <Copy size={13} />
                            <span className="hidden sm:inline">Copy/Move</span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenTransferSingle(item);
                            }}
                            className="p-1.5 rounded-lg bg-panel hover:bg-accent/20 text-subtle hover:text-accent border border-border/50 hover:border-accent/30 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                            title={`Cloud Transfer folder "${item.name}" to another remote via Kaggle / GHA`}
                          >
                            <ArrowRightLeft size={13} />
                            <span className="hidden sm:inline">Transfer</span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setTranscodeTarget({
                                sourceInput: getItemFullPath(item.name),
                                title: item.name,
                                sourceItems: [{ path: getItemFullPath(item.name), title: item.name, isDir: true }],
                              });
                            }}
                            className="p-1.5 rounded-lg bg-panel hover:bg-accent/20 text-accent border border-border/50 hover:border-accent/40 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                            title={`Transcode videos inside folder "${item.name}" to AV1`}
                          >
                            <Zap size={13} />
                            <span className="hidden sm:inline">Transcode</span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setTranscodeTarget({
                                sourceInput: getItemFullPath(item.name),
                                title: `Standardize ${item.name}`,
                                sourceItems: [{ path: getItemFullPath(item.name), title: item.name, isDir: true }],
                              });
                            }}
                            className="p-1.5 rounded-lg bg-panel hover:bg-cyan-500/20 text-subtle hover:text-cyan-400 border border-border/50 hover:border-cyan-500/30 transition-all flex items-center gap-1 text-[11px] font-mono px-2 cursor-pointer"
                            title={`Standardize media names (FileBot clean) inside "${item.name}"`}
                          >
                            <Sparkles size={13} />
                            <span className="hidden sm:inline">Rename</span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleConvertSubfolder(item.name);
                            }}
                            disabled={folderConverting === item.name}
                            className="p-1.5 rounded-lg bg-panel hover:bg-purple-500/20 text-subtle hover:text-purple-400 border border-border/50 hover:border-purple-500/30 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                            title={`Convert folder "${item.name}" into an M4B Audiobook`}
                          >
                            {folderConverting === item.name ? (
                              <Loader2 size={13} className="animate-spin text-purple-400" />
                            ) : (
                              <BookOpen size={13} />
                            )}
                            <span className="hidden sm:inline">M4B</span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const folderPath = getItemFullPath(item.name);
                              setFolderMatchTarget({ folderPath, folderName: item.name });
                            }}
                            className="p-1.5 rounded-lg bg-panel hover:bg-accent/20 text-subtle hover:text-accent border border-border/50 hover:border-accent/30 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                            title={`Match metadata for folder "${item.name}"`}
                          >
                            <Wrench size={13} />
                            <span className="hidden sm:inline">Match</span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOffloadSingleDropmb(item);
                            }}
                            disabled={dropmbOffloadingItem === item.name}
                            className="p-1.5 rounded-lg bg-panel hover:bg-cyan-500/20 text-subtle hover:text-cyan-400 border border-border/50 hover:border-cyan-500/30 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                            title={`Offload folder "${item.name}" files to DropMB 100-Day Cloud Share`}
                          >
                            {dropmbOffloadingItem === item.name ? (
                              <Loader2 size={13} className="animate-spin text-cyan-400" />
                            ) : (
                              <CloudUpload size={13} />
                            )}
                            <span className="hidden sm:inline">DropMB</span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadFolder(item.name);
                            }}
                            className="p-1.5 rounded-lg bg-panel hover:bg-teal/20 text-subtle hover:text-teal border border-border/50 hover:border-teal/30 transition-all"
                            title={`Download folder: ${item.name}`}
                          >
                            <FolderDown size={14} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameTarget({ item, newName: item.name });
                            }}
                            className="p-1.5 rounded-lg bg-panel hover:bg-surface text-subtle hover:text-bright border border-border/50 transition-all"
                            title={`Rename folder "${item.name}"`}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget([item]);
                            }}
                            className="p-1.5 rounded-lg bg-panel hover:bg-danger/20 text-subtle hover:text-danger border border-border/50 hover:border-danger/30 transition-all"
                            title={`Delete folder "${item.name}"`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 opacity-100 sm:opacity-85 sm:group-hover:opacity-100 transition-opacity flex-wrap justify-end">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePreviewFile(item);
                            }}
                            className="p-1.5 rounded-lg bg-accent/15 hover:bg-accent text-accent hover:text-void border border-accent/30 hover:border-accent transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                            title={`Preview "${item.name}"`}
                          >
                            <Eye size={12} />
                            <span className="hidden sm:inline">Preview</span>
                          </button>
                          <button
                            onClick={() => handleOpenCopyMoveSingle(item)}
                            className="p-1.5 rounded-lg bg-panel hover:bg-surface text-subtle hover:text-bright border border-border/50 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                            title={`Direct local or server-side Copy / Move "${item.name}"`}
                          >
                            <Copy size={13} />
                            <span className="hidden sm:inline">Copy/Move</span>
                          </button>
                          <button
                            onClick={() => handleOpenTransferSingle(item)}
                            className="p-1.5 rounded-lg bg-panel hover:bg-accent/20 text-subtle hover:text-accent border border-border/50 hover:border-accent/30 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                            title={`Cloud Transfer "${item.name}" to another remote via Kaggle / GHA`}
                          >
                            <ArrowRightLeft size={13} />
                            <span className="hidden sm:inline">Transfer</span>
                          </button>
                          {/* Telegram Serverless CDN Offload (< 2 GB) */}
                          {item.size <= 2000 * 1024 * 1024 && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOffloadSingleTelegram(item);
                              }}
                              disabled={telegramOffloadingItem === item.name}
                              className="p-1.5 rounded-lg bg-panel hover:bg-sky-500/20 text-subtle hover:text-sky-400 border border-border/50 hover:border-sky-500/30 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                              title={`Offload "${item.name}" to Telegram CDN (tg-serverless)`}
                            >
                              {telegramOffloadingItem === item.name ? (
                                <Loader2 size={13} className="animate-spin text-sky-400" />
                              ) : (
                                <CloudUpload size={13} />
                              )}
                              <span className="hidden sm:inline">tg-serverless</span>
                            </button>
                          )}
                          {isDropmbEligibleExtension(item.name) && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOffloadSingleDropmb(item);
                              }}
                              disabled={dropmbOffloadingItem === item.name}
                              className="p-1.5 rounded-lg bg-panel hover:bg-cyan-500/20 text-subtle hover:text-cyan-400 border border-border/50 hover:border-cyan-500/30 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                              title={`Offload "${item.name}" to DropMB (100-Day Cloud Cache)`}
                            >
                              {dropmbOffloadingItem === item.name ? (
                                <Loader2 size={13} className="animate-spin text-cyan-400" />
                              ) : (
                                <CloudUpload size={13} />
                              )}
                              <span className="hidden sm:inline">DropMB</span>
                            </button>
                          )}
                          {AUDIO_EXTS.includes(
                            item.name.split(".").pop()?.toLowerCase() || ""
                          ) && (
                            <button
                              onClick={() => handleConvertSingleFile(item)}
                              className="p-1.5 rounded-lg bg-panel hover:bg-purple-500/20 text-subtle hover:text-purple-400 border border-border/50 hover:border-purple-500/30 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                              title={`Convert "${item.name}" to M4B Audiobook`}
                            >
                              <BookOpen size={13} />
                              <span className="hidden sm:inline">M4B</span>
                            </button>
                          )}
                          {["mp4", "mkv", "avi", "mov", "webm", "m4v", "ts", "m2ts"].includes(
                            item.name.split(".").pop()?.toLowerCase() || ""
                          ) && (
                            <button
                              onClick={() => {
                                const remoteFilePath = getItemFullPath(item.name);
                                setTranscodeTarget({
                                  sourceInput: remoteFilePath,
                                  title: item.name,
                                });
                              }}
                              className="p-1.5 rounded-lg bg-panel hover:bg-accent/20 text-accent border border-border/50 hover:border-accent/40 transition-all flex items-center gap-1 text-[11px] font-mono px-2"
                              title={`Cloud Transcode to AV1 (Kaggle): ${item.name}`}
                            >
                              <Zap size={13} />
                              <span className="hidden sm:inline">Transcode</span>
                            </button>
                          )}
                          {!item.is_dir && /\.(zip|rar|7z|tar|tar\.gz|tgz)$/i.test(item.name) && (
                            <button
                              onClick={() => handleExtractHere(item)}
                              disabled={Boolean(extractingPath)}
                              className="p-1.5 rounded-lg bg-panel hover:bg-accent/20 text-subtle hover:text-accent border border-border/50 hover:border-accent/40 transition-all disabled:opacity-50"
                              title={`Extract Here: ${item.name}`}
                            >
                              {extractingPath && extractingPath.endsWith(item.name) ? (
                                <Loader2 size={13} className="animate-spin text-accent" />
                              ) : (
                                <ArchiveRestore size={13} />
                              )}
                            </button>
                          )}
                          <button
                            onClick={() => handleDownloadFile(item)}
                            className="p-1.5 rounded-lg bg-panel hover:bg-accent text-subtle hover:text-void border border-border/50 hover:border-accent transition-all"
                            title={`Download file: ${item.name}`}
                          >
                            <Download size={13} />
                          </button>
                          <button
                            onClick={() => handleShowFileInfo(item)}
                            className="p-1.5 rounded-lg bg-panel hover:bg-surface text-subtle hover:text-bright border border-border/50 transition-all"
                            title="File Details & Stream Link"
                          >
                            <Info size={13} />
                          </button>
                          <button
                            onClick={() => handleShareItem(item)}
                            className="p-1.5 rounded-lg bg-panel hover:bg-emerald-500/20 text-subtle hover:text-emerald-400 border border-border/50 hover:border-emerald-500/30 transition-all"
                            title="Share Public Link (Copy to Clipboard)"
                          >
                            <Share2 size={13} />
                          </button>
                          <button
                            onClick={() => setRenameTarget({ item, newName: item.name })}
                            className="p-1.5 rounded-lg bg-panel hover:bg-surface text-subtle hover:text-bright border border-border/50 transition-all"
                            title={`Rename file "${item.name}"`}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => setDeleteTarget([item])}
                            className="p-1.5 rounded-lg bg-panel hover:bg-danger/20 text-subtle hover:text-danger border border-border/50 hover:border-danger/30 transition-all"
                            title={`Delete file "${item.name}"`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Active Downloads Floating Progress Bar */}
      {Object.values(activeDownloads).filter((d) => d.status === "downloading").length > 0 && (
        <div className="p-4 bg-panel border-t border-border flex items-center justify-between shadow-2xl">
          <div className="flex items-center gap-3">
            <Loader2 size={18} className="text-accent animate-spin" />
            <div>
              <p className="font-body text-xs font-semibold text-bright">
                Downloading {Object.values(activeDownloads).filter((d) => d.status === "downloading").length} item(s)...
              </p>
              <p className="font-mono text-[11px] text-subtle">
                Files saved to ~/Downloads/RcloneFlix
              </p>
            </div>
          </div>
          <button
            onClick={handleOpenDownloadsFolder}
            className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
          >
            <FolderOpen size={13} />
            <span>Open Folder</span>
          </button>
        </div>
      )}

      {/* Floating Batch Selection Bar */}
      <AnimatePresence>
        {selectedItemNames.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 30 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 px-5 py-3 rounded-2xl bg-panel/95 border border-accent/40 shadow-2xl backdrop-blur-xl flex items-center gap-3 text-xs font-mono flex-wrap justify-center"
          >
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
              <span className="text-bright font-semibold">
                {selectedItemNames.size} item{selectedItemNames.size === 1 ? "" : "s"} selected
              </span>
            </div>

            <div className="h-4 w-px bg-border/60 hidden sm:block" />

            <button
              onClick={() => handleOpenCopyMoveBatch("copy")}
              className="px-3 py-1.5 rounded-xl bg-panel hover:bg-surface text-bright border border-border/80 font-semibold flex items-center gap-1.5 transition-all shadow-md"
              title="Direct local/server-side Copy or Move"
            >
              <Copy size={13} />
              <span>Copy / Move</span>
            </button>

            {items.some((it) => selectedItemNames.has(it.name) && (it.is_dir || ["mp4", "mkv", "avi", "mov", "webm", "ts"].includes(it.name.split(".").pop()?.toLowerCase() || ""))) && (
              <button
                onClick={() => {
                  const selectedList = items.filter((it) => selectedItemNames.has(it.name));
                  const videoOrDir = selectedList.filter((it) => it.is_dir || ["mp4", "mkv", "avi", "mov", "webm", "ts"].includes(it.name.split(".").pop()?.toLowerCase() || ""));
                  if (videoOrDir.length === 0) return;
                  setTranscodeTarget({
                    sourceInput: getItemFullPath(videoOrDir[0].name),
                    title: videoOrDir[0].name,
                    sourceItems: videoOrDir.map((it) => ({
                      path: getItemFullPath(it.name),
                      title: it.name,
                      isDir: it.is_dir,
                    })),
                  });
                }}
                className="px-3 py-1.5 rounded-xl bg-accent/20 hover:bg-accent/30 text-accent border border-accent/40 font-semibold flex items-center gap-1.5 transition-all shadow-md"
                title="Transcode selected video files or folders"
              >
                <Zap size={13} />
                <span>Transcode Selected</span>
              </button>
            )}

            <button
              onClick={handleOpenTransferBatch}
              className="px-3.5 py-1.5 rounded-xl bg-accent text-void font-bold flex items-center gap-1.5 hover:bg-accent-hover transition-all shadow-md"
              title="Cloud Worker Transfer via Kaggle / GitHub Actions"
            >
              <ArrowRightLeft size={13} />
              <span>Cloud Transfer</span>
            </button>

            <button
              onClick={handleDownloadBatch}
              className="px-3 py-1.5 rounded-xl bg-teal/15 hover:bg-teal/25 text-teal border border-teal/30 font-semibold flex items-center gap-1.5 transition-all"
            >
              <Download size={13} />
              <span>Download Selected</span>
            </button>

            <button
              onClick={handleOffloadBatchDropmb}
              disabled={dropmbOffloadingItem === "batch"}
              className="px-3.5 py-1.5 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 font-semibold flex items-center gap-1.5 transition-all shadow-md disabled:opacity-50"
              title="Offload selected eligible files and folders to DropMB (100-Day Cloud Cache)"
            >
              {dropmbOffloadingItem === "batch" ? (
                <Loader2 size={13} className="animate-spin text-cyan-300" />
              ) : (
                <CloudUpload size={13} />
              )}
              <span>DropMB Offload</span>
            </button>

            <button
              onClick={() => {
                const selectedList = items.filter((it) => selectedItemNames.has(it.name));
                setDeleteTarget(selectedList);
              }}
              className="px-3 py-1.5 rounded-xl bg-danger/15 hover:bg-danger/25 text-danger border border-danger/30 font-semibold flex items-center gap-1.5 transition-all"
            >
              <Trash2 size={13} />
              <span>Delete Selected</span>
            </button>

            <button
              onClick={() => setSelectedItemNames(new Set())}
              className="px-2.5 py-1.5 rounded-xl hover:bg-surface text-subtle hover:text-bright transition-colors"
            >
              Clear
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating DropMB Progress Notification */}
      <AnimatePresence>
        {dropmbProgress && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-2xl bg-panel/95 border border-cyan-500/40 shadow-2xl backdrop-blur-xl flex items-center gap-3 text-xs font-mono text-bright"
          >
            <Loader2 size={14} className="animate-spin text-cyan-400" />
            <span>{dropmbProgress.msg}</span>
            <span className="text-cyan-400 font-bold ml-1">{dropmbProgress.pct}%</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cloud Transcode Modal */}
      {transcodeTarget && (
        <CloudTranscodeModal
          isOpen={true}
          onClose={() => setTranscodeTarget(null)}
          sourceInput={transcodeTarget.sourceInput}
          sourceItems={transcodeTarget.sourceItems}
          initialTitle={transcodeTarget.title}
        />
      )}

      {/* Cloud Transfer Modal */}
      {transferTarget && (
        <CloudTransferModal
          isOpen={true}
          onClose={() => setTransferTarget(null)}
          sourceRemote={selectedRemote}
          sourcePath={currentPath}
          items={transferTarget.items}
          isSingleItem={transferTarget.isSingle}
          initialUrlMode={transferTarget.isUrl}
          initialOperation={transferTarget.initialOperation}
          initialWorker={transferTarget.initialWorker}
          onDispatched={() => {
            setSelectedItemNames(new Set());
            notifyRemoteMutated();
            fetchDirectory();
            setShowTransferDrawer(true);
          }}
        />
      )}

      {/* Cloud Transfer Drawer */}
      <CloudTransferDrawer
        isOpen={showTransferDrawer}
        onClose={() => setShowTransferDrawer(false)}
      />

      {/* Audiobook M4B Converter Modal */}
      {showAudiobookConverter && selectedBookForConvert.length > 0 && (
        <AudiobookConverterModal
          items={selectedBookForConvert}
          onClose={() => {
            setShowAudiobookConverter(false);
            setSelectedBookForConvert([]);
          }}
          onSuccess={(out) => {
            setShowAudiobookConverter(false);
            setSelectedBookForConvert([]);
            useToastStore.getState().addToast(`M4B Audiobook created: ${out}`, "success");
          }}
        />
      )}

      {/* Cloud Transcode Modal */}

      {/* Create New Folder Modal */}
      {showNewFolderModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-panel border border-border rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <h3 className="font-display text-lg text-bright">Create New Folder</h3>
            <p className="text-xs text-subtle font-mono truncate">In: {currentPath}</p>
            <input
              type="text"
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); }}
              placeholder="Folder name..."
              className="input-field w-full text-sm font-body py-2"
            />
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                onClick={() => setShowNewFolderModal(false)}
                className="btn-secondary text-xs py-2 px-4"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateFolder}
                disabled={isCreatingFolder || !newFolderName.trim()}
                className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
              >
                {isCreatingFolder && <Loader2 size={13} className="animate-spin" />}
                <span>Create</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename File / Folder Modal */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-panel border border-border rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <h3 className="font-display text-lg text-bright">Rename {renameTarget.item.is_dir ? "Folder" : "File"}</h3>
            <p className="text-xs text-subtle font-mono truncate">Current: {renameTarget.item.name}</p>
            <input
              type="text"
              autoFocus
              value={renameTarget.newName}
              onChange={(e) => setRenameTarget({ ...renameTarget, newName: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") handleRename(); }}
              placeholder="New name..."
              className="input-field w-full text-sm font-body py-2"
            />
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                onClick={() => setRenameTarget(null)}
                className="btn-secondary text-xs py-2 px-4"
              >
                Cancel
              </button>
              <button
                onClick={handleRename}
                disabled={isRenaming || !renameTarget.newName.trim()}
                className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
              >
                {isRenaming && <Loader2 size={13} className="animate-spin" />}
                <span>Rename</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (() => {
        const delClass = classifyDeleteItems(
          selectedRemote,
          currentPath,
          deleteTarget.map((it) => it.name),
          isLocalRemote
        );
        return (
          <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-panel border border-danger/40 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
              <div className="flex items-center gap-2.5 text-danger">
                <AlertCircle size={22} />
                <h3 className="font-display text-lg text-bright">
                  {delClass.mode === "soft"
                    ? "Move to RcloneFlix App Trash"
                    : delClass.mode === "mixed"
                    ? "Select App Trash Folder Separately"
                    : "Confirm Deletion"}
                </h3>
              </div>
              <p className="text-xs text-text font-body leading-relaxed">
                {delClass.mode === "soft" ? (
                  <>
                    Move{" "}
                    <span className="font-bold font-mono text-bright">
                      {deleteTarget.length === 1 ? deleteTarget[0].name : `${deleteTarget.length} items`}
                    </span>{" "}
                    into{" "}
                    <span className="font-mono text-accent">
                      {selectedRemote}:{delClass.trashDir}/&lt;timestamp&gt;/
                    </span>
                    ? You can restore or permanently empty them later from Cloud Explorer.
                  </>
                ) : delClass.mode === "mixed" ? (
                  <>
                    Cannot delete the App Trash folder (<span className="font-mono text-danger">{delClass.trashDir}</span>) in the same batch as other items (purging the trash folder would destroy the newly soft-deleted items). Deselect{" "}
                    <span className="font-mono text-bright">{delClass.trashDir}</span> or select it alone to empty it.
                  </>
                ) : (
                  <>
                    Are you sure you want to permanently delete{" "}
                    <span className="font-bold font-mono text-danger">
                      {deleteTarget.length === 1 ? deleteTarget[0].name : `${deleteTarget.length} items`}
                    </span>{" "}
                    from <span className="font-mono text-accent">{selectedRemote}{isLocalRemote ? "" : ":"}</span>? This operation cannot be undone.
                  </>
                )}
              </p>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  onClick={() => setDeleteTarget(null)}
                  className="btn-secondary text-xs py-2 px-4"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteConfirmed}
                  disabled={isDeleting || delClass.mode === "mixed"}
                  className="px-4 py-2 rounded-xl bg-danger hover:bg-danger/80 text-white font-body text-xs font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50"
                >
                  {isDeleting && <Loader2 size={13} className="animate-spin" />}
                  <span>
                    {delClass.mode === "soft"
                      ? "Move to App Trash"
                      : delClass.mode === "mixed"
                      ? "Select Trash Separately"
                      : "Delete Permanently"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* File Info Modal */}
      {fileInfoTarget && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-panel border border-border rounded-2xl p-6 w-full max-w-lg shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Info size={18} className="text-accent" />
                <h3 className="font-display text-lg text-bright">File Details</h3>
              </div>
              <button
                onClick={closeFileInfo}
                className="text-subtle hover:text-white p-1 rounded-lg"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3 font-mono text-xs">
              <div className="p-3 rounded-xl bg-surface/50 border border-border/50 space-y-2">
                <div>
                  <span className="text-subtle text-[11px] uppercase block">Filename</span>
                  <span className="text-bright font-medium break-all">{fileInfoTarget.item.name}</span>
                </div>
                <div>
                  <span className="text-subtle text-[11px] uppercase block">Remote Path</span>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="text-accent break-all">{fileInfoTarget.fullPath}</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(fileInfoTarget.fullPath);
                        setCopiedPath(true);
                        setTimeout(() => setCopiedPath(false), 2000);
                      }}
                      className="p-1 rounded bg-panel hover:bg-surface text-subtle hover:text-bright transition-colors shrink-0"
                      title="Copy Remote Path"
                    >
                      {copiedPath ? <Check size={13} className="text-teal" /> : <Copy size={13} />}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border/40">
                  <div>
                    <span className="text-subtle text-[11px] uppercase block">Size</span>
                    <span className="text-bright">
                      {formatSize(fileInfoTarget.item.size)} ({fileInfoTarget.item.size.toLocaleString()} bytes)
                    </span>
                  </div>
                  <div>
                    <span className="text-subtle text-[11px] uppercase block">Type</span>
                    <span className="text-bright">
                      {fileInfoTarget.item.is_dir ? "Directory" : fileInfoTarget.item.name.split(".").pop()?.toUpperCase() || "File"}
                    </span>
                  </div>
                </div>
              </div>

              {fileInfoTarget.streamUrl && (
                <div className="p-3 rounded-xl bg-surface/50 border border-border/50 space-y-1.5">
                  <span className="text-subtle text-[11px] uppercase block">Direct HTTP Stream Link</span>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-teal text-[11px] truncate">{fileInfoTarget.streamUrl}</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(fileInfoTarget.streamUrl!);
                        setCopiedStreamUrl(true);
                        setTimeout(() => setCopiedStreamUrl(false), 2000);
                      }}
                      className="p-1.5 rounded-lg bg-teal/15 hover:bg-teal/25 text-teal transition-colors shrink-0 flex items-center gap-1 font-body text-xs"
                      title="Copy Direct URL"
                    >
                      {copiedStreamUrl ? <Check size={13} /> : <Copy size={13} />}
                      <span>{copiedStreamUrl ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {!isAndroidRuntime() && !isLocalRemote && (() => {
              const trashInfo = inspectAppTrashPath(fileInfoTarget.fullPath);
              if (trashInfo.isTimestampRoot) {
                return (
                  <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                    This is a timestamped trash snapshot folder ({trashInfo.trashDirName}). Open this folder to restore individual items inside it.
                  </p>
                );
              }
              return null;
            })()}

            <div className="flex flex-wrap justify-end gap-2 pt-1">
              {!isAndroidRuntime() && !isLocalRemote && !fileInfoTarget.item.is_dir && (
                <VerifyChecksumButton fullPath={fileInfoTarget.fullPath} />
              )}
              {!isAndroidRuntime() &&
                !isLocalRemote &&
                inspectAppTrashPath(fileInfoTarget.fullPath).canRestore && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const restored = await restoreFromRcloneFlixAppTrash(fileInfoTarget.fullPath);
                        useToastStore.getState().addToast(`Restored to ${restored}`, "success");
                        closeFileInfo();
                        fetchDirectory();
                      } catch (err: any) {
                        useToastStore.getState().addToast(`Restore failed: ${err?.message || err}`, "error");
                      }
                    }}
                    className="btn-primary text-xs py-2 px-3"
                  >
                    Restore from App Trash
                  </button>
                )}
              <button
                onClick={closeFileInfo}
                className="btn-secondary text-xs py-2 px-4"
              >
                Close
              </button>
              {!fileInfoTarget.item.is_dir && (
                <button
                  onClick={() => {
                    const it = fileInfoTarget.item;
                    closeFileInfo();
                    handlePreviewFile(it);
                  }}
                  className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
                >
                  <Eye size={13} />
                  <span>Open Preview</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Image Preview Lightbox */}
      {imagePreview && (
        <div
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-4 cursor-pointer"
          onClick={() => {
            stopActiveSession();
            if (imageBlobUrl) {
              URL.revokeObjectURL(imageBlobUrl);
              setImageBlobUrl(null);
            }
            setImagePreview(null);
          }}
        >
          <div className="relative max-w-4xl max-h-[85vh] flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
            <div className="w-full flex items-center justify-between pb-3 text-white">
              <div className="font-body text-sm font-medium truncate max-w-md">{imagePreview.title}</div>
              <button
                onClick={() => {
                  stopActiveSession();
                  if (imageBlobUrl) {
                    URL.revokeObjectURL(imageBlobUrl);
                    setImageBlobUrl(null);
                  }
                  setImagePreview(null);
                }}
                className="p-1 rounded-lg bg-white/10 hover:bg-white/20 text-white"
              >
                <X size={18} />
              </button>
            </div>
            <img
              src={imageBlobUrl || imagePreview.url}
              alt={imagePreview.title}
              onError={async () => {
                if (!imageBlobUrl) {
                  try {
                    const r = await fetch(imagePreview.url);
                    const b = await r.blob();
                    const objectUrl = URL.createObjectURL(
                      new Blob([await b.arrayBuffer()], {
                        type: imagePreview.title.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg",
                      })
                    );
                    setImageBlobUrl(objectUrl);
                  } catch (e) {
                    console.warn("Failed loading image preview blob fallback:", e);
                  }
                }
              }}
              className="max-w-full max-h-[75vh] rounded-xl object-contain shadow-2xl border border-white/10"
            />
          </div>
        </div>
      )}

      {/* Text Preview Modal */}
      {textPreview && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-panel border border-border rounded-2xl p-6 w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl space-y-3">
            <div className="flex items-center justify-between border-b border-border/50 pb-3">
              <div className="flex items-center gap-2">
                <FileText size={18} className="text-accent" />
                <h3 className="font-body text-sm font-semibold text-bright truncate max-w-md">{textPreview.title}</h3>
              </div>
              <button onClick={() => { stopActiveSession(); setTextPreview(null); }} className="text-subtle hover:text-white p-1 rounded-lg">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto bg-surface/60 p-4 rounded-xl border border-border/40 font-mono text-xs text-bright/90 whitespace-pre-wrap leading-relaxed">
              {textPreview.loading ? (
                <div className="flex items-center justify-center h-32 gap-2 text-subtle">
                  <Loader2 size={18} className="animate-spin text-accent" />
                  <span>Loading text...</span>
                </div>
              ) : (
                textPreview.content
              )}
            </div>
            <div className="flex justify-end pt-1">
              <button onClick={() => setTextPreview(null)} className="btn-secondary text-xs py-1.5 px-4">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Folder Metadata Match Modal */}
      {folderMatchTarget && (
        <FolderMatchModal
          isOpen={!!folderMatchTarget}
          onClose={() => setFolderMatchTarget(null)}
          folderPath={folderMatchTarget.folderPath}
          folderName={folderMatchTarget.folderName}
          defaultCategory={
            folderMatchTarget.folderPath.toLowerCase().includes("music") ||
            folderMatchTarget.folderName.toLowerCase().includes("album")
              ? "music"
              : folderMatchTarget.folderPath.toLowerCase().includes("book") ||
                folderMatchTarget.folderPath.toLowerCase().includes("audiobook")
              ? "audiobooks"
              : folderMatchTarget.folderPath.toLowerCase().includes("movie")
              ? "movies"
              : "tv"
          }
          onMatchApplied={() => {
            fetchDirectory();
          }}
        />
      )}

      {/* Zero-Bandwidth Direct Stream Link Modal */}
      {shareModalTarget && (
        <ShareStreamLinkModal
          remoteName={shareModalTarget.remoteName}
          filePath={shareModalTarget.filePath}
          fileName={shareModalTarget.fileName}
          fileSize={shareModalTarget.fileSize}
          onClose={() => setShareModalTarget(null)}
        />
      )}
    </div>
  );
}
