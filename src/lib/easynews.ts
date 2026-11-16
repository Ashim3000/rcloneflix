import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore } from "../store/appStore";
import { formatFileSize, formatDuration } from "./mediaInfo";

export type EasynewsFileType = "video" | "audio" | "document" | "archive" | "photo" | "all";

export type EasynewsSortOption =
  | "relevance"
  | "dtime_desc"
  | "dtime_asc"
  | "dsize_desc"
  | "dsize_asc";

export type EasynewsSearchResult = {
  id: string;
  filename: string;
  sizeBytes: number;
  sizeFormatted: string;
  extension: string;
  duration?: number;
  durationFormatted?: string;
  postDate?: number;
  dlUrl: string;
  mediaType: "video" | "audio" | "document" | "archive" | "photo";
  resolution?: string;
  codec?: string;
};

async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url as any, init as any);
      return res as unknown as Response;
    } catch {
      // Fallback to standard fetch
    }
  }
  return await window.fetch(url, init);
}

function getFtyValues(fileType: EasynewsFileType): string[] {
  switch (fileType) {
    case "video":
      return ["VIDEO"];
    case "audio":
      return ["AUDIO"];
    case "document":
      return ["DOCUMENT"];
    case "archive":
      return ["ARCHIVE"];
    case "photo":
      return ["IMAGE"];
    case "all":
    default:
      return [];
  }
}

function getFlyValue(fileType: EasynewsFileType): number {
  switch (fileType) {
    case "video":
      return 2;
    case "audio":
      return 1;
    case "document":
      return 4;
    case "archive":
      return 8;
    case "photo":
      return 16;
    case "all":
    default:
      return 0;
  }
}

function getMediaTypeFromExt(ext: string, fly: number): "video" | "audio" | "document" | "archive" | "photo" {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (["mkv", "mp4", "avi", "mov", "wmv", "m4v", "webm", "ts"].includes(e)) return "video";
  if (["mp3", "flac", "m4a", "m4b", "aac", "ogg", "wav", "alac", "opus"].includes(e)) return "audio";
  if (["epub", "pdf", "mobi", "cbr", "cbz", "azw3", "txt", "djvu"].includes(e)) return "document";
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"].includes(e)) return "archive";
  if (["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg", "tiff", "avif"].includes(e)) return "photo";
  if (fly === 1) return "audio";
  if (fly === 4) return "document";
  if (fly === 8) return "archive";
  if (fly === 16) return "photo";
  return "video";
}

function extractTechFromFilename(fn: string) {
  const lower = fn.toLowerCase();
  let resolution: string | undefined;
  if (/\b(2160p|4k|uhd)\b/i.test(lower)) resolution = "4K";
  else if (/\b(1080p|1080i|fhd)\b/i.test(lower)) resolution = "1080p";
  else if (/\b(720p|hd)\b/i.test(lower)) resolution = "720p";
  else if (/\b(480p|576p|sd)\b/i.test(lower)) resolution = "480p";

  let codec: string | undefined;
  if (/\b(x265|h265|hevc)\b/i.test(lower)) codec = "HEVC";
  else if (/\b(x264|h264|avc)\b/i.test(lower)) codec = "H.264";
  else if (/\b(av1)\b/i.test(lower)) codec = "AV1";
  else if (/\b(flac)\b/i.test(lower)) codec = "FLAC";
  else if (/\b(mp3)\b/i.test(lower)) codec = "MP3";

  return { resolution, codec };
}

