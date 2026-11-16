/**
 * Poster cache.
 *
 * `useArtwork(url)` returns something renderable immediately — the cached file
 * if we have it, otherwise the remote URL — and quietly downloads a copy for
 * next time. Nothing ever blocks on the cache, so a cold library looks exactly
 * as it does today and a warm one renders without touching the network.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAppStore } from "../store/appStore";

/** Resolved local paths, so repeat renders don't re-query the backend. */
const resolved = new Map<string, string>();
/** URLs known to have no cache entry yet, to avoid hammering the lookup. */
const missing = new Set<string>();

/** Serialise downloads so scrolling a large grid can't open hundreds at once. */
const queue: string[] = [];
let active = 0;
const MAX_CONCURRENT = 4;

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const url = queue.shift()!;
    active++;
    const state = useAppStore.getState();
    const configPath = state.rcloneConfigPath;
    const remoteMirror = state.artworkRemoteMirrorEnabled && state.remotes.length > 0
      ? state.remotes[0].name
      : null;
    const maxCacheMb = state.localStorageCapMb || 200;

    invoke<string | null>("cache_artwork", {
      url,
      remoteMirror,
      configPath: remoteMirror ? configPath : null,
      maxCacheMb,
    })
      .then((path) => {
        if (path) {
          resolved.set(url, convertFileSrc(path));
          missing.delete(url);
        }
      })
      .catch(() => {})
      .finally(() => {
        active--;
        pump();
      });
  }
}

function enqueue(url: string) {
  if (queue.includes(url)) return;
  queue.push(url);
  pump();
}

export function useArtwork(url: string | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>(() =>
    url ? resolved.get(url) ?? url : undefined
  );

  useEffect(() => {
    if (!url) {
      setSrc(undefined);
      return;
    }

    const cached = resolved.get(url);
    if (cached) {
      setSrc(cached);
      return;
    }

    // Show the remote URL right away; swap to the local copy once it exists.
    setSrc(url);

    if (missing.has(url)) {
      enqueue(url);
      return;
    }

    let cancelled = false;
    invoke<string | null>("cached_artwork_path", { url })
      .then((path) => {
        if (cancelled) return;
        if (path) {
          const local = convertFileSrc(path);
          resolved.set(url, local);
          setSrc(local);
        } else {
          missing.add(url);
          enqueue(url);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [url]);

  return src;
}

export async function artworkCacheStats(): Promise<{ files: number; bytes: number }> {
  return invoke("artwork_cache_stats");
}

export async function clearArtworkCache(): Promise<void> {
  resolved.clear();
  missing.clear();
  await invoke("clear_artwork_cache");
}

/**
 * Hook to retrieve or generate a single-frame video screencap thumbnail via ffmpeg.
 */
export function useScreencap(input?: string): string | null {
  const [src, setSrc] = useState<string | null>(() => {
    if (!input) return null;
    return resolved.get(`screencap:${input}`) ?? null;
  });

  useEffect(() => {
    if (!input) {
      setSrc(null);
      return;
    }
    const key = `screencap:${input}`;
    const cached = resolved.get(key);
    if (cached) {
      setSrc(cached);
      return;
    }
    if (missing.has(key)) return;

    let cancelled = false;
    invoke<string>("generate_screencap", { input, offsetSecs: 10 })
      .then((path) => {
        if (cancelled) return;
        if (path) {
          const fileSrc = convertFileSrc(path);
          resolved.set(key, fileSrc);
          setSrc(fileSrc);
        }
      })
      .catch(() => {
        missing.add(key);
      });

    return () => {
      cancelled = true;
    };
  }, [input]);

  return src;
}

