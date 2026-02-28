import { NavLink, useNavigate } from "react-router-dom";
import {
  Home, Film, Tv, Music, BookOpen, Headphones,
  Shield, Settings, RefreshCw, Cloud, CloudOff, Lock,
} from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { scanAllLibraries } from "../../lib/scanner";

const NAV_ITEMS = [
  { path: "/home",       label: "Home",        icon: Home,       type: null },
  { path: "/movies",     label: "Movies",      icon: Film,       type: "movies" },
  { path: "/tv",         label: "TV Shows",    icon: Tv,         type: "tv" },
  { path: "/music",      label: "Music",       icon: Music,      type: "music" },
  { path: "/audiobooks", label: "Audiobooks",  icon: Headphones, type: "audiobooks" },
  { path: "/books",      label: "Books",       icon: BookOpen,   type: "books" },
  { path: "/adult",      label: "Adult",       icon: Shield,     type: "adult" },
];

export function Sidebar() {
  const {
    libraries, adultSettings, scanState, googleAccount, resetConfig,
  } = useAppStore();
  const navigate = useNavigate();

  const configuredTypes = new Set(libraries.map((l) => l.type));
  const isScanning = scanState.status === "scanning";

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (!item.type) return true;
    if (!configuredTypes.has(item.type as any)) return false;
    if (item.type === "adult" && adultSettings.hidden) return false;
    return true;
  });

  return (
    <aside className="w-56 flex-shrink-0 bg-surface border-r border-border flex flex-col h-full">
      {/* Logo */}
      <div className="px-6 py-5 border-b border-border">
        <h1 className="font-display text-2xl text-accent tracking-widest">RCLONEFLIX</h1>
        {/* Sync indicator */}
        <div className="flex items-center gap-1.5 mt-1">
          {googleAccount
            ? <><Cloud size={10} className="text-teal" /><span className="text-teal font-body text-xs">Synced</span></>
            : <><CloudOff size={10} className="text-subtle" /><span className="text-subtle font-body text-xs">Local only</span></>}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-0.5">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const isAdult = item.type === "adult";
          const adultLocked = isAdult && adultSettings.pinEnabled && !adultSettings.unlocked;

          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-all group ${
                  isActive
                    ? "bg-panel text-accent border-l-2 border-accent pl-2.5"
                    : "text-subtle hover:text-text hover:bg-panel/60"
                }`
              }
            >
              <Icon size={16} className="flex-shrink-0" />
              <span className="truncate flex-1">{item.label}</span>
              {adultLocked && <Lock size={11} className="text-subtle flex-shrink-0" />}
            </NavLink>
          );
        })}
      </nav>

      {/* Bottom actions */}
      <div className="px-3 pb-4 pt-2 border-t border-border space-y-1">
        <button
          onClick={() => scanAllLibraries()}
          disabled={isScanning}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm text-subtle hover:text-text hover:bg-panel/60 transition-all disabled:opacity-50"
        >
          <RefreshCw size={16} className={isScanning ? "animate-spin" : ""} />
          {isScanning ? `Scanning...` : "Scan Libraries"}
        </button>

        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-all ${
              isActive ? "bg-panel text-accent" : "text-subtle hover:text-text hover:bg-panel/60"
            }`
          }
        >
          <Settings size={16} />
          Settings
        </NavLink>

        <button
          onClick={() => {
            if (confirm("Reset all config? This cannot be undone.")) {
              resetConfig();
              navigate("/setup");
            }
          }}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-xs text-subtle/50 hover:text-danger hover:bg-danger/10 transition-all"
        >
          Reset Setup
        </button>
      </div>
    </aside>
  );
}
