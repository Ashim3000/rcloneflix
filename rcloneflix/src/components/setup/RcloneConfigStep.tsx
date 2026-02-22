import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, FolderOpen, CheckCircle2, AlertCircle, Loader2, ChevronRight } from "lucide-react";
import { pickRcloneConfig, parseRcloneConfig } from "../../lib/tauri";
import { useAppStore } from "../../store/appStore";
import type { RcloneRemote } from "../../lib/tauri";

type Props = {
  onNext: () => void;
  onBack: () => void;
};

type State = "idle" | "loading" | "success" | "error";

export function RcloneConfigStep({ onNext, onBack }: Props) {
  const [state, setState] = useState<State>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [remotes, setRemotes] = useState<RcloneRemote[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);

  const { setRcloneConfigPath, setRemotes: storeSetRemotes, rcloneConfigPath } = useAppStore();

  const processConfigFile = useCallback(async (path: string) => {
    setState("loading");
    setErrorMsg("");
    try {
      const found = await parseRcloneConfig(path);
      setRemotes(found);
      storeSetRemotes(found.map((r) => ({ name: r.name, type: r.remote_type })));
      setRcloneConfigPath(path);
      setState("success");
    } catch (e) {
      setState("error");
      setErrorMsg(
        e instanceof Error
          ? e.message
          : "Could not parse config file. Make sure it's a valid rclone config."
      );
    }
  }, [setRcloneConfigPath, storeSetRemotes]);

  const handlePickFile = async () => {
    const path = await pickRcloneConfig();
    if (path) {
      await processConfigFile(path);
    }
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) {
        // In Tauri, we can get the path from the drag event
        const path = (file as unknown as { path?: string }).path ?? file.name;
        await processConfigFile(path);
      }
    },
    [processConfigFile]
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -24 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="max-w-xl mx-auto w-full"
    >
      <div className="mb-8">
        <h2 className="font-display text-4xl text-bright tracking-wide mb-2">
          IMPORT YOUR CONFIG
        </h2>
        <p className="text-subtle font-body text-sm leading-relaxed">
          Upload your <code className="text-accent font-mono text-xs bg-panel px-1.5 py-0.5 rounded">rclone.conf</code> file.
          This is stored locally and never uploaded anywhere.
          {" "}
          <a
            href="https://rclone.org/docs/#config-config-file"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:text-accent-glow underline underline-offset-2"
          >
            Where is my config file?
          </a>
        </p>
      </div>

      {/* Drop zone */}
      <motion.div
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
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
        className="border-2 border-dashed rounded-xl p-10 flex flex-col items-center gap-4 transition-colors mb-6 cursor-pointer"
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
              className="flex flex-col items-center gap-3"
            >
              <CheckCircle2 size={40} className="text-teal" />
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
            <div className="space-y-2">
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

      {/* Navigation */}
      <div className="flex gap-3 justify-between">
        <button onClick={onBack} className="btn-ghost">
          Back
        </button>
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
    </motion.div>
  );
}
