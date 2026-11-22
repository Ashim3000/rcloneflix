import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  HardDrive,
  Layers,
  CopyCheck,
  RefreshCw,
  Trash2,
  Loader2,
  X,
  AlertTriangle,
  Wrench,
  FolderOpen,
} from "lucide-react";
import { useToastStore } from "../../store/toastStore";
import {
  isAndroidRuntime,
  fetchRemoteQuota,
  subscribeQuotaMutations,
  notifyRemoteMutated,
  formatQuotaBytes,
  getConfiguredAppTrashDir,
  fetchBestAvailableHashsum,
  runRcloneDedupe,
  runRcloneBisync,
  createUnionRemote,
  createCombineRemote,
  emptyProviderNativeTrash,
  emptyRcloneFlixAppTrash,
  type RcloneQuota,
} from "../../lib/rcloneNative";

export function VerifyChecksumButton({ fullPath }: { fullPath: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetchBestAvailableHashsum(fullPath);
          if (!res.supported) {
            useToastStore
              .getState()
              .addToast(
                res.error
                  ? "Provider returned an ERROR reading the cloud checksum for this file."
                  : "Provider does not store native MD5, SHA-1, or QuickXor checksums for this file (UNSUPPORTED).",
                "info"
              );
          } else {
            useToastStore
              .getState()
              .addToast(`Cloud ${res.algorithm.toUpperCase()}: ${res.hash}`, "success");
          }
        } catch (err: any) {
          useToastStore.getState().addToast(`Hashsum failed: ${err?.message || err}`, "error");
        } finally {
          setBusy(false);
        }
      }}
      className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 disabled:opacity-50"
    >
      {busy && <Loader2 size={13} className="animate-spin" />}
      <span>{busy ? "Checking Checksum…" : "Verify Cloud Checksum (MD5 / SHA-1 / QuickXor)"}</span>
    </button>
  );
}

