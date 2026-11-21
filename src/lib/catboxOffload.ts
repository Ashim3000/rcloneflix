import { useAppStore, type MediaItem } from "../store/appStore";
import { invoke } from "@tauri-apps/api/core";
import { log } from "./log";

const CATBOX_MAX_BYTES = 200 * 1024 * 1024;
const DISALLOWED_EXT_RE = /\.(exe|scr|cpl|doc|docx|jar)$/i;

export async function offloadItemToCatbox(item: MediaItem): Promise<string> {
  const { rcloneConfigPath, catboxConfig, upsertMediaItem } = useAppStore.getState();
  if (typeof window !== "undefined" && (window as any).AndroidBridge) {
    throw new Error("Catbox offload is desktop-only for now.");
  }
  if (!catboxConfig?.enabled) {
    throw new Error("Catbox.moe offload is disabled in Settings.");
  }
  const filename = item.filename || item.remotePath.split("/").pop() || "media.bin";
  if (DISALLOWED_EXT_RE.test(filename)) {
    throw new Error(`Catbox.moe does not allow uploading ${filename} file types.`);
  }
  if (item.sizeBytes && item.sizeBytes > CATBOX_MAX_BYTES) {
    throw new Error(`File exceeds Catbox.moe 200 MB limit (${Math.round(item.sizeBytes / 1048576)} MB).`);
  }

  const urlText = await invoke<string>("catbox_upload_file", {
    configPath: rcloneConfigPath || "",
    remotePath: item.remotePath,
    filename,
    userhash: catboxConfig?.userhash?.trim() || null,
  });

  const catboxVersion = {
    id: `${item.id}-catbox`,
    libraryId: item.libraryId,
    isLocal: false,
    remoteName: "catbox",
    remotePath: `catbox:${urlText.split("/").pop()}`,
    filename,
    sizeBytes: item.sizeBytes ?? 0,
    priority: 1,
    isAvailable: true,
    lastChecked: Date.now(),
    sourceType: "catbox" as any,
    shareUrl: urlText,
  };

  const existing = (item.versions || []).filter((v) => v.remoteName !== "catbox");
  upsertMediaItem({
    ...item,
    versions: [catboxVersion, ...existing],
  });

  log.info("catbox", `Offloaded "${item.title}" to Catbox: ${urlText}`);
  return urlText;
}
