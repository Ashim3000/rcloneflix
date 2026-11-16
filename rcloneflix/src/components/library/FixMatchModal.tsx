import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Search, Check, Loader2 } from "lucide-react";
import { useAppStore, type MediaItem } from "../../store/appStore";

type Props = {
  item: MediaItem;
  onClose: () => void;
};

type SearchResult = {
  id: string;
  title: string;
  year?: number;
  posterUrl?: string;
  overview?: string;
  source: "tmdb" | "musicbrainz" | "openlibrary";
};

export function FixMatchModal({ item, onClose }: Props) {
  const { tmdbApiKey, updateItemMetadata } = useAppStore();
  const [query, setQuery] = useState(item.title);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setResults([]);

    try {
      const found: SearchResult[] = [];

      if ((item.libraryType === "movies" || item.libraryType === "tv" || item.libraryType === "adult") && tmdbApiKey) {
        const type = item.libraryType === "tv" ? "tv" : "movie";
        const res = await fetch(
          `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(query)}&language=en-US&page=1`,
          { headers: { Authorization: `Bearer ${tmdbApiKey}` } }
        );
        if (res.ok) {
          const data = await res.json();
          (data.results ?? []).slice(0, 8).forEach((r: Record<string, unknown>) => {
            found.push({
              id: String(r.id),
              title: (r.title as string) ?? (r.name as string) ?? query,
              year: r.release_date
                ? parseInt((r.release_date as string).split("-")[0])
                : r.first_air_date
                ? parseInt((r.first_air_date as string).split("-")[0])
                : undefined,
              posterUrl: r.poster_path
                ? `https://image.tmdb.org/t/p/w92${r.poster_path}`
                : undefined,
              overview: r.overview as string,
              source: "tmdb",
            });
          });
        }
      } else if (item.libraryType === "books" || item.libraryType === "audiobooks") {
        const res = await fetch(
          `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=8`
        );
        if (res.ok) {
          const data = await res.json();
          (data.docs ?? []).forEach((r: Record<string, unknown>) => {
            const coverId = r.cover_i as number | undefined;
            found.push({
              id: r.key as string,
              title: r.title as string,
              year: r.first_publish_year as number | undefined,
              posterUrl: coverId
                ? `https://covers.openlibrary.org/b/id/${coverId}-S.jpg`
                : undefined,
              overview: (r.author_name as string[])?.join(", "),
              source: "openlibrary",
            });
          });
        }
      } else if (item.libraryType === "music") {
        const res = await fetch(
          `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&limit=8&fmt=json`,
          { headers: { "User-Agent": "RcloneFlix/0.1 (rcloneflix@example.com)" } }
        );
        if (res.ok) {
          const data = await res.json();
          (data.recordings ?? []).forEach((r: Record<string, unknown>) => {
            const credits = r["artist-credit"] as Array<Record<string, unknown>> | undefined;
            found.push({
              id: r.id as string,
              title: r.title as string,
              year: undefined,
              overview: credits?.map((c) => c.name).join(", "),
              source: "musicbrainz",
            });
          });
        }
      }

      setResults(found);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = async (result: SearchResult) => {
    setSelected(result.id);
    updateItemMetadata(item.id, {
      title: result.title,
      year: result.year,
      posterUrl: result.posterUrl,
      overview: result.overview,
      metadataId: result.id,
      metadataSource: result.source,
      metadataConfidence: "manual",
    });
    setTimeout(onClose, 600);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        className="bg-surface border border-border rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-card-hover"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div>
            <h2 className="font-body font-semibold text-bright text-base">Fix Incorrect Match</h2>
            <p className="text-subtle text-xs font-body mt-0.5 truncate max-w-xs">{item.filename}</p>
          </div>
          <button onClick={onClose} className="text-subtle hover:text-text transition-colors p-1">
            <X size={18} />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Search for correct title..."
              className="input-field flex-1"
              autoFocus
            />
            <button
              onClick={handleSearch}
              disabled={loading}
              className="btn-primary px-4 py-3 flex items-center gap-2"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="overflow-y-auto flex-1">
          {results.length === 0 && !loading && (
            <div className="flex items-center justify-center py-12 text-subtle font-body text-sm">
              {query !== item.title || results.length === 0
                ? "Search to find the correct match"
                : "No results found"}
            </div>
          )}

          {results.map((result) => (
            <button
              key={result.id}
              onClick={() => handleSelect(result)}
              className="w-full flex items-start gap-3 px-5 py-3 hover:bg-panel transition-colors border-b border-border/50 last:border-0 text-left"
            >
              {/* Poster thumbnail */}
              <div className="w-10 h-14 rounded-lg overflow-hidden bg-muted flex-shrink-0">
                {result.posterUrl ? (
                  <img src={result.posterUrl} alt={result.title} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-muted" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-text font-body font-medium text-sm truncate">{result.title}</p>
                  {selected === result.id && (
                    <Check size={14} className="text-teal flex-shrink-0" />
                  )}
                </div>
                {result.year && (
                  <p className="text-subtle font-body text-xs mt-0.5">{result.year}</p>
                )}
                {result.overview && (
                  <p className="text-subtle font-body text-xs mt-1 line-clamp-2">{result.overview}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
