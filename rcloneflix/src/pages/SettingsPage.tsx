import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Eye, EyeOff, Save, Lock, EyeOff as HideIcon, CheckCircle2, AlertCircle, Trash2 } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { hashPin, verifyPin } from "../lib/pin";
import { ScanBar } from "../components/common/ScanBar";

type Section = "api-keys" | "libraries" | "adult" | "account";

export function SettingsPage() {
  const {
    tmdbApiKey, thePornDbApiKey, setTmdbApiKey, setThePornDbApiKey,
    rcloneConfigPath, libraries,
    adultSettings, setAdultHidden, setAdultPin, setAdultPinEnabled, clearAdultPin,
  } = useAppStore();

  const [section, setSection] = useState<Section>("api-keys");
  const [showTmdb, setShowTmdb] = useState(false);
  const [showPorndb, setShowPorndb] = useState(false);
  const [saved, setSaved] = useState(false);

  // PIN setup state
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinSuccess, setPinSuccess] = useState("");
  const [pinLength, setPinLength] = useState<4 | 5 | 6>(adultSettings.pinLength);

  const handleSaveKeys = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSetPin = async () => {
    setPinError("");
    setPinSuccess("");

    if (newPin.length !== pinLength) {
      setPinError(`PIN must be exactly ${pinLength} digits`);
      return;
    }
    if (!/^\d+$/.test(newPin)) {
      setPinError("PIN must contain only digits");
      return;
    }
    if (newPin !== confirmPin) {
      setPinError("PINs don't match");
      return;
    }

    // If changing existing PIN, verify current first
    if (adultSettings.pinEnabled && adultSettings.pinHash) {
      const ok = await verifyPin(currentPin, adultSettings.pinHash);
      if (!ok) {
        setPinError("Current PIN is incorrect");
        return;
      }
    }

    const hash = await hashPin(newPin);
    setAdultPin(hash, pinLength);
    setNewPin("");
    setConfirmPin("");
    setCurrentPin("");
    setPinSuccess("PIN set successfully");
    setTimeout(() => setPinSuccess(""), 3000);
  };

  const handleRemovePin = async () => {
    if (adultSettings.pinEnabled && adultSettings.pinHash && currentPin) {
      const ok = await verifyPin(currentPin, adultSettings.pinHash);
      if (!ok) {
        setPinError("Current PIN is incorrect");
        return;
      }
    }
    clearAdultPin();
    setCurrentPin("");
    setPinSuccess("PIN removed");
    setTimeout(() => setPinSuccess(""), 3000);
  };

  const SECTIONS: { id: Section; label: string }[] = [
    { id: "api-keys", label: "API Keys" },
    { id: "libraries", label: "Libraries" },
    { id: "adult", label: "Adult Content" },
    { id: "account", label: "Account & Sync" },
  ];

  return (
    <div className="flex flex-col h-full">
      <ScanBar />

      <div className="flex-1 flex overflow-hidden">
        {/* Settings sidebar */}
        <div className="w-48 border-r border-border flex-shrink-0 py-6 px-3 space-y-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`w-full text-left px-4 py-2.5 rounded-lg font-body text-sm transition-all ${
                section === s.id
                  ? "bg-panel text-accent border-l-2 border-accent"
                  : "text-subtle hover:text-text hover:bg-panel/50"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-8 py-6 max-w-2xl">
          <AnimatePresence mode="wait">

            {/* ── API Keys ── */}
            {section === "api-keys" && (
              <motion.div key="api" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <h2 className="font-display text-3xl text-bright tracking-wide mb-6">API KEYS</h2>

                <div className="space-y-5 mb-6">
                  <div>
                    <label className="text-text font-body text-sm font-medium block mb-2">
                      TMDB API Key <span className="text-accent text-xs">(Movies & TV)</span>
                    </label>
                    <div className="relative">
                      <input type={showTmdb ? "text" : "password"} value={tmdbApiKey}
                        onChange={(e) => setTmdbApiKey(e.target.value)}
                        className="input-field pr-12" placeholder="Enter TMDB API key" />
                      <button onClick={() => setShowTmdb(s => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-subtle hover:text-text">
                        {showTmdb ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-text font-body text-sm font-medium block mb-2">
                      ThePornDB API Key <span className="text-subtle text-xs">(Adult library, optional)</span>
                    </label>
                    <div className="relative">
                      <input type={showPorndb ? "text" : "password"} value={thePornDbApiKey}
                        onChange={(e) => setThePornDbApiKey(e.target.value)}
                        className="input-field pr-12" placeholder="Enter ThePornDB API key (optional)" />
                      <button onClick={() => setShowPorndb(s => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-subtle hover:text-text">
                        {showPorndb ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                </div>

                <motion.button onClick={handleSaveKeys} className="btn-primary flex items-center gap-2"
                  whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                  <Save size={16} />
                  {saved ? "Saved!" : "Save Keys"}
                </motion.button>
              </motion.div>
            )}

            {/* ── Libraries ── */}
            {section === "libraries" && (
              <motion.div key="libs" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <h2 className="font-display text-3xl text-bright tracking-wide mb-6">LIBRARIES</h2>
                <p className="text-subtle font-body text-sm mb-4">
                  Config file: <span className="font-mono text-xs text-text">{rcloneConfigPath || "Not set"}</span>
                </p>
                <div className="space-y-3">
                  {libraries.map((lib) => (
                    <div key={lib.id} className="bg-panel border border-border rounded-xl p-4">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-text font-body font-semibold text-sm">{lib.name}</span>
                        <span className="text-subtle font-mono text-xs bg-muted px-2 py-0.5 rounded">{lib.type}</span>
                      </div>
                      <p className="text-subtle font-mono text-xs truncate">{lib.remotePath}</p>
                    </div>
                  ))}
                  {libraries.length === 0 && (
                    <p className="text-subtle font-body text-sm">No libraries configured.</p>
                  )}
                </div>
              </motion.div>
            )}

            {/* ── Adult Content ── */}
            {section === "adult" && (
              <motion.div key="adult" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <h2 className="font-display text-3xl text-bright tracking-wide mb-6">ADULT CONTENT</h2>

                {/* Hide toggle */}
                <div className="bg-panel border border-border rounded-xl p-5 mb-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-text font-body font-semibold text-sm">Hide from sidebar</p>
                      <p className="text-subtle font-body text-xs mt-0.5">
                        Remove the Adult library from the navigation entirely
                      </p>
                    </div>
                    <button
                      onClick={() => setAdultHidden(!adultSettings.hidden)}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                        adultSettings.hidden ? "bg-accent" : "bg-muted"
                      }`}
                    >
                      <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
                        adultSettings.hidden ? "translate-x-6" : "translate-x-1"
                      }`} />
                    </button>
                  </div>
                </div>

                {/* PIN setup */}
                <div className="bg-panel border border-border rounded-xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Lock size={16} className="text-accent" />
                    <p className="text-text font-body font-semibold text-sm">
                      PIN Protection
                      {adultSettings.pinEnabled && (
                        <span className="ml-2 text-teal text-xs font-normal">· Enabled</span>
                      )}
                    </p>
                  </div>

                  {/* PIN length */}
                  <div className="mb-4">
                    <label className="text-subtle font-body text-xs mb-2 block">PIN Length</label>
                    <div className="flex gap-2">
                      {([4, 5, 6] as const).map((len) => (
                        <button key={len} onClick={() => setPinLength(len)}
                          className={`px-4 py-1.5 rounded-lg font-body text-sm border transition-all ${
                            pinLength === len ? "border-accent text-accent bg-accent/10" : "border-border text-subtle hover:border-subtle"
                          }`}>
                          {len} digits
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Current PIN (if changing) */}
                  {adultSettings.pinEnabled && (
                    <div className="mb-3">
                      <label className="text-subtle font-body text-xs mb-1.5 block">Current PIN</label>
                      <input type="password" value={currentPin} onChange={(e) => setCurrentPin(e.target.value)}
                        placeholder="Enter current PIN" maxLength={6} className="input-field w-48 text-center font-mono tracking-widest" />
                    </div>
                  )}

                  <div className="flex gap-3 mb-3">
                    <div>
                      <label className="text-subtle font-body text-xs mb-1.5 block">New PIN</label>
                      <input type="password" value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
                        placeholder={"·".repeat(pinLength)} maxLength={pinLength}
                        className="input-field w-32 text-center font-mono tracking-widest" />
                    </div>
                    <div>
                      <label className="text-subtle font-body text-xs mb-1.5 block">Confirm PIN</label>
                      <input type="password" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
                        placeholder={"·".repeat(pinLength)} maxLength={pinLength}
                        className="input-field w-32 text-center font-mono tracking-widest" />
                    </div>
                  </div>

                  {pinError && (
                    <div className="flex items-center gap-2 text-danger text-xs font-body mb-3">
                      <AlertCircle size={13} /> {pinError}
                    </div>
                  )}
                  {pinSuccess && (
                    <div className="flex items-center gap-2 text-teal text-xs font-body mb-3">
                      <CheckCircle2 size={13} /> {pinSuccess}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button onClick={handleSetPin} className="btn-primary flex items-center gap-2 text-sm py-2">
                      <Lock size={14} />
                      {adultSettings.pinEnabled ? "Change PIN" : "Set PIN"}
                    </button>
                    {adultSettings.pinEnabled && (
                      <button onClick={handleRemovePin} className="btn-secondary flex items-center gap-2 text-sm py-2 text-danger border-danger/30 hover:bg-danger/10">
                        <Trash2 size={14} />
                        Remove PIN
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {/* ── Account ── */}
            {section === "account" && (
              <motion.div key="account" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <h2 className="font-display text-3xl text-bright tracking-wide mb-6">ACCOUNT & SYNC</h2>
                <div className="bg-panel border border-border rounded-xl p-5">
                  <p className="text-subtle font-body text-sm">
                    Google account sync coming in Stage 5. Your play state and config
                    will sync to Google Drive automatically once connected.
                  </p>
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
