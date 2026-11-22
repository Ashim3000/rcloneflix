import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  ArrowRightLeft,
  Copy,
  Move,
  RefreshCw,
  HardDrive,
  Sliders,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Folder,
  File,
  ShieldAlert,
  Zap,
  Globe,
  Send,
  Film,
  Link as LinkIcon,
  Cpu,
  GitBranch,
} from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import {
  useCloudTransferStore,
  type TransferOperation,
} from "../../lib/kaggleTransfer";
import {
  dispatchCloudTask,
  getActiveKaggleJobCount,
  type ProviderSelection,
} from "../../lib/cloudWorkerRouter";
import { invoke } from "@tauri-apps/api/core";
import { RemoteBrowser } from "../common/RemoteBrowser";

export type TransferExecutionTarget = ProviderSelection | "local";

type RcloneListItem = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  sourceRemote: string;
  sourcePath: string; // e.g. "odrivecrypt:/Movies"
  items?: RcloneListItem[]; // selected items if batch, or single item
  isSingleItem?: boolean;
  initialUrlMode?: boolean;
  initialDirectUrl?: string;
  initialOperation?: TransferOperation;
  initialWorker?: TransferExecutionTarget;
  onDispatched?: () => void;
};

function joinRemotePath(basePath: string, childName: string): string {
  const trimmedChild = childName.replace(/^\/+|\/+$/g, "");
  if (!trimmedChild) return basePath;
  if (basePath.endsWith(":")) return `${basePath}${trimmedChild}`;
  return `${basePath.replace(/\/+$/, "")}/${trimmedChild}`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function CloudTransferModal({
  isOpen,
  onClose,
  sourceRemote,
  sourcePath,
  items = [],
  isSingleItem = false,
  initialUrlMode = false,
  initialDirectUrl = "",
  initialOperation,
  initialWorker,
  onDispatched,
}: Props) {
  const {
    remotes,
    rcloneConfigPath,
    kaggleUsername,
    kaggleKey,
    rcloneConfigContent,
    telegramConfig,
    streamtapeConfig,
    ghaConfig,
    libraries,
  } = useAppStore();
  const addToast = useToastStore((s) => s.addToast);
  const addJob = useCloudTransferStore((s) => s.addJob);

  const localLibraryPaths = useMemo(() => {
    const list: Array<{ label: string; path: string }> = [];
    const seen = new Set<string>();
    for (const lib of libraries) {
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

  const isSourceLocal = useMemo(() => {
    return (
      sourcePath.startsWith("/") ||
      sourcePath.startsWith("\\") ||
      /^[a-zA-Z]:[/\\]/.test(sourcePath) ||
      sourcePath.startsWith("local:")
    );
  }, [sourcePath]);

  const [workerProvider, setWorkerProvider] = useState<TransferExecutionTarget>(
    initialWorker || (isSourceLocal ? "local" : "auto")
  );
  const activeKaggleJobs = getActiveKaggleJobCount();
  const isGhaConfigured = Boolean(
    ghaConfig?.enabled && ghaConfig?.token?.trim() && ghaConfig?.owner?.trim() && ghaConfig?.repo?.trim()
  );
  const isKaggleConfigured = Boolean(kaggleUsername?.trim() && kaggleKey?.trim());

  const isNoPathOffloadRemote = (rem: string): boolean => {
    const lower = (rem || "").trim().toLowerCase().replace(/:.*$/, "");
    return lower === "streamtape" || lower === "telegram";
  };

  // Available destination remotes (all personal remotes including offload remotes; only excluding Guest Pass shared_*)
  const destinationRemotes = useMemo(() => {
    return remotes
      .filter((r) => !r.name.startsWith("shared_"))
      .map((r) => r.name);
  }, [remotes]);

  // Source Mode: "remote" vs "url"
  const [sourceType, setSourceType] = useState<"remote" | "url">(
    initialDirectUrl || initialUrlMode ? "url" : "remote"
  );
  const [directUrl, setDirectUrl] = useState<string>(initialDirectUrl || "");

  // Form state
  const [operation, setOperation] = useState<TransferOperation>(initialOperation || "copy");
  const [destRemote, setDestRemote] = useState<string>(() => {
    if (initialUrlMode) {
      if (telegramConfig?.enabled && telegramConfig?.botToken) return "telegram";
      if (streamtapeConfig?.enabled && streamtapeConfig?.apiKey) return "streamtape";
    }
    const other = destinationRemotes.find((r) => r !== sourceRemote);
    return (
      other ||
      sourceRemote ||
      destinationRemotes[0] ||
      "odrivecrypt"
    );
  });

  // Default destination path (e.g. mirror folder name or root)
  const defaultSubfolder = useMemo(() => {
    if ((isSingleItem || items.length === 1) && items.length === 1) {
      return "";
    }
    if (sourcePath.endsWith(":")) {
      return "";
    }
    const match = sourcePath.match(/^[^:]*:\/?(.*)$/);
    return match ? match[1].replace(/^\/+|\/+$/g, "") : "";
  }, [sourcePath, isSingleItem, items]);

  const [destFolder, setDestFolder] = useState<string>(() => {
    if (isNoPathOffloadRemote(destRemote)) return "";
    return defaultSubfolder.replace(/^[a-zA-Z0-9_-]+:\/*/, "");
  });
  const [showDestBrowser, setShowDestBrowser] = useState<boolean>(false);
  const [transfers, setTransfers] = useState<number>(4);
  const [checkers, setCheckers] = useState<number>(8);
  const [driveServerSide, setDriveServerSide] = useState<boolean>(true);
  const [dryRun, setDryRun] = useState<boolean>(false);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [showItemsList, setShowItemsList] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Total size of selected items
  const totalSizeBytes = useMemo(() => {
    return items.reduce((sum, it) => sum + (it.size > 0 ? it.size : 0), 0);
  }, [items]);

  const isDestLocal = useMemo(() => {
    return (
      destRemote.startsWith("/") ||
      destRemote.startsWith("\\") ||
      /^[a-zA-Z]:[/\\]/.test(destRemote) ||
      destRemote.startsWith("local:")
    );
  }, [destRemote]);

  // Destination preview string (always empty destination path for streamtape & telegram offload remotes)
  const cleanDestPath = useMemo(() => {
    if (destRemote === "telegram") {
      return "telegram:";
    }
    if (destRemote === "streamtape") {
      return "streamtape:";
    }
    const strippedFolder = destFolder.trim().replace(/^[a-zA-Z0-9_-]+:\/*/, "").replace(/^\/+/, "");
    if (isDestLocal) {
      const cleanRoot = destRemote.replace(/^local:/, "");
      return strippedFolder ? `${cleanRoot}/${strippedFolder}`.replace(/\/+/g, "/") : cleanRoot;
    }
    if (!strippedFolder) return `${destRemote}:`;
    return `${destRemote}:/${strippedFolder}`;
  }, [destRemote, destFolder, isDestLocal]);

  // Transfer title
  const transferTitle = useMemo(() => {
    if (sourceType === "url") {
      if (!directUrl.trim()) return "Web URL Offload";
      try {
        const parsed = new URL(directUrl.trim());
        const filename = parsed.pathname.split("/").filter(Boolean).pop();
        return filename ? decodeURIComponent(filename) : directUrl.trim();
      } catch {
        return directUrl.trim();
      }
    }
    if ((isSingleItem || items.length === 1) && items.length === 1) {
      return items[0].name;
    }
    if (items.length > 1) {
      return `${items.length} items from ${sourceRemote}`;
    }
    const cleanSource = sourcePath.split("/").filter(Boolean).pop() || sourceRemote;
    return cleanSource;
  }, [sourceType, directUrl, isSingleItem, items, sourcePath, sourceRemote]);

  const isDirectServiceDest = destRemote === "telegram" || destRemote === "streamtape";
  const isUrlMode = sourceType === "url";

  if (!isOpen) return null;

  const handleSubmit = async () => {
    setErrorMsg("");

    if (workerProvider === "kaggle" && !isKaggleConfigured) {
      setErrorMsg(
        "Kaggle API credentials not found. Please configure them in Settings -> Cloud Transcoder / Transfers."
      );
      return;
    }
    if (workerProvider === "github_actions" && !isGhaConfigured) {
      setErrorMsg(
        "GitHub Actions token, owner, and repository are required. Please configure them in Settings -> Cloud Transcoder / Transfers."
      );
      return;
    }
    if (workerProvider === "auto" && !isKaggleConfigured && !isGhaConfigured) {
      setErrorMsg(
        "Neither Kaggle nor GitHub Actions is configured. Please configure at least one in Settings."
      );
      return;
    }

    if (!destRemote) {
      setErrorMsg("Please select a destination target.");
      return;
    }

    if (sourceType === "url") {
      const trimmedUrl = directUrl.trim();
      if (!trimmedUrl || !/^https?:\/\//i.test(trimmedUrl)) {
        setErrorMsg("Please enter a valid HTTP or HTTPS Web URL to offload.");
        return;
      }
    }

    if (destRemote === "telegram" && workerProvider !== "local") {
      if (!telegramConfig?.botToken?.trim()) {
        setErrorMsg("Telegram Bot Token is not configured. Please configure it in Settings -> Telegram Uploader.");
        return;
      }
      const targetChat = telegramConfig?.chatId?.trim();
      if (!targetChat) {
        setErrorMsg("Telegram Target Chat / Channel ID is required in Settings -> Telegram.");
        return;
      }
    }

    if (destRemote === "streamtape" && workerProvider !== "local") {
      if (!streamtapeConfig?.apiLogin?.trim() || !streamtapeConfig?.apiKey?.trim()) {
        setErrorMsg("Streamtape API Login and Key are not configured. Please configure them in Settings -> Streamtape & AList.");
        return;
      }
    }

    setIsSubmitting(true);
    if (!isDestLocal && sourceType !== "url" && totalSizeBytes > 0) {
      import("../../lib/rcloneNative")
        .then(({ checkRemoteFreeSpaceWarning }) =>
          checkRemoteFreeSpaceWarning(destRemote, totalSizeBytes, "transfer")
        )
        .then((warn) => {
          if (warn) useToastStore.getState().addToast(warn, "info");
        })
        .catch(() => {});
    }

    try {
      const jobId = `transfer-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

      // Calculate batch items list if applicable
      let batchItemsArg: string[] | undefined = undefined;
      let effectiveSource = sourcePath;

      const isSingleSelection = isSingleItem || items.length === 1;

      if (sourceType === "url") {
        effectiveSource = directUrl.trim();
        batchItemsArg = undefined;
      } else if (items.length > 0) {
        if (isSingleSelection) {
          // Single item transfer (direct path without full folder scanning / filter overhead)
          const item = items[0];
          effectiveSource = joinRemotePath(sourcePath, item.name);
          batchItemsArg = undefined;
        } else {
          // Batch transfer of selected items within source folder
          batchItemsArg = items.map((it) => it.name.trim().replace(/^\/+|\/+$/g, ""));
          effectiveSource = sourcePath;
        }
      }

      const effectiveOp = sourceType === "url" ? "copy" : operation;

      // Handle Direct Local Execution (runs on host machine without cloud worker)
      if (workerProvider === "local") {
        const op = effectiveOp === "move" ? "rclone_rename_file" : "rclone_copy_file";
        if (batchItemsArg && batchItemsArg.length > 0) {
          for (let i = 0; i < batchItemsArg.length; i++) {
            const itemName = batchItemsArg[i];
            const src = joinRemotePath(effectiveSource, itemName);
            const dst = joinRemotePath(cleanDestPath, itemName);
            await invoke(op, {
              configPath: rcloneConfigPath || "",
              fromPath: src,
              toPath: dst,
            });
          }
        } else {
          let dst = cleanDestPath;
          if (items.length === 1) {
            dst = joinRemotePath(cleanDestPath, items[0].name);
          } else if (!sourcePath.endsWith(":") && !isNoPathOffloadRemote(destRemote)) {
            const folderName = sourcePath.split("/").pop() || "";
            if (folderName && !cleanDestPath.endsWith(folderName)) {
              dst = joinRemotePath(cleanDestPath, folderName);
            }
          }
          await invoke(op, {
            configPath: rcloneConfigPath || "",
            fromPath: effectiveSource,
            toPath: dst,
          });
        }

        addToast(
          `Local ${effectiveOp} completed: "${transferTitle}"!`,
          "success"
        );
        onClose();
        if (onDispatched) onDispatched();
        return;
      }

      const targetTgChat = telegramConfig?.chatId?.trim() || undefined;

      let effectiveDest = cleanDestPath;
      if (isSingleSelection && items[0]?.is_dir && !isNoPathOffloadRemote(destRemote)) {
        effectiveDest = joinRemotePath(cleanDestPath, items[0].name);
      }

      const cleanEffectiveSource = effectiveSource.trim().replace(/^([a-zA-Z0-9_-]+:)\1+/, "$1");

      const dispatchRes = await dispatchCloudTask({
        jobType: "rclone_transfer",
        payload: {
          job_id: jobId,
          operation: effectiveOp,
          source: cleanEffectiveSource,
          destination: effectiveDest,
          batch_items: batchItemsArg,
          transfers,
          checkers,
          drive_server_side_copy: driveServerSide,
          dry_run: dryRun,
          rclone_config_snippet: rcloneConfigContent || undefined,
          telegram_bot_token: telegramConfig?.botToken?.trim() || undefined,
          telegram_chat_id: targetTgChat,
          telegram_api_id: telegramConfig?.apiId?.trim() || undefined,
          telegram_api_hash: telegramConfig?.apiHash?.trim() || undefined,
          streamtape_api_login: streamtapeConfig?.apiLogin?.trim() || undefined,
          streamtape_api_key: streamtapeConfig?.apiKey?.trim() || undefined,
        },
        title: transferTitle,
        providerOverride: workerProvider,
      });

      // Add to persistent store
      addJob({
        id: jobId,
        title: transferTitle,
        operation: effectiveOp,
        source: effectiveSource,
        destination: cleanDestPath,
        batchItems: batchItemsArg,
        kernelSlug: dispatchRes.kernelSlug || dispatchRes.jobId,
        kernelUrl: dispatchRes.url,
        status: "queued",
        createdAt: Date.now(),
        transfers,
        checkers,
        dryRun,
        provider: dispatchRes.provider,
      });

      const workerLabel = dispatchRes.provider === "github_actions" ? "GitHub Actions Runner" : "Kaggle Cloud Worker";
      addToast(
        `🚀 Dispatched Cloud Offload: "${transferTitle}" to ${workerLabel}!`,
        "success"
      );

      onClose();
      if (onDispatched) {
        onDispatched();
      }
    } catch (err: any) {
      console.error("Cloud transfer dispatch error:", err);
      setErrorMsg(err?.message || String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-void/80 backdrop-blur-md">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="relative w-full max-w-2xl bg-panel border border-border/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/60 bg-surface/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
              <ArrowRightLeft size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-lg text-bright tracking-wide">
                  CLOUD-TO-CLOUD TRANSFER
                </h2>
                <span className="px-2 py-0.5 rounded-full bg-accent/15 border border-accent/30 text-accent font-mono text-[10px] uppercase font-semibold">
                  {workerProvider === "github_actions"
                    ? "GitHub Actions Runner"
                    : workerProvider === "kaggle"
                    ? "Kaggle 1Gbps+"
                    : "Auto Multi-Cloud"}
                </span>
              </div>
              <p className="text-subtle font-body text-xs mt-0.5">
                Execute direct transfers off-device with zero local bandwidth usage
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-subtle hover:text-bright hover:bg-surface border border-transparent hover:border-border transition-all"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Source Mode Toggle */}
          <div className="flex items-center gap-2 border-b border-border/40 pb-3">
            <button
              type="button"
              onClick={() => setSourceType("remote")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-xl font-mono text-xs transition-colors ${
                sourceType === "remote"
                  ? "bg-accent/15 text-accent font-semibold border border-accent/30"
                  : "text-subtle hover:text-bright hover:bg-surface/50 border border-transparent"
              }`}
            >
              <HardDrive size={13} />
              <span>Remote Storage {sourceRemote ? `(${sourceRemote})` : ""}</span>
            </button>

            <button
              type="button"
              onClick={() => setSourceType("url")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-xl font-mono text-xs transition-colors ${
                sourceType === "url"
                  ? "bg-accent/15 text-accent font-semibold border border-accent/30"
                  : "text-subtle hover:text-bright hover:bg-surface/50 border border-transparent"
              }`}
            >
              <Globe size={13} />
              <span>Direct Web URL Offload</span>
            </button>
          </div>

          {/* Source Card */}
          {sourceType === "remote" ? (
            <div className="p-4 rounded-xl bg-surface/40 border border-border/60 space-y-2">
              <div className="flex items-center justify-between text-xs font-mono text-subtle uppercase tracking-wider">
                <span>Source Remote & Path</span>
                {items.length > 0 && (
                  <span className="text-bright">
                    {items.length} {items.length === 1 ? "item" : "items"}
                    {totalSizeBytes > 0 ? ` (${formatBytes(totalSizeBytes)})` : ""}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm font-mono text-bright break-all">
                <HardDrive size={15} className="text-accent flex-shrink-0" />
                <span>{sourcePath}</span>
              </div>

              {/* If Batch items, preview toggle */}
              {items.length > 1 && (
                <div className="pt-2 border-t border-border/30">
                  <button
                    type="button"
                    onClick={() => setShowItemsList(!showItemsList)}
                    className="flex items-center gap-1.5 text-xs text-accent hover:underline font-mono"
                  >
                    <span>{showItemsList ? "Hide selected items" : `Preview ${items.length} selected items`}</span>
                    {showItemsList ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>

                  {showItemsList && (
                    <div className="mt-2 max-h-36 overflow-y-auto space-y-1 pr-1 font-mono text-xs text-subtle bg-panel/70 p-2.5 rounded-lg border border-border/40">
                      {items.map((it) => (
                        <div key={it.name} className="flex items-center justify-between py-0.5">
                          <div className="flex items-center gap-1.5 truncate">
                            {it.is_dir ? (
                              <Folder size={12} className="text-accent flex-shrink-0" />
                            ) : (
                              <File size={12} className="text-subtle flex-shrink-0" />
                            )}
                            <span className="truncate text-bright/90">{it.name}</span>
                          </div>
                          <span className="text-[11px] text-subtle/80 flex-shrink-0 ml-2">
                            {it.is_dir ? "folder" : formatBytes(it.size)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 rounded-xl bg-surface/40 border border-border/60 space-y-3">
              <div className="flex items-center justify-between text-xs font-mono text-subtle uppercase tracking-wider">
                <span>Web URL (HTTP / HTTPS)</span>
                <span className="text-accent text-[11px]">Direct Cloud Ingest</span>
              </div>
              <div>
                <input
                  type="url"
                  value={directUrl}
                  onChange={(e) => setDirectUrl(e.target.value)}
                  placeholder="https://example.com/movie.mkv or debrid download link..."
                  className="input-field text-xs font-mono w-full"
                  autoFocus
                />
              </div>
              <p className="text-[11px] text-subtle font-body leading-relaxed">
                Paste any direct HTTP or HTTPS download link. Kaggle will download the file at Gigabit cloud speeds into temporary cloud storage and push it directly to your target destination — consuming <strong className="text-bright">0 MB</strong> of your home internet bandwidth.
              </p>
            </div>
          )}

          {/* Operation Selector */}
          {isUrlMode ? (
            <div className="p-3.5 rounded-xl bg-surface/30 border border-border/70 flex items-center justify-between">
              <div>
                <span className="font-display text-xs text-bright uppercase tracking-wider">
                  Transfer Mode: Direct Cloud URL Ingest
                </span>
                <p className="text-[11px] text-subtle mt-0.5">
                  Direct web URL will be retrieved and copied to your target destination without local bandwidth.
                </p>
              </div>
              <span className="px-2.5 py-1 rounded-full bg-accent/15 border border-accent/30 text-accent font-mono text-[11px] font-semibold flex items-center gap-1 shrink-0">
                <Zap size={12} />
                <span>Zero Bandwidth</span>
              </span>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-subtle mb-2">
                Select Operation Mode
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Copy */}
                <button
                  type="button"
                  onClick={() => setOperation("copy")}
                  className={`p-3.5 rounded-xl border text-left transition-all relative ${
                    operation === "copy"
                      ? "bg-accent/10 border-accent text-bright shadow-sm ring-1 ring-accent"
                      : "bg-surface/30 border-border/70 hover:bg-surface/60 text-subtle hover:text-bright"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <Copy size={16} className={operation === "copy" ? "text-accent" : "text-subtle"} />
                    <span className="font-display text-sm tracking-wide text-bright">COPY</span>
                  </div>
                  <p className="font-body text-[11px] text-subtle leading-tight">
                    Non-destructive copy. Duplicates files to destination without touching source.
                  </p>
                </button>

                {/* Move */}
                <button
                  type="button"
                  onClick={() => setOperation("move")}
                  className={`p-3.5 rounded-xl border text-left transition-all relative ${
                    operation === "move"
                      ? "bg-amber-500/10 border-amber-500 text-bright shadow-sm ring-1 ring-amber-500"
                      : "bg-surface/30 border-border/70 hover:bg-surface/60 text-subtle hover:text-bright"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <Move size={16} className={operation === "move" ? "text-amber-400" : "text-subtle"} />
                    <span className="font-display text-sm tracking-wide text-bright">MOVE</span>
                  </div>
                  <p className="font-body text-[11px] text-subtle leading-tight">
                    Transfers to destination and deletes files from source once safely verified.
                  </p>
                </button>

                {/* Sync */}
                <button
                  type="button"
                  onClick={() => setOperation("sync")}
                  disabled={isDirectServiceDest}
                  className={`p-3.5 rounded-xl border text-left transition-all relative disabled:opacity-40 disabled:cursor-not-allowed ${
                    operation === "sync"
                      ? "bg-purple-500/10 border-purple-500 text-bright shadow-sm ring-1 ring-purple-500"
                      : "bg-surface/30 border-border/70 hover:bg-surface/60 text-subtle hover:text-bright"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <RefreshCw size={16} className={operation === "sync" ? "text-purple-400" : "text-subtle"} />
                    <span className="font-display text-sm tracking-wide text-bright">SYNC</span>
                  </div>
                  <p className="font-body text-[11px] text-subtle leading-tight">
                    Mirrors destination to match source. Deletes destination files not in source.
                  </p>
                </button>
              </div>
              {operation === "sync" && (
                <p className="flex items-center gap-1.5 text-xs text-purple-400 font-mono mt-2 bg-purple-500/10 p-2 rounded-lg border border-purple-500/20">
                  <ShieldAlert size={14} className="flex-shrink-0" />
                  <span>Sync mirrors directory contents. Extraneous destination files will be deleted.</span>
                </p>
              )}
            </div>
          )}

          {/* Destination Remote & Path */}
          <div className="space-y-3">
            <label className="block text-xs font-mono uppercase tracking-wider text-subtle">
              Destination Target
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
              {/* Remote select */}
              <div className="sm:col-span-5 bg-surface/50 border border-border/80 rounded-xl px-3 py-2">
                <span className="block text-[10px] font-mono text-subtle uppercase">Target Service / Remote</span>
                <select
                  value={destRemote}
                  onChange={(e) => {
                    const nextRemote = e.target.value;
                    setDestRemote(nextRemote);
                    if (isNoPathOffloadRemote(nextRemote)) {
                      setDestFolder("");
                      if (operation === "sync") setOperation("copy");
                    } else {
                      setDestFolder((prev) => prev.replace(/^[a-zA-Z0-9_-]+:\/*/, ""));
                    }
                  }}
                  className="w-full bg-transparent text-bright font-mono text-xs focus:outline-none cursor-pointer mt-1"
                >
                  <optgroup label="Rclone & Cloud Remotes">
                    {destinationRemotes.map((r) => (
                      <option key={r} value={r} className="bg-panel text-bright">
                        {r} {r === sourceRemote && sourceType === "remote" ? "(same remote)" : ""}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Direct Cloud Offload Services">
                    {!destinationRemotes.some((r) => r.toLowerCase() === "telegram") && (
                      <option value="telegram" className="bg-panel text-bright">
                        ✈️ telegram (Direct MTProto / Channel Offload)
                      </option>
                    )}
                    {!destinationRemotes.some((r) => r.toLowerCase() === "streamtape") && (
                      <option value="streamtape" className="bg-panel text-bright">
                        📼 streamtape (Direct Cloud Edge Offload)
                      </option>
                    )}
                  </optgroup>
                  {localLibraryPaths.length > 0 && (
                    <optgroup label="Local Library Pathways">
                      {localLibraryPaths.map((loc) => (
                        <option key={loc.path} value={loc.path} className="bg-panel text-bright">
                          📁 Local: {loc.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              {/* Destination folder / target input */}
              {isNoPathOffloadRemote(destRemote) ? (
                <div className="sm:col-span-7 bg-surface/50 border border-border/80 rounded-xl px-3 py-2 opacity-75">
                  <span className="block text-[10px] font-mono text-subtle uppercase">
                    Destination Path ({destRemote} Root Upload)
                  </span>
                  <input
                    type="text"
                    value=""
                    disabled={true}
                    placeholder="Empty (offload remotes upload directly to root / default channel)"
                    className="w-full bg-transparent text-subtle font-mono text-xs focus:outline-none cursor-not-allowed mt-1"
                  />
                </div>
              ) : (
                <div className="sm:col-span-7 bg-surface/50 border border-border/80 rounded-xl px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="block text-[10px] font-mono text-subtle uppercase">Destination Directory / Path</span>
                    <button
                      type="button"
                      onClick={() => setShowDestBrowser(true)}
                      className="text-[10px] font-mono text-primary hover:text-bright flex items-center gap-1 transition-colors px-1.5 py-0.5 rounded bg-primary/10 hover:bg-primary/20"
                    >
                      <Folder size={11} />
                      <span>Browse...</span>
                    </button>
                  </div>
                  <input
                    type="text"
                    value={destFolder}
                    onChange={(e) => setDestFolder(e.target.value)}
                    placeholder="e.g. Backups/Movies or leave blank for root"
                    className="w-full bg-transparent text-bright font-mono text-xs focus:outline-none placeholder-subtle/50 mt-1"
                  />
                </div>
              )}
            </div>

            {/* Quick paths / helper notes */}
            {destRemote === "telegram" ? (
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
                  Files up to <strong>2,000 MB (2 GB)</strong> are transferred as native Telegram media without touching local bandwidth.
                  {telegramConfig?.chatId && !destFolder && (
                    <button
                      type="button"
                      onClick={() => setDestFolder(telegramConfig.chatId)}
                      className="ml-1 text-accent hover:underline font-mono text-[11px]"
                    >
                      Use default chat ({telegramConfig.chatId})
                    </button>
                  )}
                </p>
              </div>
            ) : destRemote === "streamtape" ? (
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
                  Uploads directly to Streamtape CDN servers via headless Kaggle worker. Watch link will be logged in Transfer history.
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-2 pt-1 overflow-x-auto text-[11px] font-mono">
                <span className="text-subtle text-[10px] uppercase">Quick Paths:</span>
                <button
                  type="button"
                  onClick={() => setDestFolder("")}
                  className="px-2 py-0.5 rounded bg-surface/60 hover:bg-surface border border-border/50 text-subtle hover:text-bright"
                >
                  / (Root)
                </button>
                {defaultSubfolder && (
                  <button
                    type="button"
                    onClick={() => setDestFolder(defaultSubfolder)}
                    className="px-2 py-0.5 rounded bg-surface/60 hover:bg-surface border border-border/50 text-subtle hover:text-bright"
                  >
                    {defaultSubfolder}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDestFolder("Transfers")}
                  className="px-2 py-0.5 rounded bg-surface/60 hover:bg-surface border border-border/50 text-subtle hover:text-bright"
                >
                  Transfers
                </button>
                <button
                  type="button"
                  onClick={() => setDestFolder("Backups")}
                  className="px-2 py-0.5 rounded bg-surface/60 hover:bg-surface border border-border/50 text-subtle hover:text-bright"
                >
                  Backups
                </button>
              </div>
            )}

            {/* Live Destination Preview */}
            <div className="p-2.5 rounded-lg bg-panel border border-border/60 flex items-center gap-2 font-mono text-xs">
              <span className="text-subtle text-[11px] uppercase">Target URI:</span>
              <span className="text-accent truncate font-semibold">{cleanDestPath}</span>
            </div>
          </div>

          {/* Worker Execution Provider Selection */}
          <div className="space-y-2">
            <label className="block text-xs font-mono uppercase tracking-wider text-subtle">
              Worker Execution Provider
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 font-mono text-xs">
              {/* Direct Local Rclone */}
              <button
                type="button"
                onClick={() => setWorkerProvider("local")}
                className={`p-3 rounded-xl border text-left transition-all ${
                  workerProvider === "local"
                    ? "bg-emerald-500/15 border-emerald-500 text-bright shadow-sm ring-1 ring-emerald-500"
                    : "bg-surface/30 border-border/70 hover:bg-surface/60 text-subtle hover:text-bright"
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1 font-semibold text-bright">
                  <HardDrive size={14} className="text-emerald-400" />
                  <span>Direct Local</span>
                </div>
                <p className="text-[10px] text-subtle font-body leading-tight">
                  Transfers directly on this host machine using local Rclone. Zero cloud quota.
                </p>
              </button>

              {/* Auto Rotate */}
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
                  Kaggle CPU ({activeKaggleJobs}/2 active) with automatic overflow to GitHub Actions.
                </p>
              </button>

              {/* GitHub Actions Runner */}
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
                    ? `${ghaConfig?.owner}/${ghaConfig?.repo} CI runner.`
                    : "Configure GHA in Settings."}
                </p>
              </button>

              {/* Kaggle CPU */}
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
                  <span>Kaggle CPU</span>
                </div>
                <p className="text-[10px] text-subtle font-body leading-tight">
                  {isKaggleConfigured
                    ? `@${kaggleUsername} (${activeKaggleJobs}/2 active, zero GPU quota).`
                    : "Missing credentials in Settings."}
                </p>
              </button>
            </div>
          </div>

          {/* Advanced Settings Collapsible */}
          <div className="pt-2 border-t border-border/40">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center justify-between w-full text-xs font-mono text-subtle hover:text-bright py-1"
            >
              <div className="flex items-center gap-2">
                <Sliders size={13} className="text-accent" />
                <span className="uppercase tracking-wider">Advanced Performance & Flags</span>
              </div>
              {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {showAdvanced && (
              <div className="mt-3 p-4 rounded-xl bg-surface/30 border border-border/60 space-y-4 font-mono text-xs">
                {/* Parallel Transfers & Checkers */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[11px] text-subtle mb-1">
                      Parallel File Streams (--transfers): <span className="text-bright font-bold">{transfers}</span>
                    </label>
                    <input
                      type="range"
                      min={1}
                      max={16}
                      step={1}
                      value={transfers}
                      onChange={(e) => setTransfers(parseInt(e.target.value, 10))}
                      className="w-full accent-accent cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-subtle mt-0.5">
                      <span>1</span>
                      <span>4 (default)</span>
                      <span>8</span>
                      <span>16</span>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] text-subtle mb-1">
                      Directory Checkers (--checkers): <span className="text-bright font-bold">{checkers}</span>
                    </label>
                    <input
                      type="range"
                      min={2}
                      max={32}
                      step={2}
                      value={checkers}
                      onChange={(e) => setCheckers(parseInt(e.target.value, 10))}
                      className="w-full accent-accent cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-subtle mt-0.5">
                      <span>2</span>
                      <span>8 (default)</span>
                      <span>16</span>
                      <span>32</span>
                    </div>
                  </div>
                </div>

                {/* Toggles */}
                <div className="pt-2 border-t border-border/30 space-y-2.5">
                  {/* Google Drive Server-Side Copy */}
                  <label className="flex items-center justify-between cursor-pointer p-2 rounded-lg hover:bg-panel/60 transition-colors">
                    <div className="pr-3">
                      <span className="block text-bright font-medium">Google Drive Server-Side Copy</span>
                      <span className="block text-[11px] text-subtle">
                        Instant zero-bandwidth copy when transferring within Google Drive
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      checked={driveServerSide}
                      onChange={(e) => setDriveServerSide(e.target.checked)}
                      className="w-4 h-4 rounded accent-accent cursor-pointer"
                    />
                  </label>

                  {/* Dry Run */}
                  <label className="flex items-center justify-between cursor-pointer p-2 rounded-lg hover:bg-panel/60 transition-colors">
                    <div className="pr-3">
                      <span className="block text-amber-400 font-medium">Dry Run Simulation (--dry-run)</span>
                      <span className="block text-[11px] text-subtle">
                        Test and verify transfer logs on Kaggle without copying or deleting files
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      checked={dryRun}
                      onChange={(e) => setDryRun(e.target.checked)}
                      className="w-4 h-4 rounded accent-amber-400 cursor-pointer"
                    />
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Error Banner */}
          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-danger/10 border border-danger/30 text-danger text-xs flex items-start gap-2.5">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold font-body">Dispatch failed</p>
                <p className="font-mono text-[11px]">{errorMsg}</p>
              </div>
            </div>
          )}

          {/* Provider Account Status Banner */}
          {workerProvider === "local" ? (
            <div className="p-3 rounded-xl bg-surface/50 border border-emerald-500/30 flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-2 text-subtle">
                <CheckCircle2 size={14} className="text-emerald-400" />
                <span>Execution Mode: <strong className="text-bright">Direct Local Machine (Rclone)</strong></span>
              </div>
              <span className="text-[11px] text-emerald-400 font-semibold">Local Host</span>
            </div>
          ) : workerProvider === "github_actions" ? (
            isGhaConfigured ? (
              <div className="p-3 rounded-xl bg-surface/50 border border-border/50 flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-2 text-subtle">
                  <CheckCircle2 size={14} className="text-purple-400" />
                  <span>Workflow Runner: <strong className="text-bright">{ghaConfig?.owner}/{ghaConfig?.repo}</strong></span>
                </div>
                <span className="text-[11px] text-purple-400 font-semibold">GitHub Actions</span>
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs flex items-center gap-2">
                <AlertCircle size={15} className="flex-shrink-0" />
                <span>GitHub Actions runner not configured. Please set token, owner, and repo in Settings.</span>
              </div>
            )
          ) : workerProvider === "kaggle" ? (
            isKaggleConfigured ? (
              <div className="p-3 rounded-xl bg-surface/50 border border-border/50 flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-2 text-subtle">
                  <CheckCircle2 size={14} className="text-teal" />
                  <span>Connected as <strong className="text-bright">@{kaggleUsername}</strong></span>
                </div>
                <span className="text-[11px] text-teal font-semibold">Kaggle Worker ({activeKaggleJobs}/2)</span>
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs flex items-center gap-2">
                <AlertCircle size={15} className="flex-shrink-0" />
                <span>Kaggle credentials not configured. Please set them up in Settings.</span>
              </div>
            )
          ) : (
            <div className="p-3 rounded-xl bg-surface/50 border border-border/50 flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-2 text-subtle">
                <CheckCircle2 size={14} className="text-accent" />
                <span>
                  {isKaggleConfigured ? `@${kaggleUsername} (${activeKaggleJobs}/2)` : "Kaggle unconfigured"}
                  {" → "}
                  {isGhaConfigured ? `${ghaConfig?.owner}/${ghaConfig?.repo}` : "GHA unconfigured"}
                </span>
              </div>
              <span className="text-[11px] text-accent font-semibold">Auto Rotation</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border/60 bg-surface/40 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 rounded-xl bg-surface hover:bg-surface/80 text-subtle hover:text-bright border border-border text-xs font-body transition-all"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={
              isSubmitting ||
              (workerProvider === "kaggle" && !isKaggleConfigured) ||
              (workerProvider === "github_actions" && !isGhaConfigured) ||
              (workerProvider === "auto" && !isKaggleConfigured && !isGhaConfigured)
            }
            className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-accent to-accent-hover text-void font-body text-xs font-bold shadow-lg hover:shadow-accent/20 flex items-center gap-2 transition-all disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>
                  {workerProvider === "local"
                    ? `Executing Local ${operation.toUpperCase()}...`
                    : workerProvider === "github_actions"
                    ? "Dispatching to GitHub Actions..."
                    : workerProvider === "kaggle"
                    ? "Dispatching to Kaggle..."
                    : "Dispatching Cloud Task..."}
                </span>
              </>
            ) : (
              <>
                <Zap size={14} />
                <span>
                  {dryRun
                    ? "Run Dry Run Simulation"
                    : workerProvider === "local"
                    ? `Execute Local ${operation.toUpperCase()}`
                    : isDirectServiceDest || isUrlMode
                    ? "Dispatch Direct Cloud Offload"
                    : `Execute Cloud ${operation.toUpperCase()}`}
                </span>
              </>
            )}
          </button>
        </div>
      </motion.div>

      {showDestBrowser && (
        <RemoteBrowser
          remoteName={destRemote}
          remoteType="drive"
          rcloneConfigPath={rcloneConfigPath || ""}
          initialPath={cleanDestPath}
          availableRemotes={remotes
            .filter((r) => !r.name.startsWith("shared_"))
            .map((r) => ({ name: r.name, type: r.type || "drive" }))}
          onSelect={(selectedPath) => {
            const [rName, ...rest] = selectedPath.split(":");
            const sub = rest.join(":").replace(/^\/+|\/+$/g, "");
            if (rName) {
              setDestRemote(rName);
              setDestFolder(isNoPathOffloadRemote(rName) ? "" : sub);
            } else {
              setDestFolder(isNoPathOffloadRemote(destRemote) ? "" : sub);
            }
            setShowDestBrowser(false);
          }}
          onClose={() => setShowDestBrowser(false)}
        />
      )}
    </div>
  );
}
