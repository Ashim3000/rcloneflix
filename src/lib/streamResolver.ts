import { invoke } from "@tauri-apps/api/core";
import type { LibraryType, MediaItem } from "../store/appStore";
import { isDebridResolvableUrl, resolveDebridLink } from "./debrid";
import { isDropmbUrl, resolveDropmbStream } from "./dropmbOffload";

export type WebStreamInfo = {
  original_url: string;
  direct_stream_url?: string | null;
  raw_title: string;
  clean_title: string;
  description?: string | null;
  poster_url?: string | null;
  provider: string;
  is_direct_media: boolean;
  media_type: string;
  year?: number | null;
  format?: string | null;
  season?: number | null;
  episode?: number | null;
};

export type DiscoveredRelease = {
  title: string;
  post_url: string;
  thumbnail?: string | null;
  date?: string | null;
  site_domain: string;
  media_type: string;
  season?: number | null;
  episode?: number | null;
  series_title?: string | null;
};

export type SiteDiscoveryFeed = {
  site_url: string;
  site_title: string;
  releases: DiscoveredRelease[];
};

/**
 * A "series container" card must drill down (crawl its episode/issue list) instead of
 * being sent to the resolve modal / player. Shared by DirectPlayPage (select + instant
 * play) and SiteDiscoveryDrawer so the three checks can never drift apart again.
 *
 * MovieBite note: show cards use post_url "moviebite.org/watch/tv/{tmdb}" — the generic
 * TV clause below excludes anything containing "/watch/" (a Yomi episode-page convention),
 * which is exactly why MovieBite shows previously skipped the drill-down and landed in the
 * resolve modal with no season/episode. They get their own explicit clause.
 */
export function isSeriesContainerRelease(release: DiscoveredRelease): boolean {
  return (
    release.media_type === "comic_series" ||
    /bunkrr?\.[a-z]+\/a\//i.test(release.post_url) ||
    release.post_url.includes("mangadex.org/title/") ||
    (release.post_url.includes("readcomicsonline.ru/comic/") && !release.post_url.match(/comic\/[^/]+\/\d+/)) ||
    release.post_url.includes("yomi.to/anime/") ||
    release.post_url.includes("yomi.to/category/") ||
    release.post_url.includes("yomi.to/series/") ||
    (/moviebite\.org\/watch\/tv\/\d+/i.test(release.post_url) &&
      !release.post_url.includes("episode=") &&
      release.episode == null) ||
    (release.media_type === "tv" && !release.post_url.includes("/watch/") && !release.episode)
  );
}

export type MatchedMetadata = {
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string;
  backdropUrl?: string;
  rating?: number;
  genres?: string[];
  metadataSource?: "cinemeta" | "tmdb" | "stashbox" | "manual";
  metadataId?: string;
};

export type WebStreamDownloadRequest = {
  download_id: string;
  stream_url: string;
  original_url?: string;
  filename: string;
  destination_dir?: string;
  remote_upload_path?: string;
  config_path?: string;
};

/**
 * Downloads a web stream or HLS stream and remuxes into a clean .mp4 using yt-dlp.
 */
export async function downloadWebStream(req: WebStreamDownloadRequest): Promise<string> {
  return invoke<string>("download_web_stream", { req });
}

export type CinextreamPayload = {
  enc: string;
  wasm_base64: string;
  category: string;
  anilist_id: string;
  episode: string;
};

/**
 * Pure in-browser WebAssembly decryptor for CineXtream / Yomi.to streams.
 * Runs natively in WebView2/Chromium using WebAssembly and crypto.subtle with zero Node.js dependency.
 */
