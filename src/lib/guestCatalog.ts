import { encryptBytes, decryptBytes } from "./crypto";
import type { LibraryType, MediaItem, WeeklyRecommendation } from "../store/appStore";

export const CATALOG_VERSION = 1;
/** Refuse to publish/read anything larger (rclone_upload_bytes/read_bytes marshal bytes as JSON number arrays; 15 MB gzipped ≈ 120+ MB raw JSON). */
export const MAX_CATALOG_BYTES = 15 * 1024 * 1024;

export type GuestCatalogLibraryMeta = { id: string; name: string; type: LibraryType };

/** Plain body (what gets hashed/compressed/encrypted). ORIGINAL admin ids, library ids and remote names. */
export type GuestCatalogBody = {
  version: 1;
  passId: string;
  libraries: GuestCatalogLibraryMeta[];
  items: MediaItem[];
  weeklyRecommendations?: Record<string, WeeklyRecommendation[]>; // keyed by ORIGINAL library id
};

export type CatalogManifest = {
  v: 1;
  passId: string;
  updatedAt: number;
  hash: string; // sha256 hex of the plaintext body bytes
  itemCount: number;
};

// ───────────── hashing / canonical JSON ─────────────

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateCatalogKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
  return btoa(bin);
}

// ───────────── gzip (optional) + encryption envelope ─────────────

async function pipeBytes(data: Uint8Array, transform: any): Promise<Uint8Array> {
  const buf = await new Response(new Blob([data as unknown as BlobPart]).stream().pipeThrough(transform)).arrayBuffer();
  return new Uint8Array(buf);
}

async function gzipMaybe(data: Uint8Array): Promise<{ bytes: Uint8Array; gz: boolean }> {
  if (typeof CompressionStream === "undefined") return { bytes: data, gz: false };
  try {
    return { bytes: await pipeBytes(data, new CompressionStream("gzip")), gz: true };
  } catch {
    return { bytes: data, gz: false };
  }
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This device cannot decompress the catalog (DecompressionStream unavailable).");
  }
  return pipeBytes(data, new DecompressionStream("gzip"));
}

export async function packCatalog(bodyBytes: Uint8Array, catalogKey: string): Promise<Uint8Array> {
  const { bytes, gz } = await gzipMaybe(bodyBytes);
  const framed = new Uint8Array(bytes.length + 1);
  framed[0] = gz ? 1 : 0;
  framed.set(bytes, 1);
  return encryptBytes(framed, catalogKey);
}

export async function unpackCatalog(blob: Uint8Array, catalogKey: string): Promise<Uint8Array> {
  const framed = await decryptBytes(blob, catalogKey); // throws on wrong key / truncated file
  if (framed.length < 2) throw new Error("Catalog is empty");
  const payload = framed.subarray(1);
  return framed[0] === 1 ? gunzip(payload) : payload.slice();
}

// ───────────── building the admin snapshot ─────────────

const LOCAL_PATH = /^(\/|[a-zA-Z]:[\\/])/;
const LOOPBACK = /(127\.0\.0\.1|localhost|0\.0\.0\.0)/i;
const LOCAL_BRIDGE_REMOTE = /^(streamtape|telegram-drive|tg-native):/i;
/** userinfo in URL, Telegram bot tokens, common secret query params. */
const SECRET_URL = /(:\/\/[^\/\s:@]+:[^\/\s@]+@)|(\/bot\d{5,}:[\w-]{20,})|([?&](?:token|apikey|api_key|key|password|pass|auth|sig|signature|access_token)=)/i;

const usablePath = (p?: string): boolean =>
  !!p && !LOCAL_PATH.test(p) && !LOOPBACK.test(p) && !LOCAL_BRIDGE_REMOTE.test(p);

/** A public share link (e.g. Streamtape `shareUrl`) plays for guests without the grantor's local bridge. */
const hasPublicLink = (v: { shareUrl?: string }): boolean => /^https?:\/\//i.test(v.shareUrl || "");

/**
 * An item no guest can ever play: local file / loopback URL / grantor-only bridge remote, and no version that is
 * either on a shareable remote or reachable through a public share link
 * (VideoPlayerPage uses `activeVersion.shareUrl` for guests, so Streamtape offloads MUST be kept).
 */
export function isUnshareableItem(it: MediaItem): boolean {
  if (usablePath(it.remotePath)) return false;
  return !(it.versions || []).some((v) => usablePath(v.remotePath) || hasPublicLink(v));
}

