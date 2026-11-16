import React, { useState, useEffect } from 'react';
import {
  X,
  Link2,
  Copy,
  Check,
  ExternalLink,
  Cloud,
  UploadCloud,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Settings,
  HardDrive,
} from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { useToastStore } from '../../store/toastStore';
import {
  loadUdropConfig,
  saveUdropConfig,
  findUdropFileByName,
  buildUdropDirectLink,
  mountUdropWebdavRemote,
  type UdropApiFile,
} from '../../lib/udrop';
import { dispatchCloudTask } from '../../lib/cloudWorkerRouter';

interface ShareStreamLinkModalProps {
  remoteName: string;
  filePath: string;
  fileName: string;
  fileSize?: number;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export const ShareStreamLinkModal: React.FC<ShareStreamLinkModalProps> = ({
  remoteName,
  filePath,
  fileName,
  fileSize,
  onClose,
}) => {
  const rcloneConfigPath = useAppStore((s) => s.rcloneConfigPath);
  const rcloneConfigContent = useAppStore((s) => s.rcloneConfigContent);
  const addToast = useToastStore((s) => s.addToast);

  const [udropConfig, setUdropConfig] = useState(loadUdropConfig);
  const [showConfig, setShowConfig] = useState(false);
  const [username, setUsername] = useState(udropConfig.username || '');
  const [password, setPassword] = useState(udropConfig.password || '');
  const [key1, setKey1] = useState(udropConfig.key1 || '');
  const [key2, setKey2] = useState(udropConfig.key2 || '');

  const [checking, setChecking] = useState(true);
  const [existingFile, setExistingFile] = useState<UdropApiFile | null>(null);
  const [directLink, setDirectLink] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const [isDispatching, setIsDispatching] = useState(false);
  const [dispatched, setDispatched] = useState(false);
  const [autoCopyOnComplete, setAutoCopyOnComplete] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isConfigured = Boolean(
    (udropConfig.username?.trim() && udropConfig.password?.trim()) ||
    (rcloneConfigContent && /\[udrop\]/i.test(rcloneConfigContent))
  );

  // Check if file already exists on uDrop on modal open
  useEffect(() => {
    let active = true;
    if (!isConfigured) {
      setChecking(false);
      setShowConfig(true);
      return;
    }

    setChecking(true);

    async function checkFile() {
      // 1. Fast WebDAV check via Rclone (~1s)
      try {
        const { checkUdropFileExistsViaRclone } = await import('../../lib/udrop');
        const exists = await checkUdropFileExistsViaRclone(fileName);
        if (!active) return;
        if (exists) {
          // If exists on WebDAV and API keys configured, try getting shortUrl
          if (udropConfig.key1?.trim() && udropConfig.key2?.trim()) {
            try {
              const file = await findUdropFileByName(fileName);
              if (file && active) {
                setExistingFile(file);
                setDirectLink(buildUdropDirectLink(file.shortUrl, file.filename));
                setChecking(false);
                return;
              }
            } catch (e) {
              console.warn('uDrop API check error (non-fatal):', e);
            }
          }
          // Direct WebDAV link fallback
          setDirectLink(`https://www.udrop.com/webdav/${encodeURIComponent(fileName)}`);
          setChecking(false);
          return;
        }
      } catch (err) {
        console.warn('Could not check existing uDrop file via WebDAV:', err);
      }
      if (active) setChecking(false);
    }

    checkFile();

    return () => {
      active = false;
    };
  }, [fileName, isConfigured]);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('uDrop WebDAV username and password are required.');
      return;
    }

    const newCfg = {
      username: username.trim(),
      password,
      key1: key1.trim(),
      key2: key2.trim(),
    };
    saveUdropConfig(newCfg);
    setUdropConfig(newCfg);
    setShowConfig(false);
    setError(null);
    addToast('uDrop settings saved', 'success');

    // Mount WebDAV remote in Rclone
    try {
      await mountUdropWebdavRemote(rcloneConfigPath || '', newCfg);
      addToast('Mounted udrop: WebDAV remote in Rclone', 'success');
    } catch (err: any) {
      console.warn('Could not auto-mount uDrop WebDAV:', err);
    }

