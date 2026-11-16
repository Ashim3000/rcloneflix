import { useRef, useEffect, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MediaCard } from "./MediaCard";
import type { MediaItem, WatchProgress } from "../../store/appStore";

type Props = {
  items: MediaItem[];
  progressMap: Record<string, WatchProgress>;
  onPlay?: (item: MediaItem) => void;
  tracksByCardId?: Map<string, MediaItem[]>;
  /** The page's scrolling element. The grid sits inside it, below other content. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Minimum card width in px; column count is derived from container width. */
  minCardWidth?: number;
  gap?: number;
};

/**
 * Windowed poster grid.
 *
 * The plain grid mounted one animated card per item — fine for a few hundred,
 * unusable at the 15k a music library reaches. Only visible rows are mounted,
 * so render cost tracks viewport size rather than library size.
 *
 * The page keeps its own scroll container (header and search scroll normally);
 * `scrollMargin` tells the virtualiser how far down the grid begins.
 */
export function VirtualMediaGrid({
  items,
  progressMap,
  onPlay,
  tracksByCardId,
  scrollRef,
  minCardWidth = 150,
  gap = 16,
}: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(6);
  const [cardWidth, setCardWidth] = useState(minCardWidth);
  const [scrollMargin, setScrollMargin] = useState(0);

  useEffect(() => {
    const el = gridRef.current;
    const scroller = scrollRef.current;
    if (!el || !scroller) return;

    const measure = () => {
      const width = el.clientWidth;
      if (width > 0) {
        const cols = Math.max(1, Math.floor((width + gap) / (minCardWidth + gap)));
        setColumns(cols);
        setCardWidth((width - gap * (cols - 1)) / cols);
      }
      // Distance from the top of the scrollable content to this grid.
      setScrollMargin(el.offsetTop);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [minCardWidth, gap, scrollRef, items.length]);

  // Poster is 2:3, plus ~44px for the title/meta block beneath it.
  const rowHeight = Math.round(cardWidth * 1.5) + 44 + gap;
  const rowCount = Math.ceil(items.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current as HTMLElement | null,
    estimateSize: () => rowHeight,
    overscan: 3,
    scrollMargin,
  });

  return (
    <div ref={gridRef} className="px-8 pb-12">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const start = virtualRow.index * columns;
          const rowItems = items.slice(start, start + columns);

          return (
            <div
              key={virtualRow.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                display: "grid",
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap,
              }}
            >
              {rowItems.map((item, i) => (
                <MediaCard
                  key={item.id}
                  item={item}
                  progress={progressMap[item.id]}
                  onPlay={onPlay}
                  groupTracks={tracksByCardId?.get(item.id)}
                  // Stagger within the row only, so scrolling doesn't replay a
                  // long entry animation.
                  index={i}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
