import React, { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ListMusic,
  Plus,
  Play,
  Trash2,
  Music,
  Film,
  Layers,
  Sparkles,
  Download,
  Radio,
  Search,
  Check,
  Loader2,
  Upload,
} from "lucide-react";
import { useAppStore, selectPlaylistItems, type Playlist, type MediaItem } from "../../store/appStore";
import { useArtwork } from "../../lib/artwork";
import { useToastStore } from "../../store/toastStore";
import { importExternalMusicPlaylist, type ImportedTrackCandidate } from "../../lib/playlistImporter";
import {
  parsePodcastRssFeed,
  searchItunesPodcasts,
  importOpmlFeeds,
  exportOpmlFeeds,
  type PodcastShowFeed,
} from "../../lib/podcastEngine";

export function PlaylistsPage() {
  const navigate = useNavigate();
  const playlists = useAppStore((s) => s.playlists);
  const mediaItems = useAppStore((s) => s.mediaItems);
  const deletePlaylist = useAppStore((s) => s.deletePlaylist);
  const createPlaylist = useAppStore((s) => s.createPlaylist);
  const bulkUpsertMediaItems = useAppStore((s) => s.bulkUpsertMediaItems);
  const addToast = useToastStore((s) => s.addToast);

  const [activeTab, setActiveTab] = useState<"all" | "music" | "video">("all");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newType, setNewType] = useState<"music" | "video" | "mixed">("mixed");

  const [showImportModal, setShowImportModal] = useState(false);
  const [importTab, setImportTab] = useState<"spotify" | "podcasts">("spotify");
  const [spotifyUrl, setSpotifyUrl] = useState("");
  const [importingSpotify, setImportingSpotify] = useState(false);
  const [spotifyPreview, setSpotifyPreview] = useState<{
    name: string;
    tracks: ImportedTrackCandidate[];
  } | null>(null);

  const [podcastQuery, setPodcastQuery] = useState("");
  const [searchingPodcasts, setSearchingPodcasts] = useState(false);
  const [podcastResults, setPodcastResults] = useState<
    { id: string; title: string; author: string; feedUrl: string; artworkUrl: string }[]
  >([]);
  const [rssUrlInput, setRssUrlInput] = useState("");
  const [loadingFeed, setLoadingFeed] = useState(false);

  const playlistList = useMemo(() => {
    const list = Object.values(playlists);
    if (activeTab === "all") return list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list.filter((p) => p.type === activeTab).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [playlists, activeTab]);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const id = createPlaylist(name, newType, newDesc.trim() || undefined);
    setNewName("");
    setNewDesc("");
    setShowCreateModal(false);
    addToast(`Created playlist "${name}"`, "success", 3000);
    navigate(`/playlist/${id}`);
  };

  const handleDelete = (e: React.MouseEvent, pl: Playlist) => {
    e.stopPropagation();
    if (window.confirm(`Are you sure you want to delete "${pl.name}"?`)) {
      deletePlaylist(pl.id);
      addToast(`Deleted "${pl.name}"`, "info", 3000);
    }
  };

  const handlePlayPlaylist = (e: React.MouseEvent, pl: Playlist) => {
    e.stopPropagation();
    const items = selectPlaylistItems(pl, mediaItems);
    if (items.length === 0) {
      addToast("Playlist is empty", "info", 3000);
      return;
    }

    if (pl.type === "music" || items.every((i) => i.libraryType === "music")) {
      window.dispatchEvent(
        new CustomEvent("rcloneflix:play-audio", {
          detail: { playlist: items, playlistIndex: 0 },
        })
      );
    } else {
      navigate("/play/video", { state: { item: items[0] } });
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto min-h-screen">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display text-4xl text-bright tracking-wide flex items-center gap-3">
            <ListMusic className="text-accent" size={36} />
            PLAYLISTS
          </h1>
          <p className="text-subtle font-body text-sm mt-1">
            Custom mixes, queues, and favorites synced across your devices
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <button
            onClick={() => setShowImportModal(true)}
            className="btn-secondary flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border border-accent/30 text-accent hover:border-accent"
          >
            <Download size={16} />
            Import Spotify / Podcasts
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn-primary flex items-center gap-2 px-5 py-2.5"
          >
            <Plus size={18} />
            New Playlist
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 mb-6 border-b border-white/10 pb-3">
        {(["all", "music", "video"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-xl text-xs font-semibold capitalize transition-colors ${
              activeTab === tab
                ? "bg-accent text-void"
                : "text-white/60 hover:text-white bg-white/5 hover:bg-white/10"
            }`}
          >
            {tab === "all" ? "All Playlists" : `${tab} Playlists`}
          </button>
        ))}
      </div>

      {/* Grid */}
      {playlistList.length === 0 ? (
        <div className="text-center py-20 bg-white/5 rounded-2xl border border-white/10 max-w-md mx-auto p-8">
          <Layers size={48} className="mx-auto text-subtle/40 mb-3" />
          <h3 className="font-heading font-semibold text-lg text-white mb-1">No playlists yet</h3>
          <p className="text-subtle font-body text-xs mb-5">
            Create custom video queues or music albums that automatically sync to remote backup.
          </p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn-primary inline-flex items-center gap-2 px-5 py-2 text-xs"
          >
            <Plus size={16} />
            Create Your First Playlist
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {playlistList.map((pl) => (
            <PlaylistCard
              key={pl.id}
              playlist={pl}
              onClick={() => navigate(`/playlist/${pl.id}`)}
              onPlay={(e) => handlePlayPlaylist(e, pl)}
              onDelete={(e) => handleDelete(e, pl)}
            />
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
          <div
            className="w-full max-w-md bg-neutral-900 border border-white/15 rounded-2xl shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-heading font-bold text-xl text-white mb-4">Create Playlist</h3>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-mono uppercase text-white/60 mb-1.5">
                  Name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Summer Roadtrip, Weekend Movies"
                  autoFocus
                  className="w-full px-3 py-2 text-sm rounded-xl bg-panel border border-border text-white placeholder-white/40 focus:outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="block text-xs font-mono uppercase text-white/60 mb-1.5">
                  Description (Optional)
                </label>
                <input
                  type="text"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="A short note about this playlist…"
                  className="w-full px-3 py-2 text-sm rounded-xl bg-panel border border-border text-white placeholder-white/40 focus:outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="block text-xs font-mono uppercase text-white/60 mb-1.5">
                  Type
                </label>
                <div className="flex items-center gap-2">
                  {(["mixed", "music", "video"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setNewType(t)}
                      className={`flex-1 py-2 text-xs font-medium rounded-xl capitalize border transition-colors ${
                        newType === t
                          ? "bg-accent text-void font-bold border-accent"
                          : "bg-white/5 border-white/10 text-white/60 hover:text-white"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={!newName.trim()}
                  className="btn-primary flex-1 py-2.5 text-xs disabled:opacity-50"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="btn-secondary px-5 py-2.5 text-xs"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import Spotify / Podcasts 2.0 / OPML Modal */}
      {showImportModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
          onClick={() => setShowImportModal(false)}
        >
          <div
            className="w-full max-w-xl bg-panel border border-border rounded-2xl shadow-2xl p-6 space-y-5 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h3 className="font-heading font-bold text-lg text-white flex items-center gap-2">
                <Download size={18} className="text-accent" />
                <span>Import Playlist, Podcast RSS, or OPML</span>
              </h3>
              <button
                onClick={() => setShowImportModal(false)}
                className="text-subtle hover:text-white text-xs"
              >
                ✕
              </button>
            </div>

            <div className="flex items-center gap-2 bg-surface p-1 rounded-xl border border-border">
              <button
                type="button"
                onClick={() => setImportTab("spotify")}
                className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${
                  importTab === "spotify"
                    ? "bg-accent text-void shadow"
                    : "text-subtle hover:text-white"
                }`}
              >
                <Music size={14} />
                <span>Spotify / Web Playlist</span>
              </button>
              <button
                type="button"
                onClick={() => setImportTab("podcasts")}
                className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${
                  importTab === "podcasts"
                    ? "bg-accent text-void shadow"
                    : "text-subtle hover:text-white"
                }`}
              >
                <Radio size={14} />
                <span>Podcasts 2.0 &amp; OPML</span>
              </button>
            </div>

            {importTab === "spotify" ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-subtle mb-1.5">
                    Public Spotify Playlist URL
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={spotifyUrl}
                      onChange={(e) => setSpotifyUrl(e.target.value)}
                      placeholder="https://open.spotify.com/playlist/..."
                      className="input-field flex-1 text-xs font-mono"
                    />
                    <button
                      type="button"
                      disabled={importingSpotify || !spotifyUrl.trim()}
                      onClick={async () => {
                        setImportingSpotify(true);
                        try {
                          const res = await importExternalMusicPlaylist(spotifyUrl);
                          setSpotifyPreview(res);
                          if (res.tracks.length === 0) {
                            addToast("No tracks found at that URL. Ensure the playlist is public.", "info");
                          }
                        } catch (err: any) {
                          addToast(`Import failed: ${err?.message || err}`, "error");
                        } finally {
                          setImportingSpotify(false);
                        }
                      }}
                      className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {importingSpotify ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                      <span>Fetch Tracks</span>
                    </button>
                  </div>
                </div>

                {spotifyPreview && (
                  <div className="p-4 rounded-xl bg-surface/60 border border-border space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h4 className="text-sm font-bold text-white">{spotifyPreview.name}</h4>
                        <p className="text-xs text-subtle">
                          {spotifyPreview.tracks.filter((t) => t.matchedItem).length} of{" "}
                          {spotifyPreview.tracks.length} tracks matched in your music library
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const matchedIds = spotifyPreview.tracks
                            .map((t) => t.matchedItem?.id)
                            .filter((id): id is string => Boolean(id));
                          const id = createPlaylist(
                            spotifyPreview.name,
                            "music",
                            `Imported from Spotify (${matchedIds.length}/${spotifyPreview.tracks.length} matched)`,
                            matchedIds
                          );
                          setShowImportModal(false);
                          setSpotifyPreview(null);
                          setSpotifyUrl("");
                          addToast(`Saved playlist "${spotifyPreview.name}"`, "success");
                          navigate(`/playlist/${id}`);
                        }}
                        className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
                      >
                        <Check size={14} />
                        <span>Save to My Playlists</span>
                      </button>
                    </div>

                    <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
                      {spotifyPreview.tracks.map((t, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between text-xs py-1.5 px-2.5 rounded-lg bg-panel/60 border border-border/60"
                        >
                          <div className="truncate pr-2">
                            <span className="text-white font-medium">{t.title}</span>
                            {t.artist && <span className="text-subtle"> — {t.artist}</span>}
                          </div>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded font-semibold shrink-0 ${
                              t.matchedItem
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                : "bg-white/5 text-subtle border border-white/10"
                            }`}
                          >
                            {t.matchedItem ? "Matched" : "Unmatched"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {/* Search iTunes Podcasts */}
                <div>
                  <label className="block text-xs font-medium text-subtle mb-1.5">
                    Search Podcasts Directory (iTunes / Podcasting 2.0)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={podcastQuery}
                      onChange={(e) => setPodcastQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && podcastQuery.trim()) {
                          e.preventDefault();
                          setSearchingPodcasts(true);
                          searchItunesPodcasts(podcastQuery)
                            .then(setPodcastResults)
                            .finally(() => setSearchingPodcasts(false));
                        }
                      }}
                      placeholder="Search podcast title, host, or topic..."
                      className="input-field flex-1 text-xs"
                    />
                    <button
                      type="button"
                      disabled={searchingPodcasts || !podcastQuery.trim()}
                      onClick={async () => {
                        setSearchingPodcasts(true);
                        try {
                          const res = await searchItunesPodcasts(podcastQuery);
                          setPodcastResults(res);
                        } finally {
                          setSearchingPodcasts(false);
                        }
                      }}
                      className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5"
                    >
                      {searchingPodcasts ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                      <span>Search</span>
                    </button>
                  </div>
                </div>

                {/* Direct RSS Feed URL */}
                <div>
                  <label className="block text-xs font-medium text-subtle mb-1.5">
                    Or Paste Direct Podcast RSS Feed URL
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={rssUrlInput}
                      onChange={(e) => setRssUrlInput(e.target.value)}
                      placeholder="https://feeds.example.com/podcast.xml"
                      className="input-field flex-1 text-xs font-mono"
                    />
                    <button
                      type="button"
                      disabled={loadingFeed || !rssUrlInput.trim()}
                      onClick={async () => {
                        setLoadingFeed(true);
                        try {
                          const feed: PodcastShowFeed = await parsePodcastRssFeed(rssUrlInput.trim());
                          const epItems: MediaItem[] = feed.episodes.slice(0, 100).map((ep, idx) => ({
                            id: `podcast-${Date.now()}-${idx}`,
                            libraryId: "podcasts",
                            libraryType: "music",
                            title: ep.title,
                            artist: feed.author || feed.title,
                            album: feed.title,
                            overview: ep.description,
                            posterUrl: feed.artworkUrl,
                            remotePath: ep.audioUrl,
                            sourceUrl: ep.audioUrl,
                            isSourceBookmark: true,
                            filename: `${ep.title.replace(/[^A-Za-z0-9 _-]/g, "") || "episode"}.mp3`,
                            duration: ep.durationSec,
                            addedAt: Date.now(),
                            lastScannedAt: Date.now(),
                          }));
                          bulkUpsertMediaItems(epItems);
                          const id = createPlaylist(
                            feed.title,
                            "music",
                            feed.description || `Podcast feed (${epItems.length} episodes)`,
                            epItems.map((i) => i.id)
                          );
                          addToast(`Subscribed to "${feed.title}" (${epItems.length} episodes)`, "success");
                          setShowImportModal(false);
                          navigate(`/playlist/${id}`);
                        } catch (err: any) {
                          addToast(`Failed to parse RSS feed: ${err?.message || err}`, "error");
                        } finally {
                          setLoadingFeed(false);
                        }
                      }}
                      className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5"
                    >
                      {loadingFeed ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                      <span>Add Feed</span>
                    </button>
                  </div>
                </div>

                {/* OPML Import / Export */}
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <label className="btn-secondary text-xs py-1.5 px-3 cursor-pointer flex items-center gap-1.5">
                    <Upload size={13} />
                    <span>Import OPML File</span>
                    <input
                      type="file"
                      accept=".opml,.xml"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const text = await file.text();
                        const feeds = importOpmlFeeds(text);
                        if (feeds.length === 0) {
                          addToast("No RSS feeds found in OPML file", "error");
                          return;
                        }
                        setLoadingFeed(true);
                        let importedCount = 0;
                        for (const f of feeds.slice(0, 15)) {
                          try {
                            const parsed = await parsePodcastRssFeed(f.xmlUrl);
                            const epItems: MediaItem[] = parsed.episodes.slice(0, 40).map((ep, idx) => ({
                              id: `podcast-${Date.now()}-${importedCount}-${idx}`,
                              libraryId: "podcasts",
                              libraryType: "music",
                              title: ep.title,
                              artist: parsed.author || parsed.title,
                              album: parsed.title,
                              overview: ep.description,
                              posterUrl: parsed.artworkUrl,
                              remotePath: ep.audioUrl,
                              sourceUrl: ep.audioUrl,
                              isSourceBookmark: true,
                              filename: `${ep.title.replace(/[^A-Za-z0-9 _-]/g, "") || "episode"}.mp3`,
                              duration: ep.durationSec,
                              addedAt: Date.now(),
                              lastScannedAt: Date.now(),
                            }));
                            bulkUpsertMediaItems(epItems);
                            createPlaylist(
                              parsed.title,
                              "music",
                              `OPML Podcast (${epItems.length} episodes) | Feed: ${f.xmlUrl}`,
                              epItems.map((i) => i.id)
                            );
                            importedCount++;
                          } catch {
                            // Skip broken feed
                          }
                        }
                        setLoadingFeed(false);
                        addToast(`Imported ${importedCount} podcast feeds from OPML`, "success");
                        setShowImportModal(false);
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const xml = exportOpmlFeeds(
                        podcastResults.map((p) => ({ title: p.title, xmlUrl: p.feedUrl }))
                      );
                      const blob = new Blob([xml], { type: "text/xml" });
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = "rcloneflix-podcasts.opml";
                      a.click();
                    }}
                    className="text-xs text-accent hover:underline"
                  >
                    Export OPML
                  </button>
                </div>

                {/* Search Results List */}
                {podcastResults.length > 0 && (
                  <div className="max-h-60 overflow-y-auto space-y-2 pr-1 pt-2">
                    {podcastResults.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between p-2.5 rounded-xl bg-surface/60 border border-border gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {p.artworkUrl && (
                            <img
                              src={p.artworkUrl}
                              alt={p.title}
                              className="w-10 h-10 rounded-lg object-cover shrink-0"
                            />
                          )}
                          <div className="truncate">
                            <div className="text-xs font-bold text-white truncate">{p.title}</div>
                            <div className="text-[11px] text-subtle truncate">{p.author}</div>
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={loadingFeed}
                          onClick={async () => {
                            setRssUrlInput(p.feedUrl);
                            setLoadingFeed(true);
                            try {
                              const feed = await parsePodcastRssFeed(p.feedUrl);
                              const epItems: MediaItem[] = feed.episodes.slice(0, 100).map((ep, idx) => ({
                                id: `podcast-${Date.now()}-${idx}`,
                                libraryId: "podcasts",
                                libraryType: "music",
                                title: ep.title,
                                artist: feed.author || feed.title,
                                album: feed.title,
                                overview: ep.description,
                                posterUrl: feed.artworkUrl || p.artworkUrl,
                                remotePath: ep.audioUrl,
                                sourceUrl: ep.audioUrl,
                                isSourceBookmark: true,
                                filename: `${ep.title.replace(/[^A-Za-z0-9 _-]/g, "") || "episode"}.mp3`,
                                duration: ep.durationSec,
                                addedAt: Date.now(),
                                lastScannedAt: Date.now(),
                              }));
                              bulkUpsertMediaItems(epItems);
                              const id = createPlaylist(
                                feed.title,
                                "music",
                                feed.description || `Podcast by ${feed.author}`,
                                epItems.map((i) => i.id)
                              );
                              addToast(`Subscribed to "${feed.title}" (${epItems.length} episodes)`, "success");
                              setShowImportModal(false);
                              navigate(`/playlist/${id}`);
                            } catch (err: any) {
                              addToast(`Failed to subscribe: ${err?.message || err}`, "error");
                            } finally {
                              setLoadingFeed(false);
                            }
                          }}
                          className="btn-accent text-xs py-1.5 px-3 shrink-0"
                        >
                          Subscribe
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PlaylistCard({
  playlist,
  onClick,
  onPlay,
  onDelete,
}: {
  playlist: Playlist;
  onClick: () => void;
  onPlay: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const mediaItems = useAppStore((s) => s.mediaItems);
  const items = selectPlaylistItems(playlist, mediaItems);
  const firstPoster = items[0]?.posterUrl;
  const posterSrc = useArtwork(firstPoster);

  return (
    <motion.div
      whileHover={{ y: -4 }}
      tabIndex={0}
      role="button"
      aria-label={`Playlist: ${playlist.name}. Press Enter to view.`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="media-card group relative bg-card border border-white/10 hover:border-accent/40 rounded-2xl overflow-hidden cursor-pointer shadow-lg transition-all flex flex-col focus:outline-none focus:scale-105 focus:ring-4 focus:ring-accent"
    >
      {/* Thumbnail Area */}
      <div className="relative aspect-video w-full bg-void overflow-hidden flex items-center justify-center">
        {posterSrc ? (
          <img
            src={posterSrc}
            alt={playlist.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-white/5">
            {playlist.type === "music" ? (
              <Music size={40} className="text-white/20" />
            ) : playlist.type === "video" ? (
              <Film size={40} className="text-white/20" />
            ) : (
              <Layers size={40} className="text-white/20" />
            )}
          </div>
        )}

        {/* Play Overlay */}
        {items.length > 0 && (
          <button
            tabIndex={-1}
            data-tv-skip="true"
            onClick={onPlay}
            title="Play Playlist"
            className="absolute right-3 bottom-3 w-10 h-10 rounded-full bg-accent text-void flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 transform translate-y-2 group-hover:translate-y-0 transition-all hover:scale-110 active:scale-95"
          >
            <Play size={18} fill="currentColor" className="ml-0.5" />
          </button>
        )}

        {/* Type Badge */}
        <span className="absolute top-3 left-3 text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-white/80 border border-white/10">
          {playlist.type}
        </span>
      </div>

      {/* Content */}
      <div className="p-4 flex-1 flex flex-col justify-between">
        <div>
          <h3 className="font-heading font-semibold text-white text-base truncate group-hover:text-accent transition-colors">
            {playlist.name}
          </h3>
          {playlist.description && (
            <p className="text-subtle font-body text-xs line-clamp-1 mt-0.5">
              {playlist.description}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
          <span className="text-subtle font-body text-xs">
            {playlist.itemIds.length} {playlist.itemIds.length === 1 ? "item" : "items"}
          </span>
          <button
            tabIndex={-1}
            data-tv-skip="true"
            onClick={onDelete}
            title="Delete Playlist"
            className="p-1 rounded text-white/30 hover:text-red-400 hover:bg-white/5 transition-colors opacity-0 group-hover:opacity-100"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
