import { useEffect, useRef, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { AudioMiniPlayer } from "./components/audioplayer/AudioMiniPlayer";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { useAppStore } from "./store/appStore";
import { scanAllLibraries } from "./lib/scanner";
import { loadSecrets, startSecretSync } from "./lib/secrets";
import { log } from "./lib/log";
import { checkPassExpiry, syncIssuedPasses } from "./lib/accessPass";
import { loadLibrary, startLibrarySync, pruneLegacyLocalStorage } from "./lib/libraryDb";
import { initCloudTranscodePoller } from "./lib/kaggleTranscode";
import { initCloudTransferPoller } from "./lib/kaggleTransfer";
import { initTvSubscriptionPoller } from "./lib/tvSubscriptionEngine";
import { initStreamtapeOffloaderPoller } from "./lib/streamtapeOffload";
import { initCyberlockerKeepAliveBot } from "./lib/cyberlockerKeepAlive";
import { initTvNavigation } from "./lib/tvNavigation";
import { SetupPage } from "./pages/SetupPage";
import { AppShell } from "./components/layout/AppShell";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { TvLibraryPage } from "./pages/tv/TvLibraryPage";
import { TvShowPage } from "./pages/tv/TvShowPage";
import { MusicLibraryPage } from "./pages/music/MusicLibraryPage";
import { MediaDetailPage } from "./pages/detail/MediaDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { VideoPlayerPage } from "./pages/player/VideoPlayerPage";
import { EpubReaderPage } from "./pages/player/EpubReaderPage";
import { PdfReaderPage } from "./pages/player/PdfReaderPage";
import { ComicReaderPage } from "./pages/player/ComicReaderPage";
import { PlaylistsPage } from "./pages/playlist/PlaylistsPage";
import { PlaylistDetailPage } from "./pages/playlist/PlaylistDetailPage";
import { PhotosPage } from "./pages/photos/PhotosPage";
import { CloudExplorerPage } from "./pages/explorer/CloudExplorerPage";
import { DirectPlayPage } from "./pages/DirectPlayPage";
import { CommandPalette } from "./components/layout/CommandPalette";
import { ToastContainer } from "./components/ToastContainer";
import { MusicSkinShell } from "./components/music/MusicSkinShell";
import { useMusicSkinWindow } from "./lib/useMusicSkinWindow";

/** How stale the library may get before a launch triggers a rescan. */
const AUTO_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export default function App() {
  const {
    setupComplete,
    audioState,
    setAudioState,
    isMusicSkinMode,
    themeConfig,
  } = useAppStore();
  const location = useLocation();

  useMusicSkinWindow();

  useEffect(() => {
    const accent = themeConfig?.accent || "gold";
    const oled = themeConfig?.oledMode ? "true" : "false";
    document.documentElement.setAttribute("data-accent", accent);
    document.documentElement.setAttribute("data-oled", oled);
  }, [themeConfig?.accent, themeConfig?.oledMode]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { playlist, playlistIndex } = (e as CustomEvent).detail;
      setAudioState({ playlist, playlistIndex, playToken: Date.now() });
    };
    const stopHandler = () => {
      setAudioState(null);
    };
    window.addEventListener("rcloneflix:play-audio", handler);
    window.addEventListener("rcloneflix:stop-audio", stopHandler);
    return () => {
      window.removeEventListener("rcloneflix:play-audio", handler);
      window.removeEventListener("rcloneflix:stop-audio", stopHandler);
    };
  }, [setAudioState]);

  useEffect(() => {
    return initTvNavigation();
  }, []);

  // Secrets live in the Tauri store, not localStorage, so they arrive
  // asynchronously. Hold rendering until they're in — otherwise the first
  // scan would run with an empty TMDB key and cache metadata-less items.
  const [secretsReady, setSecretsReady] = useState(false);
  useEffect(() => {
    const stops: Array<() => void> = [];
    (async () => {
      await loadSecrets().catch(() => {});
      // The library must be in memory before anything renders or a scan runs,
      // otherwise an empty store would look like an empty library.
      await loadLibrary().catch(() => {});
      await pruneLegacyLocalStorage();
      stops.push(
        startSecretSync(),
        startLibrarySync(),
        initStreamtapeOffloaderPoller(),
        initCyberlockerKeepAliveBot()
      );
      initCloudTranscodePoller();
      initCloudTransferPoller();
      initTvSubscriptionPoller();
      setSecretsReady(true);

      // Opt-in Linux FUSE automount for usenet-drive:
      if (
        typeof window !== "undefined" &&
        !(window as any).AndroidBridge &&
        localStorage.getItem("rcloneflix_usenet_automount") === "true" &&
        navigator.platform?.toLowerCase().includes("linux")
      ) {
        (async () => {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const st = await invoke<{ port_8553_active?: boolean }>("usenet_get_status");
            if (!st?.port_8553_active) return;
            const mounted = await invoke<Array<{ name: string }>>("list_mounted_remotes");
            if (mounted.some((m) => m.name.toLowerCase() === "usenet-drive")) return;
            const cfgPath = useAppStore.getState().rcloneConfigPath || "";
            await invoke("usenet_mount_remote", { configPath: cfgPath });
            await invoke("mount_remote", { configPath: cfgPath, remoteName: "usenet-drive" });
          } catch (err: any) {
            const { useToastStore } = await import("./store/toastStore");
            useToastStore.getState().addToast(`usenet-drive automount skipped: ${err?.message || err}`, "info");
          }
        })();
      }
    })();
    return () => stops.forEach((fn) => fn());
  }, []);

  // Run a background scan on every launch once setup is complete.
  // The scanner only picks up new/removed files since it passes knownPaths
  // to rclone, so repeated launches are cheap.
  const hasAutoScanned = useRef(false);
  useEffect(() => {
    if (!secretsReady || !setupComplete || hasAutoScanned.current) return;
    hasAutoScanned.current = true;

    // Only rescan on launch if explicitly enabled in Settings and the library is stale.
    // Full scans across cloud remotes like OpenDrive trigger strict API rate limits and IP bans.
    const { scanState, libraries, rcloneSettings } = useAppStore.getState();
    if (libraries.length === 0) return;

    if (!rcloneSettings?.autoScanOnStartup) {
      log.info(
        "scan",
        "skipping startup scan — autoScanOnStartup is disabled in Settings to protect cloud remotes from rate limits and IP bans"
      );
      return;
    }

    const age = scanState.lastScanAt ? Date.now() - scanState.lastScanAt : Infinity;
    if (age < AUTO_SCAN_INTERVAL_MS) {
      log.info(
        "scan",
        `skipping startup scan — last run ${Math.round(age / 60000)} min ago`
      );
      return;
    }
    scanAllLibraries().catch(() => {});
  }, [setupComplete, secretsReady]);

  // Periodic check for expired shared passes and sync of issued passes
  useEffect(() => {
    if (!secretsReady || !setupComplete) return;
    checkPassExpiry().catch(() => {});
    syncIssuedPasses().catch(() => {});
    const interval = setInterval(() => {
      checkPassExpiry().catch(() => {});
      syncIssuedPasses().catch(() => {});
    }, 6 * 3600 * 1000);
    return () => clearInterval(interval);
  }, [secretsReady, setupComplete]);

  if (!secretsReady) {
    return <div className="h-screen w-screen bg-void" />;
  }

  return (
    <ErrorBoundary>
      {isMusicSkinMode && setupComplete ? (
        <MusicSkinShell />
      ) : (
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/play/video" element={<VideoPlayerPage />} />
          <Route path="/play/epub" element={<EpubReaderPage />} />
          <Route path="/play/pdf" element={<PdfReaderPage />} />
          <Route path="/play/comic" element={<ComicReaderPage />} />

          <Route path="/" element={
            setupComplete ? <Navigate to="/home" replace /> : <Navigate to="/setup" replace />
          } />

          <Route element={<AppShell />}>
            <Route path="/home" element={<HomePage />} />
            <Route path="/movies" element={<LibraryPage libraryType="movies" />} />
            <Route path="/tv" element={<TvLibraryPage />} />
            <Route path="/tv/show/:showId" element={<TvShowPage />} />
            <Route path="/tv/show/*" element={<TvShowPage />} />
            <Route path="/music" element={<MusicLibraryPage />} />
            <Route path="/audiobooks" element={<LibraryPage libraryType="audiobooks" />} />
            <Route path="/books" element={<LibraryPage libraryType="books" />} />
            <Route path="/comics" element={<LibraryPage libraryType="comics" />} />
            <Route path="/photos" element={<PhotosPage />} />
            <Route path="/explorer" element={<CloudExplorerPage />} />
            <Route path="/adult" element={<LibraryPage libraryType="adult" />} />
            <Route path="/detail" element={<MediaDetailPage />} />
            <Route path="/playlists" element={<PlaylistsPage />} />
            <Route path="/playlist/:playlistId" element={<PlaylistDetailPage />} />
            <Route path="/directplay" element={<DirectPlayPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      )}
      <AnimatePresence>
        {audioState && (
          <AudioMiniPlayer
            playlist={audioState.playlist}
            playlistIndex={audioState.playlistIndex}
            playToken={audioState.playToken}
            onClose={() => setAudioState(null)}
          />
        )}
      </AnimatePresence>
      <CommandPalette />
      <ToastContainer />
    </ErrorBoundary>
  );
}
