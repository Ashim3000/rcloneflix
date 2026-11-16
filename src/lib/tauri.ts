import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export type RcloneRemote = {
  name: string;
  remote_type: string;
};

export type RcloneListItem = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mime_type: string | null;
};

// Open a native file picker and return the selected path
export async function pickRcloneConfig(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Rclone Config",
        extensions: ["conf", "config", ""],
      },
    ],
    title: "Select your rclone config file",
  });
  return selected as string | null;
}

// Open a native folder picker for local libraries
export async function pickLocalFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select local folder for library",
  });
  return selected as string | null;
}

// Parse rclone config and return list of remotes
export async function parseRcloneConfig(
  configPath: string
): Promise<RcloneRemote[]> {
  return invoke<RcloneRemote[]>("parse_rclone_config", { configPath });
}

// Create a new rclone crypt remote (AES-256 encrypted storage on top of any remote)
export async function rcloneCreateCryptRemote(
  configPath: string,
  remoteName: string,
  baseRemotePath: string,
  password: string,
  password2?: string
): Promise<RcloneRemote[]> {
  return invoke<RcloneRemote[]>("rclone_create_crypt_remote", {
    configPath,
    remoteName,
    baseRemotePath,
    password,
    password2: password2 || null,
  });
}

// Create a new rclone WebDAV remote (e.g. for Telegram Drive local endpoint)
export async function rcloneCreateWebdavRemote(
  configPath: string,
  remoteName: string,
  url: string,
  user?: string,
  pass?: string
): Promise<RcloneRemote[]> {
  return invoke<RcloneRemote[]>("rclone_create_webdav_remote", {
    configPath,
    remoteName,
    url,
    vendor: "other",
    user: user || null,
    pass: pass || null,
  });
}

// List directory contents via rclone
export async function listRemotePath(
  configPath: string,
  remotePath: string
): Promise<RcloneListItem[]> {
  return invoke<RcloneListItem[]>("list_remote_path", {
    configPath,
    remotePath,
  });
}

// Save API keys to the Tauri store
export async function saveApiKeys(keys: {
  tmdb?: string;
  theporndb?: string;
}): Promise<void> {
  return invoke("save_api_keys", { keys });
}

// Load API keys from the Tauri store
export async function loadApiKeys(): Promise<{
  tmdb: string;
  theporndb: string;
}> {
  return invoke("load_api_keys");
}

// Check if rclone binary is available / get version
export async function getRcloneVersion(): Promise<string> {
  return invoke<string>("get_rclone_version");
}

// ─── Photo Vault Helpers ─────────────────────────────────────────────────────

export async function pickPhotoFiles(): Promise<string[] | null> {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [
      {
        name: "Images",
        extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic"],
      },
    ],
    title: "Select photos to upload to Vault",
  });
  if (!selected) return null;
  return Array.isArray(selected) ? selected : [selected];
}

export async function pickPhotoFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select folder of photos",
  });
  return selected as string | null;
}

export async function listLocalImageFiles(folderPath: string): Promise<string[]> {
  return invoke<string[]>("list_local_image_files", { folderPath });
}

