export type LyricLine = {
  time: number; // seconds
  text: string;
};

export type LyricsResult = {
  synced: LyricLine[];
  plain: string | null;
  instrumental: boolean;
};

const lyricsCache = new Map<string, LyricsResult | null>();

export function parseLrc(lrcText: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const timeRegex = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const rawLine of lrcText.split(/\r?\n/)) {
    const matches = Array.from(rawLine.matchAll(timeRegex));
    if (matches.length === 0) continue;
    const text = rawLine.replace(timeRegex, "").trim();
    for (const m of matches) {
      const mins = parseInt(m[1], 10);
      const secs = parseInt(m[2], 10);
      const fracStr = m[3] || "0";
      const frac = parseInt(fracStr.padEnd(3, "0").slice(0, 3), 10) / 1000;
      const time = mins * 60 + secs + frac;
      lines.push({ time, text: text || "♪" });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

export async function fetchTrackLyrics(params: {
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
}): Promise<LyricsResult | null> {
  const cleanTitle = (params.title || "").trim();
  const cleanArtist = (params.artist || "").trim();
  const cleanAlbum = (params.album || "").trim();
  if (!cleanTitle) return null;

  const cacheKey = `${cleanArtist.toLowerCase()}:::${cleanAlbum.toLowerCase()}:::${cleanTitle.toLowerCase()}`;
  if (lyricsCache.has(cacheKey)) {
    return lyricsCache.get(cacheKey) ?? null;
  }

  try {
    // 1. Try exact match if artist is known
    if (cleanArtist && cleanArtist.toLowerCase() !== "unknown artist") {
      const qs = new URLSearchParams({
        track_name: cleanTitle,
        artist_name: cleanArtist,
      });
      if (cleanAlbum && cleanAlbum.toLowerCase() !== "unknown album") {
        qs.set("album_name", cleanAlbum);
      }
      if (params.duration && params.duration > 0) {
        qs.set("duration", String(Math.round(params.duration)));
      }

      const res = await fetch(`https://lrclib.net/api/get?${qs.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const parsed: LyricsResult = {
          synced: data.syncedLyrics ? parseLrc(String(data.syncedLyrics)) : [],
          plain: data.plainLyrics ? String(data.plainLyrics) : null,
          instrumental: Boolean(data.instrumental),
        };
        if (parsed.synced.length > 0 || parsed.plain || parsed.instrumental) {
          lyricsCache.set(cacheKey, parsed);
          return parsed;
        }
      }
    }

    // 2. Fallback to fuzzy search
    const searchQs = new URLSearchParams({
      q: cleanArtist && cleanArtist.toLowerCase() !== "unknown artist"
        ? `${cleanArtist} ${cleanTitle}`
        : cleanTitle,
    });
    const sRes = await fetch(`https://lrclib.net/api/search?${searchQs.toString()}`);
    if (sRes.ok) {
      const list = await sRes.json();
      if (Array.isArray(list) && list.length > 0) {
        const best = list.find((item: any) => item.syncedLyrics) || list[0];
        const parsed: LyricsResult = {
          synced: best.syncedLyrics ? parseLrc(String(best.syncedLyrics)) : [],
          plain: best.plainLyrics ? String(best.plainLyrics) : null,
          instrumental: Boolean(best.instrumental),
        };
        lyricsCache.set(cacheKey, parsed);
        return parsed;
      }
    }
  } catch (e) {
    console.warn("LRCLIB lyrics lookup failed:", e);
  }

  lyricsCache.set(cacheKey, null);
  return null;
}
