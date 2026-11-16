import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore, type MediaItem } from "../store/appStore";

export type StorytellerBook = {
  id: string | number;
  title: string;
  author?: string;
  hasAudio: boolean;
  hasEbook: boolean;
  isSynced: boolean;
  epubUrl?: string;
  audioUrl?: string;
  coverUrl?: string;
};

export type StorytellerConfig = {
  serverUrl: string;
  apiKey?: string;
  autoSync?: boolean;
};

async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url as any, init as any);
      return res as unknown as Response;
    } catch {
      // Fallback
    }
  }
  return await window.fetch(url, init);
}

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Validates connection to a self-hosted Storyteller instance.
 */
export async function testStorytellerConnection(
  serverUrl: string,
  apiKey?: string
): Promise<{ ok: boolean; message: string; bookCount?: number }> {
  const base = normalizeUrl(serverUrl);
  if (!base) {
    return { ok: false, message: "Please specify a valid Storyteller server URL (e.g. http://192.168.1.10:8001)." };
  }

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey?.trim()) {
      headers["Authorization"] = `Bearer ${apiKey.trim()}`;
    }

    // Try modern Storyteller REST API
    const res = await httpFetch(`${base}/api/books`, { headers });
    if (res.ok) {
      const data = await res.json();
      const count = Array.isArray(data) ? data.length : Array.isArray(data?.books) ? data.books.length : 0;
      return {
        ok: true,
        message: `Connected to Storyteller successfully! Found ${count} books in library.`,
        bookCount: count,
      };
    }

    // Try OPDS feed fallback
    const opdsRes = await httpFetch(`${base}/opds/v1.2/catalog`, { headers });
    if (opdsRes.ok) {
      return {
        ok: true,
        message: "Connected to Storyteller OPDS catalog successfully!",
      };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "Storyteller authentication failed. Please check your API key." };
    }

    return { ok: false, message: `Storyteller returned HTTP ${res.status}.` };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Failed to reach Storyteller server." };
  }
}

/**
 * Fetches all synced books from Storyteller.
 */
export async function fetchStorytellerBooks(
  serverUrl: string,
  apiKey?: string
): Promise<StorytellerBook[]> {
  const base = normalizeUrl(serverUrl);
  if (!base) return [];

  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey?.trim()) {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  }

  try {
    const res = await httpFetch(`${base}/api/books`, { headers });
    if (!res.ok) return [];

    const json = await res.json();
    const rawBooks: any[] = Array.isArray(json) ? json : json?.books || [];

    return rawBooks.map((b) => {
      const id = b.id || b.uuid || String(Math.random());
      const author = Array.isArray(b.authors)
        ? b.authors.map((a: any) => a.name || a).join(", ")
        : b.author || "";
      const isSynced = Boolean(b.synced || b.is_synced || b.aligned);
      const epubPath = b.synced_epub_path || b.epub_path || `/api/books/${id}/synced.epub`;
      const audioPath = b.audio_path || `/api/books/${id}/audio`;
      const coverPath = b.cover_path || `/api/books/${id}/cover`;

      return {
        id,
        title: b.title || "Untitled Book",
        author,
        hasAudio: Boolean(b.has_audio || b.audio_path),
        hasEbook: Boolean(b.has_ebook || b.epub_path),
        isSynced,
        epubUrl: `${base}${epubPath.startsWith("/") ? "" : "/"}${epubPath}`,
        audioUrl: `${base}${audioPath.startsWith("/") ? "" : "/"}${audioPath}`,
        coverUrl: `${base}${coverPath.startsWith("/") ? "" : "/"}${coverPath}`,
      };
    });
  } catch (err) {
    console.warn("Failed to fetch Storyteller books:", err);
    return [];
  }
}
