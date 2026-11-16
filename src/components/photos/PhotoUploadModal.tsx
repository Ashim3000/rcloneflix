import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  X, UploadCloud, Folder, FileImage, Shield, HardDrive,
  CheckCircle2, AlertCircle, Loader2, Trash2, ArrowRight,
  Sparkles, Image as ImageIcon, Plus, Layers
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import {
  useAppStore,
  type PhotoGallery,
  type GalleryPhoto,
  type PhotoStorageMode,
  isLocalPath,
} from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import {
  pickPhotoFiles,
  pickPhotoFolder,
  listLocalImageFiles,
  readLocalFileBytes,
  rcloneUploadBytes,
  rcloneMkdir,
  saveCachedVaultPhoto,
} from "../../lib/tauri";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  targetGalleryId?: string;
  initialIsAdult?: boolean;
};

export function PhotoUploadModal({ isOpen, onClose, targetGalleryId, initialIsAdult }: Props) {
  const {
    remotes,
    rcloneConfigPath,
    photoSettings,
    galleries,
    upsertGallery,
    localStorageCapMb,
    libraries,
  } = useAppStore();

  const existingGallery = targetGalleryId ? galleries[targetGalleryId] : undefined;
  const photoLibrary = libraries.find((l) => l.type === "photos");

  const libRemote = photoLibrary?.remotePaths?.[0]?.includes(":")
    ? photoLibrary.remotePaths[0].split(":")[0]
    : photoLibrary?.remotePaths?.[0]
    ? "LOCAL"
    : undefined;

  // Determine active target remote: from photoSettings, or photoLibrary, or first crypt remote, or first remote
  const activeRemote =
    existingGallery?.remoteName ||
    photoSettings.remoteName ||
    libRemote ||
    remotes.find((r) => r.type === "crypt")?.name ||
    remotes[0]?.name ||
    "odrivecrypt";

  const isLocalTarget = activeRemote === "LOCAL" || isLocalPath(photoSettings.folder);

  const isRemoteEncrypted =
    !isLocalTarget &&
    (photoSettings.isEncrypted ||
      remotes.find((r) => r.name === activeRemote)?.type === "crypt" ||
      activeRemote.toLowerCase().includes("crypt"));

  const [galleryTitle, setGalleryTitle] = useState(existingGallery ? existingGallery.title : "");
  const [description, setDescription] = useState(existingGallery?.description || "");
  const [isAdult, setIsAdult] = useState(existingGallery ? existingGallery.isAdult : (initialIsAdult || false));
  const [storageMode, setStorageMode] = useState<PhotoStorageMode>(existingGallery?.storageMode || "original");
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [currentStep, setCurrentStep] = useState<string>("");
  const [processedCount, setProcessedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (existingGallery) {
      setGalleryTitle(existingGallery.title);
      setDescription(existingGallery.description || "");
      setIsAdult(existingGallery.isAdult);
      if (existingGallery.storageMode) setStorageMode(existingGallery.storageMode);
    } else if (initialIsAdult !== undefined) {
      setIsAdult(initialIsAdult);
    }
  }, [existingGallery, initialIsAdult]);

  if (!isOpen) return null;

  const handlePickFiles = async () => {
    try {
      const selected = await pickPhotoFiles();
      if (selected && selected.length > 0) {
        setFilePaths((prev) => Array.from(new Set([...prev, ...selected])));
        setErrorMsg("");
      }
    } catch (err: any) {
      setErrorMsg("Failed to pick files: " + err.message);
    }
  };

  const handlePickFolder = async () => {
    try {
      const folder = await pickPhotoFolder();
      if (folder) {
        const images = await listLocalImageFiles(folder);
        if (images.length === 0) {
          setErrorMsg("No supported image files found in the selected folder.");
          return;
        }
        setFilePaths((prev) => Array.from(new Set([...prev, ...images])));
        setErrorMsg("");
        if (!galleryTitle) {
          const folderName = folder.split(/[\\/]/).filter(Boolean).pop() || "Gallery";
          setGalleryTitle(folderName);
        }
      }
    } catch (err: any) {
      setErrorMsg("Failed to scan folder: " + err.message);
    }
  };

  const handleRemoveFile = (index: number) => {
    setFilePaths((prev) => prev.filter((_, i) => i !== index));
  };

  const handleStartUpload = async () => {
    if (filePaths.length === 0) {
      setErrorMsg("Please select at least one photo to upload.");
      return;
    }
    if (!activeRemote) {
      setErrorMsg("No remote configured. Please set up your Photos storage first.");
      return;
    }
    if (!rcloneConfigPath) {
      setErrorMsg("Rclone configuration path is missing. Please check Settings.");
      return;
    }

    const cleanTitle = galleryTitle.trim() || "Untitled Gallery";
    setIsUploading(true);
    setErrorMsg("");
    setTotalCount(filePaths.length);
    setProcessedCount(0);

    const uploadedPhotos: GalleryPhoto[] = existingGallery ? [...existingGallery.photos] : [];
    const galleryId = existingGallery ? existingGallery.id : `gal-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const folderName = photoSettings.folder || "Photos";
    const remoteBaseDir = isLocalTarget
      ? `${photoSettings.folder || ""}/${cleanTitle}`
      : `${activeRemote}:${folderName}/${cleanTitle}`;

    // Retry helper with exponential backoff
    const uploadWithRetry = async <T,>(task: () => Promise<T>, retries = 3, initialDelay = 400): Promise<T> => {
      let attempt = 0;
      while (true) {
        try {
          return await task();
        } catch (err) {
          attempt++;
          if (attempt >= retries) throw err;
          const delay = initialDelay * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    };

    // Pre-create remote folder once
    try {
      await rcloneMkdir(rcloneConfigPath, remoteBaseDir).catch(() => {});
    } catch (e) {
      console.warn("Folder preparation warning:", e);
    }

    const failedFiles: string[] = [];

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      const filename = filePath.split(/[\\/]/).filter(Boolean).pop() || `photo_${i + 1}.jpg`;
      const baseName = filename.substring(0, filename.lastIndexOf(".")) || filename;
      const photoId = `pho-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      setProcessedCount(i + 1);

      try {
        let compWidth: number | undefined;
        let compHeight: number | undefined;

        if (storageMode === "original") {
          // 1. ORIGINAL QUALITY: Exact bytes, original filename & extension, zero conversion
          setCurrentStep(`Reading ${filename}...`);
          const photoBytes = await readLocalFileBytes(filePath);
          const destPath = `${remoteBaseDir}/${filename}`;

          setCurrentStep(`Uploading original ${filename} to ${activeRemote}...`);
          await uploadWithRetry(() => rcloneUploadBytes(rcloneConfigPath, destPath, photoBytes));

          // Cache locally for instant preview
          saveCachedVaultPhoto(photoId, photoBytes, localStorageCapMb).catch(() => {});

          uploadedPhotos.push({
            id: photoId,
            remoteOriginalPath: destPath,
            remotePath: destPath,
            filename: filename,
            sizeBytes: photoBytes.byteLength,
            isAdult,
            uploadedAt: Date.now(),
            storageMode: "original",
          });
        } else if (storageMode === "both") {
          // 2. BOTH: Original full-res file + fast WebP preview for instant gallery browsing
          setCurrentStep(`Reading original ${filename}...`);
          const originalBytes = await readLocalFileBytes(filePath);
          const origDestPath = `${remoteBaseDir}/${filename}`;

          setCurrentStep(`Uploading original ${filename} to ${activeRemote}...`);
          await uploadWithRetry(() => rcloneUploadBytes(rcloneConfigPath, origDestPath, originalBytes));

          let previewPath: string | undefined;
          try {
            setCurrentStep(`Generating preview for ${filename}...`);
            const res = await invoke<{ bytes: number[]; width: number; height: number }>(
              "compress_photo_vault",
              { filePath }
            );
            const previewBytes = new Uint8Array(res.bytes);
            previewPath = `${remoteBaseDir}/.previews/${baseName}.webp`;
            await uploadWithRetry(() => rcloneUploadBytes(rcloneConfigPath, previewPath!, previewBytes));
            saveCachedVaultPhoto(photoId, previewBytes, localStorageCapMb).catch(() => {});
            compWidth = res.width;
            compHeight = res.height;
          } catch {
            // Preview generation failed, fallback to original as preview
            previewPath = origDestPath;
            saveCachedVaultPhoto(photoId, originalBytes, localStorageCapMb).catch(() => {});
          }

          uploadedPhotos.push({
            id: photoId,
            remoteOriginalPath: origDestPath,
            remotePreviewPath: previewPath,
            remotePath: origDestPath,
            filename: filename,
            sizeBytes: originalBytes.byteLength,
            width: compWidth,
            height: compHeight,
            isAdult,
            uploadedAt: Date.now(),
            storageMode: "both",
          });
        } else {
          // 3. COMPRESSED: WebP optimized
          let photoBytes: Uint8Array;
          let destPath: string;
          let savedFilename = filename;

          try {
            setCurrentStep(`Optimizing ${filename}...`);
            const res = await invoke<{ bytes: number[]; width: number; height: number }>(
              "compress_photo_vault",
              { filePath }
            );
            photoBytes = new Uint8Array(res.bytes);
            compWidth = res.width;
            compHeight = res.height;
            savedFilename = `${baseName}.webp`;
            destPath = `${remoteBaseDir}/${savedFilename}`;
          } catch (err) {
            console.warn("Optimization failed, preserving original format:", err);
            photoBytes = await readLocalFileBytes(filePath);
            destPath = `${remoteBaseDir}/${filename}`;
            savedFilename = filename;
          }

          setCurrentStep(`Uploading to ${activeRemote}...`);
          await uploadWithRetry(() => rcloneUploadBytes(rcloneConfigPath, destPath, photoBytes));
          saveCachedVaultPhoto(photoId, photoBytes, localStorageCapMb).catch(() => {});

          uploadedPhotos.push({
            id: photoId,
            remotePreviewPath: destPath,
            remotePath: destPath,
            filename: savedFilename,
            sizeBytes: photoBytes.byteLength,
            width: compWidth,
            height: compHeight,
            isAdult,
            uploadedAt: Date.now(),
            storageMode: "compressed",
          });
        }

        if (i < filePaths.length - 1) {
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch (itemErr: any) {
        console.error(`Failed to upload ${filename}:`, itemErr);
        failedFiles.push(filename);
      }
    }

    if (uploadedPhotos.length > 0) {
      const newGallery: PhotoGallery = {
        id: galleryId,
        title: cleanTitle,
        description: description.trim() || undefined,
        coverPhotoId: uploadedPhotos[0]?.id,
        isAdult,
        photos: uploadedPhotos,
        remoteName: activeRemote,
        remotePath: remoteBaseDir,
        storageMode,
        createdAt: existingGallery ? existingGallery.createdAt : Date.now(),
        updatedAt: Date.now(),
      };

      upsertGallery(newGallery);
      useToastStore
        .getState()
        .addToast(`Uploaded ${uploadedPhotos.length} photos to ${activeRemote}`, "success");
      onClose();
    } else {
      setErrorMsg(`Failed to upload photos: ${failedFiles.join(", ")}`);
    }

    setIsUploading(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="w-full max-w-2xl bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-border flex items-center justify-between bg-panel/40">
          <div>
            <h2 className="font-display text-2xl text-bright tracking-wide flex items-center gap-2.5">
              <UploadCloud size={24} className="text-accent" />
              UPLOAD PHOTOS
            </h2>
            <p className="text-subtle font-body text-xs mt-1">
              Add photos to your collection. Uploaded directly to your storage remote.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isUploading}
            className="p-1.5 rounded-lg text-subtle hover:text-bright hover:bg-panel transition-colors disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-danger/10 border border-danger/30 text-danger text-xs font-body flex items-center gap-2">
              <AlertCircle size={15} className="flex-shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Destination banner */}
          <div className="p-3 rounded-xl bg-panel/60 border border-border flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 truncate">
              <HardDrive size={15} className="text-subtle flex-shrink-0" />
              <span className="text-subtle font-body flex-shrink-0">Destination:</span>
              <strong className="text-bright font-mono truncate">
                {isLocalTarget
                  ? `${photoSettings.folder || "Local Folder"}/`
                  : `${activeRemote}:${photoSettings.folder || "Photos"}/`}
              </strong>
            </div>
            {isRemoteEncrypted ? (
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-accent/20 text-accent border border-accent/30 flex items-center gap-1">
                <Shield size={11} />
                Rclone Crypt
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-muted text-subtle border border-border">
                Standard Storage
              </span>
            )}
          </div>

          {/* Title & Description */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-mono text-subtle uppercase tracking-wider mb-1.5">
                Gallery Name *
              </label>
              <input
                type="text"
                value={galleryTitle}
                onChange={(e) => setGalleryTitle(e.target.value)}
                placeholder="e.g. Summer Vacation, Family Memories"
                disabled={isUploading}
                className="w-full px-3.5 py-2 rounded-xl bg-panel border border-border text-bright placeholder-subtle/50 text-sm font-body focus:outline-none focus:border-accent transition-all"
              />
            </div>

            <div>
              <label className="block text-xs font-mono text-subtle uppercase tracking-wider mb-1.5">
                Description (Optional)
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Notes or context"
                disabled={isUploading}
                className="w-full px-3.5 py-2 rounded-xl bg-panel border border-border text-bright placeholder-subtle/50 text-sm font-body focus:outline-none focus:border-accent transition-all"
              />
            </div>
          </div>

          {/* Storage & Quality Mode Selector */}
          <div className="space-y-2">
            <label className="block text-xs font-mono text-subtle uppercase tracking-wider">
              Upload Quality &amp; Storage Format
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs font-body">
              <button
                type="button"
                onClick={() => setStorageMode("original")}
                disabled={isUploading}
                className={`p-3 rounded-xl border text-left transition-all ${
                  storageMode === "original"
                    ? "bg-accent/15 border-accent text-bright ring-1 ring-accent"
                    : "bg-panel/40 border-border text-subtle hover:text-text hover:bg-panel"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-white flex items-center gap-1.5">
                    <Sparkles size={14} className="text-accent" /> Original Quality
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent font-mono font-medium">Default</span>
                </div>
                <p className="text-[11px] text-subtle leading-snug">
                  100% original fidelity, raw resolution, EXIF metadata &amp; format (JPEG, PNG, RAW, TIFF). Zero forced re-encoding.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setStorageMode("both")}
                disabled={isUploading}
                className={`p-3 rounded-xl border text-left transition-all ${
                  storageMode === "both"
                    ? "bg-accent/15 border-accent text-bright ring-1 ring-accent"
                    : "bg-panel/40 border-border text-subtle hover:text-text hover:bg-panel"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-white flex items-center gap-1.5">
                    <Layers size={14} className="text-purple-400" /> Both (Archive + Fast)
                  </span>
                </div>
                <p className="text-[11px] text-subtle leading-snug">
                  Upload full original file for lossless archiving + fast WebP preview for instant gallery navigation.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setStorageMode("compressed")}
                disabled={isUploading}
                className={`p-3 rounded-xl border text-left transition-all ${
                  storageMode === "compressed"
                    ? "bg-accent/15 border-accent text-bright ring-1 ring-accent"
                    : "bg-panel/40 border-border text-subtle hover:text-text hover:bg-panel"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-white flex items-center gap-1.5">
                    <FileImage size={14} className="text-blue-400" /> Optimized WebP
                  </span>
                </div>
                <p className="text-[11px] text-subtle leading-snug">
                  Downscale &amp; compress to WebP to minimize cloud storage footprint and bandwidth.
                </p>
              </button>
            </div>
          </div>

          {/* File Picker Zone */}
          <div className="space-y-3">
            <label className="block text-xs font-mono text-subtle uppercase tracking-wider">
              Select Photos
            </label>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={handlePickFiles}
                disabled={isUploading}
                className="p-4 rounded-xl border border-dashed border-border hover:border-accent/60 bg-panel/40 hover:bg-panel/80 text-subtle hover:text-bright flex flex-col items-center justify-center gap-2 transition-all group"
              >
                <FileImage size={24} className="group-hover:text-accent transition-colors" />
                <span className="text-xs font-body font-medium">Choose Images</span>
              </button>

              <button
                type="button"
                onClick={handlePickFolder}
                disabled={isUploading}
                className="p-4 rounded-xl border border-dashed border-border hover:border-accent/60 bg-panel/40 hover:bg-panel/80 text-subtle hover:text-bright flex flex-col items-center justify-center gap-2 transition-all group"
              >
                <Folder size={24} className="group-hover:text-accent transition-colors" />
                <span className="text-xs font-body font-medium">Choose Entire Folder</span>
              </button>
            </div>

            {/* Selected Files Preview List */}
            {filePaths.length > 0 && (
              <div className="p-3 rounded-xl bg-panel/30 border border-border space-y-2">
                <div className="flex items-center justify-between text-xs font-mono text-subtle">
                  <span>Selected: <strong className="text-bright">{filePaths.length}</strong> photos</span>
                  <button
                    type="button"
                    onClick={() => setFilePaths([])}
                    disabled={isUploading}
                    className="text-danger hover:underline text-[11px]"
                  >
                    Clear All
                  </button>
                </div>

                <div className="max-h-36 overflow-y-auto space-y-1 pr-1">
                  {filePaths.map((path, idx) => {
                    const fname = path.split(/[\\/]/).pop() || path;
                    return (
                      <div
                        key={idx}
                        className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-surface/80 text-xs font-mono text-subtle"
                      >
                        <span className="truncate max-w-[80%]" title={path}>
                          {fname}
                        </span>
                        {!isUploading && (
                          <button
                            type="button"
                            onClick={() => handleRemoveFile(idx)}
                            className="text-subtle hover:text-danger p-0.5"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Sensitive / Adult Tag */}
          <div className="p-3.5 rounded-xl bg-panel/40 border border-border flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Shield size={16} className={isAdult ? "text-danger" : "text-subtle"} />
              <div>
                <span className="text-xs font-body font-medium text-bright block">
                  Mark as Sensitive / Adult
                </span>
                <span className="text-[11px] font-body text-subtle">
                  Flags this gallery for adult filtering and PIN lock in the UI.
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsAdult(!isAdult)}
              disabled={isUploading}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                isAdult ? "bg-danger" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-bright transition-transform ${
                  isAdult ? "translate-x-4" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Upload Progress */}
          {isUploading && (
            <div className="p-4 rounded-xl bg-panel border border-accent/30 space-y-2">
              <div className="flex items-center justify-between text-xs font-body">
                <span className="text-bright flex items-center gap-1.5 font-semibold">
                  <Loader2 size={13} className="animate-spin text-accent" />
                  {currentStep}
                </span>
                <span className="font-mono text-accent">
                  {processedCount} / {totalCount}
                </span>
              </div>

              <div className="w-full bg-surface rounded-full h-2 overflow-hidden border border-border">
                <div
                  className="bg-accent h-full transition-all duration-300"
                  style={{
                    width: `${totalCount > 0 ? (processedCount / totalCount) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex items-center justify-between bg-panel/30">
          <button
            type="button"
            onClick={onClose}
            disabled={isUploading}
            className="px-4 py-2 rounded-xl text-xs font-body text-subtle hover:text-bright transition-colors disabled:opacity-50"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleStartUpload}
            disabled={isUploading || filePaths.length === 0}
            className="px-5 py-2.5 rounded-xl bg-accent hover:bg-accent-glow text-void font-body text-xs font-bold flex items-center gap-2 transition-all shadow-accent-glow disabled:opacity-50 active:scale-95"
          >
            {isUploading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>Uploading...</span>
              </>
            ) : (
              <>
                <UploadCloud size={15} />
                <span>Upload {filePaths.length > 0 ? `(${filePaths.length})` : ""}</span>
              </>
            )}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
