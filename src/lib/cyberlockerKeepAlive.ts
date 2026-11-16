import { useAppStore, type MediaItem } from "../store/appStore";
import { persistItems } from "./libraryDb";
import { log } from "./log";

let isKeepAliveRunning = false;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let keepAliveStartupTimer: ReturnType<typeof setTimeout> | null = null;

export type KeepAliveStats = {
  running: boolean;
  totalCyberlockerItems: number;
  nearingExpiryCount: number;
  totalKeptAlive: number;
  lastRunAt?: number;
};

/**
 * Performs a silent, background keep-alive ping by mounting an invisible,
 * sandboxed, audio-muted iframe loading the cyberlocker embed page.
 * This runs the site's client-side JavaScript and fires the analytics/view beacons
 * that reset the inactivity timer back to Day 0.
 *
 * Popups, modals, alerts, and top-level navigation are strictly blocked by the sandbox.
 */
export async function performSilentKeepAliveVisit(
  embedUrl: string,
  dwellMs = 12000
): Promise<boolean> {
  if (typeof document === "undefined") {
    return false;
  }

  return new Promise((resolve) => {
    try {
      const iframe = document.createElement("iframe");
      // Sandboxed without allow-top-navigation or allow-popups
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
      iframe.setAttribute("allow", "autoplay 'none'");
      iframe.style.position = "fixed";
      iframe.style.left = "-9999px";
      iframe.style.top = "-9999px";
      iframe.style.width = "320px";
      iframe.style.height = "240px";
      iframe.style.opacity = "0";
      iframe.style.pointerEvents = "none";
      iframe.style.visibility = "hidden";
      iframe.style.border = "none";
      iframe.tabIndex = -1;
      iframe.src = embedUrl;

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try {
          if (iframe.parentNode) {
            iframe.parentNode.removeChild(iframe);
          }
        } catch {
          // ignore
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(true);
      }, dwellMs);

      iframe.onerror = () => {
        cleanup();
        clearTimeout(timer);
        resolve(false);
      };

      document.body.appendChild(iframe);
    } catch (err) {
      console.warn("performSilentKeepAliveVisit error:", err);
      resolve(false);
    }
  });
}

/**
 * Resolves an embed/view URL suitable for the keep-alive bot from a media version.
 */
export function resolveKeepAliveEmbedUrl(
  version: { remoteName: string; remotePath: string; shareUrl?: string; sourceType?: string }
): string | null {
  if (version.shareUrl) {
    const lower = version.shareUrl.toLowerCase();
    if (lower.includes("streamtape.com") || lower.includes("dood.") || lower.includes("doodstream.")) {
      return version.shareUrl;
    }
  }

  const rp = (version.remotePath || "").toLowerCase();
  const rn = (version.remoteName || "").toLowerCase();

  // DoodStream filecode format e.g. doodstream:abc123xyz
  if (rn.includes("dood") || rp.startsWith("doodstream:")) {
    const fileCode = version.remotePath.replace(/^doodstream:/i, "").trim();
    if (fileCode) {
      return `https://dood.to/e/${fileCode}`;
    }
  }

  // Streamtape format
  if (rn.includes("streamtape") || rp.startsWith("streamtape:")) {
    // If shareUrl is known
    if (version.shareUrl) return version.shareUrl;
    // Extract file ID if present in path e.g. streamtape:TV/abc123xyz.mp4
    const filename = version.remotePath.split("/").pop() || "";
    const cleanId = filename.split(".")[0];
    if (cleanId && cleanId.length >= 8 && cleanId.length <= 25 && /^[a-zA-Z0-9_-]+$/.test(cleanId)) {
      return `https://streamtape.com/e/${cleanId}`;
    }
  }

  return null;
}

/**
 * Computes live metrics for the keep-alive bot dashboard.
 */
export function getKeepAliveMetrics(): KeepAliveStats {
  const { mediaItems, keepAliveConfig } = useAppStore.getState();
  const allItems = Object.values(mediaItems);
  const thresholdDays = keepAliveConfig?.maxDaysBeforeExpiry ?? 25;
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;

  let totalCyberlockerItems = 0;
  let nearingExpiryCount = 0;

  for (const item of allItems) {
    if (!item.versions) continue;
    for (const v of item.versions) {
      const isCyberlocker =
        v.sourceType === "streamtape" ||
        v.sourceType === "doodstream" ||
        v.remoteName?.toLowerCase().includes("streamtape") ||
        v.remoteName?.toLowerCase().includes("dood") ||
        Boolean(v.shareUrl && (v.shareUrl.includes("streamtape") || v.shareUrl.includes("dood")));

      if (isCyberlocker) {
        totalCyberlockerItems++;
        const lastPing = v.lastKeepAliveAt || v.addedAt || 0;
        if (Date.now() - lastPing >= thresholdMs) {
          nearingExpiryCount++;
        }
      }
    }
  }

  return {
    running: isKeepAliveRunning,
    totalCyberlockerItems,
    nearingExpiryCount,
    totalKeptAlive: keepAliveConfig?.totalKeptAlive ?? 0,
    lastRunAt: keepAliveConfig?.lastRunAt,
  };
}

