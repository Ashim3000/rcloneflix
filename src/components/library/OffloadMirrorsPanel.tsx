import { useState } from "react";
import { Copy, Check, Link2 } from "lucide-react";
import type { MediaItem } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { getDropmbExpirationStatus } from "../../lib/dropmbOffload";

type Mirror = { key: string; label: string; colorCls: string; url: string; badge?: string };

export function OffloadMirrorsPanel({ item }: { item: MediaItem }) {
  const addToast = useToastStore((s) => s.addToast);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const mirrors: Mirror[] = [];
  const seen = new Set<string>();
  const push = (m: Mirror) => {
    if (m.url && !seen.has(m.url)) {
      seen.add(m.url);
      mirrors.push(m);
    }
  };

  if (item.dropmbShareUrl) {
    push({
      key: "dropmb-share",
      label: "DropMB",
      colorCls: "bg-cyan-500/15 border-cyan-500/40 text-cyan-300",
      url: item.dropmbShareUrl,
      badge: getDropmbExpirationStatus(item.dropmbExpiresAt).label,
    });
  }
  for (const v of item.versions || []) {
    const rn = (v.remoteName || "").toLowerCase();
    const url = v.shareUrl || v.remotePath;
    if (rn.includes("dropmb")) {
      push({
        key: `dropmb-${v.id}`,
        label: "DropMB",
        colorCls: "bg-cyan-500/15 border-cyan-500/40 text-cyan-300",
        url,
        badge: getDropmbExpirationStatus(v.expiresAt ?? item.dropmbExpiresAt).label,
      });
    } else if (rn.includes("streamtape") || v.sourceType === "streamtape") {
      push({
        key: `st-${v.id}`,
        label: "Streamtape",
        colorCls: "bg-amber-500/15 border-amber-500/40 text-amber-300",
        url: v.shareUrl || url,
      });
    } else if (rn.includes("udrop")) {
      push({
        key: `ud-${v.id}`,
        label: "uDrop",
        colorCls: "bg-violet-500/15 border-violet-500/40 text-violet-300",
        url,
      });
    } else if (rn.includes("dood") || v.sourceType === "doodstream") {
      push({
        key: `dood-${v.id}`,
        label: "DoodStream",
        colorCls: "bg-rose-500/15 border-rose-500/40 text-rose-300",
        url: v.shareUrl || url,
      });
    } else if (rn.includes("telegram") || rn.includes("tg-") || v.sourceType === "telegram") {
      push({
        key: `tg-${v.id}`,
        label: "Telegram",
        colorCls: "bg-sky-500/15 border-sky-500/40 text-sky-300",
        url: v.telegramDirectUrl || url,
      });
    } else if (v.sourceType === "real-debrid") {
      push({
        key: `rd-${v.id}`,
        label: "Real-Debrid",
        colorCls: "bg-emerald-500/15 border-emerald-500/40 text-emerald-300",
        url,
      });
    }
  }

  if (mirrors.length === 0) return null;

  return (
    <div className="pt-2.5 border-t border-border/40 space-y-1.5">
      <span className="text-subtle/70 text-[10px] uppercase font-mono flex items-center gap-1.5">
        <Link2 size={10} /> Offload Mirrors &amp; Direct Links
      </span>
      {mirrors.map((m) => (
        <div key={m.key} className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1 flex items-center gap-2">
            <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono font-semibold shrink-0 ${m.colorCls}`}>
              {m.label}
            </span>
            <p className="text-text font-mono text-xs truncate" title={m.url}>{m.url}</p>
            {m.badge && <span className="text-[10px] text-subtle shrink-0">{m.badge}</span>}
          </div>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(m.url);
              setCopiedKey(m.key);
              addToast(`Copied ${m.label} link`, "success");
              setTimeout(() => setCopiedKey(null), 2000);
            }}
            className="btn-secondary text-xs py-1 px-2 flex items-center gap-1 shrink-0 cursor-pointer"
          >
            {copiedKey === m.key ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
          </button>
        </div>
      ))}
    </div>
  );
}
