/**
 * Fetches album liner notes, personnel credits, labels, and track metadata from
 * the MusicBrainz API, and discovers digital booklet files (PDF / scans) stored
 * alongside the album's tracks in the cloud.
 *
 * MusicBrainz note: producer / engineer / instrument credits are ARTIST
 * RELATIONSHIPS at recording level. They are only returned when the lookup
 * includes `artist-rels` + `recording-level-rels` (and `work-level-rels` for
 * composer/lyricist credits). Without those inc parameters the API returns
 * zero personnel — see V1_0_3 plan Item 15.
 */

import { listRemotePath, type RcloneListItem } from "./tauri";
import packageJson from "../../package.json";

export interface MusicCreditTrack {
  position: number;
  title: string;
  lengthMs?: number;
  artistCredit?: string;
}

export interface AlbumCredit {
  role: string;
  name: string;
}

export interface AlbumLinerNotes {
  albumTitle: string;
  artistName: string;
  releaseDate?: string;
  country?: string;
  label?: string;
  barcode?: string;
  packaging?: string;
  disambiguation?: string;
  tracks: MusicCreditTrack[];
  credits: AlbumCredit[];
  musicBrainzId?: string;
}

const USER_AGENT = `RcloneFlix/${packageJson.version} ( https://github.com/ashim3000/rcloneflix )`;

const linerNotesCache = new Map<string, AlbumLinerNotes>();

// Display priority: production personnel first, writers, then performers.
const ROLE_ORDER = [
  "producer",
  "mix",
  "mastering",
  "recording",
  "engineer",
  "programming",
  "arranger",
  "orchestrator",
  "conductor",
  "composer",
  "lyricist",
  "writer",
  "instrument",
  "vocal",
  "performer",
];

function roleRank(role: string): number {
  const r = role.toLowerCase();
  const idx = ROLE_ORDER.findIndex((o) => r === o || r.startsWith(`${o} `) || r.startsWith(`${o}(`) || r.includes(o));
  return idx === -1 ? ROLE_ORDER.length : idx;
}

/** Collects artist relationships (producer, engineer, instrument, vocal, …) into `out`, deduped. */
function collectArtistRels(relations: any[] | undefined, out: Map<string, AlbumCredit>) {
  if (!Array.isArray(relations)) return;
  for (const rel of relations) {
    // Composer / lyricist credits live on the WORK linked from the recording
    // (returned via work-level-rels as a nested relation list).
    if (rel?.work?.relations) {
      collectArtistRels(rel.work.relations, out);
    }
    const artistName = rel?.artist?.name;
    if (!artistName) continue;
    let role: string = rel.type || "credit";
    if (Array.isArray(rel.attributes) && rel.attributes.length > 0) {
      // e.g. instrument → "instrument (drums (drum set))", vocal → "vocal (lead vocals)"
      role = `${role} (${rel.attributes.join(", ")})`;
    }
    const key = `${role.toLowerCase()}:::${artistName.toLowerCase()}`;
    if (!out.has(key)) out.set(key, { role, name: artistName });
  }
}

