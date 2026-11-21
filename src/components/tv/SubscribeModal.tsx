import { useState } from "react";
import { motion } from "framer-motion";
import { X, Bell, Sparkles, Globe, Radio, Layers, Zap, Plus } from "lucide-react";
import { useAppStore, type TvSubscription } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";

/** Common scene/P2P release groups offered as one-click chips. Free text adds any other. */
const SUGGESTED_GROUPS = [
  "FLUX",
  "NTb",
  "RAWR",
  "ETHEL",
  "playWEB",
  "MeGusta",
  "SuccessfulCrab",
  "EDITH",
  "BAE",
  "KiNGS",
];

type Props = {
  isOpen: boolean;
  onClose: () => void;
  /** Prefill for a new subscription, or the existing one when editing. */
  seed: {
    seriesId: string;
    imdbId?: string;
    seriesTitle: string;
    posterUrl?: string;
    libraryId: string;
    destinationRemotePath: string;
    subscriptionKind?: "tv" | "dated_scene";
    lastGrabbedDate?: string;
    lastGrabbedEpisode?: string;
    preferredSource?: TvSubscription["preferredSource"];
    qualityProfile?: TvSubscription["qualityProfile"];
    preferredReleaseGroups?: string[];
  };
  existing?: TvSubscription | null;
};

