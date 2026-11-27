/**
 * Serverless Encrypted .rflix Access Pass Engine
 *
 * Implements 1-Click Zero-Passphrase Sharing Passes:
 * - Scoped rclone.conf extraction (only necessary remotes, prefixed with shared_)
 * - Rich metadata ingest directly from grantor's cloud backup (.rcloneflix_backup.json.gz)
 * - Single-use token enforcement on cloud remote (${remote}:.rflix_passes/<pass_id>.json)
 * - Strict expiry (1d, 7d, 60d, lifetime) verified with network NTP/HTTP time
 * - Zero-passphrase AES-256-GCM envelope encryption
 * - 1-Click clean removal and stream cut-off at expiry
 */

import {
  useAppStore,
  type Library,
  type LibraryType,
  type MediaItem,
  type AccessPassDuration,
  type IssuedPass,
  type WeeklyRecommendation,
  type PassSyncInfo,
} from "../store/appStore";
import { invoke } from "@tauri-apps/api/core";
import { loadUdropConfig, saveUdropConfig } from "./udrop";
import { encryptBytes, decryptBytes } from "./crypto";
import {
  rcloneUploadBytes,
  rcloneReadBytes,
  rcloneReadBackup,
  rcloneMergeScopedConfig,
  rcloneRemoveScopedRemotes,
  writeLocalFileBytes,
  saveAccessPassFile,
} from "./tauri";
import { backupToRemote, BACKUP_FILE } from "./rcloneSync";
import { persistItems, persistProgress, persistProgressBatch, clearLibrary, setLibrarySyncPaused, deleteItems } from "./libraryDb";
import {
  CATALOG_VERSION,
  MAX_CATALOG_BYTES,
  buildGuestCatalogBody,
  encodeBody,
  generateCatalogKey,
  mergeGuestRecommendations,
  packCatalog,
  planCatalogApply,
  sha256Hex,
  unpackCatalog,
  type CatalogManifest,
  type GuestCatalogBody,
} from "./guestCatalog";
import { log } from "./log";
import { getUserBookmarks } from "./siteBookmarks";

export const ACCESS_PASS_MAGIC = "RFLIX_V1";
export const PASS_ENVELOPE_KEY = "rcloneflix-access-pass-v1-envelope";

export type AccessPassType = "guest" | "admin";

export type SharedLibraryMeta = {
  id: string;
  name: string;
  type: LibraryType;
  remotePaths: string[];
};

export type AdminPassPayload = {
  fullRcloneConfig: string;
  libraries: Library[];
  playback?: any;
  rcloneSettings?: any;
  secrets?: {
    tmdbApiKey?: string;
    thePornDbApiKey?: string;
    googleClientId?: string;
    kaggleUsername?: string;
    kaggleKey?: string;
    debridConfig?: any;
    easynewsConfig?: any;
    streamtapeConfig?: any;
    doodstreamConfig?: any;
    ghaConfig?: any;
    simklSettings?: any;
    traktSettings?: any;
    iptvConfig?: any;
    telegramConfig?: any;
    keepAliveConfig?: any;
    udropConfig?: any;
    usenetServerConfig?: any;
    omgUser?: string;
    omgKey?: string;
    catboxConfig?: any;
    stashBoxProviders?: any[];
  };
  stremioAddons?: any[];
  mediaItems?: Record<string, MediaItem>;
  watchProgress?: Record<string, any>;
  favorites?: Record<string, number>;
  playlists?: Record<string, any>;
  siteBookmarks?: any[];
};

export type AccessPassPayload = {
  magic: "RFLIX_V1";
  version: 1;
  passType?: AccessPassType;
  passId: string;
  label: string;
  duration: AccessPassDuration;
  createdAt: number;
  scopedRcloneConfig: string;
  sharedLibraries: SharedLibraryMeta[];
  tokenPath: string;
  backupPath: string;
  catalogKey?: string;     // per-pass AES key for the encrypted catalog
  catalogPath?: string;    // guest-scoped: <shared>:.rflix_passes/catalog_<passId>.rfc
  manifestPath?: string;   // guest-scoped: <shared>:.rflix_passes/<passId>.catalog.json
  lnurl?: string;
  adminPayload?: AdminPassPayload;
  weeklyRecommendations?: Record<string, WeeklyRecommendation[]>; // keyed by ORIGINAL library id
  remoteMapping?: Record<string, string>; // orig remote -> anonymized scoped name (guest passes, v1.0.3+)
};

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64.trim());
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export type PassToken = {
  passId: string;
  label: string;
  duration: AccessPassDuration;
  createdAt: number;
  status: "unclaimed" | "claimed" | "revoked" | "expired";
  claimedBy: string | null;
  claimedAt: number | null;
  expiresAt: number | null;
};

export function durationToMs(duration: AccessPassDuration): number | null {
  switch (duration) {
    case "1d":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "60d":
      return 60 * 24 * 60 * 60 * 1000;
    case "lifetime":
      return null;
  }
}

export function formatDuration(duration: AccessPassDuration): string {
  switch (duration) {
    case "1d":
      return "1 Day";
    case "7d":
      return "1 Week";
    case "60d":
      return "60 Days";
    case "lifetime":
      return "Lifetime (Never Expires)";
  }
}

/**
 * Resiliently fetches accurate network time from Cloudflare trace or HTTP Date headers
 * to prevent device clock manipulation. Falls back to Date.now() if offline.
 */
