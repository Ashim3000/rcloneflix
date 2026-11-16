import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { useAppStore } from '../store/appStore';

export interface UdropCredentials {
  enabled?: boolean;
  username?: string;
  password?: string;
  key1?: string;
  key2?: string;
  remoteName?: string;
  accessToken?: string;
  accountId?: string;
  tokenExpiresAt?: number;
}

export interface UdropApiFile {
  id: string;
  filename: string;
  shortUrl: string;
  fileType?: string;
  extension?: string;
  fileSize: string;
  status?: string;
  downloads?: string;
  folderId?: string | null;
  url_file?: string;
}

export interface UdropApiFolder {
  id: string;
  parentId: string | null;
  folderName: string;
  totalSize: string;
  isPublic?: string;
  file_count?: number;
}

export interface UdropAccountInfo {
  id: string;
  username: string;
  email: string;
  status: string;
  level_id?: string;
}

const STORAGE_KEY = 'rcloneflix_udrop_config';
const API_BASE = 'https://www.udrop.com/api/v2';

export function loadUdropConfig(): UdropCredentials {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

export function saveUdropConfig(cfg: UdropCredentials): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url as any, init as any);
      return res as unknown as Response;
    } catch {
      // Fallback
    }
  }
  return await window.fetch(url, init);
}

export async function httpFetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const combinedInit = { ...init, signal: controller.signal };
    return await httpFetch(url, combinedInit);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks if a file exists on the uDrop WebDAV remote directly via Rclone.
 * Runs in ~1 second without relying on the slow or unresponsive uDrop API v2.
 */
export async function checkUdropFileExistsViaRclone(
  fileName: string,
  remoteName = 'udrop'
): Promise<boolean> {
  try {
    const res = await invoke<any[]>('list_remote_path', {
      remote: remoteName,
      path: '',
    });
    if (Array.isArray(res)) {
      const cleanTarget = fileName.toLowerCase().trim();
      return res.some((item) => {
        const name = (item.name || item.path || '').toLowerCase().trim();
        return name === cleanTarget;
      });
    }
  } catch (e) {
    console.warn('Could not check uDrop via Rclone:', e);
  }
  return false;
}

/**
 * Exchanges API key1 + key2 for an access_token and account_id via POST /api/v2/authorize.
 * Caches token for 50 minutes. Uses an 8-second timeout to prevent stalling the UI.
 */
export async function getUdropAuthToken(forceRefresh = false): Promise<{ accessToken: string; accountId: string }> {
  const creds = loadUdropConfig();
  const now = Date.now();

  if (
    !forceRefresh &&
    creds.accessToken &&
    creds.accountId &&
    creds.tokenExpiresAt &&
    creds.tokenExpiresAt > now
  ) {
    return { accessToken: creds.accessToken, accountId: creds.accountId };
  }

  const k1 = creds.key1?.trim();
  const k2 = creds.key2?.trim();

  if (!k1 || !k2) {
    throw new Error('uDrop API Key 1 and Key 2 are required for public direct web links.');
  }

  const formData = new URLSearchParams();
  formData.append('key1', k1);
  formData.append('key2', k2);

  const res = await httpFetchWithTimeout(`${API_BASE}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString(),
  }, 8000);

  if (!res.ok) {
    throw new Error(`uDrop /authorize failed with HTTP ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json._status === 'error' || !json.data?.access_token) {
    throw new Error(json.response || 'Failed to authorize with uDrop API. Verify your API keys.');
  }

  const accessToken = json.data.access_token as string;
  const accountId = String(json.data.account_id);
  const tokenExpiresAt = now + 50 * 60 * 1000; // 50 mins

  saveUdropConfig({
    ...creds,
    accessToken,
    accountId,
    tokenExpiresAt,
  });

  return { accessToken, accountId };
}

/**
 * Retrieves account profile info via POST /api/v2/account/info.
 */
export async function getUdropAccountInfo(): Promise<UdropAccountInfo> {
  const { accessToken, accountId } = await getUdropAuthToken();

  const formData = new URLSearchParams();
  formData.append('access_token', accessToken);
  formData.append('account_id', accountId);

  const res = await httpFetchWithTimeout(`${API_BASE}/account/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString(),
  }, 8000);

  if (!res.ok) {
    throw new Error(`uDrop account/info failed (${res.status})`);
  }

  const json = await res.json();
  if (json._status === 'error') {
    throw new Error(json.response || 'Failed querying uDrop account info');
  }

  return json.data as UdropAccountInfo;
}

/**
 * Lists all folders and files in a specific folder (or root if parentFolderId is omitted) via POST /api/v2/folder/listing.
 */
export async function listUdropFolder(parentFolderId?: string): Promise<{ files: UdropApiFile[]; folders: UdropApiFolder[] }> {
  const { accessToken, accountId } = await getUdropAuthToken();

  const formData = new URLSearchParams();
  formData.append('access_token', accessToken);
  formData.append('account_id', accountId);
  if (parentFolderId) {
    formData.append('parent_folder_id', parentFolderId);
  }

  const res = await httpFetchWithTimeout(`${API_BASE}/folder/listing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString(),
  }, 8000);

  if (!res.ok) {
    throw new Error(`uDrop folder/listing failed (${res.status})`);
  }

  const json = await res.json();
  if (json._status === 'error') {
    throw new Error(json.response || 'Failed listing uDrop folder');
  }

  const files: UdropApiFile[] = json.data?.files || [];
  const folders: UdropApiFolder[] = json.data?.folders || [];
  return { files, folders };
}

