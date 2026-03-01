import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, Search, Music, Disc33, Clock } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import {
  useAppStore,
  selectMusicArtists,
  type MusicArtist,
  type MusicAlbum,
  type MediaItem,
} from "../../store/appStore";
import { ScanBar } from "../../components/common/ScanBar";
import { scanLibrary } from "../../lib/scanner";

type View = "artists" | "albums" | "tracks";

const PALETTE = [
  "from-indigo-900 to-indigo-800",
  "from-violet-900 to-violet-800",
  "from-rose-900 to-rose-800",
  "from-amber-900 to-amber-800",
  "from-teal-900 to-teal-800",
  "from-sky-900 to-sky-800",
];

function formatDuration(seconds: number | undefined) {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function MusicLibraryPage() {
  const { libraries, mediaItems, rcloneConfigPath, tmdbApiKey, thePornDbApiKey } = useAppStore();
  const [view, setView] = useState<View>("artists");
  const [selectedArtist, setSelectedArtist] = useState<MusicArtist | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<MusicAlbum | null>(null);
  const [search, setSearch] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);

  const library = libraries.find((l) => l.type === "music");

  const artists = useMemo(() => {
    if (!library) return [];
    return selectMusicArtists(mediaItems, library.id);
  }, [mediaItems, library]);

  const filteredArtists = useMemo(() => {
    if (!search.trim()) return artists;
    const q = search.toLowerCase();
    return artists.filter((a) => a.name.toLowerCase().includes(q));
  }, [artists, search]);

  const filteredAlbums = useMemo(() => {
    if (!selectedArtist) return [];
    const albums = Object.values(selectedArtist.albums);
    if (!search.trim()) return albums;
    const q = search.toLowerCase();
    return albums.filter((a) => a.name.toLowerCase().includes(q));
  }, [selectedArtist, search]);

  const filteredTracks = useMemo(() => {
    if (!selectedAlbum) return [];
    if (!search.trim()) return selectedAlbum.tracks;
    const q = search.toLowerCase();
    return selectedAlbum.tracks.filter((t) => t.title.toLowerCase().includes(q));
  }, [selectedAlbum, search]);

  const navigateTo = (next: View, artist?: MusicArtist, album?: MusicAlbum) => {
    setSearch("");
    if (artist !== undefined) setSelectedArtist(artist);
    if (album !== undefined) setSelectedAlbum(album);
    setView(next);
  };

  const handleBack = () => {
    setSearch("");
    if (view === "tracks") setView("albums");
    else if (view === "albums") { setSelectedArtist(null); setView("artists"); }
  };

  const playTrack = async (track: MediaItem) => {
    if (!library) return;
    setPlayingId(track.id);
    try {
      const libRoot = library.remotePath.replace(/\/$/, "");
      const relPath = track.remotePath.startsWith(libRoot + "/")
        ? track.remotePath.slice(libRoot.length + 1)
        : track.remotePath.split("/").pop() ?? track.filename;

      const result = await invoke<{ file_url: string }>("start_stream_session", {
        configPath: rcloneConfigPath,
        remoteRoot: library.remotePath,
        filePath: relPath,
        sessionId: `music-${track.id}`,
      });
      window.dispatchEvent(
        new CustomEvent("rcloneflix:play-audio", {
          detail: { item: track, streamUrl: result.file_url },
        })
      );
    } catch (e) {
      console.error("Failed to stream track:", e);
    } finally {
      setPlayingId(null);
    }
  };

  // ── Breadcrumb ─────────────────────────────────────────────────────────────

  const breadcrumb = (
    <div className="flex items-center gap-2 text-subtle font-body text-sm mb-6">
      <button
        onClick={() => navigateTo("artists")}
        className={view === "artists" ? "text-text font-semibold" : "hover:text-text transition-colors"}
      >
        {library?.name ?? "Music"}
      </button>
      {selectedArtist && (
        <>
          <span>/</span>
          <button
            onClick={() => navigateTo("albums")}
            className={view === "albums" ? "text-text font-semibold" : "hover:text-text transition-colors"}
          >
            {selectedArtist.name}
          </button>
        </>
      )}
      {selectedAlbum && view === "tracks" && (
        <>
          <span>/</span>
          <span className="text-text font-semibold">{selectedAlbum.name}</span>
        </>
      )}
    </div>
  );

  const displayName = library?.name ?? "Music";
  const subtitle =
    view === "artists"
      ? `${artists.length} artists`
      : view === "albums" && selectedArtist
      ? `${selectedArtist.albumCount} albums · ${selectedArtist.trackCount} tracks`
      : selectedAlbum
      ? `${selectedAlbum.tracks.length} tracks${selectedAlbum.year ? ` · ${selectedAlbum.year}` : ""}`
      : "";

  return (
    <div className="flex flex-col h-full">
      <ScanBar libraryId={library?.id} />
      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="px-8 pt-8 pb-4 flex items-end justify-between">
          <div>
            <div className="flex items-center gap-3">
              {view !== "artists" && (
                <button
                  onClick={handleBack}
                  className="text-subtle hover:text-text transition-colors"
                >
                  <ChevronLeft size={24} />
                </button>
              )}
              <h1 className="font-display text-5xl text-bright tracking-wide">
                {view === "artists"
                  ? displayName.toUpperCase()
                  : view === "albums"
                  ? selectedArtist?.name.toUpperCase()
                  : selectedAlbum?.name.toUpperCase()}
              </h1>
            </div>
            <p className="text-subtle font-body text-sm mt-1 ml-1">{subtitle}</p>
          </div>
          {library && view === "artists" && (
            <button
              onClick={() => scanLibrary(library, { tmdb: tmdbApiKey, theporndb: thePornDbApiKey })}
              className="btn-secondary text-xs py-2 px-3"
            >
              Scan Library
            </button>
          )}
        </div>

        {/* No library */}
        {!library && (
          <div className="px-8 py-16 text-center">
            <p className="text-subtle font-body text-sm mb-3">No music library configured yet.</p>
          </div>
        )}

        {library && (
          <div className="px-8">
            {/* Breadcrumb */}
            {view !== "artists" && breadcrumb}

            {/* Search */}
            <div className="mb-6 max-w-xs">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={
                    view === "artists" ? "Search artists…" :
                    view === "albums" ? "Search albums…" : "Search tracks…"
                  }
                  className="input-field pl-9 py-2 text-sm w-full"
                />
              </div>
            </div>

            {/* Artists grid */}
            {view === "artists" && (
              filteredArtists.length === 0 ? (
                <p className="text-subtle font-body text-sm py-12 text-center">
                  {search ? `No artists matching "${search}"` : "No music yet. Run a scan to populate this library."}
                </p>
              ) : (
                <div
                  className="grid gap-5 pb-12"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
                >
                  {filteredArtists.map((artist, i) => (
                    <ArtistCard
                      key={artist.name}
                      artist={artist}
                      index={i}
                      onClick={() => navigateTo("albums", artist)}
                    />
                  ))}
                </div>
              )
            )}

            {/* Albums grid */}
            {view === "albums" && (
              filteredAlbums.length === 0 ? (
                <p className="text-subtle font-body text-sm py-12 text-center">
                  {search ? `No albums matching "${search}"` : "No albums found."}
                </p>
              ) : (
                <div
                  className="grid gap-5 pb-12"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
                >
                  {filteredAlbums.map((album, i) => (
                    <AlbumCard
                      key={album.name}
                      album={album}
                      index={i}
                      onClick={() => navigateTo("tracks", undefined, album)}
                    />
                  ))}
                </div>
              )
            )}

            {/* Track list */}
            {view === "tracks" && selectedAlbum && (
              <div className="pb-12 max-w-2xl">
                {/* Album header with art */}
                <div className="flex gap-5 mb-8">
                  <div className="w-32 h-32 rounded-xl overflow-hidden bg-panel border border-border flex-shrink-0">
                    {selectedAlbum.posterUrl ? (
                      <img src={selectedAlbum.posterUrl} alt={selectedAlbum.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className={`w-full h-full bg-gradient-to-br ${PALETTE[0]} flex items-center justify-center`}>
                        <Disc3 size={40} className="text-white/40" />
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col justify-end">
                    <p className="text-subtle font-body text-xs uppercase tracking-widest mb-1">Album</p>
                    <h2 className="text-bright font-display text-2xl leading-tight">{selectedAlbum.name}</h2>
                    <p className="text-subtle font-body text-sm mt-1">{selectedAlbum.artistName}</p>
                    {selectedAlbum.year && <p className="text-subtle font-body text-xs mt-0.5">{selectedAlbum.year}</p>}
                  </div>
                </div>

                {/* Track list */}
                <div className="space-y-1">
                  {/* Header row */}
                  <div className="grid grid-cols-[32px_1fr_64px] gap-3 px-3 pb-2 border-b border-border">
                    <span className="text-subtle font-body text-xs text-right">#</span>
                    <span className="text-subtle font-body text-xs">Title</span>
                    <span className="text-subtle font-body text-xs text-right flex items-center justify-end gap-1">
                      <Clock size={11} />
                    </span>
                  </div>
                  {filteredTracks.map((track, i) => (
                    <TrackRow
                      key={track.id}
                      track={track}
                      index={i}
                      isLoading={playingId === track.id}
                      onClick={() => playTrack(track)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ArtistCard({ artist, index, onClick }: { artist: MusicArtist; index: number; onClick: () => void }) {
  const [imgErr, setImgErr] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.5) }}
      className="flex flex-col gap-2 cursor-pointer group"
      onClick={onClick}
    >
      {/* Round avatar for artists */}
      <div className="relative rounded-full overflow-hidden aspect-square bg-panel border border-border
        hover:border-muted hover:scale-[1.03] hover:shadow-card-hover transition-all duration-300">
        {artist.posterUrl && !imgErr ? (
          <img
            src={artist.posterUrl}
            alt={artist.name}
            className="w-full h-full object-cover"
            onError={() => setImgErr(true)}
            loading="lazy"
          />
        ) : (
          <div className={`w-full h-full bg-gradient-to-br ${PALETTE[index % PALETTE.length]} flex items-center justify-center`}>
            <Music size={28} className="text-white/40" />
          </div>
        )}
      </div>
      <div className="text-center px-1">
        <p className="text-text font-body text-sm font-medium truncate">{artist.name}</p>
        <p className="text-subtle font-body text-xs">
          {artist.albumCount} {artist.albumCount === 1 ? "album" : "albums"}
        </p>
      </div>
    </motion.div>
  );
}

function AlbumCard({ album, index, onClick }: { album: MusicAlbum; index: number; onClick: () => void }) {
  const [imgErr, setImgErr] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.5) }}
      className="flex flex-col gap-2 cursor-pointer group"
      onClick={onClick}
    >
      <div className="relative rounded-xl overflow-hidden aspect-square bg-panel border border-border
        hover:border-muted hover:scale-[1.03] hover:shadow-card-hover transition-all duration-300">
        {album.posterUrl && !imgErr ? (
          <img
            src={album.posterUrl}
            alt={album.name}
            className="w-full h-full object-cover"
            onError={() => setImgErr(true)}
            loading="lazy"
          />
        ) : (
          <div className={`w-full h-full bg-gradient-to-br ${PALETTE[index % PALETTE.length]} flex items-center justify-center`}>
            <Disc3 size={32} className="text-white/40" />
          </div>
        )}
        {/* Track count badge */}
        <div className="absolute bottom-2 right-2 bg-black/70 rounded px-1.5 py-0.5">
          <span className="text-white/80 text-xs font-body">{album.tracks.length} tracks</span>
        </div>
      </div>
      <div className="px-0.5">
        <p className="text-text font-body text-sm font-medium truncate">{album.name}</p>
        <p className="text-subtle font-body text-xs">{album.year ?? ""}</p>
      </div>
    </motion.div>
  );
}

function TrackRow({
  track,
  index,
  isLoading,
  onClick,
}: {
  track: MediaItem;
  index: number;
  isLoading: boolean;
  onClick: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: Math.min(index * 0.02, 0.3) }}
      onClick={onClick}
      className="grid grid-cols-[32px_1fr_64px] gap-3 px-3 py-2 rounded-lg
        hover:bg-panel cursor-pointer group transition-colors"
    >
      <span className="text-subtle font-body text-sm text-right self-center">
        {isLoading ? (
          <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        ) : (
          track.trackNumber ?? index + 1
        )}
      </span>
      <div className="min-w-0 self-center">
        <p className="text-text font-body text-sm truncate group-hover:text-accent transition-colors">
          {track.title}
        </p>
        {track.artist && (
          <p className="text-subtle font-body text-xs truncate">{track.artist}</p>
        )}
      </div>
      <span className="text-subtle font-body text-xs text-right self-center">
        {formatDuration(track.duration)}
      </span>
    </motion.div>
  );
}
