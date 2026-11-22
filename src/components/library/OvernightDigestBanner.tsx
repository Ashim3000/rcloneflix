import { useState, useMemo } from "react";
import { Sparkles, X, Zap } from "lucide-react";
import { useCloudTranscodeStore } from "../../lib/kaggleTranscode";

const DISMISSED_KEY = "rcloneflix_digest_dismissed_at";

export function OvernightDigestBanner() {
  const jobsMap = useCloudTranscodeStore((s) => s.jobs);
  const [dismissedAt, setDismissedAt] = useState<number>(() => {
    try {
      return parseInt(localStorage.getItem(DISMISSED_KEY) || "0", 10) || 0;
    } catch {
      return 0;
    }
  });

  const recentCompleted = useMemo(() => {
    const cutoff = Math.max(dismissedAt, Date.now() - 48 * 60 * 60 * 1000);
    return Object.values(jobsMap || {})
      .filter((j) => j.status === "complete" && (j.completedAt || j.startedAt) > cutoff)
      .sort((a, b) => (b.completedAt || b.startedAt) - (a.completedAt || a.startedAt))
      .slice(0, 6);
  }, [jobsMap, dismissedAt]);

  if (recentCompleted.length === 0) return null;

  return (
    <div className="mb-6 p-4 rounded-2xl bg-panel border border-accent/30 flex items-start justify-between gap-4">
      <div className="space-y-1.5 min-w-0">
        <div className="flex items-center gap-2 text-accent text-xs font-semibold">
          <Sparkles size={14} />
          <span>NEW SINCE LAST VISIT ({recentCompleted.length} Completed Cloud Job{recentCompleted.length === 1 ? "" : "s"})</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {recentCompleted.map((j) => (
            <span
              key={j.id}
              className="px-2.5 py-1 rounded-lg bg-surface border border-border text-xs text-bright flex items-center gap-1.5 truncate max-w-xs"
            >
              <Zap size={11} className="text-accent shrink-0" />
              <span className="truncate">{j.title}</span>
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          const now = Date.now();
          setDismissedAt(now);
          try {
            localStorage.setItem(DISMISSED_KEY, String(now));
          } catch {}
        }}
        className="p-1.5 rounded-lg text-subtle hover:text-bright shrink-0"
        title="Dismiss digest"
      >
        <X size={16} />
      </button>
    </div>
  );
}