export function VirtualRemoteCreateModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const [virtualKind, setVirtualKind] = useState<"union" | "combine">("union");
  const [virtualName, setVirtualName] = useState("");
  const [unionUpstreamsText, setUnionUpstreamsText] = useState("");
  const [combinePairsText, setCombinePairsText] = useState("");
  const [virtualBusy, setVirtualBusy] = useState(false);

  return createPortal(
    <div className="fixed inset-0 z-[10000] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-2xl w-full max-w-lg p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-bright">CREATE UNION OR COMBINE REMOTE</h3>
          <button onClick={onClose} className="text-subtle hover:text-bright">
            <X size={18} />
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setVirtualKind("union")}
            className={`flex-1 py-1.5 rounded-lg text-xs border ${
              virtualKind === "union"
                ? "bg-accent/15 border-accent text-accent"
                : "bg-panel border-border text-subtle"
            }`}
          >
            Union Pool (Merge Drives)
          </button>
          <button
            type="button"
            onClick={() => setVirtualKind("combine")}
            className={`flex-1 py-1.5 rounded-lg text-xs border ${
              virtualKind === "combine"
                ? "bg-accent/15 border-accent text-accent"
                : "bg-panel border-border text-subtle"
            }`}
          >
            Combine (Subfolder Tree)
          </button>
        </div>
        <div className="space-y-3 text-xs">
          <div>
            <label className="block text-subtle mb-1">
              New Virtual Remote Name (letters, numbers, _, - only)
            </label>
            <input
              type="text"
              value={virtualName}
              onChange={(e) => setVirtualName(e.target.value)}
              placeholder={virtualKind === "union" ? "my_union_pool" : "all_clouds"}
              className="input-field w-full text-xs font-mono"
            />
          </div>
          {virtualKind === "union" ? (
            <div>
              <label className="block text-subtle mb-1">
                Upstreams (one per line, e.g. gdrive1:Media)
              </label>
              <textarea
                rows={4}
                value={unionUpstreamsText}
                onChange={(e) => setUnionUpstreamsText(e.target.value)}
                placeholder={"gdrive1:Media\ngdrive2:Media"}
                className="input-field w-full text-xs font-mono"
              />
            </div>
          ) : (
            <div>
              <label className="block text-subtle mb-1">
                Folder Mappings (one per line: Alias=remote:path)
              </label>
              <textarea
                rows={4}
                value={combinePairsText}
                onChange={(e) => setCombinePairsText(e.target.value)}
                placeholder={"Movies=gdrive:Movies\nAnime=mega:Anime"}
                className="input-field w-full text-xs font-mono"
              />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={virtualBusy || !virtualName.trim()}
            onClick={async () => {
              setVirtualBusy(true);
              try {
                if (virtualKind === "union") {
                  const upstreams = unionUpstreamsText
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                  await createUnionRemote({
                    remoteName: virtualName.trim(),
                    upstreams,
                    actionPolicy: "epall",
                    createPolicy: "epmfs",
                  });
                } else {
                  const upstreams: Array<[string, string]> = combinePairsText
                    .split(/\r?\n/)
                    .map((line) => {
                      const idx = line.indexOf("=");
                      if (idx <= 0) return null;
                      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] as [
                        string,
                        string
                      ];
                    })
                    .filter(Boolean) as Array<[string, string]>;
                  await createCombineRemote({
                    remoteName: virtualName.trim(),
                    upstreams,
                  });
                }
                addToast(`Created ${virtualKind} remote "${virtualName.trim()}:"`, "success");
                onClose();
              } catch (err: any) {
                addToast(`Failed creating ${virtualKind} remote: ${err?.message || err}`, "error");
              } finally {
                setVirtualBusy(false);
              }
            }}
            className="btn-primary text-xs py-2 px-4 disabled:opacity-50"
          >
            {virtualBusy
              ? "Creating..."
              : `Create ${virtualKind === "union" ? "Union" : "Combine"} Remote`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function RcloneSuiteToolbar({
  selectedRemote,
  currentPath,
  isLocalRemote,
  onMutated,
}: {
  selectedRemote: string;
  currentPath: string;
  isLocalRemote: boolean;
  onMutated: () => void;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const [quota, setQuota] = useState<RcloneQuota | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);
  const [showDedupeModal, setShowDedupeModal] = useState(false);
  const [showBisyncModal, setShowBisyncModal] = useState(false);
  const [showVirtualModal, setShowVirtualModal] = useState(false);
  const [confirmTrashKind, setConfirmTrashKind] = useState<"app" | "provider" | null>(null);
  const [busyTrash, setBusyTrash] = useState(false);

  // Dedupe state
  const [dedupeMode, setDedupeMode] = useState<
    "newest" | "oldest" | "largest" | "smallest" | "rename" | "skip"
  >("newest");
  const [dedupeByHash, setDedupeByHash] = useState(false);
  const [dedupeOutput, setDedupeOutput] = useState<string | null>(null);
  const [dedupeBusy, setDedupeBusy] = useState(false);

  // Bisync state (dryRun defaults to true)
  const [bisyncLocalDir, setBisyncLocalDir] = useState("");
  const [bisyncConflict, setBisyncConflict] = useState<
    "newer" | "older" | "larger" | "smaller" | "path1" | "path2" | "none"
  >("newer");
  const [bisyncResync, setBisyncResync] = useState(false);
  const [bisyncDryRun, setBisyncDryRun] = useState(true);
  const [bisyncOutput, setBisyncOutput] = useState<string | null>(null);
  const [bisyncBusy, setBisyncBusy] = useState(false);

  const cleanRemote = selectedRemote.replace(/:.*$/, "").trim();
  const isShared = cleanRemote.toLowerCase().startsWith("shared_");
  const relFolder = currentPath.replace(/^[^:]*:/, "").replace(/^\/+/, "");
  const fullRemoteFolder = `${cleanRemote}:${relFolder}`;
  const trashDirName = getConfiguredAppTrashDir();

  // Close Rclone Tools menu on outside click or Escape key
  useEffect(() => {
    if (!showMenu) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowMenu(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showMenu]);

  // Invalidate stale dedupe preview whenever folder, mode, or byHash changes
  useEffect(() => {
    setDedupeOutput(null);
  }, [fullRemoteFolder, dedupeMode, dedupeByHash]);

  const reloadQuota = useCallback(
    (force = false) => {
      if (isAndroidRuntime() || !cleanRemote || isLocalRemote) {
        setQuota(null);
        return;
      }
      fetchRemoteQuota(cleanRemote, force)
        .then((q) => setQuota(q))
        .catch(() => setQuota(null));
    },
    [cleanRemote, isLocalRemote]
  );

  useEffect(() => {
    reloadQuota(false);
    const activeLower = cleanRemote.toLowerCase();
    return subscribeQuotaMutations((mutatedRemote) => {
      if (!mutatedRemote || mutatedRemote === activeLower) {
        reloadQuota(true);
      }
    });
  }, [reloadQuota, cleanRemote]);

  if (isAndroidRuntime() || !cleanRemote || isLocalRemote) return null;

  return (
    <>
      {quota?.supported && (quota.used != null || quota.free != null) && (
        <div
          className="px-2.5 py-1.5 rounded-xl bg-panel border border-border text-[11px] font-mono text-subtle flex items-center gap-2"
          title={`Used: ${formatQuotaBytes(quota.used)} / Total: ${formatQuotaBytes(
            quota.total
          )} • Free: ${formatQuotaBytes(quota.free)} • Provider Trash: ${formatQuotaBytes(
            quota.trashed
          )}`}
        >
          <HardDrive size={12} className="text-accent shrink-0" />
          <span>
            {formatQuotaBytes(quota.used)}
            {quota.total ? ` / ${formatQuotaBytes(quota.total)}` : ""}
            {quota.free != null ? ` (${formatQuotaBytes(quota.free)} free)` : ""}
          </span>
        </div>
      )}

      {!isShared && (
        <div ref={menuContainerRef} className="relative">
          <button
            type="button"
            onClick={() => setShowMenu((v) => !v)}
            className="px-3 py-1.5 rounded-xl bg-panel border border-border text-subtle hover:text-bright hover:border-accent/40 text-xs font-body flex items-center gap-1.5"
            title="Native Rclone tools (Dedupe, Bisync, Union/Combine, Trash)"
          >
            <Wrench size={13} className="text-accent" />
            <span>Rclone Tools ▾</span>
          </button>

          {showMenu && (
            <div className="absolute right-0 mt-1.5 w-60 rounded-xl bg-surface border border-border shadow-2xl py-1.5 z-50 text-xs">
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  setDedupeOutput(null);
                  setShowDedupeModal(true);
                }}
                className="w-full px-3.5 py-2 text-left text-subtle hover:text-bright hover:bg-panel flex items-center gap-2"
              >
                <CopyCheck size={13} className="text-accent" />
                <span>Dedupe Folder &amp; Subfolders…</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  setBisyncOutput(null);
                  setBisyncDryRun(true);
                  setShowBisyncModal(true);
                }}
                className="w-full px-3.5 py-2 text-left text-subtle hover:text-bright hover:bg-panel flex items-center gap-2"
              >
                <RefreshCw size={13} className="text-accent" />
                <span>Two-Way Sync (Bisync Beta)…</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  setShowVirtualModal(true);
                }}
                className="w-full px-3.5 py-2 text-left text-subtle hover:text-bright hover:bg-panel flex items-center gap-2"
              >
                <Layers size={13} className="text-accent" />
                <span>Create Union / Combine Remote…</span>
              </button>
              <div className="my-1 border-t border-border/60" />
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  setConfirmTrashKind("app");
                }}
                className="w-full px-3.5 py-2 text-left text-rose-300 hover:bg-panel flex items-center gap-2"
              >
                <Trash2 size={13} />
                <span>Empty RcloneFlix App Trash…</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  setConfirmTrashKind("provider");
                }}
                className="w-full px-3.5 py-2 text-left text-amber-300 hover:bg-panel flex items-center gap-2"
              >
                <Trash2 size={13} />
                <span>Empty Provider Native Trash…</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Trash Confirmation Modal */}
      {confirmTrashKind &&
        createPortal(
          <div className="fixed inset-0 z-[10000] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-surface border border-danger/40 rounded-2xl w-full max-w-md p-5 space-y-4 shadow-2xl">
              <div className="flex items-center gap-2 text-danger">
                <AlertTriangle size={20} />
                <h3 className="font-display text-lg text-bright">
                  {confirmTrashKind === "app"
                    ? "EMPTY RCLONEFLIX APP TRASH"
                    : "EMPTY CLOUD PROVIDER NATIVE TRASH"}
                </h3>
              </div>
              {confirmTrashKind === "app" ? (
                <p className="text-xs text-subtle leading-relaxed">
                  Permanently destroy all soft-deleted files inside{" "}
                  <strong className="text-bright font-mono">
                    {cleanRemote}:{trashDirName}
                  </strong>
                  ? This cannot be undone.
                </p>
              ) : (
                <p className="text-xs text-subtle leading-relaxed">
                  Run <code className="text-amber-300">rclone cleanup {cleanRemote}:</code> to
                  permanently empty the cloud provider&apos;s native trash bin on{" "}
                  <strong className="text-bright font-mono">{cleanRemote}:</strong>? This also
                  destroys items trashed outside RcloneFlix and cannot be undone.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={busyTrash}
                  onClick={() => setConfirmTrashKind(null)}
                  className="btn-secondary text-xs py-2 px-4"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busyTrash}
                  onClick={async () => {
                    setBusyTrash(true);
                    try {
                      if (confirmTrashKind === "app") {
                        await emptyRcloneFlixAppTrash(cleanRemote);
                        addToast(`Emptied RcloneFlix app trash on ${cleanRemote}:`, "success");
                        onMutated();
                      } else {
                        await emptyProviderNativeTrash(cleanRemote);
                        addToast(
                          `Emptied cloud provider trash (rclone cleanup) on ${cleanRemote}:`,
                          "success"
                        );
                      }
                      setConfirmTrashKind(null);
                    } catch (err: any) {
                      addToast(`Trash cleanup failed: ${err?.message || err}`, "error");
                    } finally {
                      setBusyTrash(false);
                    }
                  }}
                  className="px-4 py-2 rounded-xl bg-danger hover:bg-danger/80 text-white text-xs font-semibold flex items-center gap-1.5"
                >
                  {busyTrash && <Loader2 size={13} className="animate-spin" />}
                  <span>Permanently Empty Trash</span>
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Dedupe Modal */}
      {showDedupeModal &&
        createPortal(
          <div className="fixed inset-0 z-[10000] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-surface border border-border rounded-2xl w-full max-w-lg p-5 space-y-4 shadow-2xl">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-lg text-bright">
                  DEDUPE FOLDER &amp; SUBFOLDERS ({fullRemoteFolder})
                </h3>
                <button
                  onClick={() => setShowDedupeModal(false)}
                  className="text-subtle hover:text-bright"
                >
                  <X size={18} />
                </button>
              </div>
              <p className="text-xs text-subtle">
                Recursively scans <strong className="text-bright">{fullRemoteFolder}</strong> and
                all subfolders.{" "}
                {dedupeByHash
                  ? "Matching identical-content duplicates by native cloud checksum (--by-hash)."
                  : "Matching same-name duplicate files inside the same directory (e.g. Google Drive duplicate filenames)."}
              </p>
              <div className="space-y-3 text-xs">
                <label className="flex items-center gap-2 text-bright cursor-pointer">
                  <input
                    type="checkbox"
                    checked={dedupeByHash}
                    onChange={(e) => {
                      setDedupeByHash(e.target.checked);
                      setDedupeOutput(null);
                    }}
                  />
                  <span>Match by content checksum (--by-hash) instead of same filename</span>
                </label>
                <div>
                  <label className="block text-subtle mb-1">Resolution Mode</label>
                  <select
                    value={dedupeMode}
                    onChange={(e) => {
                      setDedupeMode(e.target.value as any);
                      setDedupeOutput(null);
                    }}
                    className="input-field w-full text-xs"
                  >
                    <option value="newest">Keep newest</option>
                    <option value="oldest">Keep oldest</option>
                    <option value="largest">Keep largest</option>
                    <option value="smallest">Keep smallest</option>
                    <option value="rename">Rename duplicates (keep all)</option>
                    <option value="skip">Skip (report only)</option>
                  </select>
                </div>
              </div>
              {dedupeOutput !== null && (
                <pre className="p-3 rounded-xl bg-panel border border-border text-[11px] font-mono text-subtle max-h-48 overflow-auto whitespace-pre-wrap">
                  {dedupeOutput || "No duplicates reported."}
                </pre>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={dedupeBusy}
                  onClick={async () => {
                    setDedupeBusy(true);
                    try {
                      const out = await runRcloneDedupe({
                        remotePath: fullRemoteFolder,
                        mode: dedupeMode,
                        byHash: dedupeByHash,
                        dryRun: true,
                      });
                      setDedupeOutput(out);
                    } catch (err: any) {
                      addToast(`Dedupe dry-run failed: ${err?.message || err}`, "error");
                    } finally {
                      setDedupeBusy(false);
                    }
                  }}
                  className="btn-secondary text-xs py-2 px-3"
                >
                  {dedupeBusy ? "Running..." : "1. Preview (--dry-run)"}
                </button>
                <button
                  type="button"
                  disabled={dedupeBusy || dedupeOutput === null}
                  onClick={async () => {
                    setDedupeBusy(true);
                    try {
                      const out = await runRcloneDedupe({
                        remotePath: fullRemoteFolder,
                        mode: dedupeMode,
                        byHash: dedupeByHash,
                        dryRun: false,
                      });
                      setDedupeOutput(out);
                      addToast("Dedupe completed.", "success");
                      notifyRemoteMutated(cleanRemote);
                      onMutated();
                    } catch (err: any) {
                      addToast(`Dedupe failed: ${err?.message || err}`, "error");
                    } finally {
                      setDedupeBusy(false);
                    }
                  }}
                  className="btn-primary text-xs py-2 px-3 disabled:opacity-50"
                >
                  2. Apply Dedupe
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Bisync Modal */}
      {showBisyncModal &&
        createPortal(
          <div className="fixed inset-0 z-[10000] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-surface border border-border rounded-2xl w-full max-w-lg p-5 space-y-4 shadow-2xl">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-lg text-bright">TWO-WAY SYNC — BISYNC (BETA)</h3>
                <button
                  onClick={() => setShowBisyncModal(false)}
                  className="text-subtle hover:text-bright"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2">
                <AlertTriangle size={14} className="shrink-0" />
                <span>
                  Always run a Dry-Run preview first. Bisync enforces a 50% max-delete safety cap.
                </span>
              </div>
              <div className="space-y-3 text-xs">
                <div>
                  <label className="block text-subtle mb-1">Local Directory Path</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={bisyncLocalDir}
                      onChange={(e) => setBisyncLocalDir(e.target.value)}
                      placeholder="/home/user/SyncFolder"
                      className="input-field flex-1 text-xs font-mono"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const picked = await openDialog({ directory: true, multiple: false });
                          if (typeof picked === "string" && picked.trim()) {
                            setBisyncLocalDir(picked.trim());
                          }
                        } catch {}
                      }}
                      className="btn-secondary text-xs px-3 flex items-center gap-1.5"
                    >
                      <FolderOpen size={13} />
                      <span>Browse…</span>
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-subtle mb-1">Remote Folder</label>
                  <input
                    type="text"
                    value={fullRemoteFolder}
                    readOnly
                    className="input-field w-full text-xs font-mono opacity-75"
                  />
                </div>
                <div>
                  <label className="block text-subtle mb-1">Conflict Resolution</label>
                  <select
                    value={bisyncConflict}
                    onChange={(e) => setBisyncConflict(e.target.value as any)}
                    className="input-field w-full text-xs"
                  >
                    <option value="newer">Keep newer file</option>
                    <option value="older">Keep older file</option>
                    <option value="larger">Keep larger file</option>
                    <option value="smaller">Keep smaller file</option>
                    <option value="path1">Prefer local (path1)</option>
                    <option value="path2">Prefer remote (path2)</option>
                    <option value="none">None (rename conflicts)</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 text-bright cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bisyncResync}
                    onChange={(e) => setBisyncResync(e.target.checked)}
                  />
                  <span>Initial Resync (--resync — merges both sides on first pairing)</span>
                </label>
                <label className="flex items-center gap-2 text-bright cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bisyncDryRun}
                    onChange={(e) => setBisyncDryRun(e.target.checked)}
                  />
                  <span>Dry-Run Preview Only (--dry-run)</span>
                </label>
              </div>
              {bisyncOutput !== null && (
                <pre className="p-3 rounded-xl bg-panel border border-border text-[11px] font-mono text-subtle max-h-48 overflow-auto whitespace-pre-wrap">
                  {bisyncOutput || "Bisync completed with no output."}
                </pre>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={bisyncBusy || !bisyncLocalDir.trim()}
                  onClick={async () => {
                    setBisyncBusy(true);
                    try {
                      const out = await runRcloneBisync({
                        localDir: bisyncLocalDir.trim(),
                        remoteDir: fullRemoteFolder,
                        resync: bisyncResync,
                        dryRun: bisyncDryRun,
                        conflictResolve: bisyncConflict,
                      });
                      setBisyncOutput(out);
                      if (!bisyncDryRun) {
                        setBisyncResync(false);
                        addToast("Bisync completed.", "success");
                        notifyRemoteMutated(cleanRemote);
                        onMutated();
                      }
                    } catch (err: any) {
                      addToast(`Bisync failed: ${err?.message || err}`, "error");
                    } finally {
                      setBisyncBusy(false);
                    }
                  }}
                  className="btn-primary text-xs py-2 px-4 disabled:opacity-50"
                >
                  {bisyncBusy
                    ? "Running..."
                    : bisyncDryRun
                    ? "Run Dry-Run Preview"
                    : "Execute Bisync"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Virtual Remote (Union / Combine) Modal */}
      {showVirtualModal && (
        <VirtualRemoteCreateModal onClose={() => setShowVirtualModal(false)} />
      )}
    </>
  );
}
