import {
  useAppStore,
  selectTvShows,
  type TvSubscription,
  type MediaItem,
} from "../store/appStore";
import { fetchCanonicalSeriesEpisodes, type CanonicalEpisode } from "./tvMetadata";
import { queryStremioStreams } from "./stremioAddonEngine";
import { searchEasynews, sanitizeEasynewsQuery } from "./easynews";
import { downloadWebStream } from "./streamResolver";
import { dispatchCloudTask } from "./cloudWorkerRouter";
import { useCloudTranscodeStore } from "./kaggleTranscode";
import { persistItems } from "./libraryDb";
import { useToastStore } from "../store/toastStore";

/**
 * Injects Easynews HTTP Basic Auth credentials into a members.easynews.com download URL
 * so curl / ffmpeg / yt-dlp on local or cloud workers can authenticate directly.
 */
export function buildAuthenticatedEasynewsUrl(rawDlUrl: string): string {
  const { easynewsConfig } = useAppStore.getState();
  if (!easynewsConfig?.username || !easynewsConfig?.password) return rawDlUrl;
  try {
    const u = new URL(rawDlUrl);
    u.username = easynewsConfig.username.trim();
    u.password = easynewsConfig.password.trim();
    return u.toString();
  } catch {
    return rawDlUrl;
  }
}

function matchesQualityProfile(
  resolution: string | undefined,
  profile: TvSubscription["qualityProfile"]
): boolean {
  if (profile === "any" || !resolution) return true;
  const r = resolution.toLowerCase();
  if (profile === "4k") return r === "4k" || r === "2160p";
  if (profile === "1080p") return r === "1080p";
  if (profile === "720p") return r === "720p";
  return true;
}

/**
 * Ranks candidates whose names mention a preferred release group first. Non-matching
 * candidates are kept (preference, not a hard filter), in their original order.
 */
function rankByReleaseGroups<T>(
  items: T[],
  getName: (t: T) => string,
  groups?: string[]
): T[] {
  const gs = (groups || []).map((g) => g.trim().toLowerCase()).filter(Boolean);
  if (gs.length === 0) return items;
  const matches = (t: T) => {
    const n = getName(t).toLowerCase();
    return gs.some((g) => n.includes(g)) ? 0 : 1;
  };
  return [...items].sort((a, b) => matches(a) - matches(b));
}

/**
 * Parse a YYYY-MM-DD release date from titles containing YY.MM.DD, YYYY.MM.DD, or YYYY-MM-DD.
 */
function parseDatedSceneRelease(title: string): string | null {
  const m4 = title.match(/\b((?:19|20)\d{2})[.\-_](\d{2})[.\-_](\d{2})\b/);
  if (m4) return `${m4[1]}-${m4[2]}-${m4[3]}`;
  const m2 = title.match(/\b(\d{2})[.\-_](\d{2})[.\-_](\d{2})\b/);
  if (m2) {
    const yy = parseInt(m2[1], 10);
    const mm = parseInt(m2[2], 10);
    const dd = parseInt(m2[3], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
      return `${yyyy}-${m2[2]}-${m2[3]}`;
    }
  }
  return null;
}

