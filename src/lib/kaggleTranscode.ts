import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useAppStore, type MediaItem } from "../store/appStore";
import { persistItems } from "./libraryDb";
import { useToastStore } from "../store/toastStore";
import { normalizeWorkerLog } from "./workerLog";

export type KaggleCredentials = {
  username: string;
  key: string;
};

export type KaggleConnectionStatus = {
  ok: boolean;
  username: string;
  message: string;
};

export type KaggleTranscodeRequest = {
  job_id: string;
  source_input: string;
  source_items?: string[];
  dest_remote_folder: string;
  delete_original: boolean;
  output_filename?: string;
  crf?: number;
  preset?: number;
  max_height?: number;
  rclone_config_snippet?: string;
  telegram_bot_token?: string;
  telegram_chat_id?: string;
  telegram_api_id?: string;
  telegram_api_hash?: string;
  streamtape_api_login?: string;
  streamtape_api_key?: string;
};

export type KaggleDispatchResult = {
  job_id: string;
  kernel_slug: string;
  kernel_ref: string;
  url: string;
  status: string;
};

export type KaggleKernelStatus = {
  status: "queued" | "running" | "complete" | "error" | string;
  failure_message?: string;
};

export type CloudTranscodeJob = {
  id: string;
  title: string;
  kernelSlug: string;
  kernelUrl: string;
  sourceInput: string;
  destRemoteFolder: string;
  targetFilename: string;
  targetLibraryId?: string;
  targetLibraryType?: string;
  matchedMetadata?: any;
  deleteOriginal: boolean;
  status: "queued" | "running" | "complete" | "error";
  failureMessage?: string;
  startedAt: number;
  completedAt?: number;
  provider?: "kaggle" | "github_actions";
  /** GitHub Actions run correlation — see CloudTransferJob. */
  workflowRunId?: number;
  ghaOwner?: string;
  ghaRepo?: string;
};

export async function saveKaggleCredentials(credentials: KaggleCredentials): Promise<void> {
  return invoke("save_kaggle_credentials", { credentials });
}

export async function loadKaggleCredentials(): Promise<KaggleCredentials> {
  return invoke<KaggleCredentials>("load_kaggle_credentials");
}

export async function importKaggleJson(): Promise<KaggleCredentials> {
  return invoke<KaggleCredentials>("import_kaggle_json");
}

export async function testKaggleConnection(
  username?: string,
  key?: string
): Promise<KaggleConnectionStatus> {
  return invoke<KaggleConnectionStatus>("test_kaggle_connection", { username, key });
}

export async function dispatchKaggleTranscode(
  req: KaggleTranscodeRequest
): Promise<KaggleDispatchResult> {
  const { kaggleAccounts } = useAppStore.getState();
  const enabledAccounts = (kaggleAccounts || []).filter((a) => a.enabled !== false);

  if (!enabledAccounts || enabledAccounts.length <= 1) {
    return invoke<KaggleDispatchResult>("dispatch_kaggle_transcode", { req });
  }

  let lastError: any = null;
  for (let i = 0; i < enabledAccounts.length; i++) {
    const acc = enabledAccounts[i];
    try {
      await saveKaggleCredentials({ username: acc.username, key: acc.key });
      return await invoke<KaggleDispatchResult>("dispatch_kaggle_transcode", { req });
    } catch (err: any) {
      const msg = err?.message || String(err);
      lastError = err;
      if (
        msg.includes("429") ||
        msg.toLowerCase().includes("quota") ||
        msg.toLowerCase().includes("rate limit") ||
        msg.toLowerCase().includes("concurrency")
      ) {
        console.warn(`[Kaggle Multi-Account] Quota hit on account ${acc.label || acc.username}. Rotating to next account...`);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("Failed to dispatch Kaggle transcode across all configured accounts.");
}

export async function getKaggleTranscodeStatus(
  kernelSlug: string
): Promise<KaggleKernelStatus> {
  return invoke<KaggleKernelStatus>("get_kaggle_transcode_status", { kernelSlug });
}

export async function getKaggleTranscodeOutput(
  kernelSlug: string
): Promise<string> {
  return normalizeWorkerLog(await invoke<string>("get_kaggle_transcode_output", { kernelSlug }));
}

interface CloudTranscodeStore {
  jobs: Record<string, CloudTranscodeJob>;
  addJob: (job: CloudTranscodeJob) => void;
  updateJob: (id: string, updates: Partial<CloudTranscodeJob>) => void;
  removeJob: (id: string) => void;
  clearCompletedJobs: () => void;
  clearAllJobs: () => void;
}

export const useCloudTranscodeStore = create<CloudTranscodeStore>()(
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
          const next: Record<string, CloudTranscodeJob> = {};
          Object.entries(s.jobs).forEach(([k, v]) => {
            if (v.status !== "complete" && v.status !== "error") {
              next[k] = v;
            }
          });
          return { jobs: next };
        }),
      clearAllJobs: () => set({ jobs: {} }),
    }),
    {
      name: "rcloneflix-cloud-transcode-jobs",
    }
  )
);

