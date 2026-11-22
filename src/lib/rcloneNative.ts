import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type RcloneRemote } from "../store/appStore";

export function isAndroidRuntime(): boolean {
  return typeof window !== "undefined" && Boolean((window as any).AndroidBridge);
}

/**
 * Matches the 4 local path shapes in CloudExplorerPage.tsx:366-374.
 */
export function isLocalRemotePath(remoteOrPath: string): boolean {
  const s = (remoteOrPath || "").trim();
  if (!s) return true;
  return (
    s.startsWith("/") ||
    s.startsWith("\\") ||
    /^[a-zA-Z]:[/\\]/.test(s) ||
    s.startsWith("local:")
  );
}

type RustRcloneRemote = {
  name: string;
  remote_type: string;
};

export type RcloneQuota = {
  supported: boolean;
  total?: number | null;
  used?: number | null;
  free?: number | null;
  trashed?: number | null;
};

const QUOTA_TTL_MS = 60_000;
const latestQuotaByRemote = new Map<string, { quota: RcloneQuota; fetchedAt: number }>();
type QuotaMutationListener = (mutatedRemote: string | null) => void;
const quotaListeners = new Set<QuotaMutationListener>();

export function subscribeQuotaMutations(listener: QuotaMutationListener): () => void {
  quotaListeners.add(listener);
  return () => {
    quotaListeners.delete(listener);
  };
}

export function notifyRemoteMutated(remoteName?: string): void {
  if (remoteName) {
    const clean = remoteName.replace(/:.*$/, "").trim().toLowerCase();
    if (clean) {
      latestQuotaByRemote.delete(clean);
      quotaListeners.forEach((fn) => fn(clean));
      return;
    }
  }
  latestQuotaByRemote.clear();
  quotaListeners.forEach((fn) => fn(null));
}

export function formatQuotaBytes(bytes?: number | null): string {
  if (bytes == null || Number.isNaN(bytes)) return "--";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

export async function fetchRemoteQuota(
  remoteName: string,
  forceRefresh = false
): Promise<RcloneQuota> {
  if (isAndroidRuntime() || isLocalRemotePath(remoteName)) return { supported: false };
  const clean = remoteName.replace(/:.*$/, "").trim();
  if (!clean) return { supported: false };
  const key = clean.toLowerCase();
  const cached = latestQuotaByRemote.get(key);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < QUOTA_TTL_MS) {
    return cached.quota;
  }
  const { rcloneConfigPath } = useAppStore.getState();
  const q = await invoke<RcloneQuota>("rclone_about", {
    configPath: rcloneConfigPath || "",
    remoteName: clean,
  });
  latestQuotaByRemote.set(key, { quota: q, fetchedAt: Date.now() });
  return q;
}

/**
 * Checks destination remote free space (respecting the 60-second TTL cache) and returns
 * a warning string if `free < requiredBytes`, or `null` otherwise.
 */
export async function checkRemoteFreeSpaceWarning(
  remoteName: string,
  requiredBytes: number,
  operationLabel: string
): Promise<string | null> {
  if (isAndroidRuntime() || requiredBytes <= 0 || isLocalRemotePath(remoteName)) return null;
  const clean = remoteName.replace(/:.*$/, "").trim();
  if (!clean || clean === "telegram" || clean === "streamtape") {
    return null;
  }
  const q = await fetchRemoteQuota(clean, false).catch(() => ({ supported: false } as RcloneQuota));
  if (q.supported && q.free != null && q.free < requiredBytes) {
    return `Low free space on ${clean}: (${formatQuotaBytes(q.free)} free, ${operationLabel} requires at least ${formatQuotaBytes(requiredBytes)}).`;
  }
  return null;
}

/**
 * Shared validator for the soft-delete app trash directory name.
 */
export function isValidSoftDeleteTrashDir(raw: string): boolean {
  const t = raw.trim().replace(/^\/+|\/+$/g, "");
  return Boolean(t && t !== "." && t !== ".." && /^[A-Za-z0-9._-]+$/.test(t));
}

export function getConfiguredAppTrashDir(): string {
  const raw =
    useAppStore.getState().rcloneSettings?.softDeleteTrashDir?.trim().replace(/^\/+|\/+$/g, "") ||
    "";
  return isValidSoftDeleteTrashDir(raw) ? raw : ".rcloneflix_trash";
}