async function checkDatedSceneSubscription(
  sub: TvSubscription
): Promise<{ grabbed: string[]; checkedCount: number }> {
  const state = useAppStore.getState();
  const maxBytes = (sub.maxSizeGb || 6) * 1024 * 1024 * 1024;
  const lastDate = sub.lastGrabbedDate || "";
  const queryStr = sanitizeEasynewsQuery(sub.seriesTitle);

  type Candidate = {
    title: string;
    date: string;
    url: string;
    ext: string;
    isLocalOnly: boolean;
  };
  const candidates: Candidate[] = [];

  const wantEasynews =
    (sub.preferredSource === "auto" || sub.preferredSource === "easynews") &&
    Boolean(state.easynewsConfig?.username && state.easynewsConfig?.password);
  const wantInfinidysk =
    sub.preferredSource === "auto" || sub.preferredSource === "infinidysk";

  if (wantEasynews) {
    try {
      const enRes = await searchEasynews(queryStr, "video", "relevance", sub.maxSizeGb || 6);
      for (const r of enRes.results) {
        if (r.sizeBytes > maxBytes) continue;
        if (!matchesQualityProfile(r.resolution, sub.qualityProfile)) continue;
        const d = parseDatedSceneRelease(r.filename);
        if (!d || d <= lastDate) continue;
        if (r.dlUrl) {
          candidates.push({
            title: r.filename,
            date: d,
            url: buildAuthenticatedEasynewsUrl(r.dlUrl),
            ext: r.extension?.replace(/^\./, "") || "mp4",
            isLocalOnly: false,
          });
        }
      }
    } catch (e) {
      console.warn("Easynews dated_scene search failed:", e);
    }
  }

  if (wantInfinidysk && candidates.length === 0) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const nzbResp = await invoke<{
        results: { title: string; size_bytes: number; nzb_url: string }[];
      }>("search_usenet_indexers", {
        query: queryStr,
        omgUser: localStorage.getItem("rcloneflix_omg_user") || undefined,
        omgApiKey: localStorage.getItem("rcloneflix_omg_key") || undefined,
        enableNzbindex: true,
      });
      for (const r of nzbResp?.results || []) {
        if (r.size_bytes && r.size_bytes > maxBytes) continue;
        const d = parseDatedSceneRelease(r.title);
        if (!d || d <= lastDate || !r.nzb_url) continue;
        const cleanSite = sub.seriesTitle.replace(/[\\/:]/g, "-").replace(/\s+/g, " ").trim();
        const playables = await invoke<{ name: string; size: number; virtual_path?: string | null }[]>(
          "parse_nzb_media_files",
          {
            nzbXml: null,
            nzbUrl: r.nzb_url,
            password: null,
            virtualDir: `Adult/${cleanSite}`,
          }
        );
        const best = [...(playables || [])].sort((a, b) => b.size - a.size)[0];
        if (best?.name) {
          const davPath = (best.virtual_path || best.name).split("/").map(encodeURIComponent).join("/");
          candidates.push({
            title: r.title,
            date: d,
            url: `http://127.0.0.1:8553/dav/${davPath}`,
            ext: best.name.split(".").pop()?.toLowerCase() || "mp4",
            isLocalOnly: true,
          });
          break;
        }
      }
    } catch {}
  }

  if (candidates.length === 0) {
    return { grabbed: [], checkedCount: 1 };
  }

  candidates.sort((a, b) => b.date.localeCompare(a.date));
  const pick = candidates[0];
  const targetFolder = sub.destinationRemotePath.replace(/\/+$/, "");
  const cleanTitle = pick.title.replace(/[\\/:*?"<>|]/g, "").trim();
  const effectiveTranscode = sub.transcodeToMp4 && !pick.isLocalOnly;
  const targetFilename = `${cleanTitle}.${effectiveTranscode ? "mp4" : pick.ext}`;

  if (effectiveTranscode) {
    const jobId = `sub-scene-${Date.now()}`;
    const res = await dispatchCloudTask({
      jobType: "video_transcode",
      title: `${sub.seriesTitle} ${pick.date}`,
      payload: {
        job_id: jobId,
        source_input: pick.url,
        dest_remote_folder: targetFolder,
        delete_original: false,
        output_filename: targetFilename,
        crf: 23,
        preset: 6,
        max_height: sub.qualityProfile === "720p" ? 720 : 1080,
        rclone_config_snippet: state.rcloneConfigContent,
      },
    });
    useCloudTranscodeStore.getState().addJob({
      id: res.jobId,
      title: `${sub.seriesTitle} ${pick.date}`,
      kernelSlug: res.kernelSlug || res.jobId,
      kernelUrl: res.url,
      sourceInput: pick.url,
      destRemoteFolder: targetFolder,
      targetFilename,
      targetLibraryId: sub.libraryId,
      targetLibraryType: "adult",
      deleteOriginal: false,
      status: "queued",
      startedAt: Date.now(),
      provider: res.provider,
    });
  } else {
    const dlId = `sub-scene-dl-${Date.now()}`;
    await downloadWebStream({
      download_id: dlId,
      stream_url: pick.url,
      filename: targetFilename,
      remote_upload_path: targetFolder,
      config_path: state.rcloneConfigPath,
    });
  }

  state.upsertTvSubscription({
    ...sub,
    lastGrabbedDate: pick.date,
    lastCheckedAt: Date.now(),
  });
  return { grabbed: [pick.date], checkedCount: 1 };
}

/**
 * Checks a single TV subscription for missing aired episodes and grabs the next missing episode.
 * Processes up to `maxEpisodesPerRun` per invocation to respect worker concurrency limits.
 */
export async function checkSingleTvSubscription(
  sub: TvSubscription,
  maxEpisodesPerRun = 1
): Promise<{ grabbed: string[]; checkedCount: number }> {
  if (sub.subscriptionKind === "dated_scene") {
    return checkDatedSceneSubscription(sub);
  }
  const state = useAppStore.getState();
  const canonical = await fetchCanonicalSeriesEpisodes(sub.seriesTitle, sub.imdbId || sub.seriesId);
  if (!canonical || canonical.episodes.length === 0) {
    return { grabbed: [], checkedCount: 0 };
  }

  // Gather existing local episodes for this show
  const shows = selectTvShows(state.mediaItems);
  const matchedShow = shows.find(
    (s) =>
      s.showId === sub.seriesId ||
      s.showId === canonical.imdbId ||
      s.title.toLowerCase().trim() === sub.seriesTitle.toLowerCase().trim()
  );

  const existingSet = new Set<string>();
  if (matchedShow) {
    for (const season of Object.values(matchedShow.seasons)) {
      for (const ep of season.episodes) {
        existingSet.add(`S${ep.season}E${ep.episode}`);
      }
    }
  }

  // Also avoid re-dispatching episodes already queued in active CloudTranscodeJobs
  const activeTranscodeJobs = Object.values(useCloudTranscodeStore.getState().jobs || {}).filter(
    (j) => j.status === "queued" || j.status === "running"
  );

  const missingAired: CanonicalEpisode[] = canonical.episodes.filter((ep) => {
    if (ep.season <= 0 || !ep.hasAired) return false;
    if (
      Array.isArray(sub.monitoredSeasons) &&
      !sub.monitoredSeasons.includes(ep.season)
    ) {
      return false;
    }
    const code = `S${ep.season}E${ep.episode}`;
    if (existingSet.has(code)) return false;
    const padCode = `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`;
    const alreadyQueued = activeTranscodeJobs.some(
      (j) => j.title.includes(padCode) && j.title.toLowerCase().includes(sub.seriesTitle.toLowerCase())
    );
    return !alreadyQueued;
  });

  const grabbed: string[] = [];
  const maxBytes = (sub.maxSizeGb || 6) * 1024 * 1024 * 1024;

  for (const ep of missingAired.slice(0, maxEpisodesPerRun)) {
    const padS = String(ep.season).padStart(2, "0");
    const padE = String(ep.episode).padStart(2, "0");
    const epTag = `S${padS}E${padE}`;
    const queryStr = sanitizeEasynewsQuery(`${sub.seriesTitle} ${epTag}`);

    let chosenSourceUrl: string | null = null;
    let chosenExt = "mp4";
    // InfiniDysk sources are loopback (127.0.0.1) streams: the LOCAL downloader can read
    // them, but cloud transcode workers cannot — such grabs fall back to direct download.
    let chosenIsLocalOnly = false;

    const tryStremio = async (): Promise<boolean> => {
      if (!(canonical.imdbId || sub.imdbId?.startsWith("tt"))) return false;
      const imdbId = canonical.imdbId || sub.imdbId!;
      const streams = await queryStremioStreams({
        imdbId,
        type: "series",
        season: ep.season,
        episode: ep.episode,
      });
      const valid = rankByReleaseGroups(
        streams.filter(
          (s) =>
            s.isDebridCached &&
            s.streamUrl &&
            (!s.sizeBytes || s.sizeBytes <= maxBytes) &&
            matchesQualityProfile(s.resolution, sub.qualityProfile)
        ),
        (s) => s.cleanFilename || s.title || "",
        sub.preferredReleaseGroups
      );
      if (valid.length > 0) {
        chosenSourceUrl = valid[0].streamUrl!;
        if (valid[0].cleanFilename.toLowerCase().endsWith(".mkv")) chosenExt = "mkv";
        return true;
      }
      return false;
    };

    const tryEasynews = async (): Promise<boolean> => {
      if (!state.easynewsConfig?.username || !state.easynewsConfig?.password) return false;
      try {
        const enRes = await searchEasynews(queryStr, "video", "relevance", sub.maxSizeGb || 6);
        const candidates = rankByReleaseGroups(
          enRes.results.filter(
            (r) =>
              r.sizeBytes <= maxBytes &&
              matchesQualityProfile(r.resolution, sub.qualityProfile) &&
              new RegExp(`S0?${ep.season}E0?${ep.episode}\\b`, "i").test(r.filename)
          ),
          (r) => r.filename,
          sub.preferredReleaseGroups
        );
        const pick = candidates[0];
        if (pick?.dlUrl) {
          chosenSourceUrl = buildAuthenticatedEasynewsUrl(pick.dlUrl);
          chosenExt = pick.extension?.replace(/^\./, "") || "mp4";
          return true;
        }
      } catch (e) {
        console.warn("Easynews subscription search failed:", e);
      }
      return false;
    };

    const tryInfinidysk = async (): Promise<boolean> => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const nzbResp = await invoke<{
          results: { indexer: string; id: string; title: string; size_bytes: number; nzb_url: string }[];
          indexers: unknown[];
        }>("search_usenet_indexers", {
          query: queryStr,
          omgUser: localStorage.getItem("rcloneflix_omg_user") || undefined,
          omgApiKey: localStorage.getItem("rcloneflix_omg_key") || undefined,
          enableNzbindex: true,
        });
        const validNzb = rankByReleaseGroups(
          (nzbResp?.results || []).filter(
            (r) =>
              (!r.size_bytes || r.size_bytes <= maxBytes) &&
              new RegExp(`S0?${ep.season}E0?${ep.episode}\\b`, "i").test(r.title)
          ),
          (r) => r.title,
          sub.preferredReleaseGroups
        )[0];
        // An NZB URL is NOT a media file: ingest it into the local InfiniDysk mount and
        // use the loopback WebDAV URL (the local direct downloader can read it).
        if (validNzb?.nzb_url) {
          try {
            const cleanShow = sub.seriesTitle.replace(/[\\/:]/g, "-").replace(/\s+/g, " ").trim();
            const playables = await invoke<
              { name: string; size: number; kind: string; virtual_path?: string | null }[]
            >("parse_nzb_media_files", {
              nzbXml: null,
              nzbUrl: validNzb.nzb_url,
              password: null,
              virtualDir: `TV Shows/${cleanShow}/Season ${ep.season}`,
            });
            const best = [...(playables || [])].sort((a, b) => b.size - a.size)[0];
            if (best?.name) {
              const davPath = (best.virtual_path || best.name)
                .split("/")
                .map(encodeURIComponent)
                .join("/");
              chosenSourceUrl = `http://127.0.0.1:8553/dav/${davPath}`;
              chosenExt = best.name.split(".").pop()?.toLowerCase() || "mkv";
              chosenIsLocalOnly = true;
              return true;
            }
          } catch {
            // Usenet ingest failed (provider not configured / NZB dead) — skip this source.
          }
        }
      } catch {
        // Lightweight indexer optional fallback
      }
      return false;
    };

    // Build the source attempt order: a specific source means ONLY that source; "auto"
    // means all of them, led by sourcePriority when set.
    type SourceKey = "stremio_debrid" | "easynews" | "infinidysk";
    const runners: Record<SourceKey, () => Promise<boolean>> = {
      stremio_debrid: tryStremio,
      easynews: tryEasynews,
      infinidysk: tryInfinidysk,
    };
    const order: SourceKey[] =
      sub.preferredSource === "auto"
        ? Array.from(
            new Set<SourceKey>([
              sub.sourcePriority || "stremio_debrid",
              "stremio_debrid",
              "easynews",
              "infinidysk",
            ])
          )
        : [sub.preferredSource];

    for (const src of order) {
      if (await runners[src]()) break;
    }

    if (!chosenSourceUrl) continue;

    // Loopback (InfiniDysk) sources cannot be reached by cloud transcode workers:
    // fall back to the local direct download+upload path for those grabs.
    const effectiveTranscode = sub.transcodeToMp4 && !chosenIsLocalOnly;
    if (sub.transcodeToMp4 && chosenIsLocalOnly) {
      useToastStore
        .getState()
        .addToast(
          `${sub.seriesTitle} ${epTag}: InfiniDysk source is local-only — uploading directly without cloud conversion`,
          "info",
          6000
        );
    }

    const cleanSeriesTitle = sub.seriesTitle.replace(/[\\/:*?"<>|]/g, "").trim();
    const targetFolder = `${sub.destinationRemotePath.replace(/\/+$/, "")}/Season ${ep.season}`;
    const targetFilename = `${cleanSeriesTitle} - ${epTag} - ${
      (ep.title || `Episode ${ep.episode}`).replace(/[\\/:*?"<>|]/g, "").trim()
    }.${effectiveTranscode ? "mp4" : chosenExt}`;

    const matchedMeta = {
      title: `${sub.seriesTitle} - ${epTag}`,
      showTitle: sub.seriesTitle,
      season: ep.season,
      episode: ep.episode,
      episodeTitle: ep.title,
      posterUrl: sub.posterUrl || canonical.posterUrl,
      backdropUrl: canonical.backdropUrl,
      overview: ep.overview || canonical.overview,
      year: canonical.year,
      metadataId: canonical.imdbId || sub.seriesId,
      metadataSource: "cinemeta" as const,
    };

    if (effectiveTranscode) {
      // Dispatch to Cloud Worker (Kaggle / GitHub Actions) -> routes output straight to targetFolder
      const jobId = `sub-transcode-${Date.now()}`;
      const res = await dispatchCloudTask({
        jobType: "video_transcode",
        title: `${sub.seriesTitle} ${epTag}`,
        payload: {
          job_id: jobId,
          source_input: chosenSourceUrl,
          dest_remote_folder: targetFolder,
          delete_original: false,
          output_filename: targetFilename,
          crf: 23,
          preset: 6,
          max_height: sub.qualityProfile === "720p" ? 720 : 1080,
          rclone_config_snippet: state.rcloneConfigContent,
        },
      });

      useCloudTranscodeStore.getState().addJob({
        id: res.jobId,
        title: `${sub.seriesTitle} ${epTag}`,
        kernelSlug: res.kernelSlug || res.jobId,
        kernelUrl: res.url,
        sourceInput: chosenSourceUrl,
        destRemoteFolder: targetFolder,
        targetFilename,
        targetLibraryId: sub.libraryId,
        targetLibraryType: "tv",
        matchedMetadata: matchedMeta,
        deleteOriginal: false,
        status: "queued",
        startedAt: Date.now(),
        provider: res.provider,
      });

      grabbed.push(epTag);
    } else {
      // Direct download & upload to existing series remote folder without transcoding
      const dlId = `sub-dl-${Date.now()}`;
      await downloadWebStream({
        download_id: dlId,
        stream_url: chosenSourceUrl,
        filename: targetFilename,
        remote_upload_path: targetFolder,
        config_path: state.rcloneConfigPath,
      });

      const newItem: MediaItem = {
        id: `media-sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        libraryId: sub.libraryId,
        libraryType: "tv",
        remotePath: `${targetFolder}/${targetFilename}`,
        filename: targetFilename,
        title: matchedMeta.title,
        showTitle: sub.seriesTitle,
        showId: sub.seriesId,
        season: ep.season,
        episode: ep.episode,
        episodeTitle: ep.title,
        posterUrl: matchedMeta.posterUrl,
        backdropUrl: matchedMeta.backdropUrl,
        overview: matchedMeta.overview,
        year: matchedMeta.year,
        metadataId: matchedMeta.metadataId,
        metadataSource: "cinemeta",
        addedAt: Date.now(),
        lastScannedAt: Date.now(),
      };

      useAppStore.getState().upsertMediaItem(newItem);
      await persistItems([newItem]);
      grabbed.push(epTag);
    }
  }

  useAppStore.getState().upsertTvSubscription({
    ...sub,
    lastCheckedAt: Date.now(),
    ...(grabbed.length > 0 ? { lastGrabbedEpisode: grabbed[grabbed.length - 1] } : {}),
  });

  if (grabbed.length > 0) {
    useToastStore
      .getState()
      .addToast(
        `🔔 TV Subscription (${sub.seriesTitle}): Dispatched ${grabbed.join(", ")} to ${sub.destinationRemotePath}`,
        "success",
        7000
      );
  }

  return { grabbed, checkedCount: missingAired.length };
}

let subscriptionPoller: any = null;

/**
 * Background subscription poller (checks active TV subscriptions every 4 hours).
 */
export function initTvSubscriptionPoller() {
  if (subscriptionPoller) return;

  const runCheck = async () => {
    const subs = Object.values(useAppStore.getState().tvSubscriptions || {}).filter(
      (s) => s.status === "active"
    );
    for (const sub of subs) {
      const elapsed = Date.now() - (sub.lastCheckedAt || 0);
      if (elapsed >= 4 * 60 * 60 * 1000) {
        try {
          await checkSingleTvSubscription(sub, 1);
        } catch (e) {
          console.warn(`TV Subscription check failed for ${sub.seriesTitle}:`, e);
        }
      }
    }
  };

  // Initial check 45 seconds after app launch, then every 30 minutes
  setTimeout(runCheck, 45000);
  subscriptionPoller = setInterval(runCheck, 30 * 60 * 1000);
}
