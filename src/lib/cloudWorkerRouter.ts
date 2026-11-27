import { useAppStore } from "../store/appStore";
import { useToastStore } from "../store/toastStore";
import { useCloudTransferStore, dispatchKaggleTransfer, type KaggleTransferRequest } from "./kaggleTransfer";
import { useCloudTranscodeStore, dispatchKaggleTranscode, type KaggleTranscodeRequest } from "./kaggleTranscode";
import { useCloudAlignStore, dispatchKaggleAlign, type KaggleAlignRequest } from "./kaggleAligner";
import { dispatchKaggleRdSeed, type KaggleRdSeedRequest } from "./realDebridSeeder";
import { httpFetch } from "./httpFetch";
import { ensureGitHubWorkerReady, WorkerSecurityError, DEFAULT_GHA_WORKER_REPO } from "./githubWorkerProvisioner";

export type CloudWorkerProvider = "kaggle" | "github_actions";
export type ProviderSelection = "auto" | "kaggle" | "github_actions";
export type CloudJobType = "rclone_transfer" | "video_transcode" | "whisper_align" | "dropmb_offload" | "rd_torrent_seed";

/**
 * Counts currently running or queued jobs across all Kaggle pipelines.
 * Retains jobs created < 20 mins ago that have not explicitly completed
 * to prevent transient 404 polling errors from falsely resetting concurrency.
 */
export function getActiveKaggleJobCount(): number {
  const transferJobs = Object.values(useCloudTransferStore.getState().jobs || {});
  const transcodeJobs = Object.values(useCloudTranscodeStore.getState().jobs || {});
  const alignJobs = useCloudAlignStore.getState().jobs || [];

  const now = Date.now();
  const isKaggleActive = (job: { status: string; provider?: string; createdAt?: number; startedAt?: number; completedAt?: number }) => {
    if (job.provider === "github_actions") return false;
    if (job.status === "queued" || job.status === "running") return true;
    const started = job.createdAt || job.startedAt || 0;
    // Keep active if not explicitly completed and was started within the last 20 minutes
    if (job.status !== "complete" && !job.completedAt && started > 0 && now - started < 20 * 60 * 1000) {
      return true;
    }
    return false;
  };

  const activeTransfers = transferJobs.filter(isKaggleActive).length;
  const activeTranscodes = transcodeJobs.filter(isKaggleActive).length;
  const activeAligns = alignJobs.filter(isKaggleActive).length;

  return activeTransfers + activeTranscodes + activeAligns;
}

/**
 * Determines whether a job should route to Kaggle or fall back to GitHub Actions.
 * Supports manual override ("auto" | "kaggle" | "github_actions").
 */
export function pickCloudWorkerProvider(override?: ProviderSelection): {
  provider: CloudWorkerProvider;
  reason: string;
} {
  const { ghaConfig, kaggleUsername, kaggleKey } = useAppStore.getState();
  const activeKaggle = getActiveKaggleJobCount();

  const isKaggleConfigured = Boolean(kaggleUsername?.trim() && kaggleKey?.trim());
  const isGhaConfigured = Boolean(
    ghaConfig?.enabled && ghaConfig?.token?.trim() && ghaConfig?.owner?.trim() && ghaConfig?.repo?.trim()
  );

  if (override === "github_actions") {
    if (!isGhaConfigured) {
      throw new Error("GitHub Actions runner is not fully configured in Settings.");
    }
    return {
      provider: "github_actions",
      reason: "Manually selected GitHub Actions Runner.",
    };
  }

  if (override === "kaggle") {
    if (!isKaggleConfigured) {
      throw new Error("Kaggle credentials are not configured in Settings.");
    }
    return {
      provider: "kaggle",
      reason: "Manually selected Kaggle Cloud Worker.",
    };
  }

  // Auto mode
  if (isKaggleConfigured && activeKaggle < 2) {
    return {
      provider: "kaggle",
      reason: `Kaggle active concurrency (${activeKaggle}/2) allows immediate execution.`,
    };
  }

  if (isGhaConfigured) {
    return {
      provider: "github_actions",
      reason: isKaggleConfigured
        ? `Kaggle concurrency limit reached (${activeKaggle} active jobs). Rotated to GitHub Actions runner.`
        : "Kaggle not configured. Dispatched to GitHub Actions runner.",
    };
  }

  return {
    provider: "kaggle",
    reason: "GitHub Actions fallback not configured; defaulting to Kaggle queue.",
  };
}