export async function getNetworkTime(): Promise<number> {
  try {
    const res = await fetch("https://cloudflare.com/cdn-cgi/trace", {
      cache: "no-store",
      signal: AbortSignal.timeout(3500),
    });
    if (res.ok) {
      const text = await res.text();
      const match = text.match(/ts=(\d+(\.\d+)?)/);
      if (match && match[1]) {
        return Math.floor(parseFloat(match[1]) * 1000);
      }
    }
  } catch {
    // try fallback
  }

  try {
    const headRes = await fetch("https://www.google.com", {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    const dateHeader = headRes.headers.get("date");
    if (dateHeader) {
      const ts = new Date(dateHeader).getTime();
      if (!isNaN(ts) && ts > 0) return ts;
    }
  } catch {
    // try fallback
  }

  return Date.now();
}

/**
 * Returns or generates a persistent device UUID for single-use token binding.
 */
export function getDeviceId(): string {
  const KEY = "rcloneflix-device-uuid";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `dev_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

/**
 * Parses INI-style rclone.conf content into sections with their raw key-value pairs.
 */
export function parseRcloneIni(content: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let currentSection: Map<string, string> | null = null;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const name = trimmed.slice(1, -1).trim();
      currentSection = new Map<string, string>();
      sections.set(name, currentSection);
      continue;
    }
    if (currentSection) {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        currentSection.set(key, value);
      }
    }
  }

  return sections;
}

/**
 * Finds all remote names that a given remote depends on (e.g. crypt remote referencing base remote).
 */
export function findRemoteDependencies(
  remoteName: string,
  sections: Map<string, Map<string, string>>,
  visited: Set<string> = new Set()
): Set<string> {
  if (visited.has(remoteName)) return visited;
  visited.add(remoteName);

  const section = sections.get(remoteName);
  if (!section) return visited;

  for (const [key, value] of section.entries()) {
    // Check for "remote = base_remote:path" or "remotes = ..." or values ending with ':'
    if (key === "remote" || key === "upstreams" || key === "remotes") {
      const parts = value.split(/[\s,]+/);
      for (const part of parts) {
        const depRemote = part.split(":")[0]?.trim();
        if (depRemote && sections.has(depRemote)) {
          findRemoteDependencies(depRemote, sections, visited);
        }
      }
    } else if (value.includes(":")) {
      const candidate = value.split(":")[0]?.trim();
      if (candidate && sections.has(candidate)) {
        findRemoteDependencies(candidate, sections, visited);
      }
    }
  }

  return visited;
}

/**
 * Extracts a scoped, isolated, ANONYMIZED rclone config for guest passes.
 * Library remotes become shared_cloud_1, 2…; offload remotes shared_fast_1, 2…
 * The shared_ prefix is LOAD-BEARING (write guards, pickers, guest detection,
 * teardown all key on it) — never remove it.
 */
export function extractScopedRcloneConfig(
  configContent: string,
  requiredRemoteNames: string[],
  offloadRemoteNames: Set<string> = new Set(),
  namePrefix: string = ""
): { scopedConfig: string; remoteMapping: Record<string, string> } {
  const sections = parseRcloneIni(configContent);
  const allNeededRemotes = new Set<string>();

  for (const req of requiredRemoteNames) {
    findRemoteDependencies(req, sections, allNeededRemotes);
  }

  const remoteMapping: Record<string, string> = {};
  let cloudIdx = 1;
  let fastIdx = 1;
  for (const r of allNeededRemotes) {
    const isOffload =
      offloadRemoteNames.has(r) || /^(udrop|tg[-_]|telegram|streamtape|dropmb|dood)/i.test(r);
    remoteMapping[r] = isOffload ? `shared_${namePrefix}fast_${fastIdx++}` : `shared_${namePrefix}cloud_${cloudIdx++}`;
  }

  const outputLines: string[] = [];

  for (const origRemote of allNeededRemotes) {
    const sectionProps = sections.get(origRemote);
    if (!sectionProps) continue;

    outputLines.push(`[${remoteMapping[origRemote]}]`);

    for (const [key, rawValue] of sectionProps.entries()) {
      // Scrub display-identity fields ONLY. NEVER scrub auth fields
      // (user, username, pass, token, client_id, drive_id…) — WebDAV/uDrop/SFTP
      // authenticate with `user`/`pass`, and OneDrive needs drive_id.
      if (/^(email|account_email|user_name|drive_user|owner|organization|team_drive_name)$/i.test(key)) {
        continue;
      }

      let value = rawValue;
      // NEVER rewrite backend type or vendor (historical `type = shared_opendrive`
      // bug — sanitizeScopedRcloneConfig at :330 exists to repair exactly that)
      if (key !== "type" && key !== "vendor") {
        for (const [depOrig, depAnon] of Object.entries(remoteMapping)) {
          if (value.startsWith(`${depOrig}:`)) {
            value = `${depAnon}:${value.slice(depOrig.length + 1)}`;
          } else if (value.includes(` ${depOrig}:`)) {
            value = value.split(` ${depOrig}:`).join(` ${depAnon}:`);
          } else if (value === depOrig && (key === "remote" || key === "upstreams" || key === "remotes")) {
            value = depAnon;
          }
        }
      }
      outputLines.push(`${key} = ${value}`);
    }
    outputLines.push("");
  }

  return {
    scopedConfig: outputLines.join("\n").trim(),
    remoteMapping,
  };
}

/**
 * Sanitizes scoped rclone config content.
 * Guarantees that the backend `type` property is never prefixed with `shared_`
 * (e.g. `type = shared_opendrive` is corrected back to `type = opendrive`).
 */
export function sanitizeScopedRcloneConfig(scopedConfig: string): string {
  const lines = scopedConfig.split(/\r?\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("type = shared_") || trimmed.startsWith("type=shared_")) {
        return line.replace(/type\s*=\s*shared_/, "type = ");
      }
      return line;
    })
    .join("\n");
}

const NON_WRITABLE_REMOTE_NAMES = new Set([
  "streamtape",
  "doodstream",
  "dropmb",
  "realdebrid",
  "premiumize",
  "nzbdav",
  "alldebrid",
  "torbox",
  "easynews",
  "telegram-drive",
]);

const WRITABLE_CLOUD_BACKEND_TYPES = new Set([
  "drive",
  "opendrive",
  "onedrive",
  "dropbox",
  "s3",
  "box",
  "jottacloud",
  "pcloud",
  "mega",
  "b2",
  "webdav",
  "crypt",
  "alias",
  "chunker",
  "union",
]);

/**
 * Returns true if the remote or any of its underlying dependency remotes
 * points to localhost / 127.0.0.1 (e.g. local AList streamtape or telegram-drive).
 */
export function isLoopbackRemote(
  remoteName: string,
  sections: Map<string, Map<string, string>>
): boolean {
  const cleanName = remoteName.replace(/^shared_/, "");
  const deps = findRemoteDependencies(cleanName, sections);
  if (deps.size === 0) return true;
  for (const dep of deps) {
    const sec = sections.get(dep);
    if (!sec) return true;
    const url = (sec.get("url") || "").toLowerCase();
    if (url.includes("127.0.0.1") || url.includes("localhost") || url.includes("0.0.0.0")) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether a configured rclone remote (and its entire dependency chain)
 * is a genuine, externally accessible, writable cloud storage backend.
 */
export function isWritableCloudStorageRemote(
  remoteName: string,
  configContent: string
): boolean {
  const sections = parseRcloneIni(configContent);
  const cleanName = remoteName.replace(/^shared_/, "");
  if (!sections.has(cleanName)) return false;

  const deps = findRemoteDependencies(cleanName, sections);
  if (deps.size === 0) return false;

  let hasConcreteCloudBackend = false;
  for (const dep of deps) {
    if (NON_WRITABLE_REMOTE_NAMES.has(dep.toLowerCase())) {
      return false;
    }
    const sec = sections.get(dep);
    if (!sec) return false;
    const type = (sec.get("type") || "").toLowerCase();
    const url = (sec.get("url") || "").toLowerCase();
    if (url.includes("127.0.0.1") || url.includes("localhost") || url.includes("0.0.0.0")) {
      return false;
    }
    if (!WRITABLE_CLOUD_BACKEND_TYPES.has(type)) {
      return false;
    }
    if (type !== "crypt" && type !== "alias" && type !== "chunker" && type !== "union") {
      hasConcreteCloudBackend = true;
    }
  }

  return hasConcreteCloudBackend;
}

/**
 * Returns an ordered list of candidate writable cloud remotes:
 * 1. Writable cloud remotes already referenced by the shared libraries
 * 2. Any other writable cloud remotes present in rclone.conf
 */
export function getOrderedWritableCloudRemotes(
  preferredRemotes: string[],
  configContent: string
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const r of preferredRemotes) {
    if (!seen.has(r) && isWritableCloudStorageRemote(r, configContent)) {
      seen.add(r);
      candidates.push(r);
    }
  }

  const sections = parseRcloneIni(configContent);
  for (const name of sections.keys()) {
    if (name.startsWith("shared_")) continue;
    if (!seen.has(name) && isWritableCloudStorageRemote(name, configContent)) {
      seen.add(name);
      candidates.push(name);
    }
  }

  return candidates;
}

/**
 * Picks the best writable cloud remote for hosting Guest Pass tokens and backups.
 */
export function findWritableCloudStorageRemote(
  preferredRemotes: string[],
  configContent: string
): string | null {
  const candidates = getOrderedWritableCloudRemotes(preferredRemotes, configContent);
  return candidates[0] ?? null;
}

/**
 * Rewrites a remote path (e.g. "odrivecrypt:Movies") to its scoped equivalent ("shared_odrivecrypt:Movies").
 * Leaves http://, https://, and local filesystem paths untouched.
 */
export function rewriteRemotePath(
  remotePath: string,
  remoteMapping: Record<string, string>
): string {
  if (!remotePath) return remotePath;
  if (/^https?:\/\//i.test(remotePath)) return remotePath;
  if (remotePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(remotePath)) return remotePath;
  const colonIdx = remotePath.indexOf(":");
  if (colonIdx === -1) return remotePath;
  const remote = remotePath.slice(0, colonIdx);
  if (remote.startsWith("shared_")) return remotePath;
  const subPath = remotePath.slice(colonIdx + 1);
  const targetRemote = remoteMapping[remote] || `shared_${remote}`;
  return `${targetRemote}:${subPath}`;
}

export type ExportPassOptions = {
  label: string;
  duration?: AccessPassDuration;
  libraryIds?: string[];
  grantorLnurl?: string;
  passType?: AccessPassType;
  guestEmail?: string;
};

const passFile = (remote: string, passId: string, kind: "token" | "manifest" | "catalog") =>
  `${remote}:.rflix_passes/${kind === "token" ? `${passId}.json` : kind === "manifest" ? `${passId}.catalog.json` : `catalog_${passId}.rfc`}`;

/** Uploads catalog first, manifest last (the guest only trusts the manifest). Admin-side only (unscoped remote). */
async function uploadCatalogFiles(opts: {
  configPath: string;
  remote: string;
  passId: string;
  catalogKey: string;
  bytes: Uint8Array;
  hash: string;
  itemCount: number;
  updatedAt: number;
}): Promise<void> {
  const blob = await packCatalog(opts.bytes, opts.catalogKey);
  if (blob.length > MAX_CATALOG_BYTES) {
    throw new Error(`Catalog too large to publish (${Math.round(blob.length / 1048576)} MB).`);
  }
  await rcloneUploadBytes(opts.configPath, passFile(opts.remote, opts.passId, "catalog"), blob);
  const manifest: CatalogManifest = {
    v: 1,
    passId: opts.passId,
    updatedAt: opts.updatedAt,
    hash: opts.hash,
    itemCount: opts.itemCount,
  };
  await rcloneUploadBytes(
    opts.configPath,
    passFile(opts.remote, opts.passId, "manifest"),
    new TextEncoder().encode(JSON.stringify(manifest))
  );
}

/**
 * Creates and exports a serverless encrypted `.rflix` access pass (Admin or Guest).
 */
export async function exportAccessPass(options: ExportPassOptions): Promise<{
  passId: string;
  filePath?: string;
  fileBytes: Uint8Array;
  passString: string;
}> {
  const s = useAppStore.getState();
  const passType = options.passType || "guest";

  // Always read the live rclone.conf via the backend first (bypasses Tauri plugin-fs path scope limits)
  let configContent = "";
  try {
    configContent = await invoke<string>("load_rclone_config_content");
    if (configContent && !configContent.startsWith("\0")) {
      s.setRcloneConfigContent(configContent);
    }
  } catch {}
  if (!configContent && s.rcloneConfigPath) {
    try {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const diskText = await readTextFile(s.rcloneConfigPath);
      if (diskText && !diskText.startsWith("\0")) {
        configContent = diskText;
        s.setRcloneConfigContent(configContent);
      }
    } catch {}
  }
  if (!configContent) {
    configContent = s.rcloneConfigContent || "";
  }
  if (!configContent) {
    throw new Error("No rclone configuration found.");
  }

  // ── ADMIN PASS EXPORT (Full personal identity clone for TV & secondary devices) ──
  if (passType === "admin") {
    const passId = `admin_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    let usenetServerConfig: any = null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      usenetServerConfig = await invoke("usenet_get_config");
    } catch {}
    const omgUser = typeof window !== "undefined" ? localStorage.getItem("rcloneflix_omg_user") || undefined : undefined;
    const omgKey = typeof window !== "undefined" ? localStorage.getItem("rcloneflix_omg_key") || undefined : undefined;

    const adminPayload: AdminPassPayload = {
      fullRcloneConfig: configContent,
      libraries: s.libraries,
      playback: s.playback,
      rcloneSettings: s.rcloneSettings,
      secrets: {
        tmdbApiKey: s.tmdbApiKey,
        thePornDbApiKey: s.thePornDbApiKey,
        googleClientId: s.googleClientId,
        kaggleUsername: s.kaggleUsername,
        kaggleKey: s.kaggleKey,
        debridConfig: s.debridConfig,
        easynewsConfig: s.easynewsConfig,
        streamtapeConfig: s.streamtapeConfig,
        doodstreamConfig: s.doodstreamConfig,
        ghaConfig: s.ghaConfig,
        simklSettings: s.simklSettings,
        traktSettings: s.traktSettings,
        iptvConfig: s.iptvConfig,
        telegramConfig: s.telegramConfig,
        keepAliveConfig: s.keepAliveConfig,
        udropConfig: loadUdropConfig(),
        usenetServerConfig,
        omgUser,
        omgKey,
        catboxConfig: (s as any).catboxConfig,
        stashBoxProviders: (s as any).stashBoxProviders,
      },
      stremioAddons: s.stremioAddons,
      mediaItems: s.mediaItems,
      watchProgress: s.watchProgress,
      favorites: s.favorites,
      playlists: s.playlists,
      siteBookmarks: getUserBookmarks(),
    };

    const payload: AccessPassPayload = {
      magic: ACCESS_PASS_MAGIC,
      version: 1,
      passType: "admin",
      passId,
      label: options.label || "Admin TV Pass",
      duration: "lifetime",
      createdAt: Date.now(),
      scopedRcloneConfig: configContent,
      sharedLibraries: s.libraries.map((lib) => ({
        id: lib.id,
        name: lib.name,
        type: lib.type,
        remotePaths: lib.remotePaths,
      })),
      tokenPath: "",
      backupPath: "",
      adminPayload,
    };

    const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
    const encryptedBytes = await encryptBytes(jsonBytes, PASS_ENVELOPE_KEY);
    const passString = uint8ArrayToBase64(encryptedBytes);

    const safeLabel = (options.label || "admin_pass").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    const defaultFileName = `rcloneflix_${safeLabel}.rflix`;
    let chosenPath: string | null = null;

    try {
      chosenPath = await saveAccessPassFile(defaultFileName.replace(/\.rflix$/, ""));
      if (chosenPath) {
        await writeLocalFileBytes(chosenPath, encryptedBytes);
      }
    } catch (err) {
      log.warn("access-pass", `File picker save failed, triggering browser download: ${err}`);
    }

    if (!chosenPath) {
      try {
        const blob = new Blob([encryptedBytes as unknown as BlobPart], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = defaultFileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch {}
    }

    return {
      passId,
      filePath: chosenPath || undefined,
      fileBytes: encryptedBytes,
      passString,
    };
  }

  // ── GUEST PASS EXPORT (Scoped libraries, zero admin credentials, offloaded versions preserved) ──
  const targetLibs = s.libraries.filter((l) => (options.libraryIds || []).includes(l.id));
  if (targetLibs.length === 0) {
    throw new Error("Please select at least one library to share.");
  }

  const parsedSections = parseRcloneIni(configContent);

  // Find all required remotes across the selected libraries AND their offload versions
  const rawLibraryRemotes = new Set<string>();
  const shareableRemotes = new Set<string>();
  const offloadRemoteNames = new Set<string>();
  const registerRemoteCandidate = (rName: string) => {
    if (!rName || rName === "http" || rName === "https" || rName === "doodstream" || rName === "dropmb") {
      return;
    }
    rawLibraryRemotes.add(rName);
    if (!isLoopbackRemote(rName, parsedSections) && rName !== "streamtape" && rName !== "telegram-drive" && rName !== "tg-native") {
      if (parsedSections.has(rName)) {
        shareableRemotes.add(rName);
      }
    }
  };

  for (const lib of targetLibs) {
    for (const rp of lib.remotePaths) {
      if (rp.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rp) || /^https?:\/\//i.test(rp)) {
        continue;
      }
      const colon = rp.indexOf(":");
      if (colon !== -1) {
        registerRemoteCandidate(rp.slice(0, colon));
      }
    }
  }

  // Also harvest cloud offload remotes (e.g. udrop, tg-serverless) from item.versions in selected libraries
  const selectedLibIds = new Set(targetLibs.map((l) => l.id));
  for (const item of Object.values(s.mediaItems)) {
    if (!selectedLibIds.has(item.libraryId)) continue;
    if (item.versions) {
      for (const v of item.versions) {
        if (v.remoteName) {
          registerRemoteCandidate(v.remoteName);
          offloadRemoteNames.add(v.remoteName);
        }
        const colon = v.remotePath ? v.remotePath.indexOf(":") : -1;
        if (colon !== -1 && !v.remotePath.startsWith("http://") && !v.remotePath.startsWith("https://")) {
          const vr = v.remotePath.slice(0, colon);
          registerRemoteCandidate(vr);
          offloadRemoteNames.add(vr);
        }
      }
    }
  }

  if (rawLibraryRemotes.size === 0) {
    throw new Error("Selected libraries do not have valid cloud remote paths.");
  }

  const writableCandidates = getOrderedWritableCloudRemotes(
    Array.from(rawLibraryRemotes),
    configContent
  );

  if (writableCandidates.length === 0) {
    throw new Error(
      "Guest Pass export requires at least one writable cloud storage remote (e.g. Google Drive, OpenDrive, OneDrive, Dropbox, S3, or Crypt) to host the pass token and library metadata."
    );
  }

  const passId = `pass_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const initialToken: PassToken = {
    passId,
    label: options.label || "Shared Library",
    duration: options.duration || "7d",
    createdAt: Date.now(),
    status: "unclaimed",
    claimedBy: null,
    claimedAt: null,
    expiresAt: null,
  };
  const tokenBytes = new TextEncoder().encode(JSON.stringify(initialToken, null, 2));

  const catalogKey = generateCatalogKey();
  const catalogLibs = targetLibs.map((l) => ({ id: l.id, name: l.name, type: l.type }));
  const catalogBody = buildGuestCatalogBody({
    passId,
    libraries: catalogLibs,
    mediaItems: s.mediaItems,
    picks: s.adminWeeklyRecommendations || {},
  });
  const encodedCatalog = await encodeBody(catalogBody);
  const catalogUpdatedAt = Date.now();

  // 1 & 2. Iterate through writable cloud candidates until both token and catalog upload succeed
  let primaryRemote = writableCandidates[0];
  let lastUploadErr: unknown = null;
  let uploadSucceeded = false;

  for (const candidate of writableCandidates) {
    const candidateTokenPath = passFile(candidate, passId, "token");
    try {
      await rcloneUploadBytes(s.rcloneConfigPath, candidateTokenPath, tokenBytes); // also creates .rflix_passes/
      await uploadCatalogFiles({
        configPath: s.rcloneConfigPath,
        remote: candidate,
        passId,
        catalogKey,
        bytes: encodedCatalog.bytes,
        hash: encodedCatalog.hash,
        itemCount: catalogBody.items.length,
        updatedAt: catalogUpdatedAt,
      });
      primaryRemote = candidate;
      uploadSucceeded = true;
      break;
    } catch (err) {
      lastUploadErr = err;
      log.warn("access-pass", `Cloud candidate "${candidate}" failed during pass export, trying next: ${err}`);
    }
  }

  if (!uploadSucceeded) {
    throw new Error(
      `Failed to upload Guest Pass data to cloud storage (${primaryRemote}): ${
        lastUploadErr instanceof Error ? lastUploadErr.message : String(lastUploadErr)
      }`
    );
  }

  try {
    // Old versions uploaded the FULL unencrypted rclone.conf + API keys here, readable by every guest of this remote.
    // Skip if already passphrase-encrypted (RFLIX_ENC1:) or already redacted, and confirm before overwriting an unencrypted backup.
    const legacyBackup = `${primaryRemote}:RcloneFlix/${BACKUP_FILE}`;
    const existingRaw = await rcloneReadBackup(s.rcloneConfigPath, legacyBackup);
    if (
      existingRaw &&
      !existingRaw.startsWith("RFLIX_ENC1:") &&
      !existingRaw.includes('"redactedBy"')
    ) {
      const shouldRedact =
        typeof window === "undefined" ||
        typeof window.confirm !== "function" ||
        window.confirm(
          `An unencrypted RcloneFlix backup was found on "${primaryRemote}:RcloneFlix/${BACKUP_FILE}". Because guests with this pass can read that remote, replace the unencrypted backup file with a redacted stub? (You can create a passphrase-encrypted backup in Settings → Sync & Backup.)`
        );
      if (shouldRedact) {
        await invoke("rclone_write_backup", {
          configPath: s.rcloneConfigPath,
          remotePath: legacyBackup,
          content: JSON.stringify({
            version: 3,
            redactedBy: "RcloneFlix guest-pass export",
            note: "Contained unencrypted credentials; replaced. Re-run Backup with a passphrase.",
          }),
        });
      }
    }
  } catch { /* no legacy file; never block export */ }

  // Ensure primaryRemote is included in shareableRemotes BEFORE extracting scoped config
  shareableRemotes.add(primaryRemote);

  const namePrefix = `${passId.slice(-4).toLowerCase().replace(/[^a-z0-9]/g, "x")}_`;
  const { scopedConfig, remoteMapping } = extractScopedRcloneConfig(
    configContent,
    Array.from(shareableRemotes),
    offloadRemoteNames,
    namePrefix
  );

  // Harvest active weekly recommendations for the selected libraries
  const weeklyRecommendations: Record<string, WeeklyRecommendation[]> = {};
  for (const lib of targetLibs) {
    const libPicks = s.adminWeeklyRecommendations?.[lib.id];
    if (libPicks && libPicks.items && libPicks.items.length > 0) {
      weeklyRecommendations[lib.id] = libPicks.items.slice(0, 3);
    }
  }

  // 3. Prepare payload for recipient (excluding local filesystem & 127.0.0.1 loopback paths)
  const scopedSharedLibs: SharedLibraryMeta[] = targetLibs.map((lib) => {
    const validCloudPaths = lib.remotePaths.filter((rp) => {
      if (rp.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rp)) return false;
      const colon = rp.indexOf(":");
      if (colon === -1) return false;
      const rName = rp.slice(0, colon);
      return !isLoopbackRemote(rName, parsedSections);
    });
    const pathsToRewrite =
      validCloudPaths.length > 0 ? validCloudPaths : [`${primaryRemote}:/${lib.name}`];
    return {
      id: lib.id,
      name: lib.name,
      type: lib.type,
      remotePaths: pathsToRewrite.map((rp) => rewriteRemotePath(rp, remoteMapping)),
    };
  });

  const scopedPrimary = remoteMapping[primaryRemote] || `shared_${primaryRemote}`;
  const payload: AccessPassPayload = {
    magic: ACCESS_PASS_MAGIC,
    version: 1,
    passType: "guest",
    passId,
    label: options.label || "Shared Library",
    duration: options.duration || "7d",
    createdAt: Date.now(),
    scopedRcloneConfig: scopedConfig,
    sharedLibraries: scopedSharedLibs,
    tokenPath: `${scopedPrimary}:.rflix_passes/${passId}.json`,
    backupPath: "",
    catalogKey,
    catalogPath: passFile(scopedPrimary, passId, "catalog"),
    manifestPath: passFile(scopedPrimary, passId, "manifest"),
    lnurl: options.grantorLnurl,
    weeklyRecommendations:
      Object.keys(weeklyRecommendations).length > 0 ? weeklyRecommendations : undefined,
    remoteMapping,
  };

  // 4. Encrypt with standardized envelope key
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
  const encryptedBytes = await encryptBytes(jsonBytes, PASS_ENVELOPE_KEY);
  const passString = uint8ArrayToBase64(encryptedBytes);

  // 5. Save to local disk
  const safeLabel = (options.label || "library").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const defaultFileName = `rcloneflix_${safeLabel}_${options.duration || "7d"}.rflix`;
  let chosenPath: string | null = null;

  try {
    chosenPath = await saveAccessPassFile(defaultFileName.replace(/\.rflix$/, ""));
    if (chosenPath) {
      await writeLocalFileBytes(chosenPath, encryptedBytes);
    }
  } catch (err) {
    log.warn("access-pass", `File picker save failed, triggering browser download: ${err}`);
  }

  // Fallback to web blob download if native save was not used or canceled
  if (!chosenPath) {
    try {
      const blob = new Blob([encryptedBytes as unknown as BlobPart], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultFileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {}
  }

  // 6. Record in issuedPasses
  const durMs = durationToMs(options.duration || "7d");
  const createdAt = Date.now();
  const initialExpiresAt = durMs ? createdAt + durMs : undefined;

  s.addIssuedPass({
    passId,
    label: options.label || "Shared Library",
    remoteName: primaryRemote,
    duration: options.duration || "7d",
    createdAt,
    sharedLibraries: targetLibs.map((l) => ({ id: l.id, name: l.name, type: l.type })),
    tokenPath: `${primaryRemote}:.rflix_passes/${passId}.json`,
    status: "unclaimed",
    expiresAt: initialExpiresAt,
    guestEmail: options.guestEmail?.trim() || undefined,
    catalogKey,
    catalogHash: encodedCatalog.hash,
    catalogUpdatedAt,
    catalogItemCount: catalogBody.items.length,
    lastPublishedAt: catalogUpdatedAt,
  });

  return {
    passId,
    filePath: chosenPath || undefined,
    fileBytes: encryptedBytes,
    passString,
  };
}

export type ImportProgressCallback = (msg: string) => void;

/**
 * Imports an Admin TV Pass: restores all remotes, full library metadata,
 * credentials (Debrid, Easynews, TMDB), and cloud offload workers.
 */
async function importAdminPass(
  payload: AccessPassPayload,
  onProgress?: ImportProgressCallback
): Promise<{
  passId: string;
  label: string;
  passType: "admin";
  libraryCount: number;
  itemCount: number;
}> {
  const admin = payload.adminPayload;
  if (!admin) {
    throw new Error("Corrupted admin pass: missing administration payload.");
  }

  const s = useAppStore.getState();

  // 1. Write and save rclone config
  onProgress?.("Restoring cloud remotes and configurations...");
  const configContent = admin.fullRcloneConfig || payload.scopedRcloneConfig;
  s.setRcloneConfigContent(configContent);
  const isAndroid = typeof window !== "undefined" && !!(window as any).AndroidBridge;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (isAndroid) {
      // No desktop rclone.conf to protect on Android; keep the existing persistence path.
      await invoke("save_rclone_config_content", { content: configContent });
      s.setRcloneConfigPath("android://rclone.conf");
    } else {
      // IMPORTANT: do NOT call save_rclone_config_content first — it overwrites the on-disk file
      // and would destroy local remotes before rclone_apply_admin_config can back up / merge.
      const applied = await invoke<{
        config_path: string;
        remotes: Array<{ name: string; remote_type: string }>;
        merged_content: string;
      }>("rclone_apply_admin_config", {
        configPath: s.rcloneConfigPath || "",
        adminContent: configContent,
      });
      if (applied?.config_path) {
        s.setRcloneConfigPath(applied.config_path);
      }
      if (applied?.merged_content) {
        s.setRcloneConfigContent(applied.merged_content);
      }
      if (applied?.remotes?.length) {
        s.setRemotes(applied.remotes.map((r) => ({ name: r.name, type: r.remote_type })));
      }
    }
  } catch (e) {
    log.warn("access-pass", `Backend rclone_apply_admin_config fallback: ${e}`);
    if (isAndroid) {
      s.setRcloneConfigPath("android://rclone.conf");
    }
    const sections = parseRcloneIni(configContent);
    s.setRemotes(
      Array.from(sections.entries()).map(([name, sec]) => ({
        name,
        type: sec.get("type") || "drive",
      }))
    );
  }

  // 2. Restore all libraries & settings
  onProgress?.("Restoring libraries and credentials...");
  setLibrarySyncPaused(true);
  let itemCount = 0;
  try {
    s.importConfig({
      libraries: admin.libraries || [],
      playback: admin.playback ?? s.playback,
      rcloneSettings: admin.rcloneSettings ?? s.rcloneSettings,
      tmdbApiKey: admin.secrets?.tmdbApiKey ?? s.tmdbApiKey,
      thePornDbApiKey: admin.secrets?.thePornDbApiKey ?? s.thePornDbApiKey,
      googleClientId: admin.secrets?.googleClientId ?? s.googleClientId,
      kaggleUsername: admin.secrets?.kaggleUsername ?? s.kaggleUsername,
      kaggleKey: admin.secrets?.kaggleKey ?? s.kaggleKey,
      debridConfig: admin.secrets?.debridConfig ?? s.debridConfig,
      easynewsConfig: admin.secrets?.easynewsConfig ?? s.easynewsConfig,
      streamtapeConfig: admin.secrets?.streamtapeConfig ?? s.streamtapeConfig,
      doodstreamConfig: admin.secrets?.doodstreamConfig ?? s.doodstreamConfig,
      ghaConfig: admin.secrets?.ghaConfig ?? s.ghaConfig,
      simklSettings: admin.secrets?.simklSettings ?? s.simklSettings,
      traktSettings: admin.secrets?.traktSettings ?? s.traktSettings,
      iptvConfig: admin.secrets?.iptvConfig ?? s.iptvConfig,
      telegramConfig: admin.secrets?.telegramConfig ?? s.telegramConfig,
      keepAliveConfig: admin.secrets?.keepAliveConfig ?? s.keepAliveConfig,
      mediaItems: admin.mediaItems ?? {},
      watchProgress: admin.watchProgress ?? {},
      favorites: admin.favorites ?? {},
      playlists: admin.playlists ?? {},
      setupComplete: true,
    });

    if (admin.secrets?.udropConfig) {
      saveUdropConfig(admin.secrets.udropConfig);
    }
    if (Array.isArray(admin.stremioAddons) && admin.stremioAddons.length > 0) {
      useAppStore.setState({ stremioAddons: admin.stremioAddons });
    }
    if (admin.secrets?.omgUser) {
      localStorage.setItem("rcloneflix_omg_user", admin.secrets.omgUser);
    }
    if (admin.secrets?.omgKey) {
      localStorage.setItem("rcloneflix_omg_key", admin.secrets.omgKey);
    }
    if (admin.secrets?.usenetServerConfig?.host) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("usenet_save_config", { config: admin.secrets.usenetServerConfig });
      } catch (e) {
        log.warn("access-pass", `Failed to restore Usenet NNTP config: ${e}`);
      }
    }
    if (admin.secrets?.catboxConfig) {
      useAppStore.setState({ catboxConfig: admin.secrets.catboxConfig } as any);
    }
    if (Array.isArray(admin.secrets?.stashBoxProviders)) {
      useAppStore.setState({ stashBoxProviders: admin.secrets.stashBoxProviders } as any);
    }

    if (admin.siteBookmarks && Array.isArray(admin.siteBookmarks) && admin.siteBookmarks.length > 0) {
      try {
        localStorage.setItem("rcloneflix_user_site_bookmarks", JSON.stringify(admin.siteBookmarks));
      } catch {}
    }

    // 3. Ingest items into SQLite libraryDb for permanent persistence
    onProgress?.("Ingesting library items and multi-versions...");
    if (admin.mediaItems) {
      const items = Object.values(admin.mediaItems);
      if (items.length > 0) {
        try {
          await persistItems(items);
        } catch (err) {
          log.warn("access-pass", `Could not persist items to sqlite: ${err}`);
        }
        itemCount = items.length;
      }
    }

    if (admin.watchProgress) {
      const progList = Object.values(admin.watchProgress);
      if (progList.length > 0) {
        try {
          await persistProgressBatch(progList);
        } catch (err) {
          log.warn("access-pass", `Could not persist watch progress batch: ${err}`);
        }
      }
    }
  } finally {
    setLibrarySyncPaused(false);
  }

  s.completeSetup();

  return {
    passId: payload.passId,
    label: payload.label || "Admin TV Pass",
    passType: "admin",
    libraryCount: (admin.libraries || []).length,
    itemCount,
  };
}

export function buildGuestLibraryStateFromItems(args: {
  rawItems: MediaItem[];
  sourceLibraryIds: Set<string>;                 // ORIGINAL admin library ids
  remoteMapping: Record<string, string>;          // orig remote -> scoped remote, already filtered to remotes that exist
  availableScopedRemotes: Set<string>;
  weeklyRecommendations?: Record<string, WeeklyRecommendation[]>;
}): { items: MediaItem[]; guestRecommendations: WeeklyRecommendation[] } {
  const { rawItems, sourceLibraryIds, remoteMapping, availableScopedRemotes } = args;
  const passRecs = args.weeklyRecommendations || {};
  const guestRecommendations: WeeklyRecommendation[] = [];
  const items: MediaItem[] = [];

  for (const item of rawItems) {
    if (!sourceLibraryIds.has(item.libraryId)) continue;
    const scopedLibId = `shared_${item.libraryId}`;
    let scopedRemotePath = rewriteRemotePath(item.remotePath, remoteMapping);

    const libRecs = passRecs[item.libraryId] || [];
    const recMatch = libRecs.find(
      (r) => r.itemId === item.id || r.title.toLowerCase().trim() === item.title.toLowerCase().trim()
    );
    const isRecommended = Boolean(recMatch);
    const recommendationBadge = recMatch
      ? { text: recMatch.badgeText || "Curator Pick", effect: recMatch.badgeEffect || "glow", note: recMatch.note }
      : undefined;
    if (recMatch) guestRecommendations.push({ ...recMatch, itemId: `shared_${item.id}` });

    const updatedVersions = Array.isArray(item.versions)
      ? item.versions.map((v) => {
          const nextRemotePath = v.remotePath ? rewriteRemotePath(v.remotePath, remoteMapping) : v.remotePath;
          const nextRemoteName =
            remoteMapping[v.remoteName] ||
            (v.remoteName && !v.remoteName.startsWith("shared_") && !/^https?$/i.test(v.remoteName)
              ? `shared_${v.remoteName}`
              : v.remoteName);
          return { ...v, remotePath: nextRemotePath, remoteName: nextRemoteName };
        })
      : item.versions;

    // Primary path on a remote the guest doesn't have (e.g. streamtape loopback) -> promote a playable version.
    const primaryColon = scopedRemotePath.indexOf(":");
    const primaryPrefix =
      primaryColon !== -1 && !/^https?:\/\//i.test(scopedRemotePath) ? scopedRemotePath.slice(0, primaryColon) : "";
    if (primaryPrefix && !availableScopedRemotes.has(primaryPrefix) && Array.isArray(updatedVersions)) {
      const playable = updatedVersions.find((v) => {
        if (!v.remotePath || /^https?:\/\//i.test(v.remotePath)) return false;
        const c = v.remotePath.indexOf(":");
        return c !== -1 && availableScopedRemotes.has(v.remotePath.slice(0, c));
      });
      if (playable?.remotePath) scopedRemotePath = playable.remotePath;
    }

    items.push({
      ...item,
      id: `shared_${item.id}`,
      libraryId: scopedLibId,
      remotePath: scopedRemotePath,
      versions: updatedVersions,
      isRecommended,
      recommendationBadge,
    });
  }
  return { items, guestRecommendations };
}

/**
 * 1-Click Zero-Passphrase Import:
 * Decrypts envelope, claims single-use token on cloud, merges scoped remotes,
 * ingests rich metadata from cloud backup, and mounts shared libraries.
 */
export async function importAccessPass(
  fileBytes: Uint8Array,
  onProgress?: ImportProgressCallback
): Promise<{
  passId: string;
  label: string;
  passType: AccessPassType;
  libraryCount: number;
  itemCount: number;
  expiresAt?: number;
}> {
  onProgress?.("Decrypting access pass envelope...");
  let decryptedBytes: Uint8Array;
  try {
    decryptedBytes = await decryptBytes(fileBytes, PASS_ENVELOPE_KEY);
  } catch (err) {
    throw new Error("Failed to decrypt access pass. Corrupted or invalid file.");
  }

  let payload: AccessPassPayload;
  try {
    const jsonStr = new TextDecoder().decode(decryptedBytes);
    payload = JSON.parse(jsonStr) as AccessPassPayload;
    if (payload.magic !== ACCESS_PASS_MAGIC || !payload.passId) {
      throw new Error("Invalid access pass payload format.");
    }
  } catch (err) {
    throw new Error("Failed to parse access pass data.");
  }

  // ── Handle Admin Pass immediately ──
  if (payload.passType === "admin" || payload.adminPayload) {
    return await importAdminPass(payload, onProgress);
  }

  const s = useAppStore.getState();

  // Check if this pass was already imported on this device
  if (s.libraries.some((l) => l.passId === payload.passId)) {
    throw new Error("This access pass is already installed on this device.");
  }

  // 1. Merge scoped config into recipient's rclone.conf
  onProgress?.("Mounting scoped cloud connection...");
  const configPath = s.rcloneConfigPath || "";
  const sanitizedScopedConfig = sanitizeScopedRcloneConfig(payload.scopedRcloneConfig);
  const mergeResult = await rcloneMergeScopedConfig(configPath, sanitizedScopedConfig);
  const resolvedConfigPath = mergeResult.config_path || configPath;

  s.setRcloneConfigPath(resolvedConfigPath);
  s.setRemotes(mergeResult.remotes.map((r) => ({ name: r.name, type: r.remote_type })));

  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const content = await readTextFile(resolvedConfigPath);
    s.setRcloneConfigContent(content);
  } catch (e) {
    log.warn("access-pass", `Could not cache merged rclone.conf content: ${e}`);
  }

  // 2. Verify and Claim Single-Use Token on Remote
  onProgress?.("Verifying activation token on cloud...");
  const networkNow = await getNetworkTime();
  const myDeviceId = getDeviceId();

  let token: PassToken;
  try {
    const rawTokenBytes = await rcloneReadBytes(resolvedConfigPath, payload.tokenPath);
    token = JSON.parse(new TextDecoder().decode(rawTokenBytes)) as PassToken;
  } catch (err) {
    const errDetail = err instanceof Error ? err.message : String(err);
    log.error("access-pass", `Failed to read pass token on cloud: ${errDetail}`);
    throw new Error(`Unable to reach access pass token on cloud: ${errDetail}`);
  }

  if (token.status === "revoked") {
    // Revert merged config
    await cleanupScopedRemotes(payload.scopedRcloneConfig, resolvedConfigPath);
    throw new Error("This access pass has been revoked by the library owner.");
  }

  if (token.status === "expired" || (token.expiresAt && networkNow >= token.expiresAt)) {
    await cleanupScopedRemotes(payload.scopedRcloneConfig, resolvedConfigPath);
    throw new Error("This access pass has already expired.");
  }

  if (token.status === "claimed") {
    if (!token.claimedBy || token.claimedBy !== myDeviceId) {
      await cleanupScopedRemotes(payload.scopedRcloneConfig, resolvedConfigPath);
      throw new Error("This access pass has already been activated on another device. Passes are strictly single-use.");
    }
  }

  // Calculate strict expiration starting at first import, preserving token timestamp if re-imported
  const durationMs = durationToMs(payload.duration);
  const expiresAt = token.expiresAt ?? (durationMs ? networkNow + durationMs : undefined);

  // Claim token on remote
  onProgress?.("Binding pass to this device...");
  const claimedToken: PassToken = {
    ...token,
    status: "claimed",
    claimedBy: myDeviceId,
    claimedAt: token.claimedAt ?? networkNow,
    expiresAt: expiresAt ?? null,
  };

  await rcloneUploadBytes(
    resolvedConfigPath,
    payload.tokenPath,
    new TextEncoder().encode(JSON.stringify(claimedToken, null, 2))
  );

  // 3. Ingest catalog (new passes: encrypted per-pass catalog; legacy passes: grantor backup file)
  onProgress?.("Ingesting library metadata and posters...");
  let ingestedCount = 0;
  const availableScopedRemotes = new Set(extractSectionNames(payload.scopedRcloneConfig));
  const guestImportMapping: Record<string, string> = {};
  if (payload.remoteMapping && Object.keys(payload.remoteMapping).length > 0) {
    for (const [orig, anon] of Object.entries(payload.remoteMapping)) {
      if (availableScopedRemotes.has(anon)) guestImportMapping[orig] = anon;
    }
  } else {
    // Legacy passes (pre-v1.0.3): scoped sections are shared_<orig>
    for (const scopedName of availableScopedRemotes) {
      if (scopedName.startsWith("shared_")) guestImportMapping[scopedName.slice("shared_".length)] = scopedName;
    }
  }
  let initialSync: { updatedAt: number; hash: string } | undefined;
  try {
    let rawItems: MediaItem[] = [];
    let recs = payload.weeklyRecommendations;

    if (payload.catalogPath && payload.catalogKey) {
      const blob = await rcloneReadBytes(resolvedConfigPath, payload.catalogPath);
      const bytes = await unpackCatalog(blob, payload.catalogKey);
      const body = JSON.parse(new TextDecoder().decode(bytes)) as GuestCatalogBody;
      if (body.version !== CATALOG_VERSION || body.passId !== payload.passId || !Array.isArray(body.items)) {
        throw new Error("Unrecognized catalog format");
      }
      rawItems = body.items;
      recs = body.weeklyRecommendations || recs;
      try {
        const m = JSON.parse(
          new TextDecoder().decode(await rcloneReadBytes(resolvedConfigPath, payload.manifestPath || ""))
        ) as CatalogManifest;
        if (m.hash === (await sha256Hex(bytes))) initialSync = { updatedAt: m.updatedAt, hash: m.hash };
      } catch {
        /* no manifest: first sync will simply re-download */
      }
    } else if (payload.backupPath) {
      // Legacy pass: single grantor backup (full-library JSON)
      const backupData = JSON.parse(await rcloneReadBackup(resolvedConfigPath, payload.backupPath));
      rawItems = Object.values(backupData?.mediaItems || {}) as MediaItem[];
    }

    const built = buildGuestLibraryStateFromItems({
      rawItems,
      sourceLibraryIds: new Set(payload.sharedLibraries.map((l) => l.id)),
      remoteMapping: guestImportMapping,
      availableScopedRemotes,
      weeklyRecommendations: recs,
    });

    if (built.guestRecommendations.length > 0) {
      const own = new Set(built.items.map((i) => i.id));
      useAppStore.setState((st) => ({
        guestRecommendations: mergeGuestRecommendations(st.guestRecommendations, own, built.guestRecommendations),
      }));
    }
    if (built.items.length > 0) {
      setLibrarySyncPaused(true);
      try {
        await persistItems(built.items);
        s.bulkUpsertMediaItems(built.items);
      } finally {
        setLibrarySyncPaused(false);
      }
      ingestedCount = built.items.length;
    }
  } catch (err) {
    log.warn("access-pass", `Could not ingest remote catalog: ${err}`);
  }

  // 4. Register shared libraries in store
  onProgress?.("Registering shared libraries...");
  const passSync: PassSyncInfo | undefined =
    payload.catalogKey && payload.catalogPath && payload.manifestPath
      ? {
          tokenPath: payload.tokenPath,
          manifestPath: payload.manifestPath,
          catalogPath: payload.catalogPath,
          catalogKey: payload.catalogKey,
          remoteMapping: guestImportMapping,
          updatedAt: initialSync?.updatedAt,
          hash: initialSync?.hash,
        }
      : undefined;
  for (const lib of payload.sharedLibraries) {
    s.addLibrary({
      id: `shared_${lib.id}`,
      name: `${lib.name} (${payload.label || "Shared"})`,
      type: lib.type,
      remotePaths: lib.remotePaths,
      isSharedPass: true,
      passId: payload.passId,
      expiresAt: expiresAt,
      isExpired: false,
      grantorLabel: payload.label,
      passSync,
    });
  }

  // 5. Complete setup if this is a fresh install so guest user immediately enters the app
  if (!s.setupComplete) {
    s.completeSetup();
  }

  return {
    passId: payload.passId,
    label: payload.label,
    passType: (payload.passType || "guest") as AccessPassType,
    libraryCount: payload.sharedLibraries.length,
    itemCount: ingestedCount,
    expiresAt,
  };
}

/**
 * Helper to export an access pass directly as a base64 string (ideal for QR codes and clipboard).
 */
export async function exportAccessPassToString(options: ExportPassOptions): Promise<{
  passId: string;
  passString: string;
}> {
  const res = await exportAccessPass(options);
  return {
    passId: res.passId,
    passString: res.passString,
  };
}

/**
 * Helper to import an access pass directly from a base64 string (ideal for mobile/TV pairing portal).
 */
export async function importAccessPassFromString(
  passString: string,
  onProgress?: ImportProgressCallback
): Promise<{
  passId: string;
  label: string;
  passType: AccessPassType;
  libraryCount: number;
  itemCount: number;
  expiresAt?: number;
}> {
  const bytes = base64ToUint8Array(passString.trim());
  return await importAccessPass(bytes, onProgress);
}

/**
 * Extracts remote section names from an INI string.
 */
function extractSectionNames(iniContent: string): string[] {
  const names: string[] = [];
  for (const line of iniContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      names.push(trimmed.slice(1, -1).trim());
    }
  }
  return names;
}

async function cleanupScopedRemotes(scopedConfig: string, configPath: string) {
  try {
    const remoteNames = extractSectionNames(scopedConfig);
    if (remoteNames.length > 0) {
      await rcloneRemoveScopedRemotes(configPath, remoteNames);
    }
  } catch {}
}

/**
 * Checks all active shared passes and severs access if expired.
 */
export async function checkPassExpiry(): Promise<void> {
  const s = useAppStore.getState();
  const sharedLibs = s.libraries.filter((l) => l.isSharedPass && l.expiresAt && !l.isExpired);
  if (sharedLibs.length === 0) return;

  const now = Date.now();
  for (const lib of sharedLibs) {
    if (lib.expiresAt && now >= lib.expiresAt) {
      log.warn("access-pass", `Access pass for library "${lib.name}" has expired`);
      s.markLibraryExpired(lib.passId || "");

      // Cut off any active playback
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("player_stop").catch(() => {});
      } catch {}

      // Immediately sever cloud remote access and purge media items from device
      if (lib.passId) {
        await removeSharedPass(lib.passId);
      }
    }
  }
}

/**
 * 1-Click Clean Removal:
 * Removes scoped remotes from rclone.conf, purges cached items from SQLite & store,
 * and deletes the shared library entries.
 */
export async function removeSharedPass(passId: string): Promise<void> {
  const s = useAppStore.getState();
  const targetLibs = s.libraries.filter((l) => l.passId === passId && l.isSharedPass);
  if (targetLibs.length === 0) return;

  // 1. Gather all scoped remotes to remove
  const remotesToRemove = new Set<string>();
  for (const lib of targetLibs) {
    for (const rp of lib.remotePaths) {
      const colon = rp.indexOf(":");
      if (colon !== -1) {
        const remote = rp.slice(0, colon);
        if (remote.startsWith("shared_")) remotesToRemove.add(remote);
      }
    }
    // The pass's own token/catalog remote may not appear in any library path.
    const tp = lib.passSync?.tokenPath;
    if (tp && tp.indexOf(":") !== -1) {
      const r = tp.slice(0, tp.indexOf(":"));
      if (r.startsWith("shared_")) remotesToRemove.add(r);
    }
  }
  // Never delete a scoped remote another imported pass still uses (names are per-export and can collide).
  for (const other of s.libraries) {
    if (!other.isSharedPass || other.passId === passId) continue;
    for (const rp of other.remotePaths) {
      const c = rp.indexOf(":");
      if (c !== -1) remotesToRemove.delete(rp.slice(0, c));
    }
    for (const anon of Object.values(other.passSync?.remoteMapping || {})) remotesToRemove.delete(anon);
    const otp = other.passSync?.tokenPath;
    if (otp && otp.indexOf(":") !== -1) remotesToRemove.delete(otp.slice(0, otp.indexOf(":")));
  }

  // 2. Remove remotes from rclone config
  if (remotesToRemove.size > 0 && s.rcloneConfigPath) {
    try {
      const updated = await rcloneRemoveScopedRemotes(
        s.rcloneConfigPath,
        Array.from(remotesToRemove)
      );
      s.setRemotes(updated.map((r) => ({ name: r.name, type: r.remote_type })));
    } catch (err) {
      log.error("access-pass", `Failed to remove scoped remotes: ${err}`);
    }
  }

  // 3. Purge items from SQLite & Store
  for (const lib of targetLibs) {
    try {
      await clearLibrary(lib.id);
    } catch {}
    s.clearLibraryItems(lib.id);
    s.removeLibrary(lib.id);
  }
}

/**
 * Grantor revocation of an issued pass. Updates token file on remote to "revoked".
 */
export async function revokeIssuedPass(passId: string): Promise<void> {
  const s = useAppStore.getState();
  const pass = s.issuedPasses?.find((p) => p.passId === passId);
  if (!pass) return;

  try {
    const rawTokenBytes = await rcloneReadBytes(s.rcloneConfigPath, pass.tokenPath);
    const token = JSON.parse(new TextDecoder().decode(rawTokenBytes)) as PassToken;
    const revokedToken: PassToken = {
      ...token,
      status: "revoked",
    };
    await rcloneUploadBytes(
      s.rcloneConfigPath,
      pass.tokenPath,
      new TextEncoder().encode(JSON.stringify(revokedToken, null, 2))
    );
  } catch (err) {
    log.error("access-pass", `Failed to revoke remote token file: ${err}`);
  }

  s.updateIssuedPass(passId, { status: "revoked" });
}

/**
 * Synchronizes the status of all issued passes on grantor's device by reading the single-use
 * token JSON from the cloud remote (.rflix_passes/<id>.json).
 * Updates grantor store to 'claimed', 'expired', or 'revoked'.
 */
export async function syncIssuedPasses(): Promise<void> {
  const s = useAppStore.getState();
  if (!s.issuedPasses || s.issuedPasses.length === 0 || !s.rcloneConfigPath) return;

  const now = Date.now();
  for (const pass of s.issuedPasses) {
    if (pass.status === "revoked") continue;

    try {
      const rawTokenBytes = await rcloneReadBytes(s.rcloneConfigPath, pass.tokenPath);
      const token = JSON.parse(new TextDecoder().decode(rawTokenBytes)) as PassToken;
      if (token && token.status) {
        let newStatus = token.status;
        if (token.status === "claimed" && token.expiresAt && now >= token.expiresAt) {
          newStatus = "expired";
        }
        const updatedClaimedAt = token.claimedAt ?? pass.claimedAt;
        const updatedExpiresAt = token.expiresAt ?? pass.expiresAt;
        if (
          newStatus !== pass.status ||
          updatedClaimedAt !== pass.claimedAt ||
          updatedExpiresAt !== pass.expiresAt
        ) {
          log.info(
            "access-pass",
            `Syncing pass "${pass.label}" (${pass.passId}) status: ${pass.status} -> ${newStatus}`
          );
          s.updateIssuedPass(pass.passId, {
            status: newStatus,
            claimedAt: updatedClaimedAt ?? undefined,
            expiresAt: updatedExpiresAt ?? undefined,
          });
        }
      }
    } catch (err) {
      log.warn("access-pass", `Failed to sync token status for pass ${pass.passId}: ${err}`);
    }
  }
}

/**
 * Computes the effective expiration timestamp (ms) for an IssuedPass.
 * Returns null for lifetime passes.
 */
export function resolveIssuedPassExpiry(pass: IssuedPass): number | null {
  if (pass.duration === "lifetime") return null;
  if (pass.expiresAt && pass.expiresAt > 0) return pass.expiresAt;
  const durMs = durationToMs(pass.duration);
  if (!durMs) return null;
  const baseTime = pass.claimedAt || pass.createdAt || Date.now();
  return baseTime + durMs;
}

/**
 * Generates a pre-filled mailto: URI to remind a guest user that their Shared Access Pass is expiring.
 * Zero tokens or credentials are included in the email.
 */
export function generatePassExpiryReminderMailto(
  pass: IssuedPass,
  recipientEmail: string,
  hostName?: string
): { mailtoUrl: string; daysRemaining: number; expiryDateFormatted: string } {
  const expiresAt = resolveIssuedPassExpiry(pass) ?? Date.now();
  const diffMs = expiresAt - Date.now();
  const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  const expiryDateFormatted = new Date(expiresAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const sender = hostName?.trim() || "your RcloneFlix host";
  const libNames = pass.sharedLibraries.map((l) => l.name).join(", ") || "Shared Media";

  const subject = encodeURIComponent(
    daysRemaining === 0
      ? `Your RcloneFlix Access Pass (${pass.label}) expires today`
      : `Reminder: Your RcloneFlix Access Pass (${pass.label}) expires in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}`
  );

  const body = encodeURIComponent(
    `Hi,\n\n` +
      `This is a friendly reminder that your RcloneFlix guest access pass "${pass.label}" (granting access to: ${libNames}) ` +
      (daysRemaining === 0
        ? `is scheduled to expire today (${expiryDateFormatted}).\n\n`
        : `will expire in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} on ${expiryDateFormatted}.\n\n`) +
      `If you would like to extend your access or receive a new pass, please reply to ${sender}.\n\n` +
      `Enjoy streaming!\n` +
      `— Sent via RcloneFlix`
  );

  return {
    mailtoUrl: `mailto:${encodeURIComponent(recipientEmail.trim())}?subject=${subject}&body=${body}`,
    daysRemaining,
    expiryDateFormatted,
  };
}

/**
 * Extends an issued pass's expiration on the cloud remote (.rflix_passes/<passId>.json)
 * and updates the grantor's local store without requiring a new .rflix file.
 */
export async function extendIssuedPass(
  passId: string,
  additionalDuration: AccessPassDuration
): Promise<{ newExpiresAt: number | null }> {
  const s = useAppStore.getState();
  const pass = s.issuedPasses?.find((p) => p.passId === passId);
  if (!pass) throw new Error("Issued pass not found.");

  const now = await getNetworkTime();
  const addMs = durationToMs(additionalDuration);
  const currentBase = pass.expiresAt && pass.expiresAt > now ? pass.expiresAt : now;
  const newExpiresAt = additionalDuration === "lifetime" ? null : currentBase + (addMs || 7 * 86400 * 1000);

  let updatedToken: PassToken = {
    passId: pass.passId,
    label: pass.label,
    duration: additionalDuration === "lifetime" ? "lifetime" : pass.duration,
    createdAt: pass.createdAt,
    status: pass.status === "unclaimed" ? "unclaimed" : pass.status === "revoked" ? "revoked" : "claimed",
    claimedBy: null,
    claimedAt: pass.claimedAt || now,
    expiresAt: newExpiresAt,
  };

  try {
    const rawBytes = await rcloneReadBytes(s.rcloneConfigPath, pass.tokenPath);
    const existing = JSON.parse(new TextDecoder().decode(rawBytes)) as PassToken;
    updatedToken = {
      ...existing,
      duration: additionalDuration === "lifetime" ? "lifetime" : existing.duration,
      status: existing.status === "unclaimed" ? "unclaimed" : existing.status === "revoked" ? "revoked" : "claimed",
      expiresAt: newExpiresAt,
    };
  } catch {
    // Token file may not exist yet or was cleaned up; write fresh token
  }

  await rcloneUploadBytes(
    s.rcloneConfigPath,
    pass.tokenPath,
    new TextEncoder().encode(JSON.stringify(updatedToken, null, 2))
  );

  s.updateIssuedPass(passId, {
    duration: additionalDuration === "lifetime" ? "lifetime" : pass.duration,
    status: updatedToken.status,
    expiresAt: newExpiresAt ?? undefined,
  });

  return { newExpiresAt };
}

/**
 * Re-checks the remote token file for an imported guest pass so a guest whose pass
 * was extended by the host can restore access in 1 click.
 */
export async function refreshGuestPassStatus(passId: string): Promise<boolean> {
  const s = useAppStore.getState();
  const sharedLibs = s.libraries.filter((l) => l.passId === passId && l.isSharedPass);
  if (sharedLibs.length === 0 || !s.rcloneConfigPath) return false;

  const firstRemotePath = sharedLibs[0].remotePaths[0] || "";
  const colonIdx = firstRemotePath.indexOf(":");
  if (colonIdx === -1) return false;
  const scopedRemote = firstRemotePath.slice(0, colonIdx);
  const tokenPath = `${scopedRemote}:.rflix_passes/${passId}.json`;

  try {
    const rawBytes = await rcloneReadBytes(s.rcloneConfigPath, tokenPath);
    const token = JSON.parse(new TextDecoder().decode(rawBytes)) as PassToken;
    const now = await getNetworkTime();
    if (token.status !== "revoked" && (!token.expiresAt || token.expiresAt > now)) {
      for (const lib of sharedLibs) {
        s.updateLibrary(lib.id, {
          expiresAt: token.expiresAt ?? undefined,
          isExpired: false,
        });
      }
      return true;
    }
  } catch (err) {
    log.warn("access-pass", `Failed checking guest pass extension for ${passId}: ${err}`);
  }
  return false;
}

export function formatRemoteDisplayName(name: string): string {
  return name
    .replace(/^shared_(?:[a-z0-9]{4}_)?fast_(\d+)$/i, "Fast Cloud Remote $1")
    .replace(/^shared_(?:[a-z0-9]{4}_)?cloud_(\d+)$/i, "Cloud Remote $1")
    .replace(/^shared_/i, "Shared ");
}

export type PublishSummary = {
  updated: number;
  unchanged: number;
  skipped: Array<{ passId: string; label: string; reason: string }>;
  failed: Array<{ passId: string; label: string; error: string }>;
};

let publishChain: Promise<unknown> = Promise.resolve();

/** Serialised: concurrent triggers (scan end + Push button) run one after the other. */
export function publishUpdatesToIssuedPasses(
  options: { passIds?: string[]; force?: boolean } = {}
): Promise<PublishSummary> {
  const run = publishChain.then(
    () => doPublish(options),
    () => doPublish(options)
  );
  publishChain = run.catch(() => {});
  return run;
}

async function doPublish(options: { passIds?: string[]; force?: boolean }): Promise<PublishSummary> {
  const summary: PublishSummary = { updated: 0, unchanged: 0, skipped: [], failed: [] };
  const s0 = useAppStore.getState();
  if (!s0.rcloneConfigPath) return summary;

  const passes = (s0.issuedPasses || []).filter(
    (p) =>
      p.status !== "revoked" &&
      p.status !== "expired" &&
      (!options.passIds || options.passIds.includes(p.passId))
  );

  for (const pass of passes) {
    try {
      if (!pass.catalogKey) {
        summary.skipped.push({ passId: pass.passId, label: pass.label, reason: "Issued before live updates existed — re-issue the pass." });
        continue;
      }

      const s = useAppStore.getState();
      const libs = pass.sharedLibraries.map((sl) => {
        const live = s.libraries.find((l) => l.id === sl.id);
        return { id: sl.id, name: live?.name ?? sl.name, type: live?.type ?? sl.type };
      });
      const body = buildGuestCatalogBody({
        passId: pass.passId,
        libraries: libs,
        mediaItems: s.mediaItems,
        picks: s.adminWeeklyRecommendations || {},
      });
      const { bytes, hash } = await encodeBody(body);
      const n = body.items.length;
      const prev = pass.catalogItemCount ?? 0;

      // Local content-hash & shrink guards run BEFORE any remote rclone calls so startup catch-up / no-op debounce triggers do zero network I/O.
      if (!options.force) {
        if (n === 0 && prev > 0) {
          summary.skipped.push({ passId: pass.passId, label: pass.label, reason: "Library looks empty right now; not publishing." });
          continue;
        }
        if (prev >= 20 && n < prev * 0.5) {
          summary.skipped.push({ passId: pass.passId, label: pass.label, reason: `Item count dropped ${prev} → ${n}; not publishing (use Push Updates to force).` });
          continue;
        }
        if (hash === pass.catalogHash) {
          summary.unchanged++;
          continue;
        }
      }

      // Read-only token check: never write the token here.
      try {
        const tok = JSON.parse(
          new TextDecoder().decode(await rcloneReadBytes(s0.rcloneConfigPath, pass.tokenPath))
        ) as PassToken;
        if (tok.status === "revoked" || tok.status === "expired") {
          useAppStore.getState().updateIssuedPass(pass.passId, { status: tok.status });
          summary.skipped.push({ passId: pass.passId, label: pass.label, reason: `Pass is ${tok.status}.` });
          continue;
        }
      } catch {
        summary.skipped.push({ passId: pass.passId, label: pass.label, reason: "Pass token not reachable." });
        continue;
      }

      const updatedAt = Date.now();
      await uploadCatalogFiles({
        configPath: s.rcloneConfigPath,
        remote: pass.remoteName,
        passId: pass.passId,
        catalogKey: pass.catalogKey,
        bytes,
        hash,
        itemCount: n,
        updatedAt,
      });
      useAppStore.getState().updateIssuedPass(pass.passId, {
        catalogHash: hash,
        catalogUpdatedAt: updatedAt,
        catalogItemCount: n,
        lastPublishedAt: updatedAt,
      });
      summary.updated++;
    } catch (err) {
      summary.failed.push({ passId: pass.passId, label: pass.label, error: err instanceof Error ? err.message : String(err) });
      log.warn("access-pass", `Publish failed for pass ${pass.passId}: ${err}`);
    }
  }
  return summary;
}

export type SyncSummary = {
  passId: string;
  label: string;
  status: "updated" | "unchanged" | "revoked" | "blocked" | "error";
  added: number;
  updated: number;
  removed: number;
  message?: string;
};

let inFlightSync: Promise<SyncSummary[]> | null = null;

export function syncSharedPassLibraries(options: { passId?: string; force?: boolean } = {}): Promise<SyncSummary[]> {
  if (inFlightSync) return inFlightSync;
  inFlightSync = doSync(options).finally(() => {
    inFlightSync = null;
  });
  return inFlightSync;
}

async function doSync(options: { passId?: string; force?: boolean }): Promise<SyncSummary[]> {
  const results: SyncSummary[] = [];
  const s0 = useAppStore.getState();
  const cfg = s0.rcloneConfigPath;
  if (!cfg) return results;

  const byPass = new Map<string, Library[]>();
  for (const l of s0.libraries) {
    if (!l.isSharedPass || l.isExpired || !l.passId || !l.passSync) continue; // legacy libs: nothing to sync
    if (options.passId && l.passId !== options.passId) continue;
    byPass.set(l.passId, [...(byPass.get(l.passId) || []), l]);
  }

  for (const [passId, libs] of byPass) {
    const ps = libs[0].passSync!;
    const label = libs[0].grantorLabel || passId;
    const res: SyncSummary = { passId, label, status: "unchanged", added: 0, updated: 0, removed: 0 };
    results.push(res);
    try {
      // 1. Token: ONLY a parsed "revoked" removes access. Any read/parse failure = "unknown, keep everything".
      let token: PassToken;
      try {
        token = JSON.parse(new TextDecoder().decode(await rcloneReadBytes(cfg, ps.tokenPath))) as PassToken;
      } catch (e) {
        res.status = "error";
        res.message = `Could not reach pass (${e instanceof Error ? e.message : e})`;
        continue;
      }
      if (token.status === "revoked") {
        await removeSharedPass(passId);
        res.status = "revoked";
        continue;
      }
      // Host extended the pass (including to lifetime where expiresAt is null): pick up the new expiry without a manual refresh.
      const nextExpiresAt = token.expiresAt ?? undefined;
      if (nextExpiresAt !== libs[0].expiresAt) {
        for (const l of libs) useAppStore.getState().updateLibrary(l.id, { expiresAt: nextExpiresAt, isExpired: false });
      }

      // 2. Manifest (tiny). Missing = nothing published yet.
      let manifest: CatalogManifest;
      try {
        manifest = JSON.parse(new TextDecoder().decode(await rcloneReadBytes(cfg, ps.manifestPath))) as CatalogManifest;
      } catch {
        continue;
      }
      if (!options.force && ps.updatedAt && manifest.updatedAt <= ps.updatedAt) continue;

      // 3. Catalog: integrity-checked against the manifest (guards against reading a half-written upload).
      const blob = await rcloneReadBytes(cfg, ps.catalogPath);
      const bytes = await unpackCatalog(blob, ps.catalogKey);
      if ((await sha256Hex(bytes)) !== manifest.hash) {
        res.status = "error";
        res.message = "Catalog is still being uploaded; will retry.";
        continue;
      }
      const body = JSON.parse(new TextDecoder().decode(bytes)) as GuestCatalogBody;
      if (body.version !== CATALOG_VERSION || body.passId !== passId || !Array.isArray(body.items)) {
        res.status = "error";
        res.message = "Unrecognized catalog format.";
        continue;
      }

      // 4. Map + diff.
      const s = useAppStore.getState();
      const guestLibIds = new Set(libs.map((l) => l.id));
      const sourceIds = new Set(body.libraries.map((l) => l.id).filter((id) => guestLibIds.has(`shared_${id}`)));
      // ONLY scoped pass remotes count as "available" (same meaning as at import). Including the guest's own
      // remotes would stop version promotion whenever they happen to own a remote with the grantor's name.
      const configuredRemotes = new Set<string>(
        [...(s.remotes || []).map((r) => r.name), ...extractSectionNames(s.rcloneConfigContent || "")].filter((n) =>
          n.startsWith("shared_")
        )
      );
      const available =
        configuredRemotes.size > 0 ? configuredRemotes : new Set(Object.values(ps.remoteMapping));
      const mapping: Record<string, string> = {};
      for (const [orig, anon] of Object.entries(ps.remoteMapping)) if (available.has(anon)) mapping[orig] = anon;

      const built = buildGuestLibraryStateFromItems({
        rawItems: body.items,
        sourceLibraryIds: sourceIds,
        remoteMapping: mapping,
        availableScopedRemotes: available,
        weeklyRecommendations: body.weeklyRecommendations,
      });
      const existing = Object.values(s.mediaItems).filter((i) => guestLibIds.has(i.libraryId));
      const plan = planCatalogApply(existing, built.items, { force: options.force });
      if (plan.blocked) {
        res.status = "blocked";
        res.message = plan.blocked;
        continue;
      }

      // 5. Apply (SQLite + store inside setLibrarySyncPaused so libraryDb's subscriber doesn't double-write/delete).
      const st = useAppStore.getState();
      setLibrarySyncPaused(true);
      try {
        await deleteItems(plan.removedIds);
        await persistItems(plan.toUpsert);
        st.removeMediaItemsBulk(plan.removedIds);
        st.bulkUpsertMediaItems(plan.toUpsert);
      } finally {
        setLibrarySyncPaused(false);
      }

      const passItemIds = new Set(built.items.map((i) => i.id));
      for (const id of plan.removedIds) passItemIds.add(id);
      useAppStore.setState((cur) => ({
        guestRecommendations: mergeGuestRecommendations(cur.guestRecommendations, passItemIds, built.guestRecommendations),
      }));

      for (const meta of body.libraries) {
        const gl = libs.find((l) => l.id === `shared_${meta.id}`);
        if (!gl) continue;
        const nextName = `${meta.name} (${gl.grantorLabel || "Shared"})`;
        st.updateLibrary(gl.id, {
          ...(nextName !== gl.name ? { name: nextName } : {}),
          passSync: { ...ps, updatedAt: manifest.updatedAt, hash: manifest.hash },
        });
      }
      for (const gl of libs) {
        if (!body.libraries.some((m) => `shared_${m.id}` === gl.id)) {
          st.updateLibrary(gl.id, { passSync: { ...ps, updatedAt: manifest.updatedAt, hash: manifest.hash } });
        }
      }

      res.status = plan.added + plan.updated + plan.removedIds.length > 0 ? "updated" : "unchanged";
      res.added = plan.added;
      res.updated = plan.updated;
      res.removed = plan.removedIds.length;
    } catch (err) {
      res.status = "error";
      res.message = err instanceof Error ? err.message : String(err);
      log.warn("access-pass", `Sync failed for pass ${passId}: ${res.message}`);
    }
  }
  return results;
}

