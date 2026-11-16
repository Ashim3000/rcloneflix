/**
 * Secret storage.
 *
 * API keys, the Google account tokens, and the rclone config body live in the
 * Tauri store (a file under the app's data dir) rather than localStorage.
 * localStorage is readable by anything running in the webview and is easy to
 * exfiltrate; the store at least keeps secrets out of the web origin.
 *
 * The zustand store remains the single source of truth at runtime — these
 * helpers only load secrets in at startup and write them back on change.
 */

import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type GoogleAccount } from "../store/appStore";
import { legacyState } from "./legacyStore";

type ApiKeys = { tmdb: string; theporndb: string };

let loaded = false;

/**
 * Rescue secrets written by v0.2.x, which persisted them into localStorage.
 * v0.3.0 stopped persisting them there, so without this an upgrade silently
 * loses the user's API keys and Google session.
 */
function readLegacyLocalStorageSecrets(): {
  tmdb?: string;
  theporndb?: string;
  account?: GoogleAccount;
  config?: string;
} {
  try {
    const state = legacyState() ?? {};
    return {
      tmdb: state.tmdbApiKey || undefined,
      theporndb: state.thePornDbApiKey || undefined,
      account: state.googleAccount || undefined,
      config: state.rcloneConfigContent || undefined,
    };
  } catch {
    return {};
  }
}

/** Read secrets from the Tauri store into the app store. Call once at startup. */
export async function loadSecrets(): Promise<void> {
  const store = useAppStore.getState();
  const legacy = readLegacyLocalStorageSecrets();

  try {
    const keys = await invoke<ApiKeys>("load_api_keys");
    const tmdb = keys.tmdb || legacy.tmdb;
    const theporndb = keys.theporndb || legacy.theporndb;
    if (tmdb) store.setTmdbApiKey(tmdb);
    if (theporndb) store.setThePornDbApiKey(theporndb);
    // Write the rescued values straight back so the migration happens once.
    if ((!keys.tmdb && tmdb) || (!keys.theporndb && theporndb)) {
      await persistApiKeys({ tmdb: tmdb ?? "", theporndb: theporndb ?? "" }).catch(() => {});
    }
  } catch {
    if (legacy.tmdb) store.setTmdbApiKey(legacy.tmdb);
    if (legacy.theporndb) store.setThePornDbApiKey(legacy.theporndb);
  }

  try {
    const tokens = await invoke<{
      access_token: string;
      refresh_token: string;
      expires_at: number;
      email: string;
      display_name: string;
    } | null>("load_google_tokens");
    if (tokens?.refresh_token) {
      store.setGoogleAccount({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_at,
        email: tokens.email,
        displayName: tokens.display_name,
      });
    } else if (legacy.account?.refreshToken) {
      store.setGoogleAccount(legacy.account);
      await persistGoogleAccount(legacy.account).catch(() => {});
    }
  } catch {
    if (legacy.account?.refreshToken) store.setGoogleAccount(legacy.account);
  }

  try {
    const content = (await invoke<string>("load_rclone_config_content")) || legacy.config;
    if (content && !content.startsWith("\0")) {
      store.setRcloneConfigContent(content);
    }
  } catch {
    if (legacy.config) store.setRcloneConfigContent(legacy.config);
  }

  try {
    const parsed = await invoke<Array<{ name: string; remote_type: string }>>(
      "parse_rclone_config",
      { configPath: store.rcloneConfigPath || "" }
    );
    if (Array.isArray(parsed) && parsed.length > 0) {
      store.setRemotes(parsed.map((r) => ({ name: r.name, type: r.remote_type })));
    }
  } catch {
    // Ignore parse errors during early boot
  }

  try {
    const kaggle = await invoke<{ username: string; key: string }>("load_kaggle_credentials");
    if (kaggle?.username) store.setKaggleUsername(kaggle.username);
    if (kaggle?.key) store.setKaggleKey(kaggle.key);
  } catch {}

  try {
    const rcloneSettings = await invoke<import("../store/appStore").RcloneSettings>("load_rclone_settings");
    if (rcloneSettings) {
      store.setRcloneSettings(rcloneSettings);
    }
  } catch {}

  loaded = true;
}

export async function persistApiKeys(keys: ApiKeys): Promise<void> {
  await invoke("save_api_keys", { keys });
}

export async function persistKaggleCredentials(credentials: { username: string; key: string }): Promise<void> {
  await invoke("save_kaggle_credentials", { credentials });
}

export async function persistRcloneSettings(settings: import("../store/appStore").RcloneSettings): Promise<void> {
  await invoke("save_rclone_settings", { settings });
}

export async function persistGoogleAccount(account: GoogleAccount | null): Promise<void> {
  if (!account) {
    await invoke("clear_google_tokens");
    return;
  }
  await invoke("save_google_tokens", {
    tokens: {
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
      expires_at: account.expiresAt,
      email: account.email,
      display_name: account.displayName,
    },
  });
}

export async function persistRcloneConfigContent(content: string): Promise<void> {
  await invoke("save_rclone_config_content", { content });
}

/**
 * Mirror in-memory secret changes back to the Tauri store. Subscribing rather
 * than writing at each call site means no future caller can forget to persist.
 */
export function startSecretSync(): () => void {
  let prev = {
    tmdb: useAppStore.getState().tmdbApiKey,
    theporndb: useAppStore.getState().thePornDbApiKey,
    account: useAppStore.getState().googleAccount,
    config: useAppStore.getState().rcloneConfigContent,
    kaggleUser: useAppStore.getState().kaggleUsername,
    kaggleKey: useAppStore.getState().kaggleKey,
    rcloneSettings: JSON.stringify(useAppStore.getState().rcloneSettings),
  };

  return useAppStore.subscribe((s) => {
    if (!loaded) return; // don't write back before the initial load finishes

    if (s.tmdbApiKey !== prev.tmdb || s.thePornDbApiKey !== prev.theporndb) {
      prev = { ...prev, tmdb: s.tmdbApiKey, theporndb: s.thePornDbApiKey };
      void persistApiKeys({ tmdb: s.tmdbApiKey, theporndb: s.thePornDbApiKey }).catch(() => {});
    }

    if (s.googleAccount !== prev.account) {
      prev = { ...prev, account: s.googleAccount };
      void persistGoogleAccount(s.googleAccount).catch(() => {});
    }

    if (s.rcloneConfigContent !== prev.config) {
      prev = { ...prev, config: s.rcloneConfigContent };
      void persistRcloneConfigContent(s.rcloneConfigContent).catch(() => {});
    }

    if (s.kaggleUsername !== prev.kaggleUser || s.kaggleKey !== prev.kaggleKey) {
      prev = { ...prev, kaggleUser: s.kaggleUsername, kaggleKey: s.kaggleKey };
      void persistKaggleCredentials({ username: s.kaggleUsername, key: s.kaggleKey }).catch(() => {});
    }

    const currentRcloneJson = JSON.stringify(s.rcloneSettings);
    if (currentRcloneJson !== prev.rcloneSettings) {
      prev = { ...prev, rcloneSettings: currentRcloneJson };
      if (s.rcloneSettings) {
        void persistRcloneSettings(s.rcloneSettings).catch(() => {});
      }
    }
  });
}

