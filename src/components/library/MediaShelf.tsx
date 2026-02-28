import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MediaCard } from "./MediaCard";
import type { MediaItem, WatchProgress } from "../../store/appStore";

type Props = {
  title: string;
  items: (MediaItem & { progress?: WatchProgress })[];
  progressMap?: Record<string, WatchProgress>;
  showProgress?: boolean;
  onItemClick?: (item: MediaItem) => void;
};

export function MediaShelf({ title, items, progressMap = {}, showProgress, onItemClick }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (dir: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === "left" ? -300 : 300, behavior: "smooth" });
  };

  if (items.length === 0) return null;

  return (
    <div className="group/shelf">
      <div className="px-8 mb-3 flex items-center justify-between">
        <h2 className="font-body font-semibold text-text text-sm uppercase tracking-wider">{title}</h2>
        <span className="text-subtle font-body text-xs">{items.length} item{items.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="relative">
        {/* Left fade + button */}
        <div className="absolute left-0 top-0 bottom-0 w-16 bg-gradient-to-r from-void to-transparent z-10 pointer-events-none" />
        <button
          onClick={() => scroll("left")}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-panel/90 border border-border flex items-center justify-center text-subtle hover:text-text opacity-0 group-hover/shelf:opacity-100 transition-opacity"
        >
          <ChevronLeft size={16} />
        </button>

        <div
          ref={scrollRef}
          className="flex gap-4 overflow-x-auto scrollbar-none px-8 pb-2"
          style={{ scrollbarWidth: "none" }}
        >
          {items.map((item, i) => (
            <div key={item.id} className="flex-shrink-0 w-36">
              <MediaCard
                item={item}
                progress={progressMap[item.id] ?? item.progress}
                index={i}
                onPlay={onItemClick}
              />
            </div>
          ))}
        </div>

        {/* Right fade + button */}
        <div className="absolute right-0 top-0 bottom-0 w-16 bg-gradient-to-l from-void to-transparent z-10 pointer-events-none" />
        <button
          onClick={() => scroll("right")}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-panel/90 border border-border flex items-center justify-center text-subtle hover:text-text opacity-0 group-hover/shelf:opacity-100 transition-opacity"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