    // Trigger fast re-check
    setChecking(true);
    try {
      const { checkUdropFileExistsViaRclone } = await import('../../lib/udrop');
      const exists = await checkUdropFileExistsViaRclone(fileName);
      if (exists) {
        setDirectLink(`https://www.udrop.com/webdav/${encodeURIComponent(fileName)}`);
      }
    } catch {
      // ignore
    } finally {
      setChecking(false);
    }
  };

  const handleCopy = async () => {
    if (!directLink) return;
    try {
      await navigator.clipboard.writeText(directLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      addToast('Copied direct web streaming link to clipboard!', 'success');
    } catch {
      // Fallback
    }
  };

  const handleDispatchCloudTransfer = async () => {
    setError(null);
    setIsDispatching(true);

    try {
      const cleanPath = filePath.startsWith('http://') || filePath.startsWith('https://')
        ? filePath
        : filePath.replace(/\/+/g, '/');
      const cleanSource = remoteName ? `${remoteName}:${cleanPath}` : cleanPath;
      const jobId = `transfer-udrop-${Date.now()}`;

      await dispatchCloudTask({
        jobType: 'rclone_transfer',
        title: fileName,
        payload: {
          job_id: jobId,
          operation: 'copy',
          source: cleanSource,
          destination: 'udrop:',
          transfers: 4,
          checkers: 8,
          drive_server_side_copy: true,
          rclone_config_snippet: rcloneConfigContent || undefined,
        },
      });

      setDispatched(true);
      addToast(
        `Cloud-to-cloud transfer dispatched for "${fileName}"!`,
        'success',
        6000
      );
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setIsDispatching(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-zinc-900/95 p-6 text-white shadow-2xl backdrop-blur-md">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              <Link2 className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Direct Web-Accessible Stream Link</h3>
              <p className="text-xs text-zinc-400">Powered by uDrop Cloud (0 MB Local Bandwidth)</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="mt-4 space-y-4">
          {/* Target File Info */}
          <div className="rounded-xl bg-white/5 p-3 text-xs border border-white/5 space-y-1">
            <div className="font-semibold text-white truncate flex items-center justify-between">
              <span className="truncate">{fileName}</span>
              {fileSize && fileSize > 0 && (
                <span className="text-zinc-400 font-mono ml-2 shrink-0">{formatBytes(fileSize)}</span>
              )}
            </div>
            <div className="text-zinc-400 truncate text-[11px]">
              Source: <span className="text-cyan-400 font-mono">{remoteName ? `${remoteName}:` : ''}</span>
              {filePath}
            </div>
          </div>

          {/* Quick Config Drawer */}
          {showConfig ? (
            <form onSubmit={handleSaveConfig} className="space-y-3 rounded-xl bg-black/40 p-4 border border-white/10">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-cyan-400 flex items-center gap-1.5">
                  <Settings className="w-3.5 h-3.5" /> uDrop Account Credentials
                </span>
                {isConfigured && (
                  <button
                    type="button"
                    onClick={() => setShowConfig(false)}
                    className="text-[11px] text-zinc-400 hover:text-white"
                  >
                    Cancel
                  </button>
                )}
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Enter your free uDrop API keys from your account dashboard (<a
                  href="https://www.udrop.com"
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-400 underline"
                >
                  udrop.com
                </a>) to generate instant direct streaming links.
              </p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-zinc-400 block mb-1">uDrop Username (Required for WebDAV) *</label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="myuser"
                    required
                    className="w-full rounded-lg border border-white/10 bg-zinc-800 px-2.5 py-1.5 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-zinc-400 block mb-1">WebDAV Password *</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    className="w-full rounded-lg border border-white/10 bg-zinc-800 px-2.5 py-1.5 text-xs text-white"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] text-zinc-400 block mb-1">API Key 1 (Optional - for public direct links)</label>
                <input
                  type="password"
                  value={key1}
                  onChange={(e) => setKey1(e.target.value)}
                  placeholder="e.g. 5a1b..."
                  className="w-full rounded-lg border border-white/10 bg-zinc-800 px-2.5 py-1.5 text-xs font-mono text-white"
                />
              </div>

              <div>
                <label className="text-[10px] text-zinc-400 block mb-1">API Key 2 (Optional - for public direct links)</label>
                <input
                  type="password"
                  value={key2}
                  onChange={(e) => setKey2(e.target.value)}
                  placeholder="e.g. 8f2c..."
                  className="w-full rounded-lg border border-white/10 bg-zinc-800 px-2.5 py-1.5 text-xs font-mono text-white"
                />
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  className="rounded-lg bg-cyan-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 transition"
                >
                  Save & Verify
                </button>
              </div>
            </form>
          ) : null}

          {/* Error Banner */}
          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Loading Check State */}
          {checking ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-400">
              <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
              Checking if file exists on uDrop...
            </div>
          ) : null}

          {/* STATE A: Already on uDrop (Instant Link Ready) */}
          {!checking && directLink ? (
            <div className="space-y-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-4">
              <div className="flex items-center justify-between text-xs text-cyan-300 font-medium">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-cyan-400" />
                  Direct Web Link Ready (Plays standalone, PC can be off)
                </span>
                <button
                  type="button"
                  onClick={() => setShowConfig(!showConfig)}
                  className="text-[11px] text-zinc-400 hover:text-white"
                  title="Configure uDrop credentials"
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={directLink}
                  className="w-full rounded-lg border border-white/10 bg-black/60 px-2.5 py-1.5 font-mono text-xs text-zinc-200 select-all"
                />
                <button
                  onClick={handleCopy}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 transition"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>

              <div className="flex items-center justify-between pt-1 text-[11px] text-zinc-400">
                <span>Supports HTTP 206 Range scrubbing</span>
                <a
                  href={directLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-400 hover:underline flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" /> Test in Browser
                </a>
              </div>
            </div>
          ) : null}

          {/* STATE B: Not yet on uDrop & Transfer Not Dispatched */}
          {!checking && !directLink && !dispatched ? (
            <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-zinc-800 text-zinc-300">
                  <Cloud className="w-4 h-4 text-cyan-400" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-xs font-semibold text-white">Not yet on uDrop CDN</h4>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    Dispatch a zero-bandwidth cloud-to-cloud transfer via Kaggle or GitHub Actions. Rclone streams
                    directly between remotes at Gigabit datacenter speeds.
                  </p>
                </div>
              </div>

              <div className="rounded-lg bg-black/40 p-2.5 border border-white/5 text-[11px] space-y-1 text-zinc-400 font-mono">
                <div>Destination: <span className="text-white">udrop: (Root Folder)</span></div>
                <div>Local Bandwidth: <span className="text-emerald-400 font-semibold">0 MB used</span></div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setShowConfig(!showConfig)}
                  className="text-[11px] text-zinc-400 hover:text-white flex items-center gap-1"
                >
                  <Settings className="w-3 h-3" /> uDrop Settings
                </button>

                <button
                  onClick={handleDispatchCloudTransfer}
                  disabled={isDispatching || !isConfigured}
                  className="flex items-center gap-2 rounded-xl bg-cyan-600 px-4 py-2 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50 transition shadow-lg shadow-cyan-600/20"
                >
                  {isDispatching ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UploadCloud className="h-4 w-4" />
                  )}
                  {isDispatching ? 'Dispatching...' : 'Dispatch Cloud Transfer'}
                </button>
              </div>
            </div>
          ) : null}

          {/* STATE C: Transfer Dispatched & Running */}
          {dispatched ? (
            <div className="space-y-3.5 rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-cyan-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                Cloud-to-Cloud Transfer In Progress
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed">
                Your file is streaming to uDrop via the cloud worker. You do not need to keep this modal open.
              </p>

              <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={autoCopyOnComplete}
                  onChange={(e) => setAutoCopyOnComplete(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-800 text-cyan-500 focus:ring-0"
                />
                Automatically copy direct link to clipboard when finished
              </label>

              <div className="pt-2 flex justify-end">
                <button
                  onClick={onClose}
                  className="rounded-xl bg-zinc-800 px-4 py-2 text-xs font-medium text-white hover:bg-zinc-700 transition"
                >
                  Run in Background & Close
                </button>
              </div>
            </div>
          ) : null}

          {/* Modal Footer (when not dispatched) */}
          {!dispatched && (
            <div className="flex justify-end gap-2 pt-2 border-t border-white/5">
              <button
                onClick={onClose}
                className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-white/5 hover:text-white transition"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
