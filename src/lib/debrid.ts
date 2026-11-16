import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore } from "../store/appStore";

export type DebridResolvedStream = {
  streamUrl: string;
  filename: string;
  sizeBytes?: number;
  provider: "real-debrid" | "premiumize" | "offcloud" | "pixeldrain";
};

export type InstantCacheCheck = {
  isCached: boolean;
  provider?: "real-debrid" | "premiumize" | "offcloud";
  infoHash?: string;
};

async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url as any, init as any);
      return res as unknown as Response;
    } catch {
      // Fallback to fetch
    }
  }
  return await window.fetch(url, init);
}

const SUPPORTED_HOSTERS_REGEX = /(?:rapidgator\.net|1fichier\.com|gofile\.io|pixeldrain\.com|turbobit\.net|nitroflare\.com|uploaded\.net|scribd\.com|mega\.nz|uptobox\.com|ddownload\.com|filefactory\.com|alfafile\.net|katfile\.com|dropapk\.to|clicknupload\.(?:org|click)|fastclick\.to|mexashare\.com|rosefile\.net|send\.cm|streamtape\.com|vidoza\.net|mixdrop\.(?:co|to)|voe\.sx)/i;

/**
 * Checks if a given URL is a torrent magnet or cyberlocker hoster link.
 */
export function isDebridResolvableUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.startsWith("magnet:?")) return true;
  return SUPPORTED_HOSTERS_REGEX.test(trimmed);
}

/**
 * Converts RFC 4648 Base32 string to 40-character hexadecimal SHA-1 string.
 */
function base32ToHex(base32: string): string {
  const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (let i = 0; i < base32.length; i++) {
    const val = base32chars.indexOf(base32.charAt(i).toUpperCase());
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    const chunk = bits.substring(i, i + 4);
    hex += parseInt(chunk, 2).toString(16);
  }
  return hex;
}

/**
 * Extracts a normalized 40-character lowercase hex infohash from a magnet link or hash string.
 */
