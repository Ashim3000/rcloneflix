# Post-Launch Remediation — Drop-In Implementation Plan

**Produced by:** Claude (full line-level verification of `POST_LAUNCH_REMEDIATION_PLAN.md`, 2026-11-16, v1.0.31 tree at `fedf998`)
**Audience:** Implementing AI agent. Every item below was verified against the current source; each has exact file anchors and complete drop-in code.

**Rules for the implementer (from `AGENTS.md` + handoff docs):**
1. Read `KNOWN_BUGS_AND_FIXES.md` for context before starting (items #168 and #174 relate directly to Item 0).
2. After each item: run `npx tsc --noEmit` (frontend) and/or `cargo check` in `src-tauri/` (backend). Both must stay clean.
3. When an item is **implemented and verified**, add/update its entry in `KNOWN_BUGS_AND_FIXES.md`. Never mark RESOLVED from intent — grep for the symbol the fix introduces.
4. Do not bump the version. Do not push secrets (keystore, `key.properties`, tokens — see `AGENTS.md` §1.5). Pushing code to `origin` is allowed only when the user asks.
5. Package with the build scripts, never test raw `cargo build` binaries (devUrl trap, `AGENTS.md` §1.4).
6. Anchors below use the exact current source text. If an anchor does not match, STOP and report — do not improvise.

**Corrections to the original plan (`~/.gemini/.../POST_LAUNCH_REMEDIATION_PLAN.md`), found during verification:**
- **Item 1:** The claim that `stream_ingest.rs` calls `/api/search` is wrong — the Rust side **never searches MovieBite at all**. Desktop search goes through the generic `?s=` fallback in `DirectPlayPage.tsx:237`, and the Rust MovieBite branch ignores the query and silently returns trending. The Android polyfill *does* already call `/api/search`. So the Rust fix must *add* a search path, not just headers.
- **Item 4:** The claim that "only `enterVideoPip` exists" is imprecise — the JS-exposed bridge method is `enterPip(width, height)` (`MainActivity.java:1596`); `enterVideoPip` is an internal Activity method. Either way, `enterPictureInPicture()` does not exist and the call is dead code. The fix removes it rather than renaming it (PiP is wrong for a music mini-player; the compact mode is CSS-only).
- **Item 3:** `find_downloaded_file` does not need the planned new "stat" plumbing through rclone — a tiny `statLocalFile` bridge method is simpler and is included below.
- Everything else in the plan verified as claimed.

---

## Item 0 — Kaggle `out_1.mp4` filename reassertion (ALREADY APPLIED — verify only)

Already committed as `fedf998` (KNOWN_BUGS #174). **Do not reapply.** Verify both sites look like this:

`src-tauri/src/commands/kaggle.rs` (rclone upload branch, ~line 832):

```python
        # moveto, not move: local staging name is out_{{idx}}.mp4, so the final
        # filename must be reasserted by targeting the full destination path
        upload_res = subprocess.run([
            "rclone", "moveto", local_temp_output, target_remote_file,
            "-P", "--retries", "5", "--low-level-retries", "10", "--timeout", "120s"
        ])
```

`.github/workflows/cloud_worker.yml` (~line 684):

```python
                      # moveto, not move: local staging name is out_{idx}.mp4, so the
                      # final filename must be reasserted via the full destination path
                      subprocess.run(["rclone", "moveto", local_out, dest_target, "-v"], check=True)
```

Note: GHA runners have no filename length/character limits that we've hit, so the `out_{idx}` staging there is belt-and-suspenders only; with `moveto` it is harmless. The Kaggle side MUST keep staging (Kaggle rejects some special-char filenames in `/kaggle/working` output). The yml must also be pushed to the live worker repo (`akatwhitty/cloudtest`) by the user before GHA jobs pick it up — not your job.

---

## Item 1 — MovieBite discovery: 403s swallowed, desktop search missing

### 1a. `src-tauri/src/commands/stream_ingest.rs` — replace the trending block

**Anchor:** inside the `if host.contains("moviebite")` branch (~line 3723), replace this exact text:

```rust
        let trending_url = "https://moviebite.org/api/trending";
        let resp = client
            .get(trending_url)
            .header("Referer", "https://moviebite.org/")
            .send()
            .await
            .map_err(|e| format!("Failed to contact MovieBite: {}", e))?;

        let text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read MovieBite response: {}", e))?;
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid MovieBite JSON: {}", e))?;
```

with:

```rust
        // Desktop search lands here as moviebite.org/?s=<query> (DirectPlayPage generic
        // fallback). MovieBite requires X-MovieBite-Client on /api/* or it returns
        // 403 {"success":false,"error":"Forbidden"} — which previously parsed into an
        // empty feed with no error surfaced.
        let mb_query: Option<String> = parsed_url
            .query_pairs()
            .find(|(k, _)| k == "s" || k == "q" || k == "query")
            .map(|(_, v)| v.trim().to_string())
            .filter(|s| !s.is_empty());

        let api_url = match &mb_query {
            Some(q) => format!(
                "https://moviebite.org/api/search?q={}",
                percent_encoding::utf8_percent_encode(q, percent_encoding::NON_ALPHANUMERIC)
            ),
            None => "https://moviebite.org/api/trending".to_string(),
        };

        let resp = client
            .get(&api_url)
            .header("Accept", "application/json")
            .header("X-MovieBite-Client", "1")
            .header("Origin", "https://moviebite.org")
            .header("Referer", "https://moviebite.org/")
            .send()
            .await
            .map_err(|e| format!("Failed to contact MovieBite: {}", e))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read MovieBite response: {}", e))?;
        if !status.is_success() {
            return Err(format!(
                "MovieBite API returned HTTP {}: {}",
                status,
                text.chars().take(200).collect::<String>()
            ));
        }
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid MovieBite JSON: {}", e))?;
        if json["success"].as_bool() == Some(false) || json["error"].is_string() {
            return Err(format!(
                "MovieBite API error: {}",
                json["error"].as_str().unwrap_or("unknown upstream error")
            ));
        }
```

Then, two small edits to the code that follows (same branch):

1. The parse loop `if let Some(results) = json["results"].as_array()` stays as-is, but add an error for a missing array. Replace:

```rust
        return Ok(SiteDiscoveryFeed {
            site_url: trimmed,
            site_title: "MovieBite Trending Releases".to_string(),
            releases,
        });
```

with:

```rust
        if releases.is_empty() && !json["results"].is_array() {
            return Err("MovieBite returned no results array (API may have changed)".to_string());
        }
        return Ok(SiteDiscoveryFeed {
            site_url: trimmed,
            site_title: match &mb_query {
                Some(q) => format!("MovieBite: \"{}\"", q),
                None => "MovieBite Trending Releases".to_string(),
            },
            releases,
        });
```

`percent_encoding` is already a dependency (used by `search_comics_portal` in this same file). `cargo check` must pass.

### 1b. `src/lib/androidPolyfill.ts` — add headers + surface errors

**Anchor:** in the `crawl_website_releases` handler, `// 1. MovieBite` branch (~line 3228). Replace this exact text:

```ts
          const resp = await polyfillFetchText(apiUrl, {
            Referer: "https://moviebite.org/",
            Accept: "application/json",
          });
          const releases: any[] = [];
          if (resp.ok && resp.body) {
            try {
              const json = JSON.parse(resp.body);
              const results: any[] = json?.results || json?.data || [];
```

with:

```ts
          const resp = await polyfillFetchText(apiUrl, {
            Referer: "https://moviebite.org/",
            Accept: "application/json",
            Origin: "https://moviebite.org",
            "X-MovieBite-Client": "1",
          });
          if (!resp.ok) {
            throw new Error(
              `MovieBite API returned HTTP ${resp.status || 0}${resp.body ? `: ${resp.body.slice(0, 200)}` : ""}`
            );
          }
          const releases: any[] = [];
          if (resp.body) {
            try {
              const json = JSON.parse(resp.body);
              if (json?.success === false || typeof json?.error === "string") {
                throw new Error(`MovieBite API error: ${json?.error || "unknown upstream error"}`);
              }
              const results: any[] = json?.results || json?.data || [];
```

**Important:** the existing `} catch {}` that closes this `try` swallows the thrown API error. Change that closing (the `} catch {}` directly before the `return {` with `site_title: searchQuery ? ...MovieBite...`) to:

```ts
            } catch (e) {
              if (e instanceof Error && e.message.startsWith("MovieBite")) throw e;
              // non-MovieBite parse noise: fall through with whatever parsed
            }
```

Smoke: MovieBite bookmark on desktop shows trending; searching shows search results (not trending); with network blocked you get a visible error, not an empty grid.

---

## Item 2 — Comics portal on Android (`search_comics_portal`, drill-down, issue pages)

All three capabilities exist only in Rust (`stream_ingest.rs:4448`, `:4303`, `:4622`). The polyfill falls through to `return null;`, so Android comics are dead. Port them using `polyfillFetchText` (native `httpFetch` under the hood).

### 2a. Shared portal search helper

**Anchor:** `src/lib/androidPolyfill.ts`, immediately after the `polyfillFetchText` function (ends ~line 400). Insert:

```ts
/** Android port of Rust search_comics_portal (stream_ingest.rs:4448):
 *  ReadComicsOnline autocomplete + Archive.org CBZ + MangaDex API. */
async function searchComicsPortalAndroid(query: string): Promise<any> {
  const cleanQ = query.trim();
  const releases: any[] = [];

  // 1. ReadComicsOnline JSON autocomplete search
  if (cleanQ) {
    const rcoResp = await polyfillFetchText(
      `https://readcomicsonline.ru/search?query=${encodeURIComponent(cleanQ)}`,
      { "X-Requested-With": "XMLHttpRequest", Referer: "https://readcomicsonline.ru/" }
    );
    if (rcoResp.ok && rcoResp.body) {
      try {
        const json = JSON.parse(rcoResp.body);
        for (const item of json?.suggestions || []) {
          const title = String(item?.value || "").trim();
          const slug = String(item?.data || "").trim();
          if (title && slug) {
            releases.push({
              title,
              post_url: `https://readcomicsonline.ru/comic/${slug}`,
              thumbnail: `https://readcomicsonline.ru/uploads/manga/${slug}/cover/cover_250x350.jpg`,
              date: null,
              site_domain: "readcomicsonline.ru",
              media_type: "comic_series",
              season: null,
              episode: null,
            });
          }
        }
      } catch {}
    }
  }

  // 2. Internet Archive direct CBZ comics
  const iaTerm = cleanQ
    ? `title:(${cleanQ}) AND mediatype:texts AND (format:"Comic Book ZIP" OR subject:comics)`
    : `subject:(comics OR "comic book" OR marvel OR dc) AND format:(Comic Book ZIP)`;
  const iaSort = cleanQ ? "downloads+desc" : "publicdate+desc";
  const iaResp = await polyfillFetchText(
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(iaTerm)}&fl[]=identifier,title,year&sort[]=${iaSort}&rows=24&output=json`
  );
  if (iaResp.ok && iaResp.body) {
    try {
      const json = JSON.parse(iaResp.body);
      for (const doc of json?.response?.docs || []) {
        const id = String(doc?.identifier || "");
        if (!id) continue;
        const title = Array.isArray(doc?.title) ? String(doc.title[0] ?? id) : String(doc?.title ?? id);
        releases.push({
          title,
          post_url: `https://archive.org/details/${id}`,
          thumbnail: `https://archive.org/services/img/${id}`,
          date: doc?.year != null ? String(doc.year) : null,
          site_domain: "archive.org",
          media_type: "comic_series",
          season: null,
          episode: null,
        });
      }
    } catch {}
  }

  // 3. MangaDex Public API
  const mdUrl = cleanQ
    ? `https://api.mangadex.org/manga?title=${encodeURIComponent(cleanQ)}&limit=20&includes[]=cover_art&order[relevance]=desc`
    : "https://api.mangadex.org/manga?limit=20&includes[]=cover_art&order[latestUploadedChapter]=desc&contentRating[]=safe&contentRating[]=suggestive";
  const mdResp = await polyfillFetchText(mdUrl, { "User-Agent": "RcloneFlix/1.0" });
  if (mdResp.ok && mdResp.body) {
    try {
      const json = JSON.parse(mdResp.body);
      for (const item of json?.data || []) {
        const id = String(item?.id || "");
        if (!id) continue;
        const titleObj = item?.attributes?.title || {};
        const title = String(titleObj.en || Object.values(titleObj)[0] || "Untitled Comic");
        const coverRel = (item?.relationships || []).find((r: any) => r?.type === "cover_art");
        const coverFile = coverRel?.attributes?.fileName;
        releases.push({
          title,
          post_url: `https://mangadex.org/title/${id}`,
          thumbnail: coverFile ? `https://uploads.mangadex.org/covers/${id}/${coverFile}.256.jpg` : null,
          date: item?.attributes?.year != null ? String(item.attributes.year) : null,
          site_domain: "mangadex.org",
          media_type: "comic_series",
          season: null,
          episode: null,
        });
      }
    } catch {}
  }

  return {
    site_url: "https://readcomicsonline.ru",
    site_title: cleanQ
      ? `Comics Portal — Results for "${cleanQ}"`
      : "Comics Portal — Popular Series & Issues",
    releases,
  };
}
```

### 2b. `search_comics_portal` command handler

**Anchor:** insert directly before the line `if (cmd === "check_ffmpeg_installed") return false;` (~line 4225):

```ts
      if (cmd === "search_comics_portal") {
        return await searchComicsPortalAndroid(String(args.query || ""));
      }

      if (cmd === "extract_comic_issue_pages") {
        const url = String(args.url || "").trim();

        // 1. MangaDex chapter: mangadex.org/chapter/{id} or mangadex://chapter/{id}
        const mdCh = url.match(/mangadex(?:\.org\/chapter\/|:\/\/chapter\/)([0-9a-f-]+)/i);
        if (mdCh) {
          const resp = await polyfillFetchText(
            `https://api.mangadex.org/at-home/server/${mdCh[1]}`,
            { "User-Agent": "RcloneFlix/1.0" }
          );
          if (!resp.ok) throw new Error(`Failed contacting MangaDex server (HTTP ${resp.status || 0})`);
          const json = JSON.parse(resp.body || "{}");
          const baseUrl = String(json?.baseUrl || "https://uploads.mangadex.org");
          const hash = String(json?.chapter?.hash || "");
          const pages = (json?.chapter?.data || []).map((f: string) => `${baseUrl}/data/${hash}/${f}`);
          if (!pages.length) throw new Error("No pages returned for MangaDex chapter");
          return { title: "Comic Issue", series_title: null, issue_number: null, pages, next_issue_url: null, prev_issue_url: null };
        }

        // 2. ReadComicsOnline issue page: readcomicsonline.ru/comic/{slug}/{issue}
        const resp = await polyfillFetchText(url, { Referer: "https://readcomicsonline.ru/" });
        if (!resp.ok) throw new Error(`Failed to fetch comic issue page (HTTP ${resp.status || 0})`);
        const body = resp.body || "";
        if (body.includes("Just a moment...") || body.includes("cf_chl_opt")) {
          throw new Error(
            "ReadComicsOnline is currently behind a Cloudflare challenge on this connection. Try selecting an Archive.org or MangaDex stream in the Comics Portal."
          );
        }
        const imgRe = /<img[^>]+class=["'][^"']*img-responsive[^"']*["'][^>]+(?:data-src|src)=["']\s*([^"'\s]+)\s*["']/gi;
        const pages: string[] = [];
        let im: RegExpExecArray | null;
        while ((im = imgRe.exec(body)) !== null) {
          let imgUrl = im[1].trim();
          if (imgUrl.startsWith("//")) imgUrl = `https:${imgUrl}`;
          else if (imgUrl.startsWith("/")) imgUrl = `https://readcomicsonline.ru${imgUrl}`;
          if (imgUrl.startsWith("http") && !pages.includes(imgUrl)) pages.push(imgUrl);
        }
        if (!pages.length) throw new Error("No comic page images found on page");
        const t = body.match(/<title[^>]*>([^<]+)<\/title>/i);
        return {
          title: (t?.[1] || "Comic Issue").trim(),
          series_title: null,
          issue_number: null,
          pages,
          next_issue_url: null,
          prev_issue_url: null,
        };
      }
