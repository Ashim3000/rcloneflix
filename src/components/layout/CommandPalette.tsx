import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Search, Film, Tag, HardDrive, Settings, X } from "lucide-react";
import { useAppStore } from "../../store/appStore";

export function CommandPalette() {
  const navigate = useNavigate();
  const { mediaItems, remotes, adultSettings } = useAppStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const results = useMemo(() => {
    if (!open) return { items: [], tags: [], remotes: [] };
    const q = query.trim().toLowerCase();
    const allItems = Object.values(mediaItems).filter(
      (i) => !(i.libraryType === "adult" && adultSettings.hidden)
    );

    const tagSet = new Set<string>();
    for (const i of allItems) {
      for (const t of i.userTags || []) {
        if (!q || t.toLowerCase().includes(q)) tagSet.add(t);
      }
    }

    const matchedItems = q
      ? allItems
          .filter(
            (i) =>
              i.title.toLowerCase().includes(q) ||
              i.artist?.toLowerCase().includes(q) ||
              i.author?.toLowerCase().includes(q)
          )
          .slice(0, 8)
      : allItems.slice(0, 5);

    const matchedRemotes = remotes
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .slice(0, 4);

    return {
      items: matchedItems,
      tags: Array.from(tagSet).slice(0, 6),
      remotes: matchedRemotes,
    };
  }, [open, query, mediaItems, remotes, adultSettings.hidden]);

  if (!open) return null;

  return createPortal(
    <div
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-[10000] bg-black/75 backdrop-blur-xs flex items-start justify-center pt-20 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-border rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl"
      >
        <div className="px-4 py-3 border-b border-border flex items-center gap-2.5">
          <Search size={16} className="text-accent shrink-0" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to media, #tags, cloud remotes, or Settings (Ctrl+K)…"
            className="bg-transparent text-sm text-bright placeholder:text-subtle focus:outline-none flex-1"
          />
          <button onClick={() => setOpen(false)} className="text-subtle hover:text-bright">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto p-3 space-y-3 text-xs">
          {results.tags.length > 0 && (
            <div>
              <p className="text-[10px] font-mono uppercase text-subtle px-2 mb-1">Tags</p>
              <div className="flex flex-wrap gap-1.5 px-2">
                {results.tags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      navigate(`/movies?tag=${encodeURIComponent(t)}`);
                    }}
                    className="px-2.5 py-1 rounded-full bg-panel border border-border text-subtle hover:text-accent hover:border-accent/40 flex items-center gap-1"
                  >
                    <Tag size={11} /> #{t}
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.items.length > 0 && (
            <div>
              <p className="text-[10px] font-mono uppercase text-subtle px-2 mb-1">Media Library</p>
              {results.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate("/detail", { state: { item } });
                  }}
                  className="w-full px-2.5 py-2 rounded-lg hover:bg-panel flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Film size={13} className="text-accent shrink-0" />
                    <span className="text-bright truncate">{item.title}</span>
                  </div>
                  <span className="text-[10px] font-mono uppercase text-subtle shrink-0">
                    {item.libraryType}
                  </span>
                </button>
              ))}
            </div>
          )}

          {results.remotes.length > 0 && (
            <div>
              <p className="text-[10px] font-mono uppercase text-subtle px-2 mb-1">Cloud Remotes</p>
              {results.remotes.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate("/explorer");
                  }}
                  className="w-full px-2.5 py-2 rounded-lg hover:bg-panel flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-2">
                    <HardDrive size={13} className="text-accent" />
                    <span className="text-bright font-mono">{r.name}:</span>
                  </div>
                  <span className="text-[10px] font-mono uppercase text-subtle">{r.type}</span>
                </button>
              ))}
            </div>
          )}

          <div>
            <p className="text-[10px] font-mono uppercase text-subtle px-2 mb-1">Quick Actions</p>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate("/settings");
              }}
              className="w-full px-2.5 py-2 rounded-lg hover:bg-panel flex items-center gap-2 text-left text-subtle hover:text-bright"
            >
              <Settings size={13} className="text-accent" />
              <span>Open Settings &amp; Diagnostics</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
