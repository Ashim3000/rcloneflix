import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useToastStore } from "../store/toastStore";
import { normalizeWorkerLog } from "./workerLog";

export type TransferOperation = "copy" | "move" | "sync";

export type KaggleTransferRequest = {
  job_id: string;
  operation: TransferOperation;
  source: string;
  destination: string;
  batch_items?: string[];
  dest_filename?: string;
  transfers?: number;
  checkers?: number;
  drive_server_side_copy?: boolean;
  dry_run?: boolean;
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

export type CloudTransferJob = {
  id: string;
  title: string;
  operation: TransferOperation;
  source: string;
  destination: string;
  batchItems?: string[];
  kernelSlug: string;
  kernelUrl: string;
  status: "queued" | "running" | "complete" | "error";
  failureMessage?: string;
  createdAt: number;
  completedAt?: number;
  transfers?: number;
  checkers?: number;
  dryRun?: boolean;
  provider?: "kaggle" | "github_actions";
  /** GitHub Actions run correlation: which exact run (and repo) this job maps to.
   *  Set at dispatch time or adopted by the poller — status is only ever read from
   *  THIS run, never from "the repo's latest run". */
  workflowRunId?: number;
  ghaOwner?: string;
  ghaRepo?: string;
};

export async function dispatchKaggleTransfer(
  req: KaggleTransferRequest
): Promise<KaggleDispatchResult> {
  return invoke<KaggleDispatchResult>("dispatch_kaggle_transfer", { req });
}

export async function getKaggleTransferStatus(
  kernelSlug: string
): Promise<KaggleKernelStatus> {
  return invoke<KaggleKernelStatus>("get_kaggle_transcode_status", { kernelSlug });
}

export async function getKaggleTransferOutput(
  kernelSlug: string
): Promise<string> {
  return normalizeWorkerLog(await invoke<string>("get_kaggle_transcode_output", { kernelSlug }));
}

interface CloudTransferStore {
  jobs: Record<string, CloudTransferJob>;
  addJob: (job: CloudTransferJob) => void;
  updateJob: (id: string, updates: Partial<CloudTransferJob>) => void;
  removeJob: (id: string) => void;
  clearCompletedJobs: () => void;
  clearAllJobs: () => void;
}

export const useCloudTransferStore = create<CloudTransferStore>()(
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
          const next: Record<string, CloudTransferJob> = {};
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
      name: "rcloneflix-cloud-transfer-jobs",
    }
  )
);

// Background poll timer for running cloud transfer jobs
let transferPollerInterval: any = null;

export function initCloudTransferPoller() {
  if (transferPollerInterval) return;

  transferPollerInterval = setInterval(async () => {
    const store = useCloudTransferStore.getState();
    const activeJobs = Object.values(store.jobs).filter(
      (j) => (j.status === "queued" || j.status === "running") && j.provider !== "github_actions"
    );

    if (activeJobs.length === 0) return;

    for (const job of activeJobs) {
      try {
        const res = await getKaggleTransferStatus(job.kernelSlug);
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
              job.destination.toLowerCase().startsWith("telegram:") ||
              job.destination.toLowerCase().startsWith("telegram-drive:") ||
              job.destination.toLowerCase().startsWith("tg-")
            ) {
              try {
                const outLog = await getKaggleTransferOutput(job.kernelSlug);
                const { parseAndRegisterTelegramWorkerLogs } = await import("./telegramOffload");
                await parseAndRegisterTelegramWorkerLogs(outLog);
              } catch (e) {
                console.warn("Could not auto-register Telegram offload log:", e);
              }
            } else if (job.destination.toLowerCase().startsWith("udrop:")) {
              try {
                const { getUdropDirectLinkForFile } = await import("./udrop");
                const fileName = (job.batchItems && job.batchItems[0]) || job.title || job.source.split("/").pop() || "";
                const directUrl = await getUdropDirectLinkForFile(fileName);
                if (directUrl) {
                  try {
                    await navigator.clipboard.writeText(directUrl);
                  } catch (_) {
                    // Fallback handled via toast action
                  }
                  useToastStore.getState().addToast(
                    `⚡ Direct Web Link Ready: "${fileName}"!`,
                    "success",
                    12000,
                    {
                      label: "Copy Link",
                      onClick: () => {
                        navigator.clipboard.writeText(directUrl);
                        useToastStore.getState().addToast("Copied direct link to clipboard!", "success");
                      },
                    }
                  );
                }
              } catch (e) {
                console.warn("Could not auto-resolve uDrop link on Kaggle completion:", e);
              }
            }
            useToastStore
              .getState()
              .addToast(
                `🎉 Cloud ${job.operation.toUpperCase()} complete: "${job.title}"!`,
                "success",
                8000
              );
          } else if (newStatus === "error") {
            useToastStore
              .getState()
              .addToast(
                `❌ Cloud ${job.operation.toUpperCase()} failed for "${job.title}": ${res.failure_message || "Kernel error"}`,
                "error",
                8000
              );
          }
        }
      } catch (err: any) {
        console.warn(`Error polling transfer status for job ${job.kernelSlug}:`, err);
        const errMsg = String(err?.message || err);
        const jobAge = Date.now() - (job.createdAt || 0);

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
  }, 20000); // Poll every 20 seconds
}
