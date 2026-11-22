import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, AlertTriangle, Trash2, Stethoscope, ShieldCheck, Copy, Loader2 } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { buildSanitizedDiagnostics } from "../../lib/diagnostics";
import { runLibraryDoctor, type DoctorReport } from "../../lib/versionHealth";

type AppCacheUsage = {
  artwork_bytes: number;
  photos_bytes: number;
  comic_cache_bytes: number;
  extract_bytes: number;
  catbox_temp_bytes: number;
};

type CacheBucket = "artwork" | "photos" | "comic_cache" | "extract" | "catbox_temp";

function fmtMb(bytes: number): string {
  if (!bytes) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DiagnosticsQolCards() {
  const {
    remotes,
    tmdbApiKey,
    thePornDbApiKey,
    stashBoxProviders,
    catboxConfig,
    ghaAccounts,
    kaggleAccounts,
  } = useAppStore();
  const addToast = useToastStore((s) => s.addToast);

  const [usage, setUsage] = useState<AppCacheUsage | null>(null);
  const [clearingBucket, setClearingBucket] = useState<CacheBucket | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const [doctorProgress, setDoctorProgress] = useState("");
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);

  const isDesktop = typeof window !== "undefined" && !(window as any).AndroidBridge;

  const loadUsage = useCallback(async () => {
    if (!isDesktop) return;
    try {
      const res = await invoke<AppCacheUsage>("get_app_cache_usage");
      setUsage(res);
    } catch {}
  }, [isDesktop]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const handleClearBucket = async (bucket: CacheBucket, label: string) => {
    setClearingBucket(bucket);
    try {
      const freed = await invoke<number>("clear_app_cache_bucket", { bucket });
      addToast(`Cleared ${label} (${fmtMb(freed)} freed)`, "success");
      await loadUsage();
    } catch (err: any) {
      addToast(`Failed clearing ${label}: ${err?.message || err}`, "error");
    } finally {
      setClearingBucket(null);
    }
  };

  const readinessItems = [
    { label: "Cloud Remotes", ok: remotes.length > 0, detail: `${remotes.length} configured` },
    { label: "TMDB API Key", ok: Boolean(tmdbApiKey?.trim()), detail: tmdbApiKey?.trim() ? "Configured" : "Not set" },
    {
      label: "Adult Metadata (Stash-Box / TPDB)",
      ok: Boolean(thePornDbApiKey?.trim() || (stashBoxProviders || []).some((p) => p.enabled)),
      detail: thePornDbApiKey?.trim() || (stashBoxProviders || []).some((p) => p.enabled) ? "Ready" : "Optional",
    },
    {
      label: "Cloud Workers (GHA / Kaggle)",
      ok: Boolean((ghaAccounts || []).some((w) => w.enabled !== false) || (kaggleAccounts || []).some((w) => w.enabled !== false)),
      detail: `${(ghaAccounts || []).filter((w) => w.enabled !== false).length} GHA • ${(kaggleAccounts || []).filter((w) => w.enabled !== false).length} Kaggle`,
    },
    {
      label: "Catbox.moe Offload",
      ok: Boolean(catboxConfig?.enabled),
      detail: catboxConfig?.enabled ? "Enabled" : "Disabled",
    },
  ];

  return (
    <div className="space-y-4">
      {/* System Readiness Checklist */}
      <div className="bg-panel border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-bright font-heading font-semibold text-sm">
            <ShieldCheck size={16} className="text-accent" />
            <span>System Readiness Checklist</span>
          </div>
          <button
            type="button"
            onClick={async () => {
              try {
                const bundle = await buildSanitizedDiagnostics();
                await navigator.clipboard.writeText(bundle);
                addToast("Sanitized diagnostics bundle copied to clipboard (secrets redacted)", "success");
              } catch (err: any) {
                addToast(`Could not copy diagnostics: ${err?.message || err}`, "error");
              }
            }}
            className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
          >
            <Copy size={13} />
            <span>Copy Sanitized Diagnostics</span>
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          {readinessItems.map((it) => (
            <div key={it.label} className="p-2.5 rounded-lg bg-surface border border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                {it.ok ? (
                  <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
                ) : (
                  <AlertTriangle size={14} className="text-amber-400 shrink-0" />
                )}
                <span className="text-bright">{it.label}</span>
              </div>
              <span className="text-subtle font-mono text-[11px]">{it.detail}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Storage & Cache Buckets (Excludes offline Travel Mode downloads) */}
      {isDesktop && usage && (
        <div className="bg-panel border border-border rounded-xl p-4 space-y-3">
          <div>
            <p className="font-heading font-semibold text-bright text-sm">Temporary Cache Buckets</p>
            <p className="text-xs text-subtle mt-0.5">
              Offline downloaded media (&quot;Travel Mode&quot;) is stored separately in your Downloads folder and is never deleted by cache clears.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            {(
              [
                { key: "artwork", label: "Poster & Artwork Cache", bytes: usage.artwork_bytes },
                { key: "photos", label: "Photo Thumbnail Cache", bytes: usage.photos_bytes },
                { key: "comic_cache", label: "Comic Page Cache", bytes: usage.comic_cache_bytes },
                { key: "extract", label: "Archive Extraction Scratch", bytes: usage.extract_bytes },
                { key: "catbox_temp", label: "Catbox Upload Scratch", bytes: usage.catbox_temp_bytes },
              ] as Array<{ key: CacheBucket; label: string; bytes: number }>
            ).map((b) => (
              <div key={b.key} className="p-2.5 rounded-lg bg-surface border border-border flex items-center justify-between gap-2">
                <div>
                  <p className="text-bright font-medium">{b.label}</p>
                  <p className="text-subtle font-mono text-[11px]">{fmtMb(b.bytes)}</p>
                </div>
                <button
                  type="button"
                  disabled={clearingBucket === b.key || b.bytes === 0}
                  onClick={() => handleClearBucket(b.key, b.label)}
                  className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1 disabled:opacity-40"
                >
                  {clearingBucket === b.key ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  <span>Clear</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Offline-Safe Library Doctor */}
      {isDesktop && (
        <div className="bg-panel border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-heading font-semibold text-bright text-sm flex items-center gap-2">
                <Stethoscope size={15} className="text-accent" />
                <span>Library Doctor (Offline-Safe Mirror Health Check)</span>
              </p>
              <p className="text-xs text-subtle mt-0.5">
                Verifies remote connectivity first so offline remotes are skipped safely. Requires 2+ consecutive 404s before flagging a mirror and never auto-deletes items.
              </p>
            </div>
            <button
              type="button"
              disabled={doctorBusy}
              onClick={async () => {
                setDoctorBusy(true);
                setDoctorProgress("Starting pre-flight remote checks...");
                try {
                  const rep = await runLibraryDoctor(undefined, setDoctorProgress);
                  setDoctorReport(rep);
                  addToast(`Library Doctor checked ${rep.checkedItems} multi-version items.`, "success");
                } catch (err: any) {
                  addToast(`Library Doctor failed: ${err?.message || err}`, "error");
                } finally {
                  setDoctorBusy(false);
                  setDoctorProgress("");
                }
              }}
              className="btn-secondary text-xs py-2 px-3.5 flex items-center gap-1.5 shrink-0 disabled:opacity-50"
            >
              {doctorBusy ? <Loader2 size={13} className="animate-spin" /> : <Stethoscope size={13} />}
              <span>{doctorBusy ? "Scanning…" : "Run Library Doctor"}</span>
            </button>
          </div>
          {doctorProgress && <p className="text-xs font-mono text-accent">{doctorProgress}</p>}
          {doctorReport && (
            <div className="p-2.5 rounded-lg bg-surface border border-border text-xs font-mono text-subtle flex flex-wrap gap-4">
              <span>Checked Items: <strong className="text-bright">{doctorReport.checkedItems}</strong></span>
              <span>Healthy Versions: <strong className="text-emerald-400">{doctorReport.healthyVersions}</strong></span>
              <span>Newly Flagged: <strong className="text-amber-400">{doctorReport.newlyFlaggedVersions}</strong></span>
              {doctorReport.skippedOfflineRemotes.length > 0 && (
                <span>Skipped Offline Remotes: <strong className="text-bright">{doctorReport.skippedOfflineRemotes.join(", ")}</strong></span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
