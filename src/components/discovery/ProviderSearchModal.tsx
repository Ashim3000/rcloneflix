import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { X, Search, Play, Bell, Sparkles, Loader2, Check } from "lucide-react";
import { useAppStore, type TvSubscription } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { searchEasynews } from "../../lib/easynews";
import { queryStremioStreams } from "../../lib/stremioAddonEngine";
import { httpFetch } from "../../lib/httpFetch";
import { SubscribeModal } from "../tv/SubscribeModal";

export type ParsedReleaseDescriptor = {
  kind: "tv" | "dated_scene" | "movie";
  seriesOrSite: string;
  season?: number;
  episode?: number;
  episodeCode?: string;
  releaseDate?: string;
  releaseGroup?: string;
  quality: "4k" | "1080p" | "720p" | "any";
};

export function parseReleaseDescriptor(rawTitle: string): ParsedReleaseDescriptor {
  const clean = rawTitle.replace(/\.[a-z0-9]{2,4}$/i, "");
  const qLower = clean.toLowerCase();
  const quality: ParsedReleaseDescriptor["quality"] =
    qLower.includes("2160p") || qLower.includes("4k")
      ? "4k"
      : qLower.includes("1080p")
        ? "1080p"
        : qLower.includes("720p")
          ? "720p"
          : "any";

  const grpMatch = clean.match(/(?:-|\[)([A-Za-z0-9]{2,15})\]?$/);
  const releaseGroup = grpMatch ? grpMatch[1] : undefined;

  const tvMatch = clean.match(/^(.+?)[. _-]+S(\d{1,2})\s*[. _-]*E(\d{1,3})/i);
  if (tvMatch) {
    const s = parseInt(tvMatch[2], 10);
    const e = parseInt(tvMatch[3], 10);
    return {
      kind: "tv",
      seriesOrSite: tvMatch[1].replace(/[._]+/g, " ").trim(),
      season: s,
      episode: e,
      episodeCode: `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`,
      releaseGroup,
      quality,
    };
  }

  const date4 = clean.match(/^(.+?)[. _-]+((?:19|20)\d{2})[.\-_](\d{2})[.\-_](\d{2})\b/);
  if (date4) {
    return {
      kind: "dated_scene",
      seriesOrSite: date4[1].replace(/[._]+/g, " ").trim(),
      releaseDate: `${date4[2]}-${date4[3]}-${date4[4]}`,
      releaseGroup,
      quality,
    };
  }
  const date2 = clean.match(/^(.+?)[. _-]+(\d{2})[.\-_](\d{2})[.\-_](\d{2})\b/);
  if (date2) {
    const yy = parseInt(date2[2], 10);
    const mm = parseInt(date2[3], 10);
    const dd = parseInt(date2[4], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
      return {
        kind: "dated_scene",
        seriesOrSite: date2[1].replace(/[._]+/g, " ").trim(),
        releaseDate: `${yyyy}-${date2[3]}-${date2[4]}`,
        releaseGroup,
        quality,
      };
    }
  }

  return {
    kind: "movie",
    seriesOrSite: clean.split(/\b(?:19|20)\d{2}\b|\b(?:2160p|1080p|720p)\b/i)[0].replace(/[._]+/g, " ").trim() || clean,
    releaseGroup,
    quality,
  };
}

type ProviderKey = "easynews" | "infinidysk" | "stremio_debrid";

type SearchHit = {
  id: string;
  title: string;
  sizeLabel: string;
  provider: ProviderKey;
  streamUrl?: string;
  nzbUrl?: string;
  parsed: ParsedReleaseDescriptor;
  matchedMeta?: { imdbId: string; seriesTitle: string; posterUrl?: string };
};