/**
 * Lists all folders and files in the root folder via POST /api/v2/folder/listing.
 */
export async function listUdropRootFiles(): Promise<UdropApiFile[]> {
  const { files } = await listUdropFolder();
  return files;
}

/**
 * Recursively lists all files across root and all subfolders (up to maxDepth).
 */
export async function listAllUdropFilesRecursive(maxDepth = 3): Promise<UdropApiFile[]> {
  const allFiles: UdropApiFile[] = [];

  async function walk(folderId?: string, depth = 0) {
    if (depth > maxDepth) return;
    try {
      const { files, folders } = await listUdropFolder(folderId);
      allFiles.push(...files);
      for (const f of folders) {
        if (f.id) {
          await walk(f.id, depth + 1);
        }
      }
    } catch (e) {
      console.warn(`Failed scanning uDrop folder ${folderId}:`, e);
    }
  }

  await walk(undefined, 0);
  return allFiles;
}

/**
 * Finds a file on uDrop by name, checking root first and then recursively subfolders.
 * If multiple files match, selects the highest numeric id (most recent upload).
 */
export async function findUdropFileByName(fileName: string): Promise<UdropApiFile | null> {
  const clean = fileName.toLowerCase().trim();

  try {
    const files = await listUdropRootFiles();
    const matching = files.filter((f) => f.filename.toLowerCase().trim() === clean);
    if (matching.length > 0) {
      matching.sort((a, b) => Number(b.id) - Number(a.id));
      return matching[0];
    }
  } catch {}

  try {
    const allFiles = await listAllUdropFilesRecursive(3);
    const matching = allFiles.filter((f) => f.filename.toLowerCase().trim() === clean);
    if (matching.length > 0) {
      matching.sort((a, b) => Number(b.id) - Number(a.id));
      return matching[0];
    }
  } catch {}

  return null;
}

/**
 * Builds the verified, standalone, web-accessible direct stream link.
 * Accessing this URL issues a 302 redirect with a fresh download_token on the fly,
 * serving the video with HTTP 206 Range support.
 */
export function buildUdropDirectLink(shortUrl: string, filename: string): string {
  return `https://www.udrop.com/file/${shortUrl}/${encodeURIComponent(filename)}`;
}

/**
 * Resolves the direct link for a file on uDrop by name.
 * Attempts to retrieve the public direct streaming link via API v2;
 * if API keys are absent or slow, falls back to the direct WebDAV endpoint.
 */
export async function getUdropDirectLinkForFile(fileName: string): Promise<string | null> {
  try {
    const found = await findUdropFileByName(fileName);
    if (found) {
      return buildUdropDirectLink(found.shortUrl, found.filename);
    }
  } catch (err) {
    console.warn('Could not query uDrop API short URL (falling back to WebDAV endpoint):', err);
  }
  return `https://www.udrop.com/webdav/${encodeURIComponent(fileName)}`;
}

/**
 * Mounts uDrop's HTTPS WebDAV server (`https://www.udrop.com/webdav`)
 * as an Rclone remote (`udrop`).
 */
export async function mountUdropWebdavRemote(
  rcloneConfigPath?: string,
  creds?: UdropCredentials
): Promise<{ success: boolean; message: string }> {
  const c = creds || loadUdropConfig();
  const user = c.username?.trim();
  const pass = c.password;
  const remoteName = (c.remoteName || 'udrop').trim();

  if (!user || !pass) {
    throw new Error('uDrop username and password are required to mount the WebDAV remote.');
  }

  try {
    const configPath = rcloneConfigPath || '';
    const updatedRemotes = await invoke<Array<{ name: string; remote_type: string }>>('rclone_create_webdav_remote', {
      configPath,
      remoteName,
      url: 'https://www.udrop.com/webdav',
      vendor: 'other',
      user,
      pass,
    });

    const store = useAppStore.getState();
    if (Array.isArray(updatedRemotes) && updatedRemotes.length > 0) {
      store.setRemotes(updatedRemotes.map((r) => ({ name: r.name, type: r.remote_type })));
    }
    try {
      const freshCfg = await invoke<string>('load_rclone_config_content');
      if (freshCfg) store.setRcloneConfigContent(freshCfg);
    } catch {}

    return { success: true, message: `Successfully mounted uDrop WebDAV as '${remoteName}:'` };
  } catch (err: any) {
    return { success: false, message: `Failed to mount uDrop WebDAV: ${err?.message || err}` };
  }
}
