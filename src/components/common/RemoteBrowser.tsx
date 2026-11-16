import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Folder, ChevronRight, X, Check, Loader2, AlertCircle, Home, FileArchive,
} from "lucide-react";

type RcloneListItem = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
};

type Props = {
  remoteName: string;
  remoteType: string;
  rcloneConfigPath: string;
  initialPath?: string; // full path e.g. "gdrive:/Movies" or "gdrive:"
  onSelect: (path: string) => void;
  onClose: () => void;
  /** Show files too and let one be picked (used for choosing a backup). */
  fileMode?: boolean;
  /** Only offer files whose name matches, e.g. /\.json(\.gz)?$/ */
  fileFilter?: RegExp;
  selectLabel?: string;
  /** All available remotes to allow switching directly in the modal */
  availableRemotes?: Array<{ name: string; type: string }>;
  onRemoteChange?: (remoteName: string) => void;
};

function parseSegments(path?: string): string[] {
  if (!path) return [];
  const afterColon = path.split(":")[1] ?? "";
  return afterColon.split("/").filter(Boolean);
}

export function RemoteBrowser({
  remoteName,
  remoteType,
  rcloneConfigPath,
  initialPath,
  onSelect,
  onClose,
  fileMode = false,
  fileFilter,
  selectLabel = "Select",
  availableRemotes,
  onRemoteChange,
}: Props) {
  const filteredAvailableRemotes = availableRemotes?.filter(
    (r) => !r.name.startsWith("shared_") && r.name !== "streamtape"
  );
  const initialSafeRemote =
    !remoteName.startsWith("shared_")
      ? { name: remoteName, type: remoteType }
      : filteredAvailableRemotes?.[0] ?? { name: "", type: "" };

  const [selectedRemote, setSelectedRemote] = useState<{ name: string; type: string }>(
    initialSafeRemote
  );

  useEffect(() => {
    if (!remoteName.startsWith("shared_")) {
      setSelectedRemote({ name: remoteName, type: remoteType });
    } else if (filteredAvailableRemotes && filteredAvailableRemotes.length > 0) {
      setSelectedRemote(filteredAvailableRemotes[0]);
    }
  }, [remoteName, remoteType]);

  const [segments, setSegments] = useState<string[]>(parseSegments(initialPath));
  const [items, setItems] = useState<RcloneListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentPath =
    segments.length > 0
      ? `${selectedRemote.name}:/${segments.join("/")}`
      : `${selectedRemote.name}:`;

  const handleRemoteChange = (name: string) => {
    if (name.startsWith("shared_")) return;
    const found = filteredAvailableRemotes?.find((r) => r.name === name);
    if (found) {
      setSelectedRemote(found);
      setSegments([]);
      onRemoteChange?.(found.name);
    }
  };

  useEffect(() => {
    if (!selectedRemote.name || selectedRemote.name.startsWith("shared_")) {
      setError("Browsing shared Guest Pass remotes is not permitted.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<RcloneListItem[]>("list_remote_path", {
      configPath: rcloneConfigPath,
      remotePath: currentPath,
    })
      .then((result) => {
        if (cancelled) return;
        setItems(
          result.filter((i) => {
            if (i.is_dir) return true;
            if (!fileMode) return false;
            return fileFilter ? fileFilter.test(i.name) : true;
          })
        );
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [currentPath, fileMode, fileFilter]);

  const navigateInto = (name: string) => setSegments([...segments, name]);
  const navigateToIndex = (i: number) => setSegments(segments.slice(0, i + 1));
  const navigateToRoot = () => setSegments([]);

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-surface border border-border rounded-2xl w-full max-w-lg flex flex-col shadow-card-hover"
        style={{ maxHeight: "72vh" }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-border">
          <div className="flex-1 min-w-0">
            {filteredAvailableRemotes && filteredAvailableRemotes.length > 1 ? (
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-subtle font-heading font-medium text-xs">Remote:</span>
                <select
                  value={selectedRemote.name}
                  onChange={(e) => handleRemoteChange(e.target.value)}
                  className="bg-panel border border-border text-white text-xs font-heading font-semibold rounded-md px-2.5 py-1 focus:outline-none focus:border-accent cursor-pointer"
                >
                  {filteredAvailableRemotes.map((r) => (
                    <option key={r.name} value={r.name} className="bg-surface text-text">
                      ☁️ {r.name} ({r.type})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="text-text font-body font-semibold text-sm">
                {selectedRemote.name}:{" "}
                <span className="text-subtle font-normal">({selectedRemote.type})</span>
              </p>
            )}
            {/* Breadcrumb */}
            <div className="flex items-center gap-0.5 mt-1.5 flex-wrap">
              <button
                onClick={navigateToRoot}
                className="flex items-center gap-1 text-accent hover:text-accent-glow text-xs font-body transition-colors"
              >
                <Home size={11} />
                root
              </button>
              {segments.map((seg, i) => (
                <span key={i} className="flex items-center gap-0.5">
                  <ChevronRight size={11} className="text-border flex-shrink-0" />
                  <button
                    onClick={() => navigateToIndex(i)}
                    className={`text-xs font-body transition-colors truncate max-w-[120px] ${
                      i === segments.length - 1
                        ? "text-text cursor-default"
                        : "text-accent hover:text-accent-glow"
                    }`}
                  >
                    {seg}
                  </button>
                </span>
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-subtle hover:text-text transition-colors ml-3 flex-shrink-0 mt-0.5"
          >
            <X size={18} />
          </button>
        </div>

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="text-accent animate-spin" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2 px-4">
              <AlertCircle size={20} className="text-danger" />
              <p className="text-danger font-body text-xs text-center">{error}</p>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-1 text-center">
              <p className="text-subtle font-body text-sm">Nothing here</p>
              {fileMode && (
                <p className="text-subtle/70 font-body text-xs">
                  No matching backup files found in this directory.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-0.5">
              {items.map((item) => (
                <button
                  key={item.name}
                  onClick={() =>
                    item.is_dir
                      ? navigateInto(item.name)
                      : onSelect(`${currentPath.replace(/\/$/, "")}/${item.name}`)
                  }
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-panel text-left transition-colors group"
                >
                  {item.is_dir ? (
                    <Folder size={15} className="text-accent/60 flex-shrink-0" />
                  ) : (
                    <FileArchive size={15} className="text-teal/70 flex-shrink-0" />
                  )}
                  <span className="font-body text-sm text-text flex-1 truncate">
                    {item.name}
                  </span>
                  {item.is_dir ? (
                    <ChevronRight
                      size={13}
                      className="text-subtle opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    />
                  ) : (
                    <span className="text-subtle font-mono text-[10px] flex-shrink-0">
                      {(item.size / 1024).toFixed(0)} KB
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {!fileMode ? (
          <div className="px-5 py-3 border-t border-border flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-subtle font-body text-[10px] uppercase tracking-wider mb-0.5">
                Selected folder
              </p>
              <p className="text-text font-mono text-xs truncate">{currentPath}</p>
            </div>
            <button
              onClick={() => onSelect(currentPath)}
              className="btn-primary flex items-center gap-1.5 text-sm py-2 px-4 flex-shrink-0"
            >
              <Check size={14} />
              {selectLabel}
            </button>
          </div>
        ) : (
          <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-3">
            <p className="text-subtle font-body text-xs">
              Click a backup file (<span className="font-mono text-teal">.json.gz</span>) above to restore.
            </p>
            <button
              onClick={onClose}
              className="btn-ghost text-xs py-1.5 px-3"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
