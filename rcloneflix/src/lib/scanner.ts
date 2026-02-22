import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, type MediaItem, type Library, type LibraryType } from "../store/appStore";

// ─── Tauri IPC types ──────────────────────────────────────────────────────────

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

// ─── Metadata fetchers ────────────────────────────────────────────────────────

async function fetchTmdbMetadata(
  title: string,
  year: number | undefined,
  type: "movie" | "tv",
  apiKey: string
): Promise<Partial<MediaItem>> {
  const query = encodeURIComponent(title);
  const yearParam = year ? `&year=${year}` : "";
  const endpoint = type === "movie" ? "search/movie" : "search/tv";

  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/${endpoint}?query=${query}${yearParam}&language=en-US&page=1`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!res.ok) return {};
    const data = await res.json();
    const result = data.results?.[0];
    if (!result) return {};

    const posterUrl = result.poster_path
      ? `https://image.tmdb.org/t/p/w342${result.poster_path}`
      : undefined;
    const backdropUrl = result.backdrop_path
      ? `https://image.tmdb.org/t/p/w780${result.backdrop_path}`
      : undefined;

    return {
      title: result.title ?? result.name ?? title,
      year: result.release_date
        ? parseInt(result.release_date.split("-")[0])
        : result.first_air_date
        ? parseInt(result.first_air_date.split("-")[0])
        : year,
      posterUrl,
      backdropUrl,
      overview: result.overview,
      rating: result.vote_average,
      metadataId: String(result.id),
      metadataSource: "tmdb" as const,
      metadataConfidence: "high" as const,
    };
  } catch {
    return {};
  }
}

async function fetchMusicBrainzMetadata(
  title: string,
  artist?: string
): Promise<Partial<MediaItem>> {
  try {
    const query = artist ? `${title} ${artist}` : title;
    const res = await fetch(
      `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&limit=1&fmt=json`,
      { headers: { "User-Agent": "RcloneFlix/0.1 (rcloneflix@example.com)" } }
    );
    if (!res.ok) return {};
    const data = await res.json();
    const recording = data.recordings?.[0];
    if (!recording) return {};

    return {
      title: recording.title ?? title,
      artist: recording["artist-credit"]?.[0]?.name,
      album: recording.releases?.[0]?.title,
      year: recording.releases?.[0]?.date
        ? parseInt(recording.releases[0].date.split("-")[0])
        : undefined,
      metadataId: recording.id,
      metadataSource: "musicbrainz" as const,
      metadataConfidence: "high" as const,
    };
  } catch {
    return {};
  }
}

async function fetchOpenLibraryMetadata(
  title: string,
  author?: string
): Promise<Partial<MediaItem>> {
  try {
    const query = author ? `${title} ${author}` : title;
    const res = await fetch(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=1`
    );
    if (!res.ok) return {};
    const data = await res.json();
    const book = data.docs?.[0];
    if (!book) return {};

    const coverId = book.cover_i;
    const posterUrl = coverId
      ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`
      : undefined;

    return {
      title: book.title ?? title,
      author: book.author_name?.[0],
      year: book.first_publish_year,
      posterUrl,
      metadataId: book.key,
      metadataSource: "openlibrary" as const,
      metadataConfidence: "high" as const,
    };
  } catch {
    return {};
  }
}

// ─── Main scan orchestrator ───────────────────────────────────────────────────

export async function scanLibrary(library: Library, apiKeys: { tmdb: string; theporndb: string }) {
  const store = useAppStore.getState();
  const { rcloneConfigPath, mediaItems, setScanState, bulkUpsertMediaItems, removeMediaItem } = store;

  // Get existing paths for this library
  const knownPaths = Object.values(mediaItems)
    .filter((i) => i.libraryId === library.id)
    .map((i) => i.remotePath);

  setScanState({
    status: "scanning",
    currentLibrary: library.name,
    progress: 0,
    newItemsFound: 0,
  });

  try {
    // Step 1: File discovery
    const result: LibraryScanResult = await invoke("scan_library_files", {
      configPath: rcloneConfigPath,
      remotePath: library.remotePath,
      libraryId: library.id,
      knownPaths,
    });

    // Step 2: Remove deleted files
    for (const removedPath of result.removed_paths) {
      const item = Object.values(mediaItems).find((i) => i.remotePath === removedPath);
      if (item) removeMediaItem(item.id);
    }

    // Step 3: Process new files
    const newItems: MediaItem[] = [];
    const total = result.new_files.length;

    for (let idx = 0; idx < result.new_files.length; idx++) {
      const file = result.new_files[idx];

      setScanState({
        progress: Math.round((idx / total) * 100),
        newItemsFound: idx,
      });

      // Parse filename
      const parsed: ParsedTitle = await invoke("parse_media_filename", {
        filename: file.filename,
      });

      const id: string = await invoke("hash_remote_path", {
        remotePath: file.remote_path,
      });

      // Build base item
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

      // Step 4: Fetch metadata
      let meta: Partial<MediaItem> = {};

      if (library.type === "movies" && apiKeys.tmdb) {
        meta = await fetchTmdbMetadata(parsed.title, parsed.year, "movie", apiKeys.tmdb);
      } else if (library.type === "tv" && apiKeys.tmdb) {
        meta = await fetchTmdbMetadata(
          parsed.is_episode && parsed.title ? parsed.title : parsed.title,
          parsed.year,
          "tv",
          apiKeys.tmdb
        );
      } else if (library.type === "music") {
        meta = await fetchMusicBrainzMetadata(parsed.title);
      } else if (library.type === "books" || library.type === "audiobooks") {
        meta = await fetchOpenLibraryMetadata(parsed.title);
      } else if (library.type === "adult" && apiKeys.theporndb) {
        // ThePornDB fetch (basic)
        try {
          const res = await fetch(
            `https://theporndb.net/api/scenes?q=${encodeURIComponent(parsed.title)}`,
            { headers: { Authorization: `Bearer ${apiKeys.theporndb}` } }
          );
          if (res.ok) {
            const data = await res.json();
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
    }

    if (newItems.length > 0) {
      bulkUpsertMediaItems(newItems);
    }

    setScanState({
      status: "idle",
      progress: 100,
      lastScanAt: Date.now(),
      newItemsFound: newItems.length,
      currentLibrary: undefined,
    });

    return { newItems: newItems.length, removed: result.removed_paths.length };
  } catch (e) {
    setScanState({
      status: "error",
      lastError: e instanceof Error ? e.message : String(e),
      currentLibrary: undefined,
    });
    throw e;
  }
}

export async function scanAllLibraries() {
  const store = useAppStore.getState();
  const { libraries, tmdbApiKey, thePornDbApiKey } = store;

  const apiKeys = { tmdb: tmdbApiKey, theporndb: thePornDbApiKey };

  for (const library of libraries) {
    await scanLibrary(library, apiKeys);
  }
}

// Listen for scan progress events from Rust
export function listenScanProgress(cb: (event: unknown) => void) {
  return listen("scan-progress", (event) => cb(event.payload));
}
