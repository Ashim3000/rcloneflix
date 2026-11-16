import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCcw,
  Info, ExternalLink, ShieldCheck, HardDrive, Loader2, Download,
  Sparkles, Layers, LayoutGrid
} from "lucide-react";
import { useAppStore, type PhotoGallery, type GalleryPhoto } from "../../store/appStore";
import {
  loadAndDecryptVaultPhoto,
  prefetchVaultPhoto,
  downloadDecryptedPhoto,
  batchPreparePhotos,
} from "../../lib/photoVault";
import { getSessionPin, PUBLIC_VAULT_KEY } from "../../lib/pin";

type Props = {
  gallery: PhotoGallery;
  initialIndex?: number;
  onClose: () => void;
};

function ThumbnailItem({
  photo,
  idx,
  isSelected,
  onClick,
  rcloneConfigPath,
  pin,
  shouldLoad,
}: {
  photo: GalleryPhoto;
  idx: number;
  isSelected: boolean;
  onClick: () => void;
  rcloneConfigPath: string;
  pin: string;
  shouldLoad: boolean;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldLoad || thumbUrl) return;
    let cancelled = false;
    loadAndDecryptVaultPhoto(photo, rcloneConfigPath, pin, false)
      .then((url) => {
        if (!cancelled) setThumbUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [photo.id, rcloneConfigPath, pin, shouldLoad, thumbUrl]);

  return (
    <button
      onClick={onClick}
      className={`h-14 w-14 rounded-lg overflow-hidden flex-shrink-0 border-2 transition-all flex items-center justify-center font-mono text-xs ${
        isSelected
          ? "border-accent shadow-accent-glow scale-105"
          : "border-border/60 hover:border-subtle opacity-60 hover:opacity-100"
      } bg-panel relative`}
      title={`Photo #${idx + 1}: ${photo.filename}`}
    >
      {thumbUrl ? (
        <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        <span className="text-subtle font-mono text-[11px]">#{idx + 1}</span>
      )}
    </button>
  );
}

const VIEW_MODE_KEY = "rcloneflix_photo_view_mode";

/** Lazy grid tile: only decrypts/loads once it scrolls near the viewport. */
function GridTile({
  photo,
  idx,
  rcloneConfigPath,
  pin,
  onOpen,
}: {
  photo: GalleryPhoto;
  idx: number;
  rcloneConfigPath: string;
  pin: string;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || thumbUrl) return;
    let cancelled = false;
    loadAndDecryptVaultPhoto(photo, rcloneConfigPath, pin, false)
      .then((url) => {
        if (!cancelled) setThumbUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, photo.id, rcloneConfigPath, pin, thumbUrl]);

  return (
    <button
      ref={ref}
      onClick={onOpen}
      title={`Photo #${idx + 1}: ${photo.filename}`}
      className="aspect-square rounded-lg overflow-hidden bg-panel border border-border hover:border-accent transition-colors flex items-center justify-center cursor-pointer"
    >
      {thumbUrl ? (
        <img src={thumbUrl} alt="" loading="lazy" className="w-full h-full object-cover" />
      ) : (
        <span className="text-subtle font-mono text-[11px]">{failed ? "!" : `#${idx + 1}`}</span>
      )}
    </button>
  );
}

export function PhotoGalleryViewer({ gallery, initialIndex = 0, onClose }: Props) {
  const { rcloneConfigPath, localStorageCapMb } = useAppStore();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  // Default = grid. "lightbox" only if the user explicitly chose it via the toggle.
  const [mode, setMode] = useState<"grid" | "lightbox">(() => {
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === "lightbox" ? "lightbox" : "grid";
    } catch {
      return "grid";
    }
  });
  const chooseMode = (m: "grid" | "lightbox") => {
    setMode(m);
    try {
      localStorage.setItem(VIEW_MODE_KEY, m);
    } catch {}
  };
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [viewOriginal, setViewOriginal] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const currentPhoto: GalleryPhoto | undefined = gallery.photos[currentIndex];
  const pin = gallery.isAdult
    ? (getSessionPin() || "rcloneflix-adult-vault-standard")
    : PUBLIC_VAULT_KEY;

  // Reset viewOriginal on index change unless photo only has original
  useEffect(() => {
    if (currentPhoto && !currentPhoto.remotePreviewPath && currentPhoto.remoteOriginalPath) {
      setViewOriginal(true);
    } else {
      setViewOriginal(false);
    }
  }, [currentIndex, currentPhoto]);

  // Load current photo and prefetch adjacent photos
  const loadPhoto = useCallback(async (index: number, forceOrig: boolean) => {
    const photo = gallery.photos[index];
    if (!photo) return;

    setIsLoading(true);
    setError(null);

    try {
      const url = await loadAndDecryptVaultPhoto(
        photo,
        rcloneConfigPath,
        pin,
        forceOrig,
        localStorageCapMb
      );
      setCurrentUrl(url);
      setIsLoading(false);

      // Background prefetch next 2 and previous 1 photo previews into RAM/disk
      if (index + 1 < gallery.photos.length) {
        const next = gallery.photos[index + 1];
        prefetchVaultPhoto(next, rcloneConfigPath, pin, false, localStorageCapMb).catch(() => {});
      }
      if (index + 2 < gallery.photos.length) {
        const next2 = gallery.photos[index + 2];
        prefetchVaultPhoto(next2, rcloneConfigPath, pin, false, localStorageCapMb).catch(() => {});
      }
      if (index - 1 >= 0) {
        const prev = gallery.photos[index - 1];
        prefetchVaultPhoto(prev, rcloneConfigPath, pin, false, localStorageCapMb).catch(() => {});
      }
    } catch (err: any) {
      console.error("Failed to load photo:", err);
      setError("Failed to decrypt photo: " + (err.message || String(err)));
      setIsLoading(false);
    }
  }, [gallery.photos, pin, rcloneConfigPath, localStorageCapMb]);

  useEffect(() => {
    if (mode !== "lightbox") return; // grid mode must not decrypt a full-size photo
    setZoom(1);
    setPan({ x: 0, y: 0 });
    loadPhoto(currentIndex, viewOriginal);
  }, [currentIndex, viewOriginal, loadPhoto, mode]);

  // Background prepare all gallery photos via native Rust - removed eager mount load to prevent memory freezing
  // Prefetching is now lazily driven by thumbnail viewport windowing and adjacent slide prefetch

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowRight") {
        if (currentIndex < gallery.photos.length - 1) {
          setCurrentIndex((prev) => prev + 1);
        }
      } else if (e.key === "ArrowLeft") {
        if (currentIndex > 0) {
          setCurrentIndex((prev) => prev - 1);
        }
      } else if (e.key === "+" || e.key === "=") {
        setZoom((z) => Math.min(z + 0.25, 3));
      } else if (e.key === "-" || e.key === "_") {
        setZoom((z) => Math.max(z - 0.25, 0.75));
      } else if (e.key === "0" || e.key === "r") {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      } else if (e.key === "i") {
        setShowInfo((s) => !s);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentIndex, gallery.photos.length, onClose]);

  const handlePrev = () => {
    if (currentIndex > 0) setCurrentIndex((i) => i - 1);
  };

  const handleNext = () => {
    if (currentIndex < gallery.photos.length - 1) setCurrentIndex((i) => i + 1);
  };

  const handleZoomIn = () => setZoom((z) => Math.min(z + 0.25, 3));
  const handleZoomOut = () => setZoom((z) => Math.max(z - 0.25, 0.75));
  const handleZoomReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Pan / Drag handlers when zoomed in
  const onMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || zoom <= 1) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPan({
      x: dragStart.current.panX + dx,
      y: dragStart.current.panY + dy,
    });
  };

  const onMouseUp = () => setIsDragging(false);

  const handleDownload = async () => {
    if (!currentPhoto) return;
    try {
      await downloadDecryptedPhoto(
        currentPhoto,
        rcloneConfigPath,
        pin,
        viewOriginal || !currentPhoto.remotePreviewPath
      );
    } catch (err: any) {
      console.error("Download failed:", err);
    }
  };

  if (mode === "grid") {
    return (
      <div className="fixed inset-0 bg-void z-50 flex flex-col select-none overflow-hidden">
        <div className="h-16 px-6 border-b border-border bg-surface flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-4 min-w-0">
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-subtle hover:text-text hover:bg-panel transition-all cursor-pointer"
              title="Close (Esc)"
            >
              <X size={20} />
            </button>
            <div className="min-w-0">
              <h3 className="text-bright font-display text-lg tracking-wide flex items-center gap-2 truncate">
                {gallery.title}
                {gallery.isAdult && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-danger/20 text-danger border border-danger/30">
                    ADULT
                  </span>
                )}
              </h3>
              <p className="text-subtle font-mono text-xs">{gallery.photos.length} photos</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="p-2 rounded-xl border bg-accent/10 border-accent text-accent cursor-pointer"
              title="Grid view"
            >
              <LayoutGrid size={18} />
            </button>
            <button
              onClick={() => chooseMode("lightbox")}
              className="p-2 rounded-xl border bg-panel border-border text-subtle hover:text-text transition-all cursor-pointer"
              title="Lightbox / slideshow view"
            >
              <Layers size={18} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
            {gallery.photos.map((p, idx) => (
              <GridTile
                key={p.id}
                photo={p}
                idx={idx}
                rcloneConfigPath={rcloneConfigPath}
                pin={pin}
                onOpen={() => {
                  setCurrentIndex(idx);
                  setMode("lightbox"); // open this photo; does NOT change the saved default
                }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-void z-50 flex flex-col select-none overflow-hidden"
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {/* Top Header Controls */}
      <div className="h-16 px-6 border-b border-border bg-surface flex items-center justify-between z-10">
        <div className="flex items-center gap-4">
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-subtle hover:text-text hover:bg-panel transition-all"
            title="Close viewer (Esc)"
          >
            <X size={20} />
          </button>

          <div>
            <h3 className="text-bright font-display text-lg tracking-wide flex items-center gap-2">
              {gallery.title}
              {gallery.isAdult && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-danger/20 text-danger border border-danger/30">
                  ADULT
                </span>
              )}
            </h3>
            <p className="text-subtle font-mono text-xs">
              {currentIndex + 1} / {gallery.photos.length} • {currentPhoto?.filename}
            </p>
          </div>
        </div>

        {/* Action icons */}
        <div className="flex items-center gap-2.5">
          {/* HD Original toggle if original exists */}
          {currentPhoto?.remoteOriginalPath && currentPhoto?.remotePreviewPath && (
            <button
              onClick={() => setViewOriginal(!viewOriginal)}
              className={`px-3 py-1.5 rounded-xl border text-xs font-mono font-medium flex items-center gap-1.5 transition-all ${
                viewOriginal
                  ? "bg-accent text-void border-accent font-bold shadow-accent-glow"
                  : "bg-panel border-border text-subtle hover:text-bright hover:border-accent/40"
              }`}
              title={viewOriginal ? "Viewing lossless full-res original. Click for WebP preview." : "Viewing WebP preview. Click to load lossless original."}
            >
              <Sparkles size={13} />
              <span>{viewOriginal ? "HD Original" : "Fast Preview"}</span>
            </button>
          )}

          {/* Zoom controls */}
          <div className="flex items-center bg-panel border border-border rounded-xl p-1">
            <button
              onClick={handleZoomOut}
              disabled={zoom <= 0.75}
              className="p-1.5 rounded-lg text-subtle hover:text-bright disabled:opacity-40 transition-colors"
              title="Zoom out (-)"
            >
              <ZoomOut size={16} />
            </button>
            <span className="text-xs font-mono text-subtle px-2 min-w-[3rem] text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={handleZoomIn}
              disabled={zoom >= 3}
              className="p-1.5 rounded-lg text-subtle hover:text-bright disabled:opacity-40 transition-colors"
              title="Zoom in (+)"
            >
              <ZoomIn size={16} />
            </button>
            {zoom !== 1 && (
              <button
                onClick={handleZoomReset}
                className="p-1.5 ml-1 rounded-lg text-subtle hover:text-accent transition-colors"
                title="Reset zoom (0)"
              >
                <RotateCcw size={14} />
              </button>
            )}
          </div>

          <button
            onClick={() => chooseMode("grid")}
            className="p-2 rounded-xl border bg-panel border-border text-subtle hover:text-text transition-all cursor-pointer"
            title="Back to grid view"
          >
            <LayoutGrid size={18} />
          </button>

          <button
            onClick={() => setShowInfo(!showInfo)}
            className={`p-2 rounded-xl border transition-all ${
              showInfo
                ? "bg-accent/10 border-accent text-accent"
                : "bg-panel border-border text-subtle hover:text-text"
            }`}
            title="Toggle details (I)"
          >
            <Info size={18} />
          </button>

          <button
            onClick={handleDownload}
            className="p-2 rounded-xl bg-panel border border-border text-subtle hover:text-accent hover:border-accent/40 transition-all"
            title={currentPhoto?.remoteOriginalPath ? "Download decrypted original file" : "Download decrypted photo"}
          >
            <Download size={18} />
          </button>
        </div>
      </div>

      {/* Main View Area */}
      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        {/* Previous Button */}
        {currentIndex > 0 && (
          <button
            onClick={handlePrev}
            className="absolute left-6 z-20 p-3.5 rounded-2xl bg-panel hover:bg-panel border border-border text-subtle hover:text-bright hover:border-accent/40 transition-all shadow-xl active:scale-95"
            title="Previous (Left Arrow)"
          >
            <ChevronLeft size={24} />
          </button>
        )}

        {/* Next Button */}
        {currentIndex < gallery.photos.length - 1 && (
          <button
            onClick={handleNext}
            className="absolute right-6 z-20 p-3.5 rounded-2xl bg-panel hover:bg-panel border border-border text-subtle hover:text-bright hover:border-accent/40 transition-all shadow-xl active:scale-95"
            title="Next (Right Arrow)"
          >
            <ChevronRight size={24} />
          </button>
        )}

        {/* Image Content */}
        <div
          className={`w-full h-full flex items-center justify-center p-6 ${
            zoom > 1 ? "cursor-grab active:cursor-grabbing" : ""
          }`}
          onMouseDown={onMouseDown}
        >
          {isLoading ? (
            <div className="flex flex-col items-center gap-3 text-subtle">
              <Loader2 size={36} className="animate-spin text-accent" />
              <span className="font-body text-xs font-medium">
                Fetching & Decrypting {viewOriginal ? "HD Original" : "in Memory"}...
              </span>
            </div>
          ) : error ? (
            <div className="text-center p-6 rounded-2xl bg-danger/10 border border-danger/30 text-danger max-w-md">
              <p className="font-body text-sm font-semibold">{error}</p>
            </div>
          ) : currentUrl ? (
            <motion.img
              key={`${currentPhoto?.id}-${viewOriginal ? "orig" : "prev"}`}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{
                opacity: 1,
                scale: zoom,
                x: pan.x,
                y: pan.y,
              }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              src={currentUrl}
              alt={currentPhoto?.filename}
              className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl pointer-events-none select-none"
              draggable={false}
            />
          ) : null}
        </div>

        {/* Details Side Drawer */}
        <AnimatePresence>
          {showInfo && currentPhoto && (
            <motion.div
              initial={{ x: 320, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 320, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute right-0 top-0 bottom-0 w-80 bg-surface border-l border-border p-6 shadow-2xl z-30 flex flex-col space-y-5 overflow-y-auto"
            >
              <div className="flex items-center justify-between pb-3 border-b border-border">
                <h4 className="font-display text-xl text-bright">PHOTO DETAILS</h4>
                <button
                  onClick={() => setShowInfo(false)}
                  className="text-subtle hover:text-text p-1"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Storage / Security Badge */}
              <div className="p-3.5 rounded-xl bg-accent/10 border border-accent/20 flex items-start gap-3">
                <ShieldCheck size={20} className="text-accent flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-semibold text-bright font-body">
                    {gallery.remoteName?.toLowerCase().includes("crypt")
                      ? "Rclone Crypt Protected"
                      : "Direct Storage"}
                  </div>
                  <div className="text-[11px] text-subtle font-body mt-0.5">
                    {gallery.remoteName?.toLowerCase().includes("crypt")
                      ? "Encrypted transparently by Rclone AES-256 backend."
                      : "Stored as standard media on your cloud remote or local folder."}
                  </div>
                </div>
              </div>

              {/* Metadata details */}
              <div className="space-y-3 font-body text-xs">
                <div>
                  <span className="text-subtle block uppercase tracking-wider text-[10px]">Filename</span>
                  <span className="text-bright font-mono break-all">{currentPhoto.filename}</span>
                </div>

                {currentPhoto.storageMode && (
                  <div>
                    <span className="text-subtle block uppercase tracking-wider text-[10px]">Storage Mode</span>
                    <span className="text-accent font-mono capitalize">
                      {currentPhoto.storageMode === "both"
                        ? "Both (Original + WebP)"
                        : currentPhoto.storageMode === "original"
                        ? "Original Quality"
                        : "Compressed WebP"}
                    </span>
                  </div>
                )}

                <div>
                  <span className="text-subtle block uppercase tracking-wider text-[10px]">Size</span>
                  <div className="space-y-0.5 mt-0.5">
                    <span className="text-bright font-mono block">
                      Preview: {(currentPhoto.sizeBytes / 1024).toFixed(1)} KB
                    </span>
                    {currentPhoto.originalSizeBytes && (
                      <span className="text-subtle font-mono block">
                        Original: {(currentPhoto.originalSizeBytes / 1024 / 1024).toFixed(2)} MB
                      </span>
                    )}
                  </div>
                </div>

                {currentPhoto.width && currentPhoto.height && (
                  <div>
                    <span className="text-subtle block uppercase tracking-wider text-[10px]">Resolution</span>
                    <span className="text-bright font-mono">
                      {currentPhoto.width} × {currentPhoto.height} px
                    </span>
                  </div>
                )}

                <div>
                  <span className="text-subtle block uppercase tracking-wider text-[10px]">Uploaded At</span>
                  <span className="text-bright">
                    {new Date(currentPhoto.uploadedAt).toLocaleString()}
                  </span>
                </div>

                {currentPhoto.remotePreviewPath && (
                  <div>
                    <span className="text-subtle block uppercase tracking-wider text-[10px] flex items-center gap-1">
                      <HardDrive size={11} className="text-teal" /> Remote Preview
                    </span>
                    <span className="text-bright font-mono text-[11px] break-all block mt-1">
                      {currentPhoto.remotePreviewPath}
                    </span>
                  </div>
                )}

                {currentPhoto.remoteOriginalPath && (
                  <div>
                    <span className="text-subtle block uppercase tracking-wider text-[10px] flex items-center gap-1">
                      <Sparkles size={11} className="text-accent" /> Remote Original
                    </span>
                    <span className="text-bright font-mono text-[11px] break-all block mt-1">
                      {currentPhoto.remoteOriginalPath}
                    </span>
                  </div>
                )}

                {currentPhoto.arweaveId && (
                  <div className="pt-2 border-t border-border/50">
                    <span className="text-subtle block uppercase tracking-wider text-[10px]">Legacy Arweave ID</span>
                    <span className="text-bright font-mono text-[11px] break-all block mt-1">
                      {currentPhoto.arweaveId}
                    </span>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom Thumbnail Strip */}
      <div className="h-20 px-6 border-t border-border bg-surface flex items-center gap-2 overflow-x-auto z-10 py-2">
        {gallery.photos.map((p, idx) => (
          <ThumbnailItem
            key={p.id}
            photo={p}
            idx={idx}
            isSelected={idx === currentIndex}
            onClick={() => setCurrentIndex(idx)}
            rcloneConfigPath={rcloneConfigPath}
            pin={pin}
            shouldLoad={Math.abs(idx - currentIndex) <= 6}
          />
        ))}
      </div>
    </div>
  );
}
