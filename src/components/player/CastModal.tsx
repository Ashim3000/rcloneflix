import React, { useState, useEffect } from "react";
import {
  Cast,
  RefreshCw,
  Tv,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Square,
  X,
  Check,
  AlertCircle,
  Plus,
  Loader2,
} from "lucide-react";
import { useCastStore, type CastDevice, type CastMediaParams } from "../../lib/cast";

interface CastModalProps {
  isOpen: boolean;
  onClose: () => void;
  mediaToCast?: CastMediaParams;
}

export function CastModal({ isOpen, onClose, mediaToCast }: CastModalProps) {
  const {
    devices,
    selectedDevice,
    status,
    isScanning,
    scanDevices,
    addManualDevice,
    connect,
    disconnect,
    castMedia,
    play,
    pause,
    stop,
    setVolume,
    refreshStatus,
  } = useCastStore();

  const [manualIp, setManualIp] = useState("");
  const [manualName, setManualName] = useState("");
  const [connectingIp, setConnectingIp] = useState<string | null>(null);
  const [isCastingMedia, setIsCastingMedia] = useState(false);

  useEffect(() => {
    if (isOpen) {
      scanDevices();
      refreshStatus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleConnect = async (device: CastDevice) => {
    try {
      setConnectingIp(device.ip);
      await connect(device);
      if (mediaToCast) {
        setIsCastingMedia(true);
        await castMedia(mediaToCast);
        setIsCastingMedia(false);
      }
    } catch (e) {
      console.error("Cast connection failed:", e);
    } finally {
      setConnectingIp(null);
    }
  };

  const handleManualAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualIp.trim()) return;
    try {
      setConnectingIp(manualIp.trim());
      await addManualDevice(manualIp.trim(), manualName.trim() || undefined);
      setManualIp("");
      setManualName("");
      if (mediaToCast) {
        setIsCastingMedia(true);
        await castMedia(mediaToCast);
        setIsCastingMedia(false);
      }
    } catch (e) {
      console.error("Manual cast connection failed:", e);
    } finally {
      setConnectingIp(null);
    }
  };

  const handleCastCurrentMedia = async () => {
    if (!mediaToCast) return;
    setIsCastingMedia(true);
    try {
      await castMedia(mediaToCast);
    } catch (e) {
      console.error("Cast load failed:", e);
    } finally {
      setIsCastingMedia(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in font-body">
      <div className="bg-panel border border-border rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-surface/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/40 flex items-center justify-center text-accent">
              <Cast size={18} />
            </div>
            <div>
              <h2 className="text-sm font-heading font-semibold text-white">Cast to Device</h2>
              <p className="text-[11px] text-subtle">Stream video &amp; audio to Chromecast, Google TV &amp; smart speakers</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-white/10 text-white/50 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* Active Connected Device Card */}
          {status.connected && selectedDevice && (
            <div className="p-4 rounded-xl bg-accent/10 border border-accent/30 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs font-semibold text-white">Connected to {selectedDevice.name}</span>
                </div>
                <button
                  onClick={disconnect}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors font-medium"
                >
                  Disconnect
                </button>
              </div>

              {/* Currently Playing Info */}
              {status.title && (
                <div className="text-xs text-subtle truncate">
                  Now Playing: <span className="text-white font-medium">{status.title}</span> ({status.player_state})
                </div>
              )}

              {/* Quick Playback Controls */}
              <div className="flex items-center justify-between pt-2 border-t border-accent/20">
                <div className="flex items-center gap-2">
                  {status.player_state === "PLAYING" ? (
                    <button
                      onClick={pause}
                      className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
                      title="Pause"
                    >
                      <Pause size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={play}
                      className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
                      title="Play"
                    >
                      <Play size={14} />
                    </button>
                  )}
                  <button
                    onClick={stop}
                    className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
                    title="Stop"
                  >
                    <Square size={14} />
                  </button>
                </div>

                {/* Volume Slider */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setVolume(status.volume > 0 ? 0 : 0.8)}
                    className="text-white/60 hover:text-white"
                  >
                    {status.volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={status.volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    className="w-20 h-1 appearance-none bg-white/20 rounded-full cursor-pointer"
                  />
                </div>
              </div>

              {/* Cast Current Item Button */}
              {mediaToCast && (
                <button
                  onClick={handleCastCurrentMedia}
                  disabled={isCastingMedia}
                  className="w-full mt-2 py-2 px-3 rounded-lg bg-accent text-black font-semibold text-xs hover:bg-accent-hover transition-colors flex items-center justify-center gap-1.5 shadow-md"
                >
                  {isCastingMedia ? <Loader2 size={14} className="animate-spin" /> : <Cast size={14} />}
                  <span>{isCastingMedia ? "Loading on Chromecast…" : `Cast "${mediaToCast.title}"`}</span>
                </button>
              )}
            </div>
          )}

          {/* Discovered Devices List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-white uppercase tracking-wider font-mono">
                Available Devices ({devices.length})
              </h3>
              <button
                onClick={scanDevices}
                disabled={isScanning}
                className="text-[11px] text-accent hover:text-accent-hover flex items-center gap-1 transition-colors"
              >
                <RefreshCw size={11} className={isScanning ? "animate-spin" : ""} />
                <span>{isScanning ? "Scanning LAN…" : "Scan Network"}</span>
              </button>
            </div>

            {devices.length === 0 ? (
              <div className="p-6 rounded-xl bg-surface/30 border border-border text-center space-y-2">
                <Tv size={28} className="mx-auto text-subtle opacity-40" />
                <p className="text-xs text-subtle">
                  {isScanning
                    ? "Searching for Google Cast devices on your local network…"
                    : "No Google Cast devices found yet."}
                </p>
                <p className="text-[11px] text-subtle/70">
                  Ensure your TV, Chromecast, or speaker is powered on and connected to the same Wi-Fi / subnet.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {devices.map((d) => {
                  const isSelected = selectedDevice?.ip === d.ip && status.connected;
                  const isConnecting = connectingIp === d.ip;
                  return (
                    <div
                      key={d.id}
                      className={`p-3 rounded-xl border flex items-center justify-between transition-all ${
                        isSelected
                          ? "bg-accent/15 border-accent/40 shadow-sm"
                          : "bg-surface/40 hover:bg-surface/70 border-border/80"
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                            isSelected ? "bg-accent text-black" : "bg-white/10 text-white"
                          }`}
                        >
                          <Tv size={18} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-white truncate">{d.name}</p>
                          <p className="text-[10px] text-subtle font-mono truncate">
                            {d.model} &bull; {d.ip}:{d.port}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {isSelected ? (
                          <span className="text-[11px] text-accent font-semibold flex items-center gap-1 px-2.5 py-1 rounded bg-accent/20">
                            <Check size={12} /> Connected
                          </span>
                        ) : (
                          <button
                            onClick={() => handleConnect(d)}
                            disabled={isConnecting}
                            className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                          >
                            {isConnecting && <Loader2 size={12} className="animate-spin" />}
                            <span>{isConnecting ? "Connecting…" : "Connect"}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Add Device by Manual IP */}
          <div className="pt-2 border-t border-border/60">
            <details className="group">
              <summary className="cursor-pointer text-xs text-subtle hover:text-white transition-colors flex items-center justify-between select-none py-1">
                <span>Can't find device? Connect by IP directly</span>
                <span className="text-[10px] font-mono group-open:rotate-180 transition-transform">&darr;</span>
              </summary>
              <form onSubmit={handleManualAdd} className="mt-3 p-3 rounded-xl bg-surface/30 border border-border space-y-2.5">
                <p className="text-[11px] text-subtle">
                  If mDNS multicast is disabled across your Wi-Fi routers or VLANs, enter the device's IP address directly:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    placeholder="Device Name (e.g. Living Room TV)"
                    className="input-field text-xs"
                  />
                  <input
                    type="text"
                    value={manualIp}
                    onChange={(e) => setManualIp(e.target.value)}
                    placeholder="IP Address (e.g. 192.168.1.50)"
                    className="input-field text-xs font-mono"
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={!manualIp.trim() || connectingIp === manualIp.trim()}
                  className="btn-secondary text-xs py-1.5 px-3 w-full flex items-center justify-center gap-1"
                >
                  <Plus size={12} />
                  <span>Connect to IP</span>
                </button>
              </form>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}
