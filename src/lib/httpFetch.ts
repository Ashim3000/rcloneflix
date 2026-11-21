import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url as any, init as any);
      return res as unknown as Response;
    } catch {
      // Fallback to window.fetch
    }
  }
  return await window.fetch(url, init);
}
