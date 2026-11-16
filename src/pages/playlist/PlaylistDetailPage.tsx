import React, { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Play,
  Shuffle,
  Download,
  Trash2,
  Edit2,
  Check,
  ChevronUp,
  ChevronDown,
  Clock,
  Music,
  Film,
  Layers,
  X,
} from "lucide-react";
import { useAppStore, selectPlaylistItems, isLocalPath, type MediaItem } from "../../store/appStore";
import { useArtwork } from "../../lib/artwork";
import { useToastStore } from "../../store/toastStore";
import { downloadSingleItem, startDownloadJob, getMediaSubfolder } from "../../lib/downloadManager";
import { FavoriteButton } from "../../components/common/FavoriteButton";

export function PlaylistDetailPage() {
  const { playlistId } = useParams<{ playlistId: string }>();
  const navigate = useNavigate();

  const playlists = useAppStore((s) => s.playlists);
  const mediaItems = useAppStore((s) => s.mediaItems);
  const updatePlaylist = useAppStore((s) => s.updatePlaylist);
  const deletePlaylist = useAppStore((s) => s.deletePlaylist);
  const removeFromPlaylist = useAppStore((s) => s.removeFromPlaylist);
  const reorderPlaylist = useAppStore((s) => s.reorderPlaylist);
  const addToast = useToastStore((s) => s.addToast);

  const playlist = playlistId ? playlists[playlistId] : undefined;
  const items = useMemo(
    () => (playlist ? selectPlaylistItems(playlist, mediaItems) : []),
    [playlist, mediaItems]
  );

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");

  if (!playlist) {
    return (
      <div className="p-8 max-w-4xl mx-auto min-h-screen text-center py-24">
        <Layers size={48} className="mx-auto text-subtle/40 mb-3" />
        <h2 className="text-xl font-bold text-white mb-2">Playlist not found</h2>
        <p className="text-subtle text-sm mb-6">This playlist may have been deleted.</p>
        <button onClick={() => navigate("/playlists")} className="btn-secondary px-5 py-2 text-xs">
          Back to Playlists
        </button>
      </div>
    );
  }

  const handleStartEdit = () => {
    setEditName(playlist.name);
    setEditDesc(playlist.description || "");
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    const name = editName.trim();
    if (!name) return;
    updatePlaylist(playlist.id, {
      name,
      description: editDesc.trim() || undefined,
    });
    setIsEditing(false);
    addToast("Playlist updated", "success", 2500);
  };

  const handleDelete = () => {
    if (window.confirm(`Are you sure you want to delete "${playlist.name}"?`)) {
      deletePlaylist(playlist.id);
      addToast(`Deleted "${playlist.name}"`, "info", 3000);
      navigate("/playlists");
    }
  };

  const handlePlayIndex = (index: number) => {
    if (items.length === 0) return;
    const isAudio = playlist.type === "music" || items.every((i) => i.libraryType === "music");
    if (isAudio) {
      window.dispatchEvent(
        new CustomEvent("rcloneflix:play-audio", {
          detail: { playlist: items, playlistIndex: index },
        })
      );
    } else {
      navigate("/play/video", { state: { item: items[index] } });
    }
  };

  const handleShuffle = () => {
    if (items.length === 0) return;
    const shuffled = [...items].sort(() => Math.random() - 0.5);
    const isAudio = playlist.type === "music" || items.every((i) => i.libraryType === "music");
    if (isAudio) {
      window.dispatchEvent(
        new CustomEvent("rcloneflix:play-audio", {
          detail: { playlist: shuffled, playlistIndex: 0 },
        })
      );
    } else {
      navigate("/play/video", { state: { item: shuffled[0] } });
    }
  };

  const handleDownloadAll = () => {
    if (items.length === 0) return;
    const remoteItems = items.filter((i) => !isLocalPath(i.remotePath));
    if (remoteItems.length === 0) {
      addToast("All items in this playlist are already stored locally", "info", 3000);
      return;
    }
    startDownloadJob(
      playlist.name,
      remoteItems.map((i) => ({
        remote_path: i.remotePath,
        filename: i.filename,
        subfolder: getMediaSubfolder(i),
      }))
    );
  };

  const handleMove = (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= playlist.itemIds.length) return;

    const nextIds = [...playlist.itemIds];
    const temp = nextIds[index];
    nextIds[index] = nextIds[targetIndex];
    nextIds[targetIndex] = temp;

    reorderPlaylist(playlist.id, nextIds);
  };

  const totalDuration = items.reduce((acc, i) => acc + (i.duration || 0), 0);
  const formatTotalTime = (seconds: number) => {
    if (!seconds) return "";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return hrs > 0 ? `${hrs} hr ${mins} min` : `${mins} min`;
  };

  return (
    <div className="p-8 max-w-6xl mx-auto min-h-screen">
      {/* Back Button */}
      <button
        onClick={() => navigate("/playlists")}
        className="flex items-center gap-2 text-subtle hover:text-white mb-6 text-sm transition-colors"
      >
        <ArrowLeft size={16} />
        Back to Playlists
      </button>

      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-end gap-6 mb-8 pb-8 border-b border-white/10">
        <div className="w-40 h-40 rounded-2xl overflow-hidden bg-card border border-white/10 shadow-2xl flex-shrink-0 flex items-center justify-center">
          <PlaylistHeaderCover item={items[0]} type={playlist.type} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent/20 text-accent border border-accent/30">
              {playlist.type}
            </span>
            <span className="text-xs text-subtle">
              {items.length} {items.length === 1 ? "item" : "items"}
              {totalDuration > 0 && ` · ${formatTotalTime(totalDuration)}`}
            </span>
          </div>

          {isEditing ? (
            <div className="space-y-2 max-w-md">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full px-3 py-1.5 text-lg font-bold rounded-xl bg-panel border border-border text-white focus:outline-none focus:border-accent"
                autoFocus
              />
              <input
                type="text"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Description"
                className="w-full px-3 py-1 text-xs rounded-lg bg-panel border border-border text-white focus:outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveEdit}
                  className="btn-primary text-xs py-1 px-3 flex items-center gap-1"
                >
                  <Check size={14} /> Save
                </button>
                <button
                  onClick={() => setIsEditing(false)}
                  className="btn-secondary text-xs py-1 px-3"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-3">
                <h1 className="font-display text-4xl text-bright truncate leading-tight">
                  {playlist.name}
                </h1>
                <button
                  onClick={handleStartEdit}
                  title="Edit Playlist"
                  className="p-1.5 rounded-lg text-subtle hover:text-white hover:bg-white/10 transition-colors"
                >
                  <Edit2 size={16} />
                </button>
              </div>
              {playlist.description && (
                <p className="text-subtle font-body text-sm mt-1 max-w-2xl">
                  {playlist.description}
                </p>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-3 mt-5">
            <button
              onClick={() => handlePlayIndex(0)}
              disabled={items.length === 0}
              className="btn-primary text-xs py-2 px-5 flex items-center gap-2 disabled:opacity-50"
            >
              <Play size={14} fill="currentColor" />
              Play All
            </button>
            <button
              onClick={handleShuffle}
              disabled={items.length <= 1}
              className="btn-secondary text-xs py-2 px-4 flex items-center gap-2 disabled:opacity-50"
            >
              <Shuffle size={14} />
              Shuffle
            </button>
            <button
              onClick={handleDownloadAll}
              disabled={items.length === 0}
              className="btn-secondary text-xs py-2 px-4 flex items-center gap-2 disabled:opacity-50"
            >
              <Download size={14} />
              Download All
            </button>
            <button
              onClick={handleDelete}
              className="btn-secondary text-xs py-2 px-3 text-subtle hover:text-red-400"
              title="Delete Playlist"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Items List */}
      {items.length === 0 ? (
        <div className="text-center py-16 bg-white/5 rounded-2xl border border-white/10 max-w-md mx-auto p-8">
          <p className="text-subtle text-sm">This playlist is empty.</p>
          <p className="text-subtle text-xs mt-1">
            Browse your library and click &quot;Add to Playlist&quot; to populate it.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {items.map((item, index) => (
            <PlaylistItemRow
              key={item.id}
              item={item}
              index={index}
              totalItems={items.length}
              onPlay={() => handlePlayIndex(index)}
              onRemove={() => removeFromPlaylist(playlist.id, item.id)}
              onMoveUp={() => handleMove(index, "up")}
              onMoveDown={() => handleMove(index, "down")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PlaylistHeaderCover({ item, type }: { item?: MediaItem; type: string }) {
  const posterSrc = useArtwork(item?.posterUrl);

  if (posterSrc) {
    return <img src={posterSrc} alt="Playlist Cover" className="w-full h-full object-cover" />;
  }

  return (
    <div className="w-full h-full flex items-center justify-center bg-white/5">
      {type === "music" ? (
        <Music size={48} className="text-white/20" />
      ) : type === "video" ? (
        <Film size={48} className="text-white/20" />
      ) : (
        <Layers size={48} className="text-white/20" />
      )}
    </div>
  );
}

function PlaylistItemRow({
  item,
  index,
  totalItems,
  onPlay,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  item: MediaItem;
  index: number;
  totalItems: number;
  onPlay: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const posterSrc = useArtwork(item.posterUrl || item.thumbUrl);

  const formatDuration = (sec?: number) => {
    if (!sec) return "";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div
      tabIndex={0}
      role="button"
      aria-label={`${item.title}. Press Enter to play.`}
      onClick={onPlay}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPlay();
        }
      }}
      className="media-card flex items-center gap-3 px-4 py-2.5 rounded-xl hover:bg-card/70 focus:bg-card/90 focus:ring-2 focus:ring-accent focus:outline-none group border border-transparent hover:border-white/5 transition-all cursor-pointer"
    >
      {/* Index & Reorder */}
      <div className="flex items-center gap-1 text-subtle text-xs font-mono w-12 flex-shrink-0">
        <div className="flex flex-col opacity-0 group-hover:opacity-100 transition-opacity" tabIndex={-1} data-tv-skip="true">
          <button
            tabIndex={-1}
            data-tv-skip="true"
            onClick={onMoveUp}
            disabled={index === 0}
            className="text-subtle hover:text-white disabled:opacity-20"
          >
            <ChevronUp size={12} />
          </button>
          <button
            tabIndex={-1}
            data-tv-skip="true"
            onClick={onMoveDown}
            disabled={index === totalItems - 1}
            className="text-subtle hover:text-white disabled:opacity-20"
          >
            <ChevronDown size={12} />
          </button>
        </div>
        <span className="text-center flex-1">{index + 1}</span>
      </div>

      {/* Thumbnail */}
      <div
        onClick={onPlay}
        className="relative w-11 h-11 rounded-lg overflow-hidden bg-void flex-shrink-0 cursor-pointer border border-white/10"
      >
        {posterSrc ? (
          <img src={posterSrc} alt={item.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-white/5">
            <Play size={14} className="text-white/40" />
          </div>
        )}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
          <Play size={16} fill="currentColor" className="text-white ml-0.5" />
        </div>
      </div>

      {/* Title & Metadata */}
      <div className="flex-1 min-w-0" onClick={onPlay}>
        <p className="text-sm font-body font-semibold text-white truncate cursor-pointer group-hover:text-accent transition-colors">
          {item.episodeTitle ? `${item.showTitle ?? item.title} - ${item.episodeTitle}` : item.title}
        </p>
        <p className="text-xs text-subtle font-body truncate">
          {item.artist || item.showTitle || item.author || item.libraryType}
          {item.year ? ` · ${item.year}` : ""}
        </p>
      </div>

      {/* Duration */}
      {item.duration && (
        <span className="text-xs font-mono text-subtle">{formatDuration(item.duration)}</span>
      )}

      {/* Row Actions */}
      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity" tabIndex={-1} data-tv-skip="true">
        <FavoriteButton itemId={item.id} size="sm" />
        <button
          onClick={() => downloadSingleItem(item)}
          title={`Download "${item.title}"`}
          className="p-1.5 rounded-lg text-subtle hover:text-white hover:bg-white/10 transition-colors"
        >
          <Download size={14} />
        </button>
        <button
          onClick={onRemove}
          title="Remove from playlist"
          className="p-1.5 rounded-lg text-subtle hover:text-red-400 hover:bg-white/10 transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