/**
 * Runs a health check cycle, visiting streams nearing expiry to reset their timers.
 */
export async function runKeepAliveHealthCheck(options?: {
  forceCheck?: boolean;
  maxItems?: number;
}): Promise<{ visitedCount: number; eligibleTotal: number }> {
  if (isKeepAliveRunning) {
    log.info("keepalive", "Keep-alive check already running; skipping");
    return { visitedCount: 0, eligibleTotal: 0 };
  }

  const { mediaItems, keepAliveConfig, upsertMediaItem, setKeepAliveConfig } = useAppStore.getState();
  if (!options?.forceCheck && !keepAliveConfig?.enabled) {
    return { visitedCount: 0, eligibleTotal: 0 };
  }

  isKeepAliveRunning = true;
  const thresholdDays = keepAliveConfig?.maxDaysBeforeExpiry ?? 25;
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  const maxBatch = options?.maxItems ?? keepAliveConfig?.maxBatchSize ?? 5;
  const dwellMs = keepAliveConfig?.visitDwellMs ?? 12000;

  log.info("keepalive", `Starting keep-alive cycle (threshold: ${thresholdDays} days, batch limit: ${maxBatch})`);

  try {
    const allItems = Object.values(mediaItems);
    const eligibleQueue: Array<{ item: MediaItem; versionIndex: number; embedUrl: string }> = [];

    for (const item of allItems) {
      if (!item.versions) continue;
      for (let i = 0; i < item.versions.length; i++) {
        const v = item.versions[i];
        const isCyberlocker =
          v.sourceType === "streamtape" ||
          v.sourceType === "doodstream" ||
          v.remoteName?.toLowerCase().includes("streamtape") ||
          v.remoteName?.toLowerCase().includes("dood") ||
          Boolean(v.shareUrl && (v.shareUrl.includes("streamtape") || v.shareUrl.includes("dood")));

        if (!isCyberlocker) continue;

        const lastPing = v.lastKeepAliveAt || v.addedAt || 0;
        const isOldEnough = options?.forceCheck ? true : Date.now() - lastPing >= thresholdMs;

        if (isOldEnough) {
          const embedUrl = resolveKeepAliveEmbedUrl(v);
          if (embedUrl) {
            eligibleQueue.push({ item, versionIndex: i, embedUrl });
          }
        }
      }
    }

    const eligibleTotal = eligibleQueue.length;
    const batch = eligibleQueue.slice(0, maxBatch);
    let visitedCount = 0;

    log.info("keepalive", `Found ${eligibleTotal} streams eligible for keep-alive. Visiting ${batch.length}...`);

    for (const entry of batch) {
      log.info("keepalive", `Silently pinging embed beacon for "${entry.item.title}" (${entry.embedUrl})`);
      const success = await performSilentKeepAliveVisit(entry.embedUrl, dwellMs);

      if (success) {
        visitedCount++;
        // Update version keep-alive timestamp
        const updatedVersions = [...(entry.item.versions || [])];
        if (updatedVersions[entry.versionIndex]) {
          updatedVersions[entry.versionIndex] = {
            ...updatedVersions[entry.versionIndex],
            lastKeepAliveAt: Date.now(),
          };

          const updatedItem: MediaItem = {
            ...entry.item,
            versions: updatedVersions,
          };

          upsertMediaItem(updatedItem);
          await persistItems([updatedItem]);
        }
      }

      // Gentle 2-second pause between visits in batch
      await new Promise((res) => setTimeout(res, 2000));
    }

    let accountVisited = 0;
    if (keepAliveConfig?.accountWideStreamtape) {
      try {
        accountVisited = await runStreamtapeAccountKeepAlive(Math.max(0, maxBatch - visitedCount));
      } catch (err) {
        log.warn("keepalive", `Account-wide Streamtape sweep failed: ${err}`);
      }
    }

    setKeepAliveConfig({
      lastRunAt: Date.now(),
      totalKeptAlive: (keepAliveConfig?.totalKeptAlive ?? 0) + visitedCount + accountVisited,
    });

    log.info("keepalive", `Keep-alive session completed. Successfully pinged ${visitedCount} streams.`);
    return { visitedCount, eligibleTotal };
  } catch (err) {
    log.error("keepalive", `Error during keep-alive health check: ${err}`);
    return { visitedCount: 0, eligibleTotal: 0 };
  } finally {
    isKeepAliveRunning = false;
  }
}