export async function decryptCineXtreamInBrowser(payload: CinextreamPayload): Promise<string> {
  const encoder = new TextEncoder();
  const salt = "c1n3t4r-0bf5c4t10n-s4lt-v1-2024-09";
  const keyBuf = await window.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(payload.anilist_id + salt)
  );
  const key = new Uint8Array(keyBuf);

  const wasmBinary = Uint8Array.from(atob(payload.wasm_base64), (c) => c.charCodeAt(0));
  const { instance } = await WebAssembly.instantiate(wasmBinary, {
    env: { abort: () => {} },
  });
  const exports = instance.exports as any;
  const { memory, allocBuffer, freeBuffer, normalizeBuffer } = exports;

  const encBytes = Uint8Array.from(atob(payload.enc), (c) => c.charCodeAt(0));
  const encPtr = allocBuffer(encBytes.length);
  const keyPtr = allocBuffer(32);
  const outPtr = allocBuffer(encBytes.length);

  let view = new Uint8Array(memory.buffer);
  view.set(encBytes, encPtr);
  view.set(key, keyPtr);
  const len = normalizeBuffer(encPtr, encBytes.length, keyPtr, outPtr);
  view = new Uint8Array(memory.buffer);
  const out = view.slice(outPtr, outPtr + len);
  freeBuffer(encPtr);
  freeBuffer(keyPtr);
  freeBuffer(outPtr);

  const rawText = new TextDecoder().decode(out).replace(/\0+$/, "").trim();
  let decrypted: any = null;
  try {
    decrypted = JSON.parse(rawText);
  } catch {
    const start = rawText.indexOf("{");
    const end = rawText.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        decrypted = JSON.parse(rawText.slice(start, end + 1));
      } catch {}
    }
  }
  const streamUrl =
    decrypted?.stream_url ||
    decrypted?.url ||
    decrypted?.streamUrl ||
    decrypted?.stream ||
    decrypted?.link ||
    decrypted?.file ||
    decrypted?.sources?.[0]?.url ||
    decrypted?.sources?.[0]?.file ||
    (typeof decrypted === "string" && decrypted.startsWith("http") ? decrypted : null);

  if (!streamUrl) {
    console.warn("CineXtream decrypted payload:", rawText);
    throw new Error("Missing stream_url in decrypted CineXtream output");
  }
  return streamUrl;
}

/**
 * Get a local proxy URL for a stream to bypass strict CDN Referer or CORS restrictions.
 */
export async function getStreamProxyUrl(url: string, referer?: string, isHls?: boolean): Promise<string> {
  return invoke<string>("get_stream_proxy_url", { url: url.trim(), referer: referer ?? null, is_hls: isHls ?? null });
}

/**
 * Fetch web stream metadata, OpenGraph tags, and direct stream links via native Rust or Debrid.
 */
export async function fetchWebStreamInfo(url: string): Promise<WebStreamInfo> {
  const trimmed = url.trim();

  // If DropMB share link, resolve audio stream directly
  if (isDropmbUrl(trimmed)) {
    try {
      const dropmbRes = await resolveDropmbStream(trimmed);
      if (dropmbRes) {
        return {
          original_url: trimmed,
          direct_stream_url: dropmbRes.proxiedUrl,
          raw_title: dropmbRes.filename,
          clean_title: dropmbRes.title,
          provider: "dropmb",
          is_direct_media: true,
          media_type: "music",
        };
      }
    } catch (e) {
      console.warn("DropMB resolution failed during fetchWebStreamInfo:", e);
    }
  }

  // If URL is a cyberlocker link or magnet link, resolve via Debrid (Real-Debrid, Premiumize, Offcloud)
  if (isDebridResolvableUrl(trimmed)) {
    try {
      const debridStream = await resolveDebridLink(trimmed);
      if (debridStream) {
        const fn = debridStream.filename.toLowerCase();
        let detectedType: "video" | "audio" | "document" | "archive" | "photo" = "video";
        if (fn.endsWith(".mp3") || fn.endsWith(".flac") || fn.endsWith(".m4a") || fn.endsWith(".m4b") || fn.endsWith(".wav") || fn.endsWith(".opus") || fn.endsWith(".ogg")) {
          detectedType = "audio";
        } else if (fn.endsWith(".epub") || fn.endsWith(".pdf") || fn.endsWith(".mobi") || fn.endsWith(".cbr") || fn.endsWith(".cbz") || fn.endsWith(".azw3")) {
          detectedType = "document";
        } else if (fn.endsWith(".zip") || fn.endsWith(".rar") || fn.endsWith(".7z") || fn.endsWith(".tar") || fn.endsWith(".gz") || fn.endsWith(".iso")) {
          detectedType = "archive";
        } else if (fn.endsWith(".jpg") || fn.endsWith(".jpeg") || fn.endsWith(".png") || fn.endsWith(".webp") || fn.endsWith(".gif")) {
          detectedType = "photo";
        }

        return {
          original_url: trimmed,
          direct_stream_url: debridStream.streamUrl,
          raw_title: debridStream.filename,
          clean_title: debridStream.filename.replace(/\.[^/.]+$/, "").replace(/[_.]+/g, " ").trim(),
          provider: debridStream.provider,
          is_direct_media: true,
          media_type: detectedType as any,
        };
      }
    } catch (e: any) {
      console.warn("Debrid resolution failed during fetchWebStreamInfo:", e);
      if (trimmed.startsWith("magnet:?")) {
        throw e;
      }
    }
  }

  if (trimmed.startsWith("magnet:?")) {
    throw new Error("Unable to resolve magnet link. Please verify your Real-Debrid, Premiumize, or Offcloud account in Settings.");
  }

  const info = await invoke<WebStreamInfo>("fetch_web_stream_info", { url: trimmed });
  if (info.direct_stream_url?.startsWith("cinextream://")) {
    try {
      const parts = info.direct_stream_url.replace("cinextream://", "").split("/");
      const payload = await invoke<CinextreamPayload>("get_cinextream_payload", {
        anilistId: parts[0],
        episode: parts[1] || "1",
      });
      const decrypted = await decryptCineXtreamInBrowser(payload);
      info.direct_stream_url = await getStreamProxyUrl(decrypted, undefined, true);
    } catch (e) {
      console.warn("Failed in-browser CineXtream decryption during fetchWebStreamInfo:", e);
    }
  } else if (
    info.direct_stream_url &&
    !info.direct_stream_url.includes("127.0.0.1") &&
    (/^https?:\/\/[^/]+:[^/]+@/i.test(info.direct_stream_url) || info.direct_stream_url.includes("easynews.com"))
  ) {
    try {
      info.direct_stream_url = await getStreamProxyUrl(info.direct_stream_url);
    } catch {}
  }
  return info;
}

