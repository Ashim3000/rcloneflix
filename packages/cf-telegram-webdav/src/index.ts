import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";
import bigInt from "big-integer";

export interface Env {
  TG_API_ID: string;
  TG_API_HASH: string;
  TG_STRING_SESSION: string;
  TG_DEFAULT_CHAT_ID: string;
  WEBDAV_USER: string;
  WEBDAV_PASS: string;
  MASTER_KEY_HEX: string;
}

export interface TgIndexEntry {
  /** Virtual path starting with '/', e.g. "/Movies/Inception (2010).mp4" */
  path: string;
  /** Filename, e.g. "Inception (2010).mp4" */
  name: string;
  /** Exact file size in bytes */
  size: number;
  /** Telegram message ID containing the document/video */
  msgId: number;
  /** Telegram channel/chat ID (e.g. "-1003872024113") */
  chatId: string;
  /** MIME type, e.g. "video/mp4" */
  mimeType: string;
  /** Unix timestamp (seconds) */
  mtime: number;
}

interface TgIndexManifest {
  version: 1;
  updatedAt: number;
  entries: TgIndexEntry[];
}

interface TgStreamTokenPayload {
  chatId: string;
  msgId: number;
  size?: number;
  filename?: string;
  mimeType?: string;
  exp: number;
}

// Strict 512 KiB (524,288 bytes) MTProto chunk size:
// - Divisible by 4096 (4096 * 128 = 524,288)
// - Divides 1,048,576 (1 MiB) evenly (1,048,576 / 524,288 = 2)
// - Guarantees (alignedOffset % 524,288 === 0) NEVER crosses a 1 MiB boundary!
const MTPROTO_CHUNK_SIZE = 524288;
const INDEX_FILENAME = ".rflix_tg_index.json";

const DEFAULT_INITIAL_ENTRIES: TgIndexEntry[] = [
  { path: "/Get Millie Black - S01E01 - Millie.nfo", name: "Get Millie Black - S01E01 - Millie.nfo", size: 2192, msgId: 77, chatId: "-1003872024113", mimeType: "text/x-nfo; charset=utf-8", mtime: 1793495368 },
  { path: "/Get Millie Black - S01E02 - Hibiscus.nfo", name: "Get Millie Black - S01E02 - Hibiscus.nfo", size: 2431, msgId: 66, chatId: "-1003872024113", mimeType: "text/x-nfo; charset=utf-8", mtime: 1793492879 },
  { path: "/Get Millie Black - S01E03 - Holborn.nfo", name: "Get Millie Black - S01E03 - Holborn.nfo", size: 2195, msgId: 72, chatId: "-1003872024113", mimeType: "text/x-nfo; charset=utf-8", mtime: 1793494910 },
  { path: "/Get Millie Black - S01E04 - Janet.nfo", name: "Get Millie Black - S01E04 - Janet.nfo", size: 2190, msgId: 65, chatId: "-1003872024113", mimeType: "text/x-nfo; charset=utf-8", mtime: 1793492875 },
  { path: "/Get Millie Black - S01E05 - Curtis.nfo", name: "Get Millie Black - S01E05 - Curtis.nfo", size: 1864, msgId: 76, chatId: "-1003872024113", mimeType: "text/x-nfo; charset=utf-8", mtime: 1793495368 },
  { path: "/Nocturne_2026_S01E01_Lazarus_Come_Forth_1080p_ATVP_WEB_DL_DDP5_1.mp4", name: "Nocturne_2026_S01E01_Lazarus_Come_Forth_1080p_ATVP_WEB_DL_DDP5_1.mp4", size: 552548716, msgId: 78, chatId: "-1003872024113", mimeType: "video/mp4", mtime: 1793498514 },
  { path: "/Nocturne_S01E02_For_Such_a_Time_as_This_1080p_ATVP_WEB_DL_DDP5_1.mp4", name: "Nocturne_S01E02_For_Such_a_Time_as_This_1080p_ATVP_WEB_DL_DDP5_1.mp4", size: 484612112, msgId: 79, chatId: "-1003872024113", mimeType: "video/mp4", mtime: 1793502131 },
  { path: "/RcloneFlix_0.9.0.flatpak", name: "RcloneFlix_0.9.0.flatpak", size: 27187864, msgId: 2, chatId: "-1003872024113", mimeType: "application/octet-stream", mtime: 1759254647 },
  { path: "/RcloneFlix_0.9.0_amd64.deb", name: "RcloneFlix_0.9.0_amd64.deb", size: 39199180, msgId: 4, chatId: "-1003872024113", mimeType: "application/octet-stream", mtime: 1759254692 },
  { path: "/RcloneFlix_0.9.0_x64-setup.exe", name: "RcloneFlix_0.9.0_x64-setup.exe", size: 70049095, msgId: 3, chatId: "-1003872024113", mimeType: "application/octet-stream", mtime: 1759254652 },
  { path: "/RcloneFlix_0.9.4.flatpak", name: "RcloneFlix_0.9.4.flatpak", size: 71241984, msgId: 6, chatId: "-1003872024113", mimeType: "application/octet-stream", mtime: 1759994582 },
  { path: "/RcloneFlix_0.9.4_amd64.deb", name: "RcloneFlix_0.9.4_amd64.deb", size: 84013062, msgId: 7, chatId: "-1003872024113", mimeType: "application/octet-stream", mtime: 1759994636 },
  { path: "/RcloneFlix_0.9.4_x64-setup.exe", name: "RcloneFlix_0.9.4_x64-setup.exe", size: 105674188, msgId: 8, chatId: "-1003872024113", mimeType: "application/octet-stream", mtime: 1759994664 },
  { path: "/season.nfo", name: "season.nfo", size: 258, msgId: 75, chatId: "-1003872024113", mimeType: "text/x-nfo; charset=utf-8", mtime: 1793495367 },
  { path: "/tvshow.nfo", name: "tvshow.nfo", size: 365, msgId: 61, chatId: "-1003872024113", mimeType: "text/x-nfo; charset=utf-8", mtime: 1793492872 },
];

