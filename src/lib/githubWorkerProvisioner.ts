import bundledWorkerYml from "../../.github/workflows/cloud_worker.yml?raw";
import { httpFetch } from "./httpFetch";

export const DEFAULT_GHA_WORKER_REPO = "rcloneflix-worker";
export const WORKFLOW_MANAGED_MARKER = "# rcloneflix-managed-workflow";

/** Thrown for conditions that must block a dispatch (e.g. public repo would leak secrets). */
export class WorkerSecurityError extends Error {}

// Per-session cache: owner/repo/workflowFile -> bundled blob sha already verified + branch
const verifiedCache = new Map<string, { sha: string; branch: string }>();

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function computeGitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const combined = new Uint8Array(header.byteLength + bytes.byteLength);
  combined.set(header, 0);
  combined.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", combined);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type ProvisionResult = {
  owner: string;
  repo: string;
  branch: string;
  workflowFile: string;
  createdRepo: boolean;
  updatedWorkflow: boolean;
  statusMessage: string;
};

export async function ensureGitHubWorkerReady(params: {
  token: string;
  owner?: string;
  repo?: string;
  branch?: string;
  workflowFile?: string;
  forceSync?: boolean;
  /** Explicit user opt-in to dispatch to an existing PUBLIC repo (see rev 3 note). Never applies to repos the app creates. */
  allowPublic?: boolean;
}): Promise<ProvisionResult> {
  const cleanToken = params.token.trim();
  if (!cleanToken) {
    throw new Error("GitHub Personal Access Token (PAT) is required.");
  }

  const ghHeaders: Record<string, string> = {
    Authorization: `Bearer ${cleanToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // 1. Resolve owner; inspect classic-PAT scopes (header is absent for fine-grained PATs)
  const userRes = await httpFetch("https://api.github.com/user", { headers: ghHeaders });
  if (!userRes.ok) {
    throw new Error(`GitHub authentication failed (HTTP ${userRes.status}). Check your PAT.`);
  }
  const scopesHeader = userRes.headers?.get?.("x-oauth-scopes") || "";
  const scopes = scopesHeader ? scopesHeader.split(",").map((s: string) => s.trim()) : [];
  const isClassic = scopes.length > 0;
  if (isClassic && !scopes.includes("repo")) {
    throw new Error(
      `Classic GitHub PAT is missing the 'repo' scope (found: "${scopesHeader}"). Enable 'repo' (and 'workflow' to let RcloneFlix install the worker workflow).`
    );
  }
  // Only required when we actually have to WRITE the workflow file. Dispatching needs just 'repo'.
  const canWriteWorkflow = !isClassic || scopes.includes("workflow");

  const userData = await userRes.json();
  const resolvedOwner = (params.owner?.trim() || userData?.login || "").trim();
  if (!resolvedOwner) {
    throw new Error("Could not determine GitHub username from PAT.");
  }

  const resolvedRepo = (params.repo?.trim() || DEFAULT_GHA_WORKER_REPO).trim();
  const isDefaultRepo = resolvedRepo.toLowerCase() === DEFAULT_GHA_WORKER_REPO;
  const workflowFile = (params.workflowFile?.trim() || "cloud_worker.yml").trim();
  const workflowBytes = new TextEncoder().encode(bundledWorkerYml);
  const localBlobSha = await computeGitBlobSha1(workflowBytes);
  const cacheKey = `${resolvedOwner}/${resolvedRepo}/${workflowFile}`;

  const cached = verifiedCache.get(cacheKey);
  if (!params.forceSync && cached && cached.sha === localBlobSha) {
    return {
      owner: resolvedOwner,
      repo: resolvedRepo,
      branch: params.branch?.trim() || cached.branch,
      workflowFile,
      createdRepo: false,
      updatedWorkflow: false,
      statusMessage: "Worker repository and workflow already verified for this session.",
    };
  }

  // 2. Ensure the repository exists and is private
  let createdRepo = false;
  let defaultBranch = params.branch?.trim() || "main";
  const repoRes = await httpFetch(`https://api.github.com/repos/${resolvedOwner}/${resolvedRepo}`, {
    headers: ghHeaders,
  });

  if (repoRes.status === 404) {
    const createRes = await httpFetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: resolvedRepo,
        private: true,
        auto_init: true,
        description: "RcloneFlix private cloud worker runner",
      }),
    });
    if (createRes.status === 422) {
      throw new Error(
        `Repository '${resolvedOwner}/${resolvedRepo}' already exists on GitHub, but your token cannot access it (HTTP 422). Use a Classic PAT with 'repo' + 'workflow' scopes, or grant your fine-grained PAT access to '${resolvedRepo}'.`
      );
    }
    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Failed to create private worker repo '${resolvedRepo}' (HTTP ${createRes.status}): ${errText}`);
    }
    const createdData = await createRes.json();
    defaultBranch = params.branch?.trim() || createdData?.default_branch || defaultBranch;
    createdRepo = true;
    await new Promise((r) => setTimeout(r, 1500));
  } else if (!repoRes.ok) {
    const errText = await repoRes.text();
    throw new Error(`Failed to inspect repository '${resolvedOwner}/${resolvedRepo}' (HTTP ${repoRes.status}): ${errText}`);
  } else {
    const repoData = await repoRes.json();
    if (repoData?.private !== true) {
      if (!params.allowPublic) {
        throw new WorkerSecurityError(
          `'${resolvedOwner}/${resolvedRepo}' is a PUBLIC repository. Cloud worker dispatch inputs contain your rclone and Telegram secrets and are visible to anyone on a public repo's Actions page. Make it private (private repos get 2,000 free Actions minutes/month), use '${DEFAULT_GHA_WORKER_REPO}', or enable "Allow public worker repo (I understand secrets will be visible)" in Settings.`
        );
      }
      console.warn(`[GHA] Dispatching to PUBLIC repo ${resolvedOwner}/${resolvedRepo} (explicitly allowed by the user).`);
    }
    defaultBranch = params.branch?.trim() || repoData?.default_branch || "main";
  }

  // 3. Compare the Git blob SHA of .github/workflows/{workflowFile}
  const contentsUrl = `https://api.github.com/repos/${resolvedOwner}/${resolvedRepo}/contents/.github/workflows/${workflowFile}`;
  const fileRes = await httpFetch(`${contentsUrl}?ref=${encodeURIComponent(defaultBranch)}`, {
    headers: ghHeaders,
  });

  let existingSha: string | undefined;
  if (fileRes.ok) {
    const fileData = await fileRes.json();
    existingSha = fileData?.sha;
    if (existingSha === localBlobSha) {
      verifiedCache.set(cacheKey, { sha: localBlobSha, branch: defaultBranch });
      return {
        owner: resolvedOwner,
        repo: resolvedRepo,
        branch: defaultBranch,
        workflowFile,
        createdRepo,
        updatedWorkflow: false,
        statusMessage: "Cloud worker workflow is up to date.",
      };
    }
    // Overwrite only app-managed workflows (default repo OR marker present) unless forced.
    let remoteHasMarker = false;
    try {
      if (fileData?.encoding === "base64" && typeof fileData?.content === "string") {
        remoteHasMarker = base64ToUtf8(fileData.content).includes(WORKFLOW_MANAGED_MARKER);
      }
    } catch {}
    const isManaged = isDefaultRepo || remoteHasMarker;
    if (!isManaged && !params.forceSync) {
      verifiedCache.set(cacheKey, { sha: localBlobSha, branch: defaultBranch });
      return {
        owner: resolvedOwner,
        repo: resolvedRepo,
        branch: defaultBranch,
        workflowFile,
        createdRepo: false,
        updatedWorkflow: false,
        statusMessage: `Using existing custom workflow in '${resolvedOwner}/${resolvedRepo}' (use Force Sync Workflow in Settings to overwrite).`,
      };
    }
  } else if (fileRes.status !== 404) {
    const errText = await fileRes.text();
    throw new Error(`Failed checking workflow file (HTTP ${fileRes.status}): ${errText}`);
  }

  // 4. Upsert .github/workflows/{workflowFile} (needs the 'workflow' scope on classic PATs)
  if (!canWriteWorkflow) {
    throw new Error(
      `Your classic GitHub PAT lacks the 'workflow' scope, which is required to install or update '.github/workflows/${workflowFile}'. Enable 'workflow' on the token (or install the file manually).`
    );
  }
  const putBody: Record<string, any> = {
    message: existingSha
      ? "chore: sync RcloneFlix cloud_worker.yml"
      : "feat: provision RcloneFlix cloud_worker.yml",
    content: bytesToBase64(workflowBytes),
    branch: defaultBranch,
  };
  if (existingSha) {
    putBody.sha = existingSha;
  }

  const putRes = await httpFetch(contentsUrl, {
    method: "PUT",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(putBody),
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    if (putRes.status === 403 || putRes.status === 404) {
      throw new Error(
        `GitHub rejected writing '.github/workflows/${workflowFile}' (HTTP ${putRes.status}). Ensure your PAT has the 'workflow' scope (classic) or 'Workflows: Read and write' + 'Contents: Read and write' (fine-grained).`
      );
    }
    throw new Error(`Failed uploading workflow file (HTTP ${putRes.status}): ${errText}`);
  }

  // 5. Poll until GitHub Actions indexes the workflow file (up to ~25 s)
  const wfMetaUrl = `https://api.github.com/repos/${resolvedOwner}/${resolvedRepo}/actions/workflows/${workflowFile}`;
  for (let i = 0; i < 12; i++) {
    const checkWf = await httpFetch(wfMetaUrl, { headers: ghHeaders });
    if (checkWf.ok) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  verifiedCache.set(cacheKey, { sha: localBlobSha, branch: defaultBranch });
  return {
    owner: resolvedOwner,
    repo: resolvedRepo,
    branch: defaultBranch,
    workflowFile,
    createdRepo,
    updatedWorkflow: true,
    statusMessage: createdRepo
      ? `Created private repo '${resolvedOwner}/${resolvedRepo}' and deployed ${workflowFile}.`
      : `Synced latest ${workflowFile} to '${resolvedOwner}/${resolvedRepo}'.`,
  };
}
