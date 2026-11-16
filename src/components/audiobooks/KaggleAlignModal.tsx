import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles,
  X,
  Cpu,
  Loader2,
  CheckCircle2,
  ExternalLink,
  BookOpen,
  Headphones,
  AlertCircle,
  Zap,
} from "lucide-react";
import type { MediaItem } from "../../store/appStore";
import { useAppStore } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import {
  dispatchKaggleAlign,
  useCloudAlignStore,
  type CloudAlignJob,
} from "../../lib/kaggleAligner";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  epubItem: MediaItem;
  audioItem: MediaItem;
};

export function KaggleAlignModal({
  isOpen,
  onClose,
  epubItem,
  audioItem,
}: Props) {
  const { kaggleUsername, kaggleKey, rcloneConfigContent } = useAppStore();
  const { addJob } = useCloudAlignStore();

  const [model, setModel] = useState<"base" | "small" | "medium">("small");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdJob, setCreatedJob] = useState<CloudAlignJob | null>(null);

  if (!isOpen) return null;

  const hasCreds = Boolean(kaggleUsername?.trim() && kaggleKey?.trim());

  const handleStart = async () => {
    if (!hasCreds) {
      useToastStore
        .getState()
        .addToast("Please configure Kaggle credentials in Settings first.", "error");
      return;
    }

    setIsSubmitting(true);
    try {
      const jobId = `align-${Date.now()}`;
      // Output destination: save aligned EPUB alongside the original EPUB with .aligned.epub extension
      const outPath = epubItem.remotePath.replace(/\.epub$/i, ".aligned.epub");

      const res = await dispatchKaggleAlign({
        job_id: jobId,
        title: `${epubItem.title} (Whisper SMIL)`,
        epub_remote_path: epubItem.remotePath,
        audio_remote_path: audioItem.remotePath,
        output_remote_path: outPath,
        whisper_model: model,
        rclone_config_snippet: rcloneConfigContent,
      });

      const newJob: CloudAlignJob = {
        id: jobId,
        title: epubItem.title,
        epubRemotePath: epubItem.remotePath,
        audioRemotePath: audioItem.remotePath,
        outputRemotePath: outPath,
        whisperModel: model,
        kernelSlug: res.kernel_slug,
        kernelUrl: res.url,
        status: "queued",
        createdAt: Date.now(),
      };

      addJob(newJob);
      setCreatedJob(newJob);
      useToastStore
        .getState()
        .addToast("Dispatched Whisper alignment job to Kaggle T4 GPU!", "success");
    } catch (err: any) {
      useToastStore
        .getState()
        .addToast(`Failed to dispatch alignment: ${err?.message || String(err)}`, "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        className="w-full max-w-lg rounded-2xl bg-card border border-white/15 shadow-2xl p-6 flex flex-col gap-5 text-text"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400">
              <Sparkles size={20} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">
                Kaggle Cloud Whisper Aligner
              </h2>
              <p className="text-xs text-subtle font-body">
                Free T4 GPU Media Overlay (SMIL) generation
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Success View */}
        {createdJob ? (
          <div className="space-y-4 py-2">
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-start gap-3">
              <CheckCircle2 size={20} className="flex-shrink-0 mt-0.5" />
              <div className="text-xs space-y-1">
                <p className="font-semibold text-white text-sm">
                  Alignment Worker Dispatched!
                </p>
                <p className="text-subtle">
                  Kaggle is spinning up a free Nvidia T4 GPU runner to transcribe and align{" "}
                  <strong className="text-white">"{epubItem.title}"</strong>.
                </p>
                <p className="text-subtle">
                  A 15-hour audiobook typically completes in ~12 minutes. The aligned EPUB with SMIL Media Overlays will be written back to your cloud remote automatically.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/10 text-xs">
              <span className="text-subtle">Kaggle Kernel Console</span>
              <a
                href={createdJob.kernelUrl}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline flex items-center gap-1 font-mono text-[11px]"
              >
                <span>View Notebook</span>
                <ExternalLink size={12} />
              </a>
            </div>

            <button onClick={onClose} className="btn-accent w-full py-2.5 text-xs font-semibold">
              Done
            </button>
          </div>
        ) : (
          /* Setup / Config Form */
          <div className="space-y-4">
            {/* Input Pair Summary */}
            <div className="space-y-2 p-3.5 rounded-xl bg-white/5 border border-white/10 text-xs">
              <div className="flex items-center gap-2 text-white">
                <BookOpen size={15} className="text-accent flex-shrink-0" />
                <span className="font-semibold truncate">EPUB:</span>
                <span className="text-subtle truncate">{epubItem.title}</span>
              </div>
              <div className="flex items-center gap-2 text-white">
                <Headphones size={15} className="text-amber-400 flex-shrink-0" />
                <span className="font-semibold truncate">Audio:</span>
                <span className="text-subtle truncate">{audioItem.title}</span>
              </div>
            </div>

            {/* Model Selector */}
            <div>
              <label className="text-xs font-medium text-white/80 block mb-1.5">
                Whisper Model
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { id: "base", name: "Base", desc: "~5 min (Fast)" },
                    { id: "small", name: "Small", desc: "~12 min (Recommended)" },
                    { id: "medium", name: "Medium", desc: "~25 min (Deep)" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setModel(opt.id)}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      model === opt.id
                        ? "bg-amber-500/20 border-amber-500/50 text-white"
                        : "bg-surface/40 border-white/10 text-subtle hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    <p className="font-semibold text-xs text-white">{opt.name}</p>
                    <p className="text-[10px] text-subtle">{opt.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Free GPU Badge */}
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-center gap-2.5 text-xs text-amber-300">
              <Zap size={16} className="flex-shrink-0 text-amber-400" />
              <span>
                Runs 100% offloaded on Kaggle's free 30-hour/week Nvidia T4 GPU quota. Zero CPU usage on your laptop!
              </span>
            </div>

            {/* Kaggle Status Warning */}
            {!hasCreds && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center gap-2.5 text-xs text-red-300">
                <AlertCircle size={16} className="flex-shrink-0 text-red-400" />
                <span>
                  Kaggle credentials not configured. Please add your Kaggle username and API key in Settings &rarr; Cloud Transcoder.
                </span>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button onClick={onClose} className="btn-secondary text-xs px-4 py-2">
                Cancel
              </button>
              <button
                onClick={handleStart}
                disabled={isSubmitting || !hasCreds}
                className="btn-accent text-xs px-5 py-2 font-semibold flex items-center gap-1.5"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    <span>Dispatching to GPU…</span>
                  </>
                ) : (
                  <>
                    <Cpu size={14} />
                    <span>Start Whisper Alignment</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
