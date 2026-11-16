import type { MediaItem } from "../store/appStore";

export type MediaSourceVersion = {
  id: string;
  remoteName: string;
  remotePath: string;
  libraryId: string;
  resolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  sizeBytes?: number;
  container?: string;
  isLocal: boolean;
  priority: number; // 1 = Local, 2 = Telegram Serverless / Streamtape CDN, 3 = DoodStream CDN, 4 = Primary Cloud Remote
  addedAt?: number;
  sourceType?: "local" | "telegram" | "streamtape" | "doodstream" | "real-debrid" | "remote";
  expiresAt?: number;
  lastKeepAliveAt?: number;
  shareUrl?: string;
  iteration?: number;
  telegramChatId?: string;
  telegramMsgId?: number;
  telegramMimeType?: string;
  telegramDirectUrl?: string;
};

/**
 * Strict 4-tier rule-based priority:
 * Priority 1: True Local Disk
 * Priority 2: Telegram Serverless CDN (`tg-serverless` / `telegram`) & Streamtape CDN Edge Cache (Tier 1 offload)
 * Priority 3: DoodStream CDN Rolling Relay (Tier 2 fallback)
 * Priority 4: Primary Cloud Remote (OpenDrive, GDrive, OneDrive, Seedbox)
 */
export function calculateVersionPriority(
  remoteName: string,
  remotePath: string,
  isLocal: boolean
): number {
  if (isLocal) return 1;
  const rn = (remoteName || "").toLowerCase();
  const rp = (remotePath || "").toLowerCase();
  if (
    rn.includes("telegram-drive") ||
    rn.includes("telegram") ||
    rn.includes("tg-native") ||
    rn.includes("tg-serverless") ||
    rp.startsWith("telegram-drive:") ||
    rp.startsWith("telegram:") ||
    rp.startsWith("tg-native:") ||
    rp.startsWith("tg-serverless:") ||
    rn.includes("streamtape") ||
    rp.includes("streamtape")
  ) {
    return 2;
  }
  if (rn.includes("dood") || rp.includes("dood")) {
    return 3;
  }
  return 4;
}

export function createVersionFromItem(item: MediaItem, isLocal = false): MediaSourceVersion {
  const remoteName =
    item.remotePath.includes(":") ? item.remotePath.split(":")[0] : "remote";
  const priority = calculateVersionPriority(remoteName, item.remotePath, isLocal);
  const rnLower = remoteName.toLowerCase();
  const rpLower = item.remotePath.toLowerCase();
  const isTg =
    rnLower.includes("tg-serverless") ||
    rnLower.includes("telegram") ||
    rpLower.startsWith("tg-serverless:") ||
    rpLower.startsWith("telegram:");
  const sourceType = isLocal
    ? "local"
    : isTg
    ? "telegram"
    : priority === 2
    ? "streamtape"
    : priority === 3
    ? "doodstream"
    : "remote";

  return {
    id: `${item.id}-${remoteName}-${priority}`,
    remoteName,
    remotePath: item.remotePath,
    libraryId: item.libraryId,
    resolution: item.resolution,
    videoCodec: item.videoCodec,
    audioCodec: item.audioCodec,
    sizeBytes: item.sizeBytes,
    container: item.filename.split(".").pop()?.toLowerCase(),
    isLocal,
    priority,
    sourceType,
    addedAt: item.addedAt,
  };
}

/**
 * Merge two duplicate media items into a single unified item with grouped versions.
 * Preserves high-confidence metadata while accumulating all playback locations.
 */
export function mergeItemVersions(existing: MediaItem, incoming: MediaItem): MediaItem {
  const existingVersions: MediaSourceVersion[] =
    existing.versions && existing.versions.length > 0
      ? [...existing.versions]
      : [createVersionFromItem(existing)];

  const incomingVersion = createVersionFromItem(incoming);

  const alreadyHas = existingVersions.some(
    (v) => v.remotePath.toLowerCase() === incomingVersion.remotePath.toLowerCase()
  );

  const mergedVersions = alreadyHas
    ? existingVersions
    : [...existingVersions, incomingVersion];

  // Strictly sort by priority (1 -> 2 -> 3)
  mergedVersions.sort((a, b) => a.priority - b.priority);

  return {
    ...existing,
    versions: mergedVersions,
  };
}

/**
 * Returns the default playback version adhering strictly to the 3-tier hierarchy.
 */
export function pickDefaultPlaybackVersion(item: MediaItem): MediaSourceVersion {
  if (!item.versions || item.versions.length === 0) {
    return createVersionFromItem(item);
  }

  const sorted = [...item.versions].sort((a, b) => a.priority - b.priority);
  return sorted[0];
}

/**
 * Returns the next fallback version if a specific version fails (e.g. Streamtape 404/410 expired)
 */
export function getNextFallbackVersion(
  item: MediaItem,
  failedRemotePath: string
): MediaSourceVersion | null {
  if (!item.versions || item.versions.length === 0) return null;
  const sorted = [...item.versions].sort((a, b) => a.priority - b.priority);
  const remaining = sorted.filter(
    (v) => v.remotePath.toLowerCase() !== failedRemotePath.toLowerCase()
  );
  return remaining.length > 0 ? remaining[0] : null;
}