export function extractTorrentInfoHash(urlOrMagnet: string): string | null {
  const m = urlOrMagnet.match(/urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  if (!m) {
    const directHex = urlOrMagnet.match(/^[a-fA-F0-9]{40}$/);
    if (directHex) return directHex[0].toLowerCase();
    const directB32 = urlOrMagnet.match(/^[a-zA-Z2-7]{32}$/);
    if (directB32) return base32ToHex(directB32[0]).toLowerCase();
    return null;
  }
  const hash = m[1];
  if (hash.length === 40) {
    return hash.toLowerCase();
  }
  if (hash.length === 32) {
    return base32ToHex(hash).toLowerCase();
  }
  return null;
}

// ─── Instant Cache Checking ──────────────────────────────────────────────────

/**
 * Checks if a torrent infohash is instantly cached on Real-Debrid.
 */
export async function checkRealDebridInstantAvailability(
  hash: string,
  apiKey: string
): Promise<boolean> {
  const cleanHash = hash.toLowerCase();
  try {
    const res = await httpFetch(
      `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${cleanHash}`,
      {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      }
    );
    if (!res.ok) return false;
    const data = await res.json();
    const rd = data?.[cleanHash]?.rd;
    return Boolean(Array.isArray(rd) && rd.length > 0);
  } catch {
    return false;
  }
}

/**
 * Checks if a torrent or magnet link is instantly cached on Premiumize.
 */
export async function checkPremiumizeCache(
  magnetOrHash: string,
  apiKey: string
): Promise<boolean> {
  try {
    const res = await httpFetch(
      `https://www.premiumize.me/api/cache/check?items[]=${encodeURIComponent(
        magnetOrHash.trim()
      )}&apikey=${encodeURIComponent(apiKey.trim())}`
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data?.status === "success" && Boolean(data?.response?.[0]);
  } catch {
    return false;
  }
}

/**
 * Queries active configured debrid services to check if a torrent magnet is instantly cached.
 */
export async function checkTorrentInstantCache(
  urlOrMagnet: string
): Promise<InstantCacheCheck> {
  const hash = extractTorrentInfoHash(urlOrMagnet);
  if (!hash) return { isCached: false };

  const { debridConfig } = useAppStore.getState();

  // 1. Check Real-Debrid
  if (debridConfig?.realDebridApiKey?.trim()) {
    const isRdCached = await checkRealDebridInstantAvailability(
      hash,
      debridConfig.realDebridApiKey
    );
    if (isRdCached) {
      return { isCached: true, provider: "real-debrid", infoHash: hash };
    }
  }

  // 2. Check Premiumize
  if (debridConfig?.premiumizeApiKey?.trim()) {
    const isPremCached = await checkPremiumizeCache(
      urlOrMagnet,
      debridConfig.premiumizeApiKey
    );
    if (isPremCached) {
      return { isCached: true, provider: "premiumize", infoHash: hash };
    }
  }

  return { isCached: false, infoHash: hash };
}

// ─── Real-Debrid ─────────────────────────────────────────────────────────────

export async function testRealDebridKey(apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await httpFetch("https://api.real-debrid.com/rest/1.0/user", {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
    });
    if (res.ok) {
      const data = await res.json();
      return {
        ok: true,
        message: `Connected as ${data.username || "User"} (${data.type === "premium" ? "Premium Active" : "Free Account"})`,
      };
    }
    return { ok: false, message: `Invalid API token (HTTP ${res.status})` };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Failed to reach Real-Debrid API." };
  }
}

export async function unrestrictRealDebrid(url: string, apiKey: string): Promise<DebridResolvedStream> {
  const trimmed = url.trim();

  // 1. Magnet links
  if (trimmed.startsWith("magnet:?")) {
    const form = new URLSearchParams();
    form.set("magnet", trimmed);

    const addRes = await httpFetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    if (!addRes.ok) {
      const errText = await addRes.text().catch(() => "");
      throw new Error(`Real-Debrid failed to add magnet (HTTP ${addRes.status}): ${errText}`);
    }

    const { id } = await addRes.json();
    if (!id) throw new Error("Missing torrent ID from Real-Debrid addMagnet response");

    // Phase 1: Wait for status to leave 'magnet_conversion'
    let info: any = null;
    let attempts = 0;
    while (attempts < 10) {
      const infoRes = await httpFetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${id}`, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      });
      if (infoRes.ok) {
        info = await infoRes.json();
        if (info?.status !== "magnet_conversion") {
          break;
        }
      }
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!info) {
      throw new Error("Timed out waiting for Real-Debrid to process magnet metadata.");
    }

    // Phase 2: If status is 'waiting_files_selection', select files
    if (info.status === "waiting_files_selection") {
      await httpFetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${id}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "files=all",
      });

      // Brief delay for state transition
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Re-fetch info
      const updatedRes = await httpFetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${id}`, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      });
      if (updatedRes.ok) {
        info = await updatedRes.json();
      }
    }

    // Phase 3: If not yet 'downloaded', poll briefly (cached torrents transition almost instantly)
    if (info?.status !== "downloaded" && info?.status !== "dead" && info?.status !== "error") {
      let pollCount = 0;
      while (pollCount < 6) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const pollRes = await httpFetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${id}`, {
          headers: { Authorization: `Bearer ${apiKey.trim()}` },
        });
        if (pollRes.ok) {
          info = await pollRes.json();
          if (info?.status === "downloaded") break;
        }
        pollCount++;
      }
    }

    if (info?.status === "dead" || info?.status === "error" || info?.status === "magnet_error") {
      throw new Error(`Real-Debrid torrent failed with status: ${info?.status}`);
    }

    const links: string[] = info?.links || [];
    if (!links.length || info?.status !== "downloaded") {
      const progress = typeof info?.progress === "number" ? `${info.progress}%` : "0%";
      const speed = info?.speed ? ` at ${(info.speed / 1024 / 1024).toFixed(1)} MB/s` : "";
      const seeders = info?.seeders != null ? ` (${info.seeders} seeders)` : "";
      throw new Error(
        `Torrent is caching to Real-Debrid cloud: ${progress}${speed}${seeders}. Direct stream will be available once caching completes.`
      );
    }

    // Phase 4: Identify largest media file among selected files to avoid streaming sample/nfo
    let targetLinkIndex = 0;
    if (Array.isArray(info.files) && info.files.length > 0) {
      const selectedFiles = info.files.filter((f: any) => f.selected === 1);
      let maxBytes = 0;
      selectedFiles.forEach((f: any, idx: number) => {
        if (f.bytes && f.bytes > maxBytes) {
          maxBytes = f.bytes;
          targetLinkIndex = idx;
        }
      });
    }

    const bestLink = links[targetLinkIndex] || links[0];
    return await unrestrictRealDebrid(bestLink, apiKey);
  }

  // 2. Cyberlocker / Hoster links
  const form = new URLSearchParams();
  form.set("link", trimmed);

  const res = await httpFetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Real-Debrid unrestrict failed (HTTP ${res.status}): ${errText}`);
  }

  const data = await res.json();
  const streamUrl = data.download || data.link;
  if (!streamUrl) {
    throw new Error("No download stream URL returned by Real-Debrid.");
  }

  return {
    streamUrl,
    filename: data.filename || "RealDebrid_Stream",
    sizeBytes: data.filesize || undefined,
    provider: "real-debrid",
  };
}

