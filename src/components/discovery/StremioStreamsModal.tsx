import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  X, Zap, Play, CloudUpload, Loader2, AlertCircle, Filter, HardDrive, Users, ShieldCheck,
} from "lucide-react";
import { useAppStore, type MediaItem } from "../../store/appStore";
import {
  queryStremioStreams,
  resolveImdbIdForItem,
  type NormalizedStremioStream,
} from "../../lib/stremioAddonEngine";
import { resolveDebridLink } from "../../lib/debrid";
import { AddStreamBookmarkModal } from "../library/AddStreamBookmarkModal";
import { useToastStore } from "../../store/toastStore";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  item: MediaItem;
  overrideSeason?: number;
  overrideEpisode?: number;
};

export function StremioStreamsModal({
  isOpen,
  onClose,
  item,
  overrideSeason,
  overrideEpisode,
}: Props) {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const { stremioAddons, debridConfig } = useAppStore();

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [streams, setStreams] = useState<NormalizedStremioStream[]>([]);
  const [selectedTracker, setSelectedTracker] = useState<string>("all");
  const [selectedRes, setSelectedRes] = useState<string>("all");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [ingestStream, setIngestStream] = useState<{ url: string; title: string } | null>(null);

  const isTv = item.libraryType === "tv" || item.groupType === "show" || Boolean(item.showTitle);
  const season = overrideSeason ?? item.season ?? 1;
  const episode = overrideEpisode ?? item.episode ?? 1;

  useEffect(() => {
    if (!isOpen) return;
    let active = true;

    const load = async () => {
      setLoading(true);
      setErrorMsg("");
      setStreams([]);
      try {
        const imdbId = await resolveImdbIdForItem(item);
        if (!imdbId) {
          if (active) setErrorMsg("Could not resolve an IMDb ID for this title.");
          return;
        }
        const results = await queryStremioStreams({
          imdbId,
          type: isTv ? "series" : "movie",
          season: isTv ? season : undefined,
          episode: isTv ? episode : undefined,
        });
        if (!active) return;
        setStreams(results);
        if (results.length === 0) {
          setErrorMsg("No streams returned by your configured Stremio addons.");
        }
      } catch (err: any) {
        if (active) setErrorMsg(err?.message || "Failed to query Stremio addons.");
      } finally {
        if (active) setLoading(false);
      }
    };

    load();
    return () => {
      active = false;
    };
  }, [isOpen, item, isTv, season, episode]);

  const trackers = useMemo(() => {
    const set = new Set<string>();
    for (const s of streams) {
      if (s.tracker) set.add(s.tracker);
    }
    return Array.from(set);
  }, [streams]);

  const filteredStreams = useMemo(() => {
    return streams.filter((s) => {
      if (selectedTracker !== "all" && s.tracker !== selectedTracker) return false;
      if (selectedRes !== "all" && s.resolution !== selectedRes) return false;
      return true;
    });
  }, [streams, selectedTracker, selectedRes]);

  const resolvePlayableUrl = async (s: NormalizedStremioStream): Promise<string | null> => {
    if (s.streamUrl) return s.streamUrl;
    if (s.infoHash) {
      const magnet = `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(s.cleanFilename)}`;
      try {
        const resolved = await resolveDebridLink(magnet);
        return resolved?.streamUrl ?? null;
      } catch (err: any) {
        addToast(
          err?.message || "Configure Real-Debrid/Premiumize in Settings or use a Debrid-embedded Stremio addon URL.",
          "error"
        );
        return null;
      }
    }
    return null;
  };

  const handlePlayStream = async (s: NormalizedStremioStream) => {
    setResolvingId(s.id);
    try {
      const url = await resolvePlayableUrl(s);
      if (!url) return;
      const playItem: MediaItem = {
        ...item,
        id: item.id || `stremio-live-${Date.now()}`,
        remotePath: url,
        streamUrl: url,
        filename: s.cleanFilename,
        isSourceBookmark: true,
      };
      onClose();
      navigate("/play/video", { state: { item: playItem } });
    } finally {
      setResolvingId(null);
    }
  };

  const handleIngestStream = async (s: NormalizedStremioStream) => {
    setResolvingId(s.id);
    try {
      const url = await resolvePlayableUrl(s);
      if (!url) return;
      setIngestStream({
        url,
        title: isTv
          ? `${item.showTitle || item.title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
          : item.title,
      });
    } finally {
      setResolvingId(null);
    }
  };

  if (!isOpen) return null;

  const hasAddons = (stremioAddons || []).some((a) => a.enabled);

  return (
    <>
      <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 12 }}
          className="bg-surface border border-border rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-panel/40">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
                <Zap size={18} />
              </div>
              <div>
                <h2 className="font-heading font-semibold text-bright text-base leading-tight">
                  Stremio Addon &amp; Multi-Tracker Streams
                </h2>
                <p className="text-subtle text-xs font-body">
                  {isTv
                    ? `${item.showTitle || item.title} · S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
                    : item.title}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-subtle hover:text-text p-1.5 rounded-lg hover:bg-panel transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Filter Bar */}
          {streams.length > 0 && (
            <div className="px-6 py-3 border-b border-border bg-panel/20 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs text-subtle">
                <Filter size={13} className="text-accent" />
                <span>Resolution:</span>
                {["all", "4K", "1080p", "720p"].map((res) => (
                  <button
                    key={res}
                    onClick={() => setSelectedRes(res)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      selectedRes === res
                        ? "bg-accent text-void font-semibold"
                        : "bg-panel text-subtle hover:text-text border border-border"
                    }`}
                  >
                    {res.toUpperCase()}
                  </button>
                ))}
              </div>

              {trackers.length > 0 && (
                <div className="flex items-center gap-1.5 text-xs text-subtle ml-auto">
                  <span>Tracker:</span>
                  <select
                    value={selectedTracker}
                    onChange={(e) => setSelectedTracker(e.target.value)}
                    className="bg-panel border border-border rounded-lg px-2.5 py-1 text-xs text-text focus:outline-none focus:border-accent"
                  >
                    <option value="all">All Trackers ({streams.length})</option>
                    {trackers.map((t) => (
                      <option key={t} value={t}>
                        ⚙️ {t}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-2.5">
            {!hasAddons ? (
              <div className="p-8 text-center space-y-3">
                <AlertCircle size={32} className="text-amber-400 mx-auto" />
                <p className="text-bright font-body text-sm font-medium">
                  No Stremio Addons Configured
                </p>
                <p className="text-subtle font-body text-xs max-w-md mx-auto">
                  Add a Stremio Addon URL (such as Torrentio, Comet, or MediaFusion) in{" "}
                  <span className="text-accent font-semibold">Settings &rarr; Integrations</span> to unlock multi-tracker Debrid streaming.
                </p>
              </div>
            ) : loading ? (
              <div className="py-16 text-center space-y-3">
                <Loader2 size={32} className="animate-spin text-accent mx-auto" />
                <p className="text-subtle font-body text-xs">
                  Querying Stremio addons &amp; checking Debrid cache...
                </p>
              </div>
            ) : errorMsg ? (
              <div className="p-8 text-center space-y-2">
                <AlertCircle size={28} className="text-amber-400 mx-auto" />
                <p className="text-subtle font-body text-xs">{errorMsg}</p>
              </div>
            ) : (
              filteredStreams.map((s) => (
                <div
                  key={s.id}
                  tabIndex={0}
                  className="p-3.5 rounded-xl bg-panel/60 hover:bg-panel border border-border hover:border-accent/40 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {s.isDebridCached && (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono text-[10px] font-bold flex items-center gap-1">
                          <ShieldCheck size={11} />
                          {s.debridProvider ? `${s.debridProvider}+` : "CACHED"}
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded bg-accent/15 border border-accent/30 text-accent font-mono text-[10px] font-bold">
                        {s.resolution}
                      </span>
                      {s.codec && (
                        <span className="px-2 py-0.5 rounded bg-surface border border-border text-text font-mono text-[10px]">
                          {s.codec}
                        </span>
                      )}
                      {s.sizeFormatted && (
                        <span className="px-2 py-0.5 rounded bg-surface border border-border text-subtle font-mono text-[10px] flex items-center gap-1">
                          <HardDrive size={10} />
                          {s.sizeFormatted}
                        </span>
                      )}
                      {s.tracker && (
                        <span className="px-2 py-0.5 rounded bg-violet-500/15 border border-violet-500/30 text-violet-300 font-mono text-[10px]">
                          ⚙️ {s.tracker}
                        </span>
                      )}
                      {s.seeds !== undefined && (
                        <span className="px-2 py-0.5 rounded bg-surface border border-border text-subtle font-mono text-[10px] flex items-center gap-1">
                          <Users size={10} />
                          {s.seeds}
                        </span>
                      )}
                    </div>
                    <p className="text-bright font-mono text-xs truncate" title={s.title}>
                      {s.cleanFilename}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handlePlayStream(s)}
                      disabled={resolvingId === s.id}
                      className="btn-primary py-1.5 px-3.5 text-xs flex items-center gap-1.5"
                    >
                      {resolvingId === s.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Play size={13} fill="currentColor" />
                      )}
                      <span>Stream</span>
                    </button>
                    <button
                      onClick={() => handleIngestStream(s)}
                      disabled={resolvingId === s.id}
                      className="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5"
                      title="Save bookmark, download, or cloud-transcode into your cloud library"
                    >
                      <CloudUpload size={13} className="text-accent" />
                      <span>Save / Convert</span>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </motion.div>
      </div>

      {ingestStream && (
        <AddStreamBookmarkModal
          isOpen={true}
          onClose={() => setIngestStream(null)}
          initialUrl={ingestStream.url}
          initialTitle={ingestStream.title}
          initialPoster={item.showPosterUrl || item.posterUrl}
          defaultLibraryType={isTv ? "tv" : "movies"}
          autoInspect={true}
        />
      )}
    </>
  );
}