export async function fetchAlbumLinerNotes(
  artist: string,
  album: string
): Promise<AlbumLinerNotes | null> {
  const cleanArtist = artist.trim();
  const cleanAlbum = album.trim();
  if (!cleanAlbum) return null;

  const cacheKey = `${cleanArtist.toLowerCase()}:::${cleanAlbum.toLowerCase()}`;
  if (linerNotesCache.has(cacheKey)) {
    return linerNotesCache.get(cacheKey)!;
  }

  try {
    let query = `release:"${encodeURIComponent(cleanAlbum)}"`;
    if (cleanArtist) {
      query += ` AND artist:"${encodeURIComponent(cleanArtist)}"`;
    }

    const searchUrl = `https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json&limit=3`;
    const searchRes = await fetch(searchUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });

    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const releases = searchData.releases;
    if (!releases || releases.length === 0) return null;

    const release = releases[0];
    const releaseId = release.id;

    // recording-level-rels + work-level-rels + artist-rels are REQUIRED for
    // producer/engineer/writer/instrument personnel (plan Item 15 correction).
    const detailUrl = `https://musicbrainz.org/ws/2/release/${releaseId}?inc=artist-credits+labels+recordings+release-groups+recording-level-rels+work-level-rels+artist-rels&fmt=json`;
    const detailRes = await fetch(detailUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });

    if (!detailRes.ok) return null;
    const detailData = await detailRes.json();

    const mediaList = detailData.media || [];
    const tracks: MusicCreditTrack[] = [];
    const creditMap = new Map<string, AlbumCredit>();

    // Release-level relationships (album-wide producer, art direction, …)
    collectArtistRels(detailData.relations, creditMap);

    for (const media of mediaList) {
      for (const track of media.tracks || []) {
        tracks.push({
          position: track.position,
          title: track.title,
          lengthMs: track.length,
          artistCredit: track["artist-credit"]?.map((a: any) => a.name).join(" "),
        });
        // Recording-level relationships carry the per-track personnel.
        collectArtistRels(track.recording?.relations, creditMap);
      }
    }

    const credits = Array.from(creditMap.values())
      .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name))
      .slice(0, 80);

    const labelInfo = detailData["label-info-list"]?.[0]?.label?.name ||
      detailData["label-info"]?.[0]?.label?.name;

    const notes: AlbumLinerNotes = {
      albumTitle: detailData.title || cleanAlbum,
      artistName:
        detailData["artist-credit"]?.map((a: any) => a.name).join(" ") || cleanArtist,
      releaseDate: detailData.date || release.date,
      country: detailData.country || release.country,
      label: labelInfo,
      barcode: detailData.barcode,
      packaging: detailData.packaging,
      disambiguation: detailData.disambiguation || detailData["release-group"]?.disambiguation,
      tracks,
      credits,
      musicBrainzId: releaseId,
    };

    linerNotesCache.set(cacheKey, notes);
    return notes;
  } catch (err) {
    console.warn("[musicCredits] Failed fetching MusicBrainz liner notes:", err);
    return null;
  }
}

// ── Digital booklet discovery ────────────────────────────────────────────────

export interface BookletFile {
  name: string;
  /** Full remote path (remote:path/to/file) */
  remotePath: string;
  /** Path relative to the album folder — usable as `filePath` for start_stream_session */
  relPath: string;
  isPdf: boolean;
  isImage: boolean;
  size: number;
}

const BOOKLET_NAME_RE = /(booklet|liner|digital.?booklet|scans?|artwork|cover|inlay|insert)/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp)$/i;
const PDF_EXT_RE = /\.pdf$/i;
const BOOKLET_DIR_RE = /^(artwork|scans?|booklets?|covers?)$/i;

/**
 * Scans the album's cloud folder (and one level of Artwork/Scans/Booklet
 * subfolders) for digital booklet PDFs and cover/liner scans.
 */
export async function findAlbumBooklet(
  configPath: string,
  albumDirRemotePath: string
): Promise<BookletFile[]> {
  const found: BookletFile[] = [];
  const base = albumDirRemotePath.replace(/\/+$/, "");
  if (!base || !base.includes(":")) return [];

  const classify = (entry: RcloneListItem, relPrefix: string) => {
    const isPdf = PDF_EXT_RE.test(entry.name);
    const isImage = IMAGE_EXT_RE.test(entry.name);
    if (!isPdf && !isImage) return;
    // In the album root only take files NAMED like booklet material (so track
    // embedded-art dumps don't flood the drawer); inside a dedicated
    // Artwork/Scans/Booklet subfolder take every image/PDF.
    if (relPrefix === "" && !BOOKLET_NAME_RE.test(entry.name)) return;
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    found.push({
      name: entry.name,
      remotePath: `${base}/${rel}`,
      relPath: rel,
      isPdf,
      isImage,
      size: entry.size || 0,
    });
  };

  try {
    const rootEntries = await listRemotePath(configPath, base);
    const subdirs: RcloneListItem[] = [];
    for (const e of rootEntries) {
      if (e.is_dir) {
        if (BOOKLET_DIR_RE.test(e.name)) subdirs.push(e);
      } else {
        classify(e, "");
      }
    }
    for (const dir of subdirs.slice(0, 2)) {
      try {
        const subEntries = await listRemotePath(configPath, `${base}/${dir.name}`);
        for (const e of subEntries) {
          if (!e.is_dir) classify(e, dir.name);
        }
      } catch {
        // Best-effort: a missing/unlistable subfolder never fails the scan
      }
    }
  } catch (err) {
    console.warn("[musicCredits] Booklet scan failed:", err);
    return [];
  }

  // PDFs first, then images alphabetically; capped to keep the drawer light.
  return found
    .sort((a, b) => Number(b.isPdf) - Number(a.isPdf) || a.name.localeCompare(b.name))
    .slice(0, 24);
}