/**
 * Validates a GitHub Personal Access Token and repository access.
 */
export async function testGitHubActionsConnection(
  token: string,
  owner: string,
  repo: string
): Promise<{ ok: boolean; message: string; defaultBranch?: string }> {
  try {
    const cleanToken = token.trim();
    const cleanOwner = owner.trim();
    const cleanRepo = repo.trim();

    if (!cleanToken || !cleanOwner || !cleanRepo) {
      return { ok: false, message: "Token, repository owner, and repository name are required." };
    }

    const res = await httpFetch(`https://api.github.com/repos/${cleanOwner}/${cleanRepo}`, {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (res.ok) {
      const data = await res.json();
      const defaultBranch = data.default_branch || "main";
      return {
        ok: true,
        message: `Connected to repository ${data.full_name} (default branch: ${defaultBranch}).`,
        defaultBranch,
      };
    }

    if (res.status === 401) {
      return { ok: false, message: "Invalid GitHub Personal Access Token." };
    }
    if (res.status === 404) {
      return { ok: false, message: `Repository ${cleanOwner}/${cleanRepo} not found or token lacks 'repo' scope.` };
    }

    return { ok: false, message: `GitHub API returned HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Failed to reach GitHub API." };
  }
}

/**
 * Runs resolved at dispatch time that no store job has claimed yet. The poller drains
 * this (FIFO) onto active GHA jobs missing a workflowRunId, so job records created by
 * callers AFTER dispatch still get correlated to their exact run.
 */
const pendingGhaRuns: Array<{ runId: number; owner: string; repo: string; htmlUrl: string; resolvedAt: number }> = [];

/** All run ids already claimed by any job in either store (active or finished). */
function claimedRunIds(): Set<number> {
  const ids = new Set<number>();
  for (const j of Object.values(useCloudTransferStore.getState().jobs || {})) {
    if (j.workflowRunId) ids.add(j.workflowRunId);
  }
  for (const j of Object.values(useCloudTranscodeStore.getState().jobs || {})) {
    if (j.workflowRunId) ids.add(j.workflowRunId);
  }
  return ids;
}

/**
 * Dispatches a job payload to a GitHub Actions workflow runner with multi-account pool rotation.
 */
export async function dispatchGitHubAction(params: {
  jobType: CloudJobType;
  payload: any;
}): Promise<{ runUrl: string; status: string; workflowRunId?: number; ghaOwner?: string; ghaRepo?: string }> {
  const { ghaConfig, ghaAccounts } = useAppStore.getState();

  // Build candidate pool from ghaAccounts or legacy ghaConfig
  const candidates: Array<{ token: string; owner: string; repo: string; workflowFile?: string; branch?: string; label?: string }> = [];

  if (ghaAccounts && ghaAccounts.length > 0) {
    ghaAccounts.filter((a) => a.enabled !== false).forEach((a) => candidates.push(a));
  }
  if (candidates.length === 0 && ghaConfig?.token && ghaConfig?.owner && ghaConfig?.repo) {
    candidates.push(ghaConfig);
  }

  if (candidates.length === 0) {
    throw new Error("GitHub Actions runner is not configured in Settings.");
  }

  let lastError: Error | null = null;

  for (let idx = 0; idx < candidates.length; idx++) {
    const acc = candidates[idx];
    const { token, owner, repo } = acc;
    const workflowFile = acc.workflowFile?.trim() || ghaConfig?.workflowFile?.trim() || "cloud_worker.yml";
    const ref = acc.branch?.trim() || (ghaConfig as any)?.branch?.trim() || "main";

    let dOwner = owner, dRepo = repo, dRef = ref;
    try {
      const ready = await ensureGitHubWorkerReady({
        token, owner, repo, branch: acc.branch?.trim() || undefined, workflowFile,
        allowPublic: Boolean((acc as any).allowPublicRepo ?? (ghaConfig as any)?.allowPublicRepo),
      });
      dOwner = ready.owner; dRepo = ready.repo; dRef = ready.branch;
    } catch (e) {
      const isManagedRepo = !repo || repo.trim().toLowerCase() === DEFAULT_GHA_WORKER_REPO;
      if (e instanceof WorkerSecurityError || isManagedRepo) {
        console.warn(`[GHA Multi-Account] Skipping ${acc.label || owner}: ${(e as Error).message}`);
        lastError = e instanceof Error ? e : new Error(String(e));
        continue;
      }
      // Custom repo: provisioning is best-effort; keep dispatching exactly as before.
      console.warn(`[GHA Multi-Account] Provision check skipped for ${owner}/${repo}: ${(e as Error).message}`);
    }

    const dispatchUrl = `https://api.github.com/repos/${dOwner}/${dRepo}/actions/workflows/${workflowFile}/dispatches`;

    // Optional proactive check of GitHub Actions billing minutes
    try {
      const billingRes = await httpFetch(`https://api.github.com/users/${dOwner}/settings/billing/actions`, {
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (billingRes.ok) {
        const billingData = await billingRes.json();
        if (billingData.total_minutes_used >= billingData.included_minutes && billingData.included_minutes > 0) {
          console.warn(`[GHA Multi-Account] Account ${acc.label || dOwner} has exhausted monthly free minutes (${billingData.total_minutes_used}/${billingData.included_minutes}). Rotating to next account...`);
          continue;
        }
      }
    } catch {}

    const body = {
      ref: dRef,
      inputs: {
        job_type: params.jobType,
        payload: typeof params.payload === "string" ? params.payload : JSON.stringify(params.payload),
      },
    };

    try {
      // workflow_dispatch returns a bare 204 with NO run id. Snapshot the newest run id
      // BEFORE dispatching so the run we create is identifiable as "id > preMaxId".
      const ghHeaders = {
        Authorization: `Bearer ${token.trim()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      let preMaxId = 0;
      try {
        const preRes = await httpFetch(
          `https://api.github.com/repos/${dOwner}/${dRepo}/actions/workflows/${workflowFile}/runs?per_page=1`,
          { headers: ghHeaders }
        );
        if (preRes.ok) {
          const preData = await preRes.json();
          preMaxId = Number(preData?.workflow_runs?.[0]?.id) || 0;
        }
      } catch {}

      const res = await httpFetch(dispatchUrl, {
        method: "POST",
        headers: { ...ghHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok && res.status !== 204) {
        const errorBody = await res.text();
        if (res.status === 403 || res.status === 429 || errorBody.toLowerCase().includes("billing") || errorBody.toLowerCase().includes("quota")) {
          console.warn(`[GHA Multi-Account] Quota/permission error on ${acc.label || dOwner} (HTTP ${res.status}): ${errorBody}. Rotating to next candidate...`);
          lastError = new Error(`HTTP ${res.status}: ${errorBody}`);
          continue;
        }
        if (res.status === 404) {
          throw new Error(
            `Failed to dispatch GitHub Action (HTTP 404): Workflow '${workflowFile}' not found in '${dOwner}/${dRepo}' on branch '${dRef}'. Please verify that '.github/workflows/${workflowFile}' is committed and pushed with 'workflow_dispatch' trigger enabled.`
          );
        }
        throw new Error(`Failed to dispatch GitHub Action (HTTP ${res.status}): ${errorBody}`);
      }

      // Resolve the run this dispatch just created: the oldest unclaimed run with
      // id > preMaxId on this workflow. Usually appears within a couple of seconds.
      let workflowRunId: number | undefined;
      let htmlUrl = `https://github.com/${dOwner}/${dRepo}/actions`;
      for (let attempt = 0; attempt < 6 && !workflowRunId; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const listRes = await httpFetch(
            `https://api.github.com/repos/${dOwner}/${dRepo}/actions/workflows/${workflowFile}/runs?per_page=10`,
            { headers: ghHeaders }
          );
          if (!listRes.ok) continue;
          const listData = await listRes.json();
          const claimed = claimedRunIds();
          pendingGhaRuns.forEach((p) => claimed.add(p.runId));
          const fresh = (listData?.workflow_runs || [])
            .filter((r: any) => Number(r.id) > preMaxId && !claimed.has(Number(r.id)))
            .sort((a: any, b: any) => Number(a.id) - Number(b.id));
          if (fresh.length > 0) {
            workflowRunId = Number(fresh[0].id);
            htmlUrl = fresh[0].html_url || htmlUrl;
          }
        } catch {}
      }
      if (workflowRunId) {
        pendingGhaRuns.push({ runId: workflowRunId, owner: dOwner, repo: dRepo, htmlUrl, resolvedAt: Date.now() });
      }

      return {
        runUrl: htmlUrl,
        status: "queued",
        workflowRunId,
        ghaOwner: dOwner,
        ghaRepo: dRepo,
      };
    } catch (err: any) {
      lastError = err;
      if (idx < candidates.length - 1) {
        console.warn(`[GHA Multi-Account] Error with account ${acc.label || dOwner}, attempting next account...`);
        continue;
      }
    }
  }

  throw lastError || new Error("Failed to dispatch GitHub Action across all configured accounts.");
}

// Background poller interval for GitHub Actions workflows
let ghaPollerInterval: any = null;

export function initGitHubActionsPoller() {
  if (ghaPollerInterval) return;

  ghaPollerInterval = setInterval(async () => {
    const { ghaConfig, ghaAccounts } = useAppStore.getState();

    const transferStore = useCloudTransferStore.getState();
    const transcodeStore = useCloudTranscodeStore.getState();

    const activeTransferGha = Object.values(transferStore.jobs || {}).filter(
      (j) => j.provider === "github_actions" && (j.status === "queued" || j.status === "running")
    );
    const activeTranscodeGha = Object.values(transcodeStore.jobs || {}).filter(
      (j) => j.provider === "github_actions" && (j.status === "queued" || j.status === "running")
    );

    if (activeTransferGha.length === 0 && activeTranscodeGha.length === 0) {
      return;
    }

    // Every configured account/repo a job could have been dispatched to (multi-account pool).
    const accounts: Array<{ token: string; owner: string; repo: string; workflowFile?: string }> = [];
    for (const a of ghaAccounts || []) {
      if (a.enabled !== false && a.token && a.owner && a.repo) accounts.push(a);
    }
    if (ghaConfig?.token && ghaConfig?.owner && ghaConfig?.repo) {
      if (!accounts.some((a) => a.owner === ghaConfig.owner && a.repo === ghaConfig.repo)) {
        accounts.push(ghaConfig);
      }
    }
    if (accounts.length === 0) return;

    try {
      // Fetch recent runs from every account, tagged with where they came from.
      type TaggedRun = { id: number; status: string; conclusion: string; htmlUrl: string; createdAt: number; path: string; owner: string; repo: string; token: string };
      const allRuns: TaggedRun[] = [];
      for (const acc of accounts) {
        try {
          const res = await httpFetch(
            `https://api.github.com/repos/${acc.owner}/${acc.repo}/actions/runs?per_page=20`,
            {
              headers: {
                Authorization: `Bearer ${acc.token.trim()}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
            }
          );
          if (!res.ok) continue;
          const data = await res.json();
          for (const r of data?.workflow_runs || []) {
            allRuns.push({
              id: Number(r.id),
              status: String(r.status || "").toLowerCase(),
              conclusion: String(r.conclusion || "").toLowerCase(),
              htmlUrl: r.html_url || `https://github.com/${acc.owner}/${acc.repo}/actions`,
              createdAt: Date.parse(r.created_at || "") || 0,
              path: String(r.path || ""),
              owner: acc.owner,
              repo: acc.repo,
              token: acc.token,
            });
          }
        } catch {}
      }
      if (allRuns.length === 0) return;

      // ── Correlation phase ──
      // 1) Drain dispatch-time resolved runs onto jobs missing a workflowRunId (FIFO:
      //    oldest job gets the oldest resolved run — dispatch order ≈ run creation order).
      // 2) Any job still unmatched (e.g. app restarted between dispatch and now) adopts
      //    the oldest UNCLAIMED worker run. Never a run another job already owns.
      type AnyJob = { id: string; status: string; workflowRunId?: number; createdAt?: number; startedAt?: number };
      const unmatched: Array<{ job: AnyJob; kind: "transfer" | "transcode" }> = [];
      for (const j of activeTransferGha) if (!j.workflowRunId) unmatched.push({ job: j, kind: "transfer" });
      for (const j of activeTranscodeGha) if (!j.workflowRunId) unmatched.push({ job: j, kind: "transcode" });
      unmatched.sort(
        (a, b) =>
          ((a.job.createdAt ?? a.job.startedAt) || 0) - ((b.job.createdAt ?? b.job.startedAt) || 0)
      );

      const assign = (entry: { job: AnyJob; kind: "transfer" | "transcode" }, runId: number, owner: string, repo: string, htmlUrl: string) => {
        const patch = { workflowRunId: runId, ghaOwner: owner, ghaRepo: repo, kernelUrl: htmlUrl };
        if (entry.kind === "transfer") transferStore.updateJob(entry.job.id, patch as any);
        else transcodeStore.updateJob(entry.job.id, patch as any);
        (entry.job as any).workflowRunId = runId;
        (entry.job as any).ghaOwner = owner;
        (entry.job as any).ghaRepo = repo;
      };

      pendingGhaRuns.sort((a, b) => a.runId - b.runId);
      while (unmatched.length > 0 && pendingGhaRuns.length > 0) {
        const pending = pendingGhaRuns.shift()!;
        const entry = unmatched.shift()!;
        assign(entry, pending.runId, pending.owner, pending.repo, pending.htmlUrl);
      }
      if (unmatched.length > 0) {
        const claimed = claimedRunIds();
        const workerFiles = new Set(
          accounts.map((a) => (a.workflowFile?.trim() || ghaConfig?.workflowFile?.trim() || "cloud_worker.yml"))
        );
        const adoptable = allRuns
          .filter(
            (r) =>
              !claimed.has(r.id) &&
              Array.from(workerFiles).some((f) => r.path.endsWith(`/${f}`) || r.path === f) &&
              (r.status === "queued" || r.status === "in_progress" || Date.now() - r.createdAt < 2 * 60 * 60 * 1000)
          )
          .sort((a, b) => a.createdAt - b.createdAt);
        for (const entry of unmatched) {
          const run = adoptable.shift();
          if (!run) break;
          claimed.add(run.id);
          assign(entry, run.id, run.owner, run.repo, run.htmlUrl);
        }
      }

      // ── Status phase ── each job reads status ONLY from its own correlated run.
      const runById = new Map<number, TaggedRun>(allRuns.map((r) => [r.id, r]));
      const lookupRun = async (job: AnyJob & { ghaOwner?: string; ghaRepo?: string }): Promise<TaggedRun | null> => {
        if (!job.workflowRunId) return null;
        const cached = runById.get(job.workflowRunId);
        if (cached) return cached;
        // Run fell outside the first page (busy repo) — fetch it directly.
        const acc =
          accounts.find((a) => a.owner === job.ghaOwner && a.repo === job.ghaRepo) || accounts[0];
        try {
          const res = await httpFetch(
            `https://api.github.com/repos/${acc.owner}/${acc.repo}/actions/runs/${job.workflowRunId}`,
            {
              headers: {
                Authorization: `Bearer ${acc.token.trim()}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
            }
          );
          if (!res.ok) return null;
          const r = await res.json();
          return {
            id: Number(r.id),
            status: String(r.status || "").toLowerCase(),
            conclusion: String(r.conclusion || "").toLowerCase(),
            htmlUrl: r.html_url || "",
            createdAt: Date.parse(r.created_at || "") || 0,
            path: String(r.path || ""),
            owner: acc.owner,
            repo: acc.repo,
            token: acc.token,
          };
        } catch {
          return null;
        }
      };

      // Update transfer jobs
      for (const job of activeTransferGha) {
        const run = await lookupRun(job);
        if (!run) continue; // not correlated yet — do NOT guess from unrelated runs
        const runStatus = run.status;
        const conclusion = run.conclusion;
        const runUrl = run.htmlUrl;
        if ((runStatus === "in_progress" || runStatus === "queued") && job.status !== "running") {
          if (runStatus === "in_progress") transferStore.updateJob(job.id, { status: "running", kernelUrl: runUrl });
        } else if (runStatus === "completed") {
          const finalStatus = conclusion === "success" ? "complete" : "error";
          transferStore.updateJob(job.id, {
            status: finalStatus,
            kernelUrl: runUrl,
            completedAt: Date.now(),
            failureMessage: conclusion === "success" ? undefined : `GHA runner finished with: ${conclusion}`,
          });

          if (finalStatus === "complete") {
            if (
              job.destination?.toLowerCase().startsWith("telegram:") ||
              job.destination?.toLowerCase().startsWith("telegram-drive:") ||
              job.destination?.toLowerCase().startsWith("tg-")
            ) {
              import("./telegramOffload")
                .then((m) => m.reconcileTelegramDriveCatalog())
                .catch((e) => console.warn("Telegram Drive catalog reconciliation warning:", e));
            } else if (job.destination?.toLowerCase().startsWith("udrop:")) {
              import("./udrop")
                .then(async (m) => {
                  const fileName = (job.batchItems && job.batchItems[0]) || job.title || job.source.split("/").pop() || "";
                  const directUrl = await m.getUdropDirectLinkForFile(fileName);
                  if (directUrl) {
                    try {
                      await navigator.clipboard.writeText(directUrl);
                    } catch (_) {}
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
                })
                .catch((e) => console.warn("uDrop link auto-resolve warning:", e));
            }
            useToastStore.getState().addToast(`🎉 Cloud ${job.operation.toUpperCase()} completed on GitHub Actions: "${job.title}"!`, "success", 8000);
          } else {
            useToastStore.getState().addToast(`❌ Cloud ${job.operation.toUpperCase()} failed on GitHub Actions for "${job.title}".`, "error", 8000);
          }
        }
      }

      // Update transcode jobs
      for (const job of activeTranscodeGha) {
        const run = await lookupRun(job);
        if (!run) continue; // not correlated yet — do NOT guess from unrelated runs
        const runStatus = run.status;
        const conclusion = run.conclusion;
        const runUrl = run.htmlUrl;
        if (runStatus === "in_progress" && job.status !== "running") {
          transcodeStore.updateJob(job.id, { status: "running", kernelUrl: runUrl });
        } else if (runStatus === "completed") {
          const finalStatus = conclusion === "success" ? "complete" : "error";
          transcodeStore.updateJob(job.id, {
            status: finalStatus,
            kernelUrl: runUrl,
            completedAt: Date.now(),
            failureMessage: conclusion === "success" ? undefined : `GHA runner finished with: ${conclusion}`,
          });

          if (finalStatus === "complete") {
            if (
              job.destRemoteFolder?.toLowerCase().startsWith("telegram:") ||
              job.destRemoteFolder?.toLowerCase().startsWith("telegram-drive:") ||
              job.destRemoteFolder?.toLowerCase().startsWith("tg-")
            ) {
              import("./telegramOffload")
                .then((m) => m.reconcileTelegramDriveCatalog())
                .catch((e) => console.warn("Telegram Drive catalog reconciliation warning:", e));
            }
            useToastStore.getState().addToast(`🎉 Cloud Transcode completed on GitHub Actions: "${job.title}"!`, "success", 8000);
          } else {
            useToastStore.getState().addToast(`❌ Cloud Transcode failed on GitHub Actions for "${job.title}".`, "error", 8000);
          }
        }
      }
    } catch (e) {
      console.warn("Failed polling GitHub Actions workflow runs:", e);
    }
  }, 25000);
}

/**
 * High-level router that automatically executes a cloud operation on Kaggle or GHA.
 */
export async function dispatchCloudTask(params: {
  jobType: CloudJobType;
  payload: any;
  title?: string;
  providerOverride?: ProviderSelection;
}): Promise<{
  provider: CloudWorkerProvider;
  jobId: string;
  url: string;
  kernelSlug?: string;
  status: string;
  reason: string;
}> {
  if (
    (params.jobType === "video_transcode" || params.jobType === "rclone_transfer") &&
    typeof params.payload === "object" &&
    params.payload !== null
  ) {
    const { telegramConfig, streamtapeConfig } = useAppStore.getState();
    const dest = String(params.payload.dest_remote_folder || params.payload.destination || "").toLowerCase();
    if (dest.startsWith("telegram:") || dest.startsWith("telegram-drive:") || dest.startsWith("tg-")) {
      params.payload.telegram_bot_token = params.payload.telegram_bot_token || telegramConfig?.botToken?.trim() || undefined;
      params.payload.telegram_chat_id = params.payload.telegram_chat_id || telegramConfig?.chatId?.trim() || undefined;
      params.payload.telegram_api_id = params.payload.telegram_api_id || telegramConfig?.apiId?.trim() || undefined;
      params.payload.telegram_api_hash = params.payload.telegram_api_hash || telegramConfig?.apiHash?.trim() || undefined;
    }
    if (dest.startsWith("streamtape:")) {
      params.payload.streamtape_api_login = params.payload.streamtape_api_login || streamtapeConfig?.apiLogin?.trim() || undefined;
      params.payload.streamtape_api_key = params.payload.streamtape_api_key || streamtapeConfig?.apiKey?.trim() || undefined;
    }
  }

  // Telegram-as-Source resolution & chunking (GHA only; Copy only)
  const srcLower = String(params.payload?.source || params.payload?.source_input || "").toLowerCase();
  const isSourceTelegram =
    srcLower.startsWith("telegram:") ||
    srcLower.startsWith("telegram-drive:") ||
    srcLower.startsWith("tg-native:");
  if (isSourceTelegram && typeof params.payload === "object" && params.payload !== null) {
    if (params.payload.operation === "move" || params.payload.delete_original) {
      throw new Error("Moving files out of Telegram Drive is not supported yet — use Copy.");
    }
    const { ghaConfig, ghaAccounts, telegramConfig } = useAppStore.getState();
    const hasGha = Boolean(
      (ghaAccounts && ghaAccounts.some((a) => a.enabled !== false)) ||
        (ghaConfig?.enabled && ghaConfig?.token?.trim())
    );
    if (!hasGha) {
      throw new Error("Telegram Drive as a source requires the GitHub Actions worker.");
    }
    const { invoke } = await import("@tauri-apps/api/core");
    const tgEntries = await invoke<Array<{ msgId: number; chatId: string; relPath: string; name: string }>>(
      "telegram_resolve_source_entries",
      {
        sourcePath: params.payload.source || params.payload.source_input,
        batchItems: Array.isArray(params.payload.batch_items) ? params.payload.batch_items : null,
      }
    );
    params.payload.telegram_bot_token = params.payload.telegram_bot_token || telegramConfig?.botToken?.trim() || undefined;
    params.payload.telegram_chat_id = params.payload.telegram_chat_id || telegramConfig?.chatId?.trim() || undefined;
    params.payload.telegram_api_id = params.payload.telegram_api_id || telegramConfig?.apiId?.trim() || undefined;
    params.payload.telegram_api_hash = params.payload.telegram_api_hash || telegramConfig?.apiHash?.trim() || undefined;

    const CHUNK = 80;
    if (tgEntries.length > CHUNK) {
      const totalChunks = Math.ceil(tgEntries.length / CHUNK);
      let firstResult: {
        provider: CloudWorkerProvider;
        jobId: string;
        url: string;
        kernelSlug?: string;
        status: string;
        reason: string;
      } | null = null;
      for (let i = 0; i < totalChunks; i++) {
        const slice = tgEntries.slice(i * CHUNK, (i + 1) * CHUNK);
        const chunkPayload = {
          ...params.payload,
          telegram_source_items: slice.map((e) => [e.msgId, e.chatId, e.relPath]),
        };
        const res = await dispatchGitHubAction({ jobType: params.jobType, payload: chunkPayload });
        const ghaJobId = `gha-${Date.now()}-${i + 1}`;
        initGitHubActionsPoller();
        if (!firstResult) {
          firstResult = {
            provider: "github_actions",
            jobId: ghaJobId,
            kernelSlug: ghaJobId,
            url: res.runUrl,
            status: res.status,
            reason: `Telegram source chunked (${i + 1}/${totalChunks})`,
          };
        }
      }
      useToastStore.getState().addToast(`Started ${totalChunks} cloud jobs for ${tgEntries.length} files`, "info");
      return firstResult!;
    }
    params.payload.telegram_source_items = tgEntries.map((e) => [e.msgId, e.chatId, e.relPath]);
  }

  const picked = pickCloudWorkerProvider(params.providerOverride);
  const provider = isSourceTelegram ? "github_actions" : picked.provider;
  const reason = isSourceTelegram ? "Telegram source requires GitHub Actions worker" : picked.reason;

  if (provider === "github_actions") {
    const res = await dispatchGitHubAction({
      jobType: params.jobType,
      payload: params.payload,
    });
    const ghaJobId = `gha-${Date.now()}`;
    initGitHubActionsPoller();
    return {
      provider: "github_actions",
      jobId: ghaJobId,
      kernelSlug: ghaJobId,
      url: res.runUrl,
      status: res.status,
      reason,
    };
  }

  // Otherwise route to Kaggle
  switch (params.jobType) {
    case "rclone_transfer": {
      const res = await dispatchKaggleTransfer(params.payload as KaggleTransferRequest);
      return {
        provider: "kaggle",
        jobId: res.job_id,
        kernelSlug: res.kernel_slug,
        url: res.url,
        status: res.status,
        reason,
      };
    }
    case "video_transcode": {
      const res = await dispatchKaggleTranscode(params.payload as KaggleTranscodeRequest);
      return {
        provider: "kaggle",
        jobId: res.job_id,
        kernelSlug: res.kernel_slug,
        url: res.url,
        status: res.status,
        reason,
      };
    }
    case "whisper_align": {
      const res = await dispatchKaggleAlign(params.payload as KaggleAlignRequest);
      return {
        provider: "kaggle",
        jobId: res.job_id,
        kernelSlug: res.kernel_slug,
        url: res.url,
        status: res.status,
        reason,
      };
    }
    case "rd_torrent_seed": {
      const res = await dispatchKaggleRdSeed(params.payload as KaggleRdSeedRequest);
      return {
        provider: "kaggle",
        jobId: res.job_id,
        kernelSlug: res.kernel_slug,
        url: res.url,
        status: res.status,
        reason,
      };
    }
    default:
      throw new Error(`Unsupported job type: ${params.jobType} for Kaggle worker.`);
  }
}

