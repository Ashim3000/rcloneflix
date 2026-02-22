import { NavLink, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Home, Film, Tv, Music, Headphones, BookOpen, Eye, EyeOff,
  Settings, LogOut, Cloud, CloudOff, Lock, RefreshCw, Loader2,
} from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { scanAllLibraries } from "../../lib/scanner";

const BASE_NAV = [
  { path: "/home", icon: Home, label: "Home", type: null },
  { path: "/movies", icon: Film, label: "Movies", type: "movies" },
  { path: "/tv", icon: Tv, label: "TV Shows", type: "tv" },
  { path: "/music", icon: Music, label: "Music", type: "music" },
  { path: "/audiobooks", icon: Headphones, label: "Audiobooks", type: "audiobooks" },
  { path: "/books", icon: BookOpen, label: "Books", type: "books" },
  { path: "/adult", icon: Eye, label: "Adult", type: "adult" },
];

export function Sidebar() {
  const { googleLinked, resetConfig, libraries, adultSettings, scanState } = useAppStore();
  const navigate = useNavigate();

  const enabledTypes = new Set(libraries.map((l) => l.type));
  const isScanning = scanState.status === "scanning";

  const visibleNav = BASE_NAV.filter((item) => {
    if (item.path === "/home") return true;
    if (!enabledTypes.has(item.type as never)) return false;
    if (item.type === "adult" && adultSettings.hidden) return false;
    return true;
  });

  const handleReset = () => {
    if (confirm("Reset all settings and start over?")) {
      resetConfig();
      navigate("/setup");
    }
  };

  return (
    <motion.aside
      initial={{ x: -240 }}
      animate={{ x: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="w-56 flex-shrink-0 bg-surface border-r border-border flex flex-col h-full"
    >
      {/* Logo */}
      <div className="px-5 py-6 border-b border-border">
        <h1 className="font-display text-3xl text-accent tracking-widest leading-none">
          RCFLIX
        </h1>
        <p className="text-subtle text-xs font-body mt-0.5">RcloneFlix</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {visibleNav.map((item) => {
          const isAdult = item.type === "adult";
          const adultLocked = isAdult && adultSettings.pinEnabled && !adultSettings.unlocked;

          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `sidebar-item group ${isActive ? "active" : ""}`
              }
            >
              <item.icon size={17} />
              <span className="flex-1">{item.label}</span>
              {adultLocked && (
                <Lock size={12} className="text-subtle group-hover:text-accent transition-colors" />
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="border-t border-border px-3 py-4 space-y-1">
        {/* Sync status */}
        <div className="flex items-center gap-2 px-4 py-2">
          {googleLinked ? (
            <>
              <Cloud size={14} className="text-teal" />
              <span className="text-teal text-xs font-body">Synced</span>
            </>
          ) : (
            <>
              <CloudOff size={14} className="text-subtle" />
              <span className="text-subtle text-xs font-body">Local only</span>
            </>
          )}
        </div>

        {/* Scan all */}
        <button
          onClick={() => !isScanning && scanAllLibraries()}
          disabled={isScanning}
          className="sidebar-item w-full text-left disabled:opacity-50"
        >
          {isScanning ? (
            <Loader2 size={17} className="animate-spin text-accent" />
          ) : (
            <RefreshCw size={17} />
          )}
          <span>{isScanning ? "Scanning..." : "Scan Libraries"}</span>
        </button>

        <NavLink
          to="/settings"
          className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
        >
          <Settings size={17} />
          <span>Settings</span>
        </NavLink>

        <button
          onClick={handleReset}
          className="sidebar-item w-full text-left text-danger/70 hover:text-danger hover:bg-danger/5"
        >
          <LogOut size={17} />
          <span>Reset Setup</span>
        </button>
      </div>
    </motion.aside>
  );
}
