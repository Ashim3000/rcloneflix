import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useAppStore, type MediaItem } from "../store/appStore";
import { useToastStore } from "../store/toastStore";
import { persistItems } from "./libraryDb";
import { createVersionFromItem, type MediaSourceVersion } from "./multiVersion";
import {
  dispatchCloudTask,
  type CloudWorkerProvider,
  type ProviderSelection,
} from "./cloudWorkerRouter";
import { getKaggleTranscodeStatus, getKaggleTranscodeOutput } from "./kaggleTranscode";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export type KaggleRdSeedRequest = {
  job_id: string;
  source_input: string;
  rd_api_key: string;
  title: string;
  filename: string;
  rclone_config_snippet?: string;
};

export type RdSeedJob = {
  id: string;
  mediaItemId: string;
  title: string;
  filename: string;
  sourceInput: string;
  status: "queued" | "running" | "complete" | "error";
  provider: CloudWorkerProvider;
  kernelSlug?: string;
  kernelUrl?: string;
  streamUrl?: string;
  failureMessage?: string;
  startedAt: number;
  completedAt?: number;
};

interface RdSeedStore {
  jobs: Record<string, RdSeedJob>;
  addJob: (job: RdSeedJob) => void;
  updateJob: (id: string, updates: Partial<RdSeedJob>) => void;
  removeJob: (id: string) => void;
  clearCompletedJobs: () => void;
}

export const useRdSeedStore = create<RdSeedStore>()(
  persist(
    (set) => ({
      jobs: {},
      addJob: (job) =>
        set((s) => ({
          jobs: { ...s.jobs, [job.id]: job },
        })),
      updateJob: (id, updates) =>
        set((s) => {
          const existing = s.jobs[id];
          if (!existing) return s;
          return {
            jobs: {
              ...s.jobs,
              [id]: { ...existing, ...updates },
            },
          };
        }),
      removeJob: (id) =>
        set((s) => {
          const next = { ...s.jobs };
          delete next[id];
          return { jobs: next };
        }),
      clearCompletedJobs: () =>
        set((s) => {
          const next: Record<string, RdSeedJob> = {};
          Object.entries(s.jobs).forEach(([k, v]) => {
            if (v.status !== "complete" && v.status !== "error") {
              next[k] = v;
            }
          });
          return { jobs: next };
        }),
    }),
    {
      name: "rcloneflix-rd-seed-jobs",
    }
  )
);

export async function dispatchKaggleRdSeed(req: KaggleRdSeedRequest): Promise<{
  job_id: string;
  kernel_slug: string;
  kernel_ref: string;
  url: string;
  status: string;
}> {
  return invoke("dispatch_kaggle_rd_seed", { req });
}

async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url as any, init as any);
      return res as unknown as Response;
    } catch {
      // Fallback
    }
  }
  return await window.fetch(url, init);
}

/**
 * Attaches a completed Real-Debrid streaming link to a MediaItem as a Priority 2 CDN version.
 */
export async function attachRealDebridStreamToItem(
  mediaItemId: string,
  streamUrl: string,
  filename?: string
) {
  const store = useAppStore.getState();
  const item = store.mediaItems[mediaItemId];
  if (!item) return;

  const rdVersion: MediaSourceVersion = {
    id: `${item.id}-real-debrid`,
    remoteName: "real-debrid",
    remotePath: streamUrl,
    libraryId: item.libraryId,
    resolution: item.resolution || "4K / Original",
    videoCodec: item.videoCodec,
    audioCodec: item.audioCodec,
    sizeBytes: item.sizeBytes,
    container: (filename || item.filename || "video.mkv").split(".").pop()?.toLowerCase(),
    isLocal: false,
    priority: 2,
    sourceType: "real-debrid",
    shareUrl: streamUrl,
    addedAt: Date.now(),
  };

  const existingVersions = (item.versions && item.versions.length > 0
    ? item.versions.filter((v: MediaSourceVersion) => v.sourceType !== "real-debrid")
    : [createVersionFromItem(item)]
  );

  const updatedItem: MediaItem = {
    ...item,
    streamUrl: streamUrl,
    versions: [...existingVersions, rdVersion].sort((a, b) => a.priority - b.priority),
  };

  store.upsertMediaItem(updatedItem);
  await persistItems([updatedItem]);
  useToastStore.getState().addToast(`🎉 Real-Debrid 4K Untouched Stream Ready: "${item.title}"!`, "success", 8000);
}

/**
 * Background poller checking Real-Debrid seeding jobs across Kaggle and GHA.
 */
let rdPollerInterval: any = null;