/**
 * Just-in-time stream URL resolver for playback (e.g. bypasses expiring CDN tokens).
 */
export async function resolveWebStreamUrl(url: string): Promise<string> {
  const trimmed = url.trim();
  // Loopback engines (InfiniDysk :8553, DirectPlay proxy :8552, AList :5244, …) already serve
  // the final bytes; they must never be scraped as HTML pages.
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(trimmed)) {
    return trimmed;
  }

  // If cyberlocker or magnet link, resolve via configured Debrid service
  if (isDebridResolvableUrl(trimmed)) {
    try {
      const debridStream = await resolveDebridLink(trimmed);
      if (debridStream?.streamUrl) {
        return debridStream.streamUrl;
      }
    } catch (e) {
      console.warn("Debrid resolution failed during resolveWebStreamUrl:", e);
    }
  }

  // If URL is a cinextream marker, resolve via in-browser WebAssembly
  if (trimmed.startsWith("cinextream://")) {
    try {
      const parts = trimmed.replace("cinextream://", "").split("/");
      const payload = await invoke<CinextreamPayload>("get_cinextream_payload", {
        anilistId: parts[0],
        episode: parts[1] || "1",
      });
      const decrypted = await decryptCineXtreamInBrowser(payload);
      return await getStreamProxyUrl(decrypted, undefined, true);
    } catch (e) {
      console.error("In-browser CineXtream resolution failed:", e);
    }
  }

  // If URL is a Yomi watch page and backend couldn't decrypt with node
  if (trimmed.includes("yomi.to/watch/")) {
    const match = trimmed.match(/yomi\.to\/watch\/[^/?#]+-(\d+)\/(\d+)/i);
    if (match) {
      try {
        const payload = await invoke<CinextreamPayload>("get_cinextream_payload", {
          anilistId: match[1],
          episode: match[2],
        });
        const decrypted = await decryptCineXtreamInBrowser(payload);
        return await getStreamProxyUrl(decrypted, undefined, true);
      } catch (e) {
        console.warn("Direct Yomi payload resolution failed, falling back to resolve_web_stream_url:", e);
      }
    }
  }

  try {
    const resolved = await invoke<string>("resolve_web_stream_url", { url: trimmed });
    if (resolved.includes("cinextream://")) {
      const match = resolved.match(/cinextream:\/\/(\d+)\/(\d+)/i);
      if (match) {
        const payload = await invoke<CinextreamPayload>("get_cinextream_payload", {
          anilistId: match[1],
          episode: match[2],
        });
        const decrypted = await decryptCineXtreamInBrowser(payload);
        return await getStreamProxyUrl(decrypted, undefined, true);
      }
    }
    // If resolved stream is a remote HTTP(S) m3u8, video, or URL with embedded credentials (e.g. Easynews),
    // wrap it with getStreamProxyUrl to guarantee zero CORS/Origin/BasicAuth errors
    const hasEmbeddedAuth = /^https?:\/\/[^/]+:[^/]+@/i.test(resolved);
    if (resolved.startsWith("http") && !resolved.includes("127.0.0.1") && (
      hasEmbeddedAuth ||
      resolved.includes("easynews.com") ||
      resolved.includes(".m3u8") ||
      resolved.includes("workers.dev") ||
      resolved.includes("moviebite") ||
      resolved.includes("vidmoly") ||
      resolved.includes("bright") ||
      resolved.includes("nebula") ||
      resolved.includes("cinextream") ||
      resolved.includes("yomi") ||
      resolved.includes("vkuser") ||
      resolved.includes("ok.ru") ||
      resolved.includes("sxyprn") ||
      resolved.includes("tapecontent") ||
      resolved.includes("streamtape")
    )) {
      try {
        const isHls = resolved.includes(".m3u8") || resolved.includes("cinextream") || resolved.includes("yomi");
        return await getStreamProxyUrl(resolved, undefined, isHls);
      } catch {
        return resolved;
      }
    }
    return resolved;
  } catch (err) {
    console.warn("Failed to resolve stream URL JIT, falling back to original:", err);
    return trimmed;
  }
}

/**
 * Crawl website releases feed for in-app Stremio-style discovery.
 */
export async function crawlWebsiteReleases(url: string): Promise<SiteDiscoveryFeed> {
  return invoke<SiteDiscoveryFeed>("crawl_website_releases", { url: url.trim() });
}

/**
 * Search or browse live US radio stations via iHeartRadio.
 */
export async function searchIheartRadio(query?: string): Promise<SiteDiscoveryFeed> {
  return invoke<SiteDiscoveryFeed>("search_iheart_radio", { query: query?.trim() || null });
}

/**
 * Search songs and complete albums on JioSaavn with high-efficiency AAC (.m4a).
 */
export async function searchJiosaavnStreams(query: string): Promise<SiteDiscoveryFeed> {
  return invoke<SiteDiscoveryFeed>("search_jiosaavn_streams", { query: query.trim() });
}

/**
 * Search or browse live sports events and PPV via streamed.pk API.
 */
export async function searchStreamedSports(query?: string): Promise<SiteDiscoveryFeed> {
  return invoke<SiteDiscoveryFeed>("search_streamed_sports", { query: query?.trim() || null });
}

/**
 * Search shadow library books on LibGen (epubs, pdfs, mobi).
 */
export async function searchLibgenBooks(query: string): Promise<SiteDiscoveryFeed> {
  return invoke<SiteDiscoveryFeed>("search_libgen_books", { query: query.trim() });
}

/**
 * Query Cinemeta and TMDB to match rich poster art, backdrop, and synopsis for a scraped stream.
 */
export async function matchMetadataForStream(
  cleanTitle: string,
  mediaType: LibraryType,
  yearHint?: number | null,
  tmdbApiKey?: string
): Promise<MatchedMetadata> {
  const fallback: MatchedMetadata = {
    title: cleanTitle,
    year: yearHint ?? undefined,
    metadataSource: "manual",
  };

  if (!cleanTitle.trim() || mediaType === "adult") return fallback;

  // 1. Cinemeta lookup (Free, fast, no API key required)
  if (mediaType === "movies" || mediaType === "tv") {
    const cType = mediaType === "tv" ? "series" : "movie";
    try {
      const res = await fetch(
        `https://v3-cinemeta.strem.io/catalog/${cType}/top/search=${encodeURIComponent(cleanTitle)}.json`
      );
      if (res.ok) {
        const data = await res.json();
        const metas = data?.metas;
        if (Array.isArray(metas) && metas.length > 0) {
          // If yearHint provided, try to find matching release year
          let best = metas[0];
          if (yearHint) {
            const exact = metas.find((m: any) => {
              const y = parseInt(String(m.year || m.releaseInfo || "").split("-")[0]);
              return y === yearHint;
            });
            if (exact) best = exact;
          }

          const parsedYear = parseInt(String(best.year || best.releaseInfo || "").split("-")[0]);

          return {
            title: best.name || cleanTitle,
            year: !isNaN(parsedYear) ? parsedYear : yearHint ?? undefined,
            overview: best.description,
            posterUrl: best.poster,
            backdropUrl: best.background,
            rating: typeof best.imdbRating === "number" ? best.imdbRating : parseFloat(best.imdbRating) || undefined,
            genres: Array.isArray(best.genres) ? best.genres : undefined,
            metadataSource: "cinemeta",
            metadataId: best.id,
          };
        }
      }
    } catch (e) {
      console.warn("Cinemeta lookup failed:", e);
    }
  }

  // 2. TMDB lookup if API key is provided
  if (tmdbApiKey && (mediaType === "movies" || mediaType === "tv")) {
    const tmdbType = mediaType === "tv" ? "tv" : "movie";
    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/search/${tmdbType}?query=${encodeURIComponent(cleanTitle)}&language=en-US&page=1`,
        { headers: { Authorization: `Bearer ${tmdbApiKey}` } }
      );
      if (res.ok) {
        const data = await res.json();
        const results = data?.results;
        if (Array.isArray(results) && results.length > 0) {
          const top = results[0];
          const rawDate = top.release_date || top.first_air_date || "";
          const y = parseInt(rawDate.split("-")[0]);

          return {
            title: top.title || top.name || cleanTitle,
            year: !isNaN(y) ? y : yearHint ?? undefined,
            overview: top.overview,
            posterUrl: top.poster_path ? `https://image.tmdb.org/t/p/w500${top.poster_path}` : undefined,
            backdropUrl: top.backdrop_path ? `https://image.tmdb.org/t/p/original${top.backdrop_path}` : undefined,
            rating: typeof top.vote_average === "number" ? top.vote_average : undefined,
            metadataSource: "tmdb",
            metadataId: String(top.id),
          };
        }
      }
    } catch (e) {
      console.warn("TMDB search failed:", e);
    }
  }

  return fallback;
}

