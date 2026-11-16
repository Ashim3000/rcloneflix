import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Images, Plus, Lock, Unlock, Shield, ShieldAlert,
  HardDrive, Trash2, Calendar, FileText, Image as ImageIcon,
  ExternalLink, Sparkles, RefreshCw, FolderPlus, Folder, Settings
} from "lucide-react";
import { useAppStore, type PhotoGallery, isLocalPath } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { scanLibrary } from "../../lib/scanner";
import { PhotoUploadModal } from "../../components/photos/PhotoUploadModal";
import { PhotoSetupModal } from "../../components/photos/PhotoSetupModal";
import { PhotoGalleryViewer } from "../../components/photos/PhotoGalleryViewer";
import { AdultPinLock } from "../../components/adult/AdultPinLock";
import { loadAndDecryptVaultPhoto } from "../../lib/photoVault";
import { getSessionPin, PUBLIC_VAULT_KEY } from "../../lib/pin";

/** Individual Gallery Card with on-the-fly cover photo decryption */
function GalleryCard({
  gallery,
  isLockedAdult,
  onOpen,
  onAddPhotos,
  onDelete,
}: {
  gallery: PhotoGallery;
  isLockedAdult: boolean;
  onOpen: () => void;
  onAddPhotos: () => void;
  onDelete: () => void;
}) {
  const { rcloneConfigPath, localStorageCapMb } = useAppStore();
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [loadingCover, setLoadingCover] = useState(false);

  useEffect(() => {
    if (isLockedAdult || gallery.photos.length === 0) {
      setCoverUrl(null);
      return;
    }

    const coverPhoto = gallery.photos[0];
    const pin = gallery.isAdult
      ? (getSessionPin() || "rcloneflix-adult-vault-standard")
      : PUBLIC_VAULT_KEY;

    let cancelled = false;
    setLoadingCover(true);

    loadAndDecryptVaultPhoto(coverPhoto, rcloneConfigPath, pin, false, localStorageCapMb)
      .then((url) => {
        if (!cancelled) {
          setCoverUrl(url);
          setLoadingCover(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadingCover(false);
      });

    return () => {
      cancelled = true;
    };
  }, [gallery.id, gallery.photos[0]?.id, isLockedAdult, gallery.isAdult, rcloneConfigPath, localStorageCapMb]);

  return (
    <div
      tabIndex={0}
      role="button"
      aria-label={`Photo gallery: ${gallery.title}. Press Enter to open.`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="media-card group relative bg-panel rounded-2xl border border-border hover:border-accent/50 focus:border-accent focus:ring-4 focus:ring-accent focus:outline-none overflow-hidden cursor-pointer flex flex-col transition-all duration-300 hover:shadow-card-hover hover:-translate-y-1 focus:scale-105"
    >
      {/* Cover Image Container */}
      <div className="relative aspect-[4/3] bg-surface flex items-center justify-center overflow-hidden">
        {isLockedAdult ? (
          <div className="flex flex-col items-center justify-center gap-2 p-4 text-center">
            <div className="w-12 h-12 rounded-2xl bg-danger/10 border border-danger/20 flex items-center justify-center text-danger">
              <Lock size={22} />
            </div>
            <span className="font-display text-sm tracking-wider text-danger uppercase">
              Locked Adult Photos
            </span>
            <span className="text-[11px] font-body text-subtle">
              Click to unlock with PIN
            </span>
          </div>
        ) : coverUrl ? (
          <img
            src={coverUrl}
            alt={gallery.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 ease-out"
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-subtle/50">
            <ImageIcon size={36} />
            <span className="text-[11px] font-mono mt-1">
              {loadingCover ? "Loading..." : "No cover photo"}
            </span>
          </div>
        )}

        {/* Badges Overlay */}
        <div className="absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-none">
          <div className="flex items-center gap-1.5 flex-wrap">
            {gallery.isAdult && (
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-danger/80 text-white backdrop-blur-md">
                ADULT
              </span>
            )}
            {gallery.remoteName === "LOCAL" || (gallery.photos[0]?.remotePath && isLocalPath(gallery.photos[0]?.remotePath)) ? (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-void/70 text-emerald-400 border border-emerald-500/30 backdrop-blur-md">
                LOCAL
              </span>
            ) : gallery.remoteName?.toLowerCase().includes("crypt") ? (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-void/70 text-accent border border-accent/30 backdrop-blur-md">
                RCLONE CRYPT
              </span>
            ) : gallery.photos[0]?.remotePath || gallery.remotePath ? (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-void/70 text-teal border border-teal/30 backdrop-blur-md">
                {gallery.remoteName ? gallery.remoteName.toUpperCase() : "CLOUD"}
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-void/70 text-accent border border-accent/30 backdrop-blur-md">
                ARWEAVE
              </span>
            )}
            {gallery.storageMode && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-void/70 text-bright border border-border backdrop-blur-md">
                {gallery.storageMode === "both" ? "ORIGINAL + WEBP" : gallery.storageMode === "original" ? "ORIGINALS" : "WEBP"}
              </span>
            )}
          </div>

          <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-void/80 text-bright border border-border backdrop-blur-md">
            {gallery.photos.length} {gallery.photos.length === 1 ? "photo" : "photos"}
          </span>
        </div>
      </div>

      {/* Info & Card Footer */}
      <div className="p-4 flex-1 flex flex-col justify-between">
        <div>
          <h4 className="font-body text-base font-semibold text-bright group-hover:text-accent transition-colors truncate">
            {gallery.title}
          </h4>
          {gallery.description && (
            <p className="text-xs font-body text-subtle line-clamp-2 mt-1">
              {gallery.description}
            </p>
          )}
        </div>

        <div className="pt-3 mt-3 border-t border-border/60 flex items-center justify-between text-[11px] font-mono text-subtle">
          <span className="flex items-center gap-1">
            <Calendar size={11} />
            {new Date(gallery.createdAt).toLocaleDateString()}
          </span>

          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()} tabIndex={-1} data-tv-skip="true">
            <button
              tabIndex={-1}
              data-tv-skip="true"
              onClick={onAddPhotos}
              className="p-1.5 rounded-lg text-subtle hover:text-bright hover:bg-surface transition-colors"
              title="Add photos to this gallery"
            >
              <Plus size={14} />
            </button>
            <button
              tabIndex={-1}
              data-tv-skip="true"
              onClick={onDelete}
              className="p-1.5 rounded-lg text-subtle hover:text-danger hover:bg-danger/10 transition-colors"
              title="Delete gallery"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PhotosPage() {
  const navigate = useNavigate();
  const {
    galleries,
    libraries,
    tmdbApiKey,
    thePornDbApiKey,
    scanState,
    adultSettings,
    photoSettings,
    removeGallery,
    setAdultUnlocked,
  } = useAppStore();

  const photoLibraries = libraries.filter((l) => l.type === "photos");

  const [activeFilter, setActiveFilter] = useState<"all" | "public" | "adult">("all");
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [isSetupModalOpen, setIsSetupModalOpen] = useState(false);
  const [targetGalleryId, setTargetGalleryId] = useState<string | undefined>(undefined);
  const [uploadInitialAdult, setUploadInitialAdult] = useState(false);
  const [activeViewerGallery, setActiveViewerGallery] = useState<PhotoGallery | null>(null);
  const [pinPromptGallery, setPinPromptGallery] = useState<PhotoGallery | null>(null);

  // Automatically prompt for storage setup if not yet configured and no photo libraries exist
  useEffect(() => {
    if (!photoSettings.configured && photoLibraries.length === 0) {
      setIsSetupModalOpen(true);
    }
  }, [photoSettings.configured, photoLibraries.length]);

  const galleryList = Object.values(galleries || {}).sort((a, b) => b.createdAt - a.createdAt);

  // Adult locked condition
  const isAdultLocked = adultSettings.pinEnabled && !adultSettings.unlocked;

  // Filter galleries based on active tab and adult visibility
  const filteredGalleries = galleryList.filter((g) => {
    if (g.isAdult && adultSettings.hidden) return false;
    if (activeFilter === "public") return !g.isAdult;
    if (activeFilter === "adult") return g.isAdult;
    return true;
  });

  const totalPhotos = galleryList.reduce((acc, g) => acc + g.photos.length, 0);

  const handleScanPhotoLibraries = async () => {
    if (photoLibraries.length === 0) {
      useToastStore
        .getState()
        .addToast("No photo libraries configured yet. Add a local or cloud folder in Settings > Libraries.", "info");
      navigate("/settings");
      return;
    }

    for (const lib of photoLibraries) {
      await scanLibrary(lib, { tmdb: tmdbApiKey, theporndb: thePornDbApiKey });
    }
  };

  const handleOpenGallery = (gallery: PhotoGallery) => {
    if (gallery.isAdult && isAdultLocked) {
      setPinPromptGallery(gallery);
      return;
    }
    setActiveViewerGallery(gallery);
  };

  const handleUnlockSuccess = () => {
    if (pinPromptGallery) {
      const target = pinPromptGallery;
      setPinPromptGallery(null);
      setActiveViewerGallery(target);
    }
  };

  const handleOpenNewUpload = (forAdult = false) => {
    setTargetGalleryId(undefined);
    setUploadInitialAdult(forAdult);
    setIsUploadModalOpen(true);
  };

  const handleAddPhotosToGallery = (galleryId: string) => {
    const gallery = galleries[galleryId];
    if (gallery?.isAdult && isAdultLocked) {
      setPinPromptGallery(gallery);
      return;
    }
    setTargetGalleryId(galleryId);
    setUploadInitialAdult(gallery?.isAdult || false);
    setIsUploadModalOpen(true);
  };

  const handleDeleteGallery = (galleryId: string, title: string) => {
    if (confirm(`Are you sure you want to remove the gallery "${title}"?`)) {
      removeGallery(galleryId);
    }
  };

  return (
    <div className="min-h-full flex flex-col p-8 space-y-6">
      {/* Top Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-border">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-4xl text-bright tracking-wider">
              PHOTOS
            </h1>
            <span className="px-3 py-1 rounded-full text-xs font-mono font-bold bg-accent/10 text-accent border border-accent/20 flex items-center gap-1.5">
              {photoSettings.isEncrypted ? <Lock size={13} /> : <HardDrive size={13} />}
              {photoSettings.configured
                ? photoSettings.isEncrypted
                  ? `Encrypted (${photoSettings.remoteName})`
                  : `Storage: ${photoSettings.remoteName}`
                : "Photo Library"}
            </span>
          </div>
          <p className="text-subtle font-body text-sm mt-1">
            Organize, view, and back up your personal photos with optional Rclone Crypt protection
          </p>
        </div>

        {/* Top Actions */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => setIsSetupModalOpen(true)}
            className="px-4 py-2.5 rounded-xl bg-panel hover:bg-muted border border-border text-subtle hover:text-bright text-xs font-body flex items-center gap-2 transition-all"
            title="Configure Photo Storage Remote"
          >
            <Folder size={14} className="text-accent" />
            <span>Storage Setup</span>
          </button>

          <button
            onClick={handleScanPhotoLibraries}
            disabled={scanState.status === "scanning"}
            className="px-4 py-2.5 rounded-xl bg-panel hover:bg-muted border border-border text-subtle hover:text-bright text-xs font-body flex items-center gap-2 transition-all disabled:opacity-50"
            title="Scan configured photo folders"
          >
            <RefreshCw
              size={14}
              className={scanState.status === "scanning" && photoLibraries.some((l) => l.name === scanState.currentLibrary) ? "animate-spin text-accent" : ""}
            />
            <span>Scan Libraries</span>
          </button>

          {adultSettings.pinEnabled && adultSettings.unlocked && (
            <button
              onClick={() => setAdultUnlocked(false)}
              className="px-4 py-2.5 rounded-xl bg-panel hover:bg-muted border border-border text-subtle hover:text-bright text-xs font-body flex items-center gap-2 transition-all"
              title="Lock Adult Photos"
            >
              <Lock size={14} className="text-danger" />
              <span>Lock Adult</span>
            </button>
          )}

          <button
            onClick={() => handleOpenNewUpload(false)}
            className="px-5 py-2.5 rounded-xl bg-accent hover:bg-accent-glow text-void font-body text-sm font-semibold flex items-center gap-2 transition-all shadow-accent-glow active:scale-95"
          >
            <Plus size={16} />
            <span>Upload Gallery</span>
          </button>
        </div>
      </div>

      {/* Filter Tabs & Stats Bar */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        {/* Tabs */}
        <div className="flex items-center bg-panel border border-border rounded-xl p-1">
          <button
            onClick={() => setActiveFilter("all")}
            className={`px-4 py-1.5 rounded-lg text-xs font-body font-medium transition-all ${
              activeFilter === "all"
                ? "bg-accent text-void font-semibold"
                : "text-subtle hover:text-text"
            }`}
          >
            All Galleries ({galleryList.length})
          </button>
          <button
            onClick={() => setActiveFilter("public")}
            className={`px-4 py-1.5 rounded-lg text-xs font-body font-medium transition-all ${
              activeFilter === "public"
                ? "bg-accent text-void font-semibold"
                : "text-subtle hover:text-text"
            }`}
          >
            Public ({galleryList.filter((g) => !g.isAdult).length})
          </button>
          {!adultSettings.hidden && (
            <button
              onClick={() => setActiveFilter("adult")}
              className={`px-4 py-1.5 rounded-lg text-xs font-body font-medium flex items-center gap-1.5 transition-all ${
                activeFilter === "adult"
                  ? "bg-danger text-white font-semibold"
                  : "text-subtle hover:text-text"
              }`}
            >
              <Shield size={12} className={activeFilter === "adult" ? "text-white" : "text-danger"} />
              Adult ({galleryList.filter((g) => g.isAdult).length})
              {isAdultLocked && <Lock size={10} className="text-subtle ml-0.5" />}
            </button>
          )}
        </div>

        {/* Mini stats */}
        <div className="flex items-center gap-4 text-xs font-mono text-subtle">
          <span>Total Photos: <strong className="text-bright">{totalPhotos}</strong></span>
          <span>•</span>
          <span>
            Storage:{" "}
            <strong className="text-teal">
              {photoSettings.configured
                ? `${photoSettings.remoteName} (${photoSettings.isEncrypted ? "Encrypted" : "Direct"})`
                : "Unconfigured"}
            </strong>
          </span>
        </div>
      </div>

      {/* Main Content: Gallery Grid or Empty State */}
      {filteredGalleries.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-12 text-center border-2 border-dashed border-border/80 rounded-3xl bg-panel/20 my-8">
          <div className="w-20 h-20 rounded-3xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent mb-4 shadow-accent-glow">
            <Images size={36} />
          </div>
          <h3 className="font-display text-2xl text-bright tracking-wide mb-1">
            NO PHOTO GALLERIES FOUND
          </h3>
          <p className="font-body text-sm text-subtle max-w-md mb-6">
            Configure your photo storage or local folder, or upload photos directly to your library.
          </p>
          <div className="flex items-center gap-3 flex-wrap justify-center">
            <button
              onClick={() => setIsSetupModalOpen(true)}
              className="px-5 py-2.5 rounded-xl bg-panel hover:bg-muted border border-border text-bright text-xs font-body flex items-center gap-2 transition-all"
            >
              <Folder size={15} className="text-accent" />
              <span>Configure Storage</span>
            </button>

            {photoLibraries.length > 0 && (
              <button
                onClick={handleScanPhotoLibraries}
                disabled={scanState.status === "scanning"}
                className="px-5 py-2.5 rounded-xl bg-panel hover:bg-muted border border-border text-bright text-xs font-body flex items-center gap-2 transition-all disabled:opacity-50"
              >
                <RefreshCw size={14} className={scanState.status === "scanning" ? "animate-spin text-accent" : "text-accent"} />
                <span>Scan Configured Libraries</span>
              </button>
            )}

            <button
              onClick={() => handleOpenNewUpload(false)}
              className="px-6 py-2.5 rounded-xl bg-accent hover:bg-accent-glow text-void font-body text-sm font-semibold flex items-center gap-2 transition-all shadow-accent-glow"
            >
              <Plus size={16} />
              <span>Upload First Gallery</span>
            </button>
            {!adultSettings.hidden && (
              <button
                onClick={() => handleOpenNewUpload(true)}
                className="px-4 py-2.5 rounded-xl bg-panel hover:bg-muted border border-border text-subtle hover:text-danger text-sm font-body flex items-center gap-2 transition-all"
              >
                <Shield size={15} className="text-danger" />
                <span>Upload Adult Gallery</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {filteredGalleries.map((gallery) => (
            <GalleryCard
              key={gallery.id}
              gallery={gallery}
              isLockedAdult={gallery.isAdult && isAdultLocked}
              onOpen={() => handleOpenGallery(gallery)}
              onAddPhotos={() => handleAddPhotosToGallery(gallery.id)}
              onDelete={() => handleDeleteGallery(gallery.id, gallery.title)}
            />
          ))}
        </div>
      )}

      {/* Storage Setup Modal */}
      <AnimatePresence>
        {isSetupModalOpen && (
          <PhotoSetupModal
            isOpen={isSetupModalOpen}
            onClose={() => setIsSetupModalOpen(false)}
            onConfigured={() => handleScanPhotoLibraries()}
          />
        )}
      </AnimatePresence>

      {/* Upload Modal */}
      <AnimatePresence>
        {isUploadModalOpen && (
          <PhotoUploadModal
            isOpen={isUploadModalOpen}
            onClose={() => setIsUploadModalOpen(false)}
            targetGalleryId={targetGalleryId}
            initialIsAdult={uploadInitialAdult}
          />
        )}
      </AnimatePresence>

      {/* Adult PIN Lock Modal when tapping a locked adult gallery */}
      <AnimatePresence>
        {pinPromptGallery && (
          <AdultPinLock
            onUnlocked={handleUnlockSuccess}
            onClose={() => setPinPromptGallery(null)}
          />
        )}
      </AnimatePresence>

      {/* Full-Screen Lightbox Viewer */}
      <AnimatePresence>
        {activeViewerGallery && (
          <PhotoGalleryViewer
            gallery={activeViewerGallery}
            onClose={() => setActiveViewerGallery(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