```

### 2c. Series drill-down in `crawl_website_releases`

**Anchor:** inside the `crawl_website_releases` handler, insert directly before the line `// 1. MovieBite (\`moviebite.org\`)` (~line 3228):

```ts
        // 0-comics. ReadComicsOnline / MangaDex discovery & series drill-down
        // (Android port of Rust crawl_comics_portal, stream_ingest.rs:4303)
        if (host.includes("readcomicsonline") || host.includes("mangadex.org") || lowerSite.includes("mangadex://")) {
          // a) ReadComicsOnline series page → list issues
          if (host.includes("readcomicsonline") && (lowerSite.includes("/comic/") || lowerSite.includes("/manga/"))) {
            const resp = await polyfillFetchText(siteUrl, { Referer: "https://readcomicsonline.ru/" });
            if (resp.ok && resp.body && !resp.body.includes("Just a moment...") && !resp.body.includes("cf_chl_opt")) {
              const body = resp.body;
              const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
              const seriesTitle = (titleMatch?.[1] || "Comic Series").replace("Read ", "").replace(" Online", "").trim();
              const coverMatch = body.match(/<img[^>]+src=["']([^"']+\/uploads\/manga\/[^"']+\/cover\/[^"']+)["']/i);
              let thumb: string | null = coverMatch ? coverMatch[1] : null;
              if (thumb && thumb.startsWith("//")) thumb = `https:${thumb}`;
              else if (thumb && thumb.startsWith("/")) thumb = `https://readcomicsonline.ru${thumb}`;
              const releases: any[] = [];
              const chRe = /<h5[^>]*class=["'][^"']*chapter-title-rtl[^"']*["'][^>]*>\s*<a[^>]+href=["'](https?:\/\/[^"']+\/comic\/[^"']+\/(\d+(?:\.\d+)?))["'][^>]*>([^<]+)<\/a>/gi;
              let m: RegExpExecArray | null;
              while ((m = chRe.exec(body)) !== null) {
                const epNum = parseInt(m[2].split(".")[0], 10);
                releases.push({
                  title: (m[3] || seriesTitle).trim(),
                  post_url: m[1],
                  thumbnail: thumb,
                  date: null,
                  site_domain: "readcomicsonline.ru",
                  media_type: "comics",
                  season: 1,
                  episode: Number.isFinite(epNum) ? epNum : null,
                });
              }
              if (releases.length) {
                releases.reverse(); // Issue #1 first
                return { site_url: siteUrl, site_title: seriesTitle, releases };
              }
            }
          }
          // b) MangaDex series → chapter feed
          const mdMatch = siteUrl.match(/mangadex(?:\.org\/title\/|:\/\/manga\/)([0-9a-f-]+)/i);
          if (mdMatch) {
            const resp = await polyfillFetchText(
              `https://api.mangadex.org/manga/${mdMatch[1]}/feed?translatedLanguage[]=en&order[chapter]=asc&limit=100`,
              { "User-Agent": "RcloneFlix/1.0" }
            );
            if (!resp.ok) throw new Error(`MangaDex feed error (HTTP ${resp.status || 0})`);
            const json = JSON.parse(resp.body || "{}");
            const releases: any[] = [];
            for (const ch of json?.data || []) {
              const attrs = ch?.attributes || {};
              if (!Number(attrs.pages)) continue; // skip external-only chapters with 0 hosted pages
              const chNumStr = String(attrs.chapter ?? "1");
              const chNum = parseInt(chNumStr.split(".")[0], 10);
              const chTitle = String(attrs.title || "").trim();
              releases.push({
                title: chTitle ? `Issue #${chNumStr} - ${chTitle}` : `Issue #${chNumStr}`,
                post_url: `https://mangadex.org/chapter/${ch.id}`,
                thumbnail: null,
                date: attrs.publishAt ? String(attrs.publishAt).slice(0, 10) : null,
                site_domain: "mangadex.org",
                media_type: "comics",
                season: 1,
                episode: Number.isFinite(chNum) ? chNum : null,
              });
            }
            return { site_url: siteUrl, site_title: "Comic Issues & Chapters", releases };
          }
          // c) Bare domain / search URL → portal search
          return await searchComicsPortalAndroid(searchQuery || "");
        }