let cachedClient: TelegramClient | null = null;
let cachedManifest: { manifest: TgIndexManifest; fetchedAt: number } = {
  manifest: {
    version: 1,
    updatedAt: Math.floor(Date.now() / 1000),
    entries: DEFAULT_INITIAL_ENTRIES,
  },
  fetchedAt: Date.now(),
};
const docLocationCache = new Map<
  string,
  {
    id: bigInt.BigInteger;
    accessHash: bigInt.BigInteger;
    fileReference: Buffer;
    dcId: number;
    size: number;
    mimeType: string;
    fileName: string;
  }
>();

// ============================================================================
// 1. TELEGRAM MTPROTO CLIENT & FRESH FILE_REFERENCE RESOLVER
// ============================================================================

async function getTgClient(env: Env): Promise<TelegramClient> {
  if (cachedClient) {
    try {
      if (cachedClient.connected) {
        return cachedClient;
      }
    } catch {
      // dead client
    }
    cachedClient = null;
  }
  const session = new StringSession(env.TG_STRING_SESSION.trim());
  const client = new TelegramClient(
    session,
    parseInt(env.TG_API_ID.trim(), 10),
    env.TG_API_HASH.trim(),
    {
      connectionRetries: 3,
      useWSS: true,
    }
  );
  await client.connect();
  cachedClient = client;
  return client;
}

/**
 * Fetches (or refreshes on FILE_REFERENCE_EXPIRED) the document location for (chatId, msgId).
 */
async function getDocumentLocation(
  client: TelegramClient,
  chatId: string,
  msgId: number,
  forceRefresh = false
) {
  const cacheKey = `${chatId}:${msgId}`;
  if (!forceRefresh && docLocationCache.has(cacheKey)) {
    return docLocationCache.get(cacheKey)!;
  }

  const entity = await client.getInputEntity(chatId);
  const messages = await client.getMessages(entity, { ids: [msgId] });
  const msg = messages?.[0];
  if (!msg || !msg.media || !("document" in msg.media) || !msg.media.document) {
    throw new Error(`Telegram message ${msgId} in ${chatId} does not contain a document/video`);
  }

  const doc = msg.media.document as Api.Document;
  let fileName = `telegram_${msgId}.mp4`;
  for (const attr of doc.attributes || []) {
    if (attr instanceof Api.DocumentAttributeFilename && attr.fileName) {
      fileName = attr.fileName;
      break;
    }
  }
  if (fileName.startsWith("telegram_") && msg.message) {
    const cleaned = msg.message.replace(/^🎬\s*/, "").trim();
    if (cleaned) fileName = cleaned;
  }

  const info = {
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: Buffer.from(doc.fileReference),
    dcId: doc.dcId,
    size: Number(doc.size),
    mimeType: doc.mimeType || "video/mp4",
    fileName,
  };
  docLocationCache.set(cacheKey, info);
  return info;
}

/**
 * Downloads a single 512 KiB aligned chunk from Telegram MTProto, automatically
 * refreshing `file_reference` if Telegram returns `FILE_REFERENCE_EXPIRED`.
 */
