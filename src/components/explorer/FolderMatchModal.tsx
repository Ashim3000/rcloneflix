import { useState, useEffect, useMemo, useCallback } from "react";
import packageJson from "../../../package.json";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Search,
  Sparkles,
  Tv,
  Music,
  BookOpen,
  Film,
  Check,
  Loader2,
  Folder,
  AlertCircle,
  HardDrive,
} from "lucide-react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore, type LibraryType, type MediaItem } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import {
  tvFolderSeriesCache,
  musicFolderAlbumCache,
  bookFolderAlbumCache,
} from "../../lib/scanner";
import { persistItems } from "../../lib/libraryDb";

export interface FolderMatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  folderPath: string;
  folderName: string;
  defaultCategory?: LibraryType;
  onMatchApplied?: (folderPath: string, matchedTitle: string) => void;
}

interface MatchCandidate {
  id: string;
  title: string;
  year?: number;
  posterUrl?: string;
  backdropUrl?: string;
  overview?: string;
  genres?: string[];
  creator?: string; // artist or author
  source: "cinemeta" | "tmdb" | "deezer" | "itunes" | "musicbrainz" | "openlibrary" | "googlebooks";
  rawMeta?: any;
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response | null> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url as any, init as any);
      return res as unknown as Response;
    } catch {
      // Fallback to fetch
    }
  }
  try {
    const res = await fetch(url, init);
    return res;
  } catch {
    return null;
  }
}

