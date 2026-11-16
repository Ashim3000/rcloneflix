import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore } from "../store/appStore";

export type CanonicalEpisode = {
  id: string; // e.g. "tt0903747:1:1"
  season: number;
  episode: number;
  title: string;
  overview?: string;
  thumbnail?: string;
  airDate?: string; // ISO date e.g. "2024-03-15T00:00:00.000Z"
  hasAired: boolean;
};

export type CanonicalSeries = {
  imdbId?: string;
  tmdbId?: string;
  title: string;
  posterUrl?: string;
  backdropUrl?: string;
  overview?: string;
  year?: number;
  genres?: string[];
  episodes: CanonicalEpisode[];
  totalSeasons: number;
};

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

const seriesCache = new Map<string, CanonicalSeries>();

function normalizeShowKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Parses release/air date string to determine whether the episode has officially aired.
 */
export function isEpisodeAired(airDate?: string): boolean {
  if (!airDate) return true; // Default to true if unstated
  try {
    const time = new Date(airDate).getTime();
    if (isNaN(time)) return true;
    return time <= Date.now();
  } catch {
    return true;
  }
}

/**
 * Formats air date for user display (e.g. "Oct 4, 2026").
 */
export function formatEpisodeAirDate(airDate?: string): string {
  if (!airDate) return "";
  try {
    const d = new Date(airDate);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/**
 * Fetches canonical series episode list via Cinemeta (keyless) with optional TMDB fallback.
 */
export async function fetchCanonicalSeriesEpisodes(
  showTitle: string,
  imdbOrTmdbId?: string
): Promise<CanonicalSeries | null> {
  const normKey = normalizeShowKey(showTitle);
  const cacheKey = (imdbOrTmdbId || normKey).toLowerCase();

  if (seriesCache.has(cacheKey)) {
    return seriesCache.get(cacheKey)!;
  }

  // 1. If we have an IMDb ID (e.g. "tt0903747"), fetch directly from Cinemeta
  let resolvedImdbId = imdbOrTmdbId?.startsWith("tt") ? imdbOrTmdbId : undefined;

  // 2. If no direct IMDb ID, search Cinemeta catalog by show title
  if (!resolvedImdbId && showTitle.trim()) {
    try {
      const cleanTitle = showTitle.replace(/\(\d{4}\)/g, "").trim();
      const searchRes = await httpFetch(
        `https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(cleanTitle)}.json`
      );
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const metas: any[] = searchData.metas || [];
        if (metas.length > 0) {
          const match = metas[0];
          if (match?.id?.startsWith("tt")) {
            resolvedImdbId = match.id;
          }
        }
      }
    } catch (err) {
      console.warn("Cinemeta series catalog search error:", err);
    }
  }

  // 3. Fetch full series metadata & episode manifest from Cinemeta
  if (resolvedImdbId) {
    try {
      const metaRes = await httpFetch(
        `https://v3-cinemeta.strem.io/meta/series/${resolvedImdbId}.json`
      );
      if (metaRes.ok) {
        const metaData = await metaRes.json();
        const meta = metaData?.meta;
        if (meta) {
          const rawVideos: any[] = meta.videos || [];
          const episodes: CanonicalEpisode[] = rawVideos
            .map((v) => {
              const season = v.season ?? 1;
              const epNum = v.episode ?? v.number ?? 1;
              const airDate = v.firstAired || v.released;
              return {
                id: v.id || `${resolvedImdbId}:${season}:${epNum}`,
                season,
                episode: epNum,
                title: v.name || v.title || `Episode ${epNum}`,
                overview: v.overview || v.description,
                thumbnail: v.thumbnail,
                airDate,
                hasAired: isEpisodeAired(airDate),
              };
            })
            // Ignore Season 0 (specials) unless that's all there is
            .sort((a, b) => {
              if (a.season !== b.season) return a.season - b.season;
              return a.episode - b.episode;
            });

          const seasonsSet = new Set(episodes.map((e) => e.season).filter((s) => s > 0));
          const totalSeasons = seasonsSet.size || 1;

          const series: CanonicalSeries = {
            imdbId: resolvedImdbId,
            title: meta.name || showTitle,
            posterUrl: meta.poster,
            backdropUrl: meta.background,
            overview: meta.description,
            year: meta.year ? parseInt(String(meta.year).split("-")[0], 10) : undefined,
            genres: Array.isArray(meta.genres)
              ? meta.genres
              : Array.isArray(meta.genre)
              ? meta.genre
              : undefined,
            episodes,
            totalSeasons,
          };

          seriesCache.set(cacheKey, series);
          if (imdbOrTmdbId && imdbOrTmdbId !== cacheKey) {
            seriesCache.set(imdbOrTmdbId.toLowerCase(), series);
          }
          return series;
        }
      }
    } catch (err) {
      console.warn("Failed fetching Cinemeta series details:", err);
    }
  }

  // 4. Optional TMDB fallback if configured
  const tmdbKey = useAppStore.getState().tmdbApiKey;
  if (tmdbKey && showTitle.trim()) {
    try {
      const cleanTitle = showTitle.replace(/\(\d{4}\)/g, "").trim();
      const searchRes = await httpFetch(
        `https://api.themoviedb.org/3/search/tv?api_key=${tmdbKey}&query=${encodeURIComponent(cleanTitle)}&language=en-US&page=1`
      );
      if (searchRes.ok) {
        const sData = await searchRes.json();
        const show = sData.results?.[0];
        if (show?.id) {
          const detailRes = await httpFetch(
            `https://api.themoviedb.org/3/tv/${show.id}?api_key=${tmdbKey}&language=en-US`
          );
          if (detailRes.ok) {
            const detail = await detailRes.json();
            const tmdbSeasons: any[] = detail.seasons || [];
            const episodes: CanonicalEpisode[] = [];

            for (const s of tmdbSeasons) {
              if (s.season_number <= 0) continue; // skip specials
              try {
                const sRes = await httpFetch(
                  `https://api.themoviedb.org/3/tv/${show.id}/season/${s.season_number}?api_key=${tmdbKey}&language=en-US`
                );
                if (sRes.ok) {
                  const sJson = await sRes.json();
                  const sEps: any[] = sJson.episodes || [];
                  for (const ep of sEps) {
                    episodes.push({
                      id: `tmdb-${ep.id}`,
                      season: ep.season_number,
                      episode: ep.episode_number,
                      title: ep.name || `Episode ${ep.episode_number}`,
                      overview: ep.overview,
                      thumbnail: ep.still_path
                        ? `https://image.tmdb.org/t/p/w500${ep.still_path}`
                        : undefined,
                      airDate: ep.air_date,
                      hasAired: isEpisodeAired(ep.air_date),
                    });
                  }
                }
              } catch {}
            }

            const series: CanonicalSeries = {
              tmdbId: String(show.id),
              title: detail.name || showTitle,
              posterUrl: detail.poster_path
                ? `https://image.tmdb.org/t/p/w500${detail.poster_path}`
                : undefined,
              backdropUrl: detail.backdrop_path
                ? `https://image.tmdb.org/t/p/original${detail.backdrop_path}`
                : undefined,
              overview: detail.overview,
              year: detail.first_air_date ? parseInt(detail.first_air_date.split("-")[0], 10) : undefined,
              genres: Array.isArray(detail.genres)
                ? detail.genres.map((g: any) => g?.name).filter(Boolean)
                : undefined,
              episodes,
              totalSeasons: tmdbSeasons.filter((s) => s.season_number > 0).length || 1,
            };

            seriesCache.set(cacheKey, series);
            return series;
          }
        }
      }
    } catch (err) {
      console.warn("TMDB series fetch fallback error:", err);
    }
  }

  return null;
}
