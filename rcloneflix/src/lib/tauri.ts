import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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

// Parse rclone config and return list of remotes
export async function parseRcloneConfig(
  configPath: string
): Promise<RcloneRemote[]> {
  return invoke<RcloneRemote[]>("parse_rclone_config", { configPath });
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

// Get a streaming URL for a remote file
export async function getStreamUrl(
  configPath: string,
  remotePath: string
): Promise<string> {
  return invoke<string>("get_stream_url", { configPath, remotePath });
}

// Save API keys to Tauri's encrypted store
export async function saveApiKeys(keys: {
  tmdb?: string;
  theporndb?: string;
}): Promise<void> {
  return invoke("save_api_keys", { keys });
}

// Load API keys from Tauri's encrypted store
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
