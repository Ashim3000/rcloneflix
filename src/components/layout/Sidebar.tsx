import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  Home, Film, Tv, Music, BookOpen, Headphones, Layers,
  Shield, Settings, RefreshCw, Cloud, CloudOff, Lock, ListMusic, Images,
  CloudDownload, Globe, PanelLeftClose, PanelLeftOpen, X, RotateCcw, Search, Disc3,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "../../store/appStore";
import { scanAllLibraries } from "../../lib/scanner";
import { AddStreamBookmarkModal } from "../library/AddStreamBookmarkModal";
import { isTvEnvironment } from "../../lib/tvNavigation";

const NAV_ITEMS = [
  { path: "/home",       label: "Home",           icon: Home,          type: null },
  { path: "/movies",     label: "Movies",         icon: Film,          type: "movies" },
  { path: "/tv",         label: "TV Shows",       icon: Tv,            type: "tv" },
  { path: "/music",      label: "Music",          icon: Music,         type: "music" },
  { path: "/audiobooks", label: "Audiobooks",     icon: Headphones,    type: "audiobooks" },
  { path: "/books",      label: "Books",          icon: BookOpen,      type: "books" },
  { path: "/comics",     label: "Comics",         icon: Layers,        type: "comics" },
  { path: "/photos",     label: "Photos",         icon: Images,        type: null },
  { path: "/explorer",   label: "Cloud Explorer", icon: CloudDownload, type: null },
  { path: "/adult",      label: "Adult",          icon: Shield,        type: "adult" },
  { path: "/playlists",  label: "Playlists",      icon: ListMusic,     type: null },
];

type SidebarProps = {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onSetCollapsed?: (collapsed: boolean) => void;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
};