export function inspectAppTrashPath(fullPath: string): {
  inTrash: boolean;
  isTimestampRoot: boolean;
  canRestore: boolean;
  trashDirName: string;
} {
  const trashDirName = getConfiguredAppTrashDir();
  if (isLocalRemotePath(fullPath)) {
    return { inTrash: false, isTimestampRoot: false, canRestore: false, trashDirName };
  }
  const colonIdx = fullPath.indexOf(":");
  if (colonIdx <= 1) {
    return { inTrash: false, isTimestampRoot: false, canRestore: false, trashDirName };
  }
  const rel = fullPath.slice(colonIdx + 1).replace(/^\/+|\/+$/g, "");
  if (!rel) {
    return { inTrash: false, isTimestampRoot: false, canRestore: false, trashDirName };
  }
  const segs = rel.split("/").filter(Boolean);
  const first = segs[0] || "";
  if (first !== trashDirName && first !== ".rcloneflix_trash") {
    return { inTrash: false, isTimestampRoot: false, canRestore: false, trashDirName };
  }
  return {
    inTrash: true,
    isTimestampRoot: segs.length === 2,
    canRestore: segs.length >= 3,
    trashDirName: first,
  };
}

export type DeleteClassification = {
  mode: "soft" | "permanent" | "mixed";
  softCount: number;
  permanentCount: number;
  trashDir: string;
};

/**
 * Classifies whether deleting `itemNames` inside `currentPath` will soft-delete (`"soft"`),
 * permanently delete (`"permanent"`), or perform a mixed root delete (`"mixed"` when the trash
 * folder itself is selected alongside normal items at the remote root).
 */
export function classifyDeleteItems(
  selectedRemote: string,
  currentPath: string,
  itemNames: string[],
  isLocalRemote = false
): DeleteClassification {
  const trashDir = getConfiguredAppTrashDir();
  if (
    isAndroidRuntime() ||
    isLocalRemote ||
    isLocalRemotePath(selectedRemote) ||
    isLocalRemotePath(currentPath) ||
    !useAppStore.getState().rcloneSettings?.softDeleteEnabled
  ) {
    return { mode: "permanent", softCount: 0, permanentCount: itemNames.length, trashDir };
  }

  const cleanRemote = selectedRemote.replace(/:.*$/, "").trim();
  const fullFolderPath = currentPath.includes(":")
    ? currentPath
    : `${cleanRemote}:${currentPath.replace(/^\/+/, "")}`;

  if (inspectAppTrashPath(fullFolderPath).inTrash) {
    return { mode: "permanent", softCount: 0, permanentCount: itemNames.length, trashDir };
  }

  const relDir = fullFolderPath.replace(/^[^:]*:/, "").replace(/^\/+|\/+$/g, "");
  if (!relDir) {
    let permanentCount = 0;
    for (const name of itemNames) {
      if (name === trashDir || name === ".rcloneflix_trash") {
        permanentCount++;
      }
    }
    const softCount = itemNames.length - permanentCount;
    if (permanentCount === 0) {
      return { mode: "soft", softCount, permanentCount: 0, trashDir };
    }
    if (softCount === 0) {
      return { mode: "permanent", softCount: 0, permanentCount, trashDir };
    }
    return { mode: "mixed", softCount, permanentCount, trashDir };
  }

  return { mode: "soft", softCount: itemNames.length, permanentCount: 0, trashDir };
}

export async function refreshMountedVfsAfterMutation(remoteOrPath: string): Promise<boolean> {
  if (isAndroidRuntime() || isLocalRemotePath(remoteOrPath)) return false;
  const colonIdx = remoteOrPath.indexOf(":");
  if (colonIdx <= 1) return false;
  const cleanRemote = remoteOrPath.slice(0, colonIdx).trim();
  const rel = remoteOrPath.slice(colonIdx + 1).replace(/^\/+/, "");
  const parentDir = rel ? rel.split("/").slice(0, -1).join("/") || undefined : undefined;
  return invoke<boolean>("rclone_vfs_refresh", {
    remoteName: cleanRemote,
    dirPath: parentDir,
  }).catch(() => false);
}

export async function createUnionRemote(params: {
  remoteName: string;
  upstreams: string[];
  actionPolicy: "epall" | "all" | "epff";
  createPolicy: "epmfs" | "mfs" | "lus" | "epall";
}): Promise<RcloneRemote[]> {
  if (isAndroidRuntime()) throw new Error("Union remote creation is desktop-only.");
  const { rcloneConfigPath, setRemotes } = useAppStore.getState();
  const raw = await invoke<RustRcloneRemote[]>("rclone_create_union_remote", {
    configPath: rcloneConfigPath || "",
    remoteName: params.remoteName,
    upstreams: params.upstreams,
    actionPolicy: params.actionPolicy,
    createPolicy: params.createPolicy,
  });
  const mapped: RcloneRemote[] = raw.map((r) => ({ name: r.name, type: r.remote_type }));
  setRemotes(mapped);
  return mapped;
}

