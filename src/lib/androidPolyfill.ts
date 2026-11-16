/**
 * Cross-platform polyfill for Tauri v2 IPC when running inside Android WebView / Capacitor / Web browser.
 * Ensures all @tauri-apps/api/*, @tauri-apps/plugin-*, and custom Rust invoke() commands
 * seamlessly route to AndroidBridge (native librclone.so + native storage) and browser APIs without crashes.
 */

import packageJson from "../../package.json";

type VirtualFileEntry = {
  name: string;
  text: string;
  bytes: Uint8Array;
};

const virtualFiles = new Map<string, VirtualFileEntry>();

function parseIniRemotes(ini: string): Array<{ name: string; remote_type: string }> {
  const remotes: Array<{ name: string; remote_type: string }> = [];
  const lines = (ini || "").split(/\r?\n/);
  let currentRemote: string | null = null;
  let currentType = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      if (currentRemote) {
        remotes.push({ name: currentRemote, remote_type: currentType || "drive" });
      }
      currentRemote = line.slice(1, -1).trim();
      currentType = "";
    } else if (currentRemote && line.includes("=")) {
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key === "type") {
        currentType = val;
      }
    }
  }
  if (currentRemote) {
    remotes.push({ name: currentRemote, remote_type: currentType || "drive" });
  }
  return remotes;
}

function mergeIniSections(baseIni: string, incomingIni: string): string {
  const parseSections = (content: string) => {
    const map = new Map<string, string[]>();
    let current: string | null = null;
    for (const rawLine of (content || "").split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        current = trimmed.slice(1, -1).trim();
        if (!map.has(current)) map.set(current, []);
      } else if (current) {
        map.get(current)!.push(rawLine);
      }
    }
    return map;
  };

  const baseMap = parseSections(baseIni);
  const incomingMap = parseSections(incomingIni);
  for (const [name, lines] of incomingMap.entries()) {
    baseMap.set(name, lines);
  }

  const out: string[] = [];
  for (const [name, lines] of baseMap.entries()) {
    out.push(`[${name}]`);
    for (const l of lines) {
      if (l.trim()) out.push(l);
    }
    out.push("");
  }
  return out.join("\n");
}

function removeIniSections(baseIni: string, namesToRemove: string[]): string {
  const removeSet = new Set(namesToRemove);
  const out: string[] = [];
  let skipCurrent = false;
  for (const rawLine of (baseIni || "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const sec = trimmed.slice(1, -1).trim();
      skipCurrent = removeSet.has(sec);
    }
    if (!skipCurrent) {
      out.push(rawLine);
    }
  }
  return out.join("\n");
}

let nextAsyncTaskId = 1;
const pendingAsyncTasks = new Map<number, (res: string) => void>();

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function gzipCompressBytes(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return data;
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(data as any);
  writer.close();
  const ab = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(ab);
}

async function gzipDecompressBytes(data: Uint8Array): Promise<Uint8Array> {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b && typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(data as any);
    writer.close();
    const ab = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(ab);
  }
  return data;
}

if (typeof window !== "undefined") {
  (window as any).__resolveAndroidAsyncTask = (taskId: number, base64Result?: string) => {
    const cb = pendingAsyncTasks.get(taskId);
    if (cb) {
      pendingAsyncTasks.delete(taskId);
      try {
        let jsonStr = "";
        const bridge = getBridge();
        if (bridge?.consumeAsyncTaskResult && !base64Result) {
          jsonStr = bridge.consumeAsyncTaskResult(taskId) || "{}";
        } else if (base64Result) {
          const bin = atob(base64Result);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          jsonStr = new TextDecoder().decode(bytes);
        } else {
          jsonStr = "{}";
        }
        cb(jsonStr);
      } catch (err) {
        cb(JSON.stringify({ ok: false, error: String(err) }));
      }
    }
  };
}

function getBridge(): any {
  return typeof window !== "undefined" ? (window as any).AndroidBridge : undefined;
}

async function runBridgeTaskAsync(taskType: string, payload: any): Promise<any> {
  const bridge = getBridge();
  if (typeof bridge?.runAsyncTask === "function") {
    const taskId = nextAsyncTaskId++;
    return new Promise((resolve) => {
      pendingAsyncTasks.set(taskId, (jsonStr: string) => {
        try {
          resolve(JSON.parse(jsonStr));
        } catch {
          resolve({ ok: false, raw: jsonStr });
        }
      });
      try {
        bridge.runAsyncTask(taskId, taskType, JSON.stringify(payload));
      } catch (err) {
        pendingAsyncTasks.delete(taskId);
        resolve({ ok: false, error: String(err) });
      }
    });
  }
  return null;
}

let dbItemsCache: string[] | null = null;
let dbProgressCache: string[] | null = null;
let dbPlaylistsCache: string[] | null = null;
let dbFavsCache: any[] | null = null;
let dbFlushTimeout: any = null;

function flushDbCachesAsync() {
  if (dbFlushTimeout) clearTimeout(dbFlushTimeout);
  dbFlushTimeout = setTimeout(() => {
    if (dbItemsCache) writePersistentText("rcloneflix-db-items", JSON.stringify(dbItemsCache));
    if (dbProgressCache) writePersistentText("rcloneflix-db-progress", JSON.stringify(dbProgressCache));
    if (dbPlaylistsCache) writePersistentText("rcloneflix-db-playlists", JSON.stringify(dbPlaylistsCache));
    if (dbFavsCache) writePersistentText("rcloneflix-db-favs", JSON.stringify(dbFavsCache));
  }, 120);
}

function parseKaggleUserAndSlug(input: string, defaultUser: string): { user: string; slug: string } {
  const clean = (input || "").trim().replace(/^\/+/, "");
  const stripped = clean.startsWith("code/") ? clean.slice(5) : clean;
  const parts = stripped.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return { user: parts[parts.length - 2], slug: parts[parts.length - 1] };
  } else if (parts.length === 1) {
    return { user: defaultUser, slug: parts[0] };
  } else {
    return { user: defaultUser, slug: clean };
  }
}

