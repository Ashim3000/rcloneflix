import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Share2,
  ShieldCheck,
  Clock,
  HardDrive,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Download,
  Zap,
  Lock,
  Tv,
  Copy,
  Check,
} from "lucide-react";
import {
  useAppStore,
  type AccessPassDuration,
} from "../../store/appStore";
import {
  exportAccessPass,
  formatDuration,
  type AccessPassType,
} from "../../lib/accessPass";
import { useToastStore } from "../../store/toastStore";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export function CreateAccessPassModal({ isOpen, onClose }: Props) {
  const { libraries, mediaItems } = useAppStore();
  const addToast = useToastStore((s) => s.addToast);

  // Available local libraries (exclude any already-shared passes)
  const ownLibraries = libraries.filter((l) => !l.isSharedPass);

  const [passType, setPassType] = useState<AccessPassType>("guest");
  const [selectedLibIds, setSelectedLibIds] = useState<string[]>(
    ownLibraries.length > 0 ? [ownLibraries[0].id] : []
  );
  const [duration, setDuration] = useState<AccessPassDuration>("7d");
  const [label, setLabel] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [grantorLnurl, setGrantorLnurl] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [generatedPassId, setGeneratedPassId] = useState<string | null>(null);
  const [generatedPassString, setGeneratedPassString] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const toggleLibrary = (id: string) => {
    setSelectedLibIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleGenerate = async () => {
    if (passType === "guest" && selectedLibIds.length === 0) {
      addToast("Please select at least one library to share.", "error");
      return;
    }

    setIsGenerating(true);
    setStatusMsg(
      passType === "admin"
        ? "Packaging complete setup & encrypting Admin TV pass..."
        : "Preparing cloud snapshot & extracting scoped remotes..."
    );

    try {
      const res = await exportAccessPass({
        label: label.trim() || (passType === "admin" ? "Admin TV Pass" : "Shared Library"),
        duration: passType === "admin" ? "lifetime" : duration,
        libraryIds: passType === "admin" ? ownLibraries.map((l) => l.id) : selectedLibIds,
        grantorLnurl: passType === "admin" ? undefined : grantorLnurl.trim() || undefined,
        passType,
        guestEmail: passType === "admin" ? undefined : guestEmail.trim() || undefined,
      });

      setGeneratedPassId(res.passId);
      setGeneratedPassString(res.passString);
      addToast(
        passType === "admin"
          ? "Exported Admin TV Pass successfully."
          : `Exported pass with ${formatDuration(duration)} duration.`,
        "success"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(`Export failed: ${msg}`, "error");
    } finally {
      setIsGenerating(false);
      setStatusMsg("");
    }
  };

  const resetAndClose = () => {
    setGeneratedPassId(null);
    setGeneratedPassString(null);
    setStatusMsg("");
    setGuestEmail("");
    onClose();
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-void/80 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2 }}
          className="relative w-full max-w-xl bg-surface border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-panel/60">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-accent/10 text-accent border border-accent/20">
                {passType === "admin" ? <Tv size={20} /> : <Share2 size={20} />}
              </div>
              <div>
                <h2 className="font-display text-lg text-bright tracking-wide">
                  {passType === "admin" ? "CREATE ADMIN TV PASS" : "CREATE RCLONEFLIX ACCESS PASS"}
                </h2>
                <p className="font-body text-xs text-subtle">
                  {passType === "admin"
                    ? "Encrypted all-inclusive identity clone for your TV & devices"
                    : "Encrypted serverless 1-click sharing pass (.rflix)"}
                </p>
              </div>
            </div>
            <button
              onClick={resetAndClose}
              className="text-subtle hover:text-text p-1.5 rounded-lg hover:bg-white/5 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            {generatedPassId ? (
              <div className="space-y-5 text-center py-4">
                <div className="w-16 h-16 rounded-full bg-teal/10 border border-teal/20 text-teal flex items-center justify-center mx-auto">
                  <CheckCircle2 size={36} />
                </div>
                <div>
                  <h3 className="font-display text-xl text-bright">
                    {passType === "admin" ? "ADMIN TV PASS READY!" : "ACCESS PASS READY!"}
                  </h3>
                  <p className="font-body text-sm text-subtle mt-1 max-w-md mx-auto">
                    Your encrypted <span className="text-text font-mono">.rflix</span> pass has been created and saved to your device.
                  </p>
                </div>

                <div className="p-4 rounded-lg bg-panel/70 border border-border text-left space-y-2 max-w-md mx-auto font-body text-xs">
                  <div className="flex justify-between py-1 border-b border-white/5">
                    <span className="text-subtle">Pass ID:</span>
                    <span className="text-bright font-mono">{generatedPassId}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-white/5">
                    <span className="text-subtle">Type:</span>
                    <span className="text-accent font-semibold capitalize">{passType} Pass</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-white/5">
                    <span className="text-subtle">Validity:</span>
                    <span className="text-bright font-semibold">
                      {passType === "admin" ? "Lifetime (Personal Device)" : formatDuration(duration)}
                    </span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-subtle">Contents:</span>
                    <span className="text-bright">
                      {passType === "admin"
                        ? "All Remotes, Credentials & Libraries"
                        : `${selectedLibIds.length} shared libraries`}
                    </span>
                  </div>
                </div>

                {generatedPassString && (
                  <div className="space-y-1.5 max-w-md mx-auto text-left">
                    <div className="flex justify-between items-center text-xs text-subtle">
                      <span>Pass Token String (For TV Web Setup Portal):</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(generatedPassString);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                          addToast("Pass token copied to clipboard!", "success");
                        }}
                        className="flex items-center gap-1 text-accent hover:text-accent-hover font-medium transition-colors"
                      >
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        <span>{copied ? "Copied" : "Copy Token"}</span>
                      </button>
                    </div>
                    <div className="p-2.5 bg-void border border-border rounded-lg font-mono text-[10px] text-subtle truncate select-all">
                      {generatedPassString.slice(0, 50)}...
                    </div>
                  </div>
                )}

                <div className="p-3 bg-accent/5 border border-accent/20 rounded-lg text-left max-w-md mx-auto">
                  <p className="font-body text-xs text-subtle leading-relaxed">
                    {passType === "admin" ? (
                      <>
                        <span className="text-accent font-semibold">TV Setup Instructions:</span> Open RcloneFlix on your Android TV. On your phone, scan the on-screen QR code and upload this <span className="text-text font-mono">.rflix</span> file (or paste the token above). Your TV will instantly unlock your entire library!
                      </>
                    ) : (
                      <>
                        <span className="text-accent font-semibold">Instructions for your friend:</span> Send them the downloaded <span className="text-text font-mono">.rflix</span> file. They can simply open RcloneFlix and click <span className="text-text font-semibold">"Import Access Pass"</span> or drop the file into the app to start streaming immediately with zero passwords!
                      </>
                    )}
                  </p>
                </div>

                <button
                  onClick={resetAndClose}
                  className="w-full py-2.5 rounded-lg bg-accent text-void font-body text-sm font-semibold hover:bg-accent-hover transition-colors shadow-accent-glow"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                {/* Mode Selector Tabs */}
                <div className="flex rounded-lg bg-panel p-1 border border-border">
                  <button
                    type="button"
                    onClick={() => setPassType("guest")}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md font-body text-xs font-semibold transition-all ${
                      passType === "guest"
                        ? "bg-accent text-void shadow-sm"
                        : "text-subtle hover:text-text"
                    }`}
                  >
                    <Share2 size={14} />
                    <span>Guest Pass (Share)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPassType("admin")}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md font-body text-xs font-semibold transition-all ${
                      passType === "admin"
                        ? "bg-accent text-void shadow-sm"
                        : "text-subtle hover:text-text"
                    }`}
                  >
                    <Tv size={14} />
                    <span>Admin TV Pass (Clone)</span>
                  </button>
                </div>

                {passType === "admin" ? (
                  /* Admin Pass Explainer */
                  <div className="p-3.5 rounded-lg bg-accent/5 border border-accent/20 flex items-start gap-3">
                    <Tv size={20} className="text-accent flex-shrink-0 mt-0.5" />
                    <div className="font-body text-xs text-subtle space-y-1">
                      <p>
                        <span className="text-bright font-semibold">Full Personal Device & TV Clone:</span> Exports an all-inclusive encrypted pass with all your libraries, cloud remotes, Real-Debrid / Easynews keys, and Kaggle/GitHub worker credentials.
                      </p>
                      <p className="text-teal font-medium">
                        ✓ Ready to upload or paste into the Android TV setup web portal without typing passwords.
                      </p>
                    </div>
                  </div>
                ) : (
                  /* Security Highlights Banner for Guest */
                  <div className="p-3 rounded-lg bg-panel/70 border border-border flex items-start gap-3">
                    <ShieldCheck size={18} className="text-teal flex-shrink-0 mt-0.5" />
                    <div className="font-body text-xs text-subtle space-y-1">
                      <p>
                        <span className="text-bright font-medium">Serverless Direct-to-Cloud:</span> Your friend streams directly from your cloud provider (OpenDrive, Debrid, WebDAV). Your computer stays offline and your home IP is never exposed.
                      </p>
                      <p>
                        <span className="text-bright font-medium">Scoped Isolation:</span> Only the remotes required for the selected libraries are packaged. All private credentials and master passwords are stripped.
                      </p>
                    </div>
                  </div>
                )}

                {/* Library Selection (Guest only) */}
                {passType === "guest" && (
                  <div className="space-y-2">
                    <label className="block font-body text-xs font-semibold text-bright uppercase tracking-wider">
                      Select Libraries to Share
                    </label>
                    {ownLibraries.length === 0 ? (
                      <div className="p-4 rounded-lg bg-panel/40 border border-border text-center">
                        <p className="font-body text-xs text-subtle">
                          No libraries configured yet. Please configure a library first.
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                        {ownLibraries.map((lib) => {
                          const count = Object.values(mediaItems).filter(
                            (m) => m.libraryId === lib.id
                          ).length;
                          const isSelected = selectedLibIds.includes(lib.id);

                          return (
                            <div
                              key={lib.id}
                              onClick={() => toggleLibrary(lib.id)}
                              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                                isSelected
                                  ? "bg-accent/10 border-accent text-bright"
                                  : "bg-panel/40 border-border text-subtle hover:text-text hover:bg-panel/60"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {}}
                                className="accent-accent w-4 h-4 rounded cursor-pointer"
                              />
                              <div className="truncate flex-1">
                                <div className="font-body text-xs font-medium truncate text-bright">
                                  {lib.name}
                                </div>
                                <div className="font-body text-[11px] text-subtle flex items-center gap-1.5 mt-0.5">
                                  <span className="capitalize">{lib.type}</span>
                                  <span>·</span>
                                  <span>{count} items</span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Pass Duration (Guest only) */}
                {passType === "guest" && (
                  <div className="space-y-2">
                    <label className="block font-body text-xs font-semibold text-bright uppercase tracking-wider flex items-center justify-between">
                      <span>Access Duration</span>
                      <span className="font-normal normal-case text-subtle text-[11px]">
                        Starts at recipient's first import
                      </span>
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {(["1d", "7d", "60d", "lifetime"] as AccessPassDuration[]).map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setDuration(d)}
                        className={`py-2 px-3 rounded-lg border font-body text-xs font-medium transition-all ${
                          duration === d
                            ? "bg-accent text-void border-accent shadow-sm"
                            : "bg-panel/40 border-border text-subtle hover:text-text hover:bg-panel/60"
                        }`}
                      >
                        {formatDuration(d)}
                      </button>
                    ))}
                  </div>
                </div>
                )}

                {/* Optional Label */}
                <div className="space-y-1.5">
                  <label className="block font-body text-xs font-semibold text-bright uppercase tracking-wider">
                    Pass Label / Friend's Name (Optional)
                  </label>
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. For Alice / Ashim's Shared Library"
                    className="w-full px-3 py-2 bg-panel border border-border rounded-lg font-body text-xs text-bright placeholder:text-subtle/50 focus:outline-none focus:border-accent"
                  />
                </div>

                {/* Optional Guest Email for Expiry Reminders */}
                {passType === "guest" && (
                  <div className="space-y-1.5">
                    <label className="block font-body text-xs font-semibold text-bright uppercase tracking-wider">
                      Guest Email (Optional — For Expiry Reminders)
                    </label>
                    <input
                      type="email"
                      value={guestEmail}
                      onChange={(e) => setGuestEmail(e.target.value)}
                      placeholder="friend@example.com"
                      className="w-full px-3 py-2 bg-panel border border-border rounded-lg font-body text-xs text-bright placeholder:text-subtle/50 focus:outline-none focus:border-accent"
                    />
                  </div>
                )}

                {/* Optional LNURL Tipping */}
                <div className="space-y-1.5">
                  <label className="block font-body text-xs font-semibold text-bright uppercase tracking-wider flex items-center gap-1.5">
                    <Zap size={13} className="text-yellow-400" />
                    <span>Lightning Tip Address (Optional)</span>
                  </label>
                  <input
                    type="text"
                    value={grantorLnurl}
                    onChange={(e) => setGrantorLnurl(e.target.value)}
                    placeholder="e.g. yourname@getalby.com or LNURL..."
                    className="w-full px-3 py-2 bg-panel border border-border rounded-lg font-body text-xs text-bright placeholder:text-subtle/50 focus:outline-none focus:border-accent"
                  />
                  <p className="font-body text-[11px] text-subtle">
                    Allows your friend to send media requests or support you with $1+ tips directly in their app.
                  </p>
                </div>

                {/* Action button */}
                <div className="pt-2">
                  <button
                    onClick={handleGenerate}
                    disabled={isGenerating || selectedLibIds.length === 0}
                    className="w-full py-2.5 rounded-lg bg-accent text-void font-body text-sm font-semibold hover:bg-accent-hover transition-colors shadow-accent-glow disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        <span>{statusMsg || "Generating Pass..."}</span>
                      </>
                    ) : (
                      <>
                        <Download size={16} />
                        <span>Generate & Export .rflix Pass</span>
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