export function initRdSeedPoller() {
  if (rdPollerInterval) return;

  rdPollerInterval = setInterval(async () => {
    const store = useRdSeedStore.getState();
    const activeJobs = Object.values(store.jobs).filter(
      (j) => j.status === "queued" || j.status === "running"
    );

    if (activeJobs.length === 0) return;

    for (const job of activeJobs) {
      try {
        if (job.provider === "kaggle" && job.kernelSlug) {
          const res = await getKaggleTranscodeStatus(job.kernelSlug);
          const newStatus = res.status.toLowerCase();

          if (newStatus !== job.status) {
            store.updateJob(job.id, {
              status: newStatus as any,
              failureMessage: res.failure_message || undefined,
            });

            if (newStatus === "complete") {
              const output = await getKaggleTranscodeOutput(job.kernelSlug).catch(() => "");
              let parsedUrl: string | undefined;

              const match = output.match(/=== REAL_DEBRID_STREAM_URL_START ===\s*([\s\S]*?)\s*=== REAL_DEBRID_STREAM_URL_END ===/);
              if (match && match[1]) {
                try {
                  const data = JSON.parse(match[1]);
                  parsedUrl = data.stream_url;
                } catch {
                  // Fallback string extraction
                }
              }

              if (!parsedUrl) {
                const urlMatch = output.match(/https?:\/\/[^\s"']+\.real-debrid\.com\/d\/[^\s"']+/);
                if (urlMatch) parsedUrl = urlMatch[0];
              }

              if (parsedUrl) {
                store.updateJob(job.id, {
                  status: "complete",
                  streamUrl: parsedUrl,
                  completedAt: Date.now(),
                });
                await attachRealDebridStreamToItem(job.mediaItemId, parsedUrl, job.filename);
              } else {
                store.updateJob(job.id, {
                  status: "error",
                  failureMessage: "Seeding finished, but failed to parse Real-Debrid streaming URL from worker log.",
                  completedAt: Date.now(),
                });
              }
            } else if (newStatus === "error") {
              store.updateJob(job.id, {
                status: "error",
                failureMessage: res.failure_message || "Kaggle worker encountered an error.",
                completedAt: Date.now(),
              });
            }
          }
        }
      } catch (err: any) {
        console.warn("Failed checking Real-Debrid seed job status:", err);
      }
    }
  }, 20000);
}

/**
 * Initiates the Real-Debrid Torrent Seeding pipeline for a media item.
 */
export async function seedItemToRealDebrid(
  item: MediaItem,
  providerOverride?: ProviderSelection
): Promise<{ ok: boolean; message: string; jobId?: string }> {
  const { debridConfig } = useAppStore.getState();
  const rdKey = debridConfig?.realDebridApiKey?.trim();

  if (!rdKey) {
    useToastStore.getState().addToast(
      "Real-Debrid API Key required. Please configure it in Settings -> Debrid.",
      "error",
      7000
    );
    return { ok: false, message: "Real-Debrid API key not configured." };
  }

  const jobId = `rd-seed-${Date.now()}`;
  const rcloneConfigContent = useAppStore.getState().rcloneConfigContent;
  const payload: KaggleRdSeedRequest & { rclone_config_snippet?: string } = {
    job_id: jobId,
    source_input: item.remotePath,
    rd_api_key: rdKey,
    title: item.title,
    filename: item.filename || `${item.title.replace(/[^\w.-]/g, "_")}.mkv`,
    rclone_config_snippet: rcloneConfigContent || undefined,
  };

  try {
    const dispatchRes = await dispatchCloudTask({
      jobType: "rd_torrent_seed",
      payload,
      title: `Seed to Real-Debrid: ${item.title}`,
      providerOverride,
    });

    const seedJob: RdSeedJob = {
      id: jobId,
      mediaItemId: item.id,
      title: item.title,
      filename: payload.filename,
      sourceInput: item.remotePath,
      status: "queued",
      provider: dispatchRes.provider,
      kernelSlug: dispatchRes.kernelSlug,
      kernelUrl: dispatchRes.url,
      startedAt: Date.now(),
    };

    useRdSeedStore.getState().addJob(seedJob);
    initRdSeedPoller();

    const providerName = dispatchRes.provider === "github_actions" ? "GitHub Actions" : "Kaggle Cloud Worker";
    useToastStore.getState().addToast(
      `🚀 Started Real-Debrid 4K Seeding on ${providerName}: "${item.title}"! Untouched stream will be attached automatically when caching completes.`,
      "info",
      8000
    );

    return { ok: true, message: `Dispatched to ${providerName}`, jobId };
  } catch (err: any) {
    const msg = err?.message || String(err);
    useToastStore.getState().addToast(`Failed to dispatch Real-Debrid seeding: ${msg}`, "error", 8000);
    return { ok: false, message: msg };
  }
}