async function downloadAlignedMtprotoChunk(
  client: TelegramClient,
  chatId: string,
  msgId: number,
  alignedOffset: number
): Promise<Uint8Array> {
  if (alignedOffset % MTPROTO_CHUNK_SIZE !== 0) {
    throw new Error(`Internal alignment error: offset ${alignedOffset} is not a multiple of 524288`);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const loc = await getDocumentLocation(client, chatId, msgId, attempt > 0);
    try {
      const res = (await client.invoke(
        new Api.upload.GetFile({
          location: new Api.InputDocumentFileLocation({
            id: loc.id,
            accessHash: loc.accessHash,
            fileReference: loc.fileReference,
            thumbSize: "",
          }),
          offset: bigInt(alignedOffset),
          limit: MTPROTO_CHUNK_SIZE,
        }),
        loc.dcId
      )) as Api.upload.File;

      return new Uint8Array(res.bytes);
    } catch (err: any) {
      const msg = String(err?.errorMessage || err?.message || err);
      if (attempt === 0 && msg.includes("FILE_REFERENCE")) {
        // Refresh file_reference via msgId and retry once
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed to download MTProto chunk after refreshing file_reference");
}

/**
 * Streams an arbitrary byte range [rangeStart..rangeEnd] using a pull-based ReadableStream
 * that holds only one 512 KiB MTProto chunk in memory at a time.
 * When piped through Cloudflare Workers' FixedLengthStream(contentLength), the HTTP response
 * preserves the exact Content-Length header without truncating Rclone WebDAV streams early!
 */
function streamTelegramByteRange(
  client: TelegramClient,
  chatId: string,
  msgId: number,
  rangeStart: number,
  rangeEnd: number
): ReadableStream<Uint8Array> {
  let currentAlignedOffset = Math.floor(rangeStart / MTPROTO_CHUNK_SIZE) * MTPROTO_CHUNK_SIZE;
  let firstChunkSkip = rangeStart - currentAlignedOffset;
  let bytesRemaining = rangeEnd - rangeStart + 1;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (bytesRemaining <= 0) {
        controller.close();
        return;
      }
      try {
        const chunk = await downloadAlignedMtprotoChunk(client, chatId, msgId, currentAlignedOffset);
        currentAlignedOffset += MTPROTO_CHUNK_SIZE;
        if (chunk.length === 0) {
          controller.close();
          return;
        }
        const sliceStart = firstChunkSkip;
        firstChunkSkip = 0;
        if (sliceStart >= chunk.length) {
          controller.close();
          return;
        }
        const available = chunk.length - sliceStart;
        const toSend = Math.min(available, bytesRemaining);
        const sub = chunk.subarray(sliceStart, sliceStart + toSend);
        bytesRemaining -= sub.byteLength;
        controller.enqueue(sub);
        if (bytesRemaining <= 0 || chunk.length < MTPROTO_CHUNK_SIZE) {
          controller.close();
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

// ============================================================================
// 2. SERVERLESS CHANNEL INDEX (.rflix_tg_index.json) LOADER & REBUILDER
// ============================================================================

async function loadChannelIndex(
  env: Env,
  chatId: string,
  forceReload = false
): Promise<TgIndexManifest> {
  if (!forceReload && cachedManifest) {
    return cachedManifest.manifest;
  }

  const client = await getTgClient(env);
  const entity = await client.getInputEntity(chatId);

  // 1. If channel has a pinned message, check if it's the index
  try {
    const full = (await client.invoke(new Api.channels.GetFullChannel({ channel: entity }))) as any;
    const pinnedId = full.fullChat?.pinnedMsgId;
    if (pinnedId) {
      const pinnedMsgs = await client.getMessages(entity, { ids: [pinnedId] });
      const pinMsg = pinnedMsgs?.[0];
      if (pinMsg && pinMsg.media && "document" in pinMsg.media && pinMsg.media.document) {
        const doc = pinMsg.media.document as Api.Document;
        let fn = "";
        for (const attr of doc.attributes || []) {
          if (attr instanceof Api.DocumentAttributeFilename && attr.fileName) {
            fn = attr.fileName;
            break;
          }
        }
        if (fn === INDEX_FILENAME) {
          const buf = (await client.downloadMedia(pinMsg.media, {})) as Buffer;
          if (buf && buf.length > 0) {
            const parsed = JSON.parse(buf.toString("utf-8")) as TgIndexManifest;
            if (parsed && Array.isArray(parsed.entries)) {
              cachedManifest = { manifest: parsed, fetchedAt: Date.now() };
              return parsed;
            }
          }
        }
      }
    }
  } catch {
    // Ignore and fallback to scanning messages
  }

  // Fallback: Automatically build index from channel message history
  return await rebuildChannelIndex(client, chatId);
}

/**
 * Scans the Telegram channel for all video/document messages, constructs `.rflix_tg_index.json`,
 * so WebDAV PROPFIND requests and streaming reflect all channel media.
 */
async function rebuildChannelIndex(
  client: TelegramClient,
  chatId: string
): Promise<TgIndexManifest> {
  const entity = await client.getInputEntity(chatId);

  // Find approximate highest message ID using GetFullChannel
  let maxId = 50;
  try {
    const full = (await client.invoke(new Api.channels.GetFullChannel({ channel: entity }))) as any;
    const readMax = full.fullChat?.readInboxMaxId || 0;
    const unread = full.fullChat?.unreadCount || 0;
    maxId = Math.max(readMax + unread + 50, 100);
  } catch {
    maxId = 150;
  }

  const entries: TgIndexEntry[] = [];
  const seenPaths = new Set<string>();

  // Bots cannot call messages.GetHistory or messages.Search; fetch messages by ID batch:
  const batchSize = 50;
  for (let start = 1; start <= maxId; start += batchSize) {
    const ids = Array.from({ length: batchSize }, (_, i) => start + i);
    let msgs: any[] = [];
    try {
      msgs = await client.getMessages(entity, { ids });
    } catch {
      continue;
    }

    for (const msg of msgs) {
      if (!msg || !msg.media || !("document" in msg.media) || !msg.media.document) continue;
      const doc = msg.media.document as Api.Document;

      let fileName = "";
      for (const attr of doc.attributes || []) {
        if (attr instanceof Api.DocumentAttributeFilename && attr.fileName) {
          fileName = attr.fileName;
          break;
        }
      }
      if (fileName === INDEX_FILENAME) continue;

      // Also check caption (e.g. RcloneFlix's "🎬 MovieName.mp4" or folder prefix)
      const caption = (msg.message || "").replace(/^🎬\s*/, "").trim();
      if (!fileName && caption) {
        fileName = caption;
      }
      if (!fileName) {
        const ext = (doc.mimeType || "").includes("matroska") ? ".mkv" : ".mp4";
        fileName = `telegram_video_${msg.id}${ext}`;
      }

      let virtualPath = fileName.startsWith("/") ? fileName : `/${fileName}`;
      if (seenPaths.has(virtualPath)) {
        const dotIdx = virtualPath.lastIndexOf(".");
        virtualPath =
          dotIdx > 0
            ? `${virtualPath.slice(0, dotIdx)}_${msg.id}${virtualPath.slice(dotIdx)}`
            : `${virtualPath}_${msg.id}`;
      }
      seenPaths.add(virtualPath);

      const baseName = virtualPath.split("/").filter(Boolean).pop() || fileName;
      entries.push({
        path: virtualPath,
        name: baseName,
        size: Number(doc.size),
        msgId: msg.id,
        chatId: String(chatId),
        mimeType: doc.mimeType || "video/mp4",
        mtime: msg.date || Math.floor(Date.now() / 1000),
      });
    }
  }

  const manifest: TgIndexManifest = {
    version: 1,
    updatedAt: Math.floor(Date.now() / 1000),
    entries,
  };

  cachedManifest = { manifest, fetchedAt: Date.now() };
  return manifest;
}

// ============================================================================
// 3. WEBDAV PROPFIND XML BUILDER & HELPERS
// ============================================================================

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function encodeWebdavHref(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function verifyBasicAuth(request: Request, env: Env): boolean {
  if (!env.WEBDAV_USER && !env.WEBDAV_PASS) return true;
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Basic ")) return false;
  const decoded = atob(auth.slice(6));
  const expected = `${env.WEBDAV_USER}:${env.WEBDAV_PASS}`;
  return decoded === expected;
}

function buildPropfindXml(
  reqBasePath: string,
  dirPath: string,
  depth: string,
  entries: TgIndexEntry[]
): string | null {
  const cleanTarget = dirPath.replace(/\/+$/, "");
  const normDir = dirPath === "/" ? "/" : `/${dirPath.replace(/^\/+|\/+$/g, "")}/`;
  const responses: string[] = [];

  // Support stateless virtual paths: /__tg_<msgId>_<size>/<filename>
  const statelessMatch = cleanTarget.match(/^\/__tg_(\d+)_(\d+)\/(.+)$/);
  const statelessEntry: TgIndexEntry | undefined = statelessMatch
    ? {
        path: cleanTarget,
        name: statelessMatch[3],
        size: parseInt(statelessMatch[2], 10),
        msgId: parseInt(statelessMatch[1], 10),
        chatId: "",
        mimeType: inferMimeFromFilename(statelessMatch[3]),
        mtime: Math.floor(Date.now() / 1000),
      }
    : undefined;

  // Check if exact file match
  const exactFile = statelessEntry || entries.find((e) => e.path === cleanTarget);
  if (exactFile) {
    const href = encodeWebdavHref(`${reqBasePath}${exactFile.path}`);
    const lastMod = new Date(exactFile.mtime * 1000).toUTCString();
    responses.push(`
  <D:response>
    <D:href>${escapeXml(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(exactFile.name)}</D:displayname>
        <D:getcontentlength>${exactFile.size}</D:getcontentlength>
        <D:getcontenttype>${escapeXml(exactFile.mimeType)}</D:getcontenttype>
        <D:getlastmodified>${lastMod}</D:getlastmodified>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`);
  } else {
    // Check if root or valid directory
    const isRootDir = dirPath === "/" || !cleanTarget;
    const hasMatchingChildren = entries.some((e) => e.path.startsWith(normDir));

    if (!isRootDir && !hasMatchingChildren) {
      // Neither a file nor an existing directory -> 404
      return null;
    }

    // Directory entry itself
    const dirHref = encodeWebdavHref(
      `${reqBasePath}${normDir === "/" ? "/" : normDir}`
    );
    const dirName =
      normDir === "/"
        ? "/"
        : normDir
            .replace(/\/+$/, "")
            .split("/")
            .pop() || "/";
    responses.push(`
  <D:response>
    <D:href>${escapeXml(dirHref)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(dirName)}</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`);

    if (depth !== "0") {
      const subDirs = new Set<string>();
      for (const entry of entries) {
        if (!entry.path.startsWith(normDir)) continue;
        const remainder = entry.path.slice(normDir.length);
        if (!remainder) continue;

        const slashIdx = remainder.indexOf("/");
        if (slashIdx !== -1) {
          // Immediate child subdirectory
          const subDirName = remainder.slice(0, slashIdx);
          if (!subDirs.has(subDirName)) {
            subDirs.add(subDirName);
            const subHref = encodeWebdavHref(`${reqBasePath}${normDir}${subDirName}/`);
            responses.push(`
  <D:response>
    <D:href>${escapeXml(subHref)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(subDirName)}</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`);
          }
        } else {
          // Immediate child file
          const fileHref = encodeWebdavHref(`${reqBasePath}${entry.path}`);
          const lastMod = new Date(entry.mtime * 1000).toUTCString();
          responses.push(`
  <D:response>
    <D:href>${escapeXml(fileHref)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(entry.name)}</D:displayname>
        <D:getcontentlength>${entry.size}</D:getcontentlength>
        <D:getcontenttype>${escapeXml(entry.mimeType)}</D:getcontenttype>
        <D:getlastmodified>${lastMod}</D:getlastmodified>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`);
        }
      }
    }
  }

  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join("")}\n</D:multistatus>`;
}

// ============================================================================
// 4. TOKEN UNSEALING FOR ZERO-BANDWIDTH /stream DIRECT LINKS
// ============================================================================

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

async function unsealTgStreamToken(
  token: string,
  masterKeyHex: string
): Promise<TgStreamTokenPayload> {
  const raw = base64UrlToBytes(token);
  if (raw.length < 28) throw new Error("Malformed token");
  const iv = raw.subarray(0, 12);
  const ciphertext = raw.subarray(12);
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(masterKeyHex),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const payload = JSON.parse(new TextDecoder().decode(decrypted)) as TgStreamTokenPayload;
  if (Date.now() / 1000 > payload.exp) {
    throw new Error("Telegram stream link expired");
  }
  return payload;
}

// ============================================================================
// 5. MAIN CLOUDFLARE WORKER ENTRYPOINT
// ============================================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, MKCOL, OPTIONS, PROPFIND",
  "Access-Control-Allow-Headers": "Range, Content-Type, Authorization, Depth",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, X-Telegram-Msg-Id, X-Telegram-Chat-Id",
};

function inferMimeFromFilename(name: string): string {
  const lower = (name || "").toLowerCase();
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a") || lower.endsWith(".m4b") || lower.endsWith(".aac")) return "audio/mp4";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".epub")) return "application/epub+zip";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".cbz")) return "application/vnd.comicbook+zip";
  if (lower.endsWith(".srt")) return "application/x-subrip";
  if (lower.endsWith(".vtt")) return "text/vtt; charset=utf-8";
  if (lower.endsWith(".nfo")) return "text/x-nfo; charset=utf-8";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

async function serveTelegramFileRange(
  request: Request,
  env: Env,
  chatId: string,
  msgId: number,
  knownSize?: number,
  knownMime?: string,
  knownName?: string
): Promise<Response> {
  // Fast-path for HEAD requests when size is already known from manifest / token / stateless path:
  // avoids opening a second concurrent GramJS WebSocket during rclone serve http probes!
  if (request.method === "HEAD" && knownSize && knownSize > 0) {
    const totalSize = knownSize;
    const mimeType = knownMime || inferMimeFromFilename(knownName || "");
    const fileName = knownName || `telegram_${msgId}.bin`;
    const rangeHeader = request.headers.get("Range");
    let start = 0;
    let end = totalSize - 1;
    let isPartial = false;
    if (rangeHeader && rangeHeader.startsWith("bytes=")) {
      isPartial = true;
      const parts = rangeHeader.replace("bytes=", "").split("-");
      if (parts[0] === "" && parts[1]) {
        const suffix = parseInt(parts[1], 10);
        start = Math.max(0, totalSize - suffix);
      } else {
        start = parseInt(parts[0], 10) || 0;
        end = parts[1] ? Math.min(totalSize - 1, parseInt(parts[1], 10)) : totalSize - 1;
      }
    }
    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      "Content-Type": mimeType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(Math.max(0, end - start + 1)),
      "Content-Disposition": `inline; filename="${fileName.replace(/"/g, "")}"`,
    };
    if (isPartial) {
      headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
    }
    return new Response(null, { status: isPartial ? 206 : 200, headers });
  }

  const client = await getTgClient(env);
  let loc;
  try {
    loc = await getDocumentLocation(client, chatId, msgId, false);
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes("not found") || msg.includes("does not contain a document")) {
      return new Response(`Telegram media not found for msgId ${msgId}: ${msg}`, {
        status: 404,
        headers: CORS_HEADERS,
      });
    }
    throw err;
  }

  const totalSize = knownSize && knownSize > 0 ? knownSize : loc.size;
  const mimeType = knownMime || loc.mimeType || inferMimeFromFilename(knownName || loc.fileName);
  const fileName = knownName || loc.fileName || `telegram_${msgId}.mp4`;

  const rangeHeader = request.headers.get("Range");
  let start = 0;
  let end = totalSize - 1;
  let isPartial = false;

  if (rangeHeader && rangeHeader.startsWith("bytes=")) {
    isPartial = true;
    const parts = rangeHeader.replace("bytes=", "").split("-");
    if (parts[0] === "" && parts[1]) {
      const suffix = parseInt(parts[1], 10);
      start = Math.max(0, totalSize - suffix);
      end = totalSize - 1;
    } else {
      start = parseInt(parts[0], 10) || 0;
      end = parts[1] ? Math.min(totalSize - 1, parseInt(parts[1], 10)) : totalSize - 1;
    }
  }

  if (start > end || start >= totalSize) {
    return new Response("Requested Range Not Satisfiable", {
      status: 416,
      headers: {
        ...CORS_HEADERS,
        "Content-Range": `bytes */${totalSize}`,
      },
    });
  }

  const contentLength = end - start + 1;
  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    "Content-Length": String(contentLength),
    "Content-Disposition": `inline; filename="${fileName.replace(/"/g, "")}"`,
  };
  if (isPartial) {
    headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: isPartial ? 206 : 200, headers });
  }

  const rawStream = streamTelegramByteRange(client, chatId, msgId, start, end);
  if (typeof (globalThis as any).FixedLengthStream === "function") {
    const { readable, writable } = new (globalThis as any).FixedLengthStream(contentLength);
    rawStream.pipeTo(writable).catch(() => {});
    return new Response(readable, {
      status: isPartial ? 206 : 200,
      headers,
    });
  }

  return new Response(rawStream, {
    status: isPartial ? 206 : 200,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...CORS_HEADERS,
            DAV: "1, 2",
            Allow: "OPTIONS, GET, HEAD, POST, PUT, DELETE, MKCOL, PROPFIND",
          },
        });
      }

      const url = new URL(request.url);

      // 1. Direct Stream Endpoint (/stream/...?token=...) - No Basic Auth Needed
      if (url.pathname.startsWith("/stream")) {
        const token = url.searchParams.get("token");
        if (!token) {
          return new Response("Missing ?token=", { status: 400, headers: CORS_HEADERS });
        }
        try {
          const payload = await unsealTgStreamToken(token, env.MASTER_KEY_HEX);
          return await serveTelegramFileRange(
            request,
            env,
            payload.chatId,
            payload.msgId,
            payload.size,
            payload.mimeType,
            payload.filename
          );
        } catch (err: any) {
          return new Response(`Stream Error: ${err.message}`, {
            status: 401,
            headers: CORS_HEADERS,
          });
        }
      }

      const defaultChatId = env.TG_DEFAULT_CHAT_ID.trim();

      // 1B. Public Direct Media Streaming Endpoint (/public/...) - No Basic Auth Needed
      // Allows instant direct link sharing for Telegram files to VLC, browsers, external players
      if (url.pathname.startsWith("/public")) {
        const subPath = decodeURIComponent(url.pathname.replace(/^\/public/, "") || "/");
        const cleanTarget = subPath.replace(/\/+$/, "");

        // 1B-1. Stateless direct path: /public/__tg_<msgId>_<size>/<filename>
        const statelessMatch = cleanTarget.match(/^\/__tg_(\d+)_(\d+)\/(.+)$/);
        if (statelessMatch) {
          const msgId = parseInt(statelessMatch[1], 10);
          const size = parseInt(statelessMatch[2], 10);
          const name = statelessMatch[3];
          return await serveTelegramFileRange(
            request,
            env,
            defaultChatId,
            msgId,
            size,
            inferMimeFromFilename(name),
            name
          );
        }

        // 1B-2. Lookup from manifest index
        const manifest = await loadChannelIndex(env, defaultChatId);
        const entry = manifest.entries.find(
          (e) => e.path === cleanTarget || e.name === cleanTarget.replace(/^\//, "")
        );
        if (!entry) {
          return new Response("File Not Found in Telegram Channel", {
            status: 404,
            headers: CORS_HEADERS,
          });
        }
        return await serveTelegramFileRange(
          request,
          env,
          entry.chatId || defaultChatId,
          entry.msgId,
          entry.size,
          entry.mimeType,
          entry.name
        );
      }

      // 2. All /webdav, /manifest, /register-entry, /upload-chunk, /finalize-upload, and /rebuild-index routes require Basic Auth
      if (!verifyBasicAuth(request, env)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...CORS_HEADERS,
            "WWW-Authenticate": 'Basic realm="RcloneFlix Telegram Serverless WebDAV"',
          },
        });
      }

      // 3. Manifest Query Endpoint (GET /manifest)
      if (url.pathname === "/manifest" && request.method === "GET") {
        const manifest = await loadChannelIndex(env, defaultChatId);
        return new Response(JSON.stringify(manifest, null, 2), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      // 4. Register Offloaded Entry Endpoint (POST /register-entry)
      // Called by Kaggle / GitHub Actions workers or RcloneFlix client after MTProto upload
      if (url.pathname === "/register-entry" && request.method === "POST") {
        const body = (await request.json()) as Partial<TgIndexEntry>;
        if (!body.msgId || !body.name) {
          return new Response(JSON.stringify({ error: "msgId and name are required" }), {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
        const rawPath = body.path || `/${body.name}`;
        const cleanPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
        const newEntry: TgIndexEntry = {
          path: cleanPath,
          name: body.name,
          size: Number(body.size || 0),
          msgId: Number(body.msgId),
          chatId: String(body.chatId || defaultChatId),
          mimeType: body.mimeType || inferMimeFromFilename(body.name),
          mtime: Number(body.mtime || Math.floor(Date.now() / 1000)),
        };

        cachedManifest.manifest.entries = cachedManifest.manifest.entries.filter(
          (e) => e.path !== newEntry.path && e.msgId !== newEntry.msgId
        );
        cachedManifest.manifest.entries.push(newEntry);
        cachedManifest.manifest.updatedAt = Math.floor(Date.now() / 1000);
        cachedManifest.fetchedAt = Date.now();

        return new Response(JSON.stringify({ ok: true, entry: newEntry }), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      // 5. Rebuild Index Endpoint (POST /rebuild-index)
      if (url.pathname === "/rebuild-index" && request.method === "POST") {
        const client = await getTgClient(env);
        const manifest = await rebuildChannelIndex(client, defaultChatId);
        return new Response(JSON.stringify(manifest, null, 2), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      // 5B. Chunked MTProto Upload Endpoint (POST /upload-chunk?fileId=...&startPart=...&totalParts=...)
      // Accepts a <= 16 MiB slice (up to 32 x 512 KiB MTProto parts) and forwards via Api.upload.SaveBigFilePart
      if (url.pathname === "/upload-chunk" && request.method === "POST") {
        const fileIdStr = url.searchParams.get("fileId") || "";
        const startPart = parseInt(url.searchParams.get("startPart") || "0", 10);
        const totalParts = parseInt(url.searchParams.get("totalParts") || "0", 10);
        if (!fileIdStr || totalParts <= 0) {
          return new Response(JSON.stringify({ error: "Missing fileId or totalParts" }), {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }

        const chunkBuf = Buffer.from(await request.arrayBuffer());
        const client = await getTgClient(env);
        const fileIdBig = bigInt(fileIdStr);

        const subParts: Array<{ partIndex: number; bytes: Buffer }> = [];
        for (let offset = 0, idx = 0; offset < chunkBuf.length; offset += MTPROTO_CHUNK_SIZE, idx++) {
          const end = Math.min(offset + MTPROTO_CHUNK_SIZE, chunkBuf.length);
          subParts.push({
            partIndex: startPart + idx,
            bytes: chunkBuf.subarray(offset, end),
          });
        }

        // Send in parallel batches of 8 to maximize throughput while staying well within Worker limits
        const BATCH_SIZE = 8;
        for (let i = 0; i < subParts.length; i += BATCH_SIZE) {
          const batch = subParts.slice(i, i + BATCH_SIZE);
          await Promise.all(
            batch.map((p) =>
              client.invoke(
                new Api.upload.SaveBigFilePart({
                  fileId: fileIdBig,
                  filePart: p.partIndex,
                  fileTotalParts: totalParts,
                  bytes: p.bytes,
                })
              )
            )
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
            uploadedParts: subParts.length,
            nextPart: startPart + subParts.length,
          }),
          {
            status: 200,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          }
        );
      }

      // 5C. Finalize Chunked MTProto Upload (POST /finalize-upload)
      // Commits the uploaded InputFileBig parts as a document message in the Telegram channel
      if (url.pathname === "/finalize-upload" && request.method === "POST") {
        const body = (await request.json()) as {
          fileId: string;
          totalParts: number;
          fileName: string;
          totalSize: number;
          path?: string;
          chatId?: string;
          mimeType?: string;
        };
        if (!body.fileId || !body.totalParts || !body.fileName) {
          return new Response(
            JSON.stringify({ error: "fileId, totalParts, and fileName are required" }),
            {
              status: 400,
              headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
            }
          );
        }

        const targetChat = (body.chatId || defaultChatId).trim();
        const client = await getTgClient(env);
        const entity = await client.getInputEntity(targetChat);
        const inputFile = new Api.InputFileBig({
          id: bigInt(body.fileId),
          parts: Number(body.totalParts),
          name: body.fileName,
        });

        const sent = (await client.sendFile(entity, {
          file: inputFile,
          caption: `📦 ${body.fileName}`,
          forceDocument: true,
        })) as any;

        const rawPath = body.path || `/${body.fileName}`;
        const cleanPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
        const mime = body.mimeType || inferMimeFromFilename(body.fileName);

        const newEntry: TgIndexEntry = {
          path: cleanPath,
          name: body.fileName,
          size: Number(body.totalSize || 0),
          msgId: Number(sent.id),
          chatId: targetChat,
          mimeType: mime,
          mtime: Math.floor(Date.now() / 1000),
        };

        cachedManifest.manifest.entries = cachedManifest.manifest.entries.filter(
          (e) => e.path !== newEntry.path && e.msgId !== newEntry.msgId
        );
        cachedManifest.manifest.entries.push(newEntry);
        cachedManifest.manifest.updatedAt = Math.floor(Date.now() / 1000);
        cachedManifest.fetchedAt = Date.now();

        return new Response(JSON.stringify({ ok: true, entry: newEntry }), {
          status: 201,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json",
            "X-Telegram-Msg-Id": String(sent.id),
            "X-Telegram-Chat-Id": targetChat,
          },
        });
      }

      // 6. WebDAV Endpoint (/webdav/...)
      if (url.pathname.startsWith("/webdav")) {
        const subPath = decodeURIComponent(url.pathname.replace(/^\/webdav/, "") || "/");
        const manifest = await loadChannelIndex(env, defaultChatId);

        if (request.method === "PROPFIND") {
          const depth = request.headers.get("Depth") || "1";
          const xml = buildPropfindXml("/webdav", subPath, depth, manifest.entries);
          if (!xml) {
            return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
          }
          return new Response(xml, {
            status: 207,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/xml; charset=utf-8",
              DAV: "1, 2",
            },
          });
        }

        if (request.method === "MKCOL") {
          return new Response(null, {
            status: 201,
            headers: CORS_HEADERS,
          });
        }

        if (request.method === "PUT") {
          const bodyBytes = await request.arrayBuffer();
          const buffer = Buffer.from(bodyBytes);
          const cleanTarget = subPath.replace(/\/+$/, "");
          const fileName = cleanTarget.split("/").filter(Boolean).pop() || "uploaded_file.bin";

          const client = await getTgClient(env);
          const entity = await client.getInputEntity(defaultChatId);
          const toUpload = new CustomFile(fileName, buffer.length, "", buffer);
          const sent = (await client.sendFile(entity, {
            file: toUpload,
            caption: `📦 ${fileName}`,
            forceDocument: true,
          })) as any;

          const mime = inferMimeFromFilename(fileName);
          const newEntry: TgIndexEntry = {
            path: cleanTarget.startsWith("/") ? cleanTarget : `/${cleanTarget}`,
            name: fileName,
            size: buffer.length,
            msgId: sent.id,
            chatId: defaultChatId,
            mimeType: mime,
            mtime: Math.floor(Date.now() / 1000),
          };

          cachedManifest.manifest.entries = cachedManifest.manifest.entries.filter(
            (e) => e.path !== newEntry.path
          );
          cachedManifest.manifest.entries.push(newEntry);
          cachedManifest.fetchedAt = Date.now();

          return new Response(JSON.stringify({ ok: true, entry: newEntry }), {
            status: 201,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
              "X-Telegram-Msg-Id": String(sent.id),
              "X-Telegram-Chat-Id": defaultChatId,
            },
          });
        }

        if (request.method === "DELETE") {
          const cleanTarget = subPath.replace(/\/+$/, "");
          const entry = manifest.entries.find((e) => e.path === cleanTarget);
          if (entry) {
            try {
              const client = await getTgClient(env);
              const entity = await client.getInputEntity(entry.chatId || defaultChatId);
              await client.deleteMessages(entity, [entry.msgId], { revoke: true });
            } catch {
              // ignore delete error from telegram
            }
            cachedManifest.manifest.entries = cachedManifest.manifest.entries.filter(
              (e) => e.path !== cleanTarget
            );
            cachedManifest.fetchedAt = Date.now();
          }
          return new Response(null, {
            status: 204,
            headers: CORS_HEADERS,
          });
        }

        if (request.method === "GET" || request.method === "HEAD") {
          const cleanTarget = subPath.replace(/\/+$/, "");
          // Check stateless path first: /__tg_<msgId>_<size>/<filename>
          const statelessMatch = cleanTarget.match(/^\/__tg_(\d+)_(\d+)\/(.+)$/);
          if (statelessMatch) {
            const msgId = parseInt(statelessMatch[1], 10);
            const size = parseInt(statelessMatch[2], 10);
            const name = statelessMatch[3];
            return await serveTelegramFileRange(
              request,
              env,
              defaultChatId,
              msgId,
              size,
              inferMimeFromFilename(name),
              name
            );
          }

          const entry = manifest.entries.find((e) => e.path === cleanTarget);
          if (!entry) {
            return new Response("File Not Found in Telegram Index", {
              status: 404,
              headers: CORS_HEADERS,
            });
          }
          return await serveTelegramFileRange(
            request,
            env,
            entry.chatId || defaultChatId,
            entry.msgId,
            entry.size,
            entry.mimeType,
            entry.name
          );
        }
      }

      return new Response("RcloneFlix Serverless Telegram Worker Active", {
        status: 200,
        headers: CORS_HEADERS,
      });
    } catch (err: any) {
      return new Response(`Worker Internal Error: ${err.stack || err.message || err}`, {
        status: 500,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/plain",
        },
      });
    }
  },
};
