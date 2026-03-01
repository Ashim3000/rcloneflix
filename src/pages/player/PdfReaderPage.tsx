import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { MediaItem } from "../../store/appStore";
import { useAppStore } from "../../store/appStore";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

// Vite resolves this new URL() at build time and bundles the worker asset
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).href;

type PDFDoc = PDFDocumentProxy;
type PDFPage = PDFPageProxy;

export function PdfReaderPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { item } = (location.state ?? {}) as { item: MediaItem };
  const { rcloneConfigPath, updateWatchProgress, watchProgress } = useAppStore();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfRef = useRef<PDFDoc | null>(null);
  const sessionId = useRef(`pdf-${Date.now()}`);

  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [rendering, setRendering] = useState(false);

  // Download the PDF to a temp file and get a file:// URL.
  useEffect(() => {
    if (!item) return;

    invoke<string>("download_book_to_temp", {
      configPath: rcloneConfigPath,
      remotePath: item.remotePath,
      sessionId: sessionId.current,
    })
      .then((localUrl) => { setStreamUrl(localUrl); setDownloading(false); })
      .catch((e) => { setError(String(e)); setDownloading(false); });

    return () => {
      invoke("cleanup_book_temp", { sessionId: sessionId.current }).catch(() => {});
    };
  }, [item?.id]);

  // Load PDF
  useEffect(() => {
    if (!streamUrl) return;

    pdfjsLib
      .getDocument(streamUrl)
      .promise.then((pdf) => {
        pdfRef.current = pdf;
        setTotalPages(pdf.numPages);

        // Restore page
        const existing = watchProgress[item.id];
        const startPage = existing?.position ? Math.floor(existing.position) : 1;
        setCurrentPage(Math.min(startPage, pdf.numPages));
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [streamUrl]);

  // Render page
  useEffect(() => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas || loading) return;

    setRendering(true);
    pdf.getPage(currentPage).then((page) => {
      const viewport = page.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return page.render({ canvasContext: ctx, viewport }).promise;
    }).then(() => {
      setRendering(false);
      // Save progress
      updateWatchProgress({
        itemId: item.id,
        position: currentPage,
        duration: totalPages,
        completed: currentPage >= totalPages,
        lastWatchedAt: Date.now(),
      });
    }).catch(() => setRendering(false));
  }, [currentPage, scale, loading]);

  const goTo = (page: number) => {
    setCurrentPage(Math.max(1, Math.min(totalPages, page)));
  };

  if (!item) return null;

  return (
    <div className="fixed inset-0 bg-[#2a2a2a] flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-6 py-3 bg-surface border-b border-border flex-shrink-0">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-subtle hover:text-text transition-colors"
        >
          <ArrowLeft size={18} />
          <span className="font-body text-sm">Back</span>
        </button>

        <div className="flex items-center gap-4">
          <button onClick={() => goTo(currentPage - 1)} disabled={currentPage <= 1} className="text-subtle hover:text-text disabled:opacity-30 transition-colors">
            <ChevronLeft size={20} />
          </button>
          <span className="text-text font-body text-sm">
            {currentPage} / {totalPages}
          </span>
          <button onClick={() => goTo(currentPage + 1)} disabled={currentPage >= totalPages} className="text-subtle hover:text-text disabled:opacity-30 transition-colors">
            <ChevronRight size={20} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setScale((s) => Math.max(0.5, s - 0.2))} className="text-subtle hover:text-text transition-colors">
            <ZoomOut size={18} />
          </button>
          <span className="text-subtle font-mono text-xs">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale((s) => Math.min(3, s + 0.2))} className="text-subtle hover:text-text transition-colors">
            <ZoomIn size={18} />
          </button>
        </div>
      </div>

      {/* PDF viewport */}
      <div className="flex-1 overflow-auto flex items-start justify-center p-6 relative">
        {(downloading || loading || rendering) && (
          <div className="absolute inset-0 flex items-center justify-center flex-col gap-3">
            <Loader2 size={32} className="text-accent animate-spin" />
            {downloading && (
              <p className="font-body text-sm text-subtle">Downloading…</p>
            )}
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-danger font-body text-sm">{error}</p>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="shadow-2xl"
          style={{ display: loading ? "none" : "block" }}
        />
      </div>

      {/* Page input */}
      <div className="flex items-center justify-center gap-2 py-3 border-t border-border bg-surface">
        <span className="text-subtle font-body text-xs">Go to page:</span>
        <input
          type="number"
          min={1}
          max={totalPages}
          value={currentPage}
          onChange={(e) => { const n = parseInt(e.target.value); if (!isNaN(n)) goTo(n); }}
          className="w-16 bg-panel border border-border rounded px-2 py-1 text-text text-xs font-mono text-center outline-none focus:border-accent"
        />
      </div>
    </div>
  );
}
