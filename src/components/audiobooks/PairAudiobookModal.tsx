import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, X, Headphones, BookOpen, Check, Unlink } from "lucide-react";
import type { MediaItem } from "../../store/appStore";
import { useAppStore } from "../../store/appStore";
import { isAudiobookItem, isEbookItem } from "../../lib/whispersync";

type Props = {
  item?: MediaItem;
  ebook?: MediaItem; // backward compatibility
  currentPair?: MediaItem;
  isOpen: boolean;
  onClose: () => void;
};

export function PairAudiobookModal({ item: propItem, ebook, currentPair, isOpen, onClose }: Props) {
  const { mediaItems, setWhispersyncPair, removeWhispersyncPair } = useAppStore();
  const [search, setSearch] = useState("");

  const activeItem = propItem || ebook;
  const isAudiobook = activeItem ? isAudiobookItem(activeItem) : false;

  const targetLabel = isAudiobook ? "Ebook" : "Audiobook";

  const allCandidates = useMemo(() => {
    if (!activeItem) return [];
    return Object.values(mediaItems).filter((i) => {
      if (i.id === activeItem.id) return false;
      return isAudiobook ? isEbookItem(i) : isAudiobookItem(i);
    });
  }, [mediaItems, activeItem, isAudiobook]);

  const filteredCandidates = useMemo(() => {
    if (!search.trim()) return allCandidates;
    const q = search.toLowerCase();
    return allCandidates.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        (a.author && a.author.toLowerCase().includes(q)) ||
        a.filename.toLowerCase().includes(q)
    );
  }, [allCandidates, search]);

  const handlePair = (targetId: string) => {
    if (!activeItem) return;
    setWhispersyncPair(activeItem.id, targetId);
    onClose();
  };

  const handleUnpair = () => {
    if (!activeItem) return;
    removeWhispersyncPair(activeItem.id);
    onClose();
  };

  if (!isOpen || !activeItem) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="w-full max-w-lg rounded-2xl bg-card border border-white/15 shadow-2xl p-6 flex flex-col gap-4 text-text max-h-[85vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isAudiobook ? (
                <BookOpen size={20} className="text-accent" />
              ) : (
                <Headphones size={20} className="text-accent" />
              )}
              <h2 className="text-base font-semibold text-white">
                Pair Companion {targetLabel}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <p className="text-xs text-subtle font-body">
            Pair <span className="font-semibold text-white">"{activeItem.title}"</span> with a companion {targetLabel.toLowerCase()} from any library for Whispersync Immersion Reading.
          </p>

          {/* Currently Paired Banner */}
          {currentPair && (
            <div className="flex items-center justify-between p-3 rounded-xl bg-accent/10 border border-accent/30 text-xs">
              <div className="flex items-center gap-2.5 min-w-0">
                <Check size={16} className="text-accent flex-shrink-0" />
                <div className="min-w-0">
                  <p className="font-semibold text-white truncate">{currentPair.title}</p>
                  {currentPair.author && <p className="text-[11px] text-subtle">{currentPair.author}</p>}
                </div>
              </div>
              <button
                onClick={handleUnpair}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-danger/20 hover:bg-danger/30 text-danger text-[11px] font-semibold transition-colors flex-shrink-0"
              >
                <Unlink size={12} />
                <span>Unpair</span>
              </button>
            </div>
          )}

          {/* Search Box */}
          <div className="relative">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${targetLabel.toLowerCase()}s by title, author, or filename…`}
              className="w-full pl-10 pr-4 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-white placeholder-white/40 focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          {/* Candidate List */}
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 max-h-64 divide-y divide-white/5">
            {filteredCandidates.length === 0 ? (
              <div className="text-center py-8 text-xs text-subtle">
                {allCandidates.length === 0
                  ? `No ${targetLabel.toLowerCase()}s found in your library.`
                  : `No ${targetLabel.toLowerCase()}s match your search.`}
              </div>
            ) : (
              filteredCandidates.map((cand) => {
                const isSelected = currentPair?.id === cand.id;
                return (
                  <button
                    key={cand.id}
                    onClick={() => handlePair(cand.id)}
                    className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left transition-all ${
                      isSelected
                        ? "bg-accent/15 border border-accent/40"
                        : "hover:bg-white/5 border border-transparent"
                    }`}
                  >
                    <div className="min-w-0 pr-2">
                      <p className="text-xs font-semibold text-white truncate">{cand.title}</p>
                      <p className="text-[11px] text-subtle truncate">
                        {cand.author || cand.filename}
                      </p>
                    </div>
                    {isSelected ? (
                      <span className="text-[11px] font-semibold text-accent flex items-center gap-1 flex-shrink-0">
                        <Check size={14} /> Paired
                      </span>
                    ) : (
                      <span className="text-[11px] text-white/40 group-hover:text-white flex-shrink-0">
                        Select
                      </span>
                    )}
                  </button>
                );
              })
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
