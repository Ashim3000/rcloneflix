import { Routes, Route, Navigate } from "react-router-dom";
import { useAppStore } from "./store/appStore";
import { SetupPage } from "./pages/SetupPage";
import { AppShell } from "./components/layout/AppShell";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { TvLibraryPage } from "./pages/tv/TvLibraryPage";
import { TvShowPage } from "./pages/tv/TvShowPage";
import { MediaDetailPage } from "./pages/detail/MediaDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { VideoPlayerPage } from "./pages/player/VideoPlayerPage";
import { EpubReaderPage } from "./pages/player/EpubReaderPage";
import { PdfReaderPage } from "./pages/player/PdfReaderPage";

export default function App() {
  const { setupComplete } = useAppStore();

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
        <Route path="/music" element={<LibraryPage libraryType="music" />} />
        <Route path="/audiobooks" element={<LibraryPage libraryType="audiobooks" />} />
        <Route path="/books" element={<LibraryPage libraryType="books" />} />
        <Route path="/adult" element={<LibraryPage libraryType="adult" />} />
        <Route path="/detail" element={<MediaDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
