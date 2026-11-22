import { useAppStore, type MediaItem, type GalleryPhoto, type PhotoGallery } from "../store/appStore";
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

export function resolvePhotoCatboxSourcePath(photo: GalleryPhoto): string | null {
  const candidate =
    photo.storageMode === "original" || photo.storageMode === "both"
      ? photo.remoteOriginalPath || photo.remotePath || photo.remotePreviewPath
      : photo.remotePath || photo.remoteOriginalPath || photo.remotePreviewPath;
  if (!candidate || !candidate.trim()) return null;
  return candidate.trim();
}

export function isPhotoVaultEncrypted(photo: GalleryPhoto): boolean {
  const paths = [photo.remotePath, photo.remoteOriginalPath, photo.remotePreviewPath].filter(Boolean) as string[];
  if (paths.length === 0) return true;
  return paths.some((p) => p.endsWith(".enc") || p.includes("/vault_photos/") || p.startsWith("vault:"));
}

export function isPhotoEligibleForCatbox(gallery: PhotoGallery, photo: GalleryPhoto): boolean {
  if (gallery.isAdult || photo.isAdult) return false;
  if (isPhotoVaultEncrypted(photo)) return false;
  const sourcePath = resolvePhotoCatboxSourcePath(photo);
  if (!sourcePath) return false;
  if (sourcePath.startsWith("shared_") || sourcePath.startsWith("local://") || sourcePath.startsWith("file://")) {
    return false;
  }
  return true;
}

export async function offloadPhotoToCatbox(galleryId: string, photo: GalleryPhoto): Promise<string> {
  const { rcloneConfigPath, catboxConfig, galleries, upsertGallery } = useAppStore.getState();
  if (typeof window !== "undefined" && (window as any).AndroidBridge) {
    throw new Error("Catbox offload is desktop-only for now.");
  }
  if (!catboxConfig?.enabled) {
    throw new Error("Catbox.moe offload is disabled in Settings.");
  }
  const gallery = galleries[galleryId];
  if (!gallery) {
    throw new Error("Photo gallery not found.");
  }
  if (gallery.isAdult || photo.isAdult) {
    throw new Error("Adult photos cannot be offloaded to Catbox.moe.");
  }
  if (isPhotoVaultEncrypted(photo)) {
    throw new Error("Vault-encrypted photos (.enc) cannot be offloaded to Catbox.moe.");
  }
  const sourcePath = resolvePhotoCatboxSourcePath(photo);
  if (!sourcePath) {
    throw new Error("Photo has no unencrypted remote path to offload.");
  }
  if (sourcePath.startsWith("shared_")) {
    throw new Error("Guest-pass photos cannot be offloaded.");
  }

  const filename = photo.filename || sourcePath.split("/").pop() || "photo.jpg";
  if (DISALLOWED_EXT_RE.test(filename) || filename.endsWith(".enc")) {
    throw new Error(`Catbox.moe does not allow uploading ${filename} file types.`);
  }
  const byteSize = photo.originalSizeBytes || photo.sizeBytes || 0;
  if (byteSize > CATBOX_MAX_BYTES) {
    throw new Error(`Photo exceeds Catbox.moe 200 MB limit (${Math.round(byteSize / 1048576)} MB).`);
  }

  const urlText = await invoke<string>("catbox_upload_file", {
    configPath: rcloneConfigPath || "",
    remotePath: sourcePath,
    filename,
    userhash: catboxConfig?.userhash?.trim() || null,
  });

  const updatedPhotos = gallery.photos.map((p) =>
    p.id === photo.id ? { ...p, catboxUrl: urlText } : p
  );
  upsertGallery({
    ...gallery,
    photos: updatedPhotos,
    updatedAt: Date.now(),
  });

  log.info("catbox", `Offloaded photo "${filename}" to Catbox: ${urlText}`);
  return urlText;
}