export async function createCombineRemote(params: {
  remoteName: string;
  upstreams: Array<[string, string]>;
}): Promise<RcloneRemote[]> {
  if (isAndroidRuntime()) throw new Error("Combine remote creation is desktop-only.");
  const { rcloneConfigPath, setRemotes } = useAppStore.getState();
  const raw = await invoke<RustRcloneRemote[]>("rclone_create_combine_remote", {
    configPath: rcloneConfigPath || "",
    remoteName: params.remoteName,
    upstreams: params.upstreams,
  });
  const mapped: RcloneRemote[] = raw.map((r) => ({ name: r.name, type: r.remote_type }));
  setRemotes(mapped);
  return mapped;
}

export async function runRcloneBisync(params: {
  localDir: string;
  remoteDir: string;
  resync: boolean;
  dryRun: boolean;
  conflictResolve: "none" | "newer" | "older" | "larger" | "smaller" | "path1" | "path2";
}): Promise<string> {
  if (isAndroidRuntime()) throw new Error("Bisync is desktop-only.");
  const { rcloneConfigPath } = useAppStore.getState();
  return invoke<string>("rclone_bisync", {
    configPath: rcloneConfigPath || "",
    ...params,
  });
}

export async function runRcloneDedupe(params: {
  remotePath: string;
  mode: "newest" | "oldest" | "largest" | "smallest" | "rename" | "skip";
  byHash: boolean;
  dryRun: boolean;
}): Promise<string> {
  if (isAndroidRuntime()) throw new Error("Dedupe is desktop-only.");
  const { rcloneConfigPath } = useAppStore.getState();
  return invoke<string>("rclone_dedupe", {
    configPath: rcloneConfigPath || "",
    ...params,
  });
}

export type HashsumAlgorithm = "md5" | "sha1" | "quickxor" | "sha256" | "crc32";

export type HashsumLineEntry = {
  filename: string;
  hash: string | null;
  supported: boolean;
  error: boolean;
};

export async function fetchNativeHashsum(
  remotePath: string,
  hashType: HashsumAlgorithm
): Promise<{ supported: boolean; entries: HashsumLineEntry[]; raw: string; algorithm: HashsumAlgorithm }> {
  if (isAndroidRuntime()) return { supported: false, entries: [], raw: "", algorithm: hashType };
  const { rcloneConfigPath } = useAppStore.getState();
  const raw = await invoke<string>("rclone_hashsum", {
    configPath: rcloneConfigPath || "",
    remotePath,
    hashType,
  });
  const entries: HashsumLineEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const token = match[1];
    const tokenUpper = token.toUpperCase();
    const filename = match[2];
    const isError = tokenUpper === "ERROR";
    const lineSupported = tokenUpper !== "UNSUPPORTED" && !isError;
    entries.push({
      filename,
      hash: lineSupported ? token : null,
      supported: lineSupported,
      error: isError,
    });
  }
  const supported = entries.some((e) => e.supported);
  return { supported, entries, raw, algorithm: hashType };
}

export async function fetchBestAvailableHashsum(remotePath: string): Promise<{
  supported: boolean;
  algorithm: HashsumAlgorithm;
  hash: string | null;
  error: boolean;
}> {
  const candidates: HashsumAlgorithm[] = ["md5", "sha1", "quickxor"];
  let sawError = false;
  for (const alg of candidates) {
    const res = await fetchNativeHashsum(remotePath, alg);
    if (res.entries.some((e) => e.error)) sawError = true;
    const hit = res.entries.find((e) => e.supported && e.hash);
    if (hit && hit.hash) {
      return { supported: true, algorithm: alg, hash: hit.hash, error: false };
    }
  }
  return { supported: false, algorithm: "md5", hash: null, error: sawError };
}

export async function emptyProviderNativeTrash(remoteName: string): Promise<void> {
  if (isAndroidRuntime()) throw new Error("Cleanup is desktop-only.");
  const { rcloneConfigPath } = useAppStore.getState();
  await invoke("rclone_cleanup", {
    configPath: rcloneConfigPath || "",
    remoteName,
  });
  notifyRemoteMutated(remoteName);
}

export async function emptyRcloneFlixAppTrash(remoteName: string): Promise<void> {
  if (isAndroidRuntime()) throw new Error("App trash management is desktop-only.");
  const { rcloneConfigPath } = useAppStore.getState();
  await invoke("rclone_empty_app_trash", {
    configPath: rcloneConfigPath || "",
    remoteName,
  });
  notifyRemoteMutated(remoteName);
}

export async function restoreFromRcloneFlixAppTrash(trashItemPath: string): Promise<string> {
  if (isAndroidRuntime()) throw new Error("App trash restore is desktop-only.");
  const { rcloneConfigPath } = useAppStore.getState();
  const restored = await invoke<string>("rclone_restore_from_app_trash", {
    configPath: rcloneConfigPath || "",
    trashItemPath,
  });
  const colonIdx = trashItemPath.indexOf(":");
  if (colonIdx > 1) notifyRemoteMutated(trashItemPath.slice(0, colonIdx));
  return restored;
}