/**
 * Check if a URL points to a specific video/audio file or specific watch page,
 * rather than a site root or catalog to crawl.
 */
export function isSpecificStreamOrFile(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("magnet:?")) return true;
  if (isDebridResolvableUrl(trimmed)) return true;

  const clean = trimmed.split("?")[0].split("#")[0].toLowerCase();

  // Direct media extensions
  if (
    clean.endsWith(".mp4") ||
    clean.endsWith(".mkv") ||
    clean.endsWith(".webm") ||
    clean.endsWith(".m3u8") ||
    clean.endsWith(".mpd") ||
    clean.endsWith(".avi") ||
    clean.endsWith(".mov") ||
    clean.endsWith(".flv") ||
    clean.endsWith(".ts") ||
    clean.endsWith(".m4v") ||
    clean.endsWith(".mp3") ||
    clean.endsWith(".m4a") ||
    clean.endsWith(".aac") ||
    clean.endsWith(".flac") ||
    clean.endsWith(".wav") ||
    clean.endsWith(".ogg") ||
    clean.endsWith(".opus") ||
    clean.endsWith(".epub") ||
    clean.endsWith(".pdf") ||
    clean.endsWith(".mobi") ||
    clean.endsWith(".cbz") ||
    clean.endsWith(".cbr") ||
    clean.endsWith(".cb7") ||
    clean.endsWith(".cbt") ||
    clean.endsWith(".zip") ||
    clean.endsWith(".rar") ||
    clean.endsWith(".7z") ||
    clean.endsWith(".tar") ||
    clean.endsWith(".gz") ||
    clean.endsWith(".jpg") ||
    clean.endsWith(".jpeg") ||
    clean.endsWith(".png") ||
    clean.endsWith(".webp") ||
    clean.endsWith(".gif")
  ) {
    return true;
  }

  // Specific watch / episode pages on video platforms & hosters
  return (
    trimmed.includes("/watch/") ||
    trimmed.includes("/watch?") ||
    trimmed.includes("/episode-") ||
    trimmed.includes("/view_video.php") ||
    trimmed.includes("/post/") ||
    trimmed.includes("/video/") ||
    trimmed.includes("/e/") ||
    trimmed.includes("pixeldrain.com/u/") ||
    trimmed.includes("pixeldrain.com/file/") ||
    trimmed.includes("pixeldrain.com/api/file/")
  );
}

export type ComicIssuePagesPayload = {
  issue_title: string;
  series_title?: string;
  issue_number?: number;
  total_pages: number;
  pages: string[];
  site_domain: string;
};

export async function searchComicsPortal(query: string): Promise<SiteDiscoveryFeed> {
  return await invoke<SiteDiscoveryFeed>("search_comics_portal", { query });
}

export async function extractComicIssuePages(url: string): Promise<ComicIssuePagesPayload> {
  return await invoke<ComicIssuePagesPayload>("extract_comic_issue_pages", { url });
}


