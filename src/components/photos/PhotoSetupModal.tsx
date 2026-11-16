import { useState } from "react";
import { motion } from "framer-motion";
import {
  X, Shield, Lock, HardDrive, CheckCircle2,
  Folder, Eye, EyeOff, Loader2, FolderOpen
} from "lucide-react";
import { useAppStore, type Library } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { rcloneCreateCryptRemote, parseRcloneConfig, pickLocalFolder } from "../../lib/tauri";
import { scanLibrary } from "../../lib/scanner";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onConfigured?: () => void;
};

export function PhotoSetupModal({ isOpen, onClose, onConfigured }: Props) {
  const {
    remotes,
    setRemotes,
    rcloneConfigPath,
    setPhotoSettings,
    libraries,
    addLibrary,
    tmdbApiKey,
    thePornDbApiKey,
  } = useAppStore();

  const cryptRemotes = remotes.filter((r) => r.type === "crypt");
  const nonCryptRemotes = remotes.filter((r) => r.type !== "crypt");

  // Mode: "encrypted" (default) or "plain"
  const [useEncryption, setUseEncryption] = useState(true);

  // If using encrypted: either "existing" or "new"
  const [cryptChoice, setCryptChoice] = useState<"existing" | "new">(
    cryptRemotes.length > 0 ? "existing" : "new"
  );
  const [selectedExistingCrypt, setSelectedExistingCrypt] = useState(
    cryptRemotes[0]?.name || "odrivecrypt"
  );

  // New crypt creation fields
  const [cryptBaseRemote, setCryptBaseRemote] = useState(
    nonCryptRemotes[0]?.name || "drivemine"
  );
  const [cryptRemoteFolder, setCryptRemoteFolder] = useState("Photos_Encrypted");
  const [cryptRemoteName, setCryptRemoteName] = useState("photos-crypt");
  const [cryptPassword, setCryptPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // Plain storage fields
  const [plainStorageType, setPlainStorageType] = useState<"cloud" | "local">("cloud");
  const [selectedPlainRemote, setSelectedPlainRemote] = useState(
    nonCryptRemotes[0]?.name || remotes[0]?.name || "drivemine"
  );
  const [plainFolder, setPlainFolder] = useState("Photos");
  const [localFolderPath, setLocalFolderPath] = useState("");

  const [errorMsg, setErrorMsg] = useState("");

  if (!isOpen) return null;

  const handleGeneratePassword = () => {
    const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*";
    let pass = "";
    for (let i = 0; i < 20; i++) {
      pass += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setCryptPassword(pass);
    setShowPassword(true);
  };

  const handleBrowseLocalFolder = async () => {
    try {
      const selected = await pickLocalFolder();
      if (selected) {
        setLocalFolderPath(selected);
        setErrorMsg("");
      }
    } catch (err: any) {
      setErrorMsg("Failed to select folder: " + err.message);
    }
  };

  const handleCompleteSetup = async () => {
    setErrorMsg("");
    let targetRemote = "";
    let targetFolder = "Photos";
    let isEncrypted = false;

    if (useEncryption) {
      isEncrypted = true;
      if (cryptChoice === "existing") {
        if (!selectedExistingCrypt) {
          setErrorMsg("Please select an existing encrypted remote.");
          return;
        }
        targetRemote = selectedExistingCrypt;
        targetFolder = "Photos";
      } else {
        // Create new crypt remote
        const cleanName = cryptRemoteName.trim().replace(/[:\/\\]/g, "");
        if (!cleanName) {
          setErrorMsg("Please enter a valid name for the new encrypted remote.");
          return;
        }
        if (!cryptPassword.trim()) {
          setErrorMsg("Please choose a password to encrypt your photos remote.");
          return;
        }
        if (!cryptBaseRemote) {
          setErrorMsg("Please select a base cloud remote.");
          return;
        }

        setIsCreating(true);
        try {
          const baseRemotePath = `${cryptBaseRemote}:${cryptRemoteFolder.trim() || "Photos_Encrypted"}`;
          await rcloneCreateCryptRemote(
            rcloneConfigPath,
            cleanName,
            baseRemotePath,
            cryptPassword.trim()
          );

          // Refresh remotes list
          if (rcloneConfigPath) {
            const updated = await parseRcloneConfig(rcloneConfigPath);
            setRemotes(updated.map((r) => ({ name: r.name, type: r.remote_type })));
          }

          targetRemote = cleanName;
          targetFolder = "Photos";
          useToastStore.getState().addToast(`Created encrypted remote ${cleanName}`, "success");
        } catch (err: any) {
          setErrorMsg("Failed to create encrypted remote: " + (err.message || String(err)));
          setIsCreating(false);
          return;
        }
      }
    } else {
      // Plain / unencrypted remote or local folder
      if (plainStorageType === "local") {
        if (!localFolderPath.trim()) {
          setErrorMsg("Please select a local folder for your photos.");
          return;
        }
        targetRemote = "LOCAL";
        targetFolder = localFolderPath.trim();
        isEncrypted = false;
      } else {
        if (!selectedPlainRemote) {
          setErrorMsg("Please select a storage remote.");
          return;
        }
        targetRemote = selectedPlainRemote;
        targetFolder = plainFolder.trim() || "Photos";
        isEncrypted = false;
      }
    }

    // Save photo settings in appStore
    setPhotoSettings({
      configured: true,
      remoteName: targetRemote,
      folder: targetFolder,
      isEncrypted,
    });

    // Automatically create or link a photo library with remotePaths
    const targetRemotePath =
      targetRemote === "LOCAL" ? targetFolder : `${targetRemote}:${targetFolder}`;

    const existingLib = libraries.find(
      (l) => l.type === "photos" && l.remotePaths && l.remotePaths.includes(targetRemotePath)
    );

    let libToScan: Library | undefined = existingLib;

    if (!existingLib) {
      const newLib: Library = {
        id: `lib-photos-${Date.now()}`,
        name: targetRemote === "LOCAL" ? "Local Photos" : "Photos",
        type: "photos",
        remotePaths: [targetRemotePath],
      };
      addLibrary(newLib);
      libToScan = newLib;
    }

    useToastStore.getState().addToast("Photos section configured successfully", "success");
    setIsCreating(false);
    onClose();
    if (onConfigured) onConfigured();

    // Scan initial folder in background
    if (libToScan) {
      scanLibrary(libToScan, { tmdb: tmdbApiKey, theporndb: thePornDbApiKey }).catch(() => {});
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="w-full max-w-xl bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-border flex items-center justify-between bg-panel/40">
          <div>
            <h2 className="font-display text-2xl text-bright tracking-wide flex items-center gap-2.5">
              <Shield size={22} className="text-accent" />
              SET UP PHOTOS
            </h2>
            <p className="text-subtle font-body text-xs mt-1">
              Choose how your photos are stored in the cloud or on local disk.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-subtle hover:text-bright hover:bg-panel transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-danger/10 border border-danger/30 text-danger text-xs font-body flex items-center gap-2">
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Primary Choice: Encrypted vs Plain */}
          <div>
            <label className="block text-xs font-mono text-subtle uppercase tracking-wider mb-2.5">
              Storage Privacy & Encryption
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Option 1: Encrypted (Default) */}
              <button
                type="button"
                onClick={() => setUseEncryption(true)}
                className={`p-4 rounded-xl border text-left transition-all relative flex flex-col justify-between ${
                  useEncryption
                    ? "bg-accent/10 border-accent text-bright shadow-sm"
                    : "bg-panel border-border text-subtle hover:text-text hover:border-muted"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-body text-sm font-bold text-bright flex items-center gap-1.5">
                      <Lock size={15} className="text-accent" />
                      Encrypted Remote
                    </span>
                    {useEncryption && <CheckCircle2 size={16} className="text-accent" />}
                  </div>
                  <p className="text-xs font-body text-subtle leading-relaxed">
                    Uses Rclone's native AES-256 crypt remote. Files and names are encrypted transparently by Rclone. Normal images inside the app.
                  </p>
                </div>
                <span className="mt-3 inline-block px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-accent/20 text-accent border border-accent/30 w-fit">
                  Recommended
                </span>
              </button>

              {/* Option 2: Direct / Plain */}
              <button
                type="button"
                onClick={() => setUseEncryption(false)}
                className={`p-4 rounded-xl border text-left transition-all relative flex flex-col justify-between ${
                  !useEncryption
                    ? "bg-accent/10 border-accent text-bright shadow-sm"
                    : "bg-panel border-border text-subtle hover:text-text hover:border-muted"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-body text-sm font-bold text-bright flex items-center gap-1.5">
                      <HardDrive size={15} className="text-teal" />
                      Direct / Plain
                    </span>
                    {!useEncryption && <CheckCircle2 size={16} className="text-accent" />}
                  </div>
                  <p className="text-xs font-body text-subtle leading-relaxed">
                    Stores standard image files directly on your cloud remote or on a local folder without cloud encryption.
                  </p>
                </div>
                <span className="mt-3 inline-block px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-muted text-subtle border border-border w-fit">
                  Standard Files
                </span>
              </button>
            </div>
          </div>

          {/* Conditional Sub-settings */}
          {useEncryption ? (
            <div className="p-4 rounded-xl bg-panel/50 border border-border space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-body font-semibold text-bright">
                  Rclone Crypt Remote Configuration
                </span>
                {cryptRemotes.length > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setCryptChoice("existing")}
                      className={`px-2.5 py-1 rounded-lg transition-all ${
                        cryptChoice === "existing"
                          ? "bg-accent text-void font-bold"
                          : "text-subtle hover:text-bright"
                      }`}
                    >
                      Use Existing ({cryptRemotes.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setCryptChoice("new")}
                      className={`px-2.5 py-1 rounded-lg transition-all ${
                        cryptChoice === "new"
                          ? "bg-accent text-void font-bold"
                          : "text-subtle hover:text-bright"
                      }`}
                    >
                      Create New
                    </button>
                  </div>
                )}
              </div>

              {cryptChoice === "existing" && cryptRemotes.length > 0 ? (
                <div>
                  <label className="block text-xs font-body text-subtle mb-1.5">
                    Select Existing Encrypted Remote:
                  </label>
                  <select
                    value={selectedExistingCrypt}
                    onChange={(e) => setSelectedExistingCrypt(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-surface border border-border text-bright text-sm font-body focus:outline-none focus:border-accent"
                  >
                    {cryptRemotes.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name} (crypt)
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] font-body text-subtle mt-1.5">
                    Photos will be stored in <code className="font-mono text-accent">{selectedExistingCrypt}:Photos</code> and transparently encrypted by Rclone.
                  </p>
                </div>
              ) : (
                <div className="space-y-3 pt-1">
                  <p className="text-xs font-body text-subtle">
                    Create a dedicated encrypted remote in your <code className="font-mono text-accent">rclone.conf</code>. Rclone will handle all encryption with this password.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div>
                      <label className="block text-subtle text-[11px] mb-1">Base Cloud Remote</label>
                      {nonCryptRemotes.length > 0 ? (
                        <select
                          value={cryptBaseRemote}
                          onChange={(e) => setCryptBaseRemote(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-surface border border-border text-bright text-xs focus:outline-none focus:border-accent"
                        >
                          {nonCryptRemotes.map((r) => (
                            <option key={r.name} value={r.name}>
                              {r.name} ({r.type})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={cryptBaseRemote}
                          onChange={(e) => setCryptBaseRemote(e.target.value)}
                          placeholder="e.g. drivemine"
                          className="w-full px-2.5 py-1.5 rounded-lg bg-surface border border-border text-bright text-xs"
                        />
                      )}
                    </div>

                    <div>
                      <label className="block text-subtle text-[11px] mb-1">Target Cloud Folder</label>
                      <input
                        type="text"
                        value={cryptRemoteFolder}
                        onChange={(e) => setCryptRemoteFolder(e.target.value)}
                        placeholder="Photos_Encrypted"
                        className="w-full px-2.5 py-1.5 rounded-lg bg-surface border border-border text-bright text-xs focus:outline-none focus:border-accent"
                      />
                    </div>

                    <div>
                      <label className="block text-subtle text-[11px] mb-1">New Crypt Remote Name</label>
                      <input
                        type="text"
                        value={cryptRemoteName}
                        onChange={(e) => setCryptRemoteName(e.target.value)}
                        placeholder="photos-crypt"
                        className="w-full px-2.5 py-1.5 rounded-lg bg-surface border border-border text-bright text-xs focus:outline-none focus:border-accent"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="block text-subtle text-[11px]">Passphrase / Password</label>
                        <button
                          type="button"
                          onClick={handleGeneratePassword}
                          className="text-[10px] text-accent hover:underline"
                        >
                          Generate
                        </button>
                      </div>
                      <div className="relative">
                        <input
                          type={showPassword ? "text" : "password"}
                          value={cryptPassword}
                          onChange={(e) => setCryptPassword(e.target.value)}
                          placeholder="Choose secure password"
                          className="w-full px-2.5 py-1.5 pr-8 rounded-lg bg-surface border border-border text-bright text-xs font-mono focus:outline-none focus:border-accent"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle hover:text-bright"
                        >
                          {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 rounded-xl bg-panel/50 border border-border space-y-4">
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setPlainStorageType("cloud")}
                  className={`px-3 py-1.5 rounded-lg transition-all ${
                    plainStorageType === "cloud"
                      ? "bg-accent text-void font-bold"
                      : "bg-surface border border-border text-subtle hover:text-bright"
                  }`}
                >
                  Cloud Remote
                </button>
                <button
                  type="button"
                  onClick={() => setPlainStorageType("local")}
                  className={`px-3 py-1.5 rounded-lg transition-all ${
                    plainStorageType === "local"
                      ? "bg-accent text-void font-bold"
                      : "bg-surface border border-border text-subtle hover:text-bright"
                  }`}
                >
                  Local Folder
                </button>
              </div>

              {plainStorageType === "cloud" ? (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-body text-subtle mb-1.5">
                      Select Cloud Remote:
                    </label>
                    <select
                      value={selectedPlainRemote}
                      onChange={(e) => setSelectedPlainRemote(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-surface border border-border text-bright text-sm font-body focus:outline-none focus:border-accent"
                    >
                      {remotes.map((r) => (
                        <option key={r.name} value={r.name}>
                          {r.name} ({r.type})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-body text-subtle mb-1.5">
                      Photos Folder Name:
                    </label>
                    <input
                      type="text"
                      value={plainFolder}
                      onChange={(e) => setPlainFolder(e.target.value)}
                      placeholder="Photos"
                      className="w-full px-3 py-2 rounded-xl bg-surface border border-border text-bright text-sm font-body focus:outline-none focus:border-accent"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-body text-subtle mb-1.5">
                      Local Photos Directory:
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={localFolderPath}
                        onChange={(e) => setLocalFolderPath(e.target.value)}
                        placeholder="/home/username/Pictures"
                        className="flex-1 px-3 py-2 rounded-xl bg-surface border border-border text-bright text-sm font-body focus:outline-none focus:border-accent"
                      />
                      <button
                        type="button"
                        onClick={handleBrowseLocalFolder}
                        className="px-3.5 py-2 rounded-xl bg-surface hover:bg-muted border border-border text-bright text-xs font-body flex items-center gap-1.5 transition-all"
                      >
                        <FolderOpen size={15} className="text-accent" />
                        <span>Browse...</span>
                      </button>
                    </div>
                  </div>
                  <p className="text-[11px] font-body text-subtle">
                    Points to an existing folder on your computer. Any subfolders will be scanned and displayed as galleries.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex items-center justify-between bg-panel/30">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-body text-subtle hover:text-bright transition-colors"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleCompleteSetup}
            disabled={isCreating}
            className="px-5 py-2 rounded-xl bg-accent hover:bg-accent-glow text-void font-body text-xs font-bold flex items-center gap-2 transition-all shadow-accent-glow disabled:opacity-50"
          >
            {isCreating ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>Configuring Rclone...</span>
              </>
            ) : (
              <>
                <CheckCircle2 size={15} />
                <span>Save Photos Configuration</span>
              </>
            )}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
