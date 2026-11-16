import { invoke } from '@tauri-apps/api/core';

export interface ServerlessTelegramConfig {
  workerBaseUrl: string;
  webdavUser: string;
  webdavPass: string;
  masterKeyHex: string;
  defaultChatId: string;
  apiId?: number;
  apiHash?: string;
  botToken?: string;
}

const STORAGE_KEY = 'rcloneflix_serverless_tg_config';

export function loadServerlessTelegramConfig(): ServerlessTelegramConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {
    workerBaseUrl: '',
    webdavUser: 'rcloneflix',
    webdavPass: '',
    masterKeyHex: '',
    defaultChatId: '',
  };
}

export function saveServerlessTelegramConfig(cfg: ServerlessTelegramConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export async function getLocalTelegramBaseUrl(): Promise<string> {
  try {
    const status = await invoke<{ webdav_url: string }>('telegram_get_status');
    if (status?.webdav_url) {
      return status.webdav_url.replace(/\/webdav\/?$/, '');
    }
  } catch {
    // fallback
  }
  const proxyUrl = await invoke<string>('get_stream_proxy_url');
  return proxyUrl.replace(/\/+$/, '');
}

/**
 * Mounts the embedded Rust Telegram WebDAV bridge as an rclone remote (`tg-serverless` or `telegram`).
 */
export async function mountServerlessTelegramWebdavRemote(
  rcloneConfigPath: string,
  remoteName: string,
  cfg: ServerlessTelegramConfig
): Promise<any[]> {
  await invoke('telegram_configure_and_connect', {
    apiId: cfg.apiId || null,
    apiHash: cfg.apiHash || null,
    botToken: cfg.botToken || null,
    defaultChatId: cfg.defaultChatId || null,
  });
  const baseUrl = await getLocalTelegramBaseUrl();
  const webdavUrl = `${baseUrl}/webdav`;

  return await invoke('rclone_create_webdav_remote', {
    configPath: rcloneConfigPath,
    remoteName: remoteName.trim().replace(/:$/, ''),
    url: webdavUrl,
    vendor: 'other',
    user: null,
    pass: null,
  });
}

/**
 * Syncs channel messages and pinned manifest via the native Rust MTProto engine.
 */
export async function rebuildServerlessTelegramIndex(
  cfg: ServerlessTelegramConfig
): Promise<{ entriesCount: number }> {
  const entries = await invoke<any[]>('telegram_sync_index', {
    chatId: cfg.defaultChatId || null,
  });
  return { entriesCount: Array.isArray(entries) ? entries.length : 0 };
}

/**
 * Generates a direct HTTP 206 streaming URL served by the embedded Rust MTProto proxy
 * (or public Tailscale Funnel URL if enabled).
 */
export async function generateTelegramDirectStreamUrl(
  _cfg: ServerlessTelegramConfig,
  params: {
    chatId: string;
    msgId: number;
    filename: string;
    size?: number;
    mimeType?: string;
    ttlHours?: number;
  }
): Promise<string> {
  const baseUrl = await getLocalTelegramBaseUrl();
  const encodedName = encodeURIComponent(params.filename);
  if (params.chatId) {
    return `${baseUrl}/tg-stream/${encodeURIComponent(params.chatId)}/${params.msgId}/${encodedName}`;
  }
  return `${baseUrl}/tg-stream/${params.msgId}/${encodedName}`;
}
