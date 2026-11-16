import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Search, Film, Music, BookOpen, Archive, Globe, Loader2, Play, Download,
  ExternalLink, HardDrive, FileText, Check, AlertCircle, Zap, Image, ArrowUpDown, Filter,
} from "lucide-react";
import {
  searchEasynews,
  sanitizeEasynewsQuery,
  type EasynewsFileType,
  type EasynewsSortOption,
  type EasynewsSearchResult,
} from "../../lib/easynews";
import { AddStreamBookmarkModal } from "../library/AddStreamBookmarkModal";
import { useAppStore, type LibraryType } from "../../store/appStore";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  initialQuery?: string;
  initialFileType?: EasynewsFileType;
};

export function EasynewsSearchModal({
  isOpen,
  onClose,
  initialQuery = "",
  initialFileType = "video",
}: Props) {
  const { easynewsConfig } = useAppStore();
  const [query, setQuery] = useState(sanitizeEasynewsQuery(initialQuery));
  const [fileType, setFileType] = useState<EasynewsFileType>(initialFileType);
  const [sort, setSort] = useState<EasynewsSortOption>("relevance");
  const [maxSizeGb, setMaxSizeGb] = useState<number>(20);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [results, setResults] = useState<EasynewsSearchResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<EasynewsSearchResult | null>(null);

  useEffect(() => {
    if (initialQuery) {
      setQuery(sanitizeEasynewsQuery(initialQuery));
    }
  }, [initialQuery]);

  useEffect(() => {
    if (isOpen && query.trim() && easynewsConfig?.username && easynewsConfig?.password) {
      handleSearch();
    }
  }, [isOpen, fileType, sort, maxSizeGb]);

  const handleSearch = async (targetQuery?: string) => {
    const q = (targetQuery ?? query).trim();
    if (!q) return;

    setLoading(true);
    setErrorMsg("");
    try {
      const data = await searchEasynews(q, fileType, sort, maxSizeGb);
      setResults(data.results);
      if (data.results.length === 0) {
        setErrorMsg(`No results found for "${q}" in ${fileType}.`);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || "Failed to search Easynews.");
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const isConfigured = Boolean(easynewsConfig?.username?.trim() && easynewsConfig?.password?.trim());

  return (
    <>
      <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 14 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 14 }}
          className="bg-surface border border-border rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0 bg-panel/40">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
                <Globe size={18} />
              </div>
              <div>
                <h2 className="font-heading font-semibold text-bright text-base leading-tight">
                  Easynews Multi-Type Search
                </h2>
                <p className="text-subtle text-xs font-body">
                  Search &amp; direct-stream videos, audio, books, and archives directly into RcloneFlix.
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

          {/* Search bar & Type tabs */}
          <div className="p-5 border-b border-border bg-panel/20 space-y-3 flex-shrink-0">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder="Search titles, artist, author, or release name..."
                  className="input-field pl-10 w-full text-sm font-body"
                  autoFocus
                />
              </div>
              <button
                onClick={() => handleSearch()}
                disabled={loading || !query.trim() || !isConfigured}
                className="btn-primary px-5 flex items-center gap-2 text-sm disabled:opacity-50"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                <span>Search</span>
              </button>
            </div>

            {/* Type Tabs */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              <button
                type="button"
                onClick={() => setFileType("video")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  fileType === "video"
                    ? "bg-accent text-void font-semibold"
                    : "bg-panel text-subtle hover:text-text border border-border"
                }`}
              >
                <Film size={13} />
                <span>Video (Movies/TV)</span>
              </button>
              <button
                type="button"
                onClick={() => setFileType("audio")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  fileType === "audio"
                    ? "bg-accent text-void font-semibold"
                    : "bg-panel text-subtle hover:text-text border border-border"
                }`}
              >
                <Music size={13} />
                <span>Audio (Music/Audiobooks)</span>
              </button>
              <button
                type="button"
                onClick={() => setFileType("document")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  fileType === "document"
                    ? "bg-accent text-void font-semibold"
                    : "bg-panel text-subtle hover:text-text border border-border"
                }`}
              >
                <BookOpen size={13} />
                <span>Books (PDF/EPUB)</span>
              </button>
              <button
                type="button"
                onClick={() => setFileType("photo")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  fileType === "photo"
                    ? "bg-accent text-void font-semibold"
                    : "bg-panel text-subtle hover:text-text border border-border"
                }`}
              >
                <Image size={13} />
                <span>Photos &amp; Images</span>
              </button>
              <button
                type="button"
                onClick={() => setFileType("archive")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  fileType === "archive"
                    ? "bg-accent text-void font-semibold"
                    : "bg-panel text-subtle hover:text-text border border-border"
                }`}
              >
                <Archive size={13} />
                <span>Archives (ZIP/RAR)</span>
              </button>
              <button
                type="button"
                onClick={() => setFileType("all")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  fileType === "all"
                    ? "bg-accent text-void font-semibold"
                    : "bg-panel text-subtle hover:text-text border border-border"
                }`}
              >
                <Globe size={13} />
                <span>All Files</span>
              </button>
            </div>

            {/* Sort & Max Size Controls */}
            <div className="flex items-center justify-between gap-3 pt-1 flex-wrap text-xs text-subtle border-t border-border/40">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 font-medium">
                  <ArrowUpDown size={12} className="text-accent" />
                  <span>Sort By:</span>
                </span>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as EasynewsSortOption)}
                  className="bg-panel border border-border text-text rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:border-accent"
                >
                  <option value="relevance">Relevance (Smart Match)</option>
                  <option value="dtime_desc">Newest First (Recent)</option>
                  <option value="dtime_asc">Oldest First</option>
                  <option value="dsize_asc">Smallest File Size</option>
                  <option value="dsize_desc">Largest File Size</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 font-medium">
                  <Filter size={12} className="text-accent" />
                  <span>Max File Size:</span>
                </span>
                <select
                  value={maxSizeGb}
                  onChange={(e) => setMaxSizeGb(Number(e.target.value))}
                  className="bg-panel border border-border text-text rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:border-accent"
                >
                  <option value={20}>&lt; 20 GB (Recommended)</option>
                  <option value={10}>&lt; 10 GB (Fastest)</option>
                  <option value={5}>&lt; 5 GB (Low Bandwidth)</option>
                  <option value={2}>&lt; 2 GB (Compact)</option>
                  <option value={0}>Unlimited (Any Size)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Results list */}
          <div className="flex-1 overflow-y-auto p-5">
            {!isConfigured && (
              <div className="p-8 text-center text-subtle space-y-3">
                <AlertCircle size={24} className="mx-auto text-amber-400" />
                <p className="text-text font-medium text-sm">Easynews Credentials Required</p>
                <p className="text-xs max-w-sm mx-auto">
                  Please configure your Easynews account username and password in Settings to enable direct cloud searching.
                </p>
              </div>
            )}

            {isConfigured && results.length === 0 && !loading && (
              <div className="py-12 text-center text-subtle space-y-2">
                <p className="text-sm font-medium">
                  {errorMsg || "Enter search terms above to query Easynews."}
                </p>
                <p className="text-xs">
                  Tip: Filter by Video, Audio, Books, or Archives using the tabs above.
                </p>
              </div>
            )}

            {results.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs text-subtle px-1 mb-2">
                  Showing {results.length} result{results.length !== 1 ? "s" : ""}
                </div>

                {results.map((res) => (
                  <div
                    key={res.id + res.filename}
                    onClick={() => setSelectedResult(res)}
                    className="p-3.5 rounded-xl bg-panel/50 hover:bg-panel border border-border hover:border-accent/40 transition-all cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-semibold text-text group-hover:text-accent transition-colors truncate max-w-md">
                          {res.filename}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-surface border border-border text-[10px] font-mono uppercase text-subtle font-medium">
                          {res.extension}
                        </span>
                        {res.resolution && (
                          <span className="px-1.5 py-0.5 rounded bg-accent/15 border border-accent/30 text-[10px] font-mono text-accent font-semibold">
                            {res.resolution}
                          </span>
                        )}
                        {res.codec && (
                          <span className="px-1.5 py-0.5 rounded bg-surface border border-border text-[10px] font-mono text-subtle">
                            {res.codec}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-xs text-subtle font-body">
                        <span>{res.sizeFormatted}</span>
                        {res.durationFormatted && (
                          <>
                            <span>·</span>
                            <span>{res.durationFormatted}</span>
                          </>
                        )}
                        {res.postDate && (
                          <>
                            <span>·</span>
                            <span>{new Date(res.postDate * 1000).toLocaleDateString()}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedResult(res);
                        }}
                        className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                      >
                        <Play size={13} fill="currentColor" />
                        <span>Action Menu</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </div>

      {/* Selected Action Modal via AddStreamBookmarkModal */}
      {selectedResult && (
        <AddStreamBookmarkModal
          isOpen={true}
          onClose={() => setSelectedResult(null)}
          initialUrl={selectedResult.dlUrl}
          initialTitle={selectedResult.filename}
          defaultLibraryType={
            selectedResult.mediaType === "audio"
              ? "music"
              : selectedResult.mediaType === "document"
              ? "books"
              : selectedResult.mediaType === "photo"
              ? "photos"
              : "movies"
          }
          autoInspect={true}
        />
      )}
    </>
  );
}
