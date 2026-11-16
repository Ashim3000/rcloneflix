import React, { useState } from "react";
import { Plus, Check, ListPlus, X, Music, Film, Layers } from "lucide-react";
import { useAppStore, type MediaItem, type Playlist } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";

interface AddToPlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: MediaItem[];
}

export function AddToPlaylistModal({
  isOpen,
  onClose,
  items,
}: AddToPlaylistModalProps) {
  const playlists = useAppStore((s) => s.playlists);
  const createPlaylist = useAppStore((s) => s.createPlaylist);
  const addToPlaylist = useAppStore((s) => s.addToPlaylist);
  const removeFromPlaylist = useAppStore((s) => s.removeFromPlaylist);
  const addToast = useToastStore((s) => s.addToast);

  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [newPlaylistType, setNewPlaylistType] = useState<"music" | "video" | "mixed">("mixed");
  const [showCreateForm, setShowCreateForm] = useState(false);

  if (!isOpen || items.length === 0) return null;

  const itemIds = items.map((i) => i.id);
  const isMusic = items.every((i) => i.libraryType === "music");
  const isVideo = items.every((i) => i.libraryType === "movies" || i.libraryType === "tv" || i.libraryType === "adult");
  const suggestedType: "music" | "video" | "mixed" = isMusic ? "music" : isVideo ? "video" : "mixed";

  const playlistList = Object.values(playlists).sort((a, b) => b.updatedAt - a.updatedAt);

  const handleToggle = (playlist: Playlist) => {
    const allPresent = itemIds.every((id) => playlist.itemIds.includes(id));
    if (allPresent && itemIds.length === 1) {
      removeFromPlaylist(playlist.id, itemIds[0]);
      addToast(`Removed from "${playlist.name}"`, "info", 3000);
    } else {
      addToPlaylist(playlist.id, itemIds);
      addToast(
        `Added ${items.length === 1 ? `"${items[0].title || items[0].filename}"` : `${items.length} items`} to "${playlist.name}"`,
        "success",
        3500
      );
    }
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newPlaylistName.trim();
    if (!name) return;

    const id = createPlaylist(name, newPlaylistType, undefined, itemIds);
    setNewPlaylistName("");
    setShowCreateForm(false);
    addToast(`Created playlist "${name}" and added items`, "success", 3500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div
        className="relative w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl shadow-2xl p-6 overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-accent-primary/20 text-accent-primary">
              <ListPlus size={20} />
            </div>
            <div>
              <h3 className="font-bold text-lg text-white">Add to Playlist</h3>
              <p className="text-xs text-white/50 truncate max-w-[240px]">
                {items.length === 1
                  ? items[0].title || items[0].filename
                  : `${items.length} items selected`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Playlist List */}
        <div className="flex-1 overflow-y-auto py-3 space-y-1.5 custom-scrollbar">
          {playlistList.length === 0 && !showCreateForm && (
            <div className="text-center py-8 text-white/40 space-y-2">
              <Layers size={36} className="mx-auto opacity-30" />
              <p className="text-sm">No playlists yet.</p>
            </div>
          )}

          {playlistList.map((pl) => {
            const hasAll = itemIds.every((id) => pl.itemIds.includes(id));
            const hasSome = !hasAll && itemIds.some((id) => pl.itemIds.includes(id));

            return (
              <button
                key={pl.id}
                type="button"
                onClick={() => handleToggle(pl)}
                className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                  hasAll
                    ? "bg-accent-primary/15 border-accent-primary/40 text-white"
                    : "bg-white/5 border-white/5 hover:bg-white/10 text-white/80"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2 rounded-lg bg-white/5 text-white/60">
                    {pl.type === "music" ? (
                      <Music size={16} />
                    ) : pl.type === "video" ? (
                      <Film size={16} />
                    ) : (
                      <Layers size={16} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate text-white">{pl.name}</p>
                    <p className="text-xs text-white/40">
                      {pl.itemIds.length} {pl.itemIds.length === 1 ? "item" : "items"}
                    </p>
                  </div>
                </div>

                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center border transition-colors ${
                    hasAll
                      ? "bg-accent-primary border-accent-primary text-white"
                      : hasSome
                      ? "border-accent-primary/60 text-accent-primary"
                      : "border-white/20 text-transparent"
                  }`}
                >
                  <Check size={14} className={hasAll ? "opacity-100" : hasSome ? "opacity-60" : "opacity-0"} />
                </div>
              </button>
            );
          })}
        </div>

        {/* Create New Playlist Toggle / Form */}
        <div className="pt-3 border-t border-white/10">
          {!showCreateForm ? (
            <button
              type="button"
              onClick={() => {
                setNewPlaylistType(suggestedType);
                setShowCreateForm(true);
              }}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-white/10 hover:bg-white/15 text-white text-sm font-semibold transition-colors"
            >
              <Plus size={16} />
              <span>Create New Playlist</span>
            </button>
          ) : (
            <form onSubmit={handleCreate} className="space-y-3">
              <input
                type="text"
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                placeholder="Playlist name…"
                autoFocus
                className="w-full px-3 py-2 text-sm rounded-xl bg-panel border border-border text-white placeholder-white/40 focus:outline-none focus:border-accent-primary"
              />

              <div className="flex items-center gap-2">
                {(["mixed", "music", "video"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setNewPlaylistType(t)}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-lg capitalize border transition-colors ${
                      newPlaylistType === t
                        ? "bg-accent-primary text-white border-accent-primary"
                        : "bg-white/5 border-white/10 text-white/60 hover:text-white"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={!newPlaylistName.trim()}
                  className="flex-1 py-2 rounded-xl bg-accent-primary hover:bg-accent-primary/90 disabled:opacity-50 text-white text-xs font-bold transition-colors"
                >
                  Create & Add
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white/70 text-xs font-medium transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