export function extractFilenameFromSubject(subject: string): string | null {
  if (!subject) return null;
  // 1. Quoted filename in Usenet subject (e.g. [01/50] - "Movie.Title.2024.1080p.mkv" yEnc (1/50))
  const quoted = subject.match(/"([^"]+\.[a-zA-Z0-9]{2,5})"/);
  if (quoted && quoted[1]) return quoted[1].trim();

  // 2. yEnc or part suffix (e.g. Movie.Title.2024.1080p.mkv yEnc)
  const yenc = subject.match(
    /([^\s"]+\.(?:mkv|mp4|avi|mov|wmv|m4v|webm|ts|mp3|flac|m4a|m4b|aac|ogg|wav|alac|opus|epub|pdf|mobi|cbr|cbz|azw3|txt|zip|rar|7z|tar|iso))(?:\s+yEnc|\s+\(\d+\/\d+\)|\s*$)/i
  );
  if (yenc && yenc[1]) return yenc[1].trim();

  // 3. Any standard media extension embedded in subject string
  const anyMedia = subject.match(
    /([a-zA-Z0-9_.\- ]+\.(?:mkv|mp4|avi|mov|wmv|m4v|webm|ts|mp3|flac|m4a|m4b|aac|ogg|wav|alac|opus|epub|pdf|mobi|cbr|cbz|azw3|txt|zip|rar|7z|tar|iso))/i
  );
  if (anyMedia && anyMedia[1]) return anyMedia[1].trim();

  return null;
}

/**
 * Robustly parses file sizes from bytes or formatted strings like "3.4 GB", "350 MB", "1.2 TB".
 */
export function parseSizeToBytes(raw: any): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "number") {
    return isNaN(raw) || raw < 0 ? 0 : Math.round(raw);
  }
  const str = String(raw).trim();
  if (!str) return 0;

  // Pure numeric string (e.g. raw bytes "3650722201")
  const cleanNumeric = str.replace(/,/g, "");
  if (/^\d+(\.\d+)?$/.test(cleanNumeric)) {
    const num = parseFloat(cleanNumeric);
    return isNaN(num) || num < 0 ? 0 : Math.round(num);
  }

  // Formatted string (e.g. "3.4 GB", "350MB", "1.2 TB", "500 KB", "1024 B")
  const match = str.match(/^([\d.,]+)\s*([a-zA-Z]+)?$/);
  if (match) {
    const val = parseFloat(match[1].replace(/,/g, ""));
    if (isNaN(val) || val < 0) return 0;
    const unit = (match[2] || "").toUpperCase();

    if (unit.startsWith("TB") || unit === "T") return Math.round(val * 1024 * 1024 * 1024 * 1024);
    if (unit.startsWith("GB") || unit === "G") return Math.round(val * 1024 * 1024 * 1024);
    if (unit.startsWith("MB") || unit === "M") return Math.round(val * 1024 * 1024);
    if (unit.startsWith("KB") || unit === "K") return Math.round(val * 1024);
    if (unit.startsWith("B") || unit === "BYTES") return Math.round(val);
    return Math.round(val);
  }

  return 0;
}

/**
 * Sanitizes search queries for Easynews Solr 2.0 index.
 * Strips quotes, colons, solr reserved syntax chars, and normalizes punctuation.
 */
