import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { Sidebar } from "./Sidebar";
import { AudioMiniPlayer } from "../audioplayer/AudioMiniPlayer";
import type { MediaItem } from "../../store/appStore";

type AudioState = {
  item: MediaItem;
  streamUrl: string;
} | null;

export function AppShell() {
  const [audioState, setAudioState] = useState<AudioState>(null);

  // Listen for audio play events dispatched by MediaCard
  useEffect(() => {
    const handler = (e: Event) => {
      const { item, streamUrl } = (e as CustomEvent).detail;
      setAudioState({ item, streamUrl });
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
              item={audioState.item}
              streamUrl={audioState.streamUrl}
              onClose={() => setAudioState(null)}
              
            />
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
