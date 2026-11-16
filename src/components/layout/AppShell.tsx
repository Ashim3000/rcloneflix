import { useState, useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { UniversalSearchBar } from "./UniversalSearchBar";
import { useAppStore } from "../../store/appStore";
import { isTvEnvironment } from "../../lib/tvNavigation";

const SIDEBAR_STORAGE_KEY = "rcloneflix-sidebar-collapsed";

export function AppShell() {
  const { audioState } = useAppStore();
  const location = useLocation();
  const isTv = isTvEnvironment();

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (isTvEnvironment()) return true;
    try {
      const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (saved !== null) return saved === "true";
      // Default to collapsed rail on narrow tablets / compact screens
      return typeof window !== "undefined" && window.innerWidth < 1024;
    } catch {
      return false;
    }
  });

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile drawer automatically on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  const toggleSidebarCollapse = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  };

  return (
    <div className="flex h-screen w-screen bg-void bg-noise overflow-hidden">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapse}
        onSetCollapsed={setSidebarCollapsed}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />
      <main className="flex-1 flex flex-col overflow-hidden relative min-w-0">
        {isTv ? (
          /* On Android TV, omit the persistent top search header to reclaim vertical space and prevent D-Pad focus traps; UniversalSearchBar renders as an on-demand modal */
          <UniversalSearchBar />
        ) : (
          <header className="flex items-center gap-3 px-3 sm:px-4 py-2 border-b border-surface-border/30 bg-surface-base/40 backdrop-blur-md shrink-0 z-30">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              title="Open navigation menu"
              className="flex md:hidden items-center justify-center p-2 rounded-lg bg-panel/80 border border-border text-subtle hover:text-accent transition-colors flex-shrink-0"
            >
              <Menu size={18} />
            </button>
            <div className="flex-1 flex items-center justify-center min-w-0">
              <UniversalSearchBar />
            </div>
          </header>
        )}
        <div
          className="flex-1 overflow-y-auto"
          style={{ paddingBottom: audioState ? "72px" : "0" }}
        >
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="h-full"
          >
            <Outlet />
          </motion.div>
        </div>
      </main>
    </div>
  );
}