function cleanFolderQuery(name: string): string {
  return name
    .replace(/[[(](19\d\d|20\d\d)[\])]/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/\b(1080p|720p|2160p|4k|uhd|hdr|web[-.]?dl|bluray|x264|x265|hevc|remux)\b.*/gi, "")
    .replace(/[_.]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function FolderMatchModal({
  isOpen,
  onClose,
  folderPath,
  folderName,
  defaultCategory = "tv",
  onMatchApplied,
}: FolderMatchModalProps) {
  const { mediaItems, bulkUpsertMediaItems, tmdbApiKey } = useAppStore();
  const addToast = useToastStore((s) => s.addToast);

  const [category, setCategory] = useState<LibraryType>(defaultCategory);
  const [query, setQuery] = useState(() => cleanFolderQuery(folderName));
  const [results, setResults] = useState<MatchCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<MatchCandidate | null>(null);
  const [applying, setApplying] = useState(false);

  // When folderName changes, update query
  useEffect(() => {
    if (folderName) {
      setQuery(cleanFolderQuery(folderName));
      setSelectedCandidate(null);
      setResults([]);
    }
  }, [folderName]);

  // Find matching items in library that belong to this folder
  const matchingLibraryItems = useMemo(() => {
    if (!folderPath) return [];
    const normalizedTarget = folderPath.replace(/\\/g, "/").toLowerCase();
    return Object.values(mediaItems).filter((item) => {
      if (!item.remotePath) return false;
      const normalizedItem = item.remotePath.replace(/\\/g, "/").toLowerCase();
      return (
        normalizedItem.startsWith(normalizedTarget + "/") ||
        normalizedItem === normalizedTarget ||
        normalizedItem.includes("/" + folderName.toLowerCase() + "/")
      );
    });
  }, [mediaItems, folderPath, folderName]);

  const searchMetadata = useCallback(
    async (searchTerm: string, cat: LibraryType) => {
      const q = searchTerm.trim();
      if (!q) return;
      setLoading(true);
      setResults([]);
      setSelectedCandidate(null);

      const found: MatchCandidate[] = [];

      try {
        if (cat === "tv") {
          // 1. Cinemeta Series
          const res = await safeFetch(
            `https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(q)}.json`
          );
          if (res && res.ok) {
            const data = await res.json();
            for (const m of (data.metas || []).slice(0, 8)) {
              const rawYear = m.year || m.releaseInfo;
              const y = rawYear ? parseInt(String(rawYear).split("-")[0], 10) : undefined;
              found.push({
                id: m.id,
                title: m.name ?? q,
                year: isNaN(y as number) ? undefined : y,
                posterUrl: m.poster,
                backdropUrl: m.background,
                overview: m.description,
                genres: m.genres,
                source: "cinemeta",
              });
            }
          }

          // 2. TMDB TV fallback/addition
          if (tmdbApiKey && found.length < 5) {
            const tmdbRes = await safeFetch(
              `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(q)}&language=en-US&page=1`,
              { headers: { Authorization: `Bearer ${tmdbApiKey}` } }
            );
            if (tmdbRes && tmdbRes.ok) {
              const tmdbData = await tmdbRes.json();
              for (const r of (tmdbData.results || []).slice(0, 5)) {
                if (found.some((f) => f.title.toLowerCase() === r.name?.toLowerCase())) continue;
                found.push({
                  id: `tmdb:${r.id}`,
                  title: r.name ?? q,
                  year: r.first_air_date ? parseInt(r.first_air_date.split("-")[0], 10) : undefined,
                  posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : undefined,
                  backdropUrl: r.backdrop_path ? `https://image.tmdb.org/t/p/w780${r.backdrop_path}` : undefined,
                  overview: r.overview,
                  source: "tmdb",
                });
              }
            }
          }
        } else if (cat === "music") {
          // 1. iTunes Search API (fast, comprehensive, high-res artwork, CORS-free)
          try {
            const itunesRes = await safeFetch(
              `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&limit=10`
            );
            if (itunesRes && itunesRes.ok) {
              const itunesData = await itunesRes.json();
              for (const r of itunesData.results || []) {
                const year = r.releaseDate ? parseInt(r.releaseDate.split("-")[0], 10) : undefined;
                const posterUrl = r.artworkUrl100
                  ? r.artworkUrl100.replace("100x100bb.jpg", "600x600bb.jpg")
                  : undefined;
                found.push({
                  id: `itunes:${r.collectionId}`,
                  title: r.collectionName,
                  creator: r.artistName,
                  year: isNaN(year as number) ? undefined : year,
                  posterUrl,
                  genres: r.primaryGenreName ? [r.primaryGenreName] : undefined,
                  source: "itunes",
                });
              }
            }
          } catch (e) {
            console.warn("iTunes album search failed:", e);
          }

          // 2. Deezer Albums via native Tauri HTTP
          try {
            const res = await safeFetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(q)}`);
            if (res && res.ok) {
              const data = await res.json();
              for (const alb of (data.data || []).slice(0, 8)) {
                if (found.some((f) => f.title.toLowerCase() === alb.title?.toLowerCase())) continue;
                found.push({
                  id: `deezer:${alb.id}`,
                  title: alb.title,
                  creator: alb.artist?.name,
                  posterUrl: alb.cover_xl || alb.cover_big || alb.cover_medium,
                  source: "deezer",
                });
              }
            }
          } catch (e) {
            console.warn("Deezer album search failed:", e);
          }

          // 3. MusicBrainz Release fallback if few results
          if (found.length < 3) {
            try {
              const mbRes = await safeFetch(
                `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(q)}&fmt=json&limit=5`,
                { headers: { "User-Agent": `RcloneFlix/${packageJson.version} (https://github.com/rcloneflix)` } }
              );
              if (mbRes && mbRes.ok) {
                const mbData = await mbRes.json();
                for (const rel of mbData.releases || []) {
                  if (found.some((f) => f.title.toLowerCase() === rel.title?.toLowerCase())) continue;
                  const artist = rel["artist-credit"]?.[0]?.name || rel["artist-credit"]?.[0]?.artist?.name;
                  const dateStr = rel.date || "";
                  const y = dateStr ? parseInt(dateStr.split("-")[0], 10) : undefined;
                  found.push({
                    id: `mb:${rel.id}`,
                    title: rel.title,
                    creator: artist,
                    year: isNaN(y as number) ? undefined : y,
                    posterUrl: `https://coverartarchive.org/release/${rel.id}/front-500`,
                    source: "musicbrainz",
                  });
                }
              }
            } catch (e) {
              console.warn("MusicBrainz album search failed:", e);
            }
          }
        } else if (cat === "books" || cat === "audiobooks") {
          // OpenLibrary
          const res = await safeFetch(
            `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=8`
          );
          if (res && res.ok) {
            const data = await res.json();
            for (const doc of (data.docs || []).slice(0, 8)) {
              const coverUrl = doc.cover_i
                ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
                : undefined;
              found.push({
                id: doc.key || doc.edition_key?.[0] || doc.title,
                title: doc.title,
                creator: doc.author_name?.[0],
                year: doc.first_publish_year,
                posterUrl: coverUrl,
                overview: Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : undefined,
                source: "openlibrary",
              });
            }
          }

          // Fallback Google Books
          if (found.length < 3) {
            const gbRes = await safeFetch(
              `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5`
            );
            if (gbRes && gbRes.ok) {
              const gbData = await gbRes.json();
              for (const it of gbData.items || []) {
                const vi = it.volumeInfo || {};
                const cover = vi.imageLinks?.thumbnail?.replace("http://", "https://");
                found.push({
                  id: `gb:${it.id}`,
                  title: vi.title ?? q,
                  creator: vi.authors?.[0],
                  year: vi.publishedDate ? parseInt(vi.publishedDate.split("-")[0], 10) : undefined,
                  posterUrl: cover,
                  overview: vi.description,
                  source: "googlebooks",
                });
              }
            }
          }
        } else if (cat === "movies") {
          // Cinemeta Movies
          const res = await safeFetch(
            `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(q)}.json`
          );
          if (res && res.ok) {
            const data = await res.json();
            for (const m of (data.metas || []).slice(0, 8)) {
              const rawYear = m.year || m.releaseInfo;
              const y = rawYear ? parseInt(String(rawYear).split("-")[0], 10) : undefined;
              found.push({
                id: m.id,
                title: m.name ?? q,
                year: isNaN(y as number) ? undefined : y,
                posterUrl: m.poster,
                backdropUrl: m.background,
                overview: m.description,
                genres: m.genres,
                source: "cinemeta",
              });
            }
          }
        }
      } catch (err: any) {
        console.error("FolderMatch error:", err);
      } finally {
        setResults(found);
        setLoading(false);
      }
    },
    [tmdbApiKey]
  );

  // Trigger search on modal open or category change
  useEffect(() => {
    if (isOpen && query.trim()) {
      searchMetadata(query, category);
    }
  }, [isOpen, category]);

  const handleApplyMatch = async () => {
    if (!selectedCandidate) return;
    setApplying(true);

    try {
      // 1. Populate folder caches for background scanner consistency
      if (category === "tv") {
        tvFolderSeriesCache.set(folderPath, {
          showTitle: selectedCandidate.title,
          showId: selectedCandidate.id,
          showPosterUrl: selectedCandidate.posterUrl,
          showBackdropUrl: selectedCandidate.backdropUrl,
          showOverview: selectedCandidate.overview,
          year: selectedCandidate.year,
          genres: selectedCandidate.genres,
          metadataId: selectedCandidate.id,
          metadataSource: selectedCandidate.source === "cinemeta" ? "cinemeta" : "tmdb",
          metadataConfidence: "high",
        });
      } else if (category === "music") {
        musicFolderAlbumCache.set(folderPath, {
          album: selectedCandidate.title,
          artist: selectedCandidate.creator,
          posterUrl: selectedCandidate.posterUrl,
          year: selectedCandidate.year,
          genres: selectedCandidate.genres,
          metadataId: selectedCandidate.id,
          metadataSource: selectedCandidate.source === "deezer" ? "deezer" : "musicbrainz",
        });
      } else if (category === "books" || category === "audiobooks") {
        bookFolderAlbumCache.set(folderPath, {
          title: selectedCandidate.title,
          album: selectedCandidate.title,
          author: selectedCandidate.creator,
          artist: selectedCandidate.creator,
          posterUrl: selectedCandidate.posterUrl,
          year: selectedCandidate.year,
          overview: selectedCandidate.overview,
          genres: selectedCandidate.genres,
          metadataId: selectedCandidate.id,
          metadataSource: "openlibrary",
        });
      }

      // 2. Fetch series detail from Cinemeta if it's TV to get all episode titles/thumbnails
      let cinemetaEpisodes: any[] = [];
      if (category === "tv" && selectedCandidate.source === "cinemeta" && selectedCandidate.id) {
        try {
          const detailRes = await safeFetch(
            `https://v3-cinemeta.strem.io/meta/series/${selectedCandidate.id}.json`
          );
          if (detailRes && detailRes.ok) {
            const detailData = await detailRes.json();
            if (Array.isArray(detailData?.meta?.videos)) {
              cinemetaEpisodes = detailData.meta.videos;
            }
          }
        } catch {}
      }

      // 3. Propagate to all items in current library matching this folder
      const updates: MediaItem[] = [];

      for (const item of matchingLibraryItems) {
        if (category === "tv") {
          let epTitle: string | undefined;
          let epThumb: string | undefined;
          let epOverview: string | undefined;

          if (item.season !== undefined && item.episode !== undefined && cinemetaEpisodes.length > 0) {
            const ep = cinemetaEpisodes.find(
              (v: any) =>
                Number(v.season) === item.season &&
                (Number(v.episode) === item.episode || Number(v.number) === item.episode)
            );
            if (ep) {
              epTitle = ep.name || ep.title;
              epThumb = ep.thumbnail;
              epOverview = ep.overview || ep.description;
            }
          }

          updates.push({
            ...item,
            showTitle: selectedCandidate.title,
            showId: selectedCandidate.id,
            showPosterUrl: selectedCandidate.posterUrl || item.showPosterUrl,
            showBackdropUrl: selectedCandidate.backdropUrl || item.showBackdropUrl,
            showOverview: selectedCandidate.overview || item.showOverview,
            posterUrl: epThumb || selectedCandidate.posterUrl || item.posterUrl,
            backdropUrl: selectedCandidate.backdropUrl || item.backdropUrl,
            thumbUrl: epThumb || item.thumbUrl,
            episodeTitle: epTitle || item.episodeTitle,
            title:
              epTitle ||
              (item.season !== undefined && item.episode !== undefined
                ? `${selectedCandidate.title} - S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`
                : selectedCandidate.title),
            year: selectedCandidate.year || item.year,
            genres: selectedCandidate.genres || item.genres,
            metadataId: selectedCandidate.id,
            metadataSource: selectedCandidate.source === "cinemeta" ? "cinemeta" : "tmdb",
            metadataConfidence: "high",
          });
        } else if (category === "music") {
          updates.push({
            ...item,
            album: selectedCandidate.title,
            artist: selectedCandidate.creator || item.artist,
            posterUrl: selectedCandidate.posterUrl || item.posterUrl,
            year: selectedCandidate.year || item.year,
            genres: selectedCandidate.genres || item.genres,
            metadataId: selectedCandidate.id,
            metadataSource: selectedCandidate.source,
            metadataConfidence: "high",
          });
        } else if (category === "books" || category === "audiobooks") {
          const isMultiChapter = Boolean(item.album && item.album !== item.title);
          updates.push({
            ...item,
            title: isMultiChapter ? item.title : selectedCandidate.title,
            album: selectedCandidate.title,
            author: selectedCandidate.creator || item.author,
            artist: selectedCandidate.creator || item.artist,
            posterUrl: selectedCandidate.posterUrl || item.posterUrl,
            year: selectedCandidate.year || item.year,
            overview: selectedCandidate.overview || item.overview,
            genres: selectedCandidate.genres || item.genres,
            metadataId: selectedCandidate.id,
            metadataSource: "openlibrary",
            metadataConfidence: "high",
          });
        } else if (category === "movies") {
          updates.push({
            ...item,
            title: selectedCandidate.title,
            posterUrl: selectedCandidate.posterUrl || item.posterUrl,
            backdropUrl: selectedCandidate.backdropUrl || item.backdropUrl,
            overview: selectedCandidate.overview || item.overview,
            year: selectedCandidate.year || item.year,
            genres: selectedCandidate.genres || item.genres,
            metadataId: selectedCandidate.id,
            metadataSource: selectedCandidate.source === "cinemeta" ? "cinemeta" : "tmdb",
            metadataConfidence: "high",
          });
        }
      }

      if (updates.length > 0) {
        bulkUpsertMediaItems(updates);
        persistItems(updates).catch((err) =>
          console.error("Failed persisting folder matched items:", err)
        );
      }

      addToast(
        updates.length > 0
          ? `Applied "${selectedCandidate.title}" to ${updates.length} item(s) in folder`
          : `Cached folder match "${selectedCandidate.title}" for upcoming scans`,
        "success"
      );

      onMatchApplied?.(folderPath, selectedCandidate.title);
      onClose();
    } catch (err: any) {
      addToast(`Failed applying match: ${err?.message || String(err)}`, "error");
    } finally {
      setApplying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-void/80 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="w-full max-w-2xl bg-surface border border-border rounded-2xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden"
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-panel/50">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent shrink-0">
                <Sparkles size={16} />
              </div>
              <div className="min-w-0">
                <h2 className="font-display text-lg text-bright tracking-wide flex items-center gap-2 truncate">
                  MATCH FOLDER METADATA
                </h2>
                <p className="text-subtle font-mono text-[11px] truncate" title={folderPath}>
                  {folderPath || folderName}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-white/10 text-subtle hover:text-white transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Category Tabs */}
          <div className="px-6 pt-4 pb-2 flex items-center gap-2 border-b border-border/50 bg-panel/20">
            <button
              onClick={() => setCategory("tv")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                category === "tv"
                  ? "bg-accent text-void shadow-md"
                  : "bg-panel text-subtle hover:text-white hover:bg-muted"
              }`}
            >
              <Tv size={14} />
              <span>TV Series</span>
            </button>
            <button
              onClick={() => setCategory("music")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                category === "music"
                  ? "bg-accent text-void shadow-md"
                  : "bg-panel text-subtle hover:text-white hover:bg-muted"
              }`}
            >
              <Music size={14} />
              <span>Music Album</span>
            </button>
            <button
              onClick={() => setCategory("audiobooks")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                category === "audiobooks"
                  ? "bg-accent text-void shadow-md"
                  : "bg-panel text-subtle hover:text-white hover:bg-muted"
              }`}
            >
              <BookOpen size={14} />
              <span>Audiobook / Book</span>
            </button>
            <button
              onClick={() => setCategory("movies")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                category === "movies"
                  ? "bg-accent text-void shadow-md"
                  : "bg-panel text-subtle hover:text-white hover:bg-muted"
              }`}
            >
              <Film size={14} />
              <span>Movie / Video</span>
            </button>
          </div>

          {/* Search Box */}
          <div className="px-6 py-3 border-b border-border/60">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                searchMetadata(query, category);
              }}
              className="flex items-center gap-2"
            >
              <div className="relative flex-1">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search metadata for ${category}...`}
                  className="input-field pl-9 py-2 text-sm w-full"
                />
              </div>
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="btn-accent px-4 py-2 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
              >
                {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                <span>Search</span>
              </button>
            </form>

            {matchingLibraryItems.length > 0 && (
              <p className="text-[11px] font-body text-emerald-400 mt-2 flex items-center gap-1.5">
                <HardDrive size={12} />
                <span>
                  Found <strong>{matchingLibraryItems.length}</strong> media file(s) in this folder across your library.
                </span>
              </p>
            )}
          </div>

          {/* Results List */}
          <div className="flex-1 overflow-y-auto p-6 space-y-2.5">
            {loading && (
              <div className="py-12 flex flex-col items-center justify-center gap-3">
                <Loader2 size={24} className="animate-spin text-accent" />
                <p className="text-subtle font-body text-xs">Searching online catalogs...</p>
              </div>
            )}

            {!loading && results.length === 0 && (
              <div className="py-12 text-center">
                <AlertCircle size={28} className="mx-auto text-subtle/50 mb-2" />
                <p className="text-subtle font-body text-sm">No matches found for "{query}".</p>
                <p className="text-subtle/70 font-body text-xs mt-1">
                  Try editing the search title above and searching again.
                </p>
              </div>
            )}

            {!loading &&
              results.map((candidate) => {
                const isSelected = selectedCandidate?.id === candidate.id;
                return (
                  <div
                    key={candidate.id}
                    onClick={() => setSelectedCandidate(candidate)}
                    className={`flex items-start gap-3.5 p-3 rounded-xl border transition-all cursor-pointer ${
                      isSelected
                        ? "bg-accent/15 border-accent shadow-md shadow-accent/10"
                        : "bg-panel/60 border-border/80 hover:bg-panel hover:border-muted"
                    }`}
                  >
                    {/* Poster */}
                    <div className="w-12 h-16 rounded-lg bg-surface border border-border overflow-hidden shrink-0 flex items-center justify-center">
                      {candidate.posterUrl ? (
                        <img
                          src={candidate.posterUrl}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <Folder size={18} className="text-subtle" />
                      )}
                    </div>

                    {/* Metadata */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-body text-sm font-semibold text-bright truncate">
                          {candidate.title}
                        </span>
                        {candidate.year && (
                          <span className="px-1.5 py-0.5 rounded bg-surface border border-border text-[10px] font-body text-subtle">
                            {candidate.year}
                          </span>
                        )}
                        <span className="px-1.5 py-0.5 rounded bg-panel border border-border/80 text-[9px] font-mono uppercase text-subtle">
                          {candidate.source}
                        </span>
                      </div>

                      {candidate.creator && (
                        <p className="text-accent text-xs font-body mt-0.5">{candidate.creator}</p>
                      )}

                      {candidate.overview && (
                        <p className="text-subtle font-body text-xs line-clamp-2 mt-1 leading-relaxed">
                          {candidate.overview}
                        </p>
                      )}
                    </div>

                    {/* Selected Indicator */}
                    <div className="pt-1 pr-1 shrink-0">
                      <div
                        className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${
                          isSelected
                            ? "bg-accent border-accent text-void"
                            : "border-border text-transparent"
                        }`}
                      >
                        <Check size={12} strokeWidth={3} />
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-border bg-panel/60 flex items-center justify-between gap-3">
            <div className="text-xs text-subtle truncate">
              {selectedCandidate ? (
                <span>
                  Selected: <strong className="text-white">{selectedCandidate.title}</strong>
                </span>
              ) : (
                <span>Select a result to apply metadata to this folder</span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="btn-secondary text-xs py-2 px-3"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApplyMatch}
                disabled={!selectedCandidate || applying}
                className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5 shadow-lg shadow-accent/20 disabled:opacity-50"
              >
                {applying ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Sparkles size={13} />
                )}
                <span>Apply to Folder</span>
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
