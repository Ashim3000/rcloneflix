import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useToastStore } from "../store/toastStore";
import type { KaggleDispatchResult, KaggleKernelStatus } from "./kaggleTransfer";

export type KaggleAlignRequest = {
  job_id: string;
  title: string;
  epub_remote_path: string;
  audio_remote_path: string;
  output_remote_path: string;
  whisper_model?: "tiny" | "base" | "small" | "medium";
  rclone_config_snippet?: string;
};

export type CloudAlignJob = {
  id: string;
  title: string;
  epubRemotePath: string;
  audioRemotePath: string;
  outputRemotePath: string;
  whisperModel: string;
  kernelSlug: string;
  kernelUrl: string;
  status: "queued" | "running" | "complete" | "error";
  failureMessage?: string;
  createdAt: number;
  completedAt?: number;
};

export async function dispatchKaggleAlign(
  req: KaggleAlignRequest
): Promise<KaggleDispatchResult> {
  return invoke<KaggleDispatchResult>("dispatch_kaggle_align", { req });
}

export async function getKaggleAlignStatus(
  kernelSlug: string
): Promise<KaggleKernelStatus> {
  return invoke<KaggleKernelStatus>("get_kaggle_transcode_status", { kernelSlug });
}

export async function getKaggleAlignOutput(
  kernelSlug: string
): Promise<string> {
  return invoke<string>("get_kaggle_transcode_output", { kernelSlug });
}

interface CloudAlignState {
  jobs: CloudAlignJob[];
  addJob: (job: CloudAlignJob) => void;
  updateJob: (id: string, patch: Partial<CloudAlignJob>) => void;
  removeJob: (id: string) => void;
  clearFinishedJobs: () => void;
}

export const useCloudAlignStore = create<CloudAlignState>()(
  persist(
    (set) => ({
      jobs: [],
      addJob: (job) =>
        set((state) => ({
          jobs: [job, ...state.jobs.filter((j) => j.id !== job.id)],
        })),
      updateJob: (id, patch) =>
        set((state) => ({
          jobs: state.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
        })),
      removeJob: (id) =>
        set((state) => ({
          jobs: state.jobs.filter((j) => j.id !== id),
        })),
      clearFinishedJobs: () =>
        set((state) => ({
          jobs: state.jobs.filter((j) => j.status === "running" || j.status === "queued"),
        })),
    }),
    {
      name: "rcloneflix_cloud_align_jobs",
    }
  )
);
