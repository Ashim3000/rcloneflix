import { useEffect, useRef } from "react";
import { getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { useAppStore } from "../store/appStore";

const isAndroid = typeof window !== "undefined" && Boolean((window as any).AndroidBridge);

/**
 * Manages the window lifecycle for Music Player Mode (Plexamp / Winamp style).
 * - On Desktop (Windows & Linux .deb/Flatpak): Unmaximizes if maximized (required by GTK/X11/Wayland),
 *   shrinks window to a compact 380x640 floating player on enter, and restores full window bounds on exit.
 * - On Android: Applies a compact floating player container style and supports entering native PiP.
 */
export function useMusicSkinWindow() {
  const {
    isMusicSkinMode,
    isSkinPinnedOnTop,
    prevWindowBounds,
    setPrevWindowBounds,
  } = useAppStore();

  const wasInSkinModeRef = useRef(false);
  const wasMaximizedRef = useRef(false);

  useEffect(() => {
    if (isAndroid) {
      if (isMusicSkinMode) {
        wasInSkinModeRef.current = true;
        document.documentElement.classList.add("android-music-skin-compact");
        document.body.classList.add("music-skin-mode-active");
        // Android windows cannot be resized; compact mode is CSS-only via the
        // classes above. (bridge.enterPictureInPicture never existed — the real
        // bridge method is enterPip(w, h), and PiP is wrong for a music skin.)
      } else if (wasInSkinModeRef.current) {
        wasInSkinModeRef.current = false;
        document.documentElement.classList.remove("android-music-skin-compact");
        document.body.classList.remove("music-skin-mode-active");
      }
      return;
    }

    const manageWindow = async () => {
      try {
        const win = getCurrentWindow();

        if (isMusicSkinMode) {
          wasInSkinModeRef.current = true;

          // 1. Exit fullscreen and unmaximize (critical for Linux GTK/Wayland to allow resizing down)
          const isFs = await win.isFullscreen().catch(() => false);
          if (isFs) {
            await win.setFullscreen(false).catch(() => {});
          }
          if (document.fullscreenElement) {
            await document.exitFullscreen().catch(() => {});
          }

          const isMax = await win.isMaximized().catch(() => false);
          wasMaximizedRef.current = isMax;
          if (isMax) {
            await win.unmaximize().catch(() => {});
            // GTK/Wayland/Sommelier completes unmaximize asynchronously in the
            // compositor; without a settle delay the setSize below is overridden.
            await new Promise((r) => setTimeout(r, 120));
          }

          // 2. Capture current full-app window bounds before shrinking (only if not already compact)
          const factor = (await win.scaleFactor().catch(() => 1)) || 1;
          const innerSize = await win.innerSize().catch(() => ({ width: 1280, height: 800 }));
          const outerPos = await win.outerPosition().catch(() => ({ x: 100, y: 100 }));
          const logicalW = Math.round(innerSize.width / factor);
          const logicalH = Math.round(innerSize.height / factor);

          if (!prevWindowBounds && logicalW > 500) {
            setPrevWindowBounds({
              width: logicalW,
              height: logicalH,
              x: outerPos.x,
              y: outerPos.y,
            });
          }

          // 3. Lower minimum window size and shrink to compact 380x640 player
          await win.setMinSize(new LogicalSize(340, 480)).catch(() => {});
          await win.setSize(new LogicalSize(380, 640)).catch(() => {});
          await win.setAlwaysOnTop(isSkinPinnedOnTop).catch(() => {});
        } else if (wasInSkinModeRef.current) {
          wasInSkinModeRef.current = false;

          // Restore full app window bounds and minimum size constraint
          await win.setAlwaysOnTop(false).catch(() => {});
          await win.setMinSize(new LogicalSize(900, 600)).catch(() => {});

          if (wasMaximizedRef.current) {
            wasMaximizedRef.current = false;
            await win.maximize().catch(() => {});
            setPrevWindowBounds(null);
          } else if (prevWindowBounds) {
            await win
              .setSize(new LogicalSize(prevWindowBounds.width, prevWindowBounds.height))
              .catch(() => {});
            await win
              .setPosition(new PhysicalPosition(prevWindowBounds.x, prevWindowBounds.y))
              .catch(() => {});
            setPrevWindowBounds(null);
          } else {
            await win.setSize(new LogicalSize(1280, 800)).catch(() => {});
          }
        }
      } catch (err) {
        console.warn("Failed managing music skin window bounds:", err);
      }
    };

    void manageWindow();
  }, [isMusicSkinMode]);

  // Handle live pin/unpin toggling while in skin mode without resetting window size
  useEffect(() => {
    if (isAndroid || !isMusicSkinMode) return;
    try {
      const win = getCurrentWindow();
      win.setAlwaysOnTop(isSkinPinnedOnTop).catch(() => {});
    } catch {}
  }, [isSkinPinnedOnTop, isMusicSkinMode]);
}