// Background poll timer for running cloud transcode jobs
let pollerInterval: any = null;

export function initCloudTranscodePoller() {
  if (pollerInterval) return;

  pollerInterval = setInterval(async () => {
    const store = useCloudTranscodeStore.getState();
    const activeJobs = Object.values(store.jobs).filter(
      (j) => (j.status === "queued" || j.status === "running") && j.provider !== "github_actions"
    );

    if (activeJobs.length === 0) return;

    for (const job of activeJobs) {
      try {
        const res = await getKaggleTranscodeStatus(job.kernelSlug);
        const newStatus = res.status.toLowerCase();

        if (newStatus !== job.status) {
          store.updateJob(job.id, {
            status: newStatus as any,
            failureMessage: res.failure_message || undefined,
            ...(newStatus === "complete" || newStatus === "error"
              ? { completedAt: Date.now() }
              : {}),
          });

          if (newStatus === "complete") {
            if (
              job.destRemoteFolder?.toLowerCase().startsWith("telegram:") ||
              job.destRemoteFolder?.toLowerCase().startsWith("telegram-drive:") ||
              job.destRemoteFolder?.toLowerCase().startsWith("tg-")
            ) {
              import("./telegramOffload")
                .then((m) => m.reconcileTelegramDriveCatalog())
                .catch((e) => console.warn("Telegram Drive catalog reconciliation warning:", e));
            }

            useToastStore
              .getState()
              .addToast(
                `🎉 Cloud Transcode complete: "${job.title}" is archived in ${job.destRemoteFolder}!`,
                "success",
                8000
              );

            // Automatic Library Routing Ingestion
            const targetLibId =
              job.targetLibraryId ||
              useAppStore.getState().libraries.find((l) => l.type === job.targetLibraryType)?.id;

            if (targetLibId && job.matchedMetadata) {
              try {
                const cleanFolder = job.destRemoteFolder.replace(/\/+$/, "");
                const targetFilePath = `${cleanFolder}/${job.targetFilename}`;
                const meta = job.matchedMetadata;
                const isTv = job.targetLibraryType === "tv";

                const newItem: MediaItem = {
                  id: `media-transcode-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                  libraryId: targetLibId,
                  libraryType: (job.targetLibraryType as any) || "movies",
                  remotePath: targetFilePath,
                  filename: job.targetFilename,
                  title: meta.title || job.title,
                  year: meta.year,
                  posterUrl: meta.posterUrl,
                  backdropUrl: meta.backdropUrl,
                  overview: meta.overview,
                  rating: meta.rating,
                  genres: meta.genres,
                  metadataSource: meta.metadataSource || "cinemeta",
                  metadataId: meta.metadataId,
                  addedAt: Date.now(),
                  lastScannedAt: Date.now(),
                  ...(isTv ? {
                    showTitle: meta.showTitle || meta.title || job.title,
                    season: meta.season || 1,
                    episode: meta.episode || 1,
                    episodeTitle: meta.episodeTitle,
                  } : {}),
                };

                useAppStore.getState().upsertMediaItem(newItem);
                await persistItems([newItem]);
                console.log("✅ Transcoded media item auto-ingested into library:", newItem.title);
              } catch (e) {
                console.warn("Failed to auto-ingest transcoded item into library:", e);
              }
            }
          } else if (newStatus === "error") {
            useToastStore
              .getState()
              .addToast(
                `❌ Cloud Transcode failed for "${job.title}": ${res.failure_message || "Kernel error"}`,
                "error",
                8000
              );
          }
        }
      } catch (err: any) {
        console.warn(`Error polling status for job ${job.kernelSlug}:`, err);
        const errMsg = String(err?.message || err);
        const jobAge = Date.now() - (job.startedAt || 0);

        // Tolerate initial 404 / 403 while Kaggle provisions kernel in the first 3 minutes
        if (jobAge > 3 * 60 * 1000 && (errMsg.includes("403") || errMsg.includes("404") || errMsg.includes("denied"))) {
          store.updateJob(job.id, {
            status: "error",
            failureMessage: "Job slug not found on Kaggle after 3 min (stale or mismatch)",
            completedAt: Date.now(),
          });
        }
      }
    }
  }, 30000); // Poll every 30 seconds
}