export async function readLocalFileBytes(path: string): Promise<Uint8Array> {
  const bytes = await invoke<number[] | Uint8Array>("read_local_file_bytes", { path });
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

export async function rcloneUploadFile(
  configPath: string,
  localPath: string,
  remotePath: string
): Promise<void> {
  return invoke("rclone_upload_file", { configPath, localPath, remotePath });
}

export async function rcloneMkdir(
  configPath: string,
  remotePath: string
): Promise<void> {
  return invoke("rclone_mkdir", { configPath, remotePath });
}

export async function rcloneUploadBytes(
  configPath: string,
  remotePath: string,
  bytes: Uint8Array | number[]
): Promise<number> {
  const byteArr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
  return invoke<number>("rclone_upload_bytes", { configPath, remotePath, bytes: byteArr });
}

export async function rcloneReadBytes(
  configPath: string,
  remotePath: string
): Promise<Uint8Array> {
  const bytes = await invoke<number[] | Uint8Array>("rclone_read_bytes", { configPath, remotePath });
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

export async function rcloneReadBackup(
  configPath: string,
  remotePath: string
): Promise<string> {
  return invoke<string>("rclone_read_backup", { configPath, remotePath });
}

export async function getCachedVaultPhoto(photoId: string): Promise<Uint8Array | null> {
  const bytes = await invoke<number[] | null>("get_cached_vault_photo", { photoId });
  return bytes ? new Uint8Array(bytes) : null;
}

export async function saveCachedVaultPhoto(
  photoId: string,
  bytes: Uint8Array | number[],
  maxCacheMb?: number
): Promise<void> {
  const byteArr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
  return invoke("save_cached_vault_photo", { photoId, bytes: byteArr, maxCacheMb });
}

export async function clearVaultPhotoCache(): Promise<void> {
  return invoke("clear_vault_photo_cache");
}

export async function vaultPhotoCacheStats(): Promise<{ files: number; bytes: number }> {
  return invoke("vault_photo_cache_stats");
}

export interface VaultPhotoRequest {
  id: string;
  filename: string;
  remote_path?: string;
  storage_mode?: string;
  is_adult?: boolean;
}

export interface PreparedPhotoResult {
  path: string;
  mime_type: string;
  bytes: number[];
}

export async function prepareVaultPhoto(
  photoId: string,
  pin?: string,
  remotePath?: string,
  configPath?: string
): Promise<PreparedPhotoResult> {
  return invoke<PreparedPhotoResult>("prepare_vault_photo", {
    photoId,
    pin,
    remotePath,
    configPath,
  });
}

export async function batchPrepareVaultPhotos(
  photos: VaultPhotoRequest[],
  pin?: string,
  configPath?: string
): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("batch_prepare_vault_photos", {
    photos,
    pin,
    configPath,
  });
}

export async function startFolderDownload(
  configPath: string,
  downloadId: string,
  remoteFolderPath: string,
  folderName: string,
  destinationDir?: string
): Promise<string> {
  return invoke("start_folder_download", {
    configPath,
    downloadId,
    remoteFolderPath,
    folderName,
    destinationDir,
  });
}

export interface MergeScopedConfigResult {
  config_path: string;
  remotes: RcloneRemote[];
}

export async function rcloneMergeScopedConfig(
  configPath: string,
  scopedContent: string
): Promise<MergeScopedConfigResult> {
  return invoke<MergeScopedConfigResult>("rclone_merge_scoped_config", {
    configPath,
    scopedContent,
  });
}

export async function rcloneRemoveScopedRemotes(
  configPath: string,
  remoteNames: string[]
): Promise<RcloneRemote[]> {
  return invoke<RcloneRemote[]>("rclone_remove_scoped_remotes", {
    configPath,
    remoteNames,
  });
}

export async function writeLocalFileBytes(
  path: string,
  bytes: Uint8Array | number[]
): Promise<void> {
  const byteArr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
  return invoke("write_local_file_bytes", { path, bytes: byteArr });
}

export async function pickAccessPassFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "RcloneFlix Access Pass",
        extensions: ["rflix"],
      },
    ],
    title: "Select .rflix Access Pass File",
  });
  return selected as string | null;
}

export async function saveAccessPassFile(defaultName: string): Promise<string | null> {
  const selected = await save({
    defaultPath: `${defaultName}.rflix`,
    filters: [
      {
        name: "RcloneFlix Access Pass",
        extensions: ["rflix"],
      },
    ],
    title: "Save .rflix Access Pass File",
  });
  return selected as string | null;
}

export async function saveRcloneSettings(settings: import("../store/appStore").RcloneSettings): Promise<void> {
  return invoke("save_rclone_settings", { settings });
}

export async function loadRcloneSettings(): Promise<import("../store/appStore").RcloneSettings> {
  return invoke("load_rclone_settings");
}



