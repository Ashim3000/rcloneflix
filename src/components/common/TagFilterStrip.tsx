import { useMemo, useState } from "react";
import { CheckSquare, Globe, Tag, X } from "lucide-react";
import { useAppStore, type MediaItem } from "../../store/appStore";

type Props = {
  items: MediaItem[];
  activeTag: string | null;
  onSelectTag: (tag: string | null) => void;
  allLibraries?: boolean;
  onToggleAllLibraries?: () => void;
  bulkMode?: boolean;
  onToggleBulkMode?: () => void;
  selectedIds?: string[];
  onClearSelection?: () => void;
};

export function TagFilterStrip({
  items,
  activeTag,
  onSelectTag,
  allLibraries = false,
  onToggleAllLibraries,
  bulkMode = false,
  onToggleBulkMode,
  selectedIds = [],
  onClearSelection,
}: Props) {
  const { bulkAddUserTag } = useAppStore();
  const [bulkTagInput, setBulkTagInput] = useState("");

  const tagCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) {
      for (const t of item.userTags || []) {
        map.set(t, (map.get(t) || 0) + 1);
      }
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [items]);

  if (tagCounts.length === 0 && !onToggleBulkMode && !activeTag) return null;

  const handleBulkApply = () => {
    const clean = bulkTagInput.trim().replace(/^#/, "");
    if (!clean || selectedIds.length === 0) return;
    bulkAddUserTag(selectedIds, clean);
    setBulkTagInput("");
    onClearSelection?.();
  };

  return (
    <div className="px-8 pb-3 flex flex-wrap items-center gap-2">
      {tagCounts.map(([tag, count]) => {
        const active = activeTag === tag;
        return (
          <button
            key={tag}
            type="button"
            onClick={() => onSelectTag(active ? null : tag)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border transition-colors cursor-pointer ${
              active
                ? "bg-accent text-void border-accent font-semibold"
                : "bg-panel text-subtle border-border hover:text-bright hover:border-accent/40"
            }`}
          >
            <Tag size={11} />
            <span>#{tag}</span>
            <span className="opacity-75">({count})</span>
          </button>
        );
      })}

      {activeTag && (
        <>
          <button
            type="button"
            onClick={() => onSelectTag(null)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-mono bg-panel border border-border text-subtle hover:text-bright cursor-pointer"
          >
            <X size={11} /> Clear
          </button>
          {onToggleAllLibraries && (
            <button
              type="button"
              onClick={onToggleAllLibraries}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-mono border cursor-pointer ${
                allLibraries
                  ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/40"
                  : "bg-panel text-subtle border-border hover:text-bright"
              }`}
            >
              <Globe size={11} />
              <span>All Libraries with #{activeTag}</span>
            </button>
          )}
        </>
      )}

      {onToggleBulkMode && (
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleBulkMode}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono border cursor-pointer ${
              bulkMode
                ? "bg-accent/20 text-accent border-accent/40"
                : "bg-panel text-subtle border-border hover:text-bright"
            }`}
          >
            <CheckSquare size={12} />
            <span>{bulkMode ? `Bulk Tag (${selectedIds.length})` : "Bulk Tag"}</span>
          </button>
          {bulkMode && selectedIds.length > 0 && (
            <div className="inline-flex items-center gap-1">
              <input
                type="text"
                value={bulkTagInput}
                onChange={(e) => setBulkTagInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleBulkApply()}
                placeholder="Tag selected..."
                className="bg-panel border border-border rounded-lg px-2.5 py-1 text-xs text-bright w-32"
              />
              <button
                type="button"
                onClick={handleBulkApply}
                className="px-2.5 py-1 rounded-lg bg-accent text-void text-xs font-semibold cursor-pointer"
              >
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