/** Strips URL fields that embed credentials. Everything else is kept as-is (same as today's import). */
export function scrubItemForGuest(item: MediaItem): MediaItem {
  const out: any = { ...item };
  for (const f of ["sourceUrl", "streamUrl", "dropmbShareUrl"]) {
    if (typeof out[f] === "string" && SECRET_URL.test(out[f])) delete out[f];
  }
  if (Array.isArray(out.versions)) {
    out.versions = out.versions.map((v: any) => {
      const c: any = { ...v };
      for (const f of ["telegramDirectUrl", "shareUrl"]) {
        if (typeof c[f] === "string" && SECRET_URL.test(c[f])) delete c[f];
      }
      return c;
    });
  }
  return out as MediaItem;
}

export function buildGuestCatalogBody(args: {
  passId: string;
  libraries: GuestCatalogLibraryMeta[];
  mediaItems: Record<string, MediaItem>;
  picks: Record<string, { items?: WeeklyRecommendation[] } | undefined>;
}): GuestCatalogBody {
  const ids = new Set(args.libraries.map((l) => l.id));
  const items: MediaItem[] = [];
  for (const it of Object.values(args.mediaItems)) {
    if (!ids.has(it.libraryId)) continue;
    if (isUnshareableItem(it)) continue;
    items.push(scrubItemForGuest(it));
  }
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const weeklyRecommendations: Record<string, WeeklyRecommendation[]> = {};
  for (const l of args.libraries) {
    const p = args.picks[l.id]?.items;
    if (p && p.length > 0) weeklyRecommendations[l.id] = p.slice(0, 3);
  }
  return {
    version: CATALOG_VERSION,
    passId: args.passId,
    libraries: args.libraries.map((l) => ({ id: l.id, name: l.name, type: l.type })),
    items,
    weeklyRecommendations: Object.keys(weeklyRecommendations).length ? weeklyRecommendations : undefined,
  };
}

export async function encodeBody(body: GuestCatalogBody): Promise<{ bytes: Uint8Array; hash: string }> {
  const bytes = new TextEncoder().encode(stableStringify(body));
  return { bytes, hash: await sha256Hex(bytes) };
}

// ───────────── guest-side diff ─────────────

export type CatalogApplyPlan = {
  toUpsert: MediaItem[];
  removedIds: string[];
  added: number;
  updated: number;
  blocked?: string;
};

/**
 * existing = items currently in THIS pass's guest libraries; next = freshly mapped items from the catalog.
 * Keeps guest-local fields, skips unchanged items, and refuses destructive results unless forced.
 */
export function planCatalogApply(existing: MediaItem[], next: MediaItem[], opts: { force?: boolean } = {}): CatalogApplyPlan {
  const byId = new Map(existing.map((i) => [i.id, i] as const));
  const nextIds = new Set(next.map((i) => i.id));
  const removedIds = existing.filter((i) => !nextIds.has(i.id)).map((i) => i.id);

  if (!opts.force) {
    if (next.length === 0 && existing.length > 0) {
      return { toUpsert: [], removedIds: [], added: 0, updated: 0, blocked: "Catalog is empty; keeping your current library." };
    }
    if (existing.length >= 20 && removedIds.length > existing.length * 0.5) {
      return {
        toUpsert: [],
        removedIds: [],
        added: 0,
        updated: 0,
        blocked: `Update would remove ${removedIds.length} of ${existing.length} items; keeping your current library.`,
      };
    }
  }

  const toUpsert: MediaItem[] = [];
  let added = 0;
  let updated = 0;
  for (const n of next) {
    const ex = byId.get(n.id);
    if (!ex) {
      toUpsert.push(n);
      added++;
      continue;
    }
    // Guest-local state wins over the admin copy.
    const merged: MediaItem = { ...n, userTags: ex.userTags, addedAt: ex.addedAt ?? n.addedAt };
    if (stableStringify(merged) !== stableStringify(ex)) {
      toUpsert.push(merged);
      updated++;
    }
  }
  return { toUpsert, removedIds, added, updated };
}

/** Replace only this pass's picks (identified by the guest item ids it owns), keep every other pass's picks. */
export function mergeGuestRecommendations(
  current: WeeklyRecommendation[] | undefined,
  passItemIds: Set<string>,
  fresh: WeeklyRecommendation[]
): WeeklyRecommendation[] {
  const kept = (current || []).filter((r) => !passItemIds.has(r.itemId));
  return [...kept, ...fresh];
}
