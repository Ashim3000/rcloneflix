import { createPortal } from "react-dom";
import { Activity, X, ExternalLink, Trash2, RefreshCw, ArrowRightLeft, Zap } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { useCloudTransferStore } from "../../lib/kaggleTransfer";
import { useCloudTranscodeStore } from "../../lib/kaggleTranscode";

export function useActiveJobsCount(): number {
  const scanStatus = useAppStore((s) => s.scanState.status);
  const transferJobs = useCloudTransferStore((s) => s.jobs);
  const transcodeJobs = useCloudTranscodeStore((s) => s.jobs);

  const activeTransfers = Object.values(transferJobs || {}).filter(
    (j) => j.status === "queued" || j.status === "running"
  ).length;
  const activeTranscodes = Object.values(transcodeJobs || {}).filter(
    (j) => j.status === "queued" || j.status === "running"
  ).length;

  return (scanStatus === "scanning" ? 1 : 0) + activeTransfers + activeTranscodes;
}

export function ActivityDrawer({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const scanState = useAppStore((s) => s.scanState);
  const {
    jobs: transferJobsMap,
    removeJob: removeTransferJob,
    clearCompletedJobs: clearCompletedTransfers,
  } = useCloudTransferStore();
  const {
    jobs: transcodeJobsMap,
    removeJob: removeTranscodeJob,
    clearCompletedJobs: clearCompletedTranscodes,
  } = useCloudTranscodeStore();

  if (!isOpen) return null;

  const transferJobs = Object.values(transferJobsMap || {}).sort((a, b) => b.createdAt - a.createdAt);
  const transcodeJobs = Object.values(transcodeJobsMap || {}).sort((a, b) => b.startedAt - a.startedAt);

  return createPortal(
    <div className="fixed inset-0 z-[10000] bg-black/70 backdrop-blur-xs flex justify-end">
      <div className="bg-surface border-l border-border w-full max-w-md h-full flex flex-col shadow-2xl">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity size={18} className="text-accent" />
            <h2 className="font-display text-lg text-bright">ACTIVITY CENTER</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                clearCompletedTransfers();
                clearCompletedTranscodes();
              }}
              className="btn-secondary text-[11px] py-1 px-2.5"
            >
              Clear Completed
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg text-subtle hover:text-bright">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {scanState.status === "scanning" && (
            <div className="p-3 rounded-xl bg-panel border border-accent/40 flex items-center gap-3">
              <RefreshCw size={15} className="text-accent animate-spin shrink-0" />
              <div className="min-w-0">
                <p className="text-bright font-semibold">Library Scan Running</p>
                <p className="text-subtle truncate">{scanState.currentLibrary || "Scanning remote files…"}</p>
              </div>
            </div>
          )}

          {transferJobs.length === 0 && transcodeJobs.length === 0 && scanState.status !== "scanning" && (
            <p className="text-center text-subtle py-12">No active or recent background jobs.</p>
          )}

          {transferJobs.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-mono uppercase text-subtle">Cloud Transfers ({transferJobs.length})</p>
              {transferJobs.map((j) => (
                <div key={j.id} className="p-3 rounded-xl bg-panel border border-border space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ArrowRightLeft size={13} className="text-accent shrink-0" />
                      <span className="font-semibold text-bright truncate">{j.title}</span>
                    </div>
                    <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-surface border border-border text-subtle">
                      {j.status}
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-subtle truncate">
                    {j.source} → {j.destination}
                  </p>
                  {j.failureMessage && <p className="text-[11px] text-rose-400">{j.failureMessage}</p>}
                  <div className="flex justify-end gap-2 pt-1">
                    {j.kernelUrl && (
                      <a
                        href={j.kernelUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-accent hover:underline flex items-center gap-1"
                      >
                        <ExternalLink size={11} /> Run Log
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => removeTransferJob(j.id)}
                      className="text-[11px] text-subtle hover:text-danger flex items-center gap-1"
                    >
                      <Trash2 size={11} /> Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {transcodeJobs.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-mono uppercase text-subtle">Cloud Transcodes ({transcodeJobs.length})</p>
              {transcodeJobs.map((j) => (
                <div key={j.id} className="p-3 rounded-xl bg-panel border border-border space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Zap size={13} className="text-accent shrink-0" />
                      <span className="font-semibold text-bright truncate">{j.title}</span>
                    </div>
                    <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-surface border border-border text-subtle">
                      {j.status}
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-subtle truncate">{j.destRemoteFolder}</p>
                  {j.failureMessage && <p className="text-[11px] text-rose-400">{j.failureMessage}</p>}
                  <div className="flex justify-end gap-2 pt-1">
                    {j.kernelUrl && (
                      <a
                        href={j.kernelUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-accent hover:underline flex items-center gap-1"
                      >
                        <ExternalLink size={11} /> Run Log
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => removeTranscodeJob(j.id)}
                      className="text-[11px] text-subtle hover:text-danger flex items-center gap-1"
                    >
                      <Trash2 size={11} /> Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