// ─── Premiumize.me ───────────────────────────────────────────────────────────

export async function testPremiumizeKey(apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await httpFetch(`https://www.premiumize.me/api/account/info?apikey=${encodeURIComponent(apiKey.trim())}`);
    if (res.ok) {
      const data = await res.json();
      if (data.status === "success") {
        return {
          ok: true,
          message: `Connected to Premiumize (${data.premium_until ? "Premium Active" : "Active"})`,
        };
      }
    }
    return { ok: false, message: "Invalid Premiumize API key." };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Failed to reach Premiumize.me API." };
  }
}

export async function unrestrictPremiumize(url: string, apiKey: string): Promise<DebridResolvedStream> {
  const trimmed = url.trim();

  // Try directdl first (instant streaming for cached torrents and file hosters)
  const form = new URLSearchParams();
  form.set("src", trimmed);
  form.set("apikey", apiKey.trim());

  try {
    const res = await httpFetch("https://www.premiumize.me/api/transfer/directdl", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.status === "success") {
        const firstContent = Array.isArray(data.content) && data.content.length > 0
          ? (data.content.find((c: any) => c.stream_link || c.link) || data.content[0])
          : null;

        const streamUrl =
          data.location ||
          data.link ||
          data.stream_link ||
          firstContent?.stream_link ||
          firstContent?.link;

        if (streamUrl) {
          return {
            streamUrl,
            filename: data.filename || firstContent?.path || firstContent?.name || "Premiumize_Stream",
            sizeBytes: data.filesize || firstContent?.size || undefined,
            provider: "premiumize",
          };
        }
      }
    }
  } catch (err) {
    console.warn("Premiumize directdl attempt error:", err);
  }

  // If magnet link wasn't cached, create cloud transfer and check status
  if (trimmed.startsWith("magnet:?")) {
    const createForm = new URLSearchParams();
    createForm.set("src", trimmed);
    createForm.set("apikey", apiKey.trim());

    const createRes = await httpFetch("https://www.premiumize.me/api/transfer/create", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createForm.toString(),
    });

    if (!createRes.ok) {
      throw new Error(`Premiumize failed to create transfer (HTTP ${createRes.status})`);
    }

    const createData = await createRes.json();
    if (createData.status !== "success") {
      throw new Error(createData.message || "Failed to create Premiumize cloud transfer.");
    }

    // Poll transfer list briefly (up to 8 seconds) in case it finishes quickly
    let pollCount = 0;
    while (pollCount < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const listRes = await httpFetch(
        `https://www.premiumize.me/api/transfer/list?apikey=${encodeURIComponent(apiKey.trim())}`
      );
      if (listRes.ok) {
        const listData = await listRes.json();
        const transfers = listData.transfers || [];
        const match = transfers.find((t: any) => t.id === createData.id || t.src === trimmed);
        if (match) {
          if (match.status === "finished" || match.status === "seeding") {
            // Once finished, retry directdl
            return await unrestrictPremiumize(trimmed, apiKey);
          }
          if (match.status === "running" || match.status === "waiting") {
            const pct = match.progress ? `${Math.round(match.progress * 100)}%` : "caching";
            throw new Error(
              `Torrent added to Premiumize cloud (${pct}). Direct stream will be available once download completes.`
            );
          }
        }
      }
      pollCount++;
    }

    throw new Error("Torrent added to Premiumize cloud. Direct stream will be available once download completes.");
  }

  throw new Error("Failed to unrestrict link via Premiumize.");
}

