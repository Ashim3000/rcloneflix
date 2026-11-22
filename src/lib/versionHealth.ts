import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type MediaItem, type MediaSourceVersion } from "../store/appStore";

export type DoctorReport = {
  checkedItems: number;
  skippedOfflineRemotes: string[];
  newlyFlaggedVersions: number;
  healthyVersions: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runLibraryDoctor(
  scopeRemoteName?: string,
  onProgress?: (msg: string) => void
): Promise<DoctorReport> {
  const { rcloneConfigPath, mediaItems, updateItemMetadata } = useAppStore.getState();
  const items = Object.values(mediaItems);

  const skippedOfflineRemotes: string[] = [];
  const reachableRemotes = new Map<string, boolean>();

  // 1. Pre-flight remote reachability check so offline machines never mark items dead
  const candidateRemotes = new Set<string>();
  for (const item of items) {
    for (const v of item.versions || []) {
      if (!v.isLocal && v.remoteName && v.remoteName !== "catbox" && v.remoteName !== "telegram") {
        if (!scopeRemoteName || v.remoteName === scopeRemoteName) {
          candidateRemotes.add(v.remoteName);
        }
      }
    }
  }

  for (const remote of candidateRemotes) {
    onProgress?.(`Checking connectivity to remote "${remote}"...`);
    try {
      await invoke("list_remote_path", {
        configPath: rcloneConfigPath || "",
        remotePath: `${remote}:`,
      });
      reachableRemotes.set(remote, true);
    } catch {
      reachableRemotes.set(remote, false);
      skippedOfflineRemotes.push(remote);
    }
    await sleep(250);
  }

  let checkedItems = 0;
  let newlyFlaggedVersions = 0;
  let healthyVersions = 0;

  for (const item of items) {
    if (!item.versions || item.versions.length === 0) continue;
    let changed = false;
    const nextVersions: MediaSourceVersion[] = [];

    for (const v of item.versions) {
      if (scopeRemoteName && v.remoteName !== scopeRemoteName) {
        nextVersions.push(v);
        continue;
      }

      if (v.remoteName && reachableRemotes.get(v.remoteName) === false) {
        nextVersions.push(v);
        continue;
      }

      if (v.shareUrl && v.shareUrl.startsWith("https://files.catbox.moe/")) {
        try {
          const { httpFetch } = await import("./httpFetch");
          const res = await httpFetch(v.shareUrl, { method: "HEAD" });
          if (res.ok) {
            healthyVersions++;
            nextVersions.push({ ...v, isAvailable: true, lastChecked: Date.now() });
          } else if (res.status === 404) {
            const fails = ((v as any).consecutiveHealthFailures || 0) + 1;
            const isAvail = fails < 2;
            if (!isAvail && v.isAvailable) newlyFlaggedVersions++;
            changed = true;
            nextVersions.push({
              ...v,
              isAvailable: isAvail,
              lastChecked: Date.now(),
              ...({ consecutiveHealthFailures: fails } as any),
            });
          } else {
            nextVersions.push(v);
          }
        } catch {
          nextVersions.push(v);
        }
        await sleep(250);
        continue;
      }

      healthyVersions++;
      nextVersions.push(v);
    }

    checkedItems++;
    if (changed) {
      updateItemMetadata(item.id, { versions: nextVersions } as Partial<MediaItem>);
    }
  }

  return {
    checkedItems,
    skippedOfflineRemotes,
    newlyFlaggedVersions,
    healthyVersions,
  };
}
