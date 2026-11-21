import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  X, Search, Radio, Play, Bookmark, Loader2, AlertCircle, HardDrive,
  Calendar, Layers, Filter, Check, ExternalLink, ChevronDown, ChevronUp,
  FolderOpen, Copy, Download, MoreHorizontal, Zap,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { useAppStore, type MediaItem } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { AddStreamBookmarkModal } from "../library/AddStreamBookmarkModal";
import { CloudTransferModal } from "../explorer/CloudTransferModal";
import { CloudTranscodeModal } from "../library/CloudTranscodeModal";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  initialQuery?: string;
  item?: MediaItem | null;
};

type UsenetSearchResult = {
  title: string;
  nzb_url: string;
  size_bytes: number;
  published_at?: string;
  age_days?: number;
  indexer: string;
  category?: string;
  id?: string;
};

type IndexerHealth = {
  name: string;
  active: boolean;
  hits: number;
  error?: string;
};

type NzbPlayable = { name: string; size: number; kind: string; virtual_path?: string | null };

/** Build the /dav/ stream URL for a mounted member, preferring its category path
 *  ("TV Shows/Show/Season 1/file.mkv") and percent-encoding per path segment. */
const davStreamUrl = (p: { name: string; virtual_path?: string | null }): string =>
  `http://127.0.0.1:8553/dav/${(p.virtual_path || p.name)
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

/** Derive the InfiniDysk category folder for a release so it mounts into the
 *  NZBDav-style hierarchy (/TV Shows/<Show>/Season N, /Movies, /Uncategorized, …). */
function deriveVirtualDir(title: string, libraryType?: string | null): string {
  const clean = (s: string) =>
    s.replace(/[._]+/g, " ").replace(/[\\/:]/g, "-").replace(/\s+/g, " ").trim();
  const m = title.match(/^(.+?)[. _-]+S(\d{1,2})\s*[. _-]*E\d{1,3}/i);
  if (m) return `TV Shows/${clean(m[1])}/Season ${parseInt(m[2], 10)}`;
  if (libraryType === "tv") return `TV Shows/${clean(title)}`;
  if (libraryType === "movies") return "Movies";
  if (libraryType === "music") return "Music";
  if (libraryType === "music_videos") return "Music Videos";
  if (libraryType === "audiobooks") return "Audiobooks";
  if (libraryType === "adult") return "Adult";
  if (libraryType === "comics" || libraryType === "books") return "Books";
  return "Uncategorized";
}

export function InfiniDyskSearchModal({
  isOpen,
  onClose,
  initialQuery = "",
  item,
}: Props) {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);

  const [query, setQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [results, setResults] = useState<UsenetSearchResult[]>([]);
  const [indexerHealth, setIndexerHealth] = useState<IndexerHealth[]>([]);
  const [ingestingUrl, setIngestingUrl] = useState<string | null>(null);
  const [bookmarkTarget, setBookmarkTarget] = useState<{ url: string; title: string } | null>(null);
  const [expandedNzb, setExpandedNzb] = useState<string | null>(null);
  const [nzbFilesMap, setNzbFilesMap] = useState<Record<string, NzbPlayable[]>>({});
  const [loadingFilesUrl, setLoadingFilesUrl] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<{ url: string; title: string } | null>(null);
  const [transcodeTarget, setTranscodeTarget] = useState<{ url: string; title: string } | null>(null);
  const [activeMenuUrl, setActiveMenuUrl] = useState<string | null>(null);
  const [categoryOverride, setCategoryOverride] = useState<string>(item?.libraryType || "uncategorized");

  const resolvedCategoryType = item?.libraryType || (categoryOverride === "uncategorized" ? null : categoryOverride);

  const toggleNzbFiles = async (nzb: UsenetSearchResult) => {
    if (expandedNzb === nzb.nzb_url) {
      setExpandedNzb(null);
      return;
    }

    setExpandedNzb(nzb.nzb_url);
    if (nzbFilesMap[nzb.nzb_url]) return;

    setLoadingFilesUrl(nzb.nzb_url);
    try {
      const playables = await invoke<NzbPlayable[]>(
        "parse_nzb_media_files",
        { nzbUrl: nzb.nzb_url, nzbXml: null, password: null, virtualDir: deriveVirtualDir(nzb.title, resolvedCategoryType) }
      );
      setNzbFilesMap((prev) => ({ ...prev, [nzb.nzb_url]: playables || [] }));
    } catch (err: any) {
      addToast(`Could not load files: ${err?.message || err}`, "error");
    } finally {
      setLoadingFilesUrl(null);
    }
  };

  useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
    }
  }, [initialQuery]);

  useEffect(() => {
    if (isOpen && query.trim()) {
      handleSearch();
    }
  }, [isOpen]);

  const handleSearch = async (targetQuery?: string) => {
    const q = (targetQuery ?? query).trim();
    if (!q) return;

    setLoading(true);
    setErrorMsg("");
    try {
      const omgUser = typeof window !== "undefined" ? localStorage.getItem("rcloneflix_omg_user") : null;
      const omgApiKey = typeof window !== "undefined" ? localStorage.getItem("rcloneflix_omg_key") : null;

      const res = await invoke<{ results: UsenetSearchResult[]; indexers: IndexerHealth[] }>(
        "search_usenet_indexers",
        {
          query: q,
          omgUser: omgUser?.trim() || null,
          omgApiKey: omgApiKey?.trim() || null,
          enableNzbindex: true,
        }
      );

      setResults(res?.results ?? []);
      setIndexerHealth(res?.indexers ?? []);
      if (!res?.results || res.results.length === 0) {
        setErrorMsg(`No Usenet releases found for "${q}".`);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || String(err) || "Failed to search Usenet indexers.");
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handlePlayNzb = async (nzb: UsenetSearchResult) => {
    setIngestingUrl(nzb.nzb_url);
    try {
      const playables = await invoke<NzbPlayable[]>(
        "parse_nzb_media_files",
        {
          nzbUrl: nzb.nzb_url,
          nzbXml: null,
          password: null,
          virtualDir: deriveVirtualDir(nzb.title, resolvedCategoryType),
        }
      );

      if (!playables || playables.length === 0) {
        addToast("No playable media files found inside this NZB release", "error");
        return;
      }

      const best = [...playables].sort((a, b) => b.size - a.size)[0];
      const streamUrl = davStreamUrl(best);

      const now = Date.now();
      const playItem: MediaItem = {
        ...(item || {} as MediaItem),
        id: item?.id || `usenet-${now}`,
        libraryId: item?.libraryId || "usenet",
        libraryType: item?.libraryType || "movies",
        title: item?.title || nzb.title,
        filename: best.name,
        remotePath: streamUrl,
        streamUrl,
        sourceUrl: streamUrl,
        addedAt: item?.addedAt || now,
        lastScannedAt: item?.lastScannedAt || now,
        isSourceBookmark: true,
      };

      onClose();
      navigate("/play/video", { state: { item: playItem } });
    } catch (err: any) {
      addToast(`Failed to parse/play NZB: ${err?.message || err}`, "error");
    } finally {
      setIngestingUrl(null);
    }
  };

  const handleBookmarkNzb = async (nzb: UsenetSearchResult) => {
    setIngestingUrl(nzb.nzb_url);
    try {
      const playables = await invoke<NzbPlayable[]>(
        "parse_nzb_media_files",
        {
          nzbUrl: nzb.nzb_url,
          nzbXml: null,
          password: null,
          virtualDir: deriveVirtualDir(nzb.title, resolvedCategoryType),
        }
      );

      if (!playables || playables.length === 0) {
        addToast("No playable media files found inside this NZB release", "error");
        return;
      }

      const best = [...playables].sort((a, b) => b.size - a.size)[0];
      const streamUrl = davStreamUrl(best);
      setBookmarkTarget({ url: streamUrl, title: nzb.title || best.name });
    } catch (err: any) {
      addToast(`Failed to prepare bookmark: ${err?.message || err}`, "error");
    } finally {
      setIngestingUrl(null);
    }
  };

  const formatSize = (bytes: number) => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-void z-50 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 14 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 14 }}
          className="bg-surface border border-border rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0 bg-panel">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                <Radio size={18} />
              </div>
              <div>
                <h2 className="font-heading font-semibold text-bright text-base leading-tight">
                  InfiniDysk Usenet Search
                </h2>
                <p className="text-subtle text-xs font-body">
                  Decade-long retention Usenet discovery via NZBIndex &amp; OMGWTFNZBs with direct WebDAV streaming.
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-subtle hover:text-text hover:bg-surface transition-colors cursor-pointer"
            >
              <X size={18} />
            </button>
          </div>

          {/* Search bar */}
          <div className="p-4 border-b border-border bg-panel flex items-center gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder="Search Usenet releases (e.g. Movie 1080p, Show S01E01)..."
                className="w-full bg-surface border border-border rounded-xl pl-10 pr-4 py-2 text-sm text-text placeholder:text-subtle focus:outline-none focus:border-cyan-400 transition-colors"
              />
            </div>
            {!item?.libraryType && (
              <select
                value={categoryOverride}
                onChange={(e) => setCategoryOverride(e.target.value)}
                title="Target InfiniDysk folder category"
                className="bg-surface border border-border rounded-xl px-3 py-2 text-xs text-text focus:outline-none focus:border-cyan-400"
              >
                <option value="uncategorized">Uncategorized</option>
                <option value="movies">Movies</option>
                <option value="tv">TV Shows</option>
                <option value="music">Music</option>
                <option value="music_videos">Music Videos</option>
                <option value="adult">Adult</option>
                <option value="books">Books</option>
                <option value="audiobooks">Audiobooks</option>
              </select>
            )}
            <button
              onClick={() => handleSearch()}
              disabled={loading || !query.trim()}
              className="px-4 py-2 rounded-xl bg-cyan-500 text-void font-semibold text-xs flex items-center gap-2 hover:bg-cyan-400 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              <span>Search</span>
            </button>
          </div>

          {/* Indexer Status Strip */}
          {indexerHealth.length > 0 && (
            <div className="px-6 py-2 bg-surface border-b border-border flex items-center gap-4 text-xs font-mono">
              <span className="text-subtle">Indexers:</span>
              {indexerHealth.map((idx) => (
                <span
                  key={idx.name}
                  className={`flex items-center gap-1.5 ${idx.active ? "text-cyan-400" : "text-subtle"}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${idx.active ? "bg-cyan-400" : "bg-rose-500"}`} />
                  {idx.name}: {idx.hits} releases
                </span>
              ))}
            </div>
          )}

          {/* Results List */}
          <div className="flex-1 overflow-y-auto p-5 bg-void">
            {loading && (
              <div className="py-16 text-center text-subtle space-y-3">
                <Loader2 size={24} className="animate-spin mx-auto text-cyan-400" />
                <p className="text-sm">Querying Usenet indexers &amp; NNTP headers...</p>
              </div>
            )}

            {!loading && results.length === 0 && (
              <div className="py-16 text-center text-subtle space-y-2">
                <AlertCircle size={24} className="mx-auto text-cyan-400/60" />
                <p className="text-sm font-medium">
                  {errorMsg || "Enter search terms above to query Usenet indexers."}
                </p>
                <p className="text-xs">
                  Tip: Make sure InfiniDysk NNTP server is enabled in Settings &rarr; InfiniDysk.
                </p>
              </div>
            )}

            {!loading && results.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs text-subtle px-1 mb-2 font-mono">
                  Showing {results.length} release{results.length !== 1 ? "s" : ""}
                </div>

                {results.map((res, i) => {
                  const isIngesting = ingestingUrl === res.nzb_url;
                  const isExpanded = expandedNzb === res.nzb_url;
                  const files = nzbFilesMap[res.nzb_url];
                  const isLoadingFiles = loadingFilesUrl === res.nzb_url;
                  const isMenuOpen = activeMenuUrl === res.nzb_url;

                  return (
                    <div
                      key={res.nzb_url + i}
                      className="rounded-xl bg-panel border border-border hover:border-cyan-500/40 transition-all flex flex-col group overflow-hidden"
                    >
                      <div className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs font-semibold text-text group-hover:text-cyan-400 transition-colors truncate max-w-lg">
                              {res.title}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-surface border border-border text-[10px] font-mono text-cyan-300 font-semibold uppercase">
                              {res.indexer}
                            </span>
                          </div>

                          <div className="flex items-center gap-3 text-xs text-subtle font-mono">
                            <span>{formatSize(res.size_bytes)}</span>
                            {res.published_at ? (
                              <>
                                <span>&middot;</span>
                                <span>{res.published_at}</span>
                              </>
                            ) : res.age_days !== undefined ? (
                              <>
                                <span>&middot;</span>
                                <span>{res.age_days}d ago</span>
                              </>
                            ) : null}
                            {res.category && (
                              <>
                                <span>&middot;</span>
                                <span>{res.category}</span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Search Action Suite: Files / Save-Convert / Stream / More Menu */}
                        <div className="flex items-center gap-1.5 shrink-0 relative">
                          <button
                            type="button"
                            onClick={() => toggleNzbFiles(res)}
                            className="px-2.5 py-1.5 rounded-lg border border-border bg-surface hover:bg-panel text-subtle hover:text-text text-xs flex items-center gap-1 transition-colors cursor-pointer"
                            title="Inspect multi-file release hierarchy"
                          >
                            <FolderOpen size={13} />
                            <span>Files</span>
                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          </button>

                          <button
                            type="button"
                            onClick={() => setTranscodeTarget({ url: res.nzb_url, title: res.title })}
                            className="px-2.5 py-1.5 rounded-lg border border-border bg-surface hover:bg-panel text-amber-400 hover:border-amber-500/40 text-xs flex items-center gap-1 transition-colors cursor-pointer"
                            title="Save / Transcode via Cloud Worker to your remote"
                          >
                            <Zap size={13} />
                            <span>Save/Convert</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handlePlayNzb(res)}
                            disabled={isIngesting}
                            className="px-3 py-1.5 rounded-lg bg-cyan-500 text-void font-semibold text-xs flex items-center gap-1.5 hover:bg-cyan-400 transition-colors cursor-pointer"
                          >
                            {isIngesting ? (
                              <>
                                <Loader2 size={13} className="animate-spin" />
                                <span>Mounting...</span>
                              </>
                            ) : (
                              <>
                                <Play size={13} fill="currentColor" />
                                <span>Stream</span>
                              </>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => setActiveMenuUrl(isMenuOpen ? null : res.nzb_url)}
                            className="p-1.5 rounded-lg border border-border bg-surface hover:bg-panel text-subtle hover:text-text cursor-pointer"
                            title="More Actions"
                          >
                            <MoreHorizontal size={14} />
                          </button>

                          {/* Dropdown Menu */}
                          {isMenuOpen && (
                            <div className="absolute right-0 top-9 z-30 w-44 rounded-xl bg-panel border border-border shadow-2xl py-1 text-xs text-text">
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuUrl(null);
                                  handleBookmarkNzb(res);
                                }}
                                className="w-full px-3 py-2 text-left hover:bg-surface flex items-center gap-2 cursor-pointer"
                              >
                                <Bookmark size={13} />
                                <span>Bookmark Stream</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuUrl(null);
                                  setTransferTarget({ url: res.nzb_url, title: res.title });
                                }}
                                className="w-full px-3 py-2 text-left hover:bg-surface flex items-center gap-2 cursor-pointer"
                              >
                                <HardDrive size={13} />
                                <span>Transfer via Worker</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuUrl(null);
                                  navigator.clipboard.writeText(res.nzb_url);
                                  addToast("Copied NZB link to clipboard", "success");
                                }}
                                className="w-full px-3 py-2 text-left hover:bg-surface flex items-center gap-2 cursor-pointer"
                              >
                                <Copy size={13} />
                                <span>Copy NZB Link</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Multi-File Accordion */}
                      {isExpanded && (
                        <div className="border-t border-border/60 bg-surface/40 p-3 space-y-1.5">
                          {isLoadingFiles ? (
                            <div className="py-4 flex items-center justify-center gap-2 text-xs text-subtle font-mono">
                              <Loader2 size={14} className="animate-spin text-cyan-400" />
                              <span>Parsing files inside NZB archive...</span>
                            </div>
                          ) : files && files.length > 0 ? (
                            <div className="space-y-1">
                              <div className="text-[10px] uppercase font-mono text-subtle/80 tracking-wider mb-1">
                                {files.length} playable file{files.length !== 1 ? "s" : ""} inside release:
                              </div>
                              {files.map((f, fIdx) => {
                                const fileStreamUrl = davStreamUrl(f);
                                return (
                                  <div
                                    key={f.name + fIdx}
                                    className="flex items-center justify-between p-2 rounded-lg bg-panel/60 border border-border/40 text-xs"
                                  >
                                    <div className="min-w-0 flex-1 truncate pr-2">
                                      <p className="truncate font-mono text-text/90">{f.name}</p>
                                      <span className="text-[10px] text-subtle font-mono">{formatSize(f.size)}</span>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const now = Date.now();
                                          const playItem: MediaItem = {
                                            ...(item || {} as MediaItem),
                                            id: `usenet-file-${now}`,
                                            libraryId: "usenet",
                                            libraryType: (f.kind === "audio" ? "music" : "movies") as any,
                                            title: f.name,
                                            filename: f.name,
                                            remotePath: fileStreamUrl,
                                            streamUrl: fileStreamUrl,
                                            sourceUrl: fileStreamUrl,
                                            addedAt: now,
                                            lastScannedAt: now,
                                            isSourceBookmark: true,
                                          };
                                          onClose();
                                          navigate(f.kind === "audio" ? "/play/audio" : "/play/video", { state: { item: playItem } });
                                        }}
                                        className="p-1.5 rounded-lg bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 cursor-pointer"
                                        title="Play this file"
                                      >
                                        <Play size={12} fill="currentColor" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setTranscodeTarget({ url: fileStreamUrl, title: f.name })}
                                        className="p-1.5 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 cursor-pointer"
                                        title="Save / Convert this file"
                                      >
                                        <Zap size={12} />
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="py-2 text-center text-xs text-subtle">
                              No playable media tracks detected in this NZB.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </motion.div>
      </div>

      {bookmarkTarget && (
        <AddStreamBookmarkModal
          isOpen={true}
          onClose={() => setBookmarkTarget(null)}
          initialUrl={bookmarkTarget.url}
          initialTitle={bookmarkTarget.title}
          defaultLibraryType="movies"
          autoInspect={true}
        />
      )}

      {transcodeTarget && (
        <CloudTranscodeModal
          isOpen={true}
          onClose={() => setTranscodeTarget(null)}
          sourceInput={transcodeTarget.url}
          initialTitle={transcodeTarget.title}
        />
      )}

      {transferTarget && (
        <CloudTransferModal
          isOpen={true}
          onClose={() => setTransferTarget(null)}
          sourceRemote=""
          sourcePath=""
          initialUrlMode={true}
          initialDirectUrl={transferTarget.url}
        />
      )}
    </>
  );
}