// ─── Offcloud ────────────────────────────────────────────────────────────────

function extractPixeldrainId(u: string): string | null {
  const m = u.match(/pixeldrain\.com\/(?:u|api\/file|file)\/([a-zA-Z0-9_-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function extractMagnetHash(u: string): string | null {
  return extractTorrentInfoHash(u);
}

export async function testOffcloudKey(apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await httpFetch(`https://offcloud.com/api/cloud/history?key=${encodeURIComponent(apiKey.trim())}`);
    if (res.ok) {
      const data = await res.json();
      if (data && !data.error) {
        return {
          ok: true,
          message: "Connected to Offcloud (Active Account)",
        };
      }
    }
    return { ok: false, message: "Invalid Offcloud API key." };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Failed to reach Offcloud API." };
  }
}

export async function unrestrictOffcloud(url: string, apiKey: string): Promise<DebridResolvedStream> {
  const trimmed = url.trim();
  const key = apiKey.trim();
  const pdId = extractPixeldrainId(trimmed);
  const magHash = extractMagnetHash(trimmed);

  // 1. Check if the URL is already cached / downloaded in user's Offcloud cloud history
  try {
    const historyRes = await httpFetch(`https://offcloud.com/api/cloud/history?key=${encodeURIComponent(key)}`);
    if (historyRes.ok) {
      const history = await historyRes.json();
      if (Array.isArray(history)) {
        const cleanUrl = trimmed.toLowerCase();
        const cachedItem = history.find((it: any) => {
          const orig = String(it.originalLink || it.url || "").toLowerCase();
          const origPdId = extractPixeldrainId(orig);
          const origMag = extractMagnetHash(orig);
          if (pdId && (origPdId === pdId || orig.includes(pdId) || String(it.fileName || "").toLowerCase().includes(pdId))) return true;
          if (magHash && (origMag === magHash || orig.includes(magHash) || String(it.fileName || "").toLowerCase().includes(magHash))) return true;
          return orig === cleanUrl || (orig.length > 10 && cleanUrl.includes(orig));
        });

        if (cachedItem && (cachedItem.status === "downloaded" || cachedItem.downloadUrl)) {
          const streamUrl =
            cachedItem.downloadUrl ||
            `https://offcloud.com/cloud/download/${cachedItem.requestId}/${encodeURIComponent(cachedItem.fileName || "Offcloud_Stream")}`;
          return {
            streamUrl,
            filename: cachedItem.fileName || "Offcloud_Stream",
            sizeBytes: cachedItem.fileSize || undefined,
            provider: "offcloud",
          };
        }
      }
    }
  } catch (e) {
    console.warn("Offcloud history check failed:", e);
  }

  // 2. Fallback to /api/cloud/download
  const res = await httpFetch("https://offcloud.com/api/cloud/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: trimmed, key }),
  });

  if (!res.ok) {
    throw new Error(`Offcloud download request failed (HTTP ${res.status})`);
  }

  const data = await res.json();
  const notifObj = data?.notifs || data?.notif || data;
  const requestId = notifObj?.requestId || data?.requestId;
  const fileName = notifObj?.fileName || notifObj?.filename || data?.fileName || data?.filename || "Offcloud_Stream";

  const streamUrl =
    data?.url ||
    data?.downloadUrl ||
    notifObj?.downloadUrl ||
    (requestId && fileName
      ? `https://offcloud.com/cloud/download/${requestId}/${encodeURIComponent(fileName)}`
      : null);

  if (streamUrl) {
    return {
      streamUrl,
      filename: fileName,
      sizeBytes: notifObj?.fileSize || data?.fileSize || undefined,
      provider: "offcloud",
    };
  }

  // If not immediately available, poll history briefly (up to 6s)
  if (requestId) {
    let poll = 0;
    while (poll < 3) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const histRes = await httpFetch(`https://offcloud.com/api/cloud/history?key=${encodeURIComponent(key)}`);
        if (histRes.ok) {
          const hist = await histRes.json();
          if (Array.isArray(hist)) {
            const item = hist.find((h: any) => h.requestId === requestId);
            if (item && (item.status === "downloaded" || item.downloadUrl)) {
              return {
                streamUrl: item.downloadUrl || `https://offcloud.com/cloud/download/${item.requestId}/${encodeURIComponent(item.fileName || fileName)}`,
                filename: item.fileName || fileName,
                sizeBytes: item.fileSize || undefined,
                provider: "offcloud",
              };
            }
          }
        }
      } catch {}
      poll++;
    }
  }

  throw new Error(`Torrent added to Offcloud cloud. Direct stream will be available once download completes.`);
}