```

Smoke (Android APK, debug build OK for this): ReadComicsOnline bookmark lists popular series; tapping a series lists issues oldest-first; opening an issue renders pages in ComicReaderPage; MangaDex search → series → chapter works end-to-end.

---

## Item 3 — Android downloads: subfolders, failure detection, progress, offline lookup

### 3a. `MainActivity.java` — two new bridge methods + one async task type

**Anchor 1:** inside the `@JavascriptInterface`-annotated bridge class, directly after the closing brace of `public boolean openInExternalPlayer(String url, String title)` (~line 2011 block), add:

```java
        @JavascriptInterface
        public String statLocalFile(String path) {
            JSONObject r = new JSONObject();
            try {
                File f = new File(path);
                r.put("exists", f.isFile());
                r.put("size", f.isFile() ? f.length() : 0);
                r.put("path", f.getAbsolutePath());
            } catch (Exception e) {
                try { r.put("exists", false); r.put("error", String.valueOf(e)); } catch (Exception ignored) {}
            }
            return r.toString();
        }

        @JavascriptInterface
        public boolean openDownloadsFolder() {
            try {
                Intent intent = new Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(intent);
                return true;
            } catch (Exception e) {
                Log.w(TAG, "openDownloadsFolder failed", e);
                return false;
            }
        }

        private String httpDownloadToFile(String urlStr, String headersJson, String targetPath) {
            JSONObject r = new JSONObject();
            try {
                File target = new File(targetPath);
                File parent = target.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                java.net.HttpURLConnection conn =
                        (java.net.HttpURLConnection) new java.net.URL(urlStr).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);
                JSONObject headers = (headersJson != null && !headersJson.isEmpty())
                        ? new JSONObject(headersJson) : new JSONObject();
                java.util.Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    conn.setRequestProperty(k, headers.optString(k, ""));
                }
                if (headers.optString("User-Agent", "").isEmpty()) {
                    conn.setRequestProperty("User-Agent",
                            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36");
                }
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    r.put("ok", false);
                    r.put("status", code);
                    r.put("error", "HTTP " + code);
                    conn.disconnect();
                    return r.toString();
                }
                long written = 0;
                java.io.InputStream in = conn.getInputStream();
                java.io.FileOutputStream out = new java.io.FileOutputStream(target);
                try {
                    byte[] buf = new byte[262144];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        written += n;
                    }
                } finally {
                    try { out.close(); } catch (Exception ignored) {}
                    try { in.close(); } catch (Exception ignored) {}
                }
                conn.disconnect();
                r.put("ok", true);
                r.put("status", code);
                r.put("bytes", written);
                r.put("path", target.getAbsolutePath());
            } catch (Exception e) {
                try { r.put("ok", false); r.put("error", String.valueOf(e)); } catch (Exception ignored) {}
            }
            return r.toString();
        }