export function Sidebar({
  collapsed = false,
  onToggleCollapse,
  onSetCollapsed,
  mobileOpen = false,
  onCloseMobile,
}: SidebarProps) {
  const {
    libraries, remotes, adultSettings, scanState, syncState, resetConfig, setMusicSkinMode,
  } = useAppStore();
  const navigate = useNavigate();

  const [version, setVersion] = useState("");
  const [showAddBookmarkModal, setShowAddBookmarkModal] = useState(false);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const configuredTypes = new Set(libraries.map((l) => l.type));
  const isScanning = scanState.status === "scanning";

  // Check if the user has any personal (non-shared) cloud remotes or personal libraries
  const hasPersonalRemotes = remotes.some((r) => !r.name.startsWith("shared_"));
  const hasPersonalLibraries = libraries.some((l) => !l.isSharedPass);
  const isGuestPassOnly = !hasPersonalRemotes && !hasPersonalLibraries;

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.path === "/explorer" && isGuestPassOnly) return false;
    if (!item.type) return true;
    if (!configuredTypes.has(item.type as any)) return false;
    if (item.type === "adult" && adultSettings.hidden) return false;
    return true;
  });

  const handleNavClick = () => {
    onCloseMobile?.();
  };

  return (
    <>
      {/* Mobile Backdrop Overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-xs z-40 md:hidden"
          onClick={onCloseMobile}
        />
      )}

      <aside
        onFocusCapture={() => {
          if (isTvEnvironment() && collapsed) {
            onSetCollapsed?.(false);
          }
        }}
        onBlurCapture={(e) => {
          if (
            isTvEnvironment() &&
            !collapsed &&
            !e.currentTarget.contains(e.relatedTarget as Node | null)
          ) {
            onSetCollapsed?.(true);
          }
        }}
        className={`bg-surface border-r border-border flex flex-col h-full select-none transition-all duration-200 z-50
          fixed inset-y-0 left-0 md:static md:translate-x-0 flex-shrink-0
          ${mobileOpen ? "translate-x-0 w-64 shadow-2xl" : "-translate-x-full md:translate-x-0"}
          ${collapsed ? "md:w-16" : "md:w-56"}
        `}
      >
        {/* Logo & Collapse Button */}
        <div
          className={`border-b border-border flex items-center ${
            collapsed ? "md:justify-center md:px-2 md:py-4 px-5 py-4 justify-between" : "px-5 py-4 justify-between"
          }`}
        >
          <div className={collapsed ? "md:hidden block" : "block"}>
            <h1 className="font-display text-2xl text-accent tracking-widest leading-none">
              RCLONEFLIX
            </h1>
            <div className="flex items-center gap-1.5 mt-1">
              {syncState.lastSyncAt ? (
                <>
                  <Cloud size={10} className="text-teal" />
                  <span className="text-teal font-body text-xs">Synced</span>
                </>
              ) : (
                <>
                  <CloudOff size={10} className="text-subtle" />
                  <span className="text-subtle font-body text-xs">Local only</span>
                </>
              )}
            </div>
          </div>

          {/* Desktop Collapse / Expand Rail Toggle */}
          <button
            type="button"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden md:flex items-center justify-center p-2 rounded-lg text-subtle hover:text-accent hover:bg-panel/80 transition-colors"
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>

          {/* Mobile Drawer Close Button */}
          <button
            type="button"
            onClick={onCloseMobile}
            title="Close menu"
            className="flex md:hidden items-center justify-center p-2 rounded-lg text-subtle hover:text-text hover:bg-panel/80 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
          {isTvEnvironment() && (
            <button
              type="button"
              onClick={() => {
                handleNavClick();
                window.dispatchEvent(new CustomEvent("rcloneflix:open-search"));
              }}
              title="Search Library & Streams"
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-all text-subtle hover:text-accent hover:bg-panel/60 ${
                collapsed ? "md:justify-center md:px-0" : ""
              }`}
            >
              <Search size={18} className="flex-shrink-0 text-accent" />
              <span className={`truncate flex-1 text-left ${collapsed ? "md:hidden" : ""}`}>
                Search
              </span>
            </button>
          )}
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const isAdult = item.type === "adult";
            const adultLocked = isAdult && adultSettings.pinEnabled && !adultSettings.unlocked;

            return (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={handleNavClick}
                title={item.label}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-all group ${
                    collapsed ? "md:justify-center md:px-0" : ""
                  } ${
                    isActive
                      ? "bg-panel text-accent border-l-2 border-accent"
                      : "text-subtle hover:text-text hover:bg-panel/60"
                  }`
                }
              >
                <Icon size={18} className="flex-shrink-0" />
                <span className={`truncate flex-1 ${collapsed ? "md:hidden" : ""}`}>
                  {item.label}
                </span>
                {adultLocked && (
                  <Lock size={11} className={`text-subtle flex-shrink-0 ${collapsed ? "md:hidden" : ""}`} />
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* Bottom Actions */}
        <div className="px-2 pb-4 pt-2 border-t border-border space-y-1">
          <NavLink
            to="/directplay"
            onClick={handleNavClick}
            className={({ isActive }) =>
              `w-full flex items-center gap-2.5 px-3 py-2 rounded-lg font-body text-xs font-semibold transition-all border mb-1 shadow-sm ${
                collapsed ? "md:justify-center md:px-0" : ""
              } ${
                isActive
                  ? "bg-accent text-void border-accent shadow-accent-glow"
                  : "text-accent hover:bg-accent/15 border-accent/25 bg-accent/5"
              }`
            }
            title="Directplay and Streaming: Stream on-demand, match metadata, or crawl bookmarks"
          >
            <Globe size={16} className="flex-shrink-0" />
            <span className={collapsed ? "md:hidden" : ""}>Directplay and Streaming</span>
          </NavLink>

          <button
            onClick={() => {
              onCloseMobile?.();
              setMusicSkinMode(true);
            }}
            title="Switch to Compact Music Player Skin (Plexamp / Winamp / Finamp Mode)"
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg font-body text-xs font-semibold text-subtle hover:text-accent hover:bg-accent/10 border border-white/10 hover:border-accent/30 transition-all mb-1 cursor-pointer ${
              collapsed ? "md:justify-center md:px-0" : ""
            }`}
          >
            <Disc3 size={16} className="text-accent flex-shrink-0 animate-spin-slow" />
            <span className={collapsed ? "md:hidden" : ""}>Music Player Skin</span>
          </button>

          <button
            onClick={() => scanAllLibraries()}
            disabled={isScanning}
            title={isScanning ? "Scanning Libraries..." : "Scan Libraries"}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm text-subtle hover:text-text hover:bg-panel/60 transition-all disabled:opacity-50 ${
              collapsed ? "md:justify-center md:px-0" : ""
            }`}
          >
            <RefreshCw size={16} className={`flex-shrink-0 ${isScanning ? "animate-spin" : ""}`} />
            <span className={collapsed ? "md:hidden" : ""}>
              {isScanning ? "Scanning..." : "Scan Libraries"}
            </span>
          </button>

          <NavLink
            to="/settings"
            onClick={handleNavClick}
            title="Settings"
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-all ${
                collapsed ? "md:justify-center md:px-0" : ""
              } ${
                isActive ? "bg-panel text-accent" : "text-subtle hover:text-text hover:bg-panel/60"
              }`
            }
          >
            <Settings size={16} className="flex-shrink-0" />
            <span className={collapsed ? "md:hidden" : ""}>Settings</span>
          </NavLink>

          <button
            onClick={() => {
              if (confirm("Reset all config? This cannot be undone.")) {
                resetConfig();
                navigate("/setup");
              }
            }}
            title="Reset Setup"
            className={`w-full flex items-center gap-3 px-3 py-2 text-subtle/50 hover:text-danger hover:bg-danger/10 transition-all font-body text-xs rounded-lg ${
              collapsed ? "md:justify-center md:px-0" : ""
            }`}
          >
            <RotateCcw size={14} className="flex-shrink-0" />
            <span className={collapsed ? "md:hidden" : ""}>Reset Setup</span>
          </button>

          <div className="pt-2 px-1 text-center border-t border-white/5">
            <span className="font-mono text-[10px] font-bold text-accent/80 bg-accent/10 px-1.5 py-0.5 rounded-full border border-accent/20">
              v{version || "—"}
            </span>
          </div>
        </div>
        <AddStreamBookmarkModal
          isOpen={showAddBookmarkModal}
          onClose={() => setShowAddBookmarkModal(false)}
        />
      </aside>
    </>
  );
}