// ─── Master Resolver ─────────────────────────────────────────────────────────

/**
 * Tries to resolve a cyberlocker or magnet link with any configured debrid service.
 */
export async function resolveDebridLink(url: string): Promise<DebridResolvedStream | null> {
  const { debridConfig } = useAppStore.getState();

  let lastError: Error | null = null;
  let hasConfiguredProvider = false;

  // 1. Real-Debrid
  if (debridConfig?.realDebridApiKey?.trim()) {
    hasConfiguredProvider = true;
    try {
      return await unrestrictRealDebrid(url, debridConfig.realDebridApiKey);
    } catch (e: any) {
      console.warn("Real-Debrid unrestrict failed:", e);
      lastError = e;
    }
  }

  // 2. Premiumize
  if (debridConfig?.premiumizeApiKey?.trim()) {
    hasConfiguredProvider = true;
    try {
      return await unrestrictPremiumize(url, debridConfig.premiumizeApiKey);
    } catch (e: any) {
      console.warn("Premiumize unrestrict failed:", e);
      lastError = e;
    }
  }

  // 3. Offcloud
  if (debridConfig?.offcloudApiKey?.trim()) {
    hasConfiguredProvider = true;
    try {
      return await unrestrictOffcloud(url, debridConfig.offcloudApiKey);
    } catch (e: any) {
      console.warn("Offcloud unrestrict failed:", e);
      lastError = e;
    }
  }

  // 4. Pixeldrain Direct API Fallback
  if (url.includes("pixeldrain.com/")) {
    const fileId =
      url.split("/u/")[1]?.split(/[?#/]/)[0] ||
      url.split("/api/file/")[1]?.split(/[?#/]/)[0] ||
      url.split("/file/")[1]?.split(/[?#/]/)[0];
    if (fileId) {
      return {
        streamUrl: `https://pixeldrain.com/api/file/${fileId}`,
        filename: `Pixeldrain_${fileId}`,
        provider: "pixeldrain",
      };
    }
  }

  if (url.trim().startsWith("magnet:?")) {
    if (!hasConfiguredProvider) {
      throw new Error(
        "Unable to resolve magnet link. Please configure your Real-Debrid, Premiumize, or Offcloud account in Settings > Debrid."
      );
    }
    if (lastError) {
      throw lastError;
    }
  }

  return null;
}
