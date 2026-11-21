import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useAppStore,
  type MediaItem,
  type Library,
  type PhotoGallery,
  type GalleryPhoto,
  isLocalPath,
} from "../store/appStore";
import { COMIC_EXTENSIONS, isComicExtension } from "./mediaTypes";
import { useToastStore } from "../store/toastStore";
import { log } from "./log";
import { syncExternalServerForLibraryId } from "./externalServers";

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

// ─── Throttled & Timed Fetch (Guaranteed Non-Blocking) ───────────────────────

let lastRequestTime = 0;
const MIN_REQUEST_GAP = 120; // ms between requests
const REQUEST_TIMEOUT_MS = 5000; // hard timeout per API call
let isQuotaExceeded = false; // Set only on a genuine rate-limit response

/** Hosts that have rate-limited us this scan; skipped until the scan restarts. */
const throttledHosts = new Set<string>();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function rateLimitedFetchWithTimeout(
  url: string,
  options: RequestInit = {}
): Promise<Response | null> {
  const now = Date.now();
  const wait = Math.max(0, MIN_REQUEST_GAP - (now - lastRequestTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with a real retry loop and per-host rate-limit tracking.
 *
 * Only 429 (and 503) mark a host as throttled — a 403 usually means a bad or
 * missing API key for *that* provider, so it must not silently disable
 * metadata for every other provider too.
 */
async function safeFetchApi(
  url: string,
  options?: RequestInit,
  retries = 2
): Promise<Response | null> {
  const host = hostOf(url);
  if (throttledHosts.has(host)) return null;

  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await rateLimitedFetchWithTimeout(url, options);
    lastResponse = resp;

    if (resp && resp.ok) return resp;

    if (resp && (resp.status === 429 || resp.status === 503)) {
      throttledHosts.add(host);
      isQuotaExceeded = true;
      return null;
    }

    // 4xx other than rate limits won't fix themselves — don't burn retries.
    if (resp && resp.status >= 400 && resp.status < 500) return resp;

    // Network error or 5xx: back off and retry.
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }

  return lastResponse;
}

// ─── Book & Audiobook Directory Helper ──────────────────────────────────────

const GENERIC_BOOK_FOLDERS = new Set([
  "book", "books", "audiobook", "audiobooks", "audio", "ebook", "ebooks",
  "epub", "epubs", "pdf", "pdfs", "misc", "other",
]);

export function isJunkBookFolder(folder: string): boolean {
  const f = folder.toLowerCase().trim();
  if (GENERIC_BOOK_FOLDERS.has(f)) return true;
  if (/^(archive|temp|tmp|download|downloads|disk|volume|part|folder|cache)[\d_]*$/i.test(f)) return true;
  if (/^[0-9a-f]{8,}$/i.test(f)) return true;
  if (/^\d+$/.test(f)) return true;
  return false;
}

export function extractBookInfo(
  remotePath: string,
  filename: string,
  remoteRoots: string[] = []
): { title: string; album?: string; author?: string; year?: number } {
  const root =
    remoteRoots.find((p) => remotePath.startsWith(p.replace(/\/$/, "") + "/")) ??
    remoteRoots[0] ??
    "";
  const rel = root ? remotePath.slice(root.replace(/\/$/, "").length + 1) : remotePath;

  const parts = rel.split("/").filter(Boolean);
  parts.pop(); // drop the filename; folders only

  const cleanParts = parts.filter((p) => !isJunkBookFolder(p));

  const fileNameNoExt = filename.replace(/\.[^/.]+$/, "");
  const cleanTitle = fileNameNoExt
    .replace(/^(\d+[\s._-]+|chapter[\s._-]+\d+[\s._-]*)/i, "")
    .replace(/\b(unabridged|abridged|audiobook|audiobooks|narrated by [^)]+|cd\s*\d+|disc\s*\d+|part\s*\d+|pt\s*\d+|\d+kbps)\b/gi, "")
    .replace(/\[.*?\]|\(.*?\)/g, "")
    .trim();

  let title = cleanTitle || fileNameNoExt;
  let album: string | undefined;
  let author: string | undefined;
  let year: number | undefined;

  if (cleanParts.length >= 2) {
    author = cleanParts[cleanParts.length - 2];
    const albumFolder = cleanParts[cleanParts.length - 1];
    const yMatch = albumFolder.match(/\((\d{4})\)$/);
    if (yMatch) {
      year = parseInt(yMatch[1], 10);
      album = albumFolder.replace(/\s*\(\d{4}\)$/, "").trim();
    } else {
      album = albumFolder;
    }
  } else if (cleanParts.length === 1) {
    const folder = cleanParts[0];
    if (folder.includes(" - ")) {
      const split = folder.split(" - ");
      author = split[0].trim();
      const rest = split.slice(1).join(" - ").trim();
      const yMatch = rest.match(/\((\d{4})\)$/);
      if (yMatch) {
        year = parseInt(yMatch[1], 10);
        album = rest.replace(/\s*\(\d{4}\)$/, "").trim();
      } else {
        album = rest;
      }
    } else {
      const yMatch = folder.match(/\((\d{4})\)$/);
      if (yMatch) {
        year = parseInt(yMatch[1], 10);
        album = folder.replace(/\s*\(\d{4}\)$/, "").trim();
      } else {
        album = folder;
      }
    }
  }

  // If author is missing or junk, or if filename contains " - " (Author - Title or Author - Series - Title)
  if (!author || isJunkBookFolder(author) || fileNameNoExt.includes(" - ")) {
    if (fileNameNoExt.includes(" - ")) {
      const split = fileNameNoExt.split(" - ");
      const candidateAuthor = split[0].trim();
      const rest = split.slice(1).join(" - ").trim();
      if (!isJunkBookFolder(candidateAuthor)) {
        author = candidateAuthor;
        const yMatch = rest.match(/\((\d{4})\)$/);
        if (yMatch) {
          year = parseInt(yMatch[1], 10);
          title = rest.replace(/\s*\(\d{4}\)$/, "").trim();
        } else {
          title = rest;
        }
        if (!album) album = title;
      }
    }
  }

  return {
    title,
    album,
    author: author && !isJunkBookFolder(author) ? author : undefined,
    year,
  };
}

// ─── Comic path & issue parsing ─────────────────────────────────────────────

export function extractComicInfo(
  remotePath: string,
  filename: string,
  libraryPaths: string[] = []
): {
  series: string;
  issue?: number;
  volume?: number;
  year?: number;
  cleanTitle: string;
} {
  const root =
    libraryPaths.find((p) => remotePath.startsWith(p.replace(/\/$/, "") + "/")) ??
    libraryPaths[0] ??
    "";
  const rel = root ? remotePath.slice(root.replace(/\/$/, "").length + 1) : remotePath;
  const parts = rel.split("/").filter(Boolean);
  parts.pop(); // drop filename

  const stem = filename.replace(/\.[^/.]+$/, "");

  // Match Year e.g. (2024)
  let year: number | undefined;
  const yearMatch = stem.match(/\((19\d\d|20\d\d)\)/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  }

  // Match Volume e.g. v01, Vol. 2
  let volume: number | undefined;
  const volMatch = stem.match(/\b(?:v|vol|volume)\.?\s*(\d+)\b/i);
  if (volMatch) {
    volume = parseInt(volMatch[1], 10);
  }

  // Match Issue Number: #01, #1, 001, Issue 5, c01, ch01
  let issue: number | undefined;
  const issueMatch = stem.match(/(?:#|issue\s*|ch\s*|c\s*|^|\s)(\d{1,4})(?:\.\d+)?(?:\s|$|\.|\)|\])/i);
  if (issueMatch) {
    issue = parseInt(issueMatch[1], 10);
  }

  // Derive series name from folder hierarchy or filename prefix
  let series = "";
  if (parts.length > 0) {
    series = parts[parts.length - 1].replace(/\s*\(\d{4}\)$/, "").trim();
  }
  if (!series) {
    // Strip issue/year/brackets from stem
    series = stem
      .replace(/\((?:19\d\d|20\d\d)\)/g, "")
      .replace(/\b(?:v|vol|volume)\.?\s*\d+\b/gi, "")
      .replace(/(?:#|issue\s*)\d+/gi, "")
      .replace(/\[.*?\]|\(.*?\)/g, "")
      .replace(/[-_]/g, " ")
      .trim();
  }

  const cleanTitle = issue !== undefined
    ? `${series || "Comic"} #${issue}`
    : stem.replace(/\[.*?\]|\(.*?\)/g, "").trim();

  return { series, issue, volume, year, cleanTitle };
}

// ─── Music path parsing ─────────────────────────────────────────────────────

/** Folder names that carry no artist information and should be skipped. */
const GENERIC_MUSIC_FOLDERS = new Set([
  "album", "albums", "music", "songs", "singles", "compilations",
  "various artists", "va", "misc", "other",
]);

/**
 * Derive artist / album / track from the folder layout.
 *
 * Libraries are almost always `Music/Artist/Album/Track.ext`, so the structure
 * already holds everything we need. Relying on a per-track MusicBrainz lookup
 * instead left the great majority of a 15k-track library filed under
 * "Unknown Artist" whenever matching failed or had not run yet.
 */
export function extractMusicInfo(
  remotePath: string,
  filename: string,
  remoteRoots: string[]
): { artist?: string; album?: string; title: string; trackNumber?: number; year?: number } {
  const root =
    remoteRoots.find((p) => remotePath.startsWith(p.replace(/\/$/, "") + "/")) ??
    remoteRoots[0] ??
    "";
  const rel = root ? remotePath.slice(root.replace(/\/$/, "").length + 1) : remotePath;

  const parts = rel.split("/").filter(Boolean);
  parts.pop(); // drop the filename; folders only

  // Skip container folders like "Music/Album/Artist/…".
  while (parts.length > 0 && GENERIC_MUSIC_FOLDERS.has(parts[0].toLowerCase())) {
    parts.shift();
  }

  let artist: string | undefined;
  let album: string | undefined;

  if (parts.length >= 2) {
    artist = parts[0];
    album = parts[parts.length - 1];
  } else if (parts.length === 1) {
    // A single folder is often "Artist - Album (Year)".
    const dash = parts[0].split(" - ");
    if (dash.length >= 2) {
      artist = dash[0].trim();
      album = dash.slice(1).join(" - ").trim();
    } else {
      album = parts[0];
    }
  }

  // A year in the album folder is worth keeping, but not in the display name.
  let year: number | undefined;
  if (album) {
    const m = album.match(/[[(](19\d\d|20\d\d)[\])]/);
    if (m) year = parseInt(m[1]);
    album = album
      .replace(/\[\d{6,}\]/g, "")        // catalogue ids
      .replace(/[[(](19\d\d|20\d\d)[\])]/g, "")
      .replace(/^\[E\]\s*/i, "")
      .trim();
  }

  const stem = filename.replace(/\.[^/.]+$/, "");

  // Leading track number, e.g. "05 - Title" or "12 Title".
  const trackMatch = stem.match(/^(\d{1,3})\s*[-._]?\s+/);
  let trackNumber = trackMatch ? parseInt(trackMatch[1]) : undefined;

  let title = trackMatch ? stem.slice(trackMatch[0].length) : stem;

  // Disc-track token anywhere before the title, e.g. "Ca$ino – 01-03 Birds & the Bees"
  // (album name first, then disc 01 track 03). Multi-disc sets keep global order via
  // disc*100+track; the album/artist prefix before the token is dropped from the title.
  if (trackNumber === undefined) {
    const dt = stem.match(/(?:^|\s)(\d{1,2})[-.](\d{2,3})\s+/);
    if (dt) {
      const disc = parseInt(dt[1]);
      const trk = parseInt(dt[2]);
      trackNumber = disc > 1 ? disc * 100 + trk : trk;
      title = stem.slice((dt.index ?? 0) + dt[0].length).trim();
    }
  }

  // If flat folder (no artist extracted) but filename has "Artist - Title" format
  // (hyphen, en dash, or em dash separators all occur in the wild)
  if (!artist && parts.length === 0) {
    const dashParts = title.split(/\s+[–—-]\s+/);
    if (dashParts.length >= 2) {
      artist = dashParts[0].trim();
      title = dashParts.slice(1).join(" - ").trim();
      const innerTrack = title.match(/^(\d{1,3})\s*[-._]?\s+/);
      if (innerTrack) {
        if (trackNumber === undefined) trackNumber = parseInt(innerTrack[1]);
        title = title.slice(innerTrack[0].length).trim();
      }
    }
  }

  // Scene files often repeat "Artist - " in the filename.
  if (artist && title.toLowerCase().startsWith(artist.toLowerCase() + " - ")) {
    title = title.slice(artist.length + 3);
  }
  title = title
    .replace(/[[(]explicit[\])]/gi, "")
    .replace(/[_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { artist, album, title: title || stem, trackNumber, year };
}

// ─── TV path parsing ────────────────────────────────────────────────────────

const GENERIC_TV_FOLDERS = new Set([
  "tv", "tv shows", "tv-shows", "tvshows", "shows", "series",
  "television", "videos", "video", "episodes",
]);

export function extractTvInfo(
  remotePath: string,
  filename: string,
  remoteRoots: string[]
): {
  showTitle?: string;
  season?: number;
  episode?: number;
  year?: number;
  cleanTitle?: string;
} {
  const root =
    remoteRoots.find((p) => remotePath.startsWith(p.replace(/\/$/, "") + "/")) ??
    remoteRoots[0] ??
    "";
  const rel = root ? remotePath.slice(root.replace(/\/$/, "").length + 1) : remotePath;

  const parts = rel.split("/").filter(Boolean);
  parts.pop(); // remove filename, keep folders only

  // Skip top-level container folders like "TV Shows", "Series", etc.
  while (parts.length > 0 && GENERIC_TV_FOLDERS.has(parts[0].toLowerCase())) {
    parts.shift();
  }

  let season: number | undefined;
  let showFolder: string | undefined;

  // Check if the deepest folder is a season folder, e.g. "Season 1", "Season 02", "Specials", "S01"
  if (parts.length > 0) {
    const lastFolder = parts[parts.length - 1];
    const seasonMatch =
      lastFolder.match(/^(?:Season|Series|Staffel|Saison)\s*(\d{1,2})$/i) ||
      lastFolder.match(/^S(\d{1,2})$/i);
    const isSpecials = /^(?:Specials?|Season\s*0)$/i.test(lastFolder);

    if (seasonMatch) {
      season = parseInt(seasonMatch[1], 10);
      parts.pop();
    } else if (isSpecials) {
      season = 0;
      parts.pop();
    }
  }

  if (parts.length > 0) {
    showFolder = parts[parts.length - 1];
  }

  let showTitle: string | undefined;
  let year: number | undefined;

  if (showFolder) {
    const yMatch = showFolder.match(/[[(](19\d\d|20\d\d)[\])]/);
    if (yMatch) {
      year = parseInt(yMatch[1], 10);
    }
    showTitle = showFolder
      .replace(/[[(](19\d\d|20\d\d)[\])]/g, "")
      .replace(/\[.*?\]/g, "")
      .replace(/[_.]+/g, " ")
      .trim();
  }

  // Episode and Season extraction from filename
  const stem = filename.replace(/\.[^/.]+$/, "");
  let episode: number | undefined;
  let cleanTitle: string | undefined;

  // 1. S01E02 or S1E2 pattern
  const sMatch = stem.match(/[sS](\d{1,2})[eE](\d{1,2})/);
  if (sMatch) {
    if (season === undefined) season = parseInt(sMatch[1], 10);
    episode = parseInt(sMatch[2], 10);
    if (!showTitle && sMatch.index && sMatch.index > 0) {
      const before = stem.slice(0, sMatch.index).replace(/[_.]+/g, " ").trim();
      if (before.length > 1) {
        showTitle = before;
      }
    }
    const after = stem.slice(sMatch.index! + sMatch[0].length).replace(/^[\s._-]+/, "").trim();
    if (after) {
      cleanTitle = after.replace(/[_.]+/g, " ").replace(/\s{2,}/g, " ").trim();
    }
  } else {
    // 2. 1x02 pattern
    const altMatch = stem.match(/\b(\d{1,2})x(\d{1,2})\b/);
    if (altMatch) {
      if (season === undefined) season = parseInt(altMatch[1], 10);
      episode = parseInt(altMatch[2], 10);
      if (!showTitle && altMatch.index && altMatch.index > 0) {
        const before = stem.slice(0, altMatch.index).replace(/[_.]+/g, " ").trim();
        if (before.length > 1) {
          showTitle = before;
        }
      }
      const after = stem.slice(altMatch.index! + altMatch[0].length).replace(/^[\s._-]+/, "").trim();
      if (after) {
        cleanTitle = after.replace(/[_.]+/g, " ").replace(/\s{2,}/g, " ").trim();
      }
    } else {
      // 3. Just episode number, e.g. "01.mkv" or "01 - Pilot.mkv" or "Episode 1"
      const epOnlyMatch =
        stem.match(/\b(?:ep|episode|e)[._\s-]*(\d{1,3})\b/i) ||
        stem.match(/^(\d{1,3})(?:[\s._-]+|$)/);
      if (epOnlyMatch) {
        episode = parseInt(epOnlyMatch[1], 10);
      } else {
        // 4. Anime absolute episode number: [ReleaseGroup] Show Title - 01 [1080p] or Show Title - 12v2
        const animeMatch = stem.match(/[-_\s](\d{1,4})(?:[vV]\d)?(?:\s*\[|\s*\(|$|[\s._-])/);
        if (animeMatch) {
          const parsed = parseInt(animeMatch[1], 10);
          if (!isNaN(parsed) && parsed > 0 && parsed < 2000) {
            episode = parsed;
            if (season === undefined) season = 1;
          }
        }
      }
    }
  }

  return {
    showTitle,
    season,
    episode,
    year,
    cleanTitle,
  };
}

/**
 * Construct standardized, safe filenames:
 * - For Movies: {Title} ({Year}).{ext}
 * - For TV: {Show} - S{xx}E{yy} - {EpisodeTitle}.{ext}
 * - For Music: {TrackNumber} - {Title}.{ext} or {Artist} - {Title}.{ext}
 * - Clean illegal filesystem characters (<>:"/\|?*).
 * - Limit to 180 characters to avoid Windows / Android path length issues.
 */
export function buildCanonicalFilename(
  item: Partial<MediaItem> & { mediaType?: string; cleanTitle?: string }
): string {
  const ext = (item.filename?.split(".").pop() || item.remotePath?.split(".").pop() || "mp4").toLowerCase();
  let base = "";

  const isTv =
    item.libraryType === "tv" ||
    item.mediaType === "tv" ||
    (item.season !== undefined && item.episode !== undefined);
  const isMusic =
    item.libraryType === "music" ||
    item.mediaType === "music" ||
    (item.artist !== undefined && (item.trackNumber !== undefined || item.album !== undefined));
  const isMovie = item.libraryType === "movies" || item.mediaType === "movie";

  if (isTv) {
    const s = String(item.season ?? 1).padStart(2, "0");
    const e = String(item.episode ?? 1).padStart(2, "0");
    const show = item.showTitle || item.title || "Show";
    const epTitle = item.cleanTitle || item.episodeTitle || (item.title && item.title !== show ? item.title : "");
    base = epTitle ? `${show} - S${s}E${e} - ${epTitle}` : `${show} - S${s}E${e}`;
  } else if (isMusic) {
    if (item.trackNumber !== undefined) {
      const track = String(item.trackNumber).padStart(2, "0");
      base = item.artist ? `${track} - ${item.artist} - ${item.title}` : `${track} - ${item.title}`;
    } else if (item.artist) {
      base = `${item.artist} - ${item.title}`;
    } else {
      base = item.title || "track";
    }
  } else if (isMovie) {
    base = item.year ? `${item.title} (${item.year})` : (item.title || "movie");
  } else {
    base = item.title || item.filename || "media";
  }

  const sanitized = base.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim();
  const maxBaseLen = 180 - ext.length - 1;
  const truncated = sanitized.length > maxBaseLen ? sanitized.slice(0, maxBaseLen).trim() : sanitized;
  return `${truncated || "media"}.${ext}`;
}

// ─── Metadata fetchers (Guaranteed Safe) ────────────────────────────────────

export async function fetchCinemetaMovie(
  title: string,
  year: number | undefined
): Promise<Partial<MediaItem>> {
  try {
    const q = encodeURIComponent(title);
    const resp = await safeFetchApi(
      `https://v3-cinemeta.strem.io/catalog/movie/top/search=${q}.json`
    );
    if (!resp || !resp.ok) return {};
    const data = await resp.json();
    const metas: any[] = data.metas ?? [];
    if (metas.length === 0) return {};

    // Match scoring:
    // 1. Exact title match (case-insensitive) with matching year (exact or ±1)
    // 2. Exact title match (case-insensitive)
    // 3. Exact year match
    // 4. Near year match (±1 year)
    // 5. Fallback to first result
    const normTitle = title.toLowerCase().trim();
    let matched = metas[0];

    const exactTitleAndYear = metas.find((m) => {
      const name = String(m.name || "").toLowerCase().trim();
      if (name !== normTitle) return false;
      if (!year) return true;
      const y = parseInt(String(m.releaseInfo || m.year || "").split("-")[0]);
      return !isNaN(y) && Math.abs(y - year) <= 1;
    });

    const exactTitle = metas.find((m) => {
      const name = String(m.name || "").toLowerCase().trim();
      return name === normTitle;
    });

    const exactYear = year
      ? metas.find((m) => {
          const y = parseInt(String(m.releaseInfo || m.year || "").split("-")[0]);
          return y === year;
        })
      : undefined;

    matched = exactTitleAndYear ?? exactTitle ?? exactYear ?? metas[0];

    if (!matched?.id) return {};

    let fullMeta: any = matched;
    try {
      const detailResp = await safeFetchApi(
        `https://v3-cinemeta.strem.io/meta/movie/${matched.id}.json`
      );
      if (detailResp && detailResp.ok) {
        const detailData = await detailResp.json();
        if (detailData?.meta) fullMeta = detailData.meta;
      }
    } catch {}

    const rawYear = fullMeta.year || fullMeta.releaseInfo;
    const resYear = rawYear ? parseInt(String(rawYear).split("-")[0]) : year;

    return {
      title: fullMeta.name ?? title,
      year: isNaN(resYear as number) ? year : resYear,
      posterUrl: fullMeta.poster,
      backdropUrl: fullMeta.background,
      overview: fullMeta.description,
      rating: fullMeta.imdbRating ? parseFloat(fullMeta.imdbRating) : undefined,
      metadataId: fullMeta.id,
      metadataSource: "cinemeta" as const,
      metadataConfidence: "high" as const,
    };
  } catch {
    return {};
  }
}

const cinemetaSeriesCache = new Map<string, any>();

/** Folder-level caches guaranteeing all sibling episodes or tracks in the same directory tree share the exact same metadata match */
export const tvFolderSeriesCache = new Map<string, Partial<MediaItem>>();
export const musicFolderAlbumCache = new Map<string, Partial<MediaItem>>();
export const bookFolderAlbumCache = new Map<string, Partial<MediaItem>>();

export function clearFolderMetadataCaches() {
  tvFolderSeriesCache.clear();
  musicFolderAlbumCache.clear();
  bookFolderAlbumCache.clear();
}

export function getTvShowFolderKey(
  remotePath: string,
  rootRemotePath?: string,
  parsedTitle?: string
): string {
  const parts = remotePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 1) return remotePath;
  parts.pop(); // remove filename
  // If deepest folder is Season XX, Specials, SXX, strip it to point to show directory
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (
      /^(?:Season|Series|Staffel|Saison)\s*\d+$/i.test(last) ||
      /^S\d{1,2}$/i.test(last) ||
      /^(?:Specials?|Season\s*0)$/i.test(last)
    ) {
      parts.pop();
    }
  }
  const folder = parts.join("/");
  if (rootRemotePath) {
    const cleanRoot = rootRemotePath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (folder === cleanRoot || folder === cleanRoot.replace(/\/+$/, "")) {
      return `${folder}::${(parsedTitle || "").toLowerCase().trim()}`;
    }
  }
  return folder;
}

export function getAlbumFolderKey(remotePath: string): string {
  const parts = remotePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 1) return remotePath;
  parts.pop(); // remove filename
  return parts.join("/");
}

export function getBookFolderKey(remotePath: string): string {
  const parts = remotePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 1) return remotePath;
  parts.pop(); // remove filename
  return parts.join("/");
}

export async function fetchCinemetaTv(
  showTitle: string,
  season: number | undefined,
  episode: number | undefined
): Promise<Partial<MediaItem>> {
  try {
    const cacheKey = showTitle.trim().toLowerCase();
    let meta = cinemetaSeriesCache.get(cacheKey);

    if (!meta) {
      const q = encodeURIComponent(showTitle);
      const searchResp = await safeFetchApi(
        `https://v3-cinemeta.strem.io/catalog/series/top/search=${q}.json`
      );
      if (!searchResp || !searchResp.ok) return {};
      const searchData = await searchResp.json();
      const series = searchData.metas?.[0];
      if (!series?.id) return {};

      const detailResp = await safeFetchApi(
        `https://v3-cinemeta.strem.io/meta/series/${series.id}.json`
      );
      if (!detailResp || !detailResp.ok) return {};
      const detailData = await detailResp.json();
      meta = detailData?.meta;
      if (!meta) return {};
      cinemetaSeriesCache.set(cacheKey, meta);
    }

    const showPosterUrl = meta.poster;
    const showBackdropUrl = meta.background;

    let episodeTitle: string | undefined;
    let thumbUrl: string | undefined;
    let episodeOverview: string | undefined;
    let episodeRating: number | undefined;

    if (season !== undefined && episode !== undefined && Array.isArray(meta.videos)) {
      const ep = meta.videos.find(
        (v: any) =>
          Number(v.season) === season &&
          (Number(v.episode) === episode || Number(v.number) === episode)
      );
      if (ep) {
        episodeTitle = ep.name || ep.title;
        thumbUrl = ep.thumbnail;
        episodeOverview = ep.overview || ep.description;
        if (ep.rating) episodeRating = parseFloat(ep.rating);
      }
    }

    const rawYear = meta.year || meta.releaseInfo;
    const yearVal = rawYear ? parseInt(String(rawYear).split("-")[0]) : undefined;

    const resolvedEpisodeTitle = episodeTitle;
    const resolvedTitle =
      resolvedEpisodeTitle ||
      (meta.name && season !== undefined && episode !== undefined
        ? `${meta.name} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
        : meta.name ?? showTitle);

    return {
      title: resolvedTitle,
      showTitle: meta.name ?? showTitle,
      showId: meta.id,
      showPosterUrl,
      showBackdropUrl,
      showOverview: meta.description,
      posterUrl: showPosterUrl || thumbUrl,
      backdropUrl: showBackdropUrl,
      thumbUrl,
      episodeTitle: resolvedEpisodeTitle,
      overview: episodeOverview || meta.description,
      year: yearVal && !isNaN(yearVal) ? yearVal : undefined,
      rating: episodeRating ?? (meta.imdbRating ? parseFloat(meta.imdbRating) : undefined),
      metadataId: meta.id,
      metadataSource: "cinemeta" as const,
      metadataConfidence: "high" as const,
    };
  } catch {
    return {};
  }
}


async function fetchTmdbMovie(
  title: string,
  year: number | undefined,
  apiKey: string
): Promise<Partial<MediaItem>> {
  try {
    const q = encodeURIComponent(title);
    const yearParam = year ? `&year=${year}` : "";
    const resp = await safeFetchApi(
      `https://api.themoviedb.org/3/search/movie?query=${q}${yearParam}&language=en-US&page=1`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!resp || !resp.ok) return {};
    const data = await resp.json();
    const r = data.results?.[0];
    if (!r) return {};
    return {
      title: r.title ?? title,
      year: r.release_date ? parseInt(r.release_date.split("-")[0]) : year,
      posterUrl: r.poster_path
        ? `https://image.tmdb.org/t/p/w342${r.poster_path}`
        : undefined,
      backdropUrl: r.backdrop_path
        ? `https://image.tmdb.org/t/p/w780${r.backdrop_path}`
        : undefined,
      overview: r.overview,
      rating: r.vote_average,
      metadataId: String(r.id),
      metadataSource: "tmdb" as const,
      metadataConfidence: "high" as const,
    };
  } catch {
    return {};
  }
}

async function fetchTmdbTv(
  showTitle: string,
  season: number | undefined,
  episode: number | undefined,
  apiKey: string
): Promise<Partial<MediaItem>> {
  try {
    const q = encodeURIComponent(showTitle);
    const searchResp = await safeFetchApi(
      `https://api.themoviedb.org/3/search/tv?query=${q}&language=en-US&page=1`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!searchResp || !searchResp.ok) return {};
    const searchData = await searchResp.json();
    const show = searchData.results?.[0];
    if (!show) return {};

    const showPosterUrl = show.poster_path
      ? `https://image.tmdb.org/t/p/w342${show.poster_path}`
      : undefined;
    const showBackdropUrl = show.backdrop_path
      ? `https://image.tmdb.org/t/p/w780${show.backdrop_path}`
      : undefined;

    let episodeTitle: string | undefined;
    let thumbUrl: string | undefined;

    if (season && episode) {
      try {
        const epResp = await safeFetchApi(
          `https://api.themoviedb.org/3/tv/${show.id}/season/${season}/episode/${episode}?language=en-US`,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        );
        if (epResp && epResp.ok) {
          const epData = await epResp.json();
          episodeTitle = epData.name;
          thumbUrl = epData.still_path
            ? `https://image.tmdb.org/t/p/w300${epData.still_path}`
            : undefined;
        }
      } catch {}
    }

    const resolvedEpisodeTitle = episodeTitle;
    const resolvedTitle =
      resolvedEpisodeTitle ||
      (show.name && season !== undefined && episode !== undefined
        ? `${show.name} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
        : show.name ?? showTitle);

    return {
      title: resolvedTitle,
      showTitle: show.name ?? showTitle,
      showId: String(show.id),
      showPosterUrl,
      showBackdropUrl,
      showOverview: show.overview,
      posterUrl: showPosterUrl || thumbUrl,
      backdropUrl: showBackdropUrl,
      thumbUrl,
      episodeTitle: resolvedEpisodeTitle,
      year: show.first_air_date
        ? parseInt(show.first_air_date.split("-")[0])
        : undefined,
      rating: show.vote_average,
      metadataId: String(show.id),
      metadataSource: "tmdb" as const,
      metadataConfidence: "high" as const,
    };
  } catch {
    return {};
  }
}

/** In-memory cache for album metadata so tracks in the same album share 1 network request. */
export const musicAlbumCache = new Map<string, Partial<MediaItem>>();

export function clearMusicAlbumCache() {
  musicAlbumCache.clear();
}

export async function fetchMusicMetadata(
  artist?: string,
  album?: string,
  title?: string
): Promise<Partial<MediaItem>> {
  const cleanArtist = (artist ?? "").trim();
  const cleanAlbum = (album ?? "").trim();
  const cleanTitle = (title ?? "").trim();

  // 1. Album cache check
  const albumKey =
    cleanArtist && cleanAlbum
      ? `${cleanArtist.toLowerCase()}:::${cleanAlbum.toLowerCase()}`
      : null;

  if (albumKey && musicAlbumCache.has(albumKey)) {
    const cached = musicAlbumCache.get(albumKey)!;
    if (cached.metadataSource === ("none" as any)) {
      // Known negative album match; skip repeating the album search on iTunes/Deezer
    } else {
      return { ...cached };
    }
  }

  const skipAlbumSearch =
    albumKey ? musicAlbumCache.get(albumKey)?.metadataSource === ("none" as any) : false;

  // 2. Primary: iTunes Search API
  try {
    // 2A. Search for Album if both artist and album are available and not known absent
    if (cleanArtist && cleanAlbum && !skipAlbumSearch) {
      const itunesAlbumUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(`${cleanArtist} ${cleanAlbum}`)}&entity=album&limit=1`;
      const resp = await safeFetchApi(itunesAlbumUrl);
      if (resp && resp.ok) {
        const data = await resp.json();
        const col = data.results?.[0];
        if (col && (col.collectionName || col.artistName)) {
          const rawPoster = col.artworkUrl100 as string | undefined;
          const posterUrl = rawPoster
            ? rawPoster.replace(/\/\d+x\d+bb\./, "/600x600bb.")
            : undefined;
          const year = col.releaseDate
            ? parseInt(col.releaseDate.split("-")[0])
            : undefined;
          const meta: Partial<MediaItem> = {
            posterUrl,
            year,
            genres: col.primaryGenreName ? [col.primaryGenreName] : undefined,
            artist: col.artistName || cleanArtist,
            album: col.collectionName || cleanAlbum,
            metadataId: String(col.collectionId),
            metadataSource: "itunes" as const,
            metadataConfidence: "high" as const,
          };
          if (albumKey) musicAlbumCache.set(albumKey, meta);
          return meta;
        }
      }
    }

    // 2B. Search for Song/Track (if no album match or album is missing)
    const songQuery = cleanArtist ? `${cleanArtist} ${cleanTitle}` : cleanTitle;
    if (songQuery.trim()) {
      const itunesSongUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(songQuery)}&media=music&entity=song&limit=1`;
      const resp = await safeFetchApi(itunesSongUrl);
      if (resp && resp.ok) {
        const data = await resp.json();
        const trk = data.results?.[0];
        if (trk) {
          const rawPoster = trk.artworkUrl100 as string | undefined;
          const posterUrl = rawPoster
            ? rawPoster.replace(/\/\d+x\d+bb\./, "/600x600bb.")
            : undefined;
          const year = trk.releaseDate
            ? parseInt(trk.releaseDate.split("-")[0])
            : undefined;
          const duration = trk.trackTimeMillis
            ? Math.round(trk.trackTimeMillis / 1000)
            : undefined;
          const meta: Partial<MediaItem> = {
            posterUrl,
            year,
            duration,
            genres: trk.primaryGenreName ? [trk.primaryGenreName] : undefined,
            artist: trk.artistName || cleanArtist,
            album: trk.collectionName || cleanAlbum,
            trackNumber: trk.trackNumber,
            metadataId: String(trk.trackId),
            metadataSource: "itunes" as const,
            metadataConfidence: "high" as const,
          };
          if (albumKey && posterUrl && (!musicAlbumCache.has(albumKey) || musicAlbumCache.get(albumKey)?.metadataSource === ("none" as any))) {
            musicAlbumCache.set(albumKey, {
              posterUrl,
              year,
              genres: meta.genres,
              artist: meta.artist,
              album: meta.album,
              metadataSource: "itunes" as const,
              metadataConfidence: "high" as const,
            });
          }
          return meta;
        }
      }
    }
  } catch {}

  // 3. Secondary: Deezer Search API
  try {
    if (cleanArtist && cleanAlbum && !skipAlbumSearch) {
      const deezerAlbumUrl = `https://api.deezer.com/search/album?q=${encodeURIComponent(`${cleanArtist} ${cleanAlbum}`)}&limit=1`;
      const resp = await safeFetchApi(deezerAlbumUrl);
      if (resp && resp.ok) {
        const data = await resp.json();
        const alb = data.data?.[0];
        if (alb) {
          const posterUrl = alb.cover_xl || alb.cover_big || alb.cover_medium;
          const meta: Partial<MediaItem> = {
            posterUrl,
            artist: alb.artist?.name || cleanArtist,
            album: alb.title || cleanAlbum,
            metadataId: String(alb.id),
            metadataSource: "deezer" as const,
            metadataConfidence: "high" as const,
          };
          if (albumKey) musicAlbumCache.set(albumKey, meta);
          return meta;
        }
      }
    }

    // Both iTunes and Deezer album search failed: cache negative result so other tracks in this album skip album search
    if (albumKey && cleanArtist && cleanAlbum && !skipAlbumSearch && !musicAlbumCache.has(albumKey)) {
      musicAlbumCache.set(albumKey, { metadataSource: "none" as any });
    }

    const deezerTrackQuery = cleanArtist ? `${cleanArtist} ${cleanTitle}` : cleanTitle;
    if (deezerTrackQuery.trim()) {
      const deezerTrackUrl = `https://api.deezer.com/search?q=${encodeURIComponent(deezerTrackQuery)}&limit=1`;
      const resp = await safeFetchApi(deezerTrackUrl);
      if (resp && resp.ok) {
        const data = await resp.json();
        const trk = data.data?.[0];
        if (trk) {
          const posterUrl =
            trk.album?.cover_xl || trk.album?.cover_big || trk.album?.cover_medium;
          const meta: Partial<MediaItem> = {
            posterUrl,
            duration: trk.duration,
            artist: trk.artist?.name || cleanArtist,
            album: trk.album?.title || cleanAlbum,
            metadataId: String(trk.id),
            metadataSource: "deezer" as const,
            metadataConfidence: "high" as const,
          };
          if (albumKey && posterUrl && (!musicAlbumCache.has(albumKey) || musicAlbumCache.get(albumKey)?.metadataSource === ("none" as any))) {
            musicAlbumCache.set(albumKey, {
              posterUrl,
              artist: meta.artist,
              album: meta.album,
              metadataSource: "deezer" as const,
              metadataConfidence: "high" as const,
            });
          }
          return meta;
        }
      }
    }
  } catch {}

  // 4. Tertiary Fallback: MusicBrainz
  try {
    const mbQuery = cleanArtist && cleanTitle
      ? `artist:${cleanArtist} AND recording:${cleanTitle}`
      : cleanTitle
      ? `recording:${cleanTitle}`
      : "";
    if (mbQuery) {
      const mbMeta = await fetchMusicBrainz(mbQuery);
      if (mbMeta.posterUrl || mbMeta.metadataId) {
        if (albumKey && mbMeta.posterUrl) {
          musicAlbumCache.set(albumKey, mbMeta);
        }
        return mbMeta;
      }
    }
  } catch {}

  return {};
}

export async function fetchMusicBrainz(title: string): Promise<Partial<MediaItem>> {
  try {
    const resp = await safeFetchApi(
      `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(title)}&limit=1&fmt=json`,
      {
        headers: {
          "User-Agent": "RcloneFlix/0.5.2 (https://github.com/Ashim3000/rcloneflix)",
        },
      }
    );
    if (!resp || !resp.ok) return {};
    const data = await resp.json();
    const r = data.recordings?.[0];
    if (!r) return {};

    const release = r.releases?.[0];
    let posterUrl: string | undefined;
    if (release?.id) {
      try {
        const caaResp = await safeFetchApi(
          `https://coverartarchive.org/release/${release.id}`
        );
        if (caaResp && caaResp.ok) {
          const caaData = await caaResp.json();
          posterUrl =
            caaData.images?.[0]?.thumbnails?.["500"] ??
            caaData.images?.[0]?.thumbnails?.["250"] ??
            caaData.images?.[0]?.thumbnails?.small ??
            caaData.images?.[0]?.image;
        }
      } catch {}
    }

    return {
      title: r.title ?? title,
      artist: r["artist-credit"]?.[0]?.name,
      album: release?.title,
      year: release?.date ? parseInt(release.date.split("-")[0]) : undefined,
      posterUrl,
      metadataId: r.id,
      metadataSource: "musicbrainz" as const,
      metadataConfidence: "high" as const,
    };
  } catch {
    return {};
  }
}

/** In-memory cache for book / audiobook metadata so all chapters/files share 1 network request */
export const bookAlbumCache = new Map<string, Partial<MediaItem>>();

export function clearBookAlbumCache() {
  bookAlbumCache.clear();
}

function cleanBookTitleForSearch(text: string): string {
  return text
    .replace(/\b(unabridged|abridged|audiobook|audiobooks|narrated by [^)]+|narrated by [^\]]+|cd\s*\d+|disc\s*\d+|part\s*\d+|pt\s*\d+|\d+kbps)\b/gi, "")
    .replace(/\(.*?\)|\[.*?\]/g, "") // remove parenthetical/bracket tags
    .replace(/^(\d+[\s._-]+|chapter[\s._-]+\d+[\s._-]*)/i, "") // remove leading track/chapter numbers
    .replace(/\.(m4b|m4a|mp3|epub|pdf|azw3|mobi)$/i, "") // remove extensions
    .replace(/[^\w\s]/g, " ") // keep alphanumeric
    .replace(/\s+/g, " ")
    .trim();
}

export function isTitleMatch(queryTitle: string, candidateTitle: string): boolean {
  if (!queryTitle || !candidateTitle) return true;
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const q = normalize(queryTitle);
  const c = normalize(candidateTitle);
  if (!q || !c) return true;
  if (q.includes(c) || c.includes(q)) return true;
  const qWords = q.split(" ").filter((w) => w.length > 2);
  const cWords = new Set(c.split(" ").filter((w) => w.length > 2));
  if (qWords.length === 0) return true;
  const matches = qWords.filter((w) => cWords.has(w)).length;
  return matches / qWords.length >= 0.4;
}

export function isAuthorMatch(queryAuthor?: string, candidateAuthor?: string): boolean {
  if (!queryAuthor || !candidateAuthor) return true;
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const q = normalize(queryAuthor);
  const c = normalize(candidateAuthor);
  if (!q || !c) return true;
  if (q.includes(c) || c.includes(q)) return true;
  const qWords = q.split(" ").filter((w) => w.length > 2);
  const cWords = new Set(c.split(" ").filter((w) => w.length > 2));
  if (qWords.length === 0) return true;
  const matches = qWords.filter((w) => cWords.has(w)).length;
  return matches / qWords.length >= 0.4;
}

export async function fetchItunesBookOrAudiobookMetadata(
  title: string,
  author?: string,
  mediaType: "audiobooks" | "books" = "audiobooks"
): Promise<Partial<MediaItem>> {
  const cleanTitle = cleanBookTitleForSearch(title);
  const cleanAuthor = author ? cleanBookTitleForSearch(author) : "";
  const isUnknownAuthor =
    !cleanAuthor ||
    cleanAuthor.toLowerCase() === "unknown author" ||
    cleanAuthor.toLowerCase() === "unknown";

  const isAudiobook = mediaType === "audiobooks";
  const itunesMedia = isAudiobook ? "audiobook" : "ebook";
  const itunesEntity = isAudiobook ? "audiobook" : "ebook";

  const queries: string[] = [];
  if (!isUnknownAuthor) {
    queries.push(`${cleanTitle} ${cleanAuthor}`);
  }
  queries.push(cleanTitle);

  for (const q of queries) {
    try {
      const resp = await safeFetchApi(
        `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=${itunesMedia}&entity=${itunesEntity}&limit=3`
      );
      if (resp && resp.ok) {
        const data = await resp.json();
        const results = data.results || [];
        for (const r of results) {
          const resolvedTitle = isAudiobook
            ? (r.collectionName || r.trackName || cleanTitle)
            : (r.trackName || r.collectionName || cleanTitle);
          const foundAuthor = r.artistName || (isUnknownAuthor ? undefined : cleanAuthor);

          if (!isTitleMatch(cleanTitle, resolvedTitle)) continue;
          if (!isUnknownAuthor && foundAuthor && !isAuthorMatch(cleanAuthor, foundAuthor)) continue;

          const rawPoster = r.artworkUrl100 as string | undefined;
          const poster = rawPoster ? rawPoster.replace(/\/\d+x\d+bb\./, "/600x600bb.") : undefined;
          const y = r.releaseDate ? parseInt(r.releaseDate.split("-")[0], 10) : undefined;
          return {
            title: resolvedTitle,
            author: foundAuthor,
            artist: foundAuthor,
            album: r.collectionName || resolvedTitle,
            year: isNaN(y as number) ? undefined : y,
            posterUrl: poster,
            overview: r.description ? r.description.replace(/<[^>]*>/g, "").trim() : undefined,
            genres: r.genres || (r.primaryGenreName ? [r.primaryGenreName] : undefined),
            metadataId: String(r.collectionId || r.trackId || ""),
            metadataSource: "itunes" as const,
            metadataConfidence: "high" as const,
          };
        }
      }
    } catch {}
  }
  return {};
}

export async function fetchItunesAudiobookMetadata(
  title: string,
  author?: string
): Promise<Partial<MediaItem>> {
  return fetchItunesBookOrAudiobookMetadata(title, author, "audiobooks");
}

export async function fetchGoogleBooksMetadata(
  title: string,
  author?: string
): Promise<Partial<MediaItem>> {
  const cleanTitle = cleanBookTitleForSearch(title);
  const cleanAuthor = author ? cleanBookTitleForSearch(author) : "";
  const isUnknownAuthor =
    !cleanAuthor ||
    cleanAuthor.toLowerCase() === "unknown author" ||
    cleanAuthor.toLowerCase() === "unknown";

  const queries: string[] = [];
  if (!isUnknownAuthor) {
    queries.push(`intitle:"${cleanTitle}" inauthor:"${cleanAuthor}"`);
    queries.push(`"${cleanTitle}" "${cleanAuthor}"`);
  }
  queries.push(`intitle:"${cleanTitle}"`);
  queries.push(`"${cleanTitle}"`);

  for (const q of queries) {
    try {
      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=3`;
      const resp = await safeFetchApi(url);
      if (!resp || !resp.ok) continue;
      const data = await resp.json();
      const items = data.items as any[];
      if (!items || items.length === 0) continue;

      for (const item of items) {
        const vi = item.volumeInfo;
        if (!vi) continue;
        const imgLinks = vi.imageLinks;
        let posterUrl: string | undefined;
        if (imgLinks) {
          const rawImg =
            imgLinks.extraLarge ||
            imgLinks.large ||
            imgLinks.medium ||
            imgLinks.small ||
            imgLinks.thumbnail;
          if (rawImg) {
            // Storyleaf win: rewrite zoom=1 to zoom=2 for crisp high-res covers
            posterUrl = String(rawImg)
              .replace(/zoom=1/g, "zoom=2")
              .replace(/^http:/, "https:");
          }
        }

        const year = vi.publishedDate ? parseInt(vi.publishedDate.split("-")[0]) : undefined;
        const foundAuthor = vi.authors?.[0] || (isUnknownAuthor ? undefined : cleanAuthor);

        if (posterUrl || vi.description) {
          return {
            title: vi.title || cleanTitle,
            author: foundAuthor,
            artist: foundAuthor,
            year,
            posterUrl,
            overview: vi.description,
            genres: vi.categories,
            metadataId: item.id,
            metadataSource: "googlebooks" as const,
            metadataConfidence: "high" as const,
          };
        }
      }
    } catch {}
  }

  return {};
}

export async function fetchAudnexusMetadata(
  title: string,
  author?: string
): Promise<Partial<MediaItem>> {
  const cleanTitle = cleanBookTitleForSearch(title);
  // Audnexus API does not support search endpoints; only direct ASIN lookups work: /books/{asin}
  const isAsin = /^[B0-9][A-Z0-9]{9}$/i.test(cleanTitle.trim());
  if (!isAsin) {
    return {};
  }

  try {
    const url = `https://api.audnex.us/books/${encodeURIComponent(cleanTitle.trim())}`;
    const resp = await safeFetchApi(url);
    if (resp && resp.ok) {
      const b = await resp.json();
      if (b && (b.title || b.asin)) {
        const posterUrl = b.image || b.cover || b.thumbnail;
        const authors = Array.isArray(b.authors)
          ? b.authors.map((a: any) => a.name || a).join(", ")
          : b.author;
        const year = b.releaseDate ? parseInt(b.releaseDate.split("-")[0]) : undefined;
        return {
          title: b.title || cleanTitle,
          author: authors,
          artist: authors,
          album: b.title || cleanTitle,
          year,
          posterUrl,
          overview: b.summary || b.description,
          genres: b.genres,
          metadataId: b.asin || String(b.id || ""),
          metadataSource: "audnexus" as const,
          metadataConfidence: "high" as const,
        };
      }
    }
  } catch {}

  return {};
}

export async function fetchOpenLibrary(
  bookTitle: string,
  author?: string
): Promise<Partial<MediaItem>> {
  const cleanTitle = cleanBookTitleForSearch(bookTitle);
  const cleanAuthor = author ? cleanBookTitleForSearch(author) : "";
  const isUnknownAuthor =
    !cleanAuthor ||
    cleanAuthor.toLowerCase() === "unknown author" ||
    cleanAuthor.toLowerCase() === "unknown";

  const queries: string[] = [];
  const fields = "fields=key,title,author_name,first_publish_year,subject,cover_i,first_sentence";
  if (!isUnknownAuthor) {
    queries.push(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanTitle + " " + cleanAuthor)}&${fields}&limit=3`
    );
  }
  queries.push(`https://openlibrary.org/search.json?q=${encodeURIComponent(cleanTitle)}&${fields}&limit=3`);

  for (const url of queries) {
    try {
      const resp = await safeFetchApi(url);
      if (!resp || !resp.ok) continue;
      const data = await resp.json();
      const docs = data.docs || [];
      for (const r of docs) {
        const foundTitle = r.title || cleanTitle;
        const foundAuthor = r.author_name?.[0] || (isUnknownAuthor ? undefined : cleanAuthor);

        if (!isTitleMatch(cleanTitle, foundTitle)) continue;
        if (!isUnknownAuthor && foundAuthor && !isAuthorMatch(cleanAuthor, foundAuthor)) continue;

        const coverId = r.cover_i;
        const subjects = Array.isArray(r.subject)
          ? r.subject
              .filter((s: any) => typeof s === "string" && s.length > 2 && !["fiction", "non-fiction", "general", "miscellaneous"].includes(s.toLowerCase()))
              .slice(0, 5)
          : undefined;
        return {
          title: foundTitle,
          album: foundTitle,
          author: foundAuthor,
          artist: foundAuthor,
          year: r.first_publish_year,
          posterUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : undefined,
          overview: r.first_sentence
            ? Array.isArray(r.first_sentence)
              ? r.first_sentence[0]
              : r.first_sentence
            : undefined,
          genres: subjects,
          metadataId: r.key,
          metadataSource: "openlibrary" as const,
          metadataConfidence: "high" as const,
        };
      }
    } catch {}
  }

  return {};
}

/**
 * Multi-tier metadata pipeline for Books and Audiobooks (Storyleaf Architecture):
 * 1. Direct ASIN lookup via Audnexus (if query is an ASIN)
 * 2. iTunes Search API (fast, reliable, no quota limits, crisp 600x600 artwork, official author/genres)
 * 3. OpenLibrary fallback (fields-optimized, high-res covers)
 * 4. Cross-pollinate iTunes (if audiobooks, check ebooks; if books, check audiobooks)
 * 5. Google Books fallback (zoom=2 covers)
 * Cached in-memory so multi-chapter audiobooks share a single API call.
 */
export async function fetchBookOrAudiobookMetadata(
  title: string,
  author?: string,
  libraryType: "books" | "audiobooks" = "books"
): Promise<Partial<MediaItem>> {
  const cleanTitle = cleanBookTitleForSearch(title);
  const cleanAuthor = author ? cleanBookTitleForSearch(author) : "";
  const cacheKey = `${libraryType}:::${cleanTitle.toLowerCase()}:::${cleanAuthor.toLowerCase()}`;

  if (bookAlbumCache.has(cacheKey)) {
    return { ...bookAlbumCache.get(cacheKey)! };
  }

  let meta: Partial<MediaItem> = {};

  // 1. Direct ASIN lookup via Audnexus if title is an ASIN
  if (/^[B0-9][A-Z0-9]{9}$/i.test(cleanTitle)) {
    meta = await fetchAudnexusMetadata(cleanTitle, cleanAuthor);
  }

  // 2. iTunes Search API
  if (!meta.posterUrl) {
    const itunesMeta = await fetchItunesBookOrAudiobookMetadata(cleanTitle, cleanAuthor, libraryType);
    meta = { ...itunesMeta, ...meta, posterUrl: meta.posterUrl || itunesMeta.posterUrl };
  }

  // 3. OpenLibrary fallback
  if (!meta.posterUrl) {
    const olMeta = await fetchOpenLibrary(cleanTitle, cleanAuthor);
    meta = { ...olMeta, ...meta, posterUrl: meta.posterUrl || olMeta.posterUrl };
  }

  // 4. Cross-pollinate iTunes (if audiobooks, check ebooks; if books, check audiobooks)
  if (!meta.posterUrl) {
    const altType = libraryType === "audiobooks" ? "books" : "audiobooks";
    const altMeta = await fetchItunesBookOrAudiobookMetadata(cleanTitle, cleanAuthor, altType);
    meta = { ...altMeta, ...meta, posterUrl: meta.posterUrl || altMeta.posterUrl };
  }

  // 5. Google Books fallback
  if (!meta.posterUrl) {
    const gMeta = await fetchGoogleBooksMetadata(cleanTitle, cleanAuthor);
    meta = { ...gMeta, ...meta, posterUrl: meta.posterUrl || gMeta.posterUrl };
  }

  if (meta.posterUrl || meta.overview) {
    bookAlbumCache.set(cacheKey, meta);
  }

  return meta;
}

export async function fetchThePornDbMetadata(
  title: string,
  rawFilename: string,
  apiKey: string
): Promise<Partial<MediaItem>> {
  if (!apiKey) return {};
  try {
    let resp = await safeFetchApi(
      `https://api.theporndb.net/scenes?q=${encodeURIComponent(title)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    let data = resp && resp.ok ? await resp.json() : null;
    let scene = data?.data?.[0];

    // Fallback: search raw filename stem if parsed title yielded no results
    const stem = rawFilename.replace(/\.[^/.]+$/, "");
    if (!scene && stem && stem !== title) {
      resp = await safeFetchApi(
        `https://api.theporndb.net/scenes?q=${encodeURIComponent(stem)}`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      if (resp && resp.ok) {
        data = await resp.json();
        scene = data?.data?.[0];
      }
    }

    if (scene) {
      const poster =
        scene.poster ??
        scene.posters?.large ??
        scene.posters?.medium ??
        scene.posters?.small ??
        scene.posters?.full ??
        (Array.isArray(scene.posters)
          ? (typeof scene.posters[0] === "string" ? scene.posters[0] : scene.posters[0]?.url)
          : undefined);
      const backdrop =
        scene.background?.large ??
        scene.background?.full ??
        scene.background?.medium;
      const parsedYear = scene.date ? parseInt(scene.date.substring(0, 4), 10) : undefined;
      return {
        title: scene.title ?? title,
        posterUrl: poster,
        backdropUrl: backdrop,
        overview: scene.description,
        year: isNaN(parsedYear as number) ? undefined : parsedYear,
        duration: typeof scene.duration === "number" ? scene.duration : undefined,
        genres: Array.isArray(scene.tags) ? scene.tags.map((t: any) => t.name).filter(Boolean) : undefined,
        metadataId: String(scene.id),
        metadataSource: "theporndb",
        metadataConfidence: "high",
      };
    }
  } catch {}
  return {};
}

// ─── Technical Media Specs Parser ──────────────────────────────────────────

export function parseTechnicalMediaSpecs(filename: string, sizeBytes?: number) {
  const ext = filename.split(".").pop()?.toUpperCase() || "";
  const fn = filename.toLowerCase();

  let resolution: string | undefined;
  if (/\b(2160p|4k|uhd)\b/i.test(fn)) resolution = "4K";
  else if (/\b(1080p|1080i|fhd)\b/i.test(fn)) resolution = "1080p";
  else if (/\b(720p|hd)\b/i.test(fn)) resolution = "720p";
  else if (/\b(480p|576p|sd)\b/i.test(fn)) resolution = "480p";

  let videoCodec: string | undefined;
  if (/\b(x265|h265|hevc)\b/i.test(fn)) videoCodec = "HEVC";
  else if (/\b(x264|h264|avc)\b/i.test(fn)) videoCodec = "H.264";
  else if (/\b(av1)\b/i.test(fn)) videoCodec = "AV1";
  else if (/\b(vp9)\b/i.test(fn)) videoCodec = "VP9";
  else if (/\b(xvid|divx)\b/i.test(fn)) videoCodec = "XviD";

  let audioCodec: string | undefined;
  if (/\b(ddp\+?5\.1|eac3)\b/i.test(fn)) audioCodec = "DDP 5.1";
  else if (/\b(dd5\.1|ac3)\b/i.test(fn)) audioCodec = "DD 5.1";
  else if (/\b(dts-hd\s*ma|dts-hd)\b/i.test(fn)) audioCodec = "DTS-HD";
  else if (/\b(truehd)\b/i.test(fn)) audioCodec = "TrueHD";
  else if (/\b(atmos)\b/i.test(fn)) audioCodec = "Atmos";
  else if (/\b(dts)\b/i.test(fn)) audioCodec = "DTS";
  else if (/\b(flac)\b/i.test(fn)) audioCodec = "FLAC";
  else if (/\b(aac)\b/i.test(fn)) audioCodec = "AAC";
  else if (/\b(mp3)\b/i.test(fn)) audioCodec = "MP3";
  else if (/\b(opus)\b/i.test(fn)) audioCodec = "Opus";

  return {
    container: ext,
    resolution,
    videoCodec,
    audioCodec,
    sizeBytes: sizeBytes && sizeBytes > 0 ? sizeBytes : undefined,
  };
}

// ─── Single File Processor (Fail-Safe) ───────────────────────────────────────

async function processSingleFile(
  file: DiscoveredFile,
  library: Library,
  apiKeys: { tmdb: string; theporndb: string },
  skipMetadata = false
): Promise<MediaItem> {
  let parsed: ParsedTitle = { title: file.filename, is_episode: false };
  let id = file.remote_path;

  try {
    parsed = await invoke("parse_media_filename", { filename: file.filename });
  } catch {}

  try {
    id = await invoke("hash_remote_path", { remotePath: file.remote_path });
  } catch {}

  const techSpecs = parseTechnicalMediaSpecs(file.filename, file.size);
  const isComic = library.type === "comics" || isComicExtension(file.filename);

  const baseItem: MediaItem = {
    id,
    libraryId: library.id,
    libraryType: library.type,
    remotePath: file.remote_path,
    filename: file.filename,
    title: parsed.title || file.filename,
    year: parsed.year,
    season: parsed.season,
    episode: parsed.episode,
    addedAt: Date.now(),
    lastScannedAt: skipMetadata ? 0 : Date.now(),
    metadataConfidence: "low",
    sizeBytes: techSpecs.sizeBytes,
    container: techSpecs.container,
    videoCodec: techSpecs.videoCodec,
    audioCodec: techSpecs.audioCodec,
    resolution: techSpecs.resolution,
  };

  // Path-derived music & comic tags are free and reliable; apply them always so the
  // library is organised even before (or without) an online match.
  if (isComic) {
    const cInfo = extractComicInfo(file.remote_path, file.filename, library.remotePaths);
    baseItem.title = cInfo.cleanTitle;
    baseItem.showTitle = cInfo.series;
    baseItem.album = cInfo.series;
    baseItem.episode = cInfo.issue;
    baseItem.season = cInfo.volume ?? 1;
    if (cInfo.year) baseItem.year = cInfo.year;
  } else if (library.type === "music") {
    const info = extractMusicInfo(file.remote_path, file.filename, library.remotePaths);
    baseItem.title = info.title;
    baseItem.artist = info.artist;
    baseItem.album = info.album;
    baseItem.trackNumber = info.trackNumber;
    baseItem.year = info.year ?? baseItem.year;
  } else if (library.type === "tv") {
    const tvInfo = extractTvInfo(file.remote_path, file.filename, library.remotePaths);
    baseItem.season = parsed.season ?? tvInfo.season;
    baseItem.episode = parsed.episode ?? tvInfo.episode;
    baseItem.showTitle = tvInfo.showTitle || (parsed.title && !/^[sS]\d{1,2}[eE]\d{1,2}/i.test(parsed.title) ? parsed.title : undefined);
    if (tvInfo.year && !baseItem.year) baseItem.year = tvInfo.year;
    if (tvInfo.cleanTitle && !baseItem.episodeTitle) baseItem.episodeTitle = tvInfo.cleanTitle;

    if (baseItem.season !== undefined && baseItem.episode !== undefined) {
      baseItem.title = `${baseItem.showTitle || "TV"} - S${String(baseItem.season).padStart(2, "0")}E${String(baseItem.episode).padStart(2, "0")}`;
    } else if (baseItem.showTitle) {
      baseItem.title = baseItem.showTitle;
    }
  }

  let meta: Partial<MediaItem> = {};

  if (skipMetadata) {
    // Discovery pass: local parsing only, no network. Metadata is filled in
    // afterwards so a huge library cannot starve the ones behind it.
    if (isComic) {
      return baseItem;
    }
    if (library.type === "books" || library.type === "audiobooks") {
      const bookInfo = extractBookInfo(file.remote_path, file.filename, library.remotePaths);
      baseItem.title = bookInfo.title;
      baseItem.album = bookInfo.album;
      baseItem.author = bookInfo.author;
      baseItem.artist = bookInfo.author;
      if (bookInfo.year) baseItem.year = bookInfo.year;
    }
    return baseItem;
  }

  if (isComic) {
    if (baseItem.showTitle) {
      try {
        meta = await fetchBookOrAudiobookMetadata(baseItem.showTitle, undefined, "books");
      } catch {}
    }
    // Retain comic issue title and avoid overwriting with general series title
    if (meta.title && baseItem.title) {
      delete meta.title;
    }
  } else if (library.type === "books" || library.type === "audiobooks") {
    const bookInfo = extractBookInfo(file.remote_path, file.filename, library.remotePaths);
    baseItem.title = bookInfo.title;
    baseItem.album = bookInfo.album;
    baseItem.author = bookInfo.author;
    baseItem.artist = bookInfo.author;
    if (bookInfo.year) baseItem.year = bookInfo.year;

    const queryTitle = library.type === "books" ? bookInfo.title : (bookInfo.album || bookInfo.title);
    meta = await fetchBookOrAudiobookMetadata(
      queryTitle,
      bookInfo.author,
      library.type
    );
  } else {
    try {
      if (library.type === "movies") {
        const imdbMatch = (file.remote_path + " " + file.filename).match(/\{imdb-(tt\d+)\}/i);
        if (imdbMatch) {
          try {
            const detailResp = await safeFetchApi(
              `https://v3-cinemeta.strem.io/meta/movie/${imdbMatch[1]}.json`
            );
            if (detailResp && detailResp.ok) {
              const detailData = await detailResp.json();
              if (detailData?.meta) {
                const fm = detailData.meta;
                const rawYear = fm.year || fm.releaseInfo;
                const resYear = rawYear ? parseInt(String(rawYear).split("-")[0]) : parsed.year;
                meta = {
                  title: fm.name ?? parsed.title,
                  year: isNaN(resYear as number) ? parsed.year : resYear,
                  posterUrl: fm.poster,
                  backdropUrl: fm.background,
                  overview: fm.description,
                  rating: fm.imdbRating ? parseFloat(fm.imdbRating) : undefined,
                  metadataId: fm.id || imdbMatch[1],
                  metadataSource: "cinemeta" as const,
                  metadataConfidence: "high" as const,
                };
              }
            }
          } catch {}
        }
        if (!meta.title) {
          meta = await fetchCinemetaMovie(parsed.title, parsed.year);
        }
        if (!meta.posterUrl && apiKeys.tmdb) {
          meta = await fetchTmdbMovie(parsed.title, parsed.year, apiKeys.tmdb);
        }
      } else if (library.type === "tv") {
        const matchingRoot = library.remotePaths.find((p) => file.remote_path.startsWith(p)) || library.remotePaths[0];
        const showFolderKey = getTvShowFolderKey(file.remote_path, matchingRoot, baseItem.showTitle || parsed.title);
        const seasonVal = baseItem.season ?? parsed.season;
        const episodeVal = baseItem.episode ?? parsed.episode;
        const showQuery =
          baseItem.showTitle ||
          (parsed.title && !/^[sS]\d{1,2}[eE]\d{1,2}/i.test(parsed.title) && parsed.title !== file.filename
            ? parsed.title
            : file.filename.replace(/\.[^/.]+$/, ""));

        let seriesMeta = tvFolderSeriesCache.get(showFolderKey);

        if (!seriesMeta && showQuery) {
          meta = await fetchCinemetaTv(showQuery, seasonVal, episodeVal);
          if (!meta.showPosterUrl && !meta.posterUrl && apiKeys.tmdb) {
            meta = await fetchTmdbTv(
              showQuery,
              seasonVal,
              episodeVal,
              apiKeys.tmdb
            );
          }
          if (meta.showTitle || meta.metadataId) {
            seriesMeta = {
              showTitle: meta.showTitle || showQuery,
              showId: meta.showId,
              showPosterUrl: meta.showPosterUrl,
              showBackdropUrl: meta.showBackdropUrl,
              showOverview: meta.showOverview,
              year: meta.year,
              genres: meta.genres,
              metadataId: meta.metadataId,
              metadataSource: meta.metadataSource,
              metadataConfidence: meta.metadataConfidence,
            };
            tvFolderSeriesCache.set(showFolderKey, seriesMeta);
          }
        } else if (seriesMeta) {
          const query = seriesMeta.showTitle || showQuery;
          meta = await fetchCinemetaTv(query, seasonVal, episodeVal);
          meta = {
            ...meta,
            showTitle: seriesMeta.showTitle || meta.showTitle,
            showId: seriesMeta.showId || meta.showId,
            showPosterUrl: seriesMeta.showPosterUrl || meta.showPosterUrl,
            showBackdropUrl: seriesMeta.showBackdropUrl || meta.showBackdropUrl,
            showOverview: seriesMeta.showOverview || meta.showOverview,
            genres: seriesMeta.genres || meta.genres,
            metadataId: seriesMeta.metadataId || meta.metadataId,
            metadataSource: seriesMeta.metadataSource || meta.metadataSource,
            metadataConfidence: seriesMeta.metadataConfidence || meta.metadataConfidence,
          };
          if (!meta.posterUrl) {
            meta.posterUrl = seriesMeta.showPosterUrl;
          }
        }
      } else if (library.type === "music") {
        const albumFolderKey = getAlbumFolderKey(file.remote_path);
        const cachedAlbum = musicFolderAlbumCache.get(albumFolderKey);

        if (cachedAlbum) {
          meta = {
            posterUrl: cachedAlbum.posterUrl,
            year: baseItem.year ?? cachedAlbum.year,
            genres: cachedAlbum.genres,
            metadataId: cachedAlbum.metadataId,
            metadataSource: cachedAlbum.metadataSource,
            metadataConfidence: "high",
            artist: baseItem.artist ?? cachedAlbum.artist,
            album: baseItem.album ?? cachedAlbum.album,
            trackNumber: baseItem.trackNumber,
          };
        } else {
          const musicMeta = await fetchMusicMetadata(
            baseItem.artist,
            baseItem.album,
            baseItem.title
          );
          meta = {
            posterUrl: musicMeta.posterUrl,
            duration: musicMeta.duration ?? baseItem.duration,
            year: baseItem.year ?? musicMeta.year,
            genres: musicMeta.genres,
            metadataId: musicMeta.metadataId,
            metadataSource: musicMeta.metadataSource,
            metadataConfidence: musicMeta.posterUrl ? "high" : "low",
            artist: baseItem.artist ?? musicMeta.artist,
            album: baseItem.album ?? musicMeta.album,
            trackNumber: baseItem.trackNumber ?? musicMeta.trackNumber,
          };
          if (meta.posterUrl || meta.album) {
            musicFolderAlbumCache.set(albumFolderKey, {
              posterUrl: meta.posterUrl,
              year: meta.year,
              genres: meta.genres,
              artist: meta.artist,
              album: meta.album,
              metadataId: meta.metadataId,
              metadataSource: meta.metadataSource,
            });
          }
        }
      } else if (library.type === "adult" && apiKeys.theporndb) {
        meta = await fetchThePornDbMetadata(parsed.title, file.filename, apiKeys.theporndb);
      }
    } catch {}
  }

  if (library.type === "books") {
    // Ebooks (epub, pdf, mobi, azw3) are individual distinct items. NEVER apply folder caching to books.
    const bookInfo = extractBookInfo(file.remote_path, file.filename, library.remotePaths);
    return {
      ...baseItem,
      ...meta,
      title: meta.title || baseItem.title || bookInfo.title,
      album: meta.album || baseItem.album || bookInfo.album || bookInfo.title,
      author: meta.author || baseItem.author || bookInfo.author,
      artist: meta.artist || meta.author || baseItem.artist || bookInfo.author,
      year: meta.year || baseItem.year || bookInfo.year,
      posterUrl: meta.posterUrl || baseItem.posterUrl,
      overview: meta.overview || baseItem.overview,
      genres: meta.genres || baseItem.genres,
    };
  }

  if (library.type === "audiobooks") {
    const bookFolderKey = getBookFolderKey(file.remote_path);
    const bookInfo = extractBookInfo(file.remote_path, file.filename, library.remotePaths);
    const isMultiChapter = Boolean(bookInfo.album && bookInfo.album !== bookInfo.title);
    const cachedBook = isMultiChapter ? bookFolderAlbumCache.get(bookFolderKey) : undefined;

    if (cachedBook) {
      return {
        ...baseItem,
        ...cachedBook,
        title: isMultiChapter ? baseItem.title : (cachedBook.title || baseItem.title),
        album: cachedBook.album || baseItem.album || bookInfo.album,
        author: cachedBook.author || baseItem.author || bookInfo.author,
        artist: cachedBook.artist || cachedBook.author || baseItem.artist || bookInfo.author,
        year: cachedBook.year || baseItem.year || bookInfo.year,
        posterUrl: cachedBook.posterUrl || baseItem.posterUrl,
        overview: cachedBook.overview || baseItem.overview,
        genres: cachedBook.genres || baseItem.genres,
      };
    }

    if (isMultiChapter && (meta.title || meta.posterUrl)) {
      bookFolderAlbumCache.set(bookFolderKey, {
        title: meta.title,
        album: meta.title || baseItem.album || bookInfo.album,
        author: meta.author || baseItem.author || bookInfo.author,
        artist: meta.artist || meta.author || baseItem.artist || bookInfo.author,
        year: meta.year || baseItem.year || bookInfo.year,
        posterUrl: meta.posterUrl || baseItem.posterUrl,
        overview: meta.overview || baseItem.overview,
        genres: meta.genres || baseItem.genres,
        metadataId: meta.metadataId,
        metadataSource: meta.metadataSource,
      });
    }

    return {
      ...baseItem,
      ...meta,
      title: isMultiChapter ? baseItem.title : (meta.title || baseItem.title),
      album: meta.title || baseItem.album || bookInfo.album,
      author: meta.author || baseItem.author || bookInfo.author,
      artist: meta.artist || meta.author || baseItem.artist || bookInfo.author,
      year: meta.year || baseItem.year || bookInfo.year,
      posterUrl: meta.posterUrl || baseItem.posterUrl,
      overview: meta.overview || baseItem.overview,
      genres: meta.genres || baseItem.genres,
    };
  }

  return { ...baseItem, ...meta };
}

// ─── Main scan (Guaranteed Completion & Local Persistence) ─────────────────

export async function scanLibrary(
  library: Library,
  apiKeys: { tmdb: string; theporndb: string },
  options: { skipMetadata?: boolean } = {}
) {
  const currentStatus = useAppStore.getState().scanState.status;
  if (currentStatus === "scanning") return;

  if (library.id.startsWith("plex-") || library.id.startsWith("jellyfin-")) {
    const { setScanState } = useAppStore.getState();
    setScanState({
      status: "scanning",
      currentLibrary: library.name,
      progress: 25,
      newItemsFound: 0,
      lastError: undefined,
    });
    try {
      const count = await syncExternalServerForLibraryId(library.id);
      setScanState({
        status: "idle",
        progress: 100,
        lastScanAt: Date.now(),
        newItemsFound: count,
        currentLibrary: undefined,
      });
      useToastStore.getState().addToast(`Synced ${count} items from "${library.name}"`, "success");
    } catch (err: any) {
      setScanState({ status: "error", lastError: String(err?.message || err) });
      useToastStore.getState().addToast(`External sync failed: ${err?.message || err}`, "error");
    }
    return;
  }

  isQuotaExceeded = false;
  throttledHosts.clear();

  const store = useAppStore.getState();
  const {
    rcloneConfigPath,
    mediaItems,
    setScanState,
    bulkUpsertMediaItems,
    removeMediaItem,
  } = store;

  log.info("scan", `starting "${library.name}" (${library.remotePaths.join(", ")})`);

  setScanState({
    status: "scanning",
    currentLibrary: library.name,
    progress: 0,
    newItemsFound: 0,
    lastError: undefined,
  });

  try {
    const allNewFiles: LibraryScanResult["new_files"] = [];
    const allRemovedPaths: string[] = [];
    const pathErrors: string[] = [];

    if (library.type === "photos") {
      const { galleries, upsertGallery, removeGallery } = useAppStore.getState();
      const currentGalleries = { ...galleries };
      let newPhotosCount = 0;

      for (const remotePath of library.remotePaths) {
        try {
          const prefix = remotePath.replace(/\/+$/, "") + "/";
          const pathKnownPaths: string[] = [];
          for (const g of Object.values(currentGalleries)) {
            for (const p of g.photos) {
              const pPath = p.remotePath || p.remotePreviewPath;
              if (pPath && (pPath.startsWith(prefix) || pPath.startsWith(remotePath) || pPath === remotePath)) {
                pathKnownPaths.push(pPath);
              }
            }
          }

          const result: LibraryScanResult = await invoke("scan_library_files", {
            configPath: rcloneConfigPath,
            remotePath,
            libraryId: library.id,
            knownPaths: pathKnownPaths,
            libraryType: "photos",
          });

          allNewFiles.push(...result.new_files);
          allRemovedPaths.push(...result.removed_paths);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("scan", `listing photos failed for ${remotePath}: ${msg}`);
          pathErrors.push(`${remotePath}: ${msg}`);
        }
      }

      // Handle removed photos
      if (allRemovedPaths.length > 0) {
        const removedSet = new Set(allRemovedPaths);
        for (const [galId, gallery] of Object.entries(currentGalleries)) {
          const surviving = gallery.photos.filter((p) => {
            const pPath = p.remotePath || p.remotePreviewPath;
            return !pPath || !removedSet.has(pPath);
          });
          if (surviving.length !== gallery.photos.length) {
            if (surviving.length === 0) {
              removeGallery(galId);
              delete currentGalleries[galId];
            } else {
              const updatedGal: PhotoGallery = {
                ...gallery,
                photos: surviving,
                coverPhotoId: surviving[0]?.id,
                updatedAt: Date.now(),
              };
              upsertGallery(updatedGal);
              currentGalleries[galId] = updatedGal;
            }
          }
        }
      }

      // Group new files into galleries by directory structure
      const newGalleriesMap: Record<
        string,
        {
          title: string;
          baseRemotePath: string;
          isAdult: boolean;
          photos: GalleryPhoto[];
        }
      > = {};

      for (const file of allNewFiles) {
        const matchedRoot =
          library.remotePaths.find((rp) => file.remote_path.startsWith(rp)) ||
          library.remotePaths[0] ||
          "";
        const prefix = matchedRoot.replace(/\/+$/, "") + "/";
        let subpath = "";
        if (file.remote_path.startsWith(prefix)) {
          subpath = file.remote_path.slice(prefix.length);
        } else if (file.remote_path.startsWith(matchedRoot)) {
          subpath = file.remote_path.slice(matchedRoot.length).replace(/^\/+/, "");
        } else {
          subpath = file.filename;
        }

        const parts = subpath.split("/").filter(Boolean);
        const folderName = parts.length > 1 ? parts.slice(0, -1).join(" / ") : "";
        const galleryTitle = folderName || library.name;
        const galleryId = `gal-${library.id}-${encodeURIComponent(folderName || "root")}`;

        const isAdult =
          library.name.toLowerCase().includes("adult") ||
          folderName.toLowerCase().includes("adult") ||
          file.filename.toLowerCase().includes("adult") ||
          folderName.toLowerCase().includes("nsfw") ||
          file.filename.toLowerCase().includes("nsfw");

        let photoHash = file.remote_path;
        try {
          photoHash = await invoke("hash_remote_path", { remotePath: file.remote_path });
        } catch {}

        const photoItem: GalleryPhoto = {
          id: `pho-${photoHash}`,
          remotePath: file.remote_path,
          remotePreviewPath: file.remote_path,
          remoteOriginalPath: file.remote_path,
          storageMode: "original",
          filename: file.filename,
          sizeBytes: file.size,
          width: 1920,
          height: 1080,
          isAdult,
          uploadedAt: Date.now(),
        };

        if (!newGalleriesMap[galleryId]) {
          newGalleriesMap[galleryId] = {
            title: galleryTitle,
            baseRemotePath: matchedRoot,
            isAdult,
            photos: [],
          };
        }
        newGalleriesMap[galleryId].photos.push(photoItem);
        newPhotosCount++;
      }

      // Upsert galleries
      for (const [galId, gData] of Object.entries(newGalleriesMap)) {
        const existing = currentGalleries[galId];
        const existingPhotos = existing ? [...existing.photos] : [];
        const existingPathSet = new Set(existingPhotos.map((p) => p.remotePath || p.id));

        for (const p of gData.photos) {
          if (!existingPathSet.has(p.remotePath || p.id)) {
            existingPhotos.push(p);
            existingPathSet.add(p.remotePath || p.id);
          }
        }

        const remoteName = isLocalPath(gData.baseRemotePath)
          ? "LOCAL"
          : gData.baseRemotePath.includes(":")
          ? gData.baseRemotePath.split(":")[0]
          : "CLOUD";

        const finalGallery: PhotoGallery = {
          id: galId,
          title: gData.title,
          isAdult: gData.isAdult,
          photos: existingPhotos,
          coverPhotoId: existingPhotos[0]?.id,
          remoteName,
          remotePath: gData.baseRemotePath,
          createdAt: existing?.createdAt || Date.now(),
          updatedAt: Date.now(),
        };

        upsertGallery(finalGallery);
        currentGalleries[galId] = finalGallery;
      }

      setScanState({
        status: "idle",
        progress: 100,
        lastScanAt: Date.now(),
        newItemsFound: newPhotosCount,
        currentLibrary: undefined,
      });

      if (pathErrors.length > 0) {
        setScanState({ status: "error", lastError: pathErrors.join("; ") });
        useToastStore
          .getState()
          .addToast(`Photo scan completed with errors: ${pathErrors.join("; ")}`, "error");
      } else {
        useToastStore
          .getState()
          .addToast(
            `Scanned ${newPhotosCount} photos across ${Object.keys(newGalleriesMap).length || 1} galleries in "${library.name}"`,
            "success"
          );
      }
      return;
    }

    for (const remotePath of library.remotePaths) {
      try {
        const prefix = remotePath.replace(/\/$/, "") + "/";
        const pathKnownPaths = Object.values(mediaItems)
          .filter((i) => i.libraryId === library.id && (i.remotePath.startsWith(prefix) || i.remotePath === remotePath))
          .map((i) => i.remotePath);

        const result: LibraryScanResult = await invoke("scan_library_files", {
          configPath: rcloneConfigPath,
          remotePath,
          libraryId: library.id,
          knownPaths: pathKnownPaths,
          libraryType: library.type,
        });
        allNewFiles.push(...result.new_files);
        allRemovedPaths.push(...result.removed_paths);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("scan", `listing failed for ${remotePath}: ${msg}`);
        pathErrors.push(`${remotePath}: ${msg}`);
      }
    }

    // Remove deleted files locally. Index by path first so this is O(n),
    // not a linear scan of the whole library per removed file.
    if (allRemovedPaths.length > 0) {
      const byPath = new Map(
        Object.values(mediaItems).map((i) => [i.remotePath, i])
      );
      for (const removedPath of allRemovedPaths) {
        const item = byPath.get(removedPath);
        if (item) removeMediaItem(item.id);
      }
    }

    const total = allNewFiles.length;
    let newItemCount = 0;
    const newAddedIds: string[] = [];

    // Metadata lookups are rate limited, so keep those batches small; the
    // discovery pass does no network I/O and is dominated by store/SQLite
    // round trips, so it batches far larger (15k music files was ~2,000
    // separate store updates and re-renders at a batch size of 5).
    const BATCH_SIZE = options.skipMetadata ? 250 : 5;
    for (let i = 0; i < allNewFiles.length; i += BATCH_SIZE) {
      const batch = allNewFiles.slice(i, i + BATCH_SIZE);
      const processedBatch = await Promise.all(
        batch.map((file) => processSingleFile(file, library, apiKeys, options.skipMetadata))
      );

      newItemCount += processedBatch.length;
      newAddedIds.push(...processedBatch.map((p) => p.id));

      setScanState({
        progress: Math.round(((i + batch.length) / Math.max(total, 1)) * 100),
        newItemsFound: newItemCount,
      });

      // Persist only this batch — re-writing every item found so far turned
      // a large scan into O(n²) serialisations of the whole store.
      bulkUpsertMediaItems(processedBatch);
    }

    setScanState({
      status: "idle",
      progress: 100,
      lastScanAt: Date.now(),
      newItemsFound: newItemCount,
      currentLibrary: undefined,
    });

    if (pathErrors.length > 0) {
      setScanState({ status: "error", lastError: pathErrors.join("; ") });
      log.error("scan", `"${library.name}" finished with errors: ${pathErrors.join("; ")}`);
      useToastStore
        .getState()
        .addToast(`${library.name}: ${pathErrors[0]}`, "error", 9000);
      return { newItems: newItemCount, newIds: newAddedIds, estimatedQuotaExceeded: isQuotaExceeded, failed: true };
    }

    const msg = isQuotaExceeded
      ? `Scan complete — ${newItemCount} items saved (API rate-limit hit, used local titles)`
      : `${library.name}: ${newItemCount} new item${newItemCount !== 1 ? "s" : ""}`;

    log.info("scan", `"${library.name}" complete — ${newItemCount} new items`);
    useToastStore.getState().addToast(msg, isQuotaExceeded ? "info" : "success");

    return { newItems: newItemCount, newIds: newAddedIds, estimatedQuotaExceeded: isQuotaExceeded, failed: false };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    log.error("scan", `"${library.name}" threw: ${errorMessage}`);
    setScanState({
      status: "error",
      lastError: errorMessage,
      currentLibrary: undefined,
    });
    useToastStore
      .getState()
      .addToast(`Scan error: ${errorMessage}`, "error", 6000);
    return { newItems: 0, estimatedQuotaExceeded: isQuotaExceeded, failed: true };
  }
}

function mergeEnrichedItem(existing: MediaItem, fresh: Partial<MediaItem>): MediaItem {
  return {
    ...existing,
    ...fresh,
    title: fresh.title || existing.title,
    posterUrl: fresh.posterUrl || existing.posterUrl,
    thumbUrl: fresh.thumbUrl || existing.thumbUrl,
    backdropUrl: fresh.backdropUrl || existing.backdropUrl,
    showPosterUrl: fresh.showPosterUrl || existing.showPosterUrl,
    showBackdropUrl: fresh.showBackdropUrl || existing.showBackdropUrl,
    showOverview: fresh.showOverview || existing.showOverview,
    overview: fresh.overview || existing.overview,
    year: fresh.year ?? existing.year,
    rating: fresh.rating ?? existing.rating,
    genres: fresh.genres && fresh.genres.length > 0 ? fresh.genres : existing.genres,
    artist: fresh.artist || existing.artist,
    album: fresh.album || existing.album,
    author: fresh.author || existing.author,
    episodeTitle: fresh.episodeTitle || existing.episodeTitle,
    metadataConfidence:
      fresh.metadataConfidence === "high" || !existing.metadataConfidence
        ? (fresh.metadataConfidence ?? existing.metadataConfidence)
        : existing.metadataConfidence,
    metadataSource: fresh.metadataSource || existing.metadataSource,
    metadataId: fresh.metadataId || existing.metadataId,
    userTags: existing.userTags?.length ? existing.userTags : fresh.userTags,
    studio: existing.studio || fresh.studio,
    performers: existing.performers?.length ? existing.performers : fresh.performers,
    oshash: existing.oshash || fresh.oshash,
    phash: existing.phash || fresh.phash,
    id: existing.id,
    libraryId: existing.libraryId,
    remotePath: existing.remotePath,
    filename: existing.filename,
    addedAt: existing.addedAt,
    lastScannedAt: Date.now(),
  };
}

/**
 * Re-fetch online metadata for existing items in a library.
 * Useful when metadata sources improve (e.g. Cinemeta, iTunes) or when initial
 * discovery occurred without complete metadata.
 */
export async function refreshLibraryMetadata(
  library: Library,
  apiKeys: { tmdb: string; theporndb: string },
  forceAll: boolean = true,
  targetIds?: string[]
): Promise<void> {
  const currentStatus = useAppStore.getState().scanState.status;
  if (currentStatus === "scanning") return;

  if (library.id.startsWith("plex-") || library.id.startsWith("jellyfin-")) {
    const { setScanState } = useAppStore.getState();
    setScanState({
      status: "scanning",
      currentLibrary: library.name,
      progress: 25,
      newItemsFound: 0,
      lastError: undefined,
    });
    try {
      const count = await syncExternalServerForLibraryId(library.id);
      setScanState({
        status: "idle",
        progress: 100,
        lastScanAt: Date.now(),
        newItemsFound: count,
        currentLibrary: undefined,
      });
      useToastStore.getState().addToast(`Synced ${count} items from "${library.name}"`, "success");
    } catch (err: any) {
      setScanState({ status: "error", lastError: String(err?.message || err) });
      useToastStore.getState().addToast(`External sync failed: ${err?.message || err}`, "error");
    }
    return;
  }

  isQuotaExceeded = false;
  throttledHosts.clear();
  clearMusicAlbumCache();
  clearBookAlbumCache();

  const { mediaItems, setScanState, bulkUpsertMediaItems } = useAppStore.getState();

  const targetSet = targetIds ? new Set(targetIds) : null;
  if (targetSet && targetSet.size === 0) {
    log.info("scan", `no new items to enrich in "${library.name}" — skipping metadata pass`);
    return;
  }

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const pending = Object.values(mediaItems).filter((i) => {
    if (i.libraryId !== library.id) return false;
    if (targetSet) return targetSet.has(i.id);
    if (forceAll) return i.metadataConfidence !== "manual";
    if (i.metadataConfidence === "high" || i.metadataConfidence === "manual") return false;
    const timeSinceLastScan = now - (i.lastScannedAt || 0);
    return !i.lastScannedAt || i.lastScannedAt === 0 || timeSinceLastScan > SEVEN_DAYS_MS;
  });

  if (pending.length === 0) {
    if (forceAll) {
      useToastStore
        .getState()
        .addToast(`No items to refresh in "${library.name}"`, "info", 4000);
    }
    return;
  }

  log.info("scan", `refreshing metadata for ${pending.length} items in "${library.name}"`);
  setScanState({
    status: "scanning",
    currentLibrary: `${library.name} (refreshing metadata)`,
    progress: 0,
    lastError: undefined,
  });

  const BATCH = 5;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const enriched = await Promise.all(
      batch.map((item) =>
        processSingleFile(
          {
            remote_path: item.remotePath,
            filename: item.filename,
            size: 0,
            is_dir: false,
            mime_type: null,
          },
          library,
          apiKeys,
          false
        ).then((fresh) => mergeEnrichedItem(item, fresh))
      )
    );
    await bulkUpsertMediaItems(enriched);
    const completed = Math.min(i + batch.length, pending.length);
    setScanState({
      progress: Math.round((completed / pending.length) * 100),
    });
  }

  setScanState({
    status: "idle",
    currentLibrary: undefined,
    lastScanAt: Date.now(),
    progress: 100,
  });

  useToastStore
    .getState()
    .addToast(
      `Metadata refreshed for "${library.name}" (${pending.length} items)`,
      "success",
      5000
    );
  log.info("scan", `metadata refresh for "${library.name}" complete`);
}

async function enrichLibrary(
  library: Library,
  apiKeys: { tmdb: string; theporndb: string },
  targetIds?: string[]
): Promise<void> {
  return refreshLibraryMetadata(library, apiKeys, false, targetIds);
}

/**
 * In-flight guard for full scans.
 *
 * Without this, a second scanAllLibraries (startup auto-scan racing the sidebar
 * button) sees status === "scanning" on every library and short-circuits each
 * one, so the run silently completes having scanned almost nothing — the
 * symptom being later libraries like TV Shows staying permanently empty.
 */
let fullScanInFlight: Promise<void> | null = null;

export function scanAllLibraries(): Promise<void> {
  if (fullScanInFlight) {
    log.info("scan", "full scan already running — ignoring duplicate request");
    return fullScanInFlight;
  }
  fullScanInFlight = runFullScan().finally(() => {
    fullScanInFlight = null;
  });
  return fullScanInFlight;
}

async function runFullScan() {
  const { libraries, tmdbApiKey, thePornDbApiKey } = useAppStore.getState();

  const apiKeys = { tmdb: tmdbApiKey, theporndb: thePornDbApiKey };
  const failed: string[] = [];
  throttledHosts.clear();
  clearMusicAlbumCache();
  log.info("scan", `full scan of ${libraries.length} libraries`);

  // Phase 1: discover files everywhere before fetching any metadata.
  //
  // Metadata lookups are rate limited to ~120ms each, so a 15k-track music
  // library used to hold the run for the best part of an hour and libraries
  // behind it in the list (TV Shows) never appeared at all. Listing is fast —
  // seconds per library — so do all of it first and every library populates
  // straight away, even if artwork arrives later.
  const newIdsPerLib: Record<string, string[]> = {};
  for (const library of libraries) {
    try {
      const res = await scanLibrary(library, apiKeys, { skipMetadata: true });
      if (res && res.newIds) {
        newIdsPerLib[library.id] = res.newIds;
      }
    } catch (e) {
      log.error("scan", `discovery failed for "${library.name}": ${e}`);
    }
    if (useAppStore.getState().scanState.status === "scanning") {
      useAppStore.getState().setScanState({ status: "idle", currentLibrary: undefined });
    }
  }
  log.info("scan", "discovery pass complete; starting metadata pass");

  // Phase 2: fill in metadata for anything newly discovered or still unmatched.
  for (const library of libraries) {
    try {
      const targetIds = newIdsPerLib[library.id];
      await enrichLibrary(library, apiKeys, targetIds);
    } catch (e) {
      log.error("scan", `enrichment failed for "${library.name}": ${e}`);
      failed.push(library.name);
    }
  }

  if (failed.length > 0) {
    useToastStore
      .getState()
      .addToast(
        `Scan finished, but these libraries failed: ${failed.join(", ")}`,
        "error",
        8000
      );
  }
}

export function listenScanProgress(cb: (event: unknown) => void) {
  return listen("scan-progress", (event) => cb(event.payload));
}