export function sanitizeEasynewsQuery(rawQuery: string): string {
  if (!rawQuery) return "";
  return rawQuery
    // Strip straight, curly, and backtick quotes
    .replace(/["'“”‘’`]/g, " ")
    // Strip Solr special reserved syntax characters
    .replace(/[:*?~^{}[\]()\\/!+;]/g, " ")
    // Replace dots or underscores that separate words/tags (e.g. S01.E01 -> S01 E01)
    .replace(/([a-zA-Z0-9])[._]([a-zA-Z0-9])/g, "$1 $2")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Search Easynews Solr index across Videos, Audio, Documents, Photos, or Archives.
 */
export async function searchEasynews(
  query: string,
  fileType: EasynewsFileType = "video",
  sort: EasynewsSortOption = "relevance",
  maxSizeGb = 20,
  page = 1,
  pageSize = 50
): Promise<{ results: EasynewsSearchResult[]; total: number }> {
  const { easynewsConfig } = useAppStore.getState();
  const username = easynewsConfig?.username?.trim();
  const password = easynewsConfig?.password?.trim();

  if (!username || !password) {
    throw new Error("Easynews credentials not configured. Please add your username and password in Settings.");
  }

  const cleanQuery = sanitizeEasynewsQuery(query);
  if (!cleanQuery) {
    return { results: [], total: 0 };
  }

  const fly = getFlyValue(fileType);
  const ftyValues = getFtyValues(fileType);
  const solrUrl = new URL("https://members.easynews.com/2.0/search/solr-search/advanced");
  solrUrl.searchParams.set("gps", cleanQuery);

  // Canonical Solr 2.0 file type filtering
  if (ftyValues.length > 0) {
    for (const val of ftyValues) {
      solrUrl.searchParams.append("fty[]", val);
    }
    solrUrl.searchParams.set("fty", ftyValues[0]);
  }
  if (fly > 0) {
    solrUrl.searchParams.set("fly", String(fly));
  }

  // NOTE: sbx=1 (Safe Box) must NOT be enabled as it filters out >95% of Usenet binary/video uploads
  solrUrl.searchParams.set("pby", String(pageSize));
  solrUrl.searchParams.set("pno", String(page));

  // Map sort options to Solr sort fields
  switch (sort) {
    case "dtime_desc":
      solrUrl.searchParams.set("s1", "dtime");
      solrUrl.searchParams.set("s1d", "-");
      break;
    case "dtime_asc":
      solrUrl.searchParams.set("s1", "dtime");
      solrUrl.searchParams.set("s1d", "+");
      break;
    case "dsize_desc":
      solrUrl.searchParams.set("s1", "dsize");
      solrUrl.searchParams.set("s1d", "-");
      break;
    case "dsize_asc":
      solrUrl.searchParams.set("s1", "dsize");
      solrUrl.searchParams.set("s1d", "+");
      break;
    case "relevance":
    default:
      solrUrl.searchParams.set("s1", "relevance");
      solrUrl.searchParams.set("s1d", "-");
      break;
  }

  const authHeader = `Basic ${btoa(`${username}:${password}`)}`;
  const res = await httpFetch(solrUrl.toString(), {
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("Easynews authentication failed. Please verify your username and password.");
    }
    throw new Error(`Easynews search returned status ${res.status}`);
  }

  const json = await res.json();
  const rawData: any[] = json?.data || [];
  const results: EasynewsSearchResult[] = [];

  const rawDownUrl = json?.downURL ? String(json.downURL) : "https://members.easynews.com/dl";
  const downHost = rawDownUrl.replace(/^https?:\/\//, "").replace(/\/dl.*$/, "") || "members.easynews.com";
  const port = easynewsConfig.port === 444 ? ":444" : "";

  for (const row of rawData) {
    if (!row || typeof row !== "object") continue;

    // Handle both object-based Solr 2.0 response and legacy array structure
    const isArray = Array.isArray(row);
    const id = String(isArray ? row[0] || "" : row.id || row["0"] || row.hash || "");
    const hash = String(isArray ? row[0] : row.hash || row["0"] || id || "");
    const sig = !isArray && row.sig ? String(row.sig) : "";

    // Extract clean filename from object or array
    let rawFn = "";
    if (isArray) {
      // Index 10 is clean filename in Easynews Solr array; index 1 is Usenet Subject
      const candidateFn = String(row[10] || "");
      if (candidateFn && /\.[a-zA-Z0-9]{2,5}$/.test(candidateFn)) {
        rawFn = candidateFn;
      } else {
        // Extract embedded filename from subject string (e.g. [01/50] - "The.Movie.mkv" yEnc)
        const extracted = extractFilenameFromSubject(String(row[1] || ""));
        rawFn = extracted || candidateFn || String(row[1] || "");
      }
    } else {
      const objFn = String(row.fn || row.filename || row["10"] || "");
      if (objFn && /\.[a-zA-Z0-9]{2,5}$/.test(objFn)) {
        rawFn = objFn;
      } else {
        const extracted = extractFilenameFromSubject(String(row.subject || ""));
        rawFn = extracted || objFn || String(row.subject || "");
      }
    }

    // Strip wrapping quotes and spaces
    rawFn = rawFn.replace(/^["']+|["']+$/g, "").trim();

    const rawExt = String(isArray ? row[3] || row[2] || "" : row.extension || row.ext || row["2"] || "").trim().toLowerCase();
    const cleanExt = rawExt && rawExt !== "none" ? rawExt.replace(/^\./, "") : "";

    // Determine final clean filename with extension
    let filename = rawFn;
    if (cleanExt && !filename.toLowerCase().endsWith("." + cleanExt)) {
      filename = `${filename}.${cleanExt}`;
    }

    // Extract size: check candidates across Solr 2.0 representations
    const sizeCandidates = isArray
      ? [row[4], row[3], row[2], (row as any).rawSize, (row as any).size, (row as any).bytes]
      : [row.rawSize, row.raw_size, row.size, row.bytes, row["rawSize"], row["size"], row["bytes"], row["4"], row["15"], row["3"]];

    let sizeBytes = 0;
    for (const cand of sizeCandidates) {
      const parsed = parseSizeToBytes(cand);
      if (parsed > 0) {
        sizeBytes = parsed;
        break;
      }
    }

    const postDate = Number(isArray ? row[4] : row.ts || row.timestamp) || undefined;
    const rawRuntime = isArray ? row[10] : row.runtime || row["14"];
    const duration = typeof rawRuntime === "number" ? rawRuntime : parseInt(String(rawRuntime || "0"), 10) || undefined;

    if (!filename || (!hash && !id)) continue;
    // Exclude if explicitly larger than configured threshold (default 20 GB)
    if (maxSizeGb > 0 && sizeBytes > 0 && sizeBytes > maxSizeGb * 1024 * 1024 * 1024) continue;
    // Exclude video samples / tiny junk clips under 15 MB only when size is known (> 0)
    if (fileType === "video" && sizeBytes > 0 && sizeBytes < 15 * 1024 * 1024) continue;

    const dlUrl = `https://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${downHost}${port}/dl/${hash || id}/${encodeURIComponent(filename)}${sig ? `?sig=${encodeURIComponent(sig)}` : ""}`;

    const { resolution: detectedRes, codec: detectedCodec } = extractTechFromFilename(filename);
    const resolution = !isArray && row.fullres && row.fullres !== "0 x 0" ? String(row.fullres) : detectedRes;
    const codec = !isArray && row.vcodec && row.vcodec !== "NONE" ? String(row.vcodec) : (!isArray && row.acodec && row.acodec !== "NONE" ? String(row.acodec) : detectedCodec);

    results.push({
      id: id || hash || filename,
      filename,
      sizeBytes,
      sizeFormatted: formatFileSize(sizeBytes),
      extension: cleanExt || getMediaTypeFromExt(filename, fly),
      duration,
      durationFormatted: duration ? formatDuration(duration) : undefined,
      postDate,
      dlUrl,
      mediaType: getMediaTypeFromExt(cleanExt || filename, fly),
      resolution,
      codec,
    });
  }

  // Guarantee client-side ordering matches chosen sort option
  if (sort === "dsize_asc") {
    results.sort((a, b) => a.sizeBytes - b.sizeBytes);
  } else if (sort === "dsize_desc") {
    results.sort((a, b) => b.sizeBytes - a.sizeBytes);
  } else if (sort === "dtime_desc") {
    results.sort((a, b) => (b.postDate || 0) - (a.postDate || 0));
  } else if (sort === "dtime_asc") {
    results.sort((a, b) => (a.postDate || 0) - (b.postDate || 0));
  }

  return {
    results,
    total: json?.results || json?.recordsTotal || results.length,
  };
}

/**
 * Validates Easynews login credentials by executing a quick query.
 */
export async function testEasynewsConnection(
  username: string,
  pass: string,
  port = 443
): Promise<{ ok: boolean; message: string }> {
  try {
    const solrUrl = "https://members.easynews.com/2.0/search/solr-search/advanced?gps=test&fly=2&fty%5B%5D=VIDEO&pby=1";
    const authHeader = `Basic ${btoa(`${username.trim()}:${pass.trim()}`)}`;
    const res = await httpFetch(solrUrl, {
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
    });

    if (res.ok) {
      const data = await res.json();
      if (data && (Array.isArray(data.data) || typeof data.results === "number")) {
        return { ok: true, message: `Connected to Easynews successfully! (${data.results?.toLocaleString() || "Active"} index records available)` };
      }
      return { ok: true, message: "Connected to Easynews successfully!" };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "Invalid username or password." };
    }
    return { ok: false, message: `Server error (HTTP ${res.status})` };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Failed to reach Easynews servers." };
  }
}
