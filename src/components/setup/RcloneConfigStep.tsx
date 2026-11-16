import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, FolderOpen, CheckCircle2, AlertCircle, Loader2, ChevronRight, KeyRound, FolderDown, Tv, FileText } from "lucide-react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { pickRcloneConfig, parseRcloneConfig, readLocalFileBytes } from "../../lib/tauri";
import { importAccessPass } from "../../lib/accessPass";
import { useAppStore } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { ImportAccessPassModal } from "../accessPass/ImportAccessPassModal";
import { TvPairingCard } from "./TvPairingCard";
import type { RcloneRemote } from "../../lib/tauri";

type Props = {
  onNext: () => void;
  onBack: () => void;
};

type State = "idle" | "loading" | "success" | "error";

export function RcloneConfigStep({ onNext, onBack }: Props) {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const [state, setState] = useState<State>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [remotes, setRemotes] = useState<RcloneRemote[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isPassModalOpen, setIsPassModalOpen] = useState(false);

  const isAndroidOrTv = typeof navigator !== "undefined" && (/android/i.test(navigator.userAgent) || !!(window as any).AndroidBridge);
  const [activeTab, setActiveTab] = useState<"desktop" | "tv">(isAndroidOrTv ? "tv" : "desktop");

  const {
    setRcloneConfigPath,
    setRemotes: storeSetRemotes,
    setRcloneConfigContent,
    rcloneConfigPath,
    completeSetup,
  } = useAppStore();

  const processConfigFile = useCallback(async (path: string) => {
    setState("loading");
    setErrorMsg("");
    try {
      const found = await parseRcloneConfig(path);
      setRemotes(found);
      storeSetRemotes(found.map((r) => ({ name: r.name, type: r.remote_type })));
      setRcloneConfigPath(path);

      // Capture the file itself so a Drive restore can rebuild it on another
      // machine — without this the backup ships an empty config.
      try {
        setRcloneConfigContent(await readTextFile(path));
      } catch {
        // Non-fatal: local playback only needs the path.
      }

      setState("success");
    } catch (e) {
      setState("error");
      setErrorMsg(
        e instanceof Error
          ? e.message
          : "Could not parse config file. Make sure it's a valid rclone config."
      );
    }
  }, [setRcloneConfigPath, storeSetRemotes, setRcloneConfigContent]);

  const handlePickFile = async () => {
    const path = await pickRcloneConfig();
    if (path) {
      if (path.toLowerCase().endsWith(".rflix")) {
        await handleRflixPath(path);
      } else {
        await processConfigFile(path);
      }
    }
  };

  const handleRflixPath = useCallback(async (path: string) => {
    setState("loading");
    setErrorMsg("");
    try {
      const bytes = await readLocalFileBytes(path);
      const res = await importAccessPass(bytes);
      addToast(
        res.passType === "admin"
          ? `Admin TV Pass activated! Restored ${res.libraryCount} libraries and all credentials.`
          : `Imported ${res.libraryCount} shared libraries (${res.itemCount} items).`,
        "success"
      );
      completeSetup();
      navigate("/home");
    } catch (e) {
      setState("error");
      setErrorMsg(e instanceof Error ? e.message : "Failed to import .rflix access pass.");
    }
  }, [addToast, completeSetup, navigate]);

  // Tauri v2's webview does not expose File.path, so HTML drag-and-drop cannot
  // yield a real filesystem path. Real drops arrive via the window's
  // onDragDropEvent instead; the DOM handler only tells the user to click.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over") {
            setIsDragOver(true);
          } else if (event.payload.type === "drop") {
            setIsDragOver(false);
            const path = event.payload.paths?.[0];
            if (path) {
              if (path.toLowerCase().endsWith(".rflix")) {
                void handleRflixPath(path);
              } else {
                void processConfigFile(path);
              }
            }
          } else {
            setIsDragOver(false);
          }
        })
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // Ignore in non-desktop webviews
    }
    return () => unlisten?.();
  }, [processConfigFile, handleRflixPath]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -24 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="max-w-xl mx-auto w-full"
    >
      <div className="mb-6">
        <h2 className="font-display text-4xl text-bright tracking-wide mb-2">
          IMPORT YOUR CONFIG
        </h2>
        <p className="text-subtle font-body text-sm leading-relaxed">
          Connect your remotes via QR Code phone pairing, or upload your <code className="text-accent font-mono text-xs bg-panel px-1.5 py-0.5 rounded">rclone.conf</code> or <code className="text-accent font-mono text-xs bg-panel px-1.5 py-0.5 rounded">.rflix</code> pass.
        </p>
      </div>

      {/* Mode Selector Tabs */}
      <div className="flex items-center gap-2 mb-6 p-1 bg-surface/80 border border-border/80 rounded-xl">
        <button
          type="button"
          onClick={() => setActiveTab("tv")}
          className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
            activeTab === "tv"
              ? "bg-accent text-white shadow-lg shadow-accent/20"
              : "text-subtle hover:text-bright hover:bg-white/5"
          }`}
        >
          <Tv size={15} />
          TV Phone Pairing (QR Code)
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("desktop")}
          className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
            activeTab === "desktop"
              ? "bg-accent text-white shadow-lg shadow-accent/20"
              : "text-subtle hover:text-bright hover:bg-white/5"
          }`}
        >
          <FileText size={15} />
          Direct File Upload (.conf / .rflix)
        </button>
      </div>

      {activeTab === "tv" ? (
        <div className="mb-6">
          <TvPairingCard
            onPaired={() => {
              completeSetup();
              navigate("/home");
            }}
            onManualPasteClick={() => setIsPassModalOpen(true)}
          />
        </div>
      ) : (
        <>
          {/* Drop zone */}
          <motion.div
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setIsDragOver(false); }}
            animate={{
              borderColor: isDragOver
                ? "#E8A020"
                : state === "success"
                ? "#1EC8A0"
                : state === "error"
                ? "#E84040"
                : "#1E2535",
              backgroundColor: isDragOver ? "rgba(232,160,32,0.04)" : "transparent",
            }}
            className={`border-2 border-dashed rounded-xl ${state === "success" ? "p-5" : "p-10"} flex flex-col items-center gap-4 transition-all mb-6 cursor-pointer`}
            onClick={state !== "loading" ? handlePickFile : undefined}
          >
        <AnimatePresence mode="wait">
          {state === "idle" || state === "error" ? (
            <motion.div
              key="idle"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="flex flex-col items-center gap-3"
            >
              <div className="w-16 h-16 rounded-2xl bg-panel border border-border flex items-center justify-center">
                <Upload size={28} className="text-subtle" />
              </div>
              <div className="text-center">
                <p className="text-text font-body font-medium">
                  Drop your rclone config here
                </p>
                <p className="text-subtle font-body text-sm">
                  or click to browse
                </p>
              </div>
              {state === "error" && (
                <div className="flex items-center gap-2 text-danger text-sm font-body">
                  <AlertCircle size={16} />
                  <span>{errorMsg}</span>
                </div>
              )}
            </motion.div>
          ) : state === "loading" ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3"
            >
              <Loader2 size={36} className="text-accent animate-spin" />
              <p className="text-subtle font-body text-sm">Parsing config...</p>
            </motion.div>
          ) : (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center gap-2"
            >
              <CheckCircle2 size={36} className="text-teal" />
              <div className="text-center">
                <p className="text-bright font-body font-semibold">
                  Config loaded successfully
                </p>
                <p className="text-subtle font-body text-xs font-mono mt-0.5 truncate max-w-xs">
                  {rcloneConfigPath}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Remotes list */}
      <AnimatePresence>
        {remotes.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-6 overflow-hidden"
          >
            <p className="text-subtle font-body text-xs uppercase tracking-widest mb-3">
              Found {remotes.length} remote{remotes.length !== 1 ? "s" : ""}
            </p>
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {remotes.map((remote, i) => (
                <motion.div
                  key={remote.name}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="flex items-center gap-3 bg-panel border border-border rounded-lg px-4 py-3"
                >
                  <FolderOpen size={16} className="text-accent flex-shrink-0" />
                  <span className="text-text font-body text-sm font-medium flex-1">
                    {remote.name}
                  </span>
                  <span className="text-subtle font-mono text-xs bg-muted px-2 py-0.5 rounded">
                    {remote.remote_type}
                  </span>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Or Guest Pass */}
      <div className="flex items-center gap-4 my-6">
        <div className="flex-1 h-px bg-border/60" />
        <span className="text-subtle font-mono text-xs uppercase tracking-widest">
          OR .RFLIX PASS
        </span>
        <div className="flex-1 h-px bg-border/60" />
      </div>

      <div className="p-4 rounded-xl bg-panel border border-border flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-accent/10 border border-accent/20 text-accent flex-shrink-0">
            <KeyRound size={20} />
          </div>
          <div>
            <p className="text-text font-body text-sm font-medium">
              Have an Admin TV Pass or Shared .rflix Pass?
            </p>
            <p className="text-subtle font-body text-xs mt-0.5">
              1-Click instant configuration. Paste code or upload your .rflix pass.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setIsPassModalOpen(true)}
          className="btn-ghost text-xs px-3.5 py-2 flex items-center gap-2 border border-border hover:border-accent text-bright flex-shrink-0"
        >
          <FolderDown size={14} className="text-accent" />
          Import Pass
        </button>
      </div>
      </>
      )}

      {/* Navigation */}
      <div className="flex gap-3 justify-between items-center pt-4 mt-2 sticky bottom-0 bg-void/95 backdrop-blur-sm z-10 border-t border-border/40">
        <button onClick={onBack} className="btn-ghost">
          Back
        </button>
        <div className="flex items-center gap-2">
          {state !== "success" && (
            <button
              type="button"
              onClick={onNext}
              className="px-3 py-2 rounded-lg text-xs font-semibold text-subtle hover:text-white hover:bg-white/5 transition-colors border border-white/10"
              title="Proceed without an rclone config and configure local folders instead"
            >
              Skip (Local Storage Only)
            </button>
          )}
          <motion.button
            onClick={onNext}
            disabled={state !== "success"}
            className="btn-primary flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:active:scale-100"
            whileHover={state === "success" ? { scale: 1.02 } : {}}
            whileTap={state === "success" ? { scale: 0.98 } : {}}
          >
            Continue
            <ChevronRight size={18} />
          </motion.button>
        </div>
      </div>

      <ImportAccessPassModal
        isOpen={isPassModalOpen}
        onClose={() => setIsPassModalOpen(false)}
        onImportComplete={() => {
          completeSetup();
          navigate("/home");
        }}
      />
    </motion.div>
  );
}
