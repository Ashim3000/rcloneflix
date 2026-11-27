/**
 * 9anime.co.ke resolver (TypeScript port of src-tauri/src/commands/nineanime.rs) used by
 * androidPolyfill.ts so Android keeps parity with desktop. Pure functions + injected fetch.
 *
 * Chain (verified live 2026-11-26):
 *   watch page -> server button data-token (base64url JSON {u,e,s}) -> embed page
 *     (A) packed JWPlayer page -> direct MP4 (no Referer needed)
 *     (B) wrapper iframe -> MegaPlay getSources?id=<data-id> -> {enc} -> AES-256-CBC -> master.m3u8 (Referer = MegaPlay origin)
 * Tokens live ~10 min: resolve at play time, never persist.
 */

export type FetchText = (
  url: string,
  headers?: Record<string, string>
) => Promise<{ ok: boolean; body: string; url?: string }>;

export const NINE_DEFAULT_ORIGIN = "https://9anime.co.ke";
const MEGAPLAY_KEY_DEFAULT = "i?LMTAx0Q6,:}50U";
const MEGAPLAY_IV_DEFAULT = "W0;27ToaUpl_P%'c";

export const isNineAnimeUrl = (u: string): boolean => u.toLowerCase().includes("9anime.");

const originOf = (u: string): string => {
  try {
    return new URL(u).origin;
  } catch {
    return NINE_DEFAULT_ORIGIN;
  }
};

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  let t = s.trim().replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const titleFromSlug = (slug: string): string =>
  slug
    .replace(/-dub$/, "")
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

// ───────────── pure parsing (unit-tested) ─────────────

function packerEncode(n: number, radix: number): string {
  const d = n % radix;
  const ch = d > 35 ? String.fromCharCode(d + 29) : d.toString(36);
  return (n < radix ? "" : packerEncode(Math.floor(n / radix), radix)) + ch;
}

/** Un-packs Dean Edwards "p,a,c,k,e,d" JavaScript. */
export function unpackPacker(html: string): string | null {
  const m = html.match(/\}\('([\s\S]*)',(\d+),(\d+),'([^']*)'\.split\('\|'\)/);
  if (!m) return null;
  const payload = m[1];
  const radix = parseInt(m[2], 10);
  const count = parseInt(m[3], 10);
  if (radix < 2) return null;
  const words = m[4].split("|");
  const dict: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const key = packerEncode(i, radix);
    dict[key] = words[i] ? words[i] : key;
  }
  return payload
    .replace(/\b\w+\b/g, (w) => (Object.prototype.hasOwnProperty.call(dict, w) ? dict[w] : w))
    .replace(/\\\//g, "/")
    .replace(/\\'/g, "'");
}

/** `[locked, token]` for every `<button class="server-btn …" data-token="…">`. */
export function parseServerTokens(html: string): Array<[boolean, string]> {
  const out: Array<[boolean, string]> = [];
  for (const tag of html.match(/<button\b[^>]*>/gi) || []) {
    const cls = tag.match(/\bclass\s*=\s*"([^"]*)"/i)?.[1] || "";
    if (!cls.includes("server-btn")) continue;
    const tok = tag.match(/\bdata-token\s*=\s*"([^"]+)"/i)?.[1];
    if (tok) out.push([cls.includes("locked"), tok]);
  }
  return out;
}

export function decodeEmbedToken(token: string): { url: string; exp: number } | null {
  try {
    const j = JSON.parse(new TextDecoder().decode(b64urlToBytes(token)));
    if (typeof j?.u !== "string") return null;
    return { url: j.u, exp: Number(j.e) || 0 };
  } catch {
    return null;
  }
}

