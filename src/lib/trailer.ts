/**
 * Trailer resolver for RcloneFlix.
 *
 * Resolves official trailer YouTube video IDs using Cinemeta and TMDB APIs.
 */

export interface TrailerInfo {
  source: string; // YouTube video ID or full URL
  type: string;
  name?: string;
}

/**
 * Resolves a YouTube trailer video ID or URL for a given media item.
 */
export async function resolveTrailer(item: {
  metadataId?: string;
  libraryType?: string;
  title: string;
  year?: number;
}): Promise<string | null> {
  // 1. Cinemeta by IMDb ID (tt...)
  if (item.metadataId && item.metadataId.startsWith("tt")) {
    const type = item.libraryType === "tv" ? "series" : "movie";
    try {
      const res = await fetch(
        `https://v3-cinemeta.strem.io/meta/${type}/${item.metadataId}.json`
      );
      if (res.ok) {
        const data = await res.json();
        const trailers = data.meta?.trailers;
        if (Array.isArray(trailers) && trailers.length > 0) {
          const mainTrailer =
            trailers.find((t: any) => t.type?.toLowerCase() === "trailer") || trailers[0];
          if (mainTrailer?.source) return mainTrailer.source;
        }
        if (typeof data.meta?.trailer === "string" && data.meta.trailer) {
          const match = data.meta.trailer.match(
            /(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/
          );
          if (match) return match[1];
          if (/^[a-zA-Z0-9_-]{11}$/.test(data.meta.trailer)) return data.meta.trailer;
        }
      }
    } catch (e) {
      console.warn("Cinemeta trailer lookup failed:", e);
    }
  }

  // 2. Search Cinemeta by title if no IMDb ID or not found yet
  if (item.libraryType === "movies" || item.libraryType === "tv") {
    const type = item.libraryType === "tv" ? "series" : "movie";
    try {
      const searchRes = await fetch(
        `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(
          item.title
        )}.json`
      );
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const first = searchData.metas?.[0];
        if (first?.id && first.id.startsWith("tt") && first.id !== item.metadataId) {
          const nested = await resolveTrailer({
            ...item,
            metadataId: first.id,
          });
          if (nested) return nested;
        }
        if (first?.trailers && Array.isArray(first.trailers) && first.trailers.length > 0) {
          const t = first.trailers.find((x: any) => x.type === "Trailer") || first.trailers[0];
          if (t?.source) return t.source;
        }
      }
    } catch (e) {
      console.warn("Cinemeta title search trailer lookup failed:", e);
    }
  }

  return null;
}
