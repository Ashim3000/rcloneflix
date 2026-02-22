import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MediaCard } from "./MediaCard";
import { FixMatchModal } from "./FixMatchModal";
import type { MediaItem, WatchProgress } from "../../store/appStore";

type Props = {
  title: string;
  items: MediaItem[];
  progressMap?: Record<string, WatchProgress>;
  onPlay?: (item: MediaItem) => void;
  showProgress?: boolean;
};

export function MediaShelf({ title, items, progressMap = {}, onPlay, showProgress = false }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fixingItem, setFixingItem] = useState<MediaItem | null>(null);

  const scroll = (dir: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.75;
    el.scrollBy({ left: dir === "right" ? amount : -amount, behavior: "smooth" });
  };

  if (items.length === 0) return null;

  return (
    <>
      <div className="relative group/shelf">
        {/* Row header */}
        <div className="flex items-center justify-between mb-4 px-8">
          <h2 className="font-body font-semibold text-bright text-base tracking-wide">
            {title}
          </h2>
          <div className="flex gap-1 opacity-0 group-hover/shelf:opacity-100 transition-opacity">
            <button
              onClick={() => scroll("left")}
              className="w-7 h-7 rounded-lg bg-panel border border-border flex items-center justify-center text-subtle hover:text-text transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              onClick={() => scroll("right")}
              className="w-7 h-7 rounded-lg bg-panel border border-border flex items-center justify-center text-subtle hover:text-text transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>

        {/* Scroll container */}
        <div
          ref={scrollRef}
          className="flex gap-4 overflow-x-auto scroll-smooth px-8 pb-2"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {items.map((item, i) => (
            <div key={item.id} className="flex-shrink-0 w-36">
              <MediaCard
                item={item}
                progress={showProgress ? progressMap[item.id] : undefined}
                onPlay={onPlay}
                onFixMatch={setFixingItem}
                index={i}
              />
            </div>
          ))}
        </div>

        {/* Fade edges */}
        <div className="absolute left-0 top-8 bottom-2 w-8 bg-gradient-to-r from-void to-transparent pointer-events-none" />
        <div className="absolute right-0 top-8 bottom-2 w-8 bg-gradient-to-l from-void to-transparent pointer-events-none" />
      </div>

      {fixingItem && (
        <FixMatchModal item={fixingItem} onClose={() => setFixingItem(null)} />
      )}
    </>
  );
}