function unpackPackedJs(packed: string): string | null {
  const match = packed.match(/}\s*\(\s*['"]((?:\\'|[^'])*)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]((?:\\'|[^'])*)['"]\.split\(['"]\|['"]\)/);
  if (!match) return null;
  let p = match[1];
  const a = parseInt(match[2], 10);
  const c = parseInt(match[3], 10);
  const k = match[4].split("|");
  for (let i = c - 1; i >= 0; i--) {
    const key = i.toString(a);
    const val = k[i];
    if (val) {
      p = p.replace(new RegExp(`\\b${key}\\b`, "g"), val);
    }
  }
  return p;
}

function readPersistentText(key: string): string {
  const bridge = getBridge();
  if (typeof bridge?.readStorageFile === "function") {
    try {
      const val = bridge.readStorageFile(key);
      if (val) return val;
    } catch {}
  }
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writePersistentText(key: string, value: string): void {
  const bridge = getBridge();
  if (typeof bridge?.writeStorageFile === "function") {
    try {
      if (bridge.writeStorageFile(key, value)) {
        return;
      }
    } catch {}
  }
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn("Storage write warning:", e);
  }
}

function getRcloneConfigText(): string {
  const bridge = getBridge();
  if (typeof bridge?.getRcloneConfig === "function") {
    try {
      const cfg = bridge.getRcloneConfig();
      if (cfg) return cfg;
    } catch {}
  }
  return readPersistentText("rcloneflix-rclone-config-content");
}

function saveRcloneConfigText(content: string): void {
  const bridge = getBridge();
  if (typeof bridge?.saveRcloneConfig === "function") {
    try {
      bridge.saveRcloneConfig(content || "");
    } catch {}
  }
  writePersistentText("rcloneflix-rclone-config-content", content || "");
}

function percentEncodePath(filePath: string): string {
  return filePath
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function hashRemotePathJs(remotePath: string): string {
  let hash = 5381n;
  const bytes = new TextEncoder().encode(remotePath);
  for (const b of bytes) {
    hash = ((hash * 33n) + BigInt(b)) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function parseMediaFilenameJs(filename: string) {
  const dotIdx = filename.lastIndexOf(".");
  const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;

  const cleanTitle = (raw: string): string => {
    const stripped = raw.replace(
      /\b(1080p|720p|2160p|4k|hdr|web[-.]?dl|webrip|bluray|hdtv|x264|x265|h264|hevc|aac|ddp?\d?\.?\d?|proper|repack|remux|dsnp|atvp|amzn|netflix|hbo)\b.*/i,
      ""
    );
    const cleaned = stripped.replace(/[._-]+/g, " ").trim();
    if (!cleaned) return raw.trim();
    return cleaned
      .split(/\s+/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
      .join(" ");
  };

  const extractYear = (text: string): number | null => {
    const matches = Array.from(text.matchAll(/\b(19\d\d|20\d\d)\b/g));
    if (matches.length === 0) return null;
    return parseInt(matches[matches.length - 1][1], 10);
  };

  const seMatch = stem.match(/[sS](\d{1,2})[eE](\d{1,2})/) || stem.match(/\b(\d{1,2})x(\d{1,2})\b/i);
  if (seMatch && seMatch.index !== undefined) {
    const before = stem.slice(0, seMatch.index);
    return {
      title: cleanTitle(before),
      year: extractYear(before),
      season: parseInt(seMatch[1], 10),
      episode: parseInt(seMatch[2], 10),
      is_episode: true,
    };
  }

  const yearMatches = Array.from(stem.matchAll(/\b(19\d\d|20\d\d)\b/g));
  const lastYearMatch = yearMatches.length > 0 ? yearMatches[yearMatches.length - 1] : null;
  const titlePart = lastYearMatch && lastYearMatch.index !== undefined ? stem.slice(0, lastYearMatch.index) : stem;

  return {
    title: cleanTitle(titlePart),
    year: lastYearMatch ? parseInt(lastYearMatch[1], 10) : null,
    season: null,
    episode: null,
    is_episode: false,
  };
}

function triggerBrowserFileDownload(filename: string, bytes: Uint8Array) {
  try {
    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.split("/").pop() || "export.rflix";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  } catch (e) {
    console.warn("Download trigger failed:", e);
  }
}

async function polyfillFetchText(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
  body = ""
): Promise<{ ok: boolean; status: number; body: string; base64?: string; url: string; set_cookie?: string }> {
  const bridge = getBridge();
  if (typeof bridge?.httpFetch === "function") {
    try {
      const raw = bridge.httpFetch(url, method, JSON.stringify(headers), body);
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.body === "string") {
        return {
          ok: Boolean(parsed.ok),
          status: Number(parsed.status || 200),
          body: parsed.body,
          base64: parsed.base64 || "",
          url: parsed.url || url,
          set_cookie: parsed.set_cookie,
        };
      }
    } catch {}
  }
  try {
    const resp = await window.fetch(url, {
      method,
      headers,
      body: body ? body : undefined,
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, body: text, url: resp.url || url };
  } catch {
    return { ok: false, status: 0, body: "", url };
  }
}

if (typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__) {
  const callbacks = new Map<number, (arg: any) => void>();
  const eventListeners = new Map<string, Set<number>>();
  let nextCallbackId = 1;

  // HTTP plugin state maps
  let nextHttpRid = 100;
  const httpRequests = new Map<number, any>();
  const httpBodies = new Map<number, { buf: Uint8Array; read: boolean }>();

  const registerCallback = (cb: (arg: any) => void, once = false) => {
    const id = nextCallbackId++;
    callbacks.set(id, (arg: any) => {
      if (once) callbacks.delete(id);
      return cb && cb(arg);
    });
    return id;
  };

  const unregisterCallback = (id: number) => {
    callbacks.delete(id);
  };

  const runCallback = (id: number, data: any) => {
    const cb = callbacks.get(id);
    if (cb) cb(data);
  };

  const emitTauriEvent = (event: string, payload: any) => {
    const ids = eventListeners.get(event);
    if (ids) {
      let eventId = 1;
      for (const handlerId of Array.from(ids)) {
        runCallback(handlerId, { event, id: eventId++, payload });
      }
    }
  };

  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, id: number) {
      eventListeners.get(event)?.delete(id);
      callbacks.delete(id);
    },
  };

  (window as any).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
      windows: [{ label: "main" }],
      webviews: [{ windowLabel: "main", label: "main" }],
    },
    plugins: {
      path: {
        sep: "/",
        delimiter: ":",
      },
    },
    callbacks,
    transformCallback: registerCallback,
    unregisterCallback,
    runCallback,
    convertFileSrc(filePath: string, protocol = "asset") {
      if (!filePath) return "";
      if (
        filePath.startsWith("http://") ||
        filePath.startsWith("https://") ||
        filePath.startsWith("data:") ||
        filePath.startsWith("blob:")
      ) {
        return filePath;
      }
      return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
    },
    async invoke(cmd: string, args: any = {}, options?: any) {
      // ── 1. Built-in Tauri Plugins (event, app, window, webview, http, dialog, fs) ──

      if (cmd === "plugin:event|listen") {
        const ev = args.event as string;
        const handlerId = args.handler as number;
        if (ev && handlerId) {
          if (!eventListeners.has(ev)) eventListeners.set(ev, new Set());
          eventListeners.get(ev)!.add(handlerId);
        }
        return handlerId || 1;
      }

      if (cmd === "plugin:event|unlisten") {
        const ev = args.event as string;
        const id = args.eventId as number;
        if (ev && id) {
          eventListeners.get(ev)?.delete(id);
          callbacks.delete(id);
        }
        return null;
      }

      if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
        emitTauriEvent(args.event, args.payload);
        return null;
      }

      if (cmd === "plugin:app|version") return packageJson.version;
      if (cmd === "plugin:app|name") return "RcloneFlix";
      if (cmd === "plugin:app|tauri_version") return "2.0.0";
      if (cmd === "plugin:app|identifier") return "com.rcloneflix.app";

      if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) {
        if (cmd.endsWith("get_all_windows")) return ["main"];
        if (cmd.endsWith("get_all_webviews")) return [{ windowLabel: "main", label: "main" }];
        if (cmd.endsWith("set_fullscreen")) {
          const val = Boolean(args?.value ?? args?.fullscreen);
          (window as any).__RCLONEFLIX_FULLSCREEN__ = val;
          try {
            getBridge()?.setFullscreen?.(val);
          } catch {}
          return null;
        }
        if (cmd.endsWith("is_fullscreen")) {
          return Boolean((window as any).__RCLONEFLIX_FULLSCREEN__ || document.fullscreenElement);
        }
        return null;
      }

      // @tauri-apps/plugin-http polyfill via browser fetch + native AndroidBridge.httpFetch fallback
      if (cmd === "plugin:http|fetch") {
        const rid = nextHttpRid++;
        httpRequests.set(rid, args.clientConfig);
        return rid;
      }

      if (cmd === "plugin:http|fetch_send") {
        const reqConfig = httpRequests.get(args.rid);
        httpRequests.delete(args.rid);
        if (!reqConfig) throw new Error("Invalid HTTP request rid");

        const headers = new Headers();
        const rawHeadersObj: Record<string, string> = {};
        let hasCustomRefOrOrigin = false;
        if (Array.isArray(reqConfig.headers)) {
          for (const [k, v] of reqConfig.headers) {
            const lower = String(k).toLowerCase();
            rawHeadersObj[String(k)] = String(v);
            if (lower === "referer" || lower === "origin") {
              hasCustomRefOrOrigin = true;
            }
            // Skip forbidden browser headers that cause TypeError in WebView fetch
            if (lower === "user-agent" || lower === "host" || lower === "referer" || lower === "origin") continue;
            try {
              headers.append(k, String(v));
            } catch {}
          }
        }

        const bridge = getBridge();
        const urlStr = String(reqConfig.url || "");
        const isLocalHost = urlStr.startsWith("http://127.0.0.1") || urlStr.startsWith("http://localhost");
        const shouldUseBridge = (!isLocalHost || hasCustomRefOrOrigin) &&
          (typeof bridge?.runAsyncTask === "function" || typeof bridge?.httpFetch === "function");

        if (shouldUseBridge) {
          let bodyStr = "";
          if (typeof reqConfig.data === "string") {
            bodyStr = reqConfig.data;
          } else if (reqConfig.data instanceof Uint8Array || Array.isArray(reqConfig.data)) {
            const arr = reqConfig.data instanceof Uint8Array ? reqConfig.data : new Uint8Array(reqConfig.data);
            let bin = "";
            const chunk = 0x8000;
            for (let i = 0; i < arr.length; i += chunk) {
              bin += String.fromCharCode(...arr.subarray(i, i + chunk));
            }
            bodyStr = "__BASE64__:" + btoa(bin);
          }
          let parsed: any;
          if (typeof bridge?.runAsyncTask === "function") {
            try {
              parsed = await runBridgeTaskAsync("httpFetch", {
                url: urlStr,
                method: reqConfig.method || "GET",
                headersJson: JSON.stringify(rawHeadersObj),
                body: bodyStr,
              });
            } catch {
              if (typeof bridge?.httpFetch === "function") {
                const rawRes = bridge.httpFetch(
                  urlStr,
                  reqConfig.method || "GET",
                  JSON.stringify(rawHeadersObj),
                  bodyStr
                );
                parsed = typeof rawRes === "string" ? JSON.parse(rawRes) : rawRes;
              }
            }
          } else if (typeof bridge?.httpFetch === "function") {
            const rawRes = bridge.httpFetch(
              urlStr,
              reqConfig.method || "GET",
              JSON.stringify(rawHeadersObj),
              bodyStr
            );
            parsed = typeof rawRes === "string" ? JSON.parse(rawRes) : rawRes;
          }

          let buf: Uint8Array;
          if (parsed?.base64) {
            try {
              const bin = atob(parsed.base64);
              buf = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            } catch {
              buf = new TextEncoder().encode(parsed?.body || "");
            }
          } else {
            buf = new TextEncoder().encode(parsed?.body || "");
          }

          const responseRid = nextHttpRid++;
          httpBodies.set(responseRid, { buf, read: false });

          const respHeaders: Array<[string, string]> = [];
          if (parsed?.headers && typeof parsed.headers === "object") {
            for (const [k, v] of Object.entries(parsed.headers)) {
              respHeaders.push([k, String(v)]);
            }
          } else {
            respHeaders.push(["content-type", "application/json"]);
          }
          if (parsed?.set_cookie) {
            respHeaders.push(["set-cookie", parsed.set_cookie]);
          }

          return {
            status: parsed?.status || (parsed?.ok ? 200 : 500),
            statusText: parsed?.ok ? "OK" : "Error",
            url: parsed?.url || urlStr,
            headers: respHeaders,
            rid: responseRid,
          };
        }

        try {
          const resp = await window.fetch(reqConfig.url, {
            method: reqConfig.method || "GET",
            headers,
            body: reqConfig.data ? new Uint8Array(reqConfig.data) : undefined,
          });

          const arrayBuf = await resp.arrayBuffer();
          const responseRid = nextHttpRid++;
          httpBodies.set(responseRid, { buf: new Uint8Array(arrayBuf), read: false });

          const respHeaders: Array<[string, string]> = [];
          resp.headers.forEach((v, k) => respHeaders.push([k, v]));

          return {
            status: resp.status,
            statusText: resp.statusText || "OK",
            url: resp.url || reqConfig.url,
            headers: respHeaders,
            rid: responseRid,
          };
        } catch (fetchErr) {
          if (typeof bridge?.httpFetch === "function" || typeof bridge?.runAsyncTask === "function") {
            let bodyStr = "";
            if (typeof reqConfig.data === "string") {
              bodyStr = reqConfig.data;
            } else if (reqConfig.data instanceof Uint8Array || Array.isArray(reqConfig.data)) {
              const arr = reqConfig.data instanceof Uint8Array ? reqConfig.data : new Uint8Array(reqConfig.data);
              let bin = "";
              const chunk = 0x8000;
              for (let i = 0; i < arr.length; i += chunk) {
                bin += String.fromCharCode(...arr.subarray(i, i + chunk));
              }
              bodyStr = "__BASE64__:" + btoa(bin);
            }
            let parsed: any;
            if (typeof bridge?.runAsyncTask === "function") {
              try {
                parsed = await runBridgeTaskAsync("httpFetch", {
                  url: urlStr,
                  method: reqConfig.method || "GET",
                  headersJson: JSON.stringify(rawHeadersObj),
                  body: bodyStr,
                });
              } catch {
                if (typeof bridge?.httpFetch === "function") {
                  const rawRes = bridge.httpFetch(
                    urlStr,
                    reqConfig.method || "GET",
                    JSON.stringify(rawHeadersObj),
                    bodyStr
                  );
                  parsed = typeof rawRes === "string" ? JSON.parse(rawRes) : rawRes;
                }
              }
            } else if (typeof bridge?.httpFetch === "function") {
              const rawRes = bridge.httpFetch(
                urlStr,
                reqConfig.method || "GET",
                JSON.stringify(rawHeadersObj),
                bodyStr
              );
              parsed = typeof rawRes === "string" ? JSON.parse(rawRes) : rawRes;
            }

            let buf: Uint8Array;
            if (parsed?.base64) {
              try {
                const bin = atob(parsed.base64);
                buf = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
              } catch {
                buf = new TextEncoder().encode(parsed?.body || "");
              }
            } else {
              buf = new TextEncoder().encode(parsed?.body || "");
            }

            const responseRid = nextHttpRid++;
            httpBodies.set(responseRid, { buf, read: false });

            const respHeaders: Array<[string, string]> = [];
            if (parsed?.headers && typeof parsed.headers === "object") {
              for (const [k, v] of Object.entries(parsed.headers)) {
                respHeaders.push([k, String(v)]);
              }
            } else {
              respHeaders.push(["content-type", "text/plain"]);
            }
            if (parsed?.set_cookie) {
              respHeaders.push(["set-cookie", parsed.set_cookie]);
            }

            return {
              status: parsed?.status || (parsed?.ok ? 200 : 500),
              statusText: parsed?.ok ? "OK" : "Error",
              url: parsed?.url || urlStr,
              headers: respHeaders,
              rid: responseRid,
            };
          }
          throw fetchErr;
        }
      }

      if (cmd === "plugin:http|fetch_read_body") {
        const entry = httpBodies.get(args.rid);
        if (!entry || entry.read) {
          httpBodies.delete(args.rid);
          // Last byte = 1 signals stream close to @tauri-apps/plugin-http
          return [1];
        }
        entry.read = true;
        const out = new Uint8Array(entry.buf.length + 1);
        out.set(entry.buf, 0);
        out[entry.buf.length] = 0; // Last byte = 0 means enqueue data
        return Array.from(out);
      }

      if (cmd === "plugin:http|fetch_cancel" || cmd === "plugin:http|fetch_cancel_body") {
        httpRequests.delete(args.rid);
        httpBodies.delete(args.rid);
        return null;
      }

      // @tauri-apps/plugin-dialog polyfill with Built-In Android TV D-Pad File Explorer
      if (cmd === "plugin:dialog|open") {
        const opts = args.options || args;
        const bridge = (window as any).AndroidBridge;

        const openHtmlFileInputFallback = (): Promise<any> =>
          new Promise((resolve) => {
            const input = document.createElement("input");
            input.type = "file";
            input.style.position = "fixed";
            input.style.top = "-9999px";
            input.style.left = "-9999px";
            input.style.opacity = "0";
            if (opts?.multiple) input.multiple = true;
            input.accept = "*/*";
            document.body.appendChild(input);

            let settled = false;
            const finish = (val: any) => {
              if (settled) return;
              settled = true;
              try {
                if (input.parentNode) input.parentNode.removeChild(input);
              } catch {}
              resolve(val);
            };

            input.onchange = async () => {
              const files = input.files;
              if (!files || files.length === 0) {
                finish(null);
                return;
              }
              const paths: string[] = [];
              for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const buf = await file.arrayBuffer();
                const bytes = new Uint8Array(buf);
                const lowerName = file.name.toLowerCase();
                const isBinaryPass =
                  lowerName.endsWith(".rflix") ||
                  lowerName.endsWith(".db") ||
                  lowerName.endsWith(".bin") ||
                  bytes.byteLength > 2 * 1024 * 1024;
                let text = "";
                if (!isBinaryPass) {
                  try {
                    text = new TextDecoder().decode(bytes);
                  } catch {}
                }
                const vPath = `/android-picked/${file.name}`;
                virtualFiles.set(vPath, { name: file.name, text, bytes });
                if (file.name.endsWith(".conf") || file.name.endsWith(".config")) {
                  saveRcloneConfigText(text);
                }
                paths.push(vPath);
              }
              finish(opts?.multiple ? paths : paths[0]);
            };

            input.oncancel = () => finish(null);
            input.click();
          });

        // Use Built-In D-Pad File Explorer when listLocalDirectory is available on Android TV
        if (bridge && typeof bridge.listLocalDirectory === "function" && bridge.isTv?.()) {
          return new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.setAttribute("role", "dialog");
            overlay.setAttribute("aria-modal", "true");
            overlay.className =
              "fixed inset-0 z-[100] bg-black/85 backdrop-blur-md flex items-center justify-center p-6 font-body text-white";

            let currentDir = "";

            const cleanup = (result: any) => {
              try {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
              } catch {}
              resolve(result);
            };

            const formatBytes = (b: number) => {
              if (!b || b <= 0) return "0 B";
              if (b < 1024) return `${b} B`;
              if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
              return `${(b / (1024 * 1024)).toFixed(1)} MB`;
            };

            const renderDirectory = (dirPath: string) => {
              currentDir = dirPath;
              let data: any = {};
              try {
                data = JSON.parse(bridge.listLocalDirectory(dirPath) || "{}");
              } catch {}

              const roots: Array<{ label: string; path: string }> = data.roots || [];
              const entries: Array<{ name: string; path: string; isDir: boolean; size: number }> =
                data.entries || [];
              const hasPerm = data.hasPermission !== false;

              overlay.innerHTML = `
                <div class="w-full max-w-3xl bg-[#12161f] border border-[#E8A020]/40 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
                  <div class="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-[#0b0e14]">
                    <div>
                      <h2 class="text-lg font-bold text-white flex items-center gap-2">
                        <span>📂 Select File (.rflix Pass or rclone.conf)</span>
                      </h2>
                      <p class="text-xs font-mono text-white/60 truncate max-w-xl mt-0.5">${data.currentPath || "/sdcard/Download"}</p>
                    </div>
                    <div class="flex items-center gap-2">
                      <button type="button" id="tv-fp-sys" class="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs text-white border border-white/15">
                        System Picker
                      </button>
                      <button type="button" id="tv-fp-close" data-close-modal="true" title="Close" class="px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-xs text-red-300 border border-red-500/30">
                        Cancel
                      </button>
                    </div>
                  </div>

                  <div class="px-6 py-2.5 bg-[#0e121a] border-b border-white/10 flex items-center gap-2 flex-wrap">
                    ${roots
                      .map(
                        (r, idx) => `
                      <button type="button" data-root-idx="${idx}" class="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                        data.currentPath === r.path
                          ? "bg-[#E8A020] text-black border-[#E8A020]"
                          : "bg-white/5 text-white/80 border-white/10 hover:bg-white/10"
                      }">
                        ${r.label}
                      </button>
                    `
                      )
                      .join("")}
                    <button type="button" id="tv-fp-refresh" class="px-3 py-1.5 rounded-lg text-xs bg-white/5 text-white/70 border border-white/10 hover:bg-white/10 ml-auto">
                      ↻ Refresh
                    </button>
                  </div>

                  ${
                    !hasPerm
                      ? `
                    <div class="mx-6 mt-4 p-4 rounded-xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-between gap-4">
                      <div class="text-xs text-amber-200">
                        <strong>Storage Permission Required:</strong> Allow storage access so RcloneFlix can read downloaded <code>.rflix</code> passes and <code>rclone.conf</code> files from your TV's Downloads folder or USB drive.
                      </div>
                      <button type="button" id="tv-fp-perm" data-tv-autofocus="true" class="px-4 py-2 rounded-xl bg-[#E8A020] text-black font-bold text-xs shrink-0">
                        Grant Permission
                      </button>
                    </div>
                  `
                      : ""
                  }

                  <div id="tv-fp-list" class="flex-1 overflow-y-auto p-4 space-y-1.5">
                    ${
                      data.parentPath
                        ? `
                      <button type="button" id="tv-fp-parent" class="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-left text-sm">
                        <span class="font-semibold text-white/90">⬆️ .. (Parent Folder)</span>
                        <span class="text-xs text-white/40 font-mono">Folder</span>
                      </button>
                    `
                        : ""
                    }
                    ${
                      entries.length === 0
                        ? `<div class="py-12 text-center text-sm text-white/50">No files found in this folder. Tip: Place your <code>.rflix</code> pass in <b>Downloads</b> or use Wi-Fi Pairing.</div>`
                        : entries
                            .map((entry, idx) => {
                              const lower = entry.name.toLowerCase();
                              const isSpecial =
                                !entry.isDir && (lower.endsWith(".rflix") || lower.endsWith(".conf"));
                              return `
                              <button
                                type="button"
                                data-entry-idx="${idx}"
                                ${idx === 0 && hasPerm ? 'data-tv-autofocus="true"' : ""}
                                class="w-full flex items-center justify-between px-4 py-3 rounded-xl border text-left transition-colors ${
                                  isSpecial
                                    ? "bg-[#E8A020]/15 border-[#E8A020]/50 text-[#E8A020] font-semibold"
                                    : "bg-white/[0.03] hover:bg-white/10 border-white/10 text-white"
                                }"
                              >
                                <span class="truncate pr-4">${entry.isDir ? "📁" : isSpecial ? "🔑" : "📄"} ${entry.name}</span>
                                <span class="text-xs font-mono shrink-0 ${isSpecial ? "text-[#E8A020]" : "text-white/50"}">
                                  ${entry.isDir ? "Folder" : formatBytes(entry.size)}
                                </span>
                              </button>
                            `;
                            })
                            .join("")
                    }
                  </div>
                </div>
              `;

              overlay.querySelector("#tv-fp-close")?.addEventListener("click", () => cleanup(null));
              overlay.querySelector("#tv-fp-sys")?.addEventListener("click", async () => {
                cleanup(await openHtmlFileInputFallback());
              });
              overlay.querySelector("#tv-fp-refresh")?.addEventListener("click", () => {
                renderDirectory(currentDir);
              });
              overlay.querySelector("#tv-fp-perm")?.addEventListener("click", () => {
                bridge.requestStoragePermission?.();
                setTimeout(() => renderDirectory(currentDir), 1500);
              });
              overlay.querySelector("#tv-fp-parent")?.addEventListener("click", () => {
                if (data.parentPath) renderDirectory(data.parentPath);
              });

              overlay.querySelectorAll<HTMLElement>("[data-root-idx]").forEach((btn) => {
                btn.addEventListener("click", () => {
                  const rIdx = Number(btn.dataset.rootIdx);
                  if (roots[rIdx]) renderDirectory(roots[rIdx].path);
                });
              });

              overlay.querySelectorAll<HTMLElement>("[data-entry-idx]").forEach((btn) => {
                btn.addEventListener("click", () => {
                  const eIdx = Number(btn.dataset.entryIdx);
                  const entry = entries[eIdx];
                  if (!entry) return;
                  if (entry.isDir) {
                    renderDirectory(entry.path);
                    return;
                  }
                  const b64 = String(bridge.readLocalFileBase64?.(entry.path) || "");
                  if (!b64) return;
                  const binStr = atob(b64);
                  const bytes = new Uint8Array(binStr.length);
                  for (let i = 0; i < binStr.length; i++) {
                    bytes[i] = binStr.charCodeAt(i);
                  }
                  const lowerName = entry.name.toLowerCase();
                  const isBinaryPass =
                    lowerName.endsWith(".rflix") ||
                    lowerName.endsWith(".db") ||
                    lowerName.endsWith(".bin") ||
                    bytes.byteLength > 2 * 1024 * 1024;
                  let text = "";
                  if (!isBinaryPass) {
                    try {
                      text = new TextDecoder().decode(bytes);
                    } catch {}
                  }
                  const vPath = `/android-picked/${entry.name}`;
                  virtualFiles.set(vPath, { name: entry.name, text, bytes });
                  if (lowerName.endsWith(".conf") || lowerName.endsWith(".config")) {
                    saveRcloneConfigText(text);
                  }
                  cleanup(opts?.multiple ? [vPath] : vPath);
                });
              });

              setTimeout(() => {
                const autoBtn =
                  overlay.querySelector<HTMLElement>('[data-tv-autofocus="true"]') ||
                  overlay.querySelector<HTMLElement>("button");
                autoBtn?.focus();
              }, 60);
            };

            document.body.appendChild(overlay);
            renderDirectory("");
          });
        }

        return openHtmlFileInputFallback();
      }

      if (cmd === "plugin:dialog|save") {
        const opts = args.options || args;
        const defaultName = opts?.defaultPath || "export.rflix";
        return `/android-save/${defaultName}`;
      }

      // @tauri-apps/plugin-fs polyfill
      if (cmd === "plugin:fs|read_text_file" || cmd === "plugin:fs|read_file") {
        const rawHeaderPath = options?.headers?.path ? decodeURIComponent(String(options.headers.path)) : "";
        const p = String(args?.path || rawHeaderPath || "");
        const vf = virtualFiles.get(p);
        const encodeForPluginFs = (text: string) => new TextEncoder().encode(text);
        if (vf) {
          return cmd === "plugin:fs|read_file" ? Array.from(vf.bytes) : encodeForPluginFs(vf.text);
        }
        const cfg = getRcloneConfigText();
        return cmd === "plugin:fs|read_file"
          ? Array.from(new TextEncoder().encode(cfg))
          : encodeForPluginFs(cfg);
      }

      if (cmd === "plugin:fs|write_text_file" || cmd === "plugin:fs|write_file") {
        const rawHeaderPath = options?.headers?.path ? decodeURIComponent(String(options.headers.path)) : "";
        const p = String(args?.path || rawHeaderPath || "");
        let contents = "";
        if (typeof args?.contents === "string") {
          contents = args.contents;
        } else if (args instanceof Uint8Array || args instanceof ArrayBuffer || ArrayBuffer.isView(args)) {
          const view = args instanceof Uint8Array
            ? args
            : args instanceof ArrayBuffer
              ? new Uint8Array(args)
              : new Uint8Array(args.buffer, args.byteOffset, args.byteLength);
          contents = new TextDecoder().decode(view);
        } else if (Array.isArray(args)) {
          contents = new TextDecoder().decode(new Uint8Array(args));
        } else if (args?.data) {
          contents = new TextDecoder().decode(new Uint8Array(args.data));
        } else if (Array.isArray(args?.contents)) {
          contents = new TextDecoder().decode(new Uint8Array(args.contents));
        }

        if (p.endsWith(".conf") || p.includes("rclone") || (contents.includes("[") && contents.includes("type"))) {
          saveRcloneConfigText(contents);
          return null;
        }
        const bytes = new TextEncoder().encode(contents);
        triggerBrowserFileDownload(p, bytes);
        return null;
      }

      // ── 2. Custom Application Rust Commands ──────────────────────────────────

      if (cmd === "get_local_ip") {
        const bridge = getBridge();
        if (typeof bridge?.getLocalIp === "function") {
          return bridge.getLocalIp();
        }
        return "127.0.0.1";
      }

      if (cmd === "get_rclone_version") {
        return "rclone v1.68.1 (Android Native)";
      }

      if (cmd === "read_local_file_bytes" || cmd === "read_binary_file") {
        const p = String(args.path || args.filePath || "");
        let vf = virtualFiles.get(p);
        const bridge = getBridge();
        if (!vf && (p.includes(":") || p.startsWith("/"))) {
          try {
            let b64 = "";
            if (typeof bridge?.runAsyncTask === "function") {
              const res = await runBridgeTaskAsync("readRemoteBase64", { remotePath: p });
              b64 = res?.base64 || "";
            } else if (typeof bridge?.readRemoteBase64 === "function") {
              b64 = bridge.readRemoteBase64(p);
            }
            if (b64) {
              const bin = atob(b64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              vf = { name: p.split("/").pop() || "file", text: "", bytes };
              virtualFiles.set(p, vf);
            }
          } catch {}
        }
        if (vf) {
          if (cmd === "read_binary_file") {
            return vf.bytes.buffer.slice(vf.bytes.byteOffset, vf.bytes.byteOffset + vf.bytes.byteLength);
          }
          return vf.bytes;
        }
        return cmd === "read_binary_file" ? new ArrayBuffer(0) : new Uint8Array(0);
      }

      if (cmd === "download_book_to_temp") {
        const remotePath = String(args.remotePath || args.remote_path || "").trim();
        const sessionId = String(args.sessionId || args.session_id || "default_session");
        const rawFilename = remotePath.split("/").filter(Boolean).pop() || "book";
        const filename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
        const tempKey = `/tmp/rcloneflix-books/${sessionId}/${filename}`;

        const existing = virtualFiles.get(tempKey);
        if (existing && existing.bytes && existing.bytes.length > 0) {
          return tempKey;
        }

        const bridge = getBridge();
        let bytes: Uint8Array = new Uint8Array(0);

        if (remotePath.startsWith("http://") || remotePath.startsWith("https://")) {
          let parsed: any;
          if (typeof bridge?.runAsyncTask === "function") {
            try {
              parsed = await runBridgeTaskAsync("httpFetch", { url: remotePath, method: "GET" });
            } catch {
              if (typeof bridge?.httpFetch === "function") {
                const raw = bridge.httpFetch(remotePath, "GET", "{}", "");
                parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
              }
            }
          } else if (typeof bridge?.httpFetch === "function") {
            const raw = bridge.httpFetch(remotePath, "GET", "{}", "");
            parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          }

          if (parsed?.base64) {
            const bin = atob(parsed.base64);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } else if (parsed?.body) {
            bytes = new TextEncoder().encode(parsed.body);
          } else {
            const resp = await window.fetch(remotePath);
            const ab = await resp.arrayBuffer();
            bytes = new Uint8Array(ab);
          }
        } else {
          // Stream binary directly from rclone serve http on 127.0.0.1:8085 to avoid Base64 OOM
          const colonIdx = remotePath.indexOf(":");
          if (colonIdx > 0 && typeof bridge?.runAsyncTask === "function") {
            try {
              const remoteRoot = remotePath.slice(0, colonIdx + 1);
              const relPath = remotePath.slice(colonIdx + 1).replace(/^\/+/, "");
              const srv = await runBridgeTaskAsync("startRclone", { remoteRoot, port: 8085 });
              const port = srv?.port ?? 8085;
              if (port > 0) {
                const fileUrl = `http://127.0.0.1:${port}/${percentEncodePath(relPath)}`;
                const resp = await window.fetch(fileUrl);
                if (resp.ok) {
                  const ab = await resp.arrayBuffer();
                  bytes = new Uint8Array(ab);
                }
              }
            } catch {}
          }
          if (bytes.length === 0) {
            let b64 = "";
            if (typeof bridge?.runAsyncTask === "function") {
              try {
                const res = await runBridgeTaskAsync("readRemoteBase64", { remotePath });
                b64 = res?.base64 || "";
              } catch {}
            } else if (typeof bridge?.readRemoteBase64 === "function") {
              b64 = bridge.readRemoteBase64(remotePath);
            }
            if (b64) {
              const bin = atob(b64);
              bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            }
          }
        }

        if (bytes.length === 0) {
          throw new Error(`Failed to load ebook from ${remotePath}`);
        }

        virtualFiles.set(tempKey, {
          name: filename,
          text: "",
          bytes,
        });

        return tempKey;
      }

      if (cmd === "cleanup_book_temp") {
        const sessionId = String(args.sessionId || args.session_id || "");
        if (sessionId) {
          const prefix = `/tmp/rcloneflix-books/${sessionId}/`;
          for (const k of Array.from(virtualFiles.keys())) {
            if (k.startsWith(prefix)) {
              virtualFiles.delete(k);
            }
          }
        }
        return null;
      }

      if (cmd === "write_local_file_bytes") {
        const p = String(args.path || "export.rflix");
        const bytes = new Uint8Array(args.bytes || []);
        virtualFiles.set(p, {
          name: p.split("/").pop() || "file",
          text: "",
          bytes,
        });
        triggerBrowserFileDownload(p, bytes);
        return null;
      }

      // ── Library DB Storage (Unlimited Native File Storage on Android) ────────

      if (cmd === "library_migration_done") return true;
      if (cmd === "library_mark_migrated") return null;

      if (cmd === "library_count") {
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            const res = await runBridgeTaskAsync("dbCount", {});
            if (typeof res?.count === "number" && res.count > 0) {
              return res.count;
            }
          } catch {}
        }
        if (dbItemsCache !== null) return dbItemsCache.length;
        try {
          const raw = readPersistentText("rcloneflix-db-items");
          const arr = raw ? JSON.parse(raw) : [];
          dbItemsCache = Array.isArray(arr) ? arr : [];
          return dbItemsCache.length;
        } catch {
          return 0;
        }
      }

      if (cmd === "library_load_all") {
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            const meta = await runBridgeTaskAsync("dbLoadMeta", {});
            const allItems: string[] = [];
            const PAGE_SIZE = 500;
            let offset = 0;
            while (true) {
              const page = await runBridgeTaskAsync("dbLoadItemsPage", { offset, limit: PAGE_SIZE });
              if (!Array.isArray(page) || page.length === 0) break;
              for (let i = 0; i < page.length; i++) {
                allItems.push(typeof page[i] === "string" ? page[i] : JSON.stringify(page[i]));
              }
              if (page.length < PAGE_SIZE) break;
              offset += PAGE_SIZE;
            }
            if (allItems.length > 0 || (meta && (meta.progress?.length > 0 || meta.playlists?.length > 0 || meta.favorites?.length > 0))) {
              return {
                items: allItems,
                progress: (meta?.progress || []).map((p: any) => typeof p === "string" ? p : JSON.stringify(p)),
                playlists: (meta?.playlists || []).map((p: any) => typeof p === "string" ? p : JSON.stringify(p)),
                favorites: meta?.favorites || [],
              };
            }
            // One-time automatic migration from legacy flat JSON files into SQLite
            const rawItems = readPersistentText("rcloneflix-db-items");
            const legacyItems: string[] = rawItems ? JSON.parse(rawItems) : [];
            if (legacyItems.length > 0) {
              const batch = legacyItems.map((s) => {
                try {
                  const p = JSON.parse(s);
                  return { id: String(p.id || ""), libraryId: String(p.libraryId || ""), data: s };
                } catch {
                  return null;
                }
              }).filter(Boolean);
              if (batch.length > 0) {
                await runBridgeTaskAsync("dbUpsertItems", { itemsJson: JSON.stringify(batch) });
              }
            }
          } catch (e) {
            console.warn("SQLite library_load_all fallback:", e);
          }
        }
        try {
          if (dbItemsCache === null) {
            const rawItems = readPersistentText("rcloneflix-db-items");
            dbItemsCache = rawItems ? JSON.parse(rawItems) : [];
          }
          if (dbProgressCache === null) {
            const rawProg = readPersistentText("rcloneflix-db-progress");
            dbProgressCache = rawProg ? JSON.parse(rawProg) : [];
          }
          if (dbPlaylistsCache === null) {
            const rawPlaylists = readPersistentText("rcloneflix-db-playlists");
            dbPlaylistsCache = rawPlaylists ? JSON.parse(rawPlaylists) : [];
          }
          if (dbFavsCache === null) {
            const rawFavs = readPersistentText("rcloneflix-db-favs");
            dbFavsCache = rawFavs ? JSON.parse(rawFavs) : [];
          }
          return {
            items: dbItemsCache || [],
            progress: dbProgressCache || [],
            playlists: dbPlaylistsCache || [],
            favorites: dbFavsCache || [],
          };
        } catch {
          return { items: [], progress: [], playlists: [], favorites: [] };
        }
      }

      if (cmd === "library_upsert_progress_batch") {
        const list: Array<{ itemId: string; data: string }> = args.progressList || [];
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            await runBridgeTaskAsync("dbUpsertProgressBatch", { progressJson: JSON.stringify(list) });
            return null;
          } catch {}
        }
        try {
          if (dbProgressCache === null) {
            const rawProg = readPersistentText("rcloneflix-db-progress");
            dbProgressCache = rawProg ? JSON.parse(rawProg) : [];
          }
          const map = new Map<string, string>();
          for (const s of (dbProgressCache || [])) {
            try {
              const p = JSON.parse(s);
              map.set(p.itemId, s);
            } catch {}
          }
          for (const item of list) {
            map.set(item.itemId, item.data);
          }
          dbProgressCache = Array.from(map.values());
          flushDbCachesAsync();
        } catch {}
        return null;
      }

      if (cmd === "library_upsert_items") {
        const incoming: Array<{ id: string; libraryId: string; data: string }> = args.items || [];
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            await runBridgeTaskAsync("dbUpsertItems", { itemsJson: JSON.stringify(incoming) });
            return null;
          } catch {}
        }
        try {
          if (dbItemsCache === null) {
            const rawItems = readPersistentText("rcloneflix-db-items");
            dbItemsCache = rawItems ? JSON.parse(rawItems) : [];
          }
          const map = new Map<string, string>();
          for (const s of (dbItemsCache || [])) {
            try {
              const p = JSON.parse(s);
              map.set(p.id, s);
            } catch {}
          }
          for (const item of incoming) {
            map.set(item.id, item.data);
          }
          dbItemsCache = Array.from(map.values());
          flushDbCachesAsync();
        } catch (e) {
          console.warn("library_upsert_items warning:", e);
        }
        return null;
      }

      if (cmd === "library_remove_items") {
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            await runBridgeTaskAsync("dbRemoveItems", { idsJson: JSON.stringify(args.ids || []) });
            return null;
          } catch {}
        }
        try {
          if (dbItemsCache === null) {
            const rawItems = readPersistentText("rcloneflix-db-items");
            dbItemsCache = rawItems ? JSON.parse(rawItems) : [];
          }
          const removeIds = new Set(args.ids || []);
          dbItemsCache = (dbItemsCache || []).filter((s) => {
            try {
              const p = JSON.parse(s);
              return !removeIds.has(p.id);
            } catch {
              return true;
            }
          });
          flushDbCachesAsync();
        } catch {}
        return null;
      }

      if (cmd === "library_clear_library") {
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            await runBridgeTaskAsync("dbClearLibrary", { libraryId: String(args.libraryId || "") });
            return null;
          } catch {}
        }
        try {
          if (dbItemsCache === null) {
            const rawItems = readPersistentText("rcloneflix-db-items");
            dbItemsCache = rawItems ? JSON.parse(rawItems) : [];
          }
          const libId = args.libraryId;
          dbItemsCache = (dbItemsCache || []).filter((s) => {
            try {
              const p = JSON.parse(s);
              return p.libraryId !== libId;
            } catch {
              return true;
            }
          });
          flushDbCachesAsync();
        } catch {}
        return null;
      }

      if (cmd === "library_set_progress") {
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            await runBridgeTaskAsync("dbSetProgress", { itemId: String(args.itemId || ""), data: String(args.data || "{}") });
            return null;
          } catch {}
        }
        try {
          if (dbProgressCache === null) {
            const rawProg = readPersistentText("rcloneflix-db-progress");
            dbProgressCache = rawProg ? JSON.parse(rawProg) : [];
          }
          const map = new Map<string, string>();
          for (const s of (dbProgressCache || [])) {
            try {
              const p = JSON.parse(s);
              map.set(p.itemId, s);
            } catch {}
          }
          if (args.itemId && args.data) {
            map.set(args.itemId, args.data);
          }
          dbProgressCache = Array.from(map.values());
          flushDbCachesAsync();
        } catch {}
        return null;
      }

      if (cmd === "library_remove_progress") {
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            await runBridgeTaskAsync("dbRemoveProgress", { itemId: String(args.itemId || "") });
            return null;
          } catch {}
        }
        try {
          if (dbProgressCache === null) {
            const rawProg = readPersistentText("rcloneflix-db-progress");
            dbProgressCache = rawProg ? JSON.parse(rawProg) : [];
          }
          dbProgressCache = (dbProgressCache || []).filter((s) => {
            try {
              const p = JSON.parse(s);
              return p.itemId !== args.itemId;
            } catch {
              return true;
            }
          });
          flushDbCachesAsync();
        } catch {}
        return null;
      }

      if (cmd === "library_upsert_playlists") {
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            await runBridgeTaskAsync("dbUpsertPlaylists", { playlistsJson: JSON.stringify(args.playlists || []) });
            return null;
          } catch {}
        }
        try {
          if (dbPlaylistsCache === null) {
            const raw = readPersistentText("rcloneflix-db-playlists");
            dbPlaylistsCache = raw ? JSON.parse(raw) : [];
          }
          const map = new Map<string, string>();
          for (const s of (dbPlaylistsCache || [])) {
            try {
              const p = JSON.parse(s);
              map.set(p.id, s);
            } catch {}
          }
          for (const pl of args.playlists || []) {
            map.set(pl.id, pl.data);
          }
          dbPlaylistsCache = Array.from(map.values());
          flushDbCachesAsync();
        } catch {}
        return null;
      }

      if (cmd === "library_remove_playlists") {
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            await runBridgeTaskAsync("dbRemovePlaylists", { idsJson: JSON.stringify(args.ids || []) });
            return null;
          } catch {}
        }
        try {
          if (dbPlaylistsCache === null) {
            const raw = readPersistentText("rcloneflix-db-playlists");
            dbPlaylistsCache = raw ? JSON.parse(raw) : [];
          }
          const removeIds = new Set(args.ids || []);
          dbPlaylistsCache = (dbPlaylistsCache || []).filter((s) => {
            try {
              const p = JSON.parse(s);
              return !removeIds.has(p.id);
            } catch {
              return true;
            }
          });
          flushDbCachesAsync();
        } catch {}
        return null;
      }

      if (cmd === "library_set_favorites") {
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            for (const f of args.favorites || []) {
              await runBridgeTaskAsync("dbSetFavorite", { itemId: String(f.itemId || ""), favoritedAt: Number(f.favoritedAt || 0) });
            }
            return null;
          } catch {}
        }
        try {
          if (dbFavsCache === null) {
            const raw = readPersistentText("rcloneflix-db-favs");
            dbFavsCache = raw ? JSON.parse(raw) : [];
          }
          const map = new Map<string, number>();
          for (const f of (dbFavsCache || [])) map.set(f.itemId, f.favoritedAt);
          for (const f of args.favorites || []) map.set(f.itemId, f.favoritedAt);
          dbFavsCache = Array.from(map.entries()).map(([itemId, favoritedAt]) => ({ itemId, favoritedAt }));
          flushDbCachesAsync();
        } catch {}
        return null;
      }

      if (cmd === "library_remove_favorites") {
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            for (const id of args.itemIds || []) {
              await runBridgeTaskAsync("dbSetFavorite", { itemId: String(id || ""), favoritedAt: 0 });
            }
            return null;
          } catch {}
        }
        try {
          if (dbFavsCache === null) {
            const raw = readPersistentText("rcloneflix-db-favs");
            dbFavsCache = raw ? JSON.parse(raw) : [];
          }
          const toRemove = new Set((args.itemIds || []).map((x: any) => String(x)));
          dbFavsCache = (dbFavsCache || []).filter(f => !toRemove.has(f.itemId));
          flushDbCachesAsync();
        } catch {}
        return null;
      }

      // ── Secrets & Settings Store ─────────────────────────────────────────────

      if (
        cmd === "save_api_keys" ||
        cmd === "save_kaggle_credentials" ||
        cmd === "save_rclone_settings" ||
        cmd === "save_google_tokens"
      ) {
        writePersistentText(`rcloneflix-secret-${cmd}`, JSON.stringify(args));
        return null;
      }

      if (cmd === "clear_google_tokens") {
        writePersistentText("rcloneflix-secret-save_google_tokens", "");
        return null;
      }

      if (cmd === "load_api_keys") {
        try {
          const raw = readPersistentText("rcloneflix-secret-save_api_keys");
          return raw ? JSON.parse(raw).keys : { tmdb: "", theporndb: "" };
        } catch {
          return { tmdb: "", theporndb: "" };
        }
      }

      if (cmd === "load_google_tokens") {
        try {
          const raw = readPersistentText("rcloneflix-secret-save_google_tokens");
          return raw ? JSON.parse(raw).tokens : null;
        } catch {
          return null;
        }
      }

      if (cmd === "load_kaggle_credentials") {
        let username = "";
        let key = "";
        try {
          const raw = readPersistentText("rcloneflix-secret-save_kaggle_credentials");
          if (raw) {
            const parsed = JSON.parse(raw);
            const c = parsed.credentials || parsed;
            if (c.username) username = c.username;
            if (c.key) key = c.key;
          }
        } catch {}
        if (!username || !key) {
          try {
            const rawStorage = localStorage.getItem("rcloneflix-config") || localStorage.getItem("rcloneflix-storage");
            if (rawStorage) {
              const st = JSON.parse(rawStorage)?.state;
              if (st?.kaggleUsername && !username) username = st.kaggleUsername;
              if (st?.kaggleKey && !key) key = st.kaggleKey;
            }
          } catch {}
        }
        return { username, key };
      }

      if (cmd === "test_kaggle_connection") {
        let u = (args.username || "").trim();
        let k = (args.key || "").trim();
        if (!u || !k) {
          const creds = await (window as any).__TAURI_INTERNALS__.invoke("load_kaggle_credentials");
          u = creds.username;
          k = creds.key;
        }
        if (!u || !k) {
          return {
            ok: false,
            username: "",
            message: "No Kaggle credentials configured. Please enter your username and API key in Settings -> Cloud Transcoder.",
          };
        }
        const auth = btoa(`${u}:${k}`);
        const resp = await polyfillFetchText(
          `https://www.kaggle.com/api/v1/kernels/list?user=${u}&pageSize=1`,
          {
            Authorization: `Basic ${auth}`,
            "User-Agent": "RcloneFlix-Android/0.9",
          }
        );
        if (resp.ok) {
          return {
            ok: true,
            username: u,
            message: `Successfully connected to Kaggle as @${u}!`,
          };
        }
        if (resp.status === 401) {
          return {
            ok: false,
            username: u,
            message: "Authentication failed (401). Invalid Kaggle username or API token.",
          };
        }
        return {
          ok: false,
          username: u,
          message: `Kaggle API returned status ${resp.status}: ${resp.body.slice(0, 200)}`,
        };
      }

      if (cmd === "import_kaggle_json") {
        return (window as any).__TAURI_INTERNALS__.invoke("load_kaggle_credentials");
      }

      if (cmd === "dispatch_kaggle_transcode") {
        const creds = await (window as any).__TAURI_INTERNALS__.invoke("load_kaggle_credentials");
        if (!creds.username || !creds.key) {
          throw new Error("Kaggle credentials not configured. Please set them in Settings -> Cloud Transcoder.");
        }
        const req = args.req || args;
        const rcloneConf = req.rclone_config_snippet || getRcloneConfigText();
        const jobId = String(req.job_id || `transcode-${Date.now()}`);
        const slugSuffix = jobId.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
        const titleSource = req.output_filename || slugSuffix;
        const newTitle = `Transcode ${titleSource.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 32)}`.slice(0, 48);
        const derivedSlug = newTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const kernelId = `${creds.username}/${derivedSlug}`;

        const crf = req.crf ?? 27;
        const preset = req.preset ?? 9;
        const maxHeight = req.max_height ?? 1080;
        const deleteOrig = req.delete_original ? "True" : "False";
        const outOverride = req.output_filename ? `"${req.output_filename.replace(/"/g, '\\"')}"` : "None";
        const b64Conf = utf8ToBase64(rcloneConf.trim());

        const pyScript = `# Auto-generated RcloneFlix Cloud Transcoder
import os, sys, shutil, subprocess, json, time, base64
from urllib.parse import unquote, urlparse
print("=" * 65)
print("🚀 RCLONEFLIX KAGGLE CLOUD TRANSCODER INITIALIZING")
print("=" * 65)
RCLONE_CONFIG_DIR = os.path.expanduser("~/.config/rclone")
os.makedirs(RCLONE_CONFIG_DIR, exist_ok=True)
with open(os.path.join(RCLONE_CONFIG_DIR, "rclone.conf"), "w", encoding="utf-8") as f:
    f.write(base64.b64decode("""${b64Conf}""").decode("utf-8").strip())
if not shutil.which("rclone"):
    subprocess.run("curl -fsSL https://rclone.org/install.sh | bash", shell=True, check=True)
if not shutil.which("ffmpeg") or not shutil.which("ffprobe") or "libsvtav1" not in subprocess.getoutput("ffmpeg -encoders"):
    subprocess.run("wget -q https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz && tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz && cp ffmpeg-master-latest-linux64-gpl/bin/ffmpeg ffmpeg-master-latest-linux64-gpl/bin/ffprobe /usr/local/bin/ && rm -rf ffmpeg-master-latest-linux64-gpl*", shell=True, check=True)
SOURCE_INPUT = r"""${String(req.source_input || "").trim()}"""
DEST_REMOTE_FOLDER = r"""${String(req.dest_remote_folder || "").trim()}"""
DELETE_ORIGINAL_ON_SUCCESS = ${deleteOrig}
OUTPUT_NAME_OVERRIDE = ${outOverride}
CRF = ${crf}
PRESET = ${preset}
MAX_HEIGHT = ${maxHeight}
work_dir = "/kaggle/working" if os.path.exists("/kaggle/working") else "."
source_str = SOURCE_INPUT.strip()
is_cloud_remote_source = ":" in source_str and not (source_str.startswith("http://") or source_str.startswith("https://"))
if is_cloud_remote_source:
    source_basename = os.path.basename(source_str)
    name, ext = os.path.splitext(source_basename)
    output_filename = OUTPUT_NAME_OVERRIDE if OUTPUT_NAME_OVERRIDE else f"{name}_AV1.mp4"
    if not output_filename.lower().endswith(".mp4"): output_filename = f"{output_filename}_AV1.mp4"
    local_temp_input = os.path.join(work_dir, f"temp_input{ext}")
    local_temp_output = os.path.join(work_dir, output_filename)
    subprocess.run(["rclone", "copyto", source_str, local_temp_input, "-P", "--timeout", "120s"], check=True)
    ffmpeg_input = local_temp_input
    reconn = []
else:
    raw_fn = os.path.basename(unquote(urlparse(source_str).path)) or "video_output.mp4"
    name, _ = os.path.splitext(raw_fn)
    output_filename = OUTPUT_NAME_OVERRIDE if OUTPUT_NAME_OVERRIDE else f"{name}_AV1.mp4"
    if not output_filename.lower().endswith(".mp4"): output_filename = f"{output_filename}_AV1.mp4"
    local_temp_input = None
    local_temp_output = os.path.join(work_dir, output_filename)
    ffmpeg_input = source_str
    reconn = ["-reconnect", "1", "-reconnect_at_eof", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
def resolve_smart_audio_and_subs(ffmpeg_input, is_output_mkv=False):
    probe_res = subprocess.run([
        "ffprobe", "-v", "error",
        "-show_entries", "stream=index,codec_name,codec_type,tags,disposition",
        "-of", "json", ffmpeg_input
    ], capture_output=True, text=True)
    streams = []
    try:
        data = json.loads(probe_res.stdout)
        streams = data.get("streams", [])
    except Exception:
        pass
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    sub_streams = [s for s in streams if s.get("codec_type") == "subtitle"]
    compatible_audio = ["aac", "mp3", "opus", "flac"] if not is_output_mkv else ["aac", "mp3", "opus", "flac", "ac3", "eac3", "dts", "truehd"]

    def is_english(s):
        tags = s.get("tags") or {}
        lang = (tags.get("language") or "").lower()
        title = (tags.get("title") or "").lower()
        return (
            lang in ["eng", "en", "en-us", "en-gb", "english"] or
            "eng" in lang or "english" in title or "eng" in title.split() or "dub" in title
        )

    eng_audio_idx = None
    for idx, s in enumerate(audio_streams):
        if is_english(s):
            title = ((s.get("tags") or {}).get("title") or "").lower()
            if "commentary" not in title:
                eng_audio_idx = idx
                break
            elif eng_audio_idx is None:
                eng_audio_idx = idx

    audio_flags = []
    if audio_streams:
        if eng_audio_idx is not None and eng_audio_idx > 0:
            eng_s_idx = audio_streams[eng_audio_idx].get("index", eng_audio_idx)
            print(f"🎙️ Dual Audio: Promoting English audio track (stream {eng_s_idx}) to primary default track")
            ordered_audio = [audio_streams[eng_audio_idx]] + [s for i, s in enumerate(audio_streams) if i != eng_audio_idx]
        else:
            ordered_audio = audio_streams
            if eng_audio_idx == 0:
                print("🎙️ English audio is already primary track 0")

        for out_idx, s in enumerate(ordered_audio):
            s_idx = s.get("index", out_idx)
            audio_flags.extend(["-map", f"0:{s_idx}"])
            codec = s.get("codec_name", "").lower()
            if codec in compatible_audio:
                audio_flags.extend([f"-c:a:{out_idx}", "copy"])
            else:
                audio_flags.extend([f"-c:a:{out_idx}", "aac", f"-b:a:{out_idx}", "256k"])
            if out_idx == 0:
                audio_flags.extend([f"-disposition:a:{out_idx}", "default"])
            else:
                audio_flags.extend([f"-disposition:a:{out_idx}", "0"])
            lang = ((s.get("tags") or {}).get("language") or "").strip()
            if lang:
                audio_flags.extend([f"-metadata:s:a:{out_idx}", f"language={lang}"])
            title = ((s.get("tags") or {}).get("title") or "").strip()
            if title:
                audio_flags.extend([f"-metadata:s:a:{out_idx}", f"title={title}"])
    else:
        audio_flags = ["-map", "0:a?"]

    sub_flags = []
    text_sub_codecs = ["mov_text", "subrip", "srt", "ass", "webvtt", "text"]
    compatible_subs = sub_streams if is_output_mkv else [s for s in sub_streams if s.get("codec_name", "").lower() in text_sub_codecs]
    if compatible_subs:
        eng_sub_idx = None
        for idx, s in enumerate(compatible_subs):
            if is_english(s):
                title = ((s.get("tags") or {}).get("title") or "").lower()
                disp = s.get("disposition") or {}
                is_forced = disp.get("forced") == 1
                is_signs = "signs" in title or "songs" in title
                if not is_signs and not is_forced:
                    eng_sub_idx = idx
                    break
                elif eng_sub_idx is None:
                    eng_sub_idx = idx

        if eng_sub_idx is not None:
            eng_s_sub_idx = compatible_subs[eng_sub_idx].get("index", eng_sub_idx)
            print(f"💬 Subtitle Detected: Promoting English subtitles (stream {eng_s_sub_idx}) to default")
            ordered_subs = [compatible_subs[eng_sub_idx]] + [s for i, s in enumerate(compatible_subs) if i != eng_sub_idx]
        else:
            ordered_subs = compatible_subs

        for out_s_idx, s in enumerate(ordered_subs):
            s_idx = s.get("index", out_s_idx)
            sub_flags.extend(["-map", f"0:{s_idx}"])
            if is_output_mkv:
                sub_flags.extend([f"-c:s:{out_s_idx}", "copy"])
            else:
                sub_flags.extend([f"-c:s:{out_s_idx}", "mov_text"])
            if out_s_idx == 0 and eng_sub_idx is not None:
                sub_flags.extend([f"-disposition:s:{out_s_idx}", "default"])
            else:
                sub_flags.extend([f"-disposition:s:{out_s_idx}", "0"])
            lang = ((s.get("tags") or {}).get("language") or "").strip()
            if lang:
                sub_flags.extend([f"-metadata:s:s:{out_s_idx}", f"language={lang}"])
            title = ((s.get("tags") or {}).get("title") or "").strip()
            if title:
                sub_flags.extend([f"-metadata:s:s:{out_s_idx}", f"title={title}"])

    return audio_flags, sub_flags

audio_flags, sub_flags = resolve_smart_audio_and_subs(ffmpeg_input, output_filename.lower().endswith(".mkv"))
cmd = ["ffmpeg", "-y"] + reconn + ["-i", ffmpeg_input, "-map", "0:v:0?"] + audio_flags + sub_flags + ["-vf", f"scale=-2:'trunc(min({MAX_HEIGHT},ih)/2)*2'", "-c:v", "libsvtav1", "-preset", str(PRESET), "-crf", str(CRF), "-movflags", "+faststart", local_temp_output]
p = subprocess.run(cmd)
if p.returncode != 0: sys.exit(p.returncode)
dest_folder = DEST_REMOTE_FOLDER.rstrip("/") + "/"
if ":" not in dest_folder and is_cloud_remote_source:
    dest_folder = source_str.split(":", 1)[0] + ":" + dest_folder.lstrip("/")
res_up = subprocess.run(["rclone", "move", local_temp_output, dest_folder, "-P", "--transfers", "2", "--retries", "5", "--timeout", "120s"])
if res_up.returncode == 0:
    if is_cloud_remote_source and DELETE_ORIGINAL_ON_SUCCESS: subprocess.run(["rclone", "deletefile", source_str])
    print("Transcode completed successfully!")
else: sys.exit(res_up.returncode)
`;

        const pushPayload = {
          slug: kernelId,
          newTitle,
          text: pyScript,
          language: "python",
          kernelType: "script",
          isPrivate: true,
          enableGpu: false,
          enableInternet: true,
        };

        const auth = btoa(`${creds.username}:${creds.key}`);
        const resp = await polyfillFetchText(
          "https://www.kaggle.com/api/v1/kernels/push",
          {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json",
            "User-Agent": "RcloneFlix-Android/0.9",
          },
          "POST",
          JSON.stringify(pushPayload)
        );

        if (!resp.ok) {
          throw new Error(`Kaggle push failed (${resp.status}): ${resp.body}`);
        }

        let finalRef = kernelId;
        let finalSlug = derivedSlug;
        let finalUrl = `https://www.kaggle.com/code/${creds.username}/${derivedSlug}`;
        try {
          const bj = JSON.parse(resp.body);
          if (bj?.error) throw new Error(bj.error);
          if (bj?.ref) {
            finalRef = bj.ref;
            const parsed = parseKaggleUserAndSlug(bj.ref, creds.username);
            finalSlug = parsed.slug;
          }
          if (bj?.url) {
            finalUrl = bj.url;
            const parsedUrl = parseKaggleUserAndSlug(bj.url, creds.username);
            finalSlug = parsedUrl.slug;
          }
        } catch {}

        return {
          job_id: jobId,
          kernel_slug: finalSlug,
          kernel_ref: finalRef,
          url: finalUrl,
          status: "queued",
        };
      }

      if (cmd === "dispatch_kaggle_transfer") {
        const creds = await (window as any).__TAURI_INTERNALS__.invoke("load_kaggle_credentials");
        if (!creds.username || !creds.key) {
          throw new Error("Kaggle credentials not configured. Please set them in Settings -> Cloud Transcoder / Transfers.");
        }
        const req = args.req || args;
        const rcloneConf = req.rclone_config_snippet || getRcloneConfigText();
        const jobId = String(req.job_id || `transfer-${Date.now()}`);
        const slugSuffix = jobId.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 35);
        const opUpper = String(req.operation || "copy").toUpperCase();
        const newTitle = `Cloud ${opUpper} ${slugSuffix.slice(0, 32)}`.slice(0, 48);
        const derivedSlug = newTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const kernelId = `${creds.username}/${derivedSlug}`;

        const b64Conf = utf8ToBase64(rcloneConf.trim());
        const op = (req.operation || "copy").toLowerCase();
        const transfers = req.transfers || 4;
        const checkers = req.checkers || 8;
        const driveAcross = req.drive_server_side_copy !== false ? "True" : "False";
        const dryRun = req.dry_run ? "True" : "False";
        const src = String(req.source || "").trim();
        const dst = String(req.destination || "").trim();
        const batchItems = Array.isArray(req.batch_items) ? req.batch_items : [];
        const batchItemsJson = JSON.stringify(batchItems);
        const tgToken = String(req.telegram_bot_token || "").trim();
        const tgChatId = String(req.telegram_chat_id || "").trim();
        const tgApiId = String(req.telegram_api_id || "").trim();
        const tgApiHash = String(req.telegram_api_hash || "").trim();

        const pyScript = `# Auto-generated RcloneFlix Cloud Transfer Worker
import os, sys, shutil, subprocess, time, base64, json
print("=" * 65)
print("🚀 RCLONEFLIX CLOUD TRANSFER WORKER INITIALIZING")
print("=" * 65)
RCLONE_CONFIG_DIR = os.path.expanduser("~/.config/rclone")
os.makedirs(RCLONE_CONFIG_DIR, exist_ok=True)
with open(os.path.join(RCLONE_CONFIG_DIR, "rclone.conf"), "w", encoding="utf-8") as f:
    f.write(base64.b64decode("""${b64Conf}""").decode("utf-8").strip())
if not shutil.which("rclone"):
    subprocess.run(
        "curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rclone.zip && "
        "unzip -q -o /tmp/rclone.zip -d /tmp/rclone_unz && "
        "cp /tmp/rclone_unz/rclone-*-linux-amd64/rclone /usr/local/bin/rclone && "
        "chmod 755 /usr/local/bin/rclone",
        shell=True, check=True
    )

SOURCE = r"""${src}"""
DEST = r"""${dst}"""
BATCH_ITEMS = json.loads(r"""${batchItemsJson}""")
TG_TOKEN = r"""${tgToken}"""
TG_CHAT_ID = r"""${tgChatId}"""
TG_API_ID = r"""${tgApiId}"""
TG_API_HASH = r"""${tgApiHash}"""

if DEST.lower().startswith("telegram:"):
    target_chat = DEST.split(":", 1)[1].strip("/") or TG_CHAT_ID
    stage_dir = "/tmp/stage_tg"
    os.makedirs(stage_dir, exist_ok=True)
    subprocess.run(["rclone", "copy", SOURCE, stage_dir, "-v"], check=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "telethon", "requests"], check=True)
    import requests
    from telethon.sync import TelegramClient
    client = TelegramClient("/tmp/tg_sess", int(TG_API_ID), TG_API_HASH) if (TG_API_ID.isdigit() and TG_API_HASH) else None
    if client:
        client.start(bot_token=TG_TOKEN)
    peer = int(target_chat) if target_chat.lstrip("-").isdigit() else target_chat
    for root_d, _, files in os.walk(stage_dir):
        for fn in sorted(files):
            fp = os.path.join(root_d, fn)
            fsize = os.path.getsize(fp)
            if client:
                sent = client.send_file(peer, fp, caption=f"🎬 {fn}", supports_streaming=True)
                msg_id = sent.id
            else:
                with open(fp, "rb") as fobj:
                    r = requests.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendDocument", data={"chat_id": str(peer), "caption": f"🎬 {fn}"}, files={"document": (fn, fobj)}, timeout=600)
                msg_id = (r.json().get("result") or {}).get("message_id", 0)
            entry_data = {"path": f"/{fn}", "name": fn, "size": fsize, "msgId": msg_id, "chatId": str(peer), "mtime": int(time.time())}
            print(f"RCLONEFLIX_TG_OFFLOAD_RESULT:{json.dumps(entry_data)}")
            auth_b64 = base64.b64encode(b"rcloneflix:rcloneflix-tg-2026").decode("ascii")
            try:
                requests.post("https://rcloneflix-telegram-webdav.rcloneflix-telegram-webdav.workers.dev/register-entry", headers={"Authorization": f"Basic {auth_b64}", "Content-Type": "application/json"}, json=entry_data, timeout=20)
            except Exception:
                pass
            os.remove(fp)
    if client:
        client.disconnect()
    sys.exit(0)

cmd = ["rclone", "${op}", SOURCE, DEST, "-P", "--stats", "5s", "--transfers", "${transfers}", "--checkers", "${checkers}", "--buffer-size", "64M", "--retries", "3"]
if ${driveAcross}: cmd.append("--server-side-across-configs")
if ${dryRun}: cmd.append("--dry-run")
def escape_rclone_glob(s):
    out = []
    for c in str(s):
        if c in ('[', ']', '*', '?', '{', '}'):
            out.append('\\\\' + c)
        else:
            out.append(c)
    return ''.join(out)

has_filter = False
if BATCH_ITEMS and len(BATCH_ITEMS) > 0:
    src_clean = SOURCE.split(':', 1)[1].strip('/') if ':' in SOURCE else ''
    folder_basename = src_clean.split('/')[-1] if src_clean else ''

    flines = []
    for item_name in BATCH_ITEMS:
        trimmed = str(item_name).strip()
        if folder_basename and trimmed.startswith(folder_basename + '/'):
            trimmed = trimmed[len(folder_basename) + 1:]
        clean_name = trimmed.strip('/')
        if clean_name:
            esc = escape_rclone_glob(clean_name)
            flines.append(f"+ /{esc}")
            flines.append(f"+ /{esc}/**")
    if flines:
        flines.append("- **")
        fpath = "/tmp/rflix_filter.txt"
        with open(fpath, "w", encoding="utf-8") as ff:
            ff.write("\\n".join(flines) + "\\n")
        cmd.extend(["--filter-from", fpath])
        has_filter = True

def run_rclone(active_cmd):
    p = subprocess.Popen(active_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    lines = []
    for l in p.stdout:
        print(l, end="", flush=True)
        lines.append(l)
    p.wait()
    return p.returncode, "".join(lines)

print("Executing:", " ".join(cmd))
rc, full_out = run_rclone(cmd)
# Server-side copy across different providers fails HARD inside rclone
# (e.g. WebDAV "409 Conflict: destination node is not found") instead of
# falling back. Retry once as a streamed download+upload.
if rc != 0 and "--server-side-across-configs" in cmd:
    print("Server-side transfer failed - retrying as a streamed transfer (without --server-side-across-configs)...")
    cmd = [c for c in cmd if c != "--server-side-across-configs"]
    rc, full_out = run_rclone(cmd)

if rc != 0:
    sys.exit(rc)

if not ${dryRun} and has_filter:
    import re
    checks_m = re.findall(r"Checks:\\s+(\\d+)\\s*/\\s*(\\d+)", full_out)
    checks_done = int(checks_m[-1][0]) if checks_m else 0
    files_m = re.findall(r"Transferred:\\s+(\\d+)\\s*/\\s*(\\d+)", full_out)
    files_done = int(files_m[-1][0]) if files_m else 0
    bytes_m = re.findall(r"Transferred:\\s+([0-9.]+)\\s*([kKMGTPE]?i?B)\\s*/", full_out)
    bytes_done = 0
    if bytes_m:
        val, unit = bytes_m[-1]
        mults = {'B': 1, 'KIB': 1024, 'KB': 1000, 'MIB': 1024**2, 'MB': 1000**2,
                 'GIB': 1024**3, 'GB': 1000**3, 'TIB': 1024**4, 'TB': 1000**4}
        bytes_done = int(float(val) * mults.get(unit.upper(), 1))
    if bytes_done == 0 and checks_done == 0 and files_done == 0:
        print("\\n❌ Cloud Transfer Failed: 0 files matched the filter rules! (Transferred: 0 B, Checks: 0/0).")
        sys.exit(1)

sys.exit(0)
`;

        const pushPayload = {
          slug: kernelId,
          newTitle,
          text: pyScript,
          language: "python",
          kernelType: "script",
          isPrivate: true,
          enableGpu: false,
          enableInternet: true,
        };

        const auth = btoa(`${creds.username}:${creds.key}`);
        const resp = await polyfillFetchText(
          "https://www.kaggle.com/api/v1/kernels/push",
          {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json",
            "User-Agent": "RcloneFlix-Android/0.9",
          },
          "POST",
          JSON.stringify(pushPayload)
        );

        if (!resp.ok) {
          throw new Error(`Kaggle transfer push failed (${resp.status}): ${resp.body}`);
        }

        let finalRef = kernelId;
        let finalSlug = derivedSlug;
        let finalUrl = `https://www.kaggle.com/code/${creds.username}/${derivedSlug}`;
        try {
          const bj = JSON.parse(resp.body);
          if (bj?.error) throw new Error(bj.error);
          if (bj?.ref) {
            finalRef = bj.ref;
            const parsed = parseKaggleUserAndSlug(bj.ref, creds.username);
            finalSlug = parsed.slug;
          }
          if (bj?.url) {
            finalUrl = bj.url;
            const parsedUrl = parseKaggleUserAndSlug(bj.url, creds.username);
            finalSlug = parsedUrl.slug;
          }
        } catch {}

        return {
          job_id: jobId,
          kernel_slug: finalSlug,
          kernel_ref: finalRef,
          url: finalUrl,
          status: "queued",
        };
      }

      if (cmd === "get_kaggle_transcode_status") {
        const creds = await (window as any).__TAURI_INTERNALS__.invoke("load_kaggle_credentials");
        if (!creds.username || !creds.key) throw new Error("Kaggle credentials not configured.");
        const parsed = parseKaggleUserAndSlug(args.kernelSlug || args.kernel_slug || "", creds.username);
        const auth = btoa(`${creds.username}:${creds.key}`);
        const resp = await polyfillFetchText(
          `https://www.kaggle.com/api/v1/kernels/status?userName=${parsed.user}&kernelSlug=${parsed.slug}`,
          {
            Authorization: `Basic ${auth}`,
            "User-Agent": "RcloneFlix-Android/0.9",
          }
        );
        if (!resp.ok) {
          throw new Error(`Kaggle status error (${resp.status}): ${resp.body}`);
        }
        try {
          const j = JSON.parse(resp.body);
          return {
            status: String(j?.status || "unknown").toLowerCase(),
            failure_message: j?.failureMessage || null,
          };
        } catch {
          return { status: "unknown", failure_message: null };
        }
      }

      if (cmd === "get_kaggle_transcode_output") {
        const creds = await (window as any).__TAURI_INTERNALS__.invoke("load_kaggle_credentials");
        if (!creds.username || !creds.key) throw new Error("Kaggle credentials not configured.");
        const parsed = parseKaggleUserAndSlug(args.kernelSlug || args.kernel_slug || "", creds.username);
        const auth = btoa(`${creds.username}:${creds.key}`);
        const resp = await polyfillFetchText(
          `https://www.kaggle.com/api/v1/kernels/output?userName=${parsed.user}&kernelSlug=${parsed.slug}`,
          {
            Authorization: `Basic ${auth}`,
            "User-Agent": "RcloneFlix-Android/0.9",
          }
        );
        if (!resp.ok) {
          throw new Error(`Kaggle output error (${resp.status}): ${resp.body}`);
        }
        try {
          const j = JSON.parse(resp.body);
          return j?.log || j?.logNullable || "";
        } catch {
          return "";
        }
      }

      if (cmd === "dropmb_sign_in") {
        const email = String(args.email || "").trim();
        const password = String(args.password || "");
        const resp = await polyfillFetchText(
          "https://dropmb.com/api/auth/signIn",
          { "Content-Type": "application/json", Accept: "application/json" },
          "POST",
          JSON.stringify({ email, password })
        );
        let token = "";
        if (resp.set_cookie) {
          for (const part of resp.set_cookie.split(";")) {
            const p = part.trim();
            if (p.startsWith("access_token=")) {
              token = p.slice(13);
              break;
            }
          }
        }
        let userJson: any = {};
        try {
          userJson = JSON.parse(resp.body);
        } catch {}
        if (!token && userJson?.accessToken) token = userJson.accessToken;
        if (!token && userJson?.token) token = userJson.token;
        if (!token && userJson?.access_token) token = userJson.access_token;

        if (resp.ok) {
          return {
            ok: true,
            status: resp.status,
            token,
            user: userJson,
          };
        } else {
          throw new Error(`DropMB authentication failed (HTTP ${resp.status}): ${resp.body}`);
        }
      }

      if (cmd === "dropmb_create_share") {
        const token = String(args.token || "").trim();
        const hdrs: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json",
        };
        if (token) {
          hdrs["Cookie"] = `access_token=${token}`;
          hdrs["Authorization"] = `Bearer ${token}`;
        }
        const resp = await polyfillFetchText(
          "https://dropmb.com/api/shares",
          hdrs,
          "POST",
          JSON.stringify({
            id: args.id,
            name: args.name,
            expiration: args.expiration || "5-years",
            recipients: [],
          })
        );
        let data: any = {};
        try {
          data = JSON.parse(resp.body);
        } catch {}
        return {
          ok: resp.ok,
          status: resp.status,
          data,
          body: resp.body,
        };
      }

      if (cmd === "dropmb_upload_chunk") {
        const shareId = String(args.shareId || args.share_id || "");
        const fileName = String(args.fileName || args.file_name || "");
        const chunkIndex = Number(args.chunkIndex ?? args.chunk_index ?? 0);
        const totalChunks = Number(args.totalChunks ?? args.total_chunks ?? 1);
        const fileId = args.fileId || args.file_id;
        const token = String(args.token || "").trim();
        const chunkBase64 = String(args.chunkBase64 || args.chunk_base64 || "");

        const params = new URLSearchParams();
        params.set("name", fileName);
        params.set("chunkIndex", String(chunkIndex));
        params.set("totalChunks", String(totalChunks));
        if (fileId) params.set("id", String(fileId));

        const hdrs: Record<string, string> = {
          "Content-Type": "application/octet-stream",
          Accept: "application/json",
        };
        if (token) {
          hdrs["Cookie"] = `access_token=${token}`;
          hdrs["Authorization"] = `Bearer ${token}`;
        }

        const resp = await polyfillFetchText(
          `https://dropmb.com/api/shares/${shareId}/files?${params.toString()}`,
          hdrs,
          "POST",
          `__BASE64__:${chunkBase64}`
        );
        let data: any = {};
        try {
          data = JSON.parse(resp.body);
        } catch {}
        return {
          ok: resp.ok,
          status: resp.status,
          data,
          body: resp.body,
        };
      }

      if (cmd === "dropmb_complete_share") {
        const shareId = String(args.shareId || args.share_id || "");
        const token = String(args.token || "").trim();
        const hdrs: Record<string, string> = {
          Accept: "application/json",
        };
        if (token) {
          hdrs["Cookie"] = `access_token=${token}`;
          hdrs["Authorization"] = `Bearer ${token}`;
        }
        const resp = await polyfillFetchText(
          `https://dropmb.com/api/shares/${shareId}/complete`,
          hdrs,
          "POST",
          ""
        );
        return {
          ok: resp.ok,
          status: resp.status,
          body: resp.body,
        };
      }

      if (cmd === "load_rclone_settings") {
        try {
          const raw = readPersistentText("rcloneflix-secret-save_rclone_settings");
          return raw ? JSON.parse(raw).settings : null;
        } catch {
          return null;
        }
      }

      if (cmd === "save_rclone_config_content") {
        saveRcloneConfigText(args.content || "");
        return null;
      }

      if (cmd === "load_rclone_config_content") {
        return getRcloneConfigText();
      }

      // ── Rclone Config Parsing & Scoped Pass Merging ──────────────────────────

      if (cmd === "parse_rclone_config") {
        const p = String(args.configPath || "");
        const vf = virtualFiles.get(p);
        let content = vf ? vf.text : getRcloneConfigText();
        if (vf && vf.text) {
          saveRcloneConfigText(vf.text);
        }
        return parseIniRemotes(content);
      }

      if (cmd === "rclone_merge_scoped_config") {
        const current = getRcloneConfigText();
        const incoming = args.scopedContent ?? args.scopedConfig ?? "";
        const merged = mergeIniSections(current, incoming);
        saveRcloneConfigText(merged);
        return {
          config_path: args.configPath || "android://rclone.conf",
          remotes: parseIniRemotes(merged),
        };
      }

      if (cmd === "rclone_remove_scoped_remotes") {
        const current = getRcloneConfigText();
        const updated = removeIniSections(current, args.remoteNames || []);
        saveRcloneConfigText(updated);
        return parseIniRemotes(updated);
      }

      // ── Rclone Operations (Browse, Scan, Read/Write Tokens & Backups) ────────

      if (cmd === "list_remote_path") {
        const bridge = getBridge();
        if (typeof bridge?.runAsyncTask === "function" || typeof bridge?.runRcloneCommand === "function") {
          let rp = String(
            args.remotePath ||
              (args.remote ? `${String(args.remote).replace(/:$/, "")}:${String(args.path || "")}` : "")
          );
          if (rp && !rp.includes(":") && !rp.startsWith("/")) rp = `${rp}:`;
          const argsJson = JSON.stringify(["lsjson", "--no-modtime", "--no-mimetype", rp]);
          let parsed: any;
          if (typeof bridge?.runAsyncTask === "function") {
            try {
              parsed = await runBridgeTaskAsync("runRcloneCommand", { argsJson });
            } catch {
              if (typeof bridge?.runRcloneCommand === "function") {
                parsed = JSON.parse(bridge.runRcloneCommand(argsJson));
              }
            }
          } else if (typeof bridge?.runRcloneCommand === "function") {
            parsed = JSON.parse(bridge.runRcloneCommand(argsJson));
          }
          if (!parsed?.ok) throw new Error(parsed?.stderr || "rclone lsjson failed");
          const items = JSON.parse(parsed.stdout || "[]");
          return items.map((it: any) => ({
            name: it.Name,
            path: it.Path,
            is_dir: Boolean(it.IsDir),
            size: Number(it.Size || 0),
            mime_type: it.MimeType || null,
          }));
        }
        return [];
      }

      if (cmd === "scan_library_files") {
        const bridge = getBridge();
        const libraryId = String(args.libraryId || "");
        let targetRemote = String(args.remotePath || "").trim();
        if (targetRemote && !targetRemote.includes(":") && !targetRemote.startsWith("/")) {
          targetRemote = `${targetRemote}:`;
        }
        const knownSet = new Set<string>(args.knownPaths || []);
        const isPhotos = args.libraryType === "photos";

        if (typeof bridge?.runAsyncTask === "function" || typeof bridge?.runRcloneCommand === "function") {
          emitTauriEvent("scan-progress", {
            libraryId,
            stage: "listing",
            remote: targetRemote,
            message: `Listing files in ${targetRemote}...`,
          });

          const argsJson = JSON.stringify([
            "lsjson",
            "--recursive",
            "--no-modtime",
            "--no-mimetype",
            "--files-only",
            targetRemote,
          ]);

          let parsed: any;
          if (typeof bridge?.runAsyncTask === "function") {
            try {
              parsed = await runBridgeTaskAsync("runRcloneCommand", { argsJson });
            } catch {
              if (typeof bridge?.runRcloneCommand === "function") {
                parsed = JSON.parse(bridge.runRcloneCommand(argsJson));
              }
            }
          } else if (typeof bridge?.runRcloneCommand === "function") {
            parsed = JSON.parse(bridge.runRcloneCommand(argsJson));
          }

          if (!parsed?.ok) throw new Error(parsed?.stderr || "rclone scan failed");
          const items = JSON.parse(parsed.stdout || "[]");

          const newFiles: any[] = [];
          const foundPaths = new Set<string>();

          const photoExts = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif", "bmp", "tiff", "svg", "enc"]);
          const mediaExts = new Set([
            "mkv", "mp4", "avi", "mov", "wmv", "m4v", "ts", "m2ts", "mts", "webm", "mpg", "mpeg", "flv", "3gp", "ogv", "divx", "vob",
            "mp3", "flac", "aac", "ogg", "oga", "m4a", "wav", "opus", "wma", "aiff", "alac", "ape",
            "epub", "pdf", "m4b", "aax", "aa"
          ]);

          for (const item of items) {
            if (item.IsDir) continue;
            const ext = String(item.Name || "").split(".").pop()?.toLowerCase() || "";
            const isMedia = isPhotos ? photoExts.has(ext) : mediaExts.has(ext);
            if (!isMedia) continue;

            const base = targetRemote.replace(/\/+$/, "");
            const rel = String(item.Path || "").replace(/^\/+/, "");
            const fullPath = base.endsWith(":") ? `${base}${rel}` : `${base}/${rel}`;
            foundPaths.add(fullPath);
            if (!knownSet.has(fullPath)) {
              newFiles.push({
                remote_path: fullPath,
                filename: item.Name,
                size: Number(item.Size || 0),
                is_dir: false,
                mime_type: item.MimeType || null,
              });
            }
          }

          const base = targetRemote.replace(/\/+$/, "");
          const prefix = base.endsWith(":") ? base : `${base}/`;
          const removedPaths = Array.from(knownSet).filter(
            (p) => (p.startsWith(prefix) || p === targetRemote) && !foundPaths.has(p)
          );

          emitTauriEvent("scan-progress", {
            libraryId,
            stage: "complete",
            newFiles: newFiles.length,
            removedFiles: removedPaths.length,
            totalFound: foundPaths.size,
          });

          return {
            library_id: libraryId,
            new_files: newFiles,
            removed_paths: removedPaths,
            total_found: foundPaths.size,
            errors: [],
          };
        }

        return {
          library_id: libraryId,
          new_files: [],
          removed_paths: [],
          total_found: 0,
          errors: [],
        };
      }

      if (cmd === "parse_media_filename") {
        return parseMediaFilenameJs(String(args.filename || ""));
      }

      if (cmd === "hash_remote_path") {
        return hashRemotePathJs(String(args.remotePath || ""));
      }

      if (cmd === "rclone_read_bytes") {
        const bridge = getBridge();
        const remotePath = String(args.remotePath || "");
        if (typeof bridge?.runAsyncTask === "function") {
          const res = await runBridgeTaskAsync("readRemoteBase64", { remotePath });
          const b64 = res?.base64 || "";
          if (!b64) throw new Error(`Could not read remote file: ${remotePath}`);
          const bin = atob(b64);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        } else if (typeof bridge?.readRemoteBase64 === "function") {
          const b64 = bridge.readRemoteBase64(remotePath);
          if (!b64) throw new Error(`Could not read remote file: ${remotePath}`);
          const bin = atob(b64);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        }
        throw new Error("Native Rclone bridge unavailable");
      }

      if (cmd === "rclone_read_backup") {
        const bridge = getBridge();
        const remotePath = String(args.remotePath || "");
        let b64 = "";
        if (typeof bridge?.runAsyncTask === "function") {
          const res = await runBridgeTaskAsync("readRemoteBase64", { remotePath });
          b64 = res?.base64 || "";
        } else if (typeof bridge?.readRemoteBase64 === "function") {
          b64 = bridge.readRemoteBase64(remotePath);
        }
        if (!b64) throw new Error(`Could not read remote backup: ${remotePath}`);
        const bin = atob(b64);
        const rawBytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) rawBytes[i] = bin.charCodeAt(i);
        const decompressed = await gzipDecompressBytes(rawBytes);
        return new TextDecoder().decode(decompressed);
      }

      if (cmd === "rclone_upload_bytes" || cmd === "rclone_write_backup") {
        const bridge = getBridge();
        const remotePath = String(args.remotePath || "");
        let bytes: Uint8Array;
        if (cmd === "rclone_write_backup") {
          const contentStr = String(args.content ?? args.payloadJson ?? "");
          const rawBytes = new TextEncoder().encode(contentStr);
          bytes = remotePath.endsWith(".gz") ? await gzipCompressBytes(rawBytes) : rawBytes;
        } else {
          bytes = new Uint8Array(args.bytes || []);
        }
        let bin = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        const b64 = btoa(bin);
        if (typeof bridge?.runAsyncTask === "function") {
          const res = await runBridgeTaskAsync("writeRemoteBase64", { remotePath, base64: b64 });
          if (!res?.ok) throw new Error(`Failed uploading to ${remotePath}`);
          return bytes.length;
        } else if (typeof bridge?.writeRemoteBase64 === "function") {
          const ok = bridge.writeRemoteBase64(remotePath, b64);
          if (!ok) throw new Error(`Failed uploading to ${remotePath}`);
          return bytes.length;
        }
        return 0;
      }

      if (cmd === "rclone_upload_file") {
        const remoteDest = String(args.remote_path || args.remoteDestPath || args.remotePath || "");
        if (remoteDest.startsWith("shared_") && !remoteDest.includes(".rflix_passes")) {
          throw new Error("Permission denied: write operations are forbidden on shared access pass remotes");
        }
        const localPath = String(args.local_path || args.localFilePath || args.localPath || "");
        const bridge = getBridge();
        const cmdArgs = ["copyto", localPath, remoteDest];
        const argsJson = JSON.stringify(cmdArgs);
        if (typeof bridge?.runAsyncTask === "function") {
          const parsed = await runBridgeTaskAsync("runRcloneCommand", { argsJson });
          if (!parsed?.ok) throw new Error(parsed?.stderr || "rclone upload failed");
        } else if (typeof bridge?.runRcloneCommand === "function") {
          const parsed = JSON.parse(bridge.runRcloneCommand(argsJson));
          if (!parsed.ok) throw new Error(parsed?.stderr || "rclone upload failed");
        }
        return null;
      }

      if (cmd === "rclone_mkdir") {
        const bridge = getBridge();
        const remotePath = String(args.remotePath || args.remote_path || "");
        const argsJson = JSON.stringify(["mkdir", remotePath]);
        if (typeof bridge?.runAsyncTask === "function") {
          const parsed = await runBridgeTaskAsync("runRcloneCommand", { argsJson });
          if (!parsed?.ok) throw new Error(parsed?.stderr || "rclone mkdir failed");
        } else if (typeof bridge?.runRcloneCommand === "function") {
          const parsed = JSON.parse(bridge.runRcloneCommand(argsJson));
          if (!parsed.ok) throw new Error(parsed?.stderr || "rclone mkdir failed");
        }
        return null;
      }

      if (cmd === "rclone_rename_file") {
        const bridge = getBridge();
        const src = String(args.fromPath || args.sourceRemotePath || args.sourcePath || "");
        const dst = String(args.toPath || args.targetRemotePath || args.destPath || "");
        const runMove = async (serverSide: boolean): Promise<any> => {
          const argsJson = JSON.stringify(
            serverSide ? ["moveto", "--server-side-across-configs", src, dst] : ["moveto", src, dst]
          );
          if (typeof bridge?.runAsyncTask === "function") {
            return await runBridgeTaskAsync("runRcloneCommand", { argsJson });
          } else if (typeof bridge?.runRcloneCommand === "function") {
            return JSON.parse(bridge.runRcloneCommand(argsJson));
          }
          return { ok: true };
        };
        let parsed = await runMove(true);
        // Server-side ops across different providers fail hard (e.g. WebDAV 409
        // Conflict) instead of falling back inside rclone — retry streamed.
        if (!parsed?.ok) parsed = await runMove(false);
        if (!parsed?.ok) throw new Error(parsed?.stderr || "rclone move failed");
        return null;
      }

      if (cmd === "rclone_copy_file") {
        const bridge = getBridge();
        const src = String(args.fromPath || args.sourceRemotePath || args.sourcePath || "");
        const dst = String(args.toPath || args.targetRemotePath || args.destPath || "");
        const runCopy = async (serverSide: boolean): Promise<any> => {
          const argsJson = JSON.stringify(
            serverSide ? ["copyto", "--server-side-across-configs", src, dst] : ["copyto", src, dst]
          );
          if (typeof bridge?.runAsyncTask === "function") {
            return await runBridgeTaskAsync("runRcloneCommand", { argsJson });
          } else if (typeof bridge?.runRcloneCommand === "function") {
            return JSON.parse(bridge.runRcloneCommand(argsJson));
          }
          return { ok: true };
        };
        let parsed = await runCopy(true);
        // Server-side ops across different providers fail hard (e.g. WebDAV 409
        // Conflict) instead of falling back inside rclone — retry streamed.
        if (!parsed?.ok) parsed = await runCopy(false);
        if (!parsed?.ok) throw new Error(parsed?.stderr || "rclone copy failed");
        return null;
      }

      if (cmd === "get_rclone_link") {
        const bridge = getBridge();
        const cleanRemote = String(args.remoteName || args.remote_name || "").replace(/:+$/, "");
        const cleanPath = String(args.filePath || args.file_path || "").replace(/^\/+/, "");
        const target = `${cleanRemote}:${cleanPath}`;
        const argsJson = JSON.stringify(["link", target]);
        let parsed: any;
        if (typeof bridge?.runAsyncTask === "function") {
          parsed = await runBridgeTaskAsync("runRcloneCommand", { argsJson });
        } else if (typeof bridge?.runRcloneCommand === "function") {
          parsed = JSON.parse(bridge.runRcloneCommand(argsJson));
        }
        if (!parsed?.ok) {
          throw new Error(parsed?.stderr || `Remote '${cleanRemote}' does not support public sharing links`);
        }
        const link = (parsed?.stdout || "").trim();
        if (!link) {
          throw new Error(`Remote '${cleanRemote}' returned an empty share link`);
        }
        return link;
      }

      if (cmd === "rclone_delete_item") {
        const bridge = getBridge();
        const sub = args.isDir ? "purge" : "deletefile";
        const remotePath = String(args.remotePath || args.remote_path || "");
        const argsJson = JSON.stringify([sub, remotePath]);
        if (typeof bridge?.runAsyncTask === "function") {
          const parsed = await runBridgeTaskAsync("runRcloneCommand", { argsJson });
          if (!parsed?.ok) throw new Error(parsed?.stderr || "rclone delete failed");
        } else if (typeof bridge?.runRcloneCommand === "function") {
          const parsed = JSON.parse(bridge.runRcloneCommand(argsJson));
          if (!parsed.ok) throw new Error(parsed?.stderr || "rclone delete failed");
        }
        return null;
      }

      if (cmd === "start_download") {
        const items = (args.items || []) as Array<{ remote_path: string; filename: string }>;
        const bridge = getBridge();
        for (const item of items) {
          const target = `/sdcard/Download/${item.filename}`;
          const argsJson = JSON.stringify(["copyto", item.remote_path, target]);
          if (typeof bridge?.runAsyncTask === "function") {
            await runBridgeTaskAsync("runRcloneCommand", { argsJson });
          } else if (typeof bridge?.runRcloneCommand === "function") {
            bridge.runRcloneCommand(argsJson);
          }
        }
        return "/sdcard/Download";
      }

      if (cmd === "start_folder_download") {
        const folderPath = String(args.remote_folder_path || args.remoteFolderPath || "");
        const folderName = String(args.folder_name || args.folderName || "Folder");
        const bridge = getBridge();
        const target = `/sdcard/Download/${folderName}`;
        const argsJson = JSON.stringify(["copy", folderPath, target]);
        if (typeof bridge?.runAsyncTask === "function") {
          await runBridgeTaskAsync("runRcloneCommand", { argsJson });
        } else if (typeof bridge?.runRcloneCommand === "function") {
          bridge.runRcloneCommand(argsJson);
        }
        return target;
      }

      if (cmd === "open_download_folder") {
        return null;
      }

      // ── Logging & Diagnostics ───────────────────────────────────────────────

      if (cmd === "log_message") {
        const level = String(args.level || "info");
        const target = String(args.target || "app");
        const message = String(args.message || "");
        const bridge = getBridge();
        if (typeof bridge?.appendNativeLog === "function") {
          try {
            bridge.appendNativeLog(level, target, message);
          } catch {}
        }
        return null;
      }

      if (cmd === "get_log_path") {
        return "android://logs/rcloneflix.log";
      }

      if (cmd === "read_log_tail") {
        const lines = Number(args.lines || 400);
        const bridge = getBridge();
        if (typeof bridge?.readNativeLogTail === "function") {
          try {
            const tail = bridge.readNativeLogTail(lines);
            return tail || "No log entries recorded yet.";
          } catch {}
        }
        return "No log entries recorded yet.";
      }

      // ── Media Playback & Streaming Sessions ──────────────────────────────────

      if (cmd === "start_stream_session" || cmd === "start_local_file_stream") {
        const bridge = getBridge();
        let remoteRoot = String(args.remoteRoot || "").trim();
        let filePath = String(args.filePath || "").trim();

        if (!remoteRoot) {
          if (filePath.includes(":")) {
            remoteRoot = filePath.split(":")[0] + ":";
          } else if (filePath.includes("/")) {
            const lastSlash = filePath.lastIndexOf("/");
            remoteRoot = lastSlash > 0 ? filePath.slice(0, lastSlash) : "/";
            filePath = filePath.slice(lastSlash + 1);
          } else {
            remoteRoot = filePath;
          }
        }
        if (remoteRoot && !remoteRoot.includes(":") && !remoteRoot.startsWith("/")) {
          remoteRoot = `${remoteRoot}:`;
        }

        // Desktop-only streamtape: AList WebDAV remote is not running on Android;
        // throw immediately so VideoPlayerPage triggers silent fallback to primary cloud remote
        if (remoteRoot.toLowerCase().startsWith("streamtape:") || filePath.toLowerCase().startsWith("streamtape:")) {
          throw new Error("Streamtape AList WebDAV daemon is not active on Android; falling back to primary cloud remote.");
        }

        const rootTrimmed = remoteRoot.replace(/\/+$/, "");
        if (rootTrimmed && filePath.startsWith(rootTrimmed + "/")) {
          filePath = filePath.slice(rootTrimmed.length + 1);
        } else if (rootTrimmed && rootTrimmed.endsWith(":") && filePath.startsWith(rootTrimmed)) {
          filePath = filePath.slice(rootTrimmed.length).replace(/^\/+/, "");
        }

        let port = 8085;
        if (typeof bridge?.runAsyncTask === "function") {
          try {
            const srv = await runBridgeTaskAsync("startRclone", { remoteRoot, port: 8085 });
            if (srv?.port && srv.port > 0) port = srv.port;
          } catch {
            if (typeof bridge?.startRclone === "function") {
              const p = bridge.startRclone(remoteRoot, 8085);
              if (p > 0) port = p;
            }
          }
        } else if (typeof bridge?.startRclone === "function") {
          const p = bridge.startRclone(remoteRoot, 8085);
          if (p < 0) {
            throw new Error(`Failed to start rclone serve for ${remoteRoot}`);
          }
          port = p;
        }
        const encoded = percentEncodePath(filePath.replace(/^\/+/, ""));
        const fileUrl = encoded
          ? `http://127.0.0.1:${port}/${encoded}`
          : `http://127.0.0.1:${port}/`;
        return {
          file_url: fileUrl,
          local_path: null,
        };
      }

      if (cmd === "start_rclone_serve" || cmd === "get_or_start_serve") {
        const bridge = getBridge();
        const remoteRoot = String(args.remoteRoot || "");
        if (remoteRoot.toLowerCase().startsWith("streamtape:")) {
          throw new Error("Streamtape AList WebDAV daemon is not active on Android");
        }
        if (typeof bridge?.startRclone === "function") {
          const port = bridge.startRclone(remoteRoot, 8085);
          if (port < 0) throw new Error(`Failed to start rclone serve for ${remoteRoot}`);
          return port;
        }
        return 8085;
      }

      // ── DirectPlay Portals, Live Radio & Web Stream Extraction ──────────────

      const inferRefererJs = (targetUrl: string): string => {
        const lower = targetUrl.toLowerCase();
        if (lower.includes("vidmoly") || lower.includes("vmpx.online")) return "https://vidmoly.biz/";
        if (
          lower.includes("saturn.") ||
          lower.includes("jupiter.") ||
          lower.includes("moviebite") ||
          lower.includes("tnmr.org") ||
          lower.includes("hakunaymatata") ||
          lower.includes("bright67")
        ) {
          return "https://moviebite.org/";
        }
        if (lower.includes("pornhub") || lower.includes("phncdn")) return "https://www.pornhub.com/";
        if (
          lower.includes("cinextream") ||
          lower.includes("workers.dev") ||
          lower.includes("dramahot") ||
          lower.includes("drama1")
        ) {
          return "https://cinextream.cc/";
        }
        if (lower.includes("vidara.to") || lower.includes("gosbagotui.com")) return "https://vidara.to/";
        if (lower.includes("ok.ru") || lower.includes("vkuser.net") || lower.includes("okcdn.ru")) return "https://ok.ru/";
        if (lower.includes("vk.com") || lower.includes("vk.ru") || lower.includes("vkvideo.ru")) return "https://vk.com/";
        if (lower.includes("dailymotion") || lower.includes("dmcdn.net")) return "https://www.dailymotion.com/";
        if (lower.includes("bitchute")) return "https://www.bitchute.com/";
        if (lower.includes("odysee") || lower.includes("lbry")) return "https://odysee.com/";
        if (lower.includes("tubi") || lower.includes("adrise.io")) return "https://tubitv.com/";
        try {
          const u = new URL(targetUrl);
          return `${u.protocol}//${u.host}/`;
        } catch {
          return "https://google.com/";
        }
      };

      const buildProxyUrl = (url: string, referer?: string, isHlsExplicit?: boolean) => {
        const ref = referer || inferRefererJs(url);
        const lower = url.toLowerCase();
        const isAudioOrDirectVideo = /\.(mp4|mkv|webm|mp3|flac|m4a|m4b|aac|ogg|wav|opus)(\?|$)/i.test(lower);
        const isHls = isHlsExplicit ?? (!isAudioOrDirectVideo && (
          lower.includes(".m3u8") ||
          lower.includes("/hls/") ||
          lower.includes("master.m3u8") ||
          lower.includes("/playlist.m3u8") ||
          lower.includes("/stitch/hls/")
        ));
        const endpoint = isHls ? "/playlist.m3u8" : "/stream";
        return `http://127.0.0.1:8080${endpoint}?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(ref)}`;
      };

      if (cmd === "get_stream_proxy_url") {
        let targetUrl = String(args.url || "").trim();
        let referer = String(args.referer || "").trim();
        if (!targetUrl) return "";

        // Automatically refresh DropMB short-lived share tokens so offloaded audio/video streams never fail with Format Error
        if (targetUrl.toLowerCase().includes("dropmb.com")) {
          const shareMatch = targetUrl.match(/dropmb\.com\/(?:share|api\/shares|s)\/([a-zA-Z0-9_-]+)/i);
          if (shareMatch) {
            const shareId = shareMatch[1];
            const fileIdMatch = targetUrl.match(/\/files\/([a-zA-Z0-9_-]+)/i);
            let fileId = fileIdMatch ? fileIdMatch[1] : "";
            try {
              const tokResp = await polyfillFetchText(
                `https://dropmb.com/api/shares/${shareId}/token`,
                { "Content-Type": "application/json", Accept: "application/json" },
                "POST",
                "{}"
              );
              let token = "";
              if (tokResp.ok && tokResp.body) {
                token = JSON.parse(tokResp.body)?.token || "";
              }
              if (!fileId) {
                const hdrs: Record<string, string> = { Accept: "application/json" };
                if (token) hdrs["Authorization"] = `Bearer ${token}`;
                const shResp = await polyfillFetchText(`https://dropmb.com/api/shares/${shareId}`, hdrs);
                if (shResp.ok && shResp.body) {
                  const shData = JSON.parse(shResp.body);
                  fileId = shData?.files?.[0]?.id || "";
                }
              }
              if (fileId) {
                targetUrl = `https://dropmb.com/api/shares/${shareId}/files/${fileId}?download=false${
                  token ? `&token=${encodeURIComponent(token)}` : ""
                }`;
                if (!referer) referer = `https://dropmb.com/share/${shareId}`;
              }
            } catch {}
          }
        }

        return buildProxyUrl(targetUrl, referer || inferRefererJs(targetUrl), args.is_hls ?? args.isHls);
      }

      if (cmd === "player_stop" || cmd === "stop_stream_session" || cmd === "stop_all_sessions") {
        return null;
      }

      if (cmd === "get_cinextream_payload") {
        const anilistId = String(args.anilistId || args.anilist_id || "");
        const episode = String(args.episode || "1");

        let categoryUsed = "dub";
        let encStr = "";

        const dubResp = await polyfillFetchText(
          `https://cinextream.cc/api/anime-stream?anilistId=${anilistId}&episode=${episode}&category=dub`,
          { Referer: `https://cinextream.cc/api/embed/anime/dub/${anilistId}/${episode}`, Accept: "application/json" }
        );
        if (dubResp.ok && dubResp.body) {
          try {
            const j = JSON.parse(dubResp.body);
            if (j?.enc) encStr = j.enc;
          } catch {}
        }

        if (!encStr) {
          categoryUsed = "sub";
          const subResp = await polyfillFetchText(
            `https://cinextream.cc/api/anime-stream?anilistId=${anilistId}&episode=${episode}&category=sub`,
            { Referer: `https://cinextream.cc/api/embed/anime/sub/${anilistId}/${episode}`, Accept: "application/json" }
          );
          if (subResp.ok && subResp.body) {
            try {
              const j = JSON.parse(subResp.body);
              if (j?.enc) encStr = j.enc;
            } catch {}
          }
        }

        if (!encStr) {
          throw new Error("No encrypted stream payload returned from CineXtream for dub or sub");
        }

        let wasmBase64 = readPersistentText("cinextream_decrypt_wasm_b64");
        if (!wasmBase64 || wasmBase64.length < 10000) {
          const wasmResp = await polyfillFetchText("https://cinextream.cc/decrypt.wasm");
          if (wasmResp.base64 && wasmResp.base64.length > 10000) {
            wasmBase64 = wasmResp.base64;
            writePersistentText("cinextream_decrypt_wasm_b64", wasmBase64);
          } else {
            const r = await window.fetch("https://cinextream.cc/decrypt.wasm");
            const buf = new Uint8Array(await r.arrayBuffer());
            let bin = "";
            for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
            wasmBase64 = btoa(bin);
            writePersistentText("cinextream_decrypt_wasm_b64", wasmBase64);
          }
        }

        return {
          enc: encStr,
          wasm_base64: wasmBase64,
          category: categoryUsed,
          anilist_id: anilistId,
          episode,
        };
      }

      if (cmd === "search_iheart_radio") {
        const q = String(args.query || "").trim();
        const apiUrl = q
          ? `https://api.iheart.com/api/v2/content/liveStations?q=${encodeURIComponent(q)}&limit=30`
          : "https://api.iheart.com/api/v2/content/liveStations?countryCode=US&limit=30";
        const resp = await polyfillFetchText(apiUrl, { Accept: "application/json" });
        const releases: any[] = [];
        if (resp.ok && resp.body) {
          try {
            const json = JSON.parse(resp.body);
            const hits: any[] = json?.hits || [];
            for (const hit of hits) {
              const name = hit?.name || "Station";
              const desc = hit?.description || "";
              const title = desc ? `${name} · ${desc}` : name;
              const logo = hit?.logo || null;
              const streams = hit?.streams || {};
              const streamUrl =
                streams.secure_shoutcast_stream ||
                streams.shoutcast_stream ||
                streams.secure_hls_stream ||
                streams.hls_stream ||
                "";
              if (streamUrl) {
                releases.push({
                  title,
                  post_url: streamUrl,
                  thumbnail: logo,
                  date: null,
                  site_domain: "iheart.com",
                  media_type: "music",
                  season: null,
                  episode: null,
                });
              }
            }
          } catch {}
        }
        return {
          site_url: "https://www.iheart.com",
          site_title: q ? `iHeartRadio: "${q}"` : "iHeartRadio Live Stations",
          releases,
        };
      }

      if (cmd === "search_jiosaavn_streams") {
        const q = String(args.query || "").trim() || "trending";
        const apiUrl = `https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query=${encodeURIComponent(q)}`;
        const resp = await polyfillFetchText(apiUrl, { Accept: "application/json" });
        const releases: any[] = [];
        if (resp.ok && resp.body) {
          try {
            const json = JSON.parse(resp.body);
            for (const s of json?.songs?.data || []) {
              if (!s?.url) continue;
              const title = s.description ? `${s.title || "Song"} · ${s.description}` : s.title || "Song";
              releases.push({
                title,
                post_url: s.url,
                thumbnail: s.image ? String(s.image).replace("50x50", "500x500") : null,
                date: null,
                site_domain: "jiosaavn.com",
                media_type: "music",
                season: null,
                episode: null,
              });
            }
            for (const a of json?.albums?.data || []) {
              if (!a?.url) continue;
              releases.push({
                title: `💿 Album: ${a.title || "Album"} (${a.description || ""})`,
                post_url: a.url,
                thumbnail: a.image ? String(a.image).replace("50x50", "500x500") : null,
                date: null,
                site_domain: "jiosaavn.com",
                media_type: "music",
                season: null,
                episode: null,
              });
            }
          } catch {}
        }
        return {
          site_url: "https://www.jiosaavn.com",
          site_title: q === "trending" ? "JioSaavn: Trending Songs & Albums" : `JioSaavn: "${q}"`,
          releases,
        };
      }

      if (cmd === "search_streamed_sports") {
        const qLower = String(args.query || "").trim().toLowerCase();
        const resp = await polyfillFetchText("https://streamed.pk/api/matches/all", { Accept: "application/json" });
        const releases: any[] = [];
        if (resp.ok && resp.body) {
          try {
            const list: any[] = JSON.parse(resp.body) || [];
            for (const m of list) {
              const title = String(m?.title || "Live Event");
              const category = String(m?.category || "sports");
              const id = String(m?.id || "");
              if (qLower && !title.toLowerCase().includes(qLower) && !category.toLowerCase().includes(qLower)) {
                continue;
              }
              const poster = m?.poster
                ? String(m.poster).startsWith("http")
                  ? m.poster
                  : `https://streamed.pk${m.poster}`
                : null;
              let postUrl = `https://streamed.pk/watch/${id}`;
              const firstSource = m?.sources?.[0];
              if (firstSource?.source && firstSource?.id) {
                postUrl = `https://embed.st/embed/${firstSource.source}/${firstSource.id}/1`;
              }
              releases.push({
                title: `🏆 ${title} (${category.toUpperCase()})`,
                post_url: postUrl,
                thumbnail: poster,
                date: m?.date ? String(m.date) : null,
                site_domain: "streamed.pk",
                media_type: "sports",
                season: null,
                episode: null,
              });
            }
          } catch {}
        }
        return {
          site_url: "https://streamed.pk",
          site_title: qLower ? `Streamed.pk: "${qLower}"` : "Streamed.pk Live Sports & PPV",
          releases,
        };
      }

      if (cmd === "crawl_website_releases") {
        let siteUrl = String(args.url || args.siteUrl || "").trim();
        if (!siteUrl) throw new Error("URL or site domain cannot be empty");
        if (!siteUrl.startsWith("http://") && !siteUrl.startsWith("https://")) {
          siteUrl = `https://${siteUrl}`;
        }
        const parsedUrl = new URL(siteUrl);
        const host = parsedUrl.hostname.toLowerCase();
        const lowerSite = siteUrl.toLowerCase();
        const maxItems = Number(args.maxItems || 48);

        // Extract optional search query from URL (?q=, ?query=, ?s=, ?search=, /search/)
        let searchQuery = String(args.searchQuery || "").trim();
        if (!searchQuery) {
          searchQuery =
            parsedUrl.searchParams.get("q") ||
            parsedUrl.searchParams.get("query") ||
            parsedUrl.searchParams.get("s") ||
            parsedUrl.searchParams.get("search") ||
            "";
          if (!searchQuery && siteUrl.includes("/search/")) {
            searchQuery = decodeURIComponent(siteUrl.split("/search/")[1]?.split(/[/?#]/)[0] || "");
          }
        }

        // 1. MovieBite (`moviebite.org`)
        if (host.includes("moviebite")) {
          const apiUrl = searchQuery
            ? `https://moviebite.org/api/search?q=${encodeURIComponent(searchQuery)}`
            : "https://moviebite.org/api/trending";
          const resp = await polyfillFetchText(apiUrl, {
            Referer: "https://moviebite.org/",
            Accept: "application/json",
          });
          const releases: any[] = [];
          if (resp.ok && resp.body) {
            try {
              const json = JSON.parse(resp.body);
              const results: any[] = json?.results || json?.data || [];
              for (const item of results) {
                const id = item?.id ?? item?.tmdbId;
                if (!id) continue;
                const mediaType = String(item?.mediaType || item?.media_type || "movie");
                const title = String(item?.title || item?.name || "Untitled");
                const posterPath = item?.posterPath || item?.poster_path || item?.backdropPath;
                const thumbnail = posterPath
                  ? String(posterPath).startsWith("http")
                    ? String(posterPath)
                    : `https://image.tmdb.org/t/p/w500${posterPath}`
                  : null;
                const date = item?.releaseDate || item?.firstAirDate || null;
                releases.push({
                  title,
                  post_url: `https://moviebite.org/watch/${mediaType}/${id}`,
                  thumbnail,
                  date: date ? String(date) : null,
                  site_domain: "moviebite.org",
                  media_type: mediaType === "tv" ? "tv" : "movies",
                  season: null,
                  episode: null,
                });
              }
            } catch {}
          }
          return {
            site_url: siteUrl,
            site_title: searchQuery ? `MovieBite: "${searchQuery}"` : "MovieBite Trending Releases",
            releases,
          };
        }

        // 2. Yomi.to Anime Discovery & Series Drilldown
        if (host.includes("yomi.to") || host.includes("yomi.run")) {
          const seriesMatch = siteUrl.match(/yomi\.(?:to|run)\/(?:anime|category|series)\/([^/?#]+)-(\d+)/i);
          if (seriesMatch) {
            const slug = seriesMatch[1];
            const anilistId = Number(seriesMatch[2]);
            const gql = `query ($id: Int) { Media(id: $id, type: ANIME) { id title { english romaji } coverImage { extraLarge large } episodes nextAiringEpisode { episode } } }`;
            const resp = await polyfillFetchText(
              "https://graphql.anilist.co",
              { "Content-Type": "application/json", Accept: "application/json" },
              "POST",
              JSON.stringify({ query: gql, variables: { id: anilistId } })
            );
            let title = slug.replace(/-/g, " ");
            let thumb: string | null = null;
            let totalEps = 12;
            if (resp.ok && resp.body) {
              try {
                const m = JSON.parse(resp.body)?.data?.Media;
                if (m) {
                  title = m?.title?.english || m?.title?.romaji || title;
                  thumb = m?.coverImage?.extraLarge || m?.coverImage?.large || null;
                  const nextEp = m?.nextAiringEpisode?.episode ? Number(m.nextAiringEpisode.episode) - 1 : 0;
                  totalEps = Number(m?.episodes || nextEp || 12);
                }
              } catch {}
            }
            const releases: any[] = [];
            for (let ep = 1; ep <= Math.min(totalEps, 200); ep++) {
              releases.push({
                title: `${title} - Episode ${ep}`,
                post_url: `https://yomi.to/watch/${slug}-${anilistId}/${ep}`,
                thumbnail: thumb,
                date: null,
                site_domain: "yomi.to",
                media_type: "tv",
                season: 1,
                episode: ep,
              });
            }
            return {
              site_url: siteUrl,
              site_title: `Yomi - ${title}`,
              releases,
            };
          }

          const gql = searchQuery
            ? `query ($search: String) { Page(page: 1, perPage: 25) { media(search: $search, type: ANIME, isAdult: false, sort: SEARCH_MATCH) { id title { english romaji } coverImage { extraLarge large } episodes nextAiringEpisode { episode } format } } }`
            : `query { Page(page: 1, perPage: 25) { media(type: ANIME, isAdult: false, sort: TRENDING_DESC) { id title { english romaji } coverImage { extraLarge large } episodes nextAiringEpisode { episode } format } } }`;
          const variables = searchQuery ? { search: searchQuery } : {};
          const resp = await polyfillFetchText(
            "https://graphql.anilist.co",
            { "Content-Type": "application/json", Accept: "application/json" },
            "POST",
            JSON.stringify({ query: gql, variables })
          );
          const releases: any[] = [];
          if (resp.ok && resp.body) {
            try {
              const items: any[] = JSON.parse(resp.body)?.data?.Page?.media || [];
              for (const m of items) {
                const id = m?.id;
                if (!id) continue;
                const title = m?.title?.english || m?.title?.romaji || `Anime #${id}`;
                const thumb = m?.coverImage?.extraLarge || m?.coverImage?.large || null;
                const formatStr = m?.format || "TV";
                const eps = m?.episodes || (m?.nextAiringEpisode?.episode ? m.nextAiringEpisode.episode - 1 : 1);
                const cleanSlug = String(title)
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "");
                const isMovie = formatStr === "MOVIE" || eps <= 1;
                releases.push({
                  title,
                  post_url: isMovie
                    ? `https://yomi.to/watch/${cleanSlug}-${id}/1`
                    : `https://yomi.to/anime/${cleanSlug}-${id}`,
                  thumbnail: thumb,
                  date: null,
                  site_domain: "yomi.to",
                  media_type: isMovie ? "movies" : "tv",
                  season: isMovie ? null : 1,
                  episode: null,
                });
              }
            } catch {}
          }
          return {
            site_url: siteUrl,
            site_title: searchQuery ? `Yomi Search: ${searchQuery}` : "Yomi Trending Anime",
            releases,
          };
        }

        // 4. Tubi TV Live Channels
        if (host.includes("tubitv") || host.includes("tubi.tv") || lowerSite.includes("tubi")) {
          const m3uUrl = "https://raw.githubusercontent.com/BuddyChewChew/tubi-scraper/refs/heads/main/tubi_playlist.m3u";
          const resp = await polyfillFetchText(m3uUrl);
          const releases: any[] = [];
          const qLower = searchQuery.toLowerCase();
          if (resp.ok && resp.body) {
            let currentTitle = "";
            let currentLogo: string | null = null;
            for (const rawLine of resp.body.split(/\r?\n/)) {
              const trimmed = rawLine.trim();
              if (trimmed.startsWith("#EXTINF:")) {
                const logoMatch = trimmed.match(/tvg-logo=["']([^"']+)["']/i);
                currentLogo = logoMatch ? logoMatch[1] : null;
                const commaIdx = trimmed.lastIndexOf(",");
                currentTitle = commaIdx >= 0 ? trimmed.slice(commaIdx + 1).trim() : "";
              } else if (trimmed.startsWith("http") && currentTitle) {
                if (!qLower || currentTitle.toLowerCase().includes(qLower)) {
                  releases.push({
                    title: currentTitle,
                    post_url: trimmed,
                    thumbnail: currentLogo,
                    date: null,
                    site_domain: "tubitv.com",
                    media_type: "tv",
                    season: null,
                    episode: null,
                  });
                }
                currentTitle = "";
                currentLogo = null;
              }
            }
          }
          return {
            site_url: "https://tubitv.com",
            site_title: "Tubi TV Live Channels",
            releases,
          };
        }

        // 5. Archive.org
        if (host.includes("archive.org")) {
          const idMatch = siteUrl.match(/archive\.org\/(?:details|metadata|download|embed)\/([^/?#]+)/i);
          const identifier = idMatch ? idMatch[1] : "";
          if (identifier && !["movies", "audio", "texts"].includes(identifier.toLowerCase())) {
            const metaResp = await polyfillFetchText(`https://archive.org/metadata/${identifier}`);
            if (metaResp.ok && metaResp.body) {
              try {
                const json = JSON.parse(metaResp.body);
                const rawTitle = json?.metadata?.title || identifier;
                const poster = `https://archive.org/services/img/${identifier}`;
                const releases: any[] = [];
                for (const file of json?.files || []) {
                  const name = String(file?.name || "");
                  if (!name || name.startsWith("_")) continue;
                  const lower = name.toLowerCase();
                  const isVideo = /\.(mp4|mkv|webm|avi|mov|flv|ts|m4v)$/.test(lower);
                  const isAudio = /\.(mp3|m4a|flac|ogg|wav|opus)$/.test(lower);
                  const isBook = /\.(epub|pdf|cbz|cbr)$/.test(lower);
                  if (!isVideo && !isAudio && !isBook) continue;
                  releases.push({
                    title: file?.title || name.replace(/\.[^.]+$/, "").replace(/_/g, " "),
                    post_url: `https://archive.org/download/${identifier}/${encodeURIComponent(name).replace(/%2F/g, "/")}`,
                    thumbnail: poster,
                    date: file?.mtime ? String(file.mtime) : null,
                    site_domain: "archive.org",
                    media_type: isBook ? "books" : isAudio ? "music" : "movies",
                    season: null,
                    episode: null,
                  });
                }
                return {
                  site_url: siteUrl,
                  site_title: `Archive.org: ${rawTitle}`,
                  releases,
                };
              } catch {}
            }
          }
        }

        // 6. Pixeldrain List
        if (host.includes("pixeldrain.com") && siteUrl.includes("/l/")) {
          const lid = siteUrl.split("/l/")[1]?.split(/[/?#]/)[0] || "";
          const resp = await polyfillFetchText(`https://pixeldrain.com/api/list/${lid}`);
          const releases: any[] = [];
          let listTitle = "Pixeldrain Album";
          if (resp.ok && resp.body) {
            try {
              const json = JSON.parse(resp.body);
              listTitle = json?.title || listTitle;
              for (const f of json?.files || []) {
                if (!f?.id || !f?.name) continue;
                releases.push({
                  title: f.name,
                  post_url: `https://pixeldrain.com/api/file/${f.id}`,
                  thumbnail: `https://pixeldrain.com/api/file/${f.id}/thumbnail`,
                  date: null,
                  site_domain: "pixeldrain.com",
                  media_type: String(f.mime_type || "").startsWith("audio") ? "music" : "movies",
                  season: null,
                  episode: null,
                });
              }
            } catch {}
          }
          return {
            site_url: siteUrl,
            site_title: listTitle,
            releases,
          };
        }

        // 7. SxyPrn
        if (host.includes("sxyprn.com")) {
          const resp = await polyfillFetchText(siteUrl, { Referer: "https://www.sxyprn.com/" });
          const releases: any[] = [];
          const seen = new Set<string>();
          const re = /href=['"](\/post\/[a-fA-F0-9]{10,20}(?:\.html)?[^'"]*)['"]/gi;
          let m: RegExpExecArray | null;
          while ((m = re.exec(resp.body)) !== null && releases.length < maxItems) {
            const rel = m[1];
            const fullUrl = `https://www.sxyprn.com${rel}`;
            if (seen.has(fullUrl)) continue;
            seen.add(fullUrl);
            const slice = resp.body.slice(Math.max(0, m.index - 800), Math.min(resp.body.length, m.index + 800));
            const titleMatch = slice.match(/title=['"]([^'"]{4,200})['"]/i);
            const imgMatch = slice.match(/(?:data-src|src)=['"]((?:https?:)?\/\/[^'"]+\.(?:jpg|jpeg|png|webp)[^'"]*)['"]/i);
            let poster = imgMatch?.[1] || null;
            if (poster && poster.startsWith("//")) poster = `https:${poster}`;
            releases.push({
              title: (titleMatch?.[1] || `SxyPrn Video ${releases.length + 1}`).trim(),
              post_url: fullUrl,
              thumbnail: poster,
              date: null,
              site_domain: "sxyprn.com",
              media_type: "adult",
              season: null,
              episode: null,
            });
          }
          return {
            site_url: siteUrl,
            site_title: "SxyPrn",
            releases,
          };
        }

        // 8. PornHub
        if (host.includes("pornhub.com")) {
          const resp = await polyfillFetchText(siteUrl, {
            Referer: "https://www.pornhub.com/",
            Cookie: "age_verified=1; platform=pc; accessAgeDisclaimerPH=1",
          });
          const releases: any[] = [];
          const seen = new Set<string>();
          const re = /href=["'](\/view_video\.php\?viewkey=[a-zA-Z0-9]+)["'][^>]*title=["']([^"']+)["']/gi;
          let m: RegExpExecArray | null;
          while ((m = re.exec(resp.body)) !== null && releases.length < maxItems) {
            const fullUrl = `https://www.pornhub.com${m[1]}`;
            if (seen.has(fullUrl)) continue;
            seen.add(fullUrl);
            const slice = resp.body.slice(Math.max(0, m.index - 600), Math.min(resp.body.length, m.index + 600));
            const imgMatch = slice.match(/(?:data-mediumthumb|data-src|src)=["'](https:\/\/[^"']+\.(?:jpg|webp)[^"']*)["']/i);
            releases.push({
              title: m[2].replace(/&amp;/g, "&").replace(/&#039;/g, "'").trim(),
              post_url: fullUrl,
              thumbnail: imgMatch?.[1] || null,
              date: null,
              site_domain: "pornhub.com",
              media_type: "adult",
              season: null,
              episode: null,
            });
          }
          return {
            site_url: siteUrl,
            site_title: "PornHub",
            releases,
          };
        }

        // 8b. Balbums (Bunkr Albums Search Directory)
        if (host.includes("balbums")) {
          const resp = await polyfillFetchText(siteUrl, {
            Referer: "https://balbums.st/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
          });
          const releases: any[] = [];
          const seen = new Set<string>();
          const cardRe = /<a\s+href="([^"]*bunkr[^"]*\/a\/[^"]*)"[^>]*class="[^"]*card[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
          let m: RegExpExecArray | null;
          while ((m = cardRe.exec(resp.body)) !== null && releases.length < maxItems) {
            const postUrl = m[1].trim();
            if (seen.has(postUrl)) continue;
            seen.add(postUrl);
            const inner = m[2];
            const titleMatch = inner.match(/<h3[^>]*>([^<]+)<\/h3>/i) || inner.match(/alt="([^"]+)"/i);
            const countMatch = inner.match(/<span[^>]*>([0-9]+\s*files?)<\/span>/i);
            const imgMatch = inner.match(/<img[^>]+src="([^"]+)"/i);
            const titleStr = (titleMatch?.[1] || "Bunkr Album").trim();
            const countStr = countMatch ? ` (${countMatch[1].trim()})` : "";
            releases.push({
              title: `${titleStr}${countStr}`,
              post_url: postUrl,
              thumbnail: imgMatch?.[1] || null,
              date: null,
              site_domain: "balbums.st",
              media_type: "adult",
              season: null,
              episode: null,
            });
          }
          return {
            site_url: siteUrl,
            site_title: "Balbums (Bunkr Albums)",
            releases,
          };
        }

        // 8c. Bunkr Album Feed (Inside an Album)
        if ((host.includes("bunkr") || host.includes("bunkrr")) && siteUrl.includes("/a/")) {
          const resp = await polyfillFetchText(siteUrl, {
            Referer: "https://balbums.st/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
          });
          const origin = parsedUrl.origin;
          const albumTitleMatch = resp.body.match(/<h1[^>]*>([^<]+)<\/h1>/i);
          const albumTitle = albumTitleMatch ? albumTitleMatch[1].trim() : "Bunkr Album";
          const releases: any[] = [];
          const seen = new Set<string>();
          const itemRe = /<div[^>]*class="[^"]*theItem[^"]*"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)href="(\/[fvd]\/[a-zA-Z0-9]+)"/gi;
          let m: RegExpExecArray | null;
          while ((m = itemRe.exec(resp.body)) !== null && releases.length < maxItems) {
            const rawTitle = m[1].trim();
            const inner = m[2];
            const relHref = m[3];
            const fullUrl = `${origin}${relHref}`;
            if (seen.has(fullUrl)) continue;
            seen.add(fullUrl);
            const sizeMatch = inner.match(/<p[^>]*class="[^"]*theSize[^"]*"[^>]*>([^<]+)<\/p>/i);
            const sizeStr = sizeMatch ? ` [${sizeMatch[1].trim()}]` : "";
            const imgMatch = inner.match(/<img[^>]+src="([^"]+)"/i);
            let thumb = imgMatch?.[1] || null;
            if (thumb && thumb.startsWith("/")) thumb = `${origin}${thumb}`;
            releases.push({
              title: `${rawTitle || "Media File"}${sizeStr}`,
              post_url: fullUrl,
              thumbnail: thumb,
              date: null,
              site_domain: host,
              media_type: "adult",
              season: null,
              episode: null,
            });
          }
          return {
            site_url: siteUrl,
            site_title: albumTitle,
            releases,
          };
        }

        // 9. BaddiesEast / BrokenSilenze / WordPress RSS & HTML
        const feedCandidates = [
          `${siteUrl.replace(/\/$/, "")}/feed/`,
          `${siteUrl.replace(/\/$/, "")}/feed`,
          siteUrl,
        ];
        for (const fUrl of feedCandidates) {
          const resp = await polyfillFetchText(fUrl, { Referer: parsedUrl.origin });
          if (resp.ok && resp.body && (resp.body.includes("<rss") || resp.body.includes("<feed") || resp.body.includes("<item"))) {
            const releases: any[] = [];
            const itemRe = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
            let m: RegExpExecArray | null;
            while ((m = itemRe.exec(resp.body)) !== null && releases.length < maxItems) {
              const block = m[1];
              const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] || "Episode")
                .replace(/<[^>]+>/g, "")
                .replace(/&#8211;/g, "-")
                .replace(/&amp;/g, "&")
                .trim();
              const link =
                block.match(/<enclosure[^>]+url=["']([^"']+)["']/i)?.[1] ||
                block.match(/<link[^>]*>([^<]+)<\/link>/i)?.[1] ||
                block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ||
                "";
              if (!link) continue;
              const img = block.match(/(?:url|href|src)=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i)?.[1] || null;
              const seMatch = title.match(/[sS](\d{1,2})[eE](\d{1,2})/);
              releases.push({
                title,
                post_url: link.trim(),
                thumbnail: img,
                date: null,
                site_domain: host,
                media_type: seMatch ? "tv" : "movies",
                season: seMatch ? parseInt(seMatch[1], 10) : null,
                episode: seMatch ? parseInt(seMatch[2], 10) : null,
              });
            }
            if (releases.length > 0) {
              return {
                site_url: siteUrl,
                site_title: host,
                releases,
              };
            }
          }
        }

        // 10. Generic HTML scrape fallback
        const resp = await polyfillFetchText(siteUrl, { Referer: parsedUrl.origin });
        const releases: any[] = [];
        const seen = new Set<string>();
        if (resp.ok && resp.body) {
          const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
          let m: RegExpExecArray | null;
          while ((m = linkRe.exec(resp.body)) !== null && releases.length < maxItems) {
            let href = m[1];
            try {
              href = new URL(href, siteUrl).toString();
            } catch {}
            if (!href.startsWith("http") || seen.has(href)) continue;
            const inner = m[2];
            const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            const slice = resp.body.slice(Math.max(0, m.index - 400), Math.min(resp.body.length, m.index + 600));
            const img = slice.match(/(?:data-src|src)=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i)?.[1] || null;
            if (text.length < 4) continue;
            seen.add(href);
            let posterUrl = img;
            if (posterUrl) {
              try {
                posterUrl = new URL(posterUrl, siteUrl).toString();
              } catch {}
            }
            releases.push({
              title: text,
              post_url: href,
              thumbnail: posterUrl,
              date: null,
              site_domain: host,
              media_type: "movies",
              season: null,
              episode: null,
            });
          }
        }

        return {
          site_url: siteUrl,
          site_title: host,
          releases,
        };
      }

      if (cmd === "fetch_web_stream_info" || cmd === "resolve_web_stream_url") {
        const rawUrl = String(args.url || "").trim();
        const lower = rawUrl.toLowerCase();

        const wrapReturn = (
          title: string,
          streamUrl: string,
          provider = "Direct Stream",
          mediaType = "movies",
          isDirect = true,
          posterUrl: string | null = null
        ) => {
          if (cmd === "resolve_web_stream_url") return streamUrl;
          return {
            original_url: rawUrl,
            direct_stream_url: streamUrl,
            raw_title: title,
            clean_title: title,
            description: null,
            poster_url: posterUrl,
            provider,
            is_direct_media: isDirect,
            media_type: mediaType,
            year: null,
            format: streamUrl.includes(".m3u8") ? "m3u8" : "mp4",
            season: null,
            episode: null,
          };
        };

        // 0. Easynews and HTTP Basic Auth streams (user:pass@host or members.easynews.com)
        if (
          lower.includes("members.easynews.com") ||
          (rawUrl.includes("@") && (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")))
        ) {
          const proxied = buildProxyUrl(rawUrl, "https://members.easynews.com/");
          return wrapReturn("Easynews Stream", proxied, "Easynews", "movies", true);
        }

        // 1. Direct media or local stream
        if (
          lower.startsWith("http://127.0.0.1") ||
          lower.includes(".m3u8") ||
          /\.(mp4|mkv|webm|mp3|flac|m4a|aac|ogg|wav)(\?|$)/i.test(lower)
        ) {
          const outUrl =
            !lower.startsWith("http://127.0.0.1") && lower.includes(".m3u8")
              ? buildProxyUrl(rawUrl)
              : rawUrl;
          return wrapReturn(rawUrl.split("/").pop()?.split("?")[0] || "Direct Stream", outUrl);
        }

        // 3. MovieBite (`https://moviebite.org/watch/{movie|tv}/{tmdbId}`)
        if (lower.includes("moviebite.org/watch/")) {
          const m = rawUrl.match(/moviebite\.org\/watch\/(movie|tv)\/(\d+)/i);
          if (m) {
            const mType = m[1].toLowerCase();
            const tmdbId = m[2];
            let s = "1";
            let e = "1";
            try {
              const u = new URL(rawUrl);
              s = u.searchParams.get("season") || u.searchParams.get("s") || "1";
              e = u.searchParams.get("episode") || u.searchParams.get("ep") || "1";
            } catch {}
            const apiUrl = `https://moviebite.org/api/watch?id=${tmdbId}&tmdbId=${tmdbId}&type=${mType}&mediaType=${mType}&season=${s}&s=${s}&episode=${e}&ep=${e}&mode=fast&expand=0`;
            const apiResp = await polyfillFetchText(apiUrl, {
              Accept: "application/json",
              "X-MovieBite-Client": "1",
              Referer: rawUrl,
            });
            if (apiResp.ok && apiResp.body) {
              try {
                const json = JSON.parse(apiResp.body);
                const streams: any[] = json?.results?.streams || [];
                const titleRaw = json?.results?.source || json?.results?.media?.title || "MovieBite Stream";

                const candidates: Array<{ url: string; score: number }> = [];
                for (const st of streams) {
                  let sUrl = String(st?.url || "").trim();
                  if (!sUrl) continue;
                  if (sUrl.startsWith("/stream-embed/")) {
                    sUrl = `https://moviebite.org${sUrl}`;
                  }
                  // Decode embedded JWT payload if present
                  const tokPart = sUrl.split("/").pop() || "";
                  const mid = tokPart.split(".")[1] || tokPart.split(".")[0] || "";
                  if (mid.length > 20) {
                    try {
                      const b64 = mid.replace(/-/g, "+").replace(/_/g, "/");
                      const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
                      const dec = JSON.parse(atob(b64 + pad));
                      if (dec?.m3u8?.startsWith("http")) sUrl = dec.m3u8;
                      else if (dec?.cloudUrl?.startsWith("http")) sUrl = dec.cloudUrl;
                    } catch {}
                  }

                  let score = 0;
                  const sLower = sUrl.toLowerCase();
                  if (sLower.includes("workers.dev") || sLower.includes("tnmr.org") || sLower.includes("bx5")) {
                    score += 250;
                  } else if (sLower.includes("dragonballzfans")) {
                    score += 180;
                  } else if (sLower.includes(".m3u8") && !sLower.includes("cdn-proxy")) {
                    score += 150;
                  } else if (sLower.includes("cdn-proxy")) {
                    score -= 60;
                  }
                  candidates.push({ url: sUrl, score });
                }

                candidates.sort((a, b) => b.score - a.score);
                if (candidates.length > 0 && candidates[0].url.startsWith("http")) {
                  const proxied = buildProxyUrl(candidates[0].url, "https://moviebite.org/");
                  return wrapReturn(titleRaw, proxied, "MovieBite", mType === "tv" ? "tv" : "movies", false);
                }
              } catch {}
            }
          }
        }

        // 4. Yomi.to (`https://yomi.to/watch/{slug}-{anilistId}/{ep}`)
        if (lower.includes("yomi.to/watch/")) {
          const ym = rawUrl.match(/yomi\.to\/watch\/([^/?#]+)-(\d+)\/(\d+)/i);
          if (ym) {
            const cleanTitle = `${ym[1].replace(/-/g, " ")} Episode ${ym[3]}`;
            const marker = `cinextream://${ym[2]}/${ym[3]}`;
            return wrapReturn(cleanTitle, marker, "Yomi.to", "tv", false);
          }
        }

        // 5. DropMB share or file URL
        if (lower.includes("dropmb.com")) {
          const shareMatch = rawUrl.match(/dropmb\.com\/(?:share|api\/shares|s)\/([a-zA-Z0-9_-]+)/i);
          if (shareMatch) {
            const shareId = shareMatch[1];
            const tokResp = await polyfillFetchText(
              `https://dropmb.com/api/shares/${shareId}/token`,
              { "Content-Type": "application/json", Accept: "application/json" },
              "POST",
              "{}"
            );
            let token = "";
            if (tokResp.ok && tokResp.body) {
              try {
                token = JSON.parse(tokResp.body)?.token || "";
              } catch {}
            }
            const hdrs: Record<string, string> = { Accept: "application/json" };
            if (token) hdrs["Authorization"] = `Bearer ${token}`;
            const shResp = await polyfillFetchText(`https://dropmb.com/api/shares/${shareId}`, hdrs);
            if (shResp.ok && shResp.body) {
              try {
                const data = JSON.parse(shResp.body);
                const file = data?.files?.[0];
                if (file?.id) {
                  const dlUrl = `https://dropmb.com/api/shares/${shareId}/files/${file.id}?download=false${
                    token ? `&token=${encodeURIComponent(token)}` : ""
                  }`;
                  const proxied = buildProxyUrl(dlUrl, `https://dropmb.com/share/${shareId}`);
                  return wrapReturn(file.name || `DropMB ${shareId}`, proxied, "dropmb", "music", true);
                }
              } catch {}
            }
          }
          const proxied = buildProxyUrl(rawUrl, "https://dropmb.com/");
          return wrapReturn("DropMB Stream", proxied, "dropmb", "music", true);
        }

        // 6. Streamtape
        if (lower.includes("streamtape.com") || lower.includes("streamtape.to") || lower.includes("tapecontent.net")) {
          const resp = await polyfillFetchText(rawUrl, { Referer: "https://streamtape.com/" });
          if (resp.ok && resp.body) {
            const tokenMatches = Array.from(resp.body.matchAll(/token=([A-Za-z0-9_-]+)/g));
            const idMatch = resp.body.match(/id=([A-Za-z0-9_-]+)&expires=([0-9]+)&ip=([A-Za-z0-9_.-]+)/);
            if (idMatch && tokenMatches.length > 0) {
              const lastToken = tokenMatches[tokenMatches.length - 1][1];
              const getVideoUrl = `https://streamtape.com/get_video?id=${idMatch[1]}&expires=${idMatch[2]}&ip=${idMatch[3]}&token=${lastToken}&stream=1`;
              const proxied = buildProxyUrl(getVideoUrl, rawUrl);
              return wrapReturn("Streamtape Video", proxied, "Streamtape", "movies", true);
            }
          }
        }

        // 7. Pixeldrain
        if (lower.includes("pixeldrain.com/u/") || lower.includes("pixeldrain.com/api/file/")) {
          const fid = rawUrl.split(/\/u\/|\/api\/file\//)[1]?.split(/[/?#]/)[0];
          if (fid) {
            return wrapReturn(
              `Pixeldrain ${fid}`,
              `https://pixeldrain.com/api/file/${fid}`,
              "Pixeldrain",
              "movies",
              true,
              `https://pixeldrain.com/api/file/${fid}/thumbnail`
            );
          }
        }

        // 8. Archive.org details page
        if (lower.includes("archive.org/details/")) {
          const id = rawUrl.split("/details/")[1]?.split(/[/?#]/)[0];
          if (id) {
            const metaResp = await polyfillFetchText(`https://archive.org/metadata/${id}`);
            if (metaResp.ok && metaResp.body) {
              try {
                const meta = JSON.parse(metaResp.body);
                const files: any[] = meta?.files || [];
                const mediaFile =
                  files.find((f) => /\.(mp4|m4v|webm)$/i.test(f.name || "")) ||
                  files.find((f) => /\.(mp3|m4a|flac|ogg)$/i.test(f.name || "")) ||
                  files.find((f) => /\.(mkv|avi|mov)$/i.test(f.name || ""));
                if (mediaFile?.name) {
                  const directUrl = `https://archive.org/download/${id}/${encodeURIComponent(mediaFile.name).replace(/%2F/g, "/")}`;
                  return wrapReturn(
                    meta?.metadata?.title || mediaFile.name,
                    directUrl,
                    "Archive.org",
                    "movies",
                    true,
                    `https://archive.org/services/img/${id}`
                  );
                }
              } catch {}
            }
          }
        }

        // 9. PornHub video page
        if (lower.includes("pornhub.com/view_video.php")) {
          const resp = await polyfillFetchText(rawUrl, {
            Referer: "https://www.pornhub.com/",
            Cookie: "age_verified=1; platform=pc; accessAgeDisclaimerPH=1",
          });
          if (resp.ok && resp.body) {
            const mdMatch = resp.body.match(/var\s+mediaDefinitions\s*=\s*(\[[^;]+\]);/);
            if (mdMatch) {
              try {
                const defs: any[] = JSON.parse(mdMatch[1]);
                const hlsDef = defs.find((d) => d?.format === "hls" && d?.videoUrl);
                const mp4Def = defs.find(
                  (d) => d?.videoUrl && typeof d.videoUrl === "string" && d.videoUrl.startsWith("http")
                );
                const targetDef = hlsDef || mp4Def;
                if (targetDef?.videoUrl) {
                  const cleanUrl = targetDef.videoUrl.replace(/\\\//g, "/");
                  const proxied = buildProxyUrl(cleanUrl, "https://www.pornhub.com/");
                  return wrapReturn("PornHub Video", proxied, "PornHub", "adult", true);
                }
              } catch {}
            }
            const vMatch = resp.body.match(/"videoUrl"\s*:\s*"(https?:[\\/]+[^"]+)"/);
            if (vMatch) {
              const cleanUrl = vMatch[1].replace(/\\\//g, "/");
              const proxied = buildProxyUrl(cleanUrl, "https://www.pornhub.com/");
              return wrapReturn("PornHub Video", proxied, "PornHub", "adult", true);
            }
          }
        }

        // 10. SxyPrn post page (decodes data-vnfo cipher)
        if (lower.includes("sxyprn.com/post/")) {
          const resp = await polyfillFetchText(rawUrl, { Referer: "https://www.sxyprn.com/" });
          if (resp.ok && resp.body) {
            const vnfoMatch = resp.body.match(/data-vnfo=['"](\{[^'"]+\})['"]/i);
            if (vnfoMatch) {
              try {
                const vnfo = JSON.parse(vnfoMatch[1].replace(/&quot;/g, '"'));
                const firstKey = Object.keys(vnfo)[0];
                const rawPath: string = vnfo[firstKey] || "";
                if (rawPath) {
                  const parts = rawPath.split("/");
                  if (parts.length >= 8) {
                    const ssut51 = (s: string) => {
                      let sum = 0;
                      for (const ch of s) {
                        const d = parseInt(ch, 10);
                        if (!isNaN(d)) sum += d;
                      }
                      return sum;
                    };
                    const boo = (ss: number, hostStr: string, es: number) => {
                      const str = `${ss}-${hostStr}-${es}`;
                      return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ".");
                    };
                    const s6 = ssut51(parts[6]);
                    const s7 = ssut51(parts[7]);
                    const host = "www.sxyprn.com";
                    parts[1] = `${parts[1]}8/${boo(s6, host, s7)}`;
                    const num5 = parseInt(parts[5], 10);
                    if (!isNaN(num5)) {
                      parts[5] = String(num5 - s6 - s7);
                    }
                    const decodedUrl = `https://${host}/${parts.join("/")}`;
                    const proxied = buildProxyUrl(decodedUrl, rawUrl);
                    return wrapReturn("SxyPrn Video", proxied, "Sxyprn", "adult", true);
                  }
                }
              } catch {}
            }
          }
        }

        // 11. Generic HTML page inspection & embedded iframes (Vidmoly, VOE, VKSpeed, Streamtape, Filemoon, Doodstream, OK.ru)
        const pageResp = await polyfillFetchText(rawUrl, { Referer: rawUrl });
        if (pageResp.ok && pageResp.body) {
          const pBody = pageResp.body;
          const iframeMatches = Array.from(pBody.matchAll(/<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/gi)).map((m) => m[1]);
          const dataVideoMatches = Array.from(pBody.matchAll(/data-video=["']([^"']+)["']/gi)).map((m) => m[1]);
          const allEmbeds = [...iframeMatches, ...dataVideoMatches];

          for (let embedUrl of allEmbeds) {
            if (embedUrl.startsWith("//")) embedUrl = `https:${embedUrl}`;
            const embLower = embedUrl.toLowerCase();

            // Vidmoly
            if (embLower.includes("vidmoly")) {
              const vResp = await polyfillFetchText(embedUrl, { Referer: rawUrl });
              if (vResp.ok && vResp.body) {
                const sMatch =
                  vResp.body.match(/sources:\s*\[\s*\{\s*file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i) ||
                  vResp.body.match(/['"](https?:\/\/[^'"]+\.m3u8(?:\?[^'"]*)?)['"]/i);
                if (sMatch) {
                  return wrapReturn("Vidmoly Stream", buildProxyUrl(sMatch[1], "https://vidmoly.biz/"), "Vidmoly", "movies", true);
                }
              }
            }

            // VOE
            if (embLower.includes("voe.sx") || embLower.includes("johnfullwonder.com")) {
              const voeResp = await polyfillFetchText(embedUrl, { Referer: rawUrl });
              if (voeResp.ok && voeResp.body) {
                const redMatch = voeResp.body.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
                let targetVoeBody = voeResp.body;
                if (redMatch) {
                  const redResp = await polyfillFetchText(redMatch[1], { Referer: embedUrl });
                  if (redResp.ok && redResp.body) targetVoeBody = redResp.body;
                }
                const mMatch =
                  targetVoeBody.match(/['"](https?:\/\/[^'"]+\.m3u8(?:\?[^'"]*)?)['"]/i) ||
                  targetVoeBody.match(/(?:'hls'|"hls")\s*:\s*['"]([^'"]+)['"]/i);
                if (mMatch) {
                  return wrapReturn("VOE Stream", buildProxyUrl(mMatch[1], "https://voe.sx/"), "VOE", "movies", true);
                }
              }
            }

            // VKSpeed
            if (embLower.includes("vkspeed")) {
              const vkResp = await polyfillFetchText(embedUrl, { Referer: rawUrl });
              if (vkResp.ok && vkResp.body) {
                const unpacked = unpackPackedJs(vkResp.body) || vkResp.body;
                const mp4Match =
                  unpacked.match(/(https?:\/\/[^"'\s\\]+\.vkcdn\d*\.com\/[^"'\s\\]+\/v\.mp4)/i) ||
                  unpacked.match(/['"](https?:\/\/[^"']+\.mp4(?:\?[^"']*)?)['"]/i);
                if (mp4Match) {
                  return wrapReturn("VKSpeed Stream", buildProxyUrl(mp4Match[1], "https://vkspeed.com/"), "VKSpeed", "movies", true);
                }
              }
            }

            // Streamtape
            if (embLower.includes("streamtape")) {
              const stResp = await polyfillFetchText(embedUrl, { Referer: rawUrl });
              if (stResp.ok && stResp.body) {
                const tokenMatches = Array.from(stResp.body.matchAll(/token=([A-Za-z0-9_-]+)/g));
                const idMatch = stResp.body.match(/id=([A-Za-z0-9_-]+)&expires=([0-9]+)&ip=([A-Za-z0-9_.-]+)/);
                if (idMatch && tokenMatches.length > 0) {
                  const lastToken = tokenMatches[tokenMatches.length - 1][1];
                  const getVideoUrl = `https://streamtape.com/get_video?id=${idMatch[1]}&expires=${idMatch[2]}&ip=${idMatch[3]}&token=${lastToken}&stream=1`;
                  return wrapReturn("Streamtape Video", buildProxyUrl(getVideoUrl, embedUrl), "Streamtape", "movies", true);
                }
              }
            }

            // Filemoon / Lulustream
            if (embLower.includes("filemoon") || embLower.includes("lulustream")) {
              const fmResp = await polyfillFetchText(embedUrl, { Referer: rawUrl });
              if (fmResp.ok && fmResp.body) {
                const unpacked = unpackPackedJs(fmResp.body) || fmResp.body;
                const m3u8Match = unpacked.match(/['"](https?:\/\/[^'"]+\.m3u8(?:\?[^'"]*)?)['"]/i);
                if (m3u8Match) {
                  return wrapReturn("Filemoon Stream", buildProxyUrl(m3u8Match[1], embedUrl), "Filemoon", "movies", true);
                }
              }
            }

            // OK.ru
            if (embLower.includes("ok.ru")) {
              let cleanOk = embedUrl.replace("ok.ru/video/", "ok.ru/videoembed/");
              const okResp = await polyfillFetchText(cleanOk, { Referer: rawUrl });
              if (okResp.ok && okResp.body) {
                const optMatch = okResp.body.match(/data-options=["']([^"']+)["']/i);
                if (optMatch) {
                  try {
                    const parsedOpt = JSON.parse(optMatch[1].replace(/&quot;/g, '"'));
                    const fv = parsedOpt.flashvars || {};
                    const meta = typeof fv.metadata === "string" ? JSON.parse(fv.metadata) : (fv.metadata || fv);
                    const videos: any[] = meta.videos || [];
                    if (videos.length > 0) {
                      const vUrl = videos[0].url || videos[videos.length - 1].url;
                      if (vUrl) {
                        return wrapReturn("OK.ru Video", buildProxyUrl(vUrl, "https://ok.ru/"), "OK.ru", "movies", true);
                      }
                    }
                    if (meta.hlsManifestUrl) {
                      return wrapReturn("OK.ru Stream", buildProxyUrl(meta.hlsManifestUrl, "https://ok.ru/"), "OK.ru", "movies", true);
                    }
                  } catch {}
                }
              }
            }
          }

          // Direct .m3u8 or .mp4 in main page
          const m3u8Match = pBody.match(/https?:\/\/[^"'\\\s<>]+\.m3u8[^"'\\\s<>]*/i);
          if (m3u8Match) {
            const proxied = buildProxyUrl(m3u8Match[0].replace(/\\\//g, "/"), rawUrl);
            return wrapReturn("HLS Stream", proxied, "HLS Stream", "movies", true);
          }
          const mp4Match = pBody.match(/https?:\/\/[^"'\\\s<>]+\.mp4[^"'\\\s<>]*/i);
          if (mp4Match) {
            const proxied = buildProxyUrl(mp4Match[0].replace(/\\\//g, "/"), rawUrl);
            return wrapReturn("MP4 Stream", proxied, "Direct Stream", "movies", true);
          }
        }

        return wrapReturn(rawUrl, rawUrl, "Web Stream", "movies", false);
      }

      // ── Status & Misc Safe Defaults ──────────────────────────────────────────

      if (cmd === "open_external_url") {
        const u = String(args.url || "");
        if (u) window.open(u, "_blank", "noopener,noreferrer");
        return null;
      }

      if (cmd === "rclone_create_webdav_remote") {
        const name = String(args.remoteName || "webdav").trim();
        const url = String(args.url || "").trim();
        const vendor = String(args.vendor || "other").trim();
        const user = String(args.user || "").trim();
        const pass = String(args.pass || "").trim();
        let section = `[${name}]\ntype = webdav\nurl = ${url}\nvendor = ${vendor}\n`;
        if (user) section += `user = ${user}\n`;
        if (pass) {
          const bridge = getBridge();
          let obscured = pass;
          if (typeof bridge?.runAsyncTask === "function") {
            const r = await runBridgeTaskAsync("runRcloneCommand", { argsJson: JSON.stringify(["obscure", pass]) });
            if (r?.ok && r.stdout) obscured = r.stdout.trim();
          }
          section += `pass = ${obscured}\n`;
        }
        const merged = mergeIniSections(getRcloneConfigText(), section);
        saveRcloneConfigText(merged);
        return parseIniRemotes(merged);
      }

      if (cmd === "rclone_create_crypt_remote") {
        const name = String(args.cryptRemoteName || "vault").trim();
        const target = String(args.targetRemotePath || "").trim();
        const pass = String(args.password || "");
        const bridge = getBridge();
        let obscured = pass;
        if (typeof bridge?.runAsyncTask === "function") {
          const r = await runBridgeTaskAsync("runRcloneCommand", { argsJson: JSON.stringify(["obscure", pass]) });
          if (r?.ok && r.stdout) obscured = r.stdout.trim();
        }
        const section = `[${name}]\ntype = crypt\nremote = ${target}\npassword = ${obscured}\n`;
        const merged = mergeIniSections(getRcloneConfigText(), section);
        saveRcloneConfigText(merged);
        return parseIniRemotes(merged);
      }

      if (cmd === "discover_cast_devices") return [];
      if (cmd === "get_cast_status") {
        return {
          connected: false,
          device_name: null,
          device_ip: null,
          player_state: "IDLE",
          current_time: 0,
          duration: 0,
          volume: 1,
          muted: false,
          media_title: null,
        };
      }
      if (cmd === "get_dlna_status") {
        return { running: false, port: 8200, friendly_name: "RcloneFlix", remote: "", path: "" };
      }

      if (cmd === "open_media" || cmd === "open_local_media" || cmd === "arweave_fetch_bytes") {
        throw new Error(`${cmd} is not supported on Android WebView; use browser/HTML5 fallback.`);
      }

      if (cmd === "check_ffmpeg_installed") return false;
      if (cmd === "check_fuse_path") return null;
      if (cmd === "find_downloaded_file") return null;
      if (cmd === "get_alist_status") return { running: false, port: 5244, streamtape_configured: false };
      if (cmd === "get_tailscale_status") return { installed: false, running: false, ip: null, dns_name: null };
      if (cmd === "artwork_cache_stats" || cmd === "vault_photo_cache_stats") return { files: 0, bytes: 0 };

      return null;
    },
  };
}

export {};
