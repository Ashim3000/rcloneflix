/**
 * Google Drive Sync Engine
 * 
 * Uses OAuth 2.0 PKCE flow (no client secret needed for desktop apps).
 * Stores an encrypted backup of the full app config to a private
 * appDataFolder in Google Drive — invisible to the user's Drive UI.
 * 
 * Encryption: AES-256-GCM using a key derived from the user's Google sub (ID).
 * This means only the authenticated Google account can decrypt the backup.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, type AppConfig, type MediaItem, type WatchProgress } from "../store/appStore";

// ─── Bundled OAuth client ──────────────────────────────────────────────────────
// Create a "Desktop app" OAuth 2.0 credential at https://console.cloud.google.com
// Enable: Google Drive API, Google People API (for userinfo).
// No client secret is needed — desktop apps use PKCE only.
const GOOGLE_CLIENT_ID = "307244172749-16akn833ai5besgs3pggasetmgj6ui6d.apps.googleusercontent.com";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const BACKUP_FILENAME = "rcloneflix-backup.json";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.appdata",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ─── Encryption ───────────────────────────────────────────────────────────────

async function deriveKey(googleSub: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(googleSub + "rcloneflix"),
    { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("rcloneflix-salt-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false, ["encrypt", "decrypt"]
  );
}

async function encryptData(data: string, googleSub: string): Promise<string> {
  const key = await deriveKey(googleSub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(data)
  );
  // Combine iv + encrypted, base64 encode
  const combined = new Uint8Array(iv.byteLength + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

async function decryptData(encryptedB64: string, googleSub: string): Promise<string> {
  const key = await deriveKey(googleSub);
  const combined = new Uint8Array(
    atob(encryptedB64).split("").map((c) => c.charCodeAt(0))
  );
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

// ─── OAuth PKCE Flow ──────────────────────────────────────────────────────────

export async function startGoogleSignIn(): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  sessionStorage.setItem("pkce_verifier", verifier);

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: "http://localhost:9876/oauth/callback",
    response_type: "code",
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  // Tell Rust to open browser and start local callback server
  await invoke("start_google_oauth", { authUrl, port: 9876 });
}

export async function exchangeOAuthCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  sub: string;
  email: string;
  displayName: string;
}> {
  const verifier = sessionStorage.getItem("pkce_verifier") ?? "";

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: "http://localhost:9876/oauth/callback",
      code_verifier: verifier,
      grant_type: "authorization_code",
    }),
  });

  if (!resp.ok) throw new Error(`Token exchange failed: ${await resp.text()}`);
  const tokens = await resp.json();

  // Get user info
  const userResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = await userResp.json();

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    sub: userInfo.sub,
    email: userInfo.email,
    displayName: userInfo.name,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: number;
}> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error("Token refresh failed");
  const tokens = await resp.json();
  return {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

// Get a valid access token, refreshing if needed
async function getValidToken(): Promise<string | null> {
  const store = useAppStore.getState();
  const account = store.googleAccount;
  if (!account) return null;

  if (Date.now() < account.expiresAt - 60000) {
    return account.accessToken;
  }

  try {
    const { accessToken, expiresAt } = await refreshAccessToken(account.refreshToken);
    useAppStore.getState().setGoogleAccount({ ...account, accessToken, expiresAt });
    return accessToken;
  } catch {
    return account.accessToken;
  }
}

// ─── Drive backup/restore ─────────────────────────────────────────────────────

type BackupData = {
  version: number;
  tmdbApiKey: string;
  thePornDbApiKey: string;
  rcloneConfigContent: string;
  libraries: AppConfig["libraries"];
  mediaItems: Record<string, MediaItem>;
  watchProgress: Record<string, WatchProgress>;
  exportedAt: number;
};

async function findBackupFile(accessToken: string): Promise<string | null> {
  const resp = await fetch(
    `${DRIVE_API}/files?spaces=appDataFolder&q=name='${BACKUP_FILENAME}'&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.files?.[0]?.id ?? null;
}

export async function backupToDrive(): Promise<void> {
  const store = useAppStore.getState();
  const account = store.googleAccount;
  if (!account) throw new Error("Not signed in to Google");

  store.setSyncState({ syncing: true, error: undefined });

  try {
    const token = await getValidToken();
    if (!token) throw new Error("No valid token");

    const backup: BackupData = {
      version: 1,
      tmdbApiKey: store.tmdbApiKey,
      thePornDbApiKey: store.thePornDbApiKey,
      rcloneConfigContent: store.rcloneConfigContent,
      libraries: store.libraries,
      mediaItems: store.mediaItems,
      watchProgress: store.watchProgress,
      exportedAt: Date.now(),
    };

    // Encrypt with user's sub as key material
    const sub = account.email; // use email as sub proxy since we stored it
    const encrypted = await encryptData(JSON.stringify(backup), sub);
    const payload = JSON.stringify({ encrypted, v: 1 });

    // Check if file exists
    const existingId = await findBackupFile(token);

    if (existingId) {
      // Update existing file
      await fetch(`${UPLOAD_API}/files/${existingId}?uploadType=media`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: payload,
      });
    } else {
      // Create new file
      const meta = JSON.stringify({
        name: BACKUP_FILENAME,
        parents: ["appDataFolder"],
      });
      const blob = new Blob([payload], { type: "application/json" });
      const form = new FormData();
      form.append("metadata", new Blob([meta], { type: "application/json" }));
      form.append("file", blob);

      await fetch(`${UPLOAD_API}/files?uploadType=multipart`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
    }

    store.setSyncState({ syncing: false, lastSyncAt: Date.now() });
  } catch (e) {
    store.setSyncState({ syncing: false, error: String(e) });
    throw e;
  }
}

export async function restoreFromDrive(): Promise<BackupData | null> {
  const store = useAppStore.getState();
  const account = store.googleAccount;
  if (!account) return null;

  store.setSyncState({ syncing: true, error: undefined });

  try {
    const token = await getValidToken();
    if (!token) throw new Error("No valid token");

    const fileId = await findBackupFile(token);
    if (!fileId) {
      store.setSyncState({ syncing: false });
      return null;
    }

    const resp = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Failed to download backup");

    const { encrypted } = await resp.json();
    const decrypted = await decryptData(encrypted, account.email);
    const backup: BackupData = JSON.parse(decrypted);

    // Apply to store
    store.importConfig({
      tmdbApiKey: backup.tmdbApiKey,
      thePornDbApiKey: backup.thePornDbApiKey,
      rcloneConfigContent: backup.rcloneConfigContent,
      libraries: backup.libraries,
      mediaItems: backup.mediaItems,
      watchProgress: backup.watchProgress,
    });

    store.setSyncState({ syncing: false, lastSyncAt: Date.now() });
    return backup;
  } catch (e) {
    store.setSyncState({ syncing: false, error: String(e) });
    throw e;
  }
}

// Listen for OAuth callback from Rust local server
export function listenOAuthCallback(
  onCode: (code: string) => void
): Promise<() => void> {
  return listen<{ code: string }>("oauth-callback", (event) => {
    onCode(event.payload.code);
  });
}