export function SubscribeModal({ isOpen, onClose, seed, existing }: Props) {
  const { upsertTvSubscription, kaggleUsername, ghaConfig, easynewsConfig, libraries } = useAppStore();
  const addToast = useToastStore((s) => s.addToast);

  const cloudWorkerAvailable = Boolean(kaggleUsername || ghaConfig?.enabled);
  const easynewsConfigured = Boolean(easynewsConfig?.username && easynewsConfig?.password);

  const [quality, setQuality] = useState<TvSubscription["qualityProfile"]>(
    existing?.qualityProfile ?? seed.qualityProfile ?? "1080p"
  );
  const [maxSizeGb, setMaxSizeGb] = useState<number>(existing?.maxSizeGb ?? 6);
  const [source, setSource] = useState<TvSubscription["preferredSource"]>(
    existing?.preferredSource ?? seed.preferredSource ?? "auto"
  );
  const [priority, setPriority] = useState<NonNullable<TvSubscription["sourcePriority"]>>(
    existing?.sourcePriority ?? "stremio_debrid"
  );
  const [groups, setGroups] = useState<string[]>(
    existing?.preferredReleaseGroups ?? seed.preferredReleaseGroups ?? []
  );
  const [customGroup, setCustomGroup] = useState("");
  const [transcode, setTranscode] = useState<boolean>(
    existing?.transcodeToMp4 ?? cloudWorkerAvailable
  );
  const [destPath, setDestPath] = useState<string>(
    existing?.destinationRemotePath ?? seed.destinationRemotePath ?? ""
  );
  const [targetLibId, setTargetLibId] = useState<string>(
    existing?.libraryId ?? seed.libraryId ?? libraries[0]?.id ?? ""
  );

  if (!isOpen) return null;

  const toggleGroup = (g: string) => {
    setGroups((prev) =>
      prev.some((x) => x.toLowerCase() === g.toLowerCase())
        ? prev.filter((x) => x.toLowerCase() !== g.toLowerCase())
        : [...prev, g]
    );
  };

  const addCustomGroup = () => {
    const g = customGroup.trim();
    if (!g) return;
    if (!groups.some((x) => x.toLowerCase() === g.toLowerCase())) {
      setGroups((prev) => [...prev, g]);
    }
    setCustomGroup("");
  };

  const handleSave = () => {
    const finalDest = (existing?.destinationRemotePath ?? destPath).trim();
    if (!finalDest) {
      addToast("Please enter a destination remote path.", "error");
      return;
    }
    upsertTvSubscription({
      ...(existing || {}),
      seriesId: seed.seriesId,
      imdbId: existing?.imdbId ?? seed.imdbId,
      seriesTitle: seed.seriesTitle,
      posterUrl: seed.posterUrl,
      libraryId: targetLibId || seed.libraryId,
      monitoredSeasons: existing?.monitoredSeasons ?? "all",
      qualityProfile: quality,
      preferredSource: source,
      sourcePriority: source === "auto" ? priority : undefined,
      preferredReleaseGroups: groups.length > 0 ? groups : undefined,
      maxSizeGb,
      transcodeToMp4: transcode,
      destinationRemotePath: finalDest,
      subscriptionKind: existing?.subscriptionKind ?? seed.subscriptionKind,
      lastGrabbedDate: existing?.lastGrabbedDate ?? seed.lastGrabbedDate,
      lastGrabbedEpisode: existing?.lastGrabbedEpisode ?? seed.lastGrabbedEpisode,
      status: existing?.status ?? "active",
    });
    addToast(
      existing
        ? `Updated subscription for "${seed.seriesTitle}"`
        : `Subscribed to "${seed.seriesTitle}"! New releases will route to ${finalDest}`,
      "success"
    );
    onClose();
  };

  const sourceOptions: Array<{
    key: TvSubscription["preferredSource"];
    label: string;
    icon: React.ReactNode;
    hint: string;
  }> = [
    { key: "auto", label: "All Sources", icon: <Layers size={14} />, hint: "Try every source, led by your preferred one" },
    { key: "stremio_debrid", label: "Stremio Debrid", icon: <Sparkles size={14} />, hint: "Cached debrid streams only" },
    { key: "easynews", label: "Easynews", icon: <Globe size={14} />, hint: easynewsConfigured ? "Easynews Usenet only" : "Not configured in Settings" },
    { key: "infinidysk", label: "InfiniDysk", icon: <Radio size={14} />, hint: "Built-in Usenet indexer + local NZB mount" },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-void/80 flex items-center justify-center p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-panel border border-border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/70 sticky top-0 bg-panel z-10">
          <div className="flex items-center gap-2.5 min-w-0">
            <Bell size={18} className="text-accent flex-shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-bright truncate">
                {existing ? "Edit Subscription" : "Subscribe"} — {seed.seriesTitle}
              </h2>
              <p className="text-[11px] text-subtle truncate">
                New episodes route to {existing?.destinationRemotePath ?? seed.destinationRemotePath}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-subtle hover:text-bright hover:bg-surface cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Quality */}
          <div>
            <label className="text-[11px] uppercase tracking-wider font-mono text-subtle mb-1.5 block">Quality</label>
            <div className="grid grid-cols-4 gap-1.5">
              {(["any", "720p", "1080p", "4k"] as const).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setQuality(q)}
                  className={`py-2 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                    quality === q
                      ? "bg-accent text-void border-accent"
                      : "bg-surface border-border text-subtle hover:text-bright hover:border-accent/50"
                  }`}
                >
                  {q === "any" ? "Any" : q.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Max size */}
          <div>
            <label className="text-[11px] uppercase tracking-wider font-mono text-subtle mb-1.5 block">
              Max Episode Size — {maxSizeGb} GB
            </label>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={maxSizeGb}
              onChange={(e) => setMaxSizeGb(parseInt(e.target.value, 10))}
              className="w-full h-1.5 appearance-none rounded-full cursor-pointer bg-muted accent-accent"
            />
          </div>

          {/* Destination path (editable when seed had none) */}
          {!existing?.destinationRemotePath && !seed.destinationRemotePath && (
            <div className="space-y-2">
              <div>
                <label className="text-[11px] uppercase tracking-wider font-mono text-subtle mb-1.5 block">
                  Target Library
                </label>
                <select
                  value={targetLibId}
                  onChange={(e) => {
                    const libId = e.target.value;
                    setTargetLibId(libId);
                    const lib = libraries.find((l) => l.id === libId);
                    if (lib?.remotePaths?.[0] && !destPath) {
                      setDestPath(`${lib.remotePaths[0].replace(/\/+$/, "")}/${seed.seriesTitle}`);
                    }
                  }}
                  className="input-field w-full text-xs"
                >
                  {libraries.map((l) => (
                    <option key={l.id} value={l.id}>{l.name} ({l.type})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wider font-mono text-subtle mb-1.5 block">
                  Destination Remote Path
                </label>
                <input
                  type="text"
                  value={destPath}
                  onChange={(e) => setDestPath(e.target.value)}
                  placeholder="e.g. gdrive:TV Shows/ShowName"
                  className="input-field w-full text-xs font-mono"
                />
              </div>
            </div>
          )}

          {/* Preferred release groups */}
          <div>
            <label className="text-[11px] uppercase tracking-wider font-mono text-subtle mb-1.5 block">
              Preferred Release Groups <span className="normal-case text-subtle/70">(ranked first, others still allowed)</span>
            </label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {SUGGESTED_GROUPS.map((g) => {
                const active = groups.some((x) => x.toLowerCase() === g.toLowerCase());
                return (
                  <button
                    key={g}
                    type="button"
                    onClick={() => toggleGroup(g)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors cursor-pointer ${
                      active
                        ? "bg-accent/20 border-accent/60 text-accent"
                        : "bg-surface border-border text-subtle hover:text-bright"
                    }`}
                  >
                    {g}
                  </button>
                );
              })}
              {groups
                .filter((g) => !SUGGESTED_GROUPS.some((s) => s.toLowerCase() === g.toLowerCase()))
                .map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => toggleGroup(g)}
                    className="px-2.5 py-1 rounded-full text-[11px] font-mono border bg-accent/20 border-accent/60 text-accent cursor-pointer"
                    title="Click to remove"
                  >
                    {g} ×
                  </button>
                ))}
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={customGroup}
                onChange={(e) => setCustomGroup(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomGroup();
                  }
                }}
                placeholder="Add another group…"
                className="flex-1 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-bright placeholder:text-subtle/60 focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={addCustomGroup}
                className="p-1.5 rounded-lg border border-border bg-surface text-subtle hover:text-accent hover:border-accent/50 cursor-pointer"
                title="Add group"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>

          {/* Search source */}
          <div>
            <label className="text-[11px] uppercase tracking-wider font-mono text-subtle mb-1.5 block">Search Source</label>
            <div className="grid grid-cols-2 gap-1.5">
              {sourceOptions.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setSource(o.key)}
                  className={`px-3 py-2 rounded-lg text-left border transition-colors cursor-pointer ${
                    source === o.key
                      ? "bg-accent/15 border-accent/60"
                      : "bg-surface border-border hover:border-accent/40"
                  }`}
                >
                  <span className={`flex items-center gap-1.5 text-xs font-semibold ${source === o.key ? "text-accent" : "text-bright/90"}`}>
                    {o.icon}
                    {o.label}
                  </span>
                  <span className="block text-[10px] text-subtle mt-0.5">{o.hint}</span>
                </button>
              ))}
            </div>
            {source === "auto" && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[11px] text-subtle font-mono">Try first:</span>
                {(["stremio_debrid", "easynews", "infinidysk"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer ${
                      priority === p
                        ? "bg-accent/20 border-accent/60 text-accent"
                        : "bg-surface border-border text-subtle hover:text-bright"
                    }`}
                  >
                    {p === "stremio_debrid" ? "Stremio" : p === "easynews" ? "Easynews" : "InfiniDysk"}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Auto conversion */}
          <div>
            <button
              type="button"
              onClick={() => cloudWorkerAvailable && setTranscode((t) => !t)}
              disabled={!cloudWorkerAvailable}
              className={`w-full px-3 py-2.5 rounded-lg border flex items-center justify-between transition-colors ${
                !cloudWorkerAvailable
                  ? "bg-surface/50 border-border/50 cursor-not-allowed opacity-60"
                  : transcode
                    ? "bg-accent/15 border-accent/60 cursor-pointer"
                    : "bg-surface border-border hover:border-accent/40 cursor-pointer"
              }`}
            >
              <span className="flex items-center gap-2 text-xs font-semibold text-bright/90">
                <Zap size={14} className={transcode ? "text-accent" : "text-subtle"} />
                Automatic Cloud Conversion (H.264/AAC MP4)
              </span>
              <span className={`text-[11px] font-mono ${transcode ? "text-accent" : "text-subtle"}`}>
                {cloudWorkerAvailable ? (transcode ? "ON" : "OFF") : "No worker configured"}
              </span>
            </button>
            {transcode && (source === "infinidysk" || (source === "auto" && priority === "infinidysk")) && (
              <p className="text-[10px] text-amber-400/90 mt-1.5 px-1">
                InfiniDysk grabs are local-only streams — those episodes upload directly without
                cloud conversion; other sources still convert.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border/70 flex items-center justify-end gap-2 sticky bottom-0 bg-panel">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-semibold text-subtle hover:text-bright cursor-pointer">
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded-lg bg-accent text-void text-xs font-bold hover:bg-accent/90 cursor-pointer flex items-center gap-1.5"
          >
            <Bell size={13} />
            {existing ? "Save Changes" : "Subscribe"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
