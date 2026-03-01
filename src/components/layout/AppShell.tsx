import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { Sidebar } from "./Sidebar";
import { AudioMiniPlayer } from "../audioplayer/AudioMiniPlayer";
import { ToastContainer } from "../ToastContainer";
import type { MediaItem } from "../../store/appStore";

type AudioState = {
  playlist: MediaItem[];
  playlistIndex: number;
} | null;

export function AppShell() {
  const [audioState, setAudioState] = useState<AudioState>(null);

  // Listen for audio play events dispatched by MusicLibraryPage / MediaDetailPage
  useEffect(() => {
    const handler = (e: Event) => {
      const { playlist, playlistIndex } = (e as CustomEvent).detail;
      setAudioState({ playlist, playlistIndex });
    };
    window.addEventListener("rcloneflix:play-audio", handler);
    return () => window.removeEventListener("rcloneflix:play-audio", handler);
  }, []);

  return (
    <div className="flex h-screen w-screen bg-void overflow-hidden">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <div
          className="flex-1 overflow-y-auto"
          style={{ paddingBottom: audioState ? "72px" : "0" }}
        >
          <Outlet />
        </div>
        <AnimatePresence>
          {audioState && (
            <AudioMiniPlayer
              playlist={audioState.playlist}
              playlistIndex={audioState.playlistIndex}
              onClose={() => setAudioState(null)}
            />
          )}
        </AnimatePresence>
      </main>
      <ToastContainer />
    </div>
  );
}
