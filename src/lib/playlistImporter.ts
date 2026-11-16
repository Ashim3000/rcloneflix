import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore, type MediaItem } from "../store/appStore";

export interface ImportedTrackCandidate {
  title: string;
  artist: string;
  matchedItem?: MediaItem;
}

async function httpFetchText(url: string): Promise<string> {
  if (typeof window !== "undefined" && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url);
      return await res.text();
    } catch {
      // Fallback to window.fetch
    }
  }
  const r = await fetch(url);
  return await r.text();
}

/**
 * Resolves a public Spotify or Apple Music playlist URL into track candidates
 * and matches them against the user's local/cloud RcloneFlix music library.
 */
export async function importExternalMusicPlaylist(
  playlistUrl: string
): Promise<{ name: string; tracks: ImportedTrackCandidate[] }> {
  let targetUrl = playlistUrl.trim();
  const spotifyMatch = targetUrl.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/);
  if (spotifyMatch) {
    targetUrl = `https://open.spotify.com/embed/playlist/${spotifyMatch[1]}`;
  }

  const html = await httpFetchText(targetUrl).catch(() => "");

  const tracks: { title: string; artist: string }[] = [];
  let playlistName = "Imported Playlist";

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    playlistName = titleMatch[1].replace(/\s*\|\s*Spotify.*$/i, "").trim();
  }

  // Parse Spotify Embed __NEXT_DATA__ trackList if present
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const json = JSON.parse(nextDataMatch[1]);
      const entity = json?.props?.pageProps?.state?.data?.entity;
      if (entity?.name) playlistName = entity.name;
      const trackList = entity?.trackList || [];
      for (const t of trackList) {
        if (t.title) {
          tracks.push({ title: String(t.title), artist: String(t.subtitle || "") });
        }
      }
    } catch {
      // Fallback to meta tag scraping
    }
  }

  const allItems = Object.values(useAppStore.getState().mediaItems).filter(
    (m) => m.libraryType === "music"
  );

  const reconciled: ImportedTrackCandidate[] = tracks.map((t) => {
    const normTitle = t.title.toLowerCase().trim();
    const normArtist = t.artist.toLowerCase().trim();
    const matchedItem = allItems.find((item) => {
      const itemTitle = item.title.toLowerCase();
      const itemArtist = (item.artist || "").toLowerCase();
      return (
        itemTitle === normTitle &&
        (!normArtist || !itemArtist || itemArtist.includes(normArtist) || normArtist.includes(itemArtist))
      );
    });
    return { ...t, matchedItem };
  });

  return { name: playlistName, tracks: reconciled };
}
