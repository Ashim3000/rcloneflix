import { readLogTail } from "./log";
import { useAppStore } from "../store/appStore";

export function redactSensitiveText(input: string): string {
  return input
    // 1. URL query secrets (Streamtape login/key, API keys, tokens, userhash)
    .replace(/([?&](?:login|key|api_key|apikey|token|pass|password|userhash|auth)=)[^&\s"']+/gi, "$1[REDACTED]")
    // 2. GitHub classic & fine-grained PATs
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GH_TOKEN]")
    // 3. Telegram Bot tokens
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,40}\b/g, "[REDACTED_TG_BOT_TOKEN]")
    // 4. HTTP Authorization & ApiKey headers
    .replace(/((?:Authorization|ApiKey|X-Api-Key)\s*[:=]\s*(?:Bearer\s+|Basic\s+)?)[^\s"',}]+/gi, "$1[REDACTED]")
    // 5. Catbox userhash values
    .replace(/(userhash\s*[:=]\s*["']?)[A-Za-z0-9]{16,32}/gi, "$1[REDACTED]")
    // 6. Rclone config secret fields
    .replace(/(^\s*(?:pass|password|token|client_secret|access_key_id|secret_access_key|api_key)\s*=\s*).+$/gim, "$1[REDACTED]")
    // 7. Embedded URL credentials (https://user:pass@host, sftp://user:pass@host)
    .replace(/((?:https?|sftp|ftp|webdav):\/\/[^:\s/]+:)[^@\s/]+(@)/gi, "$1[REDACTED]$2");
}

export async function buildSanitizedDiagnostics(): Promise<string> {
  const s = useAppStore.getState();
  const rawLogs = await readLogTail(100).catch(() => "(failed to read log tail)");
  const sanitizedLogs = redactSensitiveText(rawLogs);

  const summary = {
    version: "1.0.41",
    platform: typeof window !== "undefined" && (window as any).AndroidBridge ? "android" : "desktop",
    remotesCount: s.remotes.length,
    librariesCount: s.libraries.length,
    mediaItemsCount: Object.keys(s.mediaItems).length,
    providersConfigured: {
      tmdb: Boolean(s.tmdbApiKey?.trim()),
      thePornDb: Boolean(s.thePornDbApiKey?.trim()),
      stashBoxCount: (s.stashBoxProviders || []).filter((p) => p.enabled).length,
      catboxEnabled: Boolean(s.catboxConfig?.enabled),
      streamtapeEnabled: Boolean(s.streamtapeConfig?.enabled),
      telegramEnabled: Boolean(s.telegramConfig?.enabled),
      githubWorkersCount: (s.ghaAccounts || []).filter((w) => w.enabled !== false).length,
      kaggleWorkersCount: (s.kaggleAccounts || []).filter((w) => w.enabled !== false).length,
    },
  };

  return [
    "=== RcloneFlix Sanitized Diagnostics ===",
    JSON.stringify(summary, null, 2),
    "",
    "=== Recent Log Tail (Sanitized) ===",
    sanitizedLogs,
  ].join("\n");
}
