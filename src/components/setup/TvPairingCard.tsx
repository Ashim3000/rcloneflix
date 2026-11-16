import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { Tv, QrCode, Smartphone, Copy, Check, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { getLocalLanIp, generateQrSvg, TV_PAIRING_PORT } from "../../lib/tvPairing";
import { importAccessPassFromString, importAccessPass } from "../../lib/accessPass";
import { base64ToUint8Array } from "../../lib/accessPass";
import { useToastStore } from "../../store/toastStore";
import { useAppStore } from "../../store/appStore";

type Props = {
  onPaired: () => void;
  onManualPasteClick?: () => void;
};

export function TvPairingCard({ onPaired, onManualPasteClick }: Props) {
  const addToast = useToastStore((s) => s.addToast);
  const { setRcloneConfigContent, completeSetup } = useAppStore();

  const [localIp, setLocalIp] = useState<string>("Detecting...");
  const [pairingUrl, setPairingUrl] = useState<string>("");
  const [qrSvg, setQrSvg] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");

  const refreshIpAndQr = useCallback(async () => {
    const ip = await getLocalLanIp();
    setLocalIp(ip);
    const url = `http://${ip}:${TV_PAIRING_PORT}`;
    setPairingUrl(url);
    const svg = await generateQrSvg(url);
    setQrSvg(svg);
  }, []);

  useEffect(() => {
    refreshIpAndQr();
  }, [refreshIpAndQr]);

  // Handle incoming pairing payload from Android native bridge or window event
  const handlePairPayload = useCallback(
    async (payloadData: { type: string; payload: string; filename?: string }) => {
      setIsProcessing(true);
      setStatusMessage("Pairing data received from phone...");
      try {
        if (payloadData.type === "token") {
          setStatusMessage("Activating TV Pass token...");
          const res = await importAccessPassFromString(payloadData.payload);
          addToast(
            res.passType === "admin"
              ? `Admin TV Pass paired! Restored ${res.libraryCount} libraries & credentials.`
              : `Paired! Imported ${res.libraryCount} shared libraries.`,
            "success"
          );
          completeSetup();
          onPaired();
        } else if (payloadData.type === "pass") {
          setStatusMessage("Decrypting .rflix pass file...");
          const bytes = base64ToUint8Array(payloadData.payload);
          const res = await importAccessPass(bytes);
          addToast(
            res.passType === "admin"
              ? `Admin TV Pass paired! Restored ${res.libraryCount} libraries.`
              : `Paired! Imported ${res.libraryCount} shared libraries.`,
            "success"
          );
          completeSetup();
          onPaired();
        } else if (payloadData.type === "config") {
          setStatusMessage("Importing rclone.conf...");
          const rawConf = String(payloadData.payload || "");
          try {
            (window as any).AndroidBridge?.saveRcloneConfig?.(rawConf);
          } catch {}
          setRcloneConfigContent(rawConf);
          try {
            const parsed = await invoke<any[]>("parse_rclone_config", { content: rawConf });
            if (Array.isArray(parsed) && parsed.length > 0) {
              useAppStore.getState().setRemotes(parsed);
            }
          } catch {}
          addToast("rclone.conf paired successfully!", "success");
          onPaired();
        }
      } catch (err: any) {
        addToast(`Pairing failed: ${err?.message || "Invalid pass data"}`, "error");
        setIsProcessing(false);
        setStatusMessage("");
      }
    },
    [addToast, completeSetup, onPaired, setRcloneConfigContent]
  );

  // Hook into window global callback for Android WebView evaluation
  useEffect(() => {
    (window as any).onTvPairReceived = (data: any) => {
      void handlePairPayload(data);
    };

    const onCustomEvent = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail) {
        void handlePairPayload(customEvent.detail);
      }
    };
    window.addEventListener("tv-pair-received", onCustomEvent);

    return () => {
      delete (window as any).onTvPairReceived;
      window.removeEventListener("tv-pair-received", onCustomEvent);
    };
  }, [handlePairPayload]);

  const copyUrl = async () => {
    if (!pairingUrl) return;
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      addToast("Pairing URL copied to clipboard", "info");
    } catch {
      addToast("Could not copy URL automatically", "error");
    }
  };

  return (
    <div className="w-full bg-surface/60 border border-border/80 rounded-2xl p-6 sm:p-8 backdrop-blur-md shadow-2xl relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute -top-24 -right-24 w-72 h-72 bg-accent/10 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-6 border-b border-border/60">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center text-accent flex-shrink-0">
            <Tv size={26} />
          </div>
          <div>
            <h3 className="text-lg sm:text-xl font-display font-semibold text-bright tracking-wide flex items-center gap-2">
              PAIR FROM YOUR PHONE OR PC
              <span className="text-[10px] font-mono tracking-wider uppercase px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                TV Mode
              </span>
            </h3>
            <p className="text-subtle text-xs sm:text-sm mt-0.5">
              Zero typing required on TV. Scan or open the local link to upload your pass.
            </p>
          </div>
        </div>

        <button
          onClick={refreshIpAndQr}
          title="Refresh Network IP"
          className="self-start sm:self-auto btn-ghost p-2 text-subtle hover:text-bright"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Main Pairing Layout */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
        {/* QR Code Container */}
        <div className="flex flex-col items-center justify-center p-6 rounded-xl bg-black/40 border border-border/60 text-center relative group">
          {qrSvg ? (
            <div
              className="w-52 h-52 sm:w-60 sm:h-60 bg-white p-3 rounded-xl shadow-2xl flex items-center justify-center transition-transform group-hover:scale-[1.02]"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : (
            <div className="w-52 h-52 sm:w-60 sm:h-60 bg-surface/50 rounded-xl flex items-center justify-center text-subtle">
              <QrCode size={48} className="animate-pulse text-subtle/40" />
            </div>
          )}
          <p className="text-bright text-xs mt-3 flex items-center gap-1.5 font-semibold">
            <Smartphone size={16} className="text-accent" />
            Scan with your phone camera on Wi-Fi
          </p>
        </div>

        {/* Pairing Link & Instructions */}
        <div className="flex flex-col gap-4">
          <div className="space-y-2">
            <span className="text-subtle text-xs font-semibold uppercase tracking-wider">
              Step 1: Open on phone or computer browser
            </span>
            <div className="p-3.5 bg-black/80 border-2 border-accent/60 rounded-xl font-mono text-base sm:text-lg text-accent font-bold select-all break-all tracking-wide text-center sm:text-left shadow-lg">
              {pairingUrl || (localIp && localIp !== "Detecting..." ? `http://${localIp}:${TV_PAIRING_PORT}` : "Detecting Wi-Fi IP...")}
            </div>
            <p className="text-subtle text-xs leading-relaxed">
              Ensure your phone or PC is connected to the same Wi-Fi, then navigate to the address above.
            </p>
          </div>

          <div className="space-y-2">
            <span className="text-subtle text-xs font-semibold uppercase tracking-wider">
              Step 2: Upload pass
            </span>
            <div className="p-3 bg-black/30 border border-border/50 rounded-xl text-xs text-subtle leading-relaxed">
              Upload your <strong className="text-bright">.rflix pass file</strong> or paste the pass token. No password or passphrase is required.
            </div>
          </div>

          {onManualPasteClick && (
            <button
              onClick={onManualPasteClick}
              className="mt-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-border hover:border-accent/60 bg-panel hover:bg-panel/80 text-bright text-xs font-semibold transition-all"
            >
              <KeyRound size={14} className="text-accent" />
              Or Enter Pass Token Directly on TV
            </button>
          )}
        </div>
      </div>

      {/* Processing Overlay */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-void/90 backdrop-blur-md flex flex-col items-center justify-center gap-3 z-20"
          >
            <Loader2 size={36} className="text-accent animate-spin" />
            <p className="text-bright font-medium text-sm">{statusMessage}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