export function findPlayerFile(js: string): string | null {
  const re = /['"]?file['"]?\s*:\s*['"](https?:\/\/[^'"\s\\]+)['"]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(js)) !== null) {
    if (/\.(vtt|srt|ass|jpe?g|png|webp)/i.test(m[1])) continue;
    return m[1];
  }
  return js.match(/https?:\/\/[^'"\s\\<>]+\.(?:m3u8|mp4)[^'"\s\\<>]*/i)?.[0] || null;
}

export function findIframeSrc(html: string, base: string): string | null {
  const raw = html.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
  if (!raw) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

const padBytes = (s: string, n: number): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(n));
  out.set(new TextEncoder().encode(s).subarray(0, n));
  return out;
};

/** AES-256-CBC (zero-padded key/iv) → `file` URL. Throws on a wrong key (bad PKCS7 padding / JSON). */
export async function megaplayDecrypt(
  enc: string,
  key = MEGAPLAY_KEY_DEFAULT,
  iv = MEGAPLAY_IV_DEFAULT
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto not available");
  const k = await subtle.importKey("raw", padBytes(key, 32), { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await subtle.decrypt({ name: "AES-CBC", iv: padBytes(iv, 16) }, k, b64urlToBytes(enc));
  const j = JSON.parse(new TextDecoder().decode(plain));
  if (!j || typeof j.file !== "string") throw new Error("MegaPlay payload has no file");
  return j.file;
}

export function megaplayKeysFromJs(js: string): [string, string] | null {
  const k = js.match(/SOURCE_ENC_KEY\s*=\s*"([^"]*)"/)?.[1];
  const i = js.match(/SOURCE_ENC_IV\s*=\s*"([^"]*)"/)?.[1];
  return k !== undefined && i !== undefined ? [k, i] : null;
}

export const stripSeasonSuffix = (s: string): string =>
  s
    .replace(/\s+(?:season|part|cour)\s+\d+.*$/i, "")
    .replace(/\s+\d+(?:st|nd|rd|th)\s+season.*$/i, "")
    .trim();

export function titleOverlap(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const ta = tok(a);
  const tb = tok(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  ta.forEach((w) => {
    if (tb.has(w)) inter++;
  });
  return inter / (ta.size + tb.size - inter);
}

// ───────────── network orchestration ─────────────

export type NineResolved = {
  file: string;
  /** Referer the stream needs (HLS from MegaPlay); undefined for plain MP4. */
  referer?: string;
  title: string;
  dub: boolean;
  episode: number;
  slug: string;
};

async function resolveMegaplay(
  fetchText: FetchText,
  iframe: string,
  referer: string
): Promise<{ file: string; referer: string }> {
  const page = await fetchText(iframe, { Referer: referer });
  if (!page.ok) throw new Error("MegaPlay player page failed");
  const id = page.body.match(/data-id="(\d+)"/)?.[1];
  if (!id) throw new Error("MegaPlay: no data-id");
  const origin = originOf(iframe);
  const src = await fetchText(`${origin}/stream/getSources?id=${id}`, {
    Referer: iframe,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json",
  });
  if (!src.ok) throw new Error("MegaPlay getSources failed");
  const j = JSON.parse(src.body);
  let file: string | undefined;
  if (typeof j?.enc === "string") {
    try {
      file = await megaplayDecrypt(j.enc);
    } catch (first) {
      // Key rotated? Re-read it from the live player script and retry once.
      const jsPath = page.body.match(/src="([^"]*e1-player[^"]*\.js[^"]*)"/)?.[1];
      if (!jsPath) throw first;
      const js = await fetchText(new URL(jsPath, iframe).toString(), { Referer: iframe });
      const keys = megaplayKeysFromJs(js.body);
      if (!keys) throw first;
      file = await megaplayDecrypt(j.enc, keys[0], keys[1]);
    }
  } else {
    file = j?.sources?.file || j?.sources?.[0]?.file;
  }
  if (!file) throw new Error("MegaPlay: no sources");
  return { file, referer: `${origin}/` };
}

async function resolveServer(
  fetchText: FetchText,
  watchUrl: string,
  token: string
): Promise<{ file: string; referer?: string }> {
  const t = decodeEmbedToken(token);
  if (!t) throw new Error("undecodable server token");
  if (t.exp > 0 && t.exp < Date.now() / 1000 + 5) throw new Error("server token expired");
  const emb = await fetchText(t.url, { Referer: watchUrl });
  if (!emb.ok) throw new Error("embed fetch failed");
  const embFinal = emb.url || t.url;

  const unpacked = emb.body.includes("p,a,c,k,e,d") ? unpackPacker(emb.body) || "" : "";
  const f = findPlayerFile(unpacked) || findPlayerFile(emb.body);
  if (f) return { file: f, referer: /\.m3u8/i.test(f) ? `${originOf(embFinal)}/` : undefined };

  const iframe = findIframeSrc(emb.body, embFinal);
  if (iframe && /megaplay/i.test(iframe)) return resolveMegaplay(fetchText, iframe, embFinal);
  throw new Error("unknown embed layout");
}

export async function resolveNineAnimeWatch(url: string, fetchText: FetchText): Promise<NineResolved> {
  const m = url.match(/\/watch\/([^/?#]+?)-episode-(\d+)/i);
  if (!m) throw new Error("Not a 9anime watch URL");
  const slug = m[1];
  const episode = parseInt(m[2], 10) || 1;
  const page = await fetchText(url);
  if (!page.ok) throw new Error("9anime watch page failed");
  const tokens = parseServerTokens(page.body).filter(([locked]) => !locked).map(([, t]) => t);
  if (!tokens.length) throw new Error("9anime: no playable (non-VIP) server on this page");
  let last = "";
  for (const tok of tokens) {
    try {
      const r = await resolveServer(fetchText, page.url || url, tok);
      const dub = slug.endsWith("-dub");
      return {
        file: r.file,
        referer: r.referer,
        title: `${titleFromSlug(slug)} Episode ${episode}${dub ? " [Dub]" : ""}`,
        dub,
        episode,
        slug,
      };
    } catch (e: any) {
      last = String(e?.message || e);
    }
  }
  throw new Error(`9anime: all servers failed (${last})`);
}

type Hit = { title: string; slug: string; kind: string; cover?: string };

/** Returns the hits plus the origin that actually answered (follows 9anime domain-rotation redirects). */
async function searchTitles(fetchText: FetchText, origin: string, q: string): Promise<{ hits: Hit[]; origin: string }> {
  const r = await fetchText(`${origin}/api/search?q=${encodeURIComponent(q)}`, {
    Referer: origin,
    Accept: "application/json",
  });
  const active = originOf(r.url || origin);
  origin = active;
  if (!r.ok) return { hits: [], origin };
  try {
    const arr = JSON.parse(r.body)?.results;
    const hits = (Array.isArray(arr) ? arr : [])
      .filter((x: any) => x?.slug)
      .map((x: any) => ({
        title: String(x.title || x.slug),
        slug: String(x.slug),
        kind: String(x.type || "TV"),
        cover: x.cover_image ? (String(x.cover_image).startsWith("http") ? x.cover_image : `${origin}${x.cover_image}`) : undefined,
      }));
    return { hits, origin };
  } catch {
    return { hits: [], origin };
  }
}

/** yomi.to is dead: find the same show on 9anime (English Dub preferred when asked). */
export async function searchAndResolveForYomi(
  yomiSlug: string,
  episode: number,
  preferDub: boolean,
  fetchText: FetchText
): Promise<NineResolved> {
  const words = yomiSlug.replace(/-/g, " ");
  const queries = [words];
  const stripped = stripSeasonSuffix(words);
  if (stripped && stripped !== words) queries.push(stripped);
  for (const q of queries) {
    const { hits, origin: activeOrigin } = await searchTitles(fetchText, NINE_DEFAULT_ORIGIN, q);
    let best: Hit | undefined;
    let bestScore = 0;
    for (const h of hits) {
      if (h.slug.endsWith("-dub")) continue;
      const s = titleOverlap(words, h.title);
      if (s >= 0.6 && s > bestScore) {
        best = h;
        bestScore = s;
      }
    }
    if (!best) continue;
    const dubSlug = `${best.slug}-dub`;
    const hasDub = hits.some((h) => h.slug === dubSlug);
    const order: string[] = [];
    if (preferDub && hasDub) order.push(dubSlug);
    order.push(best.slug);
    if (!preferDub && hasDub) order.push(dubSlug);
    const ep = /movie/i.test(best.kind) ? 1 : episode;
    for (const slug of order) {
      try {
        return await resolveNineAnimeWatch(`${activeOrigin}/watch/${slug}-episode-${ep}`, fetchText);
      } catch {
        /* try next */
      }
    }
  }
  throw new Error("9anime: no matching title found");
}

export type NineRelease = {
  title: string;
  post_url: string;
  thumbnail: string | null;
  date: string | null;
  site_domain: string;
  media_type: string;
  season: number | null;
  episode: number | null;
};

export async function crawlNineAnime(
  url: string,
  fetchText: FetchText
): Promise<{ site_url: string; site_title: string; releases: NineRelease[] }> {
  const u = new URL(url);
  let origin = u.origin;
  const mk = (title: string, post_url: string, thumb: string | undefined, media_type: string, ep: number | null): NineRelease => ({
    title,
    post_url,
    thumbnail: thumb || null,
    date: null,
    site_domain: new URL(origin).hostname,
    media_type,
    season: ep !== null ? 1 : null,
    episode: ep,
  });

  const slug =
    u.pathname.match(/\/watch\/([^/?#]+?)-episode-\d+/i)?.[1] || u.pathname.match(/^\/anime\/([^/?#]+)/i)?.[1];
  if (slug) {
    const page = await fetchText(url);
    if (!page.ok) throw new Error("9anime page failed");
    origin = originOf(page.url || url);
    const re = new RegExp(`/watch/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-episode-(\\d+)`, "g");
    const eps = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(page.body)) !== null) eps.add(parseInt(m[1], 10));
    if (!eps.size) eps.add(1);
    const title = titleFromSlug(slug);
    return {
      site_url: url,
      site_title: title,
      releases: [...eps]
        .sort((a, b) => a - b)
        .map((n) => mk(`${title} - Episode ${n}`, `${origin}/watch/${slug}-episode-${n}`, undefined, "tv", n)),
    };
  }

  const q =
    u.searchParams.get("keyword") ||
    u.searchParams.get("q") ||
    u.searchParams.get("query") ||
    u.searchParams.get("s") ||
    (u.pathname.startsWith("/search/") ? decodeURIComponent(u.pathname.slice(8)) : "");
  if (q.trim()) {
    const found = await searchTitles(fetchText, origin, q.trim());
    origin = found.origin;
    const hits = found.hits;
    return {
      site_url: url,
      site_title: `9anime: "${q.trim()}"`,
      releases: hits.map((h) =>
        /movie/i.test(h.kind)
          ? mk(h.title, `${origin}/watch/${h.slug}-episode-1`, h.cover, "movies", null)
          : mk(h.title, `${origin}/anime/${h.slug}`, h.cover, "tv", null)
      ),
    };
  }

  const page = await fetchText(url);
  if (!page.ok) throw new Error("9anime page failed");
  origin = originOf(page.url || url);
  const seen = new Set<string>();
  const releases: NineRelease[] = [];
  const re = /\/watch\/([a-z0-9][a-z0-9-]*?)-episode-\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(page.body)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    releases.push(mk(titleFromSlug(m[1]), `${origin}/anime/${m[1]}`, undefined, "tv", null));
  }
  return { site_url: url, site_title: "9anime Latest", releases };
}
