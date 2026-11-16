import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore, type MediaItem } from "../store/appStore";
import { annotateWithLibraryMatch } from "./discoveryMatching";

async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url as any, init as any);
      return res as unknown as Response;
    } catch {
      // Fallback
    }
  }
  return await window.fetch(url, init);
}

const recommendationCache = new Map<string, MediaItem[]>();

/**
 * Resolves a numeric TMDB ID for a MediaItem using its metadataId, showId, or title+year search.
 */
async function resolveTmdbId(
  item: MediaItem,
  mediaType: "movie" | "tv",
  apiKey: string
): Promise<number | null> {
  const rawId = (mediaType === "tv" ? item.showId || item.metadataId : item.metadataId) || "";

  // 1. Already a numeric TMDB ID
  if (/^\d+$/.test(rawId)) {
    return parseInt(rawId, 10);
  }

  // 2. IMDb ID (tt...) -> resolve via TMDB /find
  if (rawId.startsWith("tt")) {
    try {
      const findUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(
        rawId
      )}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`;
      const res = await httpFetch(findUrl);
      if (res.ok) {
        const data = await res.json();
        const list = mediaType === "tv" ? data.tv_results : data.movie_results;
        if (Array.isArray(list) && list.length > 0 && list[0].id) {
          return Number(list[0].id);
        }
      }
    } catch {}
  }

  // 3. Fallback search by title
  const queryTitle = (mediaType === "tv" ? item.showTitle || item.title : item.title)
    .replace(/\(\d{4}\)/g, "")
    .trim();
  if (!queryTitle) return null;

  try {
    const yearParam =
      item.year && mediaType === "movie" ? `&year=${item.year}` : "";
    const searchUrl = `https://api.themoviedb.org/3/search/${mediaType}?api_key=${encodeURIComponent(
      apiKey
    )}&query=${encodeURIComponent(queryTitle)}${yearParam}`;
    const res = await httpFetch(searchUrl);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.results) && data.results.length > 0) {
        return Number(data.results[0].id);
      }
    }
  } catch {}

  return null;
}

/**
 * Keyless fallback using Cinemeta's genre catalog when no TMDB API key is configured.
 */
async function fetchCinemetaGenreRecommendations(
  item: MediaItem,
  mediaType: "movie" | "tv"
): Promise<MediaItem[]> {
  const cinemetaType = mediaType === "tv" ? "series" : "movie";
  const genres = item.genres && item.genres.length > 0 ? item.genres : ["Action", "Drama", "Sci-Fi"];
  const currentTitleNorm = (item.showTitle || item.title).toLowerCase().trim();

  const urlsToTry = [
    ...genres.slice(0, 2).map(
      (g) => `https://v3-cinemeta.strem.io/catalog/${cinemetaType}/top/genre=${encodeURIComponent(g)}.json`
    ),
    `https://v3-cinemeta.strem.io/catalog/${cinemetaType}/top.json`,
  ];

  const seenIds = new Set<string>();
  const combinedMetas: any[] = [];

  for (const url of urlsToTry) {
    try {
      const res = await httpFetch(url);
      if (res.ok) {
        const data = await res.json();
        const metas: any[] = data?.metas || [];
        for (const m of metas) {
          if (m?.id && !seenIds.has(m.id)) {
            seenIds.add(m.id);
            combinedMetas.push(m);
          }
        }
      }
      if (combinedMetas.length >= 24) break;
    } catch {
      // continue to next catalog URL
    }
  }

  return combinedMetas
    .filter((m) => {
      if (!m?.name) return false;
      if (m.id === item.metadataId || m.id === item.showId) return false;
      return m.name.toLowerCase().trim() !== currentTitleNorm;
    })
    .map((m) => {
      const mGenres: string[] = Array.isArray(m.genres) ? m.genres : [];
      const overlap = mGenres.filter((g) => genres.includes(g)).length;
      const rating = m.imdbRating ? parseFloat(m.imdbRating) : 0;
      const yearNum = m.releaseInfo ? parseInt(String(m.releaseInfo).slice(0, 4), 10) : undefined;

      const mapped: MediaItem = {
        id: `rec-cinemeta-${m.id}`,
        libraryId: "discovery",
        libraryType: mediaType === "tv" ? "tv" : "movies",
        remotePath: "",
        filename: "",
        title: m.name,
        showTitle: mediaType === "tv" ? m.name : undefined,
        showId: mediaType === "tv" ? m.id : undefined,
        year: !isNaN(yearNum as number) ? yearNum : undefined,
        posterUrl: m.poster,
        backdropUrl: m.background,
        overview: m.description,
        rating: !isNaN(rating) && rating > 0 ? rating : undefined,
        genres: mGenres,
        metadataId: m.id,
        metadataSource: "cinemeta",
        addedAt: Date.now(),
        lastScannedAt: Date.now(),
        groupType: mediaType === "tv" ? "show" : "single",
      };
      return { mapped, score: overlap * 10 + (rating || 5) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 18)
    .map((x) => x.mapped);
}

/**
 * Fetches "More Like This" recommendations for a Movie or TV Show,
 * annotated with `inLibrary: true` and `matchedLibraryId` if present in the user's library.
 */
export async function fetchMoreLikeThis(item: MediaItem): Promise<MediaItem[]> {
  const isTv = item.libraryType === "tv" || item.groupType === "show" || Boolean(item.showTitle);
  const mediaType: "movie" | "tv" = isTv ? "tv" : "movie";
  const cacheKey = `${mediaType}:${item.showId || item.metadataId || item.showTitle || item.title}`;

  const { tmdbApiKey, mediaItems } = useAppStore.getState();

  if (recommendationCache.has(cacheKey)) {
    return annotateWithLibraryMatch(recommendationCache.get(cacheKey)!, mediaItems);
  }

  let results: MediaItem[] = [];

  // 1. Try TMDB Recommendations + Similar if TMDB API key is configured
  if (tmdbApiKey?.trim()) {
    const tmdbId = await resolveTmdbId(item, mediaType, tmdbApiKey.trim());
    if (tmdbId) {
      try {
        const recUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/recommendations?api_key=${encodeURIComponent(
          tmdbApiKey.trim()
        )}&page=1`;
        const res = await httpFetch(recUrl);
        let rawList: any[] = [];
        if (res.ok) {
          const data = await res.json();
          rawList = Array.isArray(data.results) ? data.results : [];
        }

        // Fallback to /similar if /recommendations is sparse
        if (rawList.length < 6) {
          const simUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/similar?api_key=${encodeURIComponent(
            tmdbApiKey.trim()
          )}&page=1`;
          const simRes = await httpFetch(simUrl);
          if (simRes.ok) {
            const simData = await simRes.json();
            const simList = Array.isArray(simData.results) ? simData.results : [];
            const seenTmdb = new Set(rawList.map((r) => r.id));
            for (const s of simList) {
              if (!seenTmdb.has(s.id)) {
                rawList.push(s);
                seenTmdb.add(s.id);
              }
            }
          }
        }

        results = rawList.slice(0, 18).map((r): MediaItem => {
          const title = (mediaType === "tv" ? r.name || r.original_name : r.title || r.original_title) || "Untitled";
          const dateStr = (mediaType === "tv" ? r.first_air_date : r.release_date) || "";
          const year = dateStr ? parseInt(dateStr.slice(0, 4), 10) : undefined;
          return {
            id: `rec-tmdb-${mediaType}-${r.id}`,
            libraryId: "discovery",
            libraryType: mediaType === "tv" ? "tv" : "movies",
            remotePath: "",
            filename: "",
            title,
            showTitle: mediaType === "tv" ? title : undefined,
            showId: mediaType === "tv" ? String(r.id) : undefined,
            year: year && !isNaN(year) ? year : undefined,
            posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : undefined,
            backdropUrl: r.backdrop_path ? `https://image.tmdb.org/t/p/w1280${r.backdrop_path}` : undefined,
            overview: r.overview,
            rating: typeof r.vote_average === "number" && r.vote_average > 0 ? r.vote_average : undefined,
            metadataId: String(r.id),
            metadataSource: "tmdb",
            addedAt: Date.now(),
            lastScannedAt: Date.now(),
            groupType: mediaType === "tv" ? "show" : "single",
          };
        });
      } catch {}
    }
  }

  // 2. Keyless Cinemeta Genre/Catalog Fallback if TMDB key is missing or returned 0 items
  if (results.length === 0) {
    results = await fetchCinemetaGenreRecommendations(item, mediaType);
  }

  if (results.length > 0) {
    recommendationCache.set(cacheKey, results);
  }

  return annotateWithLibraryMatch(results, mediaItems);
}

/**
 * Returns the ISO 8601 week string for a given date (defaults to now), e.g. "2026-W46".
 * ISO weeks start on Monday 00:00:00 UTC.
 */
export function getIsoWeekString(d: Date = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}


