/**
 * Snapshot of the pre-0.4 localStorage blob, captured before anything else runs.
 *
 * This module must be imported first (see main.tsx) and must import nothing
 * itself. Creating the zustand store rehydrates from localStorage and can write
 * straight back through the new `partialize`, which no longer includes
 * mediaItems/watchProgress — so by the time a migration running in a React
 * effect reads localStorage, the library it was supposed to rescue may already
 * have been stripped out.
 */

const KEY = "rcloneflix-config";

function read(): unknown {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const snapshot = read();

export function legacyState(): Record<string, any> | null {
  const s = (snapshot as any)?.state;
  return s && typeof s === "object" ? s : null;
}

/** Raw size of the captured blob, for diagnostics. */
export function legacyBlobSize(): number {
  try {
    return localStorage.getItem(KEY)?.length ?? 0;
  } catch {
    return 0;
  }
}
