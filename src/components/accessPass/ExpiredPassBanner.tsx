import { useState } from "react";
import { AlertTriangle, Trash2, Loader2, RefreshCw } from "lucide-react";
import { useAppStore, type Library } from "../../store/appStore";
import { removeSharedPass, refreshGuestPassStatus } from "../../lib/accessPass";
import { useToastStore } from "../../store/toastStore";

type Props = {
  library?: Library;
};

export function ExpiredPassBanner({ library }: Props) {
  const { libraries } = useAppStore();
  const addToast = useToastStore((s) => s.addToast);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  const expiredLibs = library
    ? library.isSharedPass && (library.isExpired || (library.expiresAt && Date.now() >= library.expiresAt))
      ? [library]
      : []
    : libraries.filter(
        (l) =>
          l.isSharedPass &&
          (l.isExpired || (l.expiresAt && Date.now() >= l.expiresAt))
      );

  if (expiredLibs.length === 0) return null;

  const target = expiredLibs[0];
  const passId = target.passId || "";

  const handleCheckExtension = async () => {
    if (!passId) return;
    setIsChecking(true);
    try {
      const restored = await refreshGuestPassStatus(passId);
      if (restored) {
        addToast(`Access pass "${target.name}" was extended by host! Streaming restored.`, "success");
      } else {
        addToast("Pass is still expired on host remote.", "info");
      }
    } finally {
      setIsChecking(false);
    }
  };

  const handleRemove = async () => {
    if (!passId) return;
    setIsRemoving(true);
    try {
      await removeSharedPass(passId);
      addToast("Cleaned up scoped remotes and cached metadata.", "info");
    } catch (err) {
      addToast(`Removal error: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setIsRemoving(false);
    }
  };

  const formattedDate = target.expiresAt
    ? new Date(target.expiresAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Recently";

  return (
    <div className="mx-6 my-4 p-4 rounded-xl bg-danger/10 border border-danger/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-danger/20 text-danger flex-shrink-0 mt-0.5 sm:mt-0">
          <AlertTriangle size={18} />
        </div>
        <div>
          <h4 className="font-display text-sm text-bright tracking-wide">
            SHARED ACCESS PASS EXPIRED
          </h4>
          <p className="font-body text-xs text-subtle mt-0.5">
            Access to <span className="text-text font-medium">{target.name}</span> granted by{" "}
            <span className="text-text font-medium">{target.grantorLabel || "host"}</span> expired on {formattedDate}.
            Streaming has been severed.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={handleCheckExtension}
          disabled={isChecking || isRemoving}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-panel border border-border text-bright hover:border-accent font-body text-xs font-semibold transition-colors disabled:opacity-50"
        >
          <RefreshCw size={13} className={isChecking ? "animate-spin text-accent" : "text-accent"} />
          <span>Check Extension</span>
        </button>

        <button
          onClick={handleRemove}
          disabled={isRemoving || isChecking}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-danger text-white hover:bg-danger/80 font-body text-xs font-semibold transition-colors disabled:opacity-50 shadow-sm"
        >
          {isRemoving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Trash2 size={14} />
          )}
          <span>Remove Expired Library (1-Click)</span>
        </button>
      </div>
    </div>
  );
}
