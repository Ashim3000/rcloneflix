import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  ArrowRightLeft,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Terminal,
  ExternalLink,
  Trash2,
  RefreshCw,
  Copy,
  Move,
  ChevronDown,
  ChevronUp,
  HardDrive,
  Zap,
} from "lucide-react";
import {
  useCloudTransferStore,
  getKaggleTransferOutput,
  type CloudTransferJob,
} from "../../lib/kaggleTransfer";
import { useToastStore } from "../../store/toastStore";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export function CloudTransferDrawer({ isOpen, onClose }: Props) {
  const { jobs, removeJob, clearCompletedJobs } = useCloudTransferStore();
  const addToast = useToastStore((s) => s.addToast);

  const [selectedJobForLogs, setSelectedJobForLogs] = useState<CloudTransferJob | null>(null);
  const [logsText, setLogsText] = useState<string>("");
  const [loadingLogs, setLoadingLogs] = useState<boolean>(false);
  const [autoRefreshLogs, setAutoRefreshLogs] = useState<boolean>(true);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  const jobList = Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt);

  const activeCount = jobList.filter(
    (j) => j.status === "queued" || j.status === "running"
  ).length;

  // Fetch logs for the selected job
  const fetchLogs = useCallback(
    async (job: CloudTransferJob) => {
      setLoadingLogs(true);
      try {
        if (job.provider === "github_actions") {
          setLogsText(
            `=== GitHub Actions Cloud Worker Runner ===\nJob ID: ${job.id}\nOperation: ${job.operation.toUpperCase()}\nStatus: ${job.status.toUpperCase()}\nCreated: ${new Date(job.createdAt).toLocaleString()}\n\nLive step-by-step logs, runner output, and status are streaming directly on GitHub Actions:\n${job.kernelUrl}\n\nTip: Click the "GitHub Actions" link button below to open your runner dashboard.`
          );
          return;
        }
        const out = await getKaggleTransferOutput(job.kernelSlug);
        setLogsText(out || "No stdout output recorded yet. Execution may still be queuing or preparing environment.");
      } catch (err: any) {
        setLogsText(`Error fetching Kaggle logs: ${err?.message || String(err)}`);
      } finally {
        setLoadingLogs(false);
      }
    },
    []
  );

  // When selectedJobForLogs changes, fetch logs
  useEffect(() => {
    if (selectedJobForLogs) {
      fetchLogs(selectedJobForLogs);
    } else {
      setLogsText("");
    }
  }, [selectedJobForLogs, fetchLogs]);

  // Auto-refresh logs while terminal modal is open and job is active
  useEffect(() => {
    if (!selectedJobForLogs || !autoRefreshLogs) return;
    if (selectedJobForLogs.status !== "running" && selectedJobForLogs.status !== "queued") return;
    if (selectedJobForLogs.provider === "github_actions") return;

    const interval = setInterval(() => {
      fetchLogs(selectedJobForLogs);
    }, 6000);

    return () => clearInterval(interval);
  }, [selectedJobForLogs, autoRefreshLogs, fetchLogs]);

  // Scroll to bottom of terminal when logsText changes
  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logsText]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-void/70 backdrop-blur-sm">
      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="w-full max-w-xl h-full bg-panel border-l border-border/80 shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/60 bg-surface/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
              <ArrowRightLeft size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-base text-bright tracking-wide">
                  CLOUD TRANSFERS
                </h2>
                {activeCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-accent/20 text-accent font-mono text-[10px] font-bold animate-pulse">
                    {activeCount} active
                  </span>
                )}
              </div>
              <p className="text-subtle font-body text-xs">
                Kaggle datacenter offloaded transfers
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {jobList.some((j) => j.status === "complete" || j.status === "error") && (
              <button
                type="button"
                onClick={clearCompletedJobs}
                className="px-2.5 py-1.5 rounded-lg bg-surface hover:bg-surface/80 text-subtle hover:text-bright border border-border text-[11px] font-mono transition-all"
                title="Clear completed and failed jobs"
              >
                Clear Finished
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-subtle hover:text-bright hover:bg-surface border border-transparent hover:border-border transition-all"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Jobs List */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {jobList.length === 0 ? (
            <div className="h-64 flex flex-col items-center justify-center gap-2 text-subtle text-center">
              <ArrowRightLeft size={36} className="text-subtle/30" />
              <p className="font-body text-sm font-medium text-bright">No cloud transfers yet</p>
              <p className="font-body text-xs max-w-xs">
                Select items in Cloud Explorer and click "Cloud Transfer" to transfer files off-device.
              </p>
            </div>
          ) : (
            jobList.map((job) => {
              const isRunning = job.status === "running";
              const isQueued = job.status === "queued";
              const isComplete = job.status === "complete";
              const isError = job.status === "error";

              const opColor =
                job.operation === "copy"
                  ? "text-cyan-400 bg-cyan-500/10 border-cyan-500/30"
                  : job.operation === "move"
                  ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
                  : "text-purple-400 bg-purple-500/10 border-purple-500/30";

              return (
                <div
                  key={job.id}
                  className="p-4 rounded-xl bg-surface/40 border border-border/70 hover:border-border transition-all space-y-3"
                >
                  {/* Job Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase border ${opColor}`}
                        >
                          {job.operation}
                        </span>
                        {job.provider === "github_actions" ? (
                          <span className="px-1.5 py-0.5 rounded font-mono text-[9px] bg-purple-500/15 text-purple-400 border border-purple-500/30 font-semibold">
                            GHA
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded font-mono text-[9px] bg-teal/15 text-teal border border-teal/30 font-semibold">
                            Kaggle
                          </span>
                        )}
                        {job.dryRun && (
                          <span className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/30">
                            DRY RUN
                          </span>
                        )}
                        <h3 className="font-body text-sm font-semibold text-bright truncate">
                          {job.title}
                        </h3>
                      </div>
                      <p className="font-mono text-[11px] text-subtle">
                        {new Date(job.createdAt).toLocaleTimeString()} · {new Date(job.createdAt).toLocaleDateString()}
                      </p>
                    </div>

                    {/* Status Badge */}
                    <div className="flex-shrink-0">
                      {isQueued && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 font-mono text-[11px]">
                          <Clock size={12} className="animate-pulse" />
                          <span>Queued</span>
                        </div>
                      )}
                      {isRunning && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent/20 border border-accent/40 text-accent font-mono text-[11px]">
                          <Loader2 size={12} className="animate-spin" />
                          <span>Transferring</span>
                        </div>
                      )}
                      {isComplete && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-teal/15 border border-teal/30 text-teal font-mono text-[11px]">
                          <CheckCircle2 size={12} />
                          <span>Complete</span>
                        </div>
                      )}
                      {isError && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-danger/15 border border-danger/30 text-danger font-mono text-[11px]">
                          <AlertCircle size={12} />
                          <span>Failed</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Route Paths */}
                  <div className="p-2.5 rounded-lg bg-panel/70 border border-border/40 font-mono text-xs space-y-1">
                    <div className="flex items-center gap-2 truncate text-subtle">
                      <span className="text-[10px] uppercase text-subtle/70 w-10 flex-shrink-0">FROM:</span>
                      <span className="text-bright/90 truncate">{job.source}</span>
                    </div>
                    <div className="flex items-center gap-2 truncate text-subtle">
                      <span className="text-[10px] uppercase text-accent/70 w-10 flex-shrink-0">TO:</span>
                      <span className="text-accent truncate font-medium">{job.destination}</span>
                    </div>
                  </div>

                  {/* Failure Message */}
                  {job.failureMessage && (
                    <div className="p-2.5 rounded-lg bg-danger/10 border border-danger/20 text-danger font-mono text-xs">
                      {job.failureMessage}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex items-center justify-between pt-1 text-xs">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedJobForLogs(job)}
                        className="px-2.5 py-1 rounded-lg bg-surface hover:bg-surface/80 border border-border/60 text-subtle hover:text-bright flex items-center gap-1.5 font-mono text-[11px] transition-all"
                      >
                        <Terminal size={12} className="text-accent" />
                        <span>Live Terminal</span>
                      </button>

                      {job.kernelUrl && (
                        <a
                          href={job.kernelUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="px-2.5 py-1 rounded-lg bg-surface hover:bg-surface/80 border border-border/60 text-subtle hover:text-bright flex items-center gap-1.5 font-mono text-[11px] transition-all"
                        >
                          <ExternalLink size={12} />
                          <span>{job.provider === "github_actions" ? "GitHub Actions" : "Kaggle Notebook"}</span>
                        </a>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => removeJob(job.id)}
                      className="p-1 rounded-lg text-subtle/60 hover:text-danger hover:bg-danger/10 transition-colors"
                      title="Dismiss job"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Terminal Modal for Viewing Logs */}
        {selectedJobForLogs && (
          <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-void/85 backdrop-blur-md">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-3xl bg-[#0d1117] border border-border/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
            >
              {/* Terminal Titlebar */}
              <div className="px-5 py-3.5 bg-[#161b22] border-b border-border/60 flex items-center justify-between">
                <div className="flex items-center gap-2.5 font-mono text-xs">
                  <Terminal size={15} className="text-accent" />
                  <span className="text-bright font-bold">
                    {selectedJobForLogs.provider === "github_actions" ? "GitHub Actions Log:" : "Kaggle Execution Log:"}
                  </span>
                  <span className="text-subtle truncate max-w-xs">{selectedJobForLogs.title}</span>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => fetchLogs(selectedJobForLogs)}
                    disabled={loadingLogs}
                    className="p-1.5 rounded-lg text-subtle hover:text-bright hover:bg-[#21262d] transition-all flex items-center gap-1.5 font-mono text-[11px]"
                    title="Refresh logs now"
                  >
                    <RefreshCw size={13} className={loadingLogs ? "animate-spin" : ""} />
                    <span>Refresh</span>
                  </button>

                  <button
                    onClick={() => setSelectedJobForLogs(null)}
                    className="p-1.5 rounded-lg text-subtle hover:text-bright hover:bg-[#21262d] transition-all"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              {/* Terminal Body */}
              <div className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-[#c9d1d9] bg-[#0d1117] select-text">
                {loadingLogs && !logsText ? (
                  <div className="h-48 flex items-center justify-center gap-2 text-subtle">
                    <Loader2 size={18} className="animate-spin text-accent" />
                    <span>Fetching live logs from Kaggle API...</span>
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap break-all font-mono text-[11px]">
                    {logsText}
                    <div ref={terminalEndRef} />
                  </pre>
                )}
              </div>

              {/* Terminal Footer */}
              <div className="px-5 py-2.5 bg-[#161b22] border-t border-border/60 flex items-center justify-between font-mono text-[11px] text-subtle">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-teal animate-pulse" />
                    <span>Kernel: {selectedJobForLogs.kernelSlug}</span>
                  </span>
                </div>
                <span>Status: {selectedJobForLogs.status.toUpperCase()}</span>
              </div>
            </motion.div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
