import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  X,
  FileCheck2,
  UploadCloud,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FolderDown,
  ShieldCheck,
  Film,
  KeyRound,
  Tv,
  Smartphone,
} from "lucide-react";
import {
  importAccessPass,
  importAccessPassFromString,
  base64ToUint8Array,
  type AccessPassType,
} from "../../lib/accessPass";
import { getLocalLanIp, generateQrSvg, TV_PAIRING_PORT } from "../../lib/tvPairing";
import { pickAccessPassFile, readLocalFileBytes } from "../../lib/tauri";
import { useToastStore } from "../../store/toastStore";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete?: () => void;
};

export function ImportAccessPassModal({ isOpen, onClose, onImportComplete }: Props) {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isImporting, setIsImporting] = useState(false);
  const [currentStep, setCurrentStep] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [passTokenInput, setPassTokenInput] = useState("");
  const [localIp, setLocalIp] = useState<string>("Detecting...");
  const [pairingUrl, setPairingUrl] = useState<string>("");
  const [qrSvg, setQrSvg] = useState<string>("");
  const [importResult, setImportResult] = useState<{
    passId: string;
    label: string;
    passType?: AccessPassType;
    libraryCount: number;
    itemCount: number;
    expiresAt?: number;
  } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    void getLocalLanIp().then(async (ip) => {
      setLocalIp(ip);
      const url = `http://${ip}:${TV_PAIRING_PORT}`;
      setPairingUrl(url);
      const svg = await generateQrSvg(url);
      setQrSvg(svg);
    });
  }, [isOpen]);

  const processBytes = useCallback(async (bytes: Uint8Array) => {
    setIsImporting(true);
    setErrorMsg("");
    setCurrentStep("Reading pass file...");

    try {
      const result = await importAccessPass(bytes, (msg) => {
        setCurrentStep(msg);
      });

      setImportResult(result);
      addToast(
        result.passType === "admin"
          ? `Admin TV Pass activated! Restored ${result.libraryCount} libraries and all credentials.`
          : `Imported ${result.libraryCount} shared libraries (${result.itemCount} items).`,
        "success"
      );
      onImportComplete?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      addToast(`Import failed: ${msg}`, "error");
    } finally {
      setIsImporting(false);
    }
  }, [addToast, onImportComplete]);

  const handlePasteActivate = useCallback(async (rawToken?: string) => {
    const token = (rawToken || passTokenInput).trim();
    if (!token) return;
    setIsImporting(true);
    setErrorMsg("");
    setCurrentStep("Decrypting pass token...");

    try {
      const result = await importAccessPassFromString(token, (msg) => {
        setCurrentStep(msg);
      });

      setImportResult(result);
      addToast(
        result.passType === "admin"
          ? `Admin TV Pass activated! Restored ${result.libraryCount} libraries and all credentials.`
          : `Imported ${result.libraryCount} shared libraries (${result.itemCount} items).`,
        "success"
      );
      onImportComplete?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      addToast(`Import failed: ${msg}`, "error");
    } finally {
      setIsImporting(false);
    }
  }, [passTokenInput, addToast, onImportComplete]);

  // Listen to incoming pairing payloads from TV pairing web server
  useEffect(() => {
    if (!isOpen) return;
    const onCustomEvent = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail) {
        const data = customEvent.detail;
        if (data.type === "token" && data.payload) {
          setPassTokenInput(data.payload);
          void handlePasteActivate(data.payload);
        } else if (data.type === "pass" && data.payload) {
          const bytes = base64ToUint8Array(data.payload);
          void processBytes(bytes);
        }
      }
    };
    window.addEventListener("tv-pair-received", onCustomEvent);
    return () => window.removeEventListener("tv-pair-received", onCustomEvent);
  }, [isOpen, handlePasteActivate, processBytes]);

  const handlePickFile = async () => {
    try {
      const path = await pickAccessPassFile();
      if (!path) return;
      const bytes = await readLocalFileBytes(path);
      await processBytes(bytes);
    } catch (err) {
      // If native dialog fails or isn't available, trigger browser file input
      fileInputRef.current?.click();
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      await processBytes(new Uint8Array(arrayBuffer));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (isImporting) return;

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      await processBytes(new Uint8Array(arrayBuffer));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
    }
  };

  const resetAndClose = () => {
    setImportResult(null);
    setErrorMsg("");
    setCurrentStep("");
    setPassTokenInput("");
    onClose();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-void/80 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2 }}
          className="relative w-full max-w-lg bg-surface border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-panel/60">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-accent/10 text-accent border border-accent/20">
                <FolderDown size={20} />
              </div>
              <div>
                <h2 className="font-display text-lg text-bright tracking-wide">
                  IMPORT RCLONEFLIX ACCESS PASS
                </h2>
                <p className="font-body text-xs text-subtle">
                  Instant shared library activation — no passwords required
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

          <div className="p-6 space-y-5">
            {importResult ? (
              <div className="space-y-5 text-center py-3">
                <div className="w-16 h-16 rounded-full bg-teal/10 border border-teal/20 text-teal flex items-center justify-center mx-auto">
                  <CheckCircle2 size={36} />
                </div>
                <div>
                  <h3 className="font-display text-xl text-bright">
                    {importResult.passType === "admin" ? "ADMIN TV SETUP COMPLETE!" : "SHARED LIBRARIES READY!"}
                  </h3>
                  <p className="font-body text-sm text-subtle mt-1">
                    Successfully activated <span className="text-text font-semibold">{importResult.label}</span>.
                  </p>
                </div>

                <div className="p-4 rounded-lg bg-panel/70 border border-border text-left space-y-2 font-body text-xs max-w-md mx-auto">
                  <div className="flex justify-between py-1 border-b border-white/5">
                    <span className="text-subtle">Pass Type:</span>
                    <span className="text-accent font-semibold capitalize">
                      {importResult.passType === "admin" ? "Admin TV Pass" : "Guest Pass"}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-white/5">
                    <span className="text-subtle">Libraries Added:</span>
                    <span className="text-bright font-semibold">{importResult.libraryCount}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-white/5">
                    <span className="text-subtle">Metadata Items Ingested:</span>
                    <span className="text-teal font-semibold">{importResult.itemCount} titles</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-subtle">Access Expiration:</span>
                    <span className="text-bright font-medium">
                      {importResult.expiresAt
                        ? new Date(importResult.expiresAt).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "Lifetime (Never Expires)"}
                    </span>
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => {
                      resetAndClose();
                      navigate("/movies");
                    }}
                    className="flex-1 py-2.5 rounded-lg bg-accent text-void font-body text-sm font-semibold hover:bg-accent-hover transition-colors shadow-accent-glow"
                  >
                    Browse Media
                  </button>
                  <button
                    onClick={resetAndClose}
                    className="px-5 py-2.5 rounded-lg bg-panel border border-border font-body text-sm font-medium text-subtle hover:text-text transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : isImporting ? (
              <div className="py-12 text-center space-y-4">
                <Loader2 size={40} className="text-accent animate-spin mx-auto" />
                <div className="space-y-1">
                  <h3 className="font-display text-lg text-bright">
                    ACTIVATING ACCESS PASS
                  </h3>
                  <p className="font-body text-xs text-accent font-medium">
                    {currentStep}
                  </p>
                </div>
                <p className="font-body text-[11px] text-subtle max-w-xs mx-auto">
                  Verifying single-use token, establishing scoped cloud credentials, and populating media metadata...
                </p>
              </div>
            ) : (
              <>
                {/* TV Wireless Phone Pairing Card */}
                <div className="p-4 rounded-xl bg-accent/10 border border-accent/30 space-y-3">
                  <div className="flex items-center gap-2 text-accent font-semibold text-xs uppercase tracking-wider">
                    <Smartphone size={15} />
                    <span>Send From Phone or PC (Zero Typing on TV)</span>
                  </div>
                  <div className="flex flex-col sm:flex-row items-center gap-4">
                    {qrSvg ? (
                      <div
                        className="w-24 h-24 sm:w-28 sm:h-28 bg-white p-1.5 rounded-lg shadow-md flex-shrink-0"
                        dangerouslySetInnerHTML={{ __html: qrSvg }}
                      />
                    ) : (
                      <div className="w-24 h-24 bg-surface rounded-lg flex items-center justify-center text-subtle flex-shrink-0">
                        <Tv size={28} className="animate-pulse" />
                      </div>
                    )}
                    <div className="space-y-1.5 text-xs text-left w-full">
                      <p className="text-subtle text-[11px]">
                        Scan QR with your phone camera, or open in your browser:
                      </p>
                      <div className="p-2 bg-black/60 border border-border rounded-lg font-mono text-xs sm:text-sm text-accent font-bold break-all select-all">
                        {pairingUrl || (localIp && localIp !== "Detecting..." ? `http://${localIp}:${TV_PAIRING_PORT}` : "Detecting Wi-Fi IP...")}
                      </div>
                      <p className="text-subtle text-[10px]">
                        Drop your <span className="text-bright font-mono">.rflix</span> file into the webpage to activate instantly.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Dropzone */}
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                  onClick={handlePickFile}
                  className="border-2 border-dashed border-border hover:border-accent/60 bg-panel/30 hover:bg-panel/60 rounded-xl p-6 text-center cursor-pointer transition-all space-y-2 group"
                >
                  <div className="w-12 h-12 rounded-full bg-accent/10 border border-accent/20 text-accent flex items-center justify-center mx-auto group-hover:scale-105 transition-transform">
                    <UploadCloud size={24} />
                  </div>
                  <div>
                    <p className="font-body text-sm font-medium text-bright">
                      Select or Drop your <span className="text-accent font-mono">.rflix</span> file here
                    </p>
                    <p className="font-body text-xs text-subtle mt-0.5">
                      Instant 1-Click activation — no passwords required
                    </p>
                  </div>
                  <button
                    type="button"
                    className="px-4 py-1.5 rounded-lg bg-panel border border-border font-body text-xs font-medium text-subtle group-hover:text-text transition-colors"
                  >
                    Browse Files
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={typeof window !== "undefined" && (window as any).AndroidBridge ? "*/*" : ".rflix,*/*"}
                    onChange={handleFileInputChange}
                    className="hidden"
                  />
                </div>

                {/* Or Paste Token String */}
                <div className="space-y-2 pt-2 border-t border-border">
                  <label className="block font-body text-xs font-semibold text-bright uppercase tracking-wider flex items-center gap-1.5">
                    <KeyRound size={13} className="text-accent" />
                    <span>Or Paste Pass Token Code</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={passTokenInput}
                      onChange={(e) => setPassTokenInput(e.target.value)}
                      placeholder="Paste base64 pass token string here..."
                      className="flex-1 px-3 py-2 bg-panel border border-border rounded-lg font-mono text-xs text-bright placeholder:text-subtle/40 focus:outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => handlePasteActivate()}
                      disabled={!passTokenInput.trim()}
                      className="px-4 py-2 bg-accent text-void rounded-lg font-body text-xs font-semibold hover:bg-accent-hover transition-colors disabled:opacity-40"
                    >
                      Activate
                    </button>
                  </div>
                </div>

                {/* Error Banner */}
                {errorMsg && (
                  <div className="p-3.5 rounded-lg bg-danger/10 border border-danger/30 flex items-start gap-3 text-danger font-body text-xs">
                    <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="font-semibold">Import Error: </span>
                      {errorMsg}
                    </div>
                  </div>
                )}

                {/* Info */}
                <div className="p-3.5 rounded-lg bg-panel/60 border border-border flex items-start gap-3">
                  <ShieldCheck size={18} className="text-teal flex-shrink-0 mt-0.5" />
                  <div className="font-body text-xs text-subtle space-y-1">
                    <p>
                      <span className="text-bright font-medium">Zero-Configuration Streaming:</span> The pass automatically mounts the grantor's cloud libraries and populates posters, overviews, and episode structures.
                    </p>
                    <p>
                      <span className="text-bright font-medium">Single-Use Token:</span> Each pass binds strictly to your device on first import and starts the access timer.
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
