import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Eye, EyeOff, Save, Lock, CheckCircle2, AlertCircle, Trash2,
  Plus, Edit2, X, RefreshCw, Cloud, CloudOff, LogOut, Chrome,
} from "lucide-react";
import { useAppStore, type Library, type LibraryType } from "../store/appStore";
import { hashPin, verifyPin } from "../lib/pin";
import { ScanBar } from "../components/common/ScanBar";
import { scanAllLibraries } from "../lib/scanner";
import { backupToDrive, restoreFromDrive, startGoogleSignIn } from "../lib/sync";
import { RemoteBrowser } from "../components/common/RemoteBrowser";

type Section = "api-keys" | "libraries" | "adult" | "sync" | "scan";

const LIBRARY_TYPES: { value: LibraryType; label: string }[] = [
  { value: "movies", label: "Movies" },
  { value: "tv", label: "TV Shows" },
  { value: "music", label: "Music" },
  { value: "audiobooks", label: "Audiobooks" },
  { value: "books", label: "Books" },
  { value: "adult", label: "Adult" },
];

export function SettingsPage() {
  const {
    tmdbApiKey, thePornDbApiKey, setTmdbApiKey, setThePornDbApiKey,
    libraries, addLibrary, removeLibrary, updateLibrary,
    rcloneConfigPath, remotes,
    adultSettings, setAdultHidden, setAdultPin, clearAdultPin,
    googleAccount, setGoogleAccount, syncState,
  } = useAppStore();

  const [section, setSection] = useState<Section>("api-keys");
  const [showTmdb, setShowTmdb] = useState(false);
  const [showPorndb, setShowPorndb] = useState(false);
  const [savedKeys, setSavedKeys] = useState(false);

  // PIN state
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [pinLength, setPinLength] = useState<4|5|6>(adultSettings.pinLength);
  const [pinError, setPinError] = useState("");
  const [pinSuccess, setPinSuccess] = useState("");

  // Library edit state
  const [editingLib, setEditingLib] = useState<Library | null>(null);
  const [newLib, setNewLib] = useState<{ name: string; type: LibraryType; remotePath: string } | null>(null);
  const [showBrowserFor, setShowBrowserFor] = useState<"edit" | "new" | null>(null);

  // Sync state
  const [syncMsg, setSyncMsg] = useState("");

  const handleSaveKeys = () => {
    setSavedKeys(true);
    setTimeout(() => setSavedKeys(false), 2000);
  };

  const handleSetPin = async () => {
    setPinError(""); setPinSuccess("");
    if (newPin.length !== pinLength) { setPinError(`PIN must be exactly ${pinLength} digits`); return; }
    if (!/^\d+$/.test(newPin)) { setPinError("PIN must contain only digits"); return; }
    if (newPin !== confirmPin) { setPinError("PINs don't match"); return; }
    if (adultSettings.pinEnabled && adultSettings.pinHash) {
      const ok = await verifyPin(currentPin, adultSettings.pinHash);
      if (!ok) { setPinError("Current PIN is incorrect"); return; }
    }
    const hash = await hashPin(newPin);
    setAdultPin(hash, pinLength);
    setNewPin(""); setConfirmPin(""); setCurrentPin("");
    setPinSuccess("PIN set successfully");
    setTimeout(() => setPinSuccess(""), 3000);
  };

  const handleAddLibrary = () => {
    if (!newLib) return;
    const id = `lib-${Date.now()}`;
    addLibrary({ id, ...newLib });
    setNewLib(null);
  };

  const handleSaveLibEdit = () => {
    if (!editingLib) return;
    updateLibrary(editingLib.id, { name: editingLib.name, type: editingLib.type, remotePath: editingLib.remotePath });
    setEditingLib(null);
  };

  const handleBackup = async () => {
    setSyncMsg("Backing up...");
    try {
      await backupToDrive();
      setSyncMsg("✓ Backup complete");
    } catch (e) { setSyncMsg(`Error: ${String(e)}`); }
    setTimeout(() => setSyncMsg(""), 3000);
  };

  const handleRestore = async () => {
    setSyncMsg("Restoring...");
    try {
      const backup = await restoreFromDrive();
      setSyncMsg(backup ? "✓ Config restored from Drive" : "No backup found");
    } catch (e) { setSyncMsg(`Error: ${String(e)}`); }
    setTimeout(() => setSyncMsg(""), 4000);
  };

  const handleSignOut = () => {
    setGoogleAccount(null);
  };

  const SECTIONS: { id: Section; label: string }[] = [
    { id: "api-keys", label: "API Keys" },
    { id: "libraries", label: "Libraries" },
    { id: "scan", label: "Scanning" },
    { id: "adult", label: "Adult Content" },
    { id: "sync", label: "Google Sync" },
  ];

  return (
    <div className="flex flex-col h-full">
      <ScanBar />
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-48 border-r border-border flex-shrink-0 py-6 px-3 space-y-1">
          {SECTIONS.map((s) => (
            <button key={s.id} onClick={() => setSection(s.id)}
              className={`w-full text-left px-4 py-2.5 rounded-lg font-body text-sm transition-all ${
                section === s.id ? "bg-panel text-accent border-l-2 border-accent pl-3.5" : "text-subtle hover:text-text hover:bg-panel/50"
              }`}>
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
                      TMDB API Key <span className="text-accent text-xs">· required for Movies & TV</span>
                    </label>
                    <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer"
                      className="text-accent text-xs hover:underline block mb-2">
                      Get a free key at themoviedb.org →
                    </a>
                    <div className="relative">
                      <input type={showTmdb ? "text" : "password"} value={tmdbApiKey}
                        onChange={(e) => setTmdbApiKey(e.target.value)}
                        className="input-field pr-12" placeholder="Enter TMDB Read Access Token" />
                      <button onClick={() => setShowTmdb(s => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-subtle hover:text-text">
                        {showTmdb ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-text font-body text-sm font-medium block mb-2">
                      ThePornDB API Key <span className="text-subtle text-xs">· optional, Adult library only</span>
                    </label>
                    <div className="relative">
                      <input type={showPorndb ? "text" : "password"} value={thePornDbApiKey}
                        onChange={(e) => setThePornDbApiKey(e.target.value)}
                        className="input-field pr-12" placeholder="Optional" />
                      <button onClick={() => setShowPorndb(s => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-subtle hover:text-text">
                        {showPorndb ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                </div>
                <button onClick={handleSaveKeys} className="btn-primary flex items-center gap-2">
                  <Save size={16} />
                  {savedKeys ? "Saved!" : "Save Keys"}
                </button>
              </motion.div>
            )}

            {/* ── Libraries ── */}
            {section === "libraries" && (
              <motion.div key="libs" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <div className="flex items-center justify-between mb-6">
                  <h2 className="font-display text-3xl text-bright tracking-wide">LIBRARIES</h2>
                  <button onClick={() => setNewLib({ name: "", type: "movies", remotePath: "" })}
                    className="btn-secondary flex items-center gap-2 text-sm py-2">
                    <Plus size={14} /> Add Library
                  </button>
                </div>

                <p className="text-subtle font-body text-xs mb-4">
                  Config: <span className="font-mono text-text">{rcloneConfigPath || "Not set"}</span>
                </p>

                {/* Add new library form */}
                {newLib && (
                  <div className="bg-panel border border-accent/30 rounded-xl p-4 mb-4">
                    <p className="text-accent font-body text-xs font-semibold uppercase tracking-wider mb-3">New Library</p>
                    <div className="space-y-3">
                      <input value={newLib.name} onChange={(e) => setNewLib({ ...newLib, name: e.target.value })}
                        placeholder="Library name" className="input-field text-sm" />
                      <select value={newLib.type}
                        onChange={(e) => setNewLib({ ...newLib, type: e.target.value as LibraryType })}
                        className="input-field text-sm">
                        {LIBRARY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <div className="flex items-center gap-2">
                        <select
                          value={newLib.remotePath.split(":")[0] ?? ""}
                          onChange={(e) => setNewLib({ ...newLib, remotePath: e.target.value ? `${e.target.value}:` : "" })}
                          className="input-field text-sm flex-shrink-0 w-40"
                        >
                          <option value="">Remote…</option>
                          {remotes.map((r) => (
                            <option key={r.name} value={r.name}>{r.name} ({r.type})</option>
                          ))}
                        </select>
                        <div className="flex-1 flex items-center gap-2 bg-panel border border-border rounded-lg px-3 py-2 min-w-0">
                          <span className="font-mono text-xs text-text flex-1 truncate">
                            {newLib.remotePath
                              ? (newLib.remotePath.split(":")[1] || <span className="text-subtle italic">/ root</span>)
                              : <span className="text-subtle italic">select a remote first</span>}
                          </span>
                          <button
                            type="button"
                            onClick={() => setShowBrowserFor("new")}
                            disabled={!newLib.remotePath}
                            className="text-accent hover:text-accent-glow text-xs font-body font-semibold transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                          >
                            Browse
                          </button>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={handleAddLibrary} disabled={!newLib.name || !newLib.remotePath}
                          className="btn-primary text-sm py-2 disabled:opacity-50">Add</button>
                        <button onClick={() => setNewLib(null)} className="btn-secondary text-sm py-2">Cancel</button>
                      </div>
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  {libraries.map((lib) => (
                    <div key={lib.id} className="bg-panel border border-border rounded-xl p-4">
                      {editingLib?.id === lib.id ? (
                        <div className="space-y-3">
                          <input value={editingLib.name}
                            onChange={(e) => setEditingLib({ ...editingLib, name: e.target.value })}
                            className="input-field text-sm" />
                          <div className="flex items-center gap-2">
                            <select
                              value={editingLib.remotePath.split(":")[0] ?? ""}
                              onChange={(e) => setEditingLib({ ...editingLib, remotePath: e.target.value ? `${e.target.value}:` : "" })}
                              className="input-field text-sm flex-shrink-0 w-40"
                            >
                              <option value="">Remote…</option>
                              {remotes.map((r) => (
                                <option key={r.name} value={r.name}>{r.name} ({r.type})</option>
                              ))}
                            </select>
                            <div className="flex-1 flex items-center gap-2 bg-panel border border-border rounded-lg px-3 py-2 min-w-0">
                              <span className="font-mono text-xs text-text flex-1 truncate">
                                {editingLib.remotePath.split(":")[1] || <span className="text-subtle italic">/ root</span>}
                              </span>
                              <button
                                type="button"
                                onClick={() => setShowBrowserFor("edit")}
                                disabled={!editingLib.remotePath}
                                className="text-accent hover:text-accent-glow text-xs font-body font-semibold transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                              >
                                Browse
                              </button>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={handleSaveLibEdit} className="btn-primary text-sm py-2">Save</button>
                            <button onClick={() => setEditingLib(null)} className="btn-secondary text-sm py-2">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-text font-body font-semibold text-sm">{lib.name}</span>
                              <span className="text-subtle font-mono text-xs bg-muted px-2 py-0.5 rounded">{lib.type}</span>
                            </div>
                            <p className="text-subtle font-mono text-xs truncate max-w-sm">{lib.remotePath}</p>
                          </div>
                          <div className="flex gap-2 ml-4">
                            <button onClick={() => setEditingLib(lib)}
                              className="text-subtle hover:text-text transition-colors p-1.5 rounded hover:bg-muted">
                              <Edit2 size={14} />
                            </button>
                            <button onClick={() => removeLibrary(lib.id)}
                              className="text-subtle hover:text-danger transition-colors p-1.5 rounded hover:bg-danger/10">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  {libraries.length === 0 && (
                    <p className="text-subtle font-body text-sm">No libraries configured yet.</p>
                  )}
                </div>

                {/* Path browser for editing an existing library */}
                {showBrowserFor === "edit" && editingLib && (() => {
                  const remoteName = editingLib.remotePath.split(":")[0];
                  const remote = remotes.find((r) => r.name === remoteName);
                  return remote ? (
                    <RemoteBrowser
                      remoteName={remote.name}
                      remoteType={remote.type}
                      rcloneConfigPath={rcloneConfigPath}
                      initialPath={editingLib.remotePath}
                      onSelect={(path) => { setEditingLib({ ...editingLib, remotePath: path }); setShowBrowserFor(null); }}
                      onClose={() => setShowBrowserFor(null)}
                    />
                  ) : null;
                })()}

                {/* Path browser for adding a new library */}
                {showBrowserFor === "new" && newLib && (() => {
                  const remoteName = newLib.remotePath.split(":")[0];
                  const remote = remotes.find((r) => r.name === remoteName);
                  return remote ? (
                    <RemoteBrowser
                      remoteName={remote.name}
                      remoteType={remote.type}
                      rcloneConfigPath={rcloneConfigPath}
                      initialPath={newLib.remotePath}
                      onSelect={(path) => { setNewLib({ ...newLib, remotePath: path }); setShowBrowserFor(null); }}
                      onClose={() => setShowBrowserFor(null)}
                    />
                  ) : null;
                })()}
              </motion.div>
            )}

            {/* ── Scanning ── */}
            {section === "scan" && (
              <motion.div key="scan" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <h2 className="font-display text-3xl text-bright tracking-wide mb-6">SCANNING</h2>
                <div className="space-y-4">
                  <div className="bg-panel border border-border rounded-xl p-5">
                    <p className="text-text font-body font-semibold text-sm mb-1">Scan All Libraries</p>
                    <p className="text-subtle font-body text-xs mb-4">
                      Discovers new files and fetches missing metadata. Rate-limited to avoid API quota errors.
                    </p>
                    <button onClick={() => scanAllLibraries()} className="btn-primary flex items-center gap-2 text-sm py-2.5">
                      <RefreshCw size={14} />
                      Scan Now
                    </button>
                  </div>

                  {libraries.map((lib) => (
                    <div key={lib.id} className="bg-panel border border-border rounded-xl p-4 flex items-center justify-between">
                      <div>
                        <p className="text-text font-body text-sm font-medium">{lib.name}</p>
                        <p className="text-subtle font-mono text-xs">{lib.remotePath}</p>
                      </div>
                      <ScanBar libraryId={lib.id} compact />
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* ── Adult ── */}
            {section === "adult" && (
              <motion.div key="adult" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <h2 className="font-display text-3xl text-bright tracking-wide mb-6">ADULT CONTENT</h2>
                <div className="bg-panel border border-border rounded-xl p-5 mb-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-text font-body font-semibold text-sm">Hide from sidebar</p>
                      <p className="text-subtle font-body text-xs mt-0.5">Remove Adult library from navigation</p>
                    </div>
                    <button onClick={() => setAdultHidden(!adultSettings.hidden)}
                      className={`relative w-11 h-6 rounded-full transition-colors ${adultSettings.hidden ? "bg-accent" : "bg-muted"}`}>
                      <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${adultSettings.hidden ? "translate-x-6" : "translate-x-1"}`} />
                    </button>
                  </div>
                </div>

                <div className="bg-panel border border-border rounded-xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Lock size={16} className="text-accent" />
                    <p className="text-text font-body font-semibold text-sm">
                      PIN Protection
                      {adultSettings.pinEnabled && <span className="ml-2 text-teal text-xs">· Enabled</span>}
                    </p>
                  </div>
                  <div className="mb-4">
                    <label className="text-subtle font-body text-xs mb-2 block">PIN Length</label>
                    <div className="flex gap-2">
                      {([4,5,6] as const).map((len) => (
                        <button key={len} onClick={() => setPinLength(len)}
                          className={`px-4 py-1.5 rounded-lg font-body text-sm border transition-all ${
                            pinLength === len ? "border-accent text-accent bg-accent/10" : "border-border text-subtle"
                          }`}>{len} digits</button>
                      ))}
                    </div>
                  </div>
                  {adultSettings.pinEnabled && (
                    <div className="mb-3">
                      <label className="text-subtle font-body text-xs mb-1.5 block">Current PIN</label>
                      <input type="password" value={currentPin}
                        onChange={(e) => setCurrentPin(e.target.value)}
                        placeholder="Enter current PIN" maxLength={6}
                        className="input-field w-36 text-center font-mono tracking-widest" />
                    </div>
                  )}
                  <div className="flex gap-3 mb-3">
                    <div>
                      <label className="text-subtle font-body text-xs mb-1.5 block">New PIN</label>
                      <input type="password" value={newPin}
                        onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
                        maxLength={pinLength} className="input-field w-28 text-center font-mono tracking-widest" />
                    </div>
                    <div>
                      <label className="text-subtle font-body text-xs mb-1.5 block">Confirm PIN</label>
                      <input type="password" value={confirmPin}
                        onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
                        maxLength={pinLength} className="input-field w-28 text-center font-mono tracking-widest" />
                    </div>
                  </div>
                  {pinError && <p className="text-danger text-xs font-body mb-3 flex items-center gap-1"><AlertCircle size={12}/>{pinError}</p>}
                  {pinSuccess && <p className="text-teal text-xs font-body mb-3 flex items-center gap-1"><CheckCircle2 size={12}/>{pinSuccess}</p>}
                  <div className="flex gap-2">
                    <button onClick={handleSetPin} className="btn-primary flex items-center gap-2 text-sm py-2">
                      <Lock size={14} />{adultSettings.pinEnabled ? "Change PIN" : "Set PIN"}
                    </button>
                    {adultSettings.pinEnabled && (
                      <button onClick={() => clearAdultPin()} className="btn-secondary flex items-center gap-2 text-sm py-2 text-danger border-danger/30">
                        <Trash2 size={14} />Remove PIN
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {/* ── Google Sync ── */}
            {section === "sync" && (
              <motion.div key="sync" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <h2 className="font-display text-3xl text-bright tracking-wide mb-6">GOOGLE SYNC</h2>

                {googleAccount ? (
                  <div className="space-y-4">
                    <div className="bg-panel border border-teal/30 rounded-xl p-5 flex items-center gap-3">
                      <CheckCircle2 size={20} className="text-teal flex-shrink-0" />
                      <div>
                        <p className="text-text font-body font-semibold text-sm">{googleAccount.displayName}</p>
                        <p className="text-subtle font-body text-xs">{googleAccount.email}</p>
                      </div>
                      <button onClick={handleSignOut} className="ml-auto text-subtle hover:text-danger transition-colors p-1.5 rounded hover:bg-danger/10">
                        <LogOut size={16} />
                      </button>
                    </div>

                    {syncMsg && (
                      <p className="text-accent font-body text-sm">{syncMsg}</p>
                    )}

                    {syncState.lastSyncAt && (
                      <p className="text-subtle font-body text-xs">
                        Last synced: {new Date(syncState.lastSyncAt).toLocaleString()}
                      </p>
                    )}

                    <div className="flex gap-3">
                      <button onClick={handleBackup} disabled={syncState.syncing}
                        className="btn-primary flex items-center gap-2 text-sm py-2.5 disabled:opacity-50">
                        <Cloud size={14} />
                        {syncState.syncing ? "Syncing..." : "Backup to Drive"}
                      </button>
                      <button onClick={handleRestore} disabled={syncState.syncing}
                        className="btn-secondary flex items-center gap-2 text-sm py-2.5 disabled:opacity-50">
                        <RefreshCw size={14} />
                        Restore from Drive
                      </button>
                    </div>

                    <div className="bg-panel border border-border rounded-xl p-4 mt-2">
                      <p className="text-subtle font-body text-xs leading-relaxed">
                        Backups are AES-256 encrypted using your Google identity and stored in your private app data folder — invisible in your regular Drive.
                        Includes: rclone config, library mappings, API keys, watch progress, and scan data.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-subtle font-body text-sm">
                      Sign in with Google to enable encrypted config backup and cross-device sync.
                    </p>
                    <button
                      onClick={() => startGoogleSignIn()}
                      className="btn-primary flex items-center gap-2">
                      <Chrome size={16} />
                      Sign in with Google
                    </button>
                  </div>
                )}
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