```

**Anchor 2:** in `runAsyncTask` (~line 1664), after the `if ("httpFetch".equals(taskType)) { ... }` block, add a sibling case:

```java
                    } else if ("httpDownload".equals(taskType)) {
                        resultJson = httpDownloadToFile(
                                req.optString("url", ""),
                                req.optString("headersJson", "{}"),
                                req.optString("targetPath", "")
                        );
```

(`Intent` is already imported; `File`, `JSONObject` already in use in this class.)

### 3b. `src/lib/androidPolyfill.ts` — rewrite the four download handlers

**Anchor:** replace the entire existing `start_download`, `start_folder_download`, and `open_download_folder` handlers (~lines 2765–2797, the block quoted below must match before deletion):

```ts
      if (cmd === "start_download") {
        const items = (args.items || []) as Array<{ remote_path: string; filename: string }>;
        ...
      if (cmd === "open_download_folder") {
        return null;
      }
```

with:

```ts
      if (cmd === "start_download") {
        const items = (args.items || []) as Array<{
          remote_path: string;
          filename: string;
          subfolder?: string;
          headers?: Record<string, string>;
        }>;
        const downloadId = String(args.downloadId || args.download_id || `dl-${Date.now()}`);
        const bridge = getBridge();
        if (typeof bridge?.hasStoragePermission === "function" && !bridge.hasStoragePermission()) {
          if (typeof bridge?.requestStoragePermission === "function") bridge.requestStoragePermission();
          throw new Error("Storage permission required — grant RcloneFlix storage access, then retry the download.");
        }
        const baseDir = "/sdcard/Download/RcloneFlix";
        let completed = 0;
        let destDir = baseDir;
        const emitProgress = (status: string, currentFile: string, error?: string) => {
          emitTauriEvent("download-progress", {
            download_id: downloadId,
            total_files: items.length,
            completed_files: completed,
            current_file: currentFile,
            destination_path: destDir,
            status,
            ...(error ? { error } : {}),
          });
        };
        for (const item of items) {
          const sub = String(item.subfolder || "").replace(/^\/+|\/+$/g, "");
          destDir = sub ? `${baseDir}/${sub}` : baseDir;
          const target = `${destDir}/${item.filename}`;
          emitProgress("downloading", item.filename);
          const src = String(item.remote_path || "");
          let parsed: any;
          if (src.startsWith("http://") || src.startsWith("https://")) {
            // DirectPlay web URLs need Referer/UA-aware native download, not rclone
            parsed = await runBridgeTaskAsync("httpDownload", {
              url: src,
              headersJson: JSON.stringify(item.headers || {}),
              targetPath: target,
            });
          } else {
            parsed = await runBridgeTaskAsync("runRcloneCommand", {
              argsJson: JSON.stringify(["copyto", src, target]),
            });
          }
          if (!parsed || parsed.ok === false) {
            const msg = String(parsed?.error || parsed?.stderr || `Download failed for ${item.filename}`);
            emitProgress("error", item.filename, msg);
            throw new Error(msg);
          }
          completed += 1;
        }
        emitProgress("completed", items.length ? items[items.length - 1].filename : "");
        return destDir;
      }

      if (cmd === "start_folder_download") {
        const folderPath = String(args.remote_folder_path || args.remoteFolderPath || "");
        const folderName = String(args.folder_name || args.folderName || "Folder");
        const downloadId = String(args.downloadId || args.download_id || `dl-${Date.now()}`);
        const target = `/sdcard/Download/RcloneFlix/${folderName}`;
        const emitFolderProgress = (status: string, error?: string) => {
          emitTauriEvent("download-progress", {
            download_id: downloadId,
            total_files: 1,
            completed_files: status === "completed" ? 1 : 0,
            current_file: folderName,
            destination_path: target,
            status,
            ...(error ? { error } : {}),
          });
        };
        emitFolderProgress("downloading");
        const parsed = await runBridgeTaskAsync("runRcloneCommand", {
          argsJson: JSON.stringify(["copy", folderPath, target]),
        });
        if (!parsed || parsed.ok === false) {
          const msg = String(parsed?.error || parsed?.stderr || `Folder download failed for ${folderName}`);
          emitFolderProgress("error", msg);
          throw new Error(msg);
        }
        emitFolderProgress("completed");
        return target;
      }

      if (cmd === "open_download_folder") {
        const bridge = getBridge();
        if (typeof bridge?.openDownloadsFolder === "function") bridge.openDownloadsFolder();
        return null;
      }
```

Then **delete** the stub line `if (cmd === "find_downloaded_file") return null;` (~line 4226) and add, in the same misc cluster where it was:

```ts
      if (cmd === "find_downloaded_file") {
        const bridge = getBridge();
        const filename = String(args.filename || "");
        if (!filename || typeof bridge?.statLocalFile !== "function") return null;
        const sub = String(args.subfolder || "").replace(/^\/+|\/+$/g, "");
        const base = "/sdcard/Download/RcloneFlix";
        const candidates = [
          sub ? `${base}/${sub}/${filename}` : `${base}/${filename}`,
          `${base}/${filename}`,
          `/sdcard/Download/${filename}`, // legacy flat location from pre-fix builds
        ];
        for (const p of candidates) {
          try {
            const st = JSON.parse(bridge.statLocalFile(p) || "{}");
            if (st?.exists && Number(st?.size) > 0) return String(st.path || p);
          } catch {}
        }
        return null;
      }
```

Notes for the implementer:
- `emitTauriEvent`, `runBridgeTaskAsync`, `getBridge`, and `polyfillFetchText` are all in scope inside the polyfill factory — do not re-declare or import anything.
- `runBridgeTaskAsync` never rejects; it resolves parsed JSON. Failure is `parsed.ok === false` (or null when no bridge).
- The frontend contract is `downloadManager.ts` (`DownloadProgressEvent`, snake_case fields, statuses `downloading | completed | error`) — do not invent new field names.

Smoke: download an episode on Android → lands in `/sdcard/Download/RcloneFlix/TV/<Show>/Season N/`, progress toast updates, completed toast's "Open Folder" opens the Downloads UI, and re-opening the item plays the local copy (offline detection via `find_downloaded_file`).

---

## Item 4 — Music Player Mode window resize (.deb maximized + Android)

### 4a. `src-tauri/capabilities/default.json` — missing window ACL permissions

In the `permissions` array, directly after `"core:window:allow-set-fullscreen"`, add:

```json
    "core:window:allow-is-maximized",
    "core:window:allow-unmaximize",
    "core:window:allow-maximize",
```

(Root cause: `win.isMaximized()` is ACL-rejected today, the `.catch(() => false)` masks it, `unmaximize()` never runs, and GTK/Wayland ignores `setSize` on a maximized window.)

### 4b. `src/lib/useMusicSkinWindow.ts` — settle delay + restore maximize

1. Next to the existing `const wasInSkinModeRef = useRef(false);` add:

```ts
  const wasMaximizedRef = useRef(false);
```

2. Replace:

```ts
          const isMax = await win.isMaximized().catch(() => false);
          if (isMax) {
            await win.unmaximize().catch(() => {});
          }
```

with:

```ts
          const isMax = await win.isMaximized().catch(() => false);
          wasMaximizedRef.current = isMax;
          if (isMax) {
            await win.unmaximize().catch(() => {});
            // GTK/Wayland/Sommelier completes unmaximize asynchronously in the
            // compositor; without a settle delay the setSize below is overridden.
            await new Promise((r) => setTimeout(r, 120));
          }
```

3. In the restore branch, replace:

```ts
          if (prevWindowBounds) {
```

with:

```ts
          if (wasMaximizedRef.current) {
            wasMaximizedRef.current = false;
            await win.maximize().catch(() => {});
            setPrevWindowBounds(null);
          } else if (prevWindowBounds) {
```

4. Android: replace the dead PiP call. Replace:

```ts
        const bridge = (window as any).AndroidBridge;
        if (bridge && typeof bridge.enterPictureInPicture === "function") {
          try {
            bridge.enterPictureInPicture();
          } catch (e) {
            console.warn("Could not trigger Android PiP for music skin:", e);
          }
        }
```

with:

```ts
        // Android windows cannot be resized; compact mode is CSS-only via the
        // classes above. (bridge.enterPictureInPicture never existed — the real
        // bridge method is enterPip(w, h), and PiP is wrong for a music skin.)
```

### 4c. `src/index.css` — define the compact-mode classes (currently referenced but unstyled)

Append at the end of the file:

```css
/* ── Android Music Skin compact mode ─────────────────────────────────────────
   The window itself cannot resize on Android; these classes (toggled by
   useMusicSkinWindow) keep the skin flush to the viewport and stop background
   scroll-through while it is active. */
html.android-music-skin-compact,
html.android-music-skin-compact body {
  overflow: hidden;
  overscroll-behavior: none;
}
body.music-skin-mode-active {
  touch-action: manipulation;
}
```

Smoke: on the `.deb`, maximize the window → enter Music Player Mode → window shrinks to 380×640 compact player; exit → window re-maximizes. On Android, entering Music Player Mode shows the skin with no background scroll bleed; no console warning about `enterPictureInPicture`.

---

## After all items

1. `npx tsc --noEmit` and `cargo check` both clean.
2. Add KNOWN_BUGS entries (#175+) for each implemented item, with real symbol names.
3. Report per-item status honestly — anything skipped or failed gets listed as such, never as done.
4. Do NOT build packages or push unless the user asks; the pending app rebuild will pick these up together with the already-committed Item 0.
