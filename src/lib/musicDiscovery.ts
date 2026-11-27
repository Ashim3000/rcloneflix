import { httpFetch } from "./httpFetch";
import { downloadWebStream } from "./streamResolver";
import type { Library } from "../store/appStore";

export type DiscoverTrack = {
  id: number;
  title: string;
  artist: string;
  album: string;
  coverUrl?: string;
  previewUrl?: string;
};
export type DiscoverAlbum = {
  id: number;
  title: string;
  artist: string;
  coverUrl?: string;
  year?: number;
};
export type DiscoverArtist = { id: number; name: string; pictureUrl?: string };
export type DiscoverSection = {
  seed: string;
  similar: DiscoverArtist[];
  topTracks: DiscoverTrack[];
  albums: DiscoverAlbum[];
};
export type DiscoverFeed = {
  builtAt: number;
  chartAlbums: DiscoverAlbum[];
  chartTracks: DiscoverTrack[];
  sections: DiscoverSection[];
};

const CACHE_KEY = "rcloneflix_music_discover_v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEEZER = "https://api.deezer.com";

/** Lowercase, strip diacritics and everything but letters/digits. */
export function normName(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Make a single path segment safe for rclone/local paths. */
export function safeSegment(s: string): string {
  const cleaned = (s || "")
    .replace(/[\\/:*?"<>|\u0000]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120)
    .trim();
  return cleaned || "Unknown";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dz<T = any>(path: string): Promise<T | null> {
  try {
    const res = await Promise.race([
      httpFetch(`${DEEZER}${path}`),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
    ]);
    if (!res || !res.ok) return null;
    const json: any = await res.json();
    if (json && json.error) return null; // quota / not found
    return json as T;
  } catch {
    return null;
  }
}

const mapAlbum = (a: any, fallbackArtist = ""): DiscoverAlbum => ({
  id: a.id,
  title: a.title,
  artist: a.artist?.name || fallbackArtist,
  coverUrl: a.cover_medium || a.cover_big || a.cover,
  year: a.release_date ? parseInt(String(a.release_date).slice(0, 4), 10) || undefined : undefined,
});
const mapTrack = (t: any, fallbackArtist = ""): DiscoverTrack => ({
  id: t.id,
  title: t.title_short || t.title,
  artist: t.artist?.name || fallbackArtist,
  album: t.album?.title || "Singles",
  coverUrl: t.album?.cover_medium || t.album?.cover,
  previewUrl: t.preview || undefined,
});

/** Pick up to `n` seed artists: random among the 12 biggest in the library. */
export function pickSeedArtists(
  libraryArtists: { name: string; trackCount: number }[],
  n = 3,
  rng: () => number = Math.random
): string[] {
  const pool = libraryArtists
    .filter((a) => a.name && !/^(unknown artist|various artists|va)$/i.test(a.name.trim()))
    .sort((a, b) => b.trackCount - a.trackCount)
    .slice(0, 12)
    .map((a) => a.name);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export function readCachedFeed(): DiscoverFeed | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const feed = JSON.parse(raw) as DiscoverFeed;
    if (!feed || Date.now() - feed.builtAt > CACHE_TTL_MS) return null;
    return feed;
  } catch {
    return null;
  }
}

/**
 * Build the discover feed. Sequential on purpose (Deezer allows ~50 req / 5 s;
 * a full build is ~14 requests). Anything that fails is simply omitted.
 * `libraryArtists` / `libraryAlbumKeys` are used to hide what the user already owns.
 */
export async function buildDiscoverFeed(
  libraryArtists: { name: string; trackCount: number }[],
  libraryAlbumKeys: Set<string> // normName(artist + album)
): Promise<DiscoverFeed> {
  const ownedArtists = new Set(libraryArtists.map((a) => normName(a.name)));

  const chartAlbumsRaw = await dz<{ data: any[] }>("/chart/0/albums?limit=24");
  const chartTracksRaw = await dz<{ data: any[] }>("/chart/0/tracks?limit=24");

  const chartAlbums = (chartAlbumsRaw?.data || [])
    .map((a) => mapAlbum(a))
    .filter((a) => !libraryAlbumKeys.has(normName(a.artist + a.title)))
    .slice(0, 16);
  const chartTracks = (chartTracksRaw?.data || [])
    .map((t) => mapTrack(t))
    .filter((t) => t.previewUrl)
    .slice(0, 16);

  const sections: DiscoverSection[] = [];
  for (const seed of pickSeedArtists(libraryArtists, 3)) {
    const found = await dz<{ data: any[] }>(`/search/artist?q=${encodeURIComponent(seed)}&limit=1`);
    const id = found?.data?.[0]?.id;
    if (!id) continue;
    await sleep(120);
    const related = await dz<{ data: any[] }>(`/artist/${id}/related?limit=12`);
    const top = await dz<{ data: any[] }>(`/artist/${id}/top?limit=8`);
    const albums = await dz<{ data: any[] }>(`/artist/${id}/albums?limit=24`);

    const similar = (related?.data || [])
      .filter((a) => !ownedArtists.has(normName(a.name)))
      .slice(0, 8)
      .map((a): DiscoverArtist => ({ id: a.id, name: a.name, pictureUrl: a.picture_medium || a.picture }));
    const topTracks = (top?.data || [])
      .map((t) => mapTrack(t, seed))
      .filter((t) => t.previewUrl)
      .slice(0, 5);
    const seen = new Set<string>();
    const albumList = (albums?.data || [])
      .map((a) => mapAlbum(a, seed))
      .filter((a) => {
        const k = normName(a.artist + a.title);
        if (seen.has(k) || libraryAlbumKeys.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 8);

    if (similar.length || topTracks.length || albumList.length) {
      sections.push({ seed, similar, topTracks, albums: albumList });
    }
    await sleep(120);
  }

  const feed: DiscoverFeed = { builtAt: Date.now(), chartAlbums, chartTracks, sections };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(feed));
  } catch {
    /* quota — ignore */
  }
  return feed;
}

/** Query string for the Usenet search modal (no quotes/colons — indexers choke on them). */
export function usenetQueryFor(artist: string, album?: string): string {
  return `${artist} ${album && album !== "Singles" ? album : ""}`
    .replace(/["':]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type GrabTarget = { remoteDir: string; filename: string };

/** Throws if the library can't be written to. */
export function buildGrabTarget(library: Library, artist: string, album: string, title: string): GrabTarget {
  if (library.isSharedPass) throw new Error("Shared music libraries are read-only.");
  const base = (library.remotePaths?.[0] || "").trim();
  if (!base) throw new Error("This music library has no destination path.");
  const colon = base.indexOf(":");
  if (colon > 1 && base.slice(0, colon).toLowerCase().startsWith("shared_")) {
    throw new Error("Shared remotes are read-only.");
  }
  const root = base.replace(/[\\/]+$/, "");
  return {
    remoteDir: `${root}/${safeSegment(artist)}/${safeSegment(album || "Singles")}`,
    filename: `${safeSegment(title)}.mp3`,
  };
}

/** Best-match YouTube grab → mp3 → uploaded into the music library. Returns the download id. */
export async function grabTrackToLibrary(
  track: Pick<DiscoverTrack, "title" | "artist" | "album">,
  library: Library,
  rcloneConfigPath: string
): Promise<string> {
  const target = buildGrabTarget(library, track.artist, track.album, track.title);
  const downloadId = `music-grab-${Date.now()}`;
  await downloadWebStream({
    download_id: downloadId,
    stream_url: `ytsearch1:${track.artist} - ${track.title} audio`,
    filename: target.filename,
    remote_upload_path: target.remoteDir,
    config_path: rcloneConfigPath,
  });
  return downloadId;
}