export function ProviderSearchModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const { easynewsConfig, stremioAddons, debridConfig, libraries } = useAppStore();

  const hasEasynews = Boolean(easynewsConfig?.enabled && easynewsConfig?.username && easynewsConfig?.password);
  const hasDebridKey = Boolean(debridConfig?.realDebridApiKey || debridConfig?.premiumizeApiKey || debridConfig?.offcloudApiKey);
  const hasStremio = Boolean((stremioAddons?.length ?? 0) > 0 && hasDebridKey);
  const [hasInfiniDysk, setHasInfiniDysk] = useState(false);

  const [provider, setProvider] = useState<ProviderKey>("easynews");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [matchingId, setMatchingId] = useState<string | null>(null);
  const [subscribeSeed, setSubscribeSeed] = useState<{
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
  } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      try {
        const st = await invoke<{ configured?: boolean }>("usenet_get_status");
        const hasOmg = Boolean(localStorage.getItem("rcloneflix_omg_user") && localStorage.getItem("rcloneflix_omg_key"));
        const enableNzbindex = true; // matches InfiniDyskSearchModal.tsx
        setHasInfiniDysk(Boolean(st?.configured && (hasOmg || enableNzbindex)));
      } catch {
        setHasInfiniDysk(false);
      }
    })();
  }, [isOpen]);

  useEffect(() => {
    if (hasEasynews) setProvider("easynews");
    else if (hasInfiniDysk) setProvider("infinidysk");
    else if (hasStremio) setProvider("stremio_debrid");
  }, [hasEasynews, hasInfiniDysk, hasStremio]);

  if (!isOpen) return null;

  const formatBytes = (b?: number) => {
    if (!b) return "—";
    if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
    return `${(b / 1048576).toFixed(0)} MB`;
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setHits([]);
    try {
      if (provider === "easynews") {
        const res = await searchEasynews(query.trim(), "video", "relevance", 15);
        setHits(
          res.results.map((r, i) => ({
            id: `en-${i}-${r.filename}`,
            title: r.filename,
            sizeLabel: formatBytes(r.sizeBytes),
            provider: "easynews",
            streamUrl: r.dlUrl,
            parsed: parseReleaseDescriptor(r.filename),
          }))
        );
      } else if (provider === "infinidysk") {
        const res = await invoke<{ results: Array<{ id: string; title: string; size_bytes: number; nzb_url: string }> }>(
          "search_usenet_indexers",
          {
            query: query.trim(),
            omgUser: localStorage.getItem("rcloneflix_omg_user") || undefined,
            omgApiKey: localStorage.getItem("rcloneflix_omg_key") || undefined,
            enableNzbindex: true,
          }
        );
        setHits(
          (res?.results || []).map((r, i) => ({
            id: `nzb-${i}-${r.id}`,
            title: r.title,
            sizeLabel: formatBytes(r.size_bytes),
            provider: "infinidysk",
            nzbUrl: r.nzb_url,
            parsed: parseReleaseDescriptor(r.title),
          }))
        );
      } else if (provider === "stremio_debrid") {
        const cmRes = await httpFetch(
          `https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(query.trim())}.json`
        );
        const cmJson = await cmRes.json();
        const top = cmJson?.metas?.[0];
        if (!top?.imdb_id && !top?.id) {
          addToast("No matching series found on Cinemeta for Stremio query.", "info");
          return;
        }
        const imdbId = top.imdb_id || top.id;
        const streams = await queryStremioStreams({ imdbId, type: "series", season: 1, episode: 1 });
        setHits(
          streams
            .filter((s) => s.streamUrl)
            .map((s, i) => ({
              id: `st-${i}`,
              title: s.cleanFilename || s.title || top.name,
              sizeLabel: formatBytes(s.sizeBytes),
              provider: "stremio_debrid",
              streamUrl: s.streamUrl,
              parsed: parseReleaseDescriptor(s.cleanFilename || s.title || top.name),
              matchedMeta: { imdbId, seriesTitle: top.name, posterUrl: top.poster },
            }))
        );
      }
    } catch (err: any) {
      addToast(`Search failed: ${err?.message || err}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleStream = async (hit: SearchHit) => {
    try {
      if (hit.streamUrl) {
        onClose();
        navigate(`/player?url=${encodeURIComponent(hit.streamUrl)}&title=${encodeURIComponent(hit.title)}`);
        return;
      }
      if (hit.nzbUrl) {
        const playables = await invoke<Array<{ name: string; size: number; virtual_path?: string | null }>>(
          "parse_nzb_media_files",
          { nzbUrl: hit.nzbUrl, nzbXml: null, password: null, virtualDir: "Uncategorized" }
        );
        const best = [...(playables || [])].sort((a, b) => b.size - a.size)[0];
        if (!best) {
          addToast("No playable media found inside NZB.", "error");
          return;
        }
        const davPath = (best.virtual_path || best.name).split("/").map(encodeURIComponent).join("/");
        onClose();
        navigate(`/player?url=${encodeURIComponent(`http://127.0.0.1:8553/dav/${davPath}`)}&title=${encodeURIComponent(best.name)}`);
      }
    } catch (err: any) {
      addToast(`Stream failed: ${err?.message || err}`, "error");
    }
  };

  const handleMatchMeta = async (hit: SearchHit) => {
    setMatchingId(hit.id);
    try {
      const res = await httpFetch(
        `https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(hit.parsed.seriesOrSite)}.json`
      );
      const data = await res.json();
      const top = data?.metas?.[0];
      if (!top) {
        addToast(`No Cinemeta match for "${hit.parsed.seriesOrSite}"`, "info");
        return;
      }
      setHits((prev) =>
        prev.map((h) =>
          h.id === hit.id
            ? {
                ...h,
                matchedMeta: {
                  imdbId: top.imdb_id || top.id,
                  seriesTitle: top.name,
                  posterUrl: top.poster,
                },
              }
            : h
        )
      );
    } catch (err: any) {
      addToast(`Metadata lookup failed: ${err?.message || err}`, "error");
    } finally {
      setMatchingId(null);
    }
  };

  const handleOpenSubscribe = (hit: SearchHit) => {
    const isDated = hit.parsed.kind === "dated_scene";
    const preferredLib =
      libraries.find((l) => (isDated ? l.type === "adult" : l.type === "tv")) || libraries[0];
    const cleanTitle = hit.matchedMeta?.seriesTitle || hit.parsed.seriesOrSite;
    const baseRemote = preferredLib?.remotePaths?.[0]?.replace(/\/+$/, "") || "";
    setSubscribeSeed({
      seriesId: isDated
        ? `dated:${cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
        : hit.matchedMeta?.imdbId || cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      imdbId: isDated ? undefined : hit.matchedMeta?.imdbId,
      seriesTitle: cleanTitle,
      posterUrl: isDated ? undefined : hit.matchedMeta?.posterUrl,
      libraryId: preferredLib?.id || "",
      destinationRemotePath: baseRemote ? `${baseRemote}/${cleanTitle}` : "",
      subscriptionKind: isDated ? "dated_scene" : "tv",
      lastGrabbedDate: isDated ? hit.parsed.releaseDate : undefined,
      lastGrabbedEpisode: !isDated ? hit.parsed.episodeCode : undefined,
      preferredSource: hit.provider,
      qualityProfile: hit.parsed.quality,
      preferredReleaseGroups: hit.parsed.releaseGroup ? [hit.parsed.releaseGroup] : undefined,
    });
  };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg text-bright">SEARCH &amp; SUBSCRIBE</h2>
            <p className="text-xs text-subtle">Search configured providers, stream directly, or subscribe to future releases.</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-subtle hover:text-bright hover:bg-panel">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 border-b border-border bg-panel flex flex-wrap items-center gap-2.5">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderKey)}
            className="bg-surface border border-border rounded-xl px-3 py-2 text-xs text-bright"
          >
            {hasEasynews && <option value="easynews">Easynews</option>}
            {hasInfiniDysk && <option value="infinidysk">InfiniDysk (Usenet)</option>}
            {hasStremio && <option value="stremio_debrid">Stremio Debrid</option>}
          </select>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search show, movie, or dated scene (e.g. Severance, SiteName 26.11.15)..."
            className="flex-1 bg-surface border border-border rounded-xl px-3.5 py-2 text-xs text-bright"
          />
          <button
            onClick={handleSearch}
            disabled={loading || !query.trim()}
            className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            <span>Search</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {hits.length === 0 && !loading && (
            <p className="text-center text-xs text-subtle py-10">Enter a query and click Search.</p>
          )}
          {hits.map((hit) => (
            <div key={hit.id} className="p-3 rounded-xl bg-panel border border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-bright truncate">{hit.title}</p>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-subtle mt-1">
                  <span>{hit.sizeLabel}</span>
                  <span className="px-1.5 py-0.5 rounded bg-surface border border-border">{hit.parsed.kind}</span>
                  {hit.parsed.quality !== "any" && <span className="px-1.5 py-0.5 rounded bg-accent/15 text-accent">{hit.parsed.quality}</span>}
                  {hit.parsed.releaseDate && <span className="font-mono">{hit.parsed.releaseDate}</span>}
                  {hit.parsed.episodeCode && <span className="font-mono">{hit.parsed.episodeCode}</span>}
                  {hit.matchedMeta && (
                    <span className="text-emerald-400 flex items-center gap-1">
                      <Check size={11} /> {hit.matchedMeta.seriesTitle}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleStream(hit)}
                  className="btn-secondary text-[11px] py-1.5 px-2.5 flex items-center gap-1"
                >
                  <Play size={12} /> Stream
                </button>
                {hit.parsed.kind !== "dated_scene" && (
                  <button
                    onClick={() => handleMatchMeta(hit)}
                    disabled={matchingId === hit.id}
                    className="btn-secondary text-[11px] py-1.5 px-2.5 flex items-center gap-1"
                  >
                    {matchingId === hit.id ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    Match
                  </button>
                )}
                <button
                  onClick={() => handleOpenSubscribe(hit)}
                  className="btn-primary text-[11px] py-1.5 px-2.5 flex items-center gap-1"
                >
                  <Bell size={12} /> Subscribe
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {subscribeSeed && (
        <SubscribeModal
          isOpen={Boolean(subscribeSeed)}
          onClose={() => setSubscribeSeed(null)}
          seed={subscribeSeed}
        />
      )}
    </div>,
    document.body
  );
}
