import { useEffect, useRef } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAppStore } from "./store/appStore";
import { scanAllLibraries } from "./lib/scanner";
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

export default function App() {
  const { setupComplete } = useAppStore();

  // Run a background scan on every launch once setup is complete.
  // The scanner only picks up new/removed files since it passes knownPaths
  // to rclone, so repeated launches are cheap.
  const hasAutoScanned = useRef(false);
  useEffect(() => {
    if (setupComplete && !hasAutoScanned.current) {
      hasAutoScanned.current = true;
      scanAllLibraries().catch(() => {});
    }
  }, [setupComplete]);

  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/play/video" element={<VideoPlayerPage />} />
      <Route path="/play/epub" element={<EpubReaderPage />} />
      <Route path="/play/pdf" element={<PdfReaderPage />} />

      <Route path="/" element={
        setupComplete ? <Navigate to="/home" replace /> : <Navigate to="/setup" replace />
      } />

      <Route element={<AppShell />}>
        <Route path="/home" element={<HomePage />} />
        <Route path="/movies" element={<LibraryPage libraryType="movies" />} />
        <Route path="/tv" element={<TvLibraryPage />} />
        <Route path="/tv/show/:showId" element={<TvShowPage />} />
        <Route path="/music" element={<MusicLibraryPage />} />
        <Route path="/audiobooks" element={<LibraryPage libraryType="audiobooks" />} />
        <Route path="/books" element={<LibraryPage libraryType="books" />} />
        <Route path="/adult" element={<LibraryPage libraryType="adult" />} />
        <Route path="/detail" element={<MediaDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
