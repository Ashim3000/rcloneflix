import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { CloudDownload, ArrowRight, CheckCircle2, Loader2, AlertCircle, FolderOpen } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { RemoteBrowser } from "../common/RemoteBrowser";
import { restoreFromRemote, type RestoreSummary } from "../../lib/rcloneSync";

type Props = {
  onNext: () => void;
  onBack: () => void;
};

/**
 * Optional "pick up where another machine left off" step.
 *
 * Runs after the rclone config is loaded, because the whole point is that the
 * user's existing remotes are the transport — there's no account to create and
 * nothing to authorise.
 */
export function RestoreStep({ onNext, onBack }: Props) {
  const { remotes, rcloneConfigPath } = useAppStore();
  const [selectedRemoteName, setSelectedRemoteName] = useState<string>(
    () => remotes[0]?.name ?? ""
  );
  const [browsing, setBrowsing] = useState(false);
  const [state, setState] = useState<"idle" | "restoring" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<RestoreSummary | null>(null);

  useEffect(() => {
    if (remotes.length > 0 && (!selectedRemoteName || !remotes.some((r) => r.name === selectedRemoteName))) {
      setSelectedRemoteName(remotes[0].name);
    }
  }, [remotes, selectedRemoteName]);

  const activeRemote = remotes.find((r) => r.name === selectedRemoteName) ?? remotes[0];

  const handlePick = async (path: string) => {
    setBrowsing(false);
    if (!/\.json(\.gz)?$/i.test(path)) {
      setError("Pick a backup file (.json.gz) rather than a folder.");
      setState("error");
      return;
    }
    setState("restoring");
    setError("");
    try {
      setSummary(await restoreFromRemote(path, { replaceLibraries: true }));
      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  };

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
          RESTORE A BACKUP
        </h2>
        <p className="text-subtle font-body text-sm leading-relaxed">
          Already using RcloneFlix elsewhere? Point it at the backup on one of your remotes
          and this machine picks up the same libraries, metadata and watch progress. Skip
          this if you're starting fresh.
        </p>
      </div>

      {state === "done" && summary ? (
        <div className="bg-panel border border-teal/40 rounded-xl p-5 mb-6">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 size={18} className="text-teal" />
            <p className="text-bright font-body font-semibold text-sm">Restored</p>
          </div>
          <p className="text-subtle font-body text-xs leading-relaxed">
            From <span className="font-mono text-text">{summary.deviceName}</span>, backed up{" "}
            {summary.exportedAt ? new Date(summary.exportedAt).toLocaleString() : "recently"}.
            <br />
            {summary.librariesRestored} libraries · {summary.itemsAdded} media items ·{" "}
            {summary.progressUpdated} watch positions.
          </p>
        </div>
      ) : (
        <div className="bg-panel border border-border rounded-xl p-6 mb-6 flex flex-col items-center gap-4">
          {state === "restoring" ? (
            <>
              <Loader2 size={32} className="text-accent animate-spin" />
              <p className="text-subtle font-body text-sm">Restoring…</p>
            </>
          ) : (
            <>
              <div className="w-14 h-14 rounded-2xl bg-surface border border-border flex items-center justify-center">
                <CloudDownload size={26} className="text-accent" />
              </div>

              {remotes.length > 1 && (
                <div className="w-full max-w-sm flex flex-col items-center gap-1.5 text-center">
                  <label className="text-xs font-heading font-medium text-subtle">
                    Remote containing backup:
                  </label>
                  <select
                    value={activeRemote?.name ?? ""}
                    onChange={(e) => setSelectedRemoteName(e.target.value)}
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-text text-sm font-body outline-none focus:border-accent transition-colors cursor-pointer text-center"
                  >
                    {remotes.map((r) => (
                      <option key={r.name} value={r.name}>
                        ☁️ {r.name} ({r.type})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {remotes.length === 1 && (
                <p className="text-subtle font-body text-xs">
                  Remote: <span className="text-text font-mono">☁️ {remotes[0].name}</span> ({remotes[0].type})
                </p>
              )}

              <button
                onClick={() => setBrowsing(true)}
                disabled={!activeRemote}
                className="btn-primary text-sm py-2.5 px-5 disabled:opacity-40 flex items-center gap-2"
              >
                <FolderOpen size={16} />
                <span>
                  {activeRemote ? `Browse "${activeRemote.name}" for a backup` : "Browse remotes for a backup"}
                </span>
              </button>

              {remotes.length === 0 && (
                <p className="text-subtle font-body text-xs">
                  Load an rclone config first.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {state === "error" && (
        <div className="flex items-start gap-2 text-xs text-danger font-body bg-danger/10 border border-danger/20 rounded-lg p-3 mb-6">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div className="flex gap-3 justify-between">
        <button onClick={onBack} className="btn-ghost">
          Back
        </button>
        <button onClick={onNext} className="btn-primary flex items-center gap-2">
          {state === "done" ? "Continue" : "Skip — set up fresh"}
          <ArrowRight size={16} />
        </button>
      </div>

      {browsing && activeRemote && (
        <RemoteBrowser
          remoteName={activeRemote.name}
          remoteType={activeRemote.type}
          rcloneConfigPath={rcloneConfigPath}
          fileMode
          fileFilter={/\.json(\.gz)?$/i}
          availableRemotes={remotes}
          onRemoteChange={(newRemote) => setSelectedRemoteName(newRemote)}
          selectLabel="Select Backup File"
          onSelect={handlePick}
          onClose={() => setBrowsing(false)}
        />
      )}
    </motion.div>
  );
}
