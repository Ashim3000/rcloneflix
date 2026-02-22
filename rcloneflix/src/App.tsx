import { Routes, Route, Navigate } from "react-router-dom";
import { useAppStore } from "./store/appStore";
import { SetupPage } from "./pages/SetupPage";
import { AppShell } from "./components/layout/AppShell";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { VideoPlayerPage } from "./pages/player/VideoPlayerPage";
import { EpubReaderPage } from "./pages/player/EpubReaderPage";
import { PdfReaderPage } from "./pages/player/PdfReaderPage";

export default function App() {
  const { setupComplete } = useAppStore();

  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      {/* Full-screen players — outside AppShell so no sidebar */}
      <Route path="/play/video" element={<VideoPlayerPage />} />
      <Route path="/play/epub" element={<EpubReaderPage />} />
      <Route path="/play/pdf" element={<PdfReaderPage />} />

      <Route
        path="/"
        element={
          setupComplete ? (
            <Navigate to="/home" replace />
          ) : (
            <Navigate to="/setup" replace />
          )
        }
      />
      <Route element={<AppShell />}>
        <Route path="/home" element={<HomePage />} />
        <Route path="/movies" element={<LibraryPage />} />
        <Route path="/tv" element={<LibraryPage />} />
        <Route path="/music" element={<LibraryPage />} />
        <Route path="/audiobooks" element={<LibraryPage />} />
        <Route path="/books" element={<LibraryPage />} />
        <Route path="/adult" element={<LibraryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
