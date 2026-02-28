import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, type MediaItem, type Library } from "../store/appStore";

type DiscoveredFile = {
  remote_path: string;
  filename: string;
  size: number;
  is_dir: boolean;
  mime_type: string | null;
};

type LibraryScanResult = {
  library_id: string;
  new_files: DiscoveredFile[];
  removed_paths: string[];
  total_found: number;
  errors: string[];
};

type ParsedTitle = {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  is_episode: boolean;
};

// ─── Rate-limited fetch ───────────────────────────────────────────────────────
// TMDB allows 50 requests/second but we throttle to 10/s to be safe

let lastRequestTime = 0;
const MIN_REQUEST_GAP = 120; // ms between requests

async function rateLimitedFetch(url: string, options?: RequestInit): Promise<Response> {
  const now = Date.now();
  const wait = Math.max(0, MIN_REQUEST_GAP - (now - lastRequestTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestTime = Date.now();
  return fetch(url, options);
}

async function fetchWithRetry(url: string, options?: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const resp = await rateLimitedFetch(url, options);
    if (resp.status === 429) {
      // Rate limited — back off exponentially
      const backoff = Math.pow(2, i) * 2000;
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    return resp;
  }
  throw new Error("Max retries exceeded");
}

// ─── Metadata fetchers ────────────────────────────────────────────────────────

async function fetchTmdbMovie(title: string, year: number | undefined, apiKey: string): Promise<Partial<MediaItem>> {
  try {
    const q = encodeURIComponent(title);
    const yearParam = year ? `&year=${year}` : "";
    const resp = await fetchWithRetry(
      `https://api.themoviedb.org/3/search/movie?query=${q}${yearParam}&language=en-US&page=1`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!resp.ok) return {};
    const data = await resp.json();
    const r = data.results?.[0];
    if (!r) return {};
    return {
      title: r.title ?? title,
      year: r.release_date ? parseInt(r.release_date.split("-")[0]) : year,
      posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : undefined,
      backdropUrl: r.backdrop_path ? `https://image.tmdb.org/t/p/w780${r.backdrop_path}` : undefined,
      overview: r.overview,
      rating: r.vote_average,
      metadataId: String(r.id),
      metadataSource: "tmdb" as const,
      metadataConfidence: "high" as const,
    };
  } catch { return {}; }
}

async function fetchTmdbTv(showTitle: string, season: number | undefined, episode: number | undefined, apiKey: string): Promise<Partial<MediaItem>> {
  try {
    const q = encodeURIComponent(showTitle);
    const searchResp = await fetchWithRetry(
      `https://api.themoviedb.org/3/search/tv?query=${q}&language=en-US&page=1`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!searchResp.ok) return {};
    const searchData = await searchResp.json();
    const show = searchData.results?.[0];
    if (!show) return {};

    const showPosterUrl = show.poster_path ? `https://image.tmdb.org/t/p/w342${show.poster_path}` : undefined;
    const showBackdropUrl = show.backdrop_path ? `https://image.tmdb.org/t/p/w780${show.backdrop_path}` : undefined;

    // Fetch episode-specific info if we have season/episode
    let episodeTitle: string | undefined;
    let thumbUrl: string | undefined;

    if (season && episode) {
      try {
        const epResp = await fetchWithRetry(
          `https://api.themoviedb.org/3/tv/${show.id}/season/${season}/episode/${episode}?language=en-US`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );
        if (epResp.ok) {
          const epData = await epResp.json();
          episodeTitle = epData.name;
          thumbUrl = epData.still_path ? `https://image.tmdb.org/t/p/w300${epData.still_path}` : undefined;
        }
      } catch {}
    }

    return {
      showTitle: show.name ?? showTitle,
      showId: String(show.id),
      showPosterUrl,
      showBackdropUrl,
      showOverview: show.overview,
      posterUrl: thumbUrl ?? showPosterUrl,
      backdropUrl: showBackdropUrl,
      thumbUrl,
      episodeTitle,
      year: show.first_air_date ? parseInt(show.first_air_date.split("-")[0]) : undefined,
      rating: show.vote_average,
      metadataId: String(show.id),
      metadataSource: "tmdb" as const,
      metadataConfidence: "high" as const,
    };
  } catch { return {}; }
}

async function fetchMusicBrainz(title: string): Promise<Partial<MediaItem>> {
  try {
    const resp = await fetch(
      `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(title)}&limit=1&fmt=json`,
      { headers: { "User-Agent": "RcloneFlix/0.1 (rcloneflix@example.com)" } }
    );
    if (!resp.ok) return {};
    const data = await resp.json();
    const r = data.recordings?.[0];
    if (!r) return {};
    return {
      title: r.title ?? title,
      artist: r["artist-credit"]?.[0]?.name,
      album: r.releases?.[0]?.title,
      year: r.releases?.[0]?.date ? parseInt(r.releases[0].date.split("-")[0]) : undefined,
      metadataId: r.id,
      metadataSource: "musicbrainz" as const,
      metadataConfidence: "high" as const,
    };
  } catch { return {}; }
}

async function fetchOpenLibrary(title: string): Promise<Partial<MediaItem>> {
  try {
    const resp = await fetch(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(title)}&limit=1`
    );
    if (!resp.ok) return {};
    const data = await resp.json();
    const r = data.docs?.[0];
    if (!r) return {};
    const coverId = r.cover_i;
    return {
      title: r.title ?? title,
      author: r.author_name?.[0],
      year: r.first_publish_year,
      posterUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : undefined,
      metadataId: r.key,
      metadataSource: "openlibrary" as const,
      metadataConfidence: "high" as const,
    };
  } catch { return {}; }
}

// ─── Main scan ────────────────────────────────────────────────────────────────

export async function scanLibrary(library: Library, apiKeys: { tmdb: string; theporndb: string }) {
  const store = useAppStore.getState();
  const { rcloneConfigPath, mediaItems, setScanState, bulkUpsertMediaItems, removeMediaItem } = store;

  const knownPaths = Object.values(mediaItems)
    .filter((i) => i.libraryId === library.id)
    .map((i) => i.remotePath);

  setScanState({ status: "scanning", currentLibrary: library.name, progress: 0, newItemsFound: 0 });

  try {
    const result: LibraryScanResult = await invoke("scan_library_files", {
      configPath: rcloneConfigPath,
      remotePath: library.remotePath,
      libraryId: library.id,
      knownPaths,
    });

    // Remove deleted files
    for (const removedPath of result.removed_paths) {
      const item = Object.values(mediaItems).find((i) => i.remotePath === removedPath);
      if (item) removeMediaItem(item.id);
    }

    const total = result.new_files.length;
    const newItems: MediaItem[] = [];

    for (let idx = 0; idx < result.new_files.length; idx++) {
      const file = result.new_files[idx];

      setScanState({ progress: Math.round((idx / Math.max(total, 1)) * 100), newItemsFound: idx });

      const parsed: ParsedTitle = await invoke("parse_media_filename", { filename: file.filename });
      const id: string = await invoke("hash_remote_path", { remotePath: file.remote_path });

      const baseItem: MediaItem = {
        id,
        libraryId: library.id,
        libraryType: library.type,
        remotePath: file.remote_path,
        filename: file.filename,
        title: parsed.title,
        year: parsed.year,
        season: parsed.season,
        episode: parsed.episode,
        addedAt: Date.now(),
        lastScannedAt: Date.now(),
        metadataConfidence: "low",
      };

      let meta: Partial<MediaItem> = {};

      if (library.type === "movies" && apiKeys.tmdb) {
        meta = await fetchTmdbMovie(parsed.title, parsed.year, apiKeys.tmdb);
      } else if (library.type === "tv" && apiKeys.tmdb) {
        meta = await fetchTmdbTv(parsed.title, parsed.season, parsed.episode, apiKeys.tmdb);
      } else if (library.type === "music") {
        meta = await fetchMusicBrainz(parsed.title);
      } else if (library.type === "books" || library.type === "audiobooks") {
        meta = await fetchOpenLibrary(parsed.title);
      } else if (library.type === "adult" && apiKeys.theporndb) {
        try {
          const resp = await fetchWithRetry(
            `https://theporndb.net/api/scenes?q=${encodeURIComponent(parsed.title)}`,
            { headers: { Authorization: `Bearer ${apiKeys.theporndb}` } }
          );
          if (resp.ok) {
            const data = await resp.json();
            const scene = data.data?.[0];
            if (scene) {
              meta = {
                title: scene.title ?? parsed.title,
                posterUrl: scene.posters?.[0]?.url,
                overview: scene.description,
                metadataId: String(scene.id),
                metadataSource: "theporndb",
                metadataConfidence: "high",
              };
            }
          }
        } catch {}
      }

      newItems.push({ ...baseItem, ...meta });

      // Batch save every 20 items to avoid store thrashing
      if (newItems.length % 20 === 0) {
        bulkUpsertMediaItems([...newItems]);
      }
    }

    if (newItems.length > 0) bulkUpsertMediaItems(newItems);

    setScanState({
      status: "idle", progress: 100, lastScanAt: Date.now(),
      newItemsFound: newItems.length, currentLibrary: undefined,
    });

    return { newItems: newItems.length, removed: result.removed_paths.length };
  } catch (e) {
    setScanState({ status: "error", lastError: e instanceof Error ? e.message : String(e), currentLibrary: undefined });
    throw e;
  }
}

export async function scanAllLibraries() {
  const { libraries, tmdbApiKey, thePornDbApiKey } = useAppStore.getState();
  const apiKeys = { tmdb: tmdbApiKey, theporndb: thePornDbApiKey };
  for (const library of libraries) {
    await scanLibrary(library, apiKeys);
  }
}

export function listenScanProgress(cb: (event: unknown) => void) {
  return listen("scan-progress", (event) => cb(event.payload));
}
