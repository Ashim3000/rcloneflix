import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore, type StremioAddonConfig, type MediaItem } from "../store/appStore";

export type NormalizedStremioStream = {
  id: string;
  addonId: string;
  addonName: string;
  name: string;
  title: string;
  cleanFilename: string;
  resolution: "4K" | "1080p" | "720p" | "480p" | "unknown";
  codec?: string;
  sizeBytes?: number;
  sizeFormatted?: string;
  tracker?: string;
  seeds?: number;
  isDebridCached: boolean;
  debridProvider?: "Real-Debrid" | "Premiumize" | "AllDebrid" | "TorBox";
  streamUrl?: string;
  infoHash?: string;
  fileIdx?: number;
};

export type ParsedAddonUrlMetadata = {
  manifestUrl: string;
  baseUrl: string;
  hasDebridEmbedded: boolean;
  debridProviders: string[];
  qualityFilter?: string[];
  sizeFilter?: string;
  sortBy?: string;
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

function formatBytes(bytes?: number): string | undefined {
  if (!bytes || bytes <= 0) return undefined;
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

/**
 * Normalizes a Stremio addon URL and extracts embedded configuration parameters
 * (such as Real-Debrid/Premiumize keys, quality filters, and size limits).
 */
export function parseStremioAddonUrl(rawUrl: string): ParsedAddonUrlMetadata {
  let cleaned = rawUrl.trim().replace(/^stremio:\/\//i, "https://");
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = `https://${cleaned}`;
  }

  // Ensure raw pipe characters in path are URL-encoded
  const [schemeAndHost, ...pathParts] = cleaned.split(/(?<=^https?:\/\/[^/]+)\//);
  const fullPath = (pathParts.join("/") || "").replace(/\|/g, "%7C");
  cleaned = fullPath ? `${schemeAndHost}/${fullPath}` : schemeAndHost;

  if (!cleaned.endsWith("/manifest.json")) {
    cleaned = cleaned.replace(/\/+$/, "") + "/manifest.json";
  }

  const baseUrl = cleaned.slice(0, -"/manifest.json".length);

  // Inspect config segment if present
  const debridProviders: string[] = [];
  let qualityFilter: string[] | undefined;
  let sizeFilter: string | undefined;
  let sortBy: string | undefined;

  try {
    const decodedPath = decodeURIComponent(fullPath);
    if (/realdebrid=[^|/&\s]+/i.test(decodedPath)) debridProviders.push("Real-Debrid");
    if (/premiumize=[^|/&\s]+/i.test(decodedPath)) debridProviders.push("Premiumize");
    if (/alldebrid=[^|/&\s]+/i.test(decodedPath)) debridProviders.push("AllDebrid");
    if (/torbox=[^|/&\s]+/i.test(decodedPath)) debridProviders.push("TorBox");

    const qMatch = decodedPath.match(/qualityfilter=([^|/&]+)/i);
    if (qMatch?.[1]) qualityFilter = qMatch[1].split(",");

    const sMatch = decodedPath.match(/sizefilter=([^|/&]+)/i);
    if (sMatch?.[1]) sizeFilter = sMatch[1];

    const sortMatch = decodedPath.match(/sort=([^|/&]+)/i);
    if (sortMatch?.[1]) sortBy = sortMatch[1];
  } catch {}

  return {
    manifestUrl: cleaned,
    baseUrl,
    hasDebridEmbedded: debridProviders.length > 0,
    debridProviders,
    qualityFilter,
    sizeFilter,
    sortBy,
  };
}

/**
 * Fetches and validates a Stremio Addon manifest.json and returns a StremioAddonConfig ready for appStore.
 */
export async function validateAndFetchStremioAddon(rawUrl: string): Promise<StremioAddonConfig> {
  const parsed = parseStremioAddonUrl(rawUrl);
  const res = await httpFetch(parsed.manifestUrl);
  if (!res.ok) {
    throw new Error(`Addon returned HTTP ${res.status}`);
  }
  const manifest = await res.json();
  if (!manifest || !manifest.id || !manifest.name) {
    throw new Error("Invalid Stremio manifest.json response");
  }

  const supportedTypes: string[] = Array.isArray(manifest.types)
    ? manifest.types
    : ["movie", "series"];
  const idPrefixes: string[] = Array.isArray(manifest.idPrefixes)
    ? manifest.idPrefixes
    : ["tt"];

  const suffix =
    parsed.debridProviders.length > 0 ? ` (${parsed.debridProviders.join(" + ")})` : "";

  return {
    id: `${manifest.id}-${Date.now().toString(36)}`,
    name: `${manifest.name}${suffix}`,
    manifestUrl: parsed.manifestUrl,
    baseUrl: parsed.baseUrl,
    version: String(manifest.version || "1.0.0"),
    description: manifest.description,
    supportedTypes,
    idPrefixes,
    hasDebridEmbedded: parsed.hasDebridEmbedded,
    enabled: true,
  };
}

/**
 * Resolves an IMDb ID ("tt...") for a MediaItem via Cinemeta search if not already set.
 */
export async function resolveImdbIdForItem(item: MediaItem): Promise<string | null> {
  if (item.metadataId?.startsWith("tt")) return item.metadataId;
  if (item.showId?.startsWith("tt")) return item.showId;

  const isTv = item.libraryType === "tv" || item.groupType === "show" || Boolean(item.showTitle);
  const type = isTv ? "series" : "movie";
  const queryTitle = (isTv ? item.showTitle || item.title : item.title)
    .replace(/\(\d{4}\)/g, "")
    .trim();

  if (!queryTitle) return null;

  try {
    const res = await httpFetch(
      `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(queryTitle)}.json`
    );
    if (res.ok) {
      const data = await res.json();
      const metas: any[] = data?.metas || [];
      const first = metas.find((m) => m?.id?.startsWith("tt"));
      if (first?.id) return first.id;
    }
  } catch {}

  return null;
}

/**
 * Parses a raw Stremio stream object into a NormalizedStremioStream.
 */
export function normalizeStremioStream(
  raw: any,
  addon: StremioAddonConfig,
  index: number
): NormalizedStremioStream {
  const name = String(raw.name || addon.name || "").trim();
  const title = String(raw.title || raw.description || "").trim();
  const combined = `${name}\n${title}`;

  // 1. Resolution
  let resolution: NormalizedStremioStream["resolution"] = "unknown";
  if (/\b(2160p|4k|uhd)\b/i.test(combined)) resolution = "4K";
  else if (/\b(1080p|1080i|fhd)\b/i.test(combined)) resolution = "1080p";
  else if (/\b(720p|hd)\b/i.test(combined)) resolution = "720p";
  else if (/\b(480p|576p|sd)\b/i.test(combined)) resolution = "480p";

  // 2. Video Codec
  let codec: string | undefined;
  if (/\b(hevc|x265|h\.?265)\b/i.test(combined)) codec = "HEVC";
  else if (/\b(av1)\b/i.test(combined)) codec = "AV1";
  else if (/\b(x264|h\.?264|avc)\b/i.test(combined)) codec = "H.264";

  // 3. File Size
  let sizeBytes: number | undefined =
    typeof raw.behaviorHints?.videoSize === "number" && raw.behaviorHints.videoSize > 0
      ? raw.behaviorHints.videoSize
      : undefined;

  if (!sizeBytes) {
    const sizeMatch =
      title.match(/💾\s*([\d.]+)\s*(GB|GiB|MB|MiB)/i) ||
      title.match(/\b([\d.]+)\s*(GB|GiB|MB|MiB)\b/i);
    if (sizeMatch) {
      const val = parseFloat(sizeMatch[1]);
      const unit = sizeMatch[2].toUpperCase();
      if (!isNaN(val)) {
        sizeBytes = unit.startsWith("G")
          ? Math.round(val * 1024 * 1024 * 1024)
          : Math.round(val * 1024 * 1024);
      }
    }
  }

  // 4. Seeders
  let seeds: number | undefined;
  const seedMatch = title.match(/👤\s*(\d+)/);
  if (seedMatch) {
    seeds = parseInt(seedMatch[1], 10);
  }

  // 5. Tracker (e.g. ⚙️ 1337x, ⚙️ TorrentGalaxy, ⚙️ EZTV)
  let tracker: string | undefined;
  const trackerMatch = title.match(/⚙️\s*([^\n\r🇬🇧🇺🇸🇮🇹🇪🇸🇫🇷🇩🇪🇯🇵🇰🇷🇷🇺]+)/u);
  if (trackerMatch?.[1]) {
    tracker = trackerMatch[1].trim();
  }

  // 6. Debrid Cache Status
  const isRdCached = /\[RD\+\]|⚡\s*RD/i.test(name);
  const isPmCached = /\[PM\+\]|⚡\s*PM/i.test(name);
  const isAdCached = /\[AD\+\]|⚡\s*AD/i.test(name);
  const isTbCached = /\[TB\+\]|⚡\s*TB/i.test(name);
  const isDebridCached = isRdCached || isPmCached || isAdCached || isTbCached || addon.hasDebridEmbedded;

  let debridProvider: NormalizedStremioStream["debridProvider"];
  if (isRdCached || /realdebrid/i.test(String(raw.url || ""))) debridProvider = "Real-Debrid";
  else if (isPmCached || /premiumize/i.test(String(raw.url || ""))) debridProvider = "Premiumize";
  else if (isAdCached || /alldebrid/i.test(String(raw.url || ""))) debridProvider = "AllDebrid";
  else if (isTbCached || /torbox/i.test(String(raw.url || ""))) debridProvider = "TorBox";

  const firstLine = (raw.behaviorHints?.filename || title.split(/\r?\n/)[0] || name)
    .replace(/[\\/:*?"<>|]/g, ".")
    .trim();

  return {
    id: `${addon.id}-${index}`,
    addonId: addon.id,
    addonName: addon.name,
    name: name.replace(/\r?\n/g, " "),
    title,
    cleanFilename: firstLine.endsWith(".mkv") || firstLine.endsWith(".mp4") ? firstLine : `${firstLine}.mp4`,
    resolution,
    codec,
    sizeBytes,
    sizeFormatted: formatBytes(sizeBytes),
    tracker,
    seeds,
    isDebridCached,
    debridProvider,
    streamUrl: typeof raw.url === "string" ? raw.url : undefined,
    infoHash: typeof raw.infoHash === "string" ? raw.infoHash.toLowerCase() : undefined,
    fileIdx: typeof raw.fileIdx === "number" ? raw.fileIdx : undefined,
  };
}

/**
 * Queries all enabled Stremio addons in parallel for a movie or specific TV episode.
 */
export async function queryStremioStreams(params: {
  imdbId: string;
  type: "movie" | "series";
  season?: number;
  episode?: number;
}): Promise<NormalizedStremioStream[]> {
  const addons = (useAppStore.getState().stremioAddons || []).filter((a) => a.enabled);
  if (addons.length === 0) return [];

  const videoId =
    params.type === "series" && params.season !== undefined && params.episode !== undefined
      ? `${params.imdbId}:${params.season}:${params.episode}`
      : params.imdbId;

  const perAddonPromises = addons.map(async (addon) => {
    try {
      const streamEndpoint = `${addon.baseUrl}/stream/${params.type}/${videoId}.json`;
      const res = await httpFetch(streamEndpoint);
      if (!res.ok) return [];
      const data = await res.json();
      const rawStreams: any[] = Array.isArray(data?.streams) ? data.streams : [];
      return rawStreams.map((s, idx) => normalizeStremioStream(s, addon, idx));
    } catch (err) {
      console.warn(`Stremio addon ${addon.name} query failed:`, err);
      return [];
    }
  });

  const nested = await Promise.all(perAddonPromises);
  return nested.flat();
}
