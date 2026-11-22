import { Sparkles, WifiOff } from "lucide-react";
import { isLocalItem, type MediaItem, type WatchProgress } from "../../store/appStore";

export type SmartPresetId = "all" | "unwatched" | "missing_meta" | "catbox_eligible" | "offline_only";

export function applySmartPresetFilter(
  items: MediaItem[],
  preset: SmartPresetId,
  watchProgress: Record<string, WatchProgress>
): MediaItem[] {
  switch (preset) {
    case "unwatched":
      return items.filter((i) => {
        const wp = watchProgress[i.id];
        if (!wp) return true;
        const ratio = wp.percentage ?? (wp.duration > 0 ? wp.position / wp.duration : 0);
        return !wp.completed && ratio < 0.85;
      });
    case "missing_meta":
      return items.filter((i) => !i.posterUrl || !i.overview);
    case "catbox_eligible":
      return items.filter(
        (i) =>
          i.libraryType !== "adult" &&
          Boolean(i.sizeBytes && i.sizeBytes > 0 && i.sizeBytes <= 200 * 1024 * 1024)
      );
    case "offline_only":
      return items.filter((i) => isLocalItem(i));
    default:
      return items;
  }
}

export function SmartCollectionBar({
  activePreset,
  onSelectPreset,
}: {
  activePreset: SmartPresetId;
  onSelectPreset: (p: SmartPresetId) => void;
}) {
  const presets: Array<{ id: SmartPresetId; label: string; isOffline?: boolean }> = [
    { id: "all", label: "All Items" },
    { id: "unwatched", label: "Unwatched" },
    { id: "missing_meta", label: "Missing Metadata" },
    { id: "catbox_eligible", label: "Catbox Eligible (≤ 200 MB)" },
    { id: "offline_only", label: "Offline Only (Travel Mode)", isOffline: true },
  ];

  return (
    <div className="px-8 pb-3 flex items-center gap-2 overflow-x-auto text-xs">
      <span className="text-subtle font-mono text-[11px] flex items-center gap-1 shrink-0 mr-1">
        <Sparkles size={12} className="text-accent" /> Smart Filters:
      </span>
      {presets.map((p) => {
        const active = activePreset === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelectPreset(active && p.id !== "all" ? "all" : p.id)}
            className={`px-3 py-1 rounded-full border text-xs transition-all flex items-center gap-1.5 shrink-0 ${
              active
                ? "bg-accent/15 border-accent text-accent font-semibold"
                : "bg-panel border-border text-subtle hover:text-bright"
            }`}
          >
            {p.isOffline && <WifiOff size={11} />}
            <span>{p.label}</span>
          </button>
        );
      })}
    </div>
  );
}