/**
 * Initializes the background scheduler for the keep-alive bot.
 */
export function initCyberlockerKeepAliveBot(): () => void {
  const { keepAliveConfig } = useAppStore.getState();

  // Initial check 3 minutes after launch
  keepAliveStartupTimer = setTimeout(() => {
    runKeepAliveHealthCheck().catch(() => {});
  }, 3 * 60 * 1000);

  // Periodic recurring check
  const intervalHours = keepAliveConfig?.checkIntervalHours ?? 12;
  const intervalMs = intervalHours * 60 * 60 * 1000;

  keepAliveTimer = setInterval(() => {
    runKeepAliveHealthCheck().catch(() => {});
  }, intervalMs);

  return () => {
    if (keepAliveStartupTimer) clearTimeout(keepAliveStartupTimer);
    if (keepAliveTimer) clearInterval(keepAliveTimer);
  };
}

type StreamtapeApiFile = { linkid: string; name: string };

const ST_PING_MAP_KEY = "rcloneflix_st_account_pings";

function loadStPingMap(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(ST_PING_MAP_KEY) || "{}"); } catch { return {}; }
}
function saveStPingMap(map: Record<string, number>) {
  try { localStorage.setItem(ST_PING_MAP_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

/**
 * Recursively crawls the entire Streamtape account via the listfolder API
 * (same endpoint pattern already used in streamtapeOffload.ts) and returns every file's linkid.
 */
export async function discoverStreamtapeAccountFiles(): Promise<StreamtapeApiFile[]> {
  const { streamtapeConfig } = useAppStore.getState();
  if (!streamtapeConfig?.apiLogin?.trim() || !streamtapeConfig?.apiKey?.trim()) return [];

  const login = encodeURIComponent(streamtapeConfig.apiLogin.trim());
  const key = encodeURIComponent(streamtapeConfig.apiKey.trim());
  const out: StreamtapeApiFile[] = [];
  const queue: (string | null)[] = [null]; // null = account root
  const seenFolders = new Set<string>();
  let crawled = 0;

  while (queue.length > 0 && crawled < 50) { // hard folder cap — safety against API loops
    const folder = queue.shift() ?? null;
    crawled++;
    const url =
      `https://api.streamtape.com/file/listfolder?login=${login}&key=${key}` +
      (folder ? `&folder=${encodeURIComponent(folder)}` : "");
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const json = await resp.json();
      if (json?.status !== 200) continue;
      for (const f of json?.result?.files || []) {
        if (f?.linkid) out.push({ linkid: String(f.linkid), name: String(f.name || "") });
      }
      for (const fl of json?.result?.folders || []) {
        const id = String(fl?.id ?? "");
        if (id && !seenFolders.has(id)) {
          seenFolders.add(id);
          queue.push(id);
        }
      }
    } catch (err) {
      log.warn("keepalive", `Streamtape folder crawl failed for '${folder}': ${err}`);
    }
    await new Promise((r) => setTimeout(r, 500)); // API courtesy delay
  }
  return out;
}

/**
 * Pings up to maxVisits account-wide Streamtape files whose last ping exceeds the
 * configured expiry threshold. Reuses the existing sandboxed-iframe visit mechanism.
 */
export async function runStreamtapeAccountKeepAlive(maxVisits = 10): Promise<number> {
  const { keepAliveConfig } = useAppStore.getState();
  const thresholdMs = (keepAliveConfig?.maxDaysBeforeExpiry ?? 25) * 24 * 60 * 60 * 1000;
  const dwellMs = keepAliveConfig?.visitDwellMs ?? 12000;

  const files = await discoverStreamtapeAccountFiles();
  if (files.length === 0) return 0;

  const pings = loadStPingMap();
  const due = files.filter((f) => Date.now() - (pings[f.linkid] || 0) >= thresholdMs);
  log.info("keepalive", `Account-wide Streamtape: ${files.length} files total, ${due.length} due for ping.`);

  let visited = 0;
  for (const f of due.slice(0, maxVisits)) {
    const ok = await performSilentKeepAliveVisit(`https://streamtape.com/e/${f.linkid}`, dwellMs);
    if (ok) {
      pings[f.linkid] = Date.now();
      visited++;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  saveStPingMap(pings);
  return visited;
}

