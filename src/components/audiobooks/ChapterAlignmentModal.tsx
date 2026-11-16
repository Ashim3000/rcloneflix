import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Layers,
  X,
  RefreshCw,
  BookOpen,
  Headphones,
  Check,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import type { WhispersyncAlignment, AlignedChapter } from "../../lib/whispersync";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  alignment: WhispersyncAlignment | null;
  onReScan: () => void;
  isScanning: boolean;
  onJumpToChapter?: (chapter: AlignedChapter) => void;
  onOpenKaggleAlign?: () => void;
};

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const remSec = s % 60;
  if (m < 60) {
    return `${m}:${remSec.toString().padStart(2, "0")}`;
  }
  const h = Math.floor(m / 60);
  const remMin = m % 60;
  return `${h}:${remMin.toString().padStart(2, "0")}:${remSec.toString().padStart(2, "0")}`;
}

export function ChapterAlignmentModal({
  isOpen,
  onClose,
  alignment,
  onReScan,
  isScanning,
  onJumpToChapter,
  onOpenKaggleAlign,
}: Props) {
  if (!isOpen) return null;

  const chapters = alignment?.chapters ?? [];

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="w-full max-w-xl rounded-2xl bg-card border border-white/15 shadow-2xl p-6 flex flex-col gap-4 text-text max-h-[85vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers size={20} className="text-accent" />
              <h2 className="text-base font-semibold text-white">Whispersync Chapter Alignment</h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <div className="p-3 rounded-xl bg-accent/10 border border-accent/25 text-xs text-text/90 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-accent flex-shrink-0" />
              <p>
                <strong>{chapters.length} Chapters Aligned:</strong> Audio chapters from ffprobe metadata are mapped directly to EPUB Table of Contents landmarks.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {onOpenKaggleAlign && (
                <button
                  onClick={onOpenKaggleAlign}
                  title="Generate exact SMIL overlays with free Kaggle T4 GPU"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[11px] font-semibold hover:bg-amber-500/30 transition-all"
                >
                  <Sparkles size={12} />
                  <span>Kaggle T4 GPU</span>
                </button>
              )}
              <button
                onClick={onReScan}
                disabled={isScanning}
                title="Re-scan and realign chapters"
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-accent text-void text-[11px] font-semibold hover:bg-accent/80 transition-all flex-shrink-0 disabled:opacity-50"
              >
                <RefreshCw size={12} className={isScanning ? "animate-spin" : ""} />
                <span>{isScanning ? "Scanning…" : "Re-Scan"}</span>
              </button>
            </div>
          </div>

          {/* Chapter Alignment List */}
          <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-72 divide-y divide-white/5">
            {chapters.length === 0 ? (
              <div className="text-center py-10 text-xs text-subtle">
                No chapters mapped yet. Click Re-Scan to analyze the audiobook and EPUB.
              </div>
            ) : (
              chapters.map((ch, idx) => (
                <div
                  key={idx}
                  className="pt-2 flex items-center justify-between gap-3 hover:bg-white/5 p-2 rounded-xl transition-colors group"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/10 text-accent font-semibold">
                        #{idx + 1}
                      </span>
                      <h4 className="text-xs font-semibold text-white truncate">{ch.title}</h4>
                    </div>

                    <div className="flex items-center gap-3 mt-1 text-[11px] text-subtle font-mono">
                      <span className="flex items-center gap-1">
                        <Headphones size={11} className="text-white/40" />
                        {formatTime(ch.audioStartSec)} – {formatTime(ch.audioEndSec)}
                      </span>
                      <span>•</span>
                      <span className="flex items-center gap-1">
                        <BookOpen size={11} className="text-white/40" />
                        Page ~{Math.round(ch.epubPercentage * 100)}%
                      </span>
                    </div>
                  </div>

                  {onJumpToChapter && (
                    <button
                      onClick={() => onJumpToChapter(ch)}
                      title="Jump reader and narrator to this chapter"
                      className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-[11px] font-medium transition-all flex-shrink-0"
                    >
                      <span>Jump</span>
                      <ChevronRight size={12} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="pt-2 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-colors"
            >
              Done
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
