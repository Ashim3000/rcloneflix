import { useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Fingerprint, Loader2, Search, X, Check, AlertTriangle, Info } from "lucide-react";
import { isLocalPath, useAppStore, type MediaItem } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import {
  identifyByHash,
  parseAdultSceneFragment,
  searchScenesByFragment,
  type StashSceneMatch,
} from "../../lib/stashBox";

type Props = {
  item: MediaItem;
  onClose: () => void;
};

type MatchOrigin = "oshash" | "phash" | "fragment" | null;

export function FingerprintIdentifyModal({ item, onClose }: Props) {
  const {
    rcloneConfigPath,
    stashBoxProviders,
    thePornDbApiKey,
    experimentalPhashEnabled,
    updateItemMetadata,
  } = useAppStore();
  const addToast = useToastStore((s) => s.addToast);

  const activeProvider = (stashBoxProviders || []).find((p) => p.enabled && p.endpoint) || null;
  const hasAnyProvider = Boolean(activeProvider || thePornDbApiKey?.trim());

  const [oshash, setOshash] = useState(item.oshash || "");
  const [phash, setPhash] = useState(item.phash || "");
  const [busy, setBusy] = useState<string | null>(null);
  const [matches, setMatches] = useState<StashSceneMatch[]>([]);
  const [matchOrigin, setMatchOrigin] = useState<MatchOrigin>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [providerErrors, setProviderErrors] = useState<string[]>([]);

  const resolveStreamUrl = async (): Promise<string> => {
    const p = item.remotePath;
    if (p.startsWith("http://") || p.startsWith("https://")) return p;
    if (isLocalPath(p)) return p;
    const colon = p.indexOf(":");
    if (colon === -1) return p;
    const remoteRoot = p.slice(0, colon + 1);
    const filePath = p.slice(colon + 1).replace(/^\/+/, "");
    const res = await invoke<{ file_url: string }>("start_stream_session", {
      configPath: rcloneConfigPath || "",
      remoteRoot,
      filePath,
      sessionId: `fp-${item.id}`,
    });
    return res.file_url;
  };

  const runHashLookupWithFallback = async (hash: string, algorithm: "OSHASH" | "PHASH") => {
    setProviderErrors([]);
    if (!hasAnyProvider) {
      setStatusMessage(
        `Computed ${algorithm} (${hash}), but neither a Stash-Box provider nor a ThePornDB API key is enabled in Settings → API Keys.`
      );
      return;
    }

    const { matches: hashMatches, queriedProviders, errors } = await identifyByHash({
      hash,
      algorithm,
      provider: activeProvider,
      thePornDbApiKey,
    });
    setProviderErrors(errors);

    if (hashMatches.length > 0) {
      setMatches(hashMatches);
      setMatchOrigin(algorithm === "OSHASH" ? "oshash" : "phash");
      setStatusMessage(
        `Found ${hashMatches.length} exact ${algorithm} match(es) via ${queriedProviders.join(" + ")}.`
      );
      return;
    }

    // Automatic fallback to filename fragment search when hash returns 0 results
    const frag = parseAdultSceneFragment(item.filename || item.title);
    const fragMatches = await searchScenesByFragment(activeProvider, frag, thePornDbApiKey);
    setMatches(fragMatches);
    setMatchOrigin(fragMatches.length > 0 ? "fragment" : null);

    const phashNote =
      algorithm === "PHASH"
        ? " (Note: Visual pHash is experimental and not yet verified against Stash's reference pHash implementation.)"
        : "";

    if (fragMatches.length > 0) {
      setStatusMessage(
        `No exact ${algorithm} match on ${queriedProviders.join(" / ")}${phashNote} — showing ${fragMatches.length} filename fragment candidate(s).`
      );
    } else {
      setStatusMessage(
        `No ${algorithm} or filename fragment matches found on ${queriedProviders.join(" / ")}.${phashNote}`
      );
    }
  };

  const handleComputeOshash = async () => {
    setBusy("oshash");
    try {
      const url = await resolveStreamUrl();
      const h = await invoke<string>("compute_remote_oshash", { streamUrl: url });
      setOshash(h);
      updateItemMetadata(item.id, { oshash: h });
      await runHashLookupWithFallback(h, "OSHASH");
    } catch (err: any) {
      addToast(`OSHASH failed: ${err?.message || err}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const handleComputePhash = async () => {
    setBusy("phash");
    try {
      const url = await resolveStreamUrl();
      const h = await invoke<string>("compute_remote_phash", {
        streamUrl: url,
        durationSecs: item.duration ?? null,
      });
      setPhash(h);
      updateItemMetadata(item.id, { phash: h });
      await runHashLookupWithFallback(h, "PHASH");
    } catch (err: any) {
      addToast(`pHash failed: ${err?.message || err}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const handleFragmentSearch = async () => {
    setBusy("fragment");
    setProviderErrors([]);
    try {
      if (!hasAnyProvider) {
        setStatusMessage("Configure a Stash-Box provider or ThePornDB API key in Settings → API Keys to search.");
        return;
      }
      const frag = parseAdultSceneFragment(item.filename || item.title);
      const res = await searchScenesByFragment(activeProvider, frag, thePornDbApiKey);
      setMatches(res);
      setMatchOrigin(res.length > 0 ? "fragment" : null);
      setStatusMessage(
        res.length > 0
          ? `Found ${res.length} candidate(s) for filename fragment "${[frag.studio, frag.date, frag.title].filter(Boolean).join(" · ")}".`
          : `No scene matches found for parsed filename fragment "${frag.title}".`
      );
    } catch (err: any) {
      addToast(`Fragment search failed: ${err?.message || err}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const handleApply = (m: StashSceneMatch) => {
    const yearNum = m.date ? parseInt(m.date.slice(0, 4), 10) : undefined;
    updateItemMetadata(item.id, {
      title: m.title,
      posterUrl: m.posterUrl || item.posterUrl,
      overview: m.details || item.overview,
      studio: m.studio,
      performers: m.performers,
      genres: m.tags.length > 0 ? m.tags : item.genres,
      year: yearNum && !Number.isNaN(yearNum) ? yearNum : item.year,
      metadataSource: m.source === "theporndb" ? "theporndb" : "manual",
      metadataId: m.id,
      metadataConfidence: matchOrigin === "fragment" ? "medium" : "high",
    });
    addToast(`Applied metadata from ${m.source}: "${m.title}"`, "success");
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[10000] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Fingerprint size={18} className="text-accent" />
            <h2 className="font-display text-lg text-bright">IDENTIFY BY FINGERPRINT</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-subtle hover:text-bright hover:bg-panel">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 border-b border-border bg-panel space-y-3">
          {!hasAnyProvider && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2">
              <AlertTriangle size={14} className="shrink-0" />
              <span>No Stash-Box endpoint or ThePornDB API key is enabled. Enable one in <strong>Settings → API Keys</strong> to match scenes.</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleComputeOshash}
              disabled={Boolean(busy)}
              className="btn-primary text-xs py-2 px-3.5 flex items-center gap-1.5 disabled:opacity-50"
            >
              {busy === "oshash" ? <Loader2 size={14} className="animate-spin" /> : <Fingerprint size={14} />}
              <span>Compute OSHASH (Fast)</span>
            </button>

            {experimentalPhashEnabled && (
              <button
                type="button"
                onClick={handleComputePhash}
                disabled={Boolean(busy)}
                className="btn-secondary text-xs py-2 px-3.5 flex items-center gap-1.5 disabled:opacity-50"
              >
                {busy === "phash" ? <Loader2 size={14} className="animate-spin" /> : <Fingerprint size={14} />}
                <span>Compute Visual pHash (Experimental)</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleFragmentSearch}
              disabled={Boolean(busy)}
              className="btn-secondary text-xs py-2 px-3.5 flex items-center gap-1.5 disabled:opacity-50"
            >
              {busy === "fragment" ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              <span>Search Filename Fragment</span>
            </button>
          </div>

          {(oshash || phash) && (
            <div className="text-[11px] font-mono text-subtle flex flex-wrap gap-4">
              {oshash && <span>OSHASH: <strong className="text-bright">{oshash}</strong></span>}
              {phash && <span>pHash: <strong className="text-bright">{phash}</strong></span>}
            </div>
          )}

          {statusMessage && (
            <div className="p-2.5 rounded-lg bg-surface border border-border text-xs text-subtle flex items-start gap-2">
              <Info size={14} className="text-accent shrink-0 mt-0.5" />
              <span>{statusMessage}</span>
            </div>
          )}

          {providerErrors.length > 0 && (
            <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs space-y-1">
              {providerErrors.map((err, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <AlertTriangle size={13} className="shrink-0" />
                  <span>{err}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {matches.length === 0 ? (
            <p className="text-center text-xs text-subtle py-8">
              Compute OSHASH or run a fragment search to find matching scenes.
            </p>
          ) : (
            matches.map((m) => (
              <div key={`${m.source}-${m.id}`} className="p-3 rounded-xl bg-panel border border-border flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  {m.posterUrl && (
                    <img src={m.posterUrl} alt="" className="w-16 h-10 object-cover rounded border border-border shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-semibold text-bright truncate">{m.title}</p>
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-surface border border-border text-subtle shrink-0">
                        {m.source}
                      </span>
                    </div>
                    <p className="text-[11px] text-subtle truncate">
                      {[m.studio, m.date, m.performers.join(", ")].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleApply(m)}
                  className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1 shrink-0"
                >
                  <Check size={13} /> Apply
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
