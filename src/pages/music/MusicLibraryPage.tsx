import { useMemo, useState, useRef, useEffect } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { TagFilterStrip } from "../../components/common/TagFilterStrip";
import { UserTagsEditor } from "../../components/common/UserTagsEditor";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "framer-motion";
import { ChevronLeft, Search, Music, Disc3, Clock, RefreshCw, Play, Download, Sparkles, SortAsc, Cloud, Check, Loader2, AlertCircle, BookOpen, X } from "lucide-react";
import {
  useAppStore,
  selectMusicArtists,
  type MusicArtist,
  type MusicAlbum,
  type MediaItem,
} from "../../store/appStore";
import { ScanBar } from "../../components/common/ScanBar";
import { scanLibrary, refreshLibraryMetadata } from "../../lib/scanner";
import { useArtwork } from "../../lib/artwork";
import { FixMatchModal } from "../../components/library/FixMatchModal";
import { downloadSingleItem, downloadAlbum, startDownloadJob } from "../../lib/downloadManager";
import { FavoriteButton } from "../../components/common/FavoriteButton";
import { AddToPlaylistButton } from "../../components/playlist/AddToPlaylistButton";
import { offloadAudioItemToDropmb, offloadAlbumToDropmb, getDropmbExpirationStatus } from "../../lib/dropmbOffload";
import { invoke } from "@tauri-apps/api/core";
import {
  fetchAlbumLinerNotes,
  findAlbumBooklet,
  type AlbumLinerNotes,
  type BookletFile,
} from "../../lib/musicCredits";
import { useToastStore } from "../../store/toastStore";

type View = "artists" | "albums" | "tracks";
type MusicSortKey = "name" | "addedAt" | "year";

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
  const location = useLocation();
  const { libraries, mediaItems, tmdbApiKey, thePornDbApiKey, scanState, setMusicSkinMode, rcloneConfigPath } = useAppStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>("artists");
  const [sort, setSort] = useState<MusicSortKey>(() => {
    return (localStorage.getItem("rcloneflix_sort_music") as MusicSortKey) || "name";
  });
  const [selectedArtist, setSelectedArtist] = useState<MusicArtist | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<MusicAlbum | null>(null);
  const [search, setSearch] = useState("");
  const [fixMatchTarget, setFixMatchTarget] = useState<MediaItem | null>(null);
  const [fixMatchMode, setFixMatchMode] = useState<"item" | "album">("album");
  const [offloadingAlbum, setOffloadingAlbum] = useState(false);
  const [linerNotes, setLinerNotes] = useState<AlbumLinerNotes | null>(null);
  const [loadingLinerNotes, setLoadingLinerNotes] = useState(false);
  const [showLinerNotes, setShowLinerNotes] = useState(false);
  const [bookletFiles, setBookletFiles] = useState<BookletFile[]>([]);
  const [bookletImageUrls, setBookletImageUrls] = useState<Record<string, string>>({});
  const [loadingBooklet, setLoadingBooklet] = useState(false);
  const addToast = useToastStore((s) => s.addToast);

  const handleSortChange = (newSort: MusicSortKey) => {
    setSort(newSort);
    localStorage.setItem("rcloneflix_sort_music", newSort);
  };

  const musicLibraries = useMemo(
    () => libraries.filter((l) => l.type === "music"),
    [libraries]
  );
  const library = musicLibraries[0];

  // Artists are unified across all music libraries, deduplicating tracks
  // and albums and deferring duplicate tracks to the local version.
  const artists = useMemo(() => {
    const musicLibIds = new Set(musicLibraries.map((l) => l.id));
    const musicItems = Object.fromEntries(
      Object.entries(mediaItems).filter(([_, item]) => musicLibIds.has(item.libraryId))
    );
    return selectMusicArtists(musicItems);
  }, [mediaItems, musicLibraries]);

  const artistAddedAtMap = useMemo(() => {
    const map = new Map<string, { newestAddedAt: number; newestYear: number }>();
    for (const a of artists) {
      let maxAdded = 0;
      let maxYear = 0;
      for (const alb of Object.values(a.albums)) {
        if (alb.year && alb.year > maxYear) maxYear = alb.year;
        for (const t of alb.tracks) {
          if (t.addedAt > maxAdded) maxAdded = t.addedAt;
          if (t.year && t.year > maxYear) maxYear = t.year;
        }
      }
      map.set(a.name, { newestAddedAt: maxAdded, newestYear: maxYear });
    }
    return map;
  }, [artists]);

  const filteredArtists = useMemo(() => {
    let list = artists;
    if (activeTag) {
      list = list.filter((a) =>
        Object.values(a.albums).some((alb) => alb.tracks.some((t) => t.userTags?.includes(activeTag)))
      );
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((a) => a.name.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      if (sort === "addedAt") {
        return (artistAddedAtMap.get(b.name)?.newestAddedAt ?? 0) - (artistAddedAtMap.get(a.name)?.newestAddedAt ?? 0);
      }
      if (sort === "year") {
        return (artistAddedAtMap.get(b.name)?.newestYear ?? 0) - (artistAddedAtMap.get(a.name)?.newestYear ?? 0);
      }
      return a.name.localeCompare(b.name);
    });
  }, [artists, search, sort, artistAddedAtMap]);

  const [searchParams, setSearchParams] = useSearchParams();
  const activeTag = searchParams.get("tag");
  const musicItems = useMemo(
    () => Object.values(mediaItems).filter((i) => i.libraryType === "music"),
    [mediaItems]
  );

  const filteredAlbums = useMemo(() => {
    if (!selectedArtist) return [];
    let albums = Object.values(selectedArtist.albums);
    if (activeTag) {
      albums = albums.filter((alb) => alb.tracks.some((t) => t.userTags?.includes(activeTag)));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      albums = albums.filter((a) => a.name.toLowerCase().includes(q));
    }
    return [...albums].sort((a, b) => {
      if (sort === "year") {
        return (b.year ?? 0) - (a.year ?? 0);
      }
      if (sort === "addedAt") {
        const bAdded = Math.max(...b.tracks.map((t) => t.addedAt), 0);
        const aAdded = Math.max(...a.tracks.map((t) => t.addedAt), 0);
        return bAdded - aAdded;
      }
      return a.name.localeCompare(b.name);
    });
  }, [selectedArtist, search, sort]);

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

  // Automatically navigate directly to album details if passed in location.state (e.g. from Continue Playing)
  useEffect(() => {
    const state = location.state as {
      artistName?: string;
      albumName?: string;
      trackId?: string;
    } | null;

    if (!state || artists.length === 0) return;

    let targetArtist: MusicArtist | undefined;
    if (state.artistName) {
      targetArtist = artists.find(
        (a) => a.name.toLowerCase() === state.artistName?.toLowerCase()
      );
    }

    // If artist not found by name, search across all artists for the matching album or track
    if (!targetArtist) {
      for (const a of artists) {
        if (state.albumName && Object.keys(a.albums).some((alb) => alb.toLowerCase() === state.albumName?.toLowerCase())) {
          targetArtist = a;
          break;
        }
        if (state.trackId && Object.values(a.albums).some((alb) => alb.tracks.some((t) => t.id === state.trackId))) {
          targetArtist = a;
          break;
        }
      }
    }

    if (targetArtist) {
      setSelectedArtist(targetArtist);
      let targetAlbum: MusicAlbum | undefined;
      if (state.albumName) {
        targetAlbum = Object.values(targetArtist.albums).find(
          (alb) => alb.name.toLowerCase() === state.albumName?.toLowerCase()
        );
      }
      if (!targetAlbum && state.trackId) {
        targetAlbum = Object.values(targetArtist.albums).find(
          (alb) => alb.tracks.some((t) => t.id === state.trackId)
        );
      }
      if (!targetAlbum) {
        targetAlbum = Object.values(targetArtist.albums)[0];
      }

      if (targetAlbum) {
        setSelectedAlbum(targetAlbum);
        setView("tracks");
      } else {
        setView("albums");
      }
    }
  }, [location.state, artists]);

  const handleBack = () => {
    setSearch("");
    if (view === "tracks") setView("albums");
    else if (view === "albums") { setSelectedArtist(null); setView("artists"); }
  };

  // Dispatch playlist context so AudioMiniPlayer can handle download + prefetch.
  const playTrack = (index: number) => {
    window.dispatchEvent(
      new CustomEvent("rcloneflix:play-audio", {
        detail: { playlist: filteredTracks, playlistIndex: index },
      })
    );
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
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
          {library && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMusicSkinMode(true)}
                title="Switch to Compact Music Player Skin (Plexamp / Winamp Mode)"
                className="px-3 py-2 rounded-lg bg-accent/15 hover:bg-accent text-accent hover:text-void border border-accent/30 font-body font-semibold text-xs transition-all flex items-center gap-1.5"
              >
                <Disc3 size={14} />
                <span>Music Player Skin</span>
              </button>
              {view === "artists" && (
                <>
                  <button
                    onClick={async () => {
                      for (const lib of musicLibraries) {
                        await refreshLibraryMetadata(
                          lib,
                          { tmdb: tmdbApiKey, theporndb: thePornDbApiKey },
                          true
                        );
                      }
                    }}
                    disabled={scanState.status === "scanning"}
                    title="Re-fetch music artwork and tags from iTunes and MusicBrainz"
                    className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Sparkles
                      size={13}
                      className={scanState.status === "scanning" ? "animate-spin text-accent" : "text-accent"}
                    />
                    Refresh Metadata
                  </button>

                  <button
                    onClick={async () => {
                      for (const lib of musicLibraries) {
                        await scanLibrary(lib, { tmdb: tmdbApiKey, theporndb: thePornDbApiKey });
                      }
                    }}
                    disabled={scanState.status === "scanning"}
                    className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <RefreshCw
                      size={13}
                      className={scanState.status === "scanning" ? "animate-spin" : ""}
                    />
                    {scanState.status === "scanning" ? "Scanning…" : "Scan Library"}
                  </button>
                </>
              )}
            </div>
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

            {/* Search & Sort */}
            <div className="mb-6 flex items-center gap-3">
              <div className="relative flex-1 max-w-xs">
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
              {view !== "tracks" && (
                <div className="relative">
                  <SortAsc
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle pointer-events-none"
                  />
                  <select
                    value={sort}
                    onChange={(e) => handleSortChange(e.target.value as MusicSortKey)}
                    className="input-field pl-9 py-2 text-sm appearance-none pr-8 cursor-pointer"
                  >
                    <option value="name">Name (A → Z)</option>
                    <option value="addedAt">Recently Added</option>
                    <option value="year">Recently Released</option>
                  </select>
                </div>
              )}
            </div>

            {view === "artists" && (
              <TagFilterStrip
                items={musicItems}
                activeTag={activeTag}
                onSelectTag={(t) => (t ? setSearchParams({ tag: t }) : setSearchParams({}))}
              />
            )}

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
                {/* Album header with art & actions */}
                <div className="flex flex-col sm:flex-row gap-6 mb-8 items-start sm:items-end">
                  <div className="w-36 h-36 rounded-2xl overflow-hidden bg-panel border border-border shadow-xl flex-shrink-0">
                    <AlbumHeaderCover posterUrl={selectedAlbum.posterUrl} name={selectedAlbum.name} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-subtle font-body text-xs uppercase tracking-widest mb-1">Album</p>
                    <h2 className="text-bright font-display text-3xl leading-tight truncate">{selectedAlbum.name}</h2>
                    <p className="text-text font-body text-base mt-1 font-medium">{selectedAlbum.artistName}</p>
                    <div className="flex items-center gap-3 text-subtle font-body text-xs mt-1.5">
                      {selectedAlbum.year && <span>{selectedAlbum.year}</span>}
                      {selectedAlbum.year && <span>•</span>}
                      <span>{selectedAlbum.tracks.length} {selectedAlbum.tracks.length === 1 ? "track" : "tracks"}</span>
                    </div>

                    <div className="flex items-center gap-3 mt-4">
                      <button
                        onClick={() => playTrack(0)}
                        className="btn-primary text-xs py-2 px-4 flex items-center gap-2"
                      >
                        <Play size={14} className="fill-current" />
                        Play Album
                      </button>
                      <button
                        onClick={() =>
                          downloadAlbum(
                            selectedAlbum.tracks,
                            selectedAlbum.name,
                            selectedAlbum.artistName
                          )
                        }
                        className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
                        title="Download entire album"
                      >
                        <Download size={13} />
                        Download Album
                      </button>

                      {/* DropMB Album Offload */}
                      {selectedAlbum.tracks.length > 0 && (
                        selectedAlbum.tracks.every((t) =>
                          t.versions?.some(
                            (v) =>
                              v.remoteName === "dropmb" ||
                              v.remotePath.toLowerCase().includes("dropmb.com")
                          )
                        ) ? (() => {
                          const firstTrack = selectedAlbum.tracks[0];
                          const dropmbVer = firstTrack?.versions?.find(
                            (v) =>
                              v.remoteName === "dropmb" ||
                              v.remotePath.toLowerCase().includes("dropmb.com")
                          );
                          const exp = getDropmbExpirationStatus(
                            dropmbVer?.expiresAt || firstTrack?.dropmbExpiresAt
                          );
                          return (
                            <div
                              className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 text-cyan-400 border-cyan-500/30 cursor-default"
                              title={`All tracks cached on DropMB. ${exp.tooltip}`}
                            >
                              <Check size={13} className="text-cyan-400" />
                              <span>DropMB Cached • {exp.label}</span>
                            </div>
                          );
                        })() : (
                          <button
                            onClick={async () => {
                              setOffloadingAlbum(true);
                              try {
                                await offloadAlbumToDropmb(selectedAlbum.tracks, selectedAlbum.name);
                              } finally {
                                setOffloadingAlbum(false);
                              }
                            }}
                            disabled={offloadingAlbum}
                            className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 text-cyan-400 border-cyan-500/30 hover:border-cyan-400 transition-colors disabled:opacity-50"
                            title="Offload all tracks in this album to a single DropMB Container (100-Day Cloud Storage)"
                          >
                            {offloadingAlbum ? (
                              <Loader2 size={13} className="animate-spin text-cyan-400" />
                            ) : (
                              <Cloud size={13} />
                            )}
                            {offloadingAlbum ? "Offloading Album..." : "Offload Album"}
                          </button>
                        )
                      )}

                      <button
                        onClick={async () => {
                          setShowLinerNotes(true);
                          setLoadingLinerNotes(true);
                          setLoadingBooklet(true);
                          setBookletFiles([]);
                          setBookletImageUrls({});

                          // Booklet scan runs in parallel with the MusicBrainz lookup
                          const firstTrackPath = selectedAlbum.tracks[0]?.remotePath || "";
                          const albumDir =
                            firstTrackPath.includes(":") &&
                            !/^https?:\/\//i.test(firstTrackPath) &&
                            firstTrackPath.includes("/")
                              ? firstTrackPath.slice(0, firstTrackPath.lastIndexOf("/"))
                              : "";
                          void (async () => {
                            try {
                              if (!albumDir || !rcloneConfigPath) return;
                              const files = await findAlbumBooklet(rcloneConfigPath, albumDir);
                              setBookletFiles(files);
                              const urls: Record<string, string> = {};
                              const images = files.filter((f) => f.isImage).slice(0, 8);
                              for (let i = 0; i < images.length; i++) {
                                try {
                                  const res = await invoke<{ file_url: string }>("start_stream_session", {
                                    configPath: rcloneConfigPath,
                                    remoteRoot: albumDir,
                                    filePath: images[i].relPath,
                                    sessionId: `booklet-${Date.now()}-${i}`,
                                  });
                                  urls[images[i].relPath] = res.file_url;
                                } catch {
                                  // inline preview is best-effort
                                }
                              }
                              setBookletImageUrls(urls);
                            } finally {
                              setLoadingBooklet(false);
                            }
                          })();

                          try {
                            const res = await fetchAlbumLinerNotes(selectedArtist?.name || "", selectedAlbum.name);
                            setLinerNotes(res);
                          } finally {
                            setLoadingLinerNotes(false);
                          }
                        }}
                        className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
                        title="View album credits, liner notes, and booklet details from MusicBrainz"
                      >
                        <BookOpen size={13} />
                        Liner Notes
                      </button>

                      <AddToPlaylistButton
                        items={selectedAlbum.tracks}
                        size="sm"
                        showLabel
                        label="Add to Playlist"
                      />
                      <div className="w-full pt-2">
                        <UserTagsEditor
                          itemIds={selectedAlbum.tracks.map((t) => t.id)}
                          tags={Array.from(new Set(selectedAlbum.tracks.flatMap((t) => t.userTags || [])))}
                          libraryType="music"
                          libraryRoute="/music"
                        />
                      </div>
                      {selectedAlbum.tracks[0] && (
                        <button
                          onClick={() => {
                            setFixMatchMode("album");
                            setFixMatchTarget(selectedAlbum.tracks[0]);
                          }}
                          className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
                          title="Search correct artist, album art, and metadata (Reconciles entire album)"
                        >
                          <Search size={13} />
                          Fix Match
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Track list */}
                <div className="space-y-1">
                  {/* Header row */}
                  <div className="grid grid-cols-[36px_1fr_auto_60px] gap-3 px-3 pb-2 border-b border-border">
                    <span className="text-subtle font-body text-xs text-right">#</span>
                    <span className="text-subtle font-body text-xs">Title</span>
                    <span className="w-5"></span>
                    <span className="text-subtle font-body text-xs text-right flex items-center justify-end gap-1">
                      <Clock size={11} />
                    </span>
                  </div>
                  <VirtualTrackList
                    tracks={filteredTracks}
                    onPlay={playTrack}
                    onFixMatch={(track) => {
                      setFixMatchMode("item");
                      setFixMatchTarget(track);
                    }}
                    scrollRef={scrollRef}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {fixMatchTarget && (
        <FixMatchModal
          item={fixMatchTarget}
          mode={fixMatchMode}
          albumTracks={fixMatchMode === "album" ? selectedAlbum?.tracks : undefined}
          onClose={() => setFixMatchTarget(null)}
        />
      )}

      {/* Album Liner Notes & Booklet Modal - Solid UI Standard */}
      {showLinerNotes && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80">
          <div className="w-full max-w-lg max-h-[80vh] rounded-2xl bg-panel border border-border shadow-2xl p-5 flex flex-col gap-4 text-white overflow-hidden">
            <div className="flex items-center justify-between pb-3 border-b border-white/10 shrink-0">
              <h3 className="text-sm font-heading font-bold text-white flex items-center gap-2">
                <BookOpen size={16} className="text-accent" />
                <span>Liner Notes & Booklet</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowLinerNotes(false)}
                className="p-1 rounded-lg hover:bg-white/10 text-white/60 hover:text-white cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-1 text-xs text-white/80">
              {loadingLinerNotes ? (
                <div className="py-16 flex flex-col items-center justify-center gap-3">
                  <Loader2 size={24} className="animate-spin text-accent" />
                  <p className="text-white/60">Fetching MusicBrainz booklet & liner notes…</p>
                </div>
              ) : linerNotes ? (
                <div className="space-y-4">
                  <div>
                    <h4 className="text-base font-bold text-white">{linerNotes.albumTitle}</h4>
                    <p className="text-accent font-medium">{linerNotes.artistName}</p>
                    {linerNotes.disambiguation && (
                      <p className="text-[11px] text-white/50 italic mt-0.5">{linerNotes.disambiguation}</p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2 p-3 rounded-xl bg-surface border border-white/10 font-mono text-[11px]">
                    {linerNotes.releaseDate && (
                      <div>
                        <span className="text-white/40 block">Release Date:</span>
                        <span>{linerNotes.releaseDate}</span>
                      </div>
                    )}
                    {linerNotes.country && (
                      <div>
                        <span className="text-white/40 block">Country:</span>
                        <span>{linerNotes.country}</span>
                      </div>
                    )}
                    {linerNotes.label && (
                      <div>
                        <span className="text-white/40 block">Record Label:</span>
                        <span>{linerNotes.label}</span>
                      </div>
                    )}
                    {linerNotes.barcode && (
                      <div>
                        <span className="text-white/40 block">Barcode / UPC:</span>
                        <span>{linerNotes.barcode}</span>
                      </div>
                    )}
                  </div>

                  {linerNotes.credits && linerNotes.credits.length > 0 && (
                    <div>
                      <h5 className="font-semibold text-white/70 mb-2 uppercase tracking-wider text-[10px]">
                        Personnel & Production Credits
                      </h5>
                      <div className="space-y-1">
                        {linerNotes.credits.map((c, idx) => (
                          <div
                            key={idx}
                            className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface/50 border border-white/5"
                          >
                            <span className="text-white/50 capitalize truncate">{c.role}</span>
                            <span className="text-white/85 font-medium truncate text-right">{c.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {linerNotes.tracks && linerNotes.tracks.length > 0 && (
                    <div>
                      <h5 className="font-semibold text-white/70 mb-2 uppercase tracking-wider text-[10px]">
                        Tracklist & Performance Credits
                      </h5>
                      <div className="space-y-1">
                        {linerNotes.tracks.map((t, idx) => (
                          <div
                            key={idx}
                            className="flex items-center justify-between p-2 rounded-lg bg-surface/50 border border-white/5"
                          >
                            <div className="flex items-center gap-2 truncate">
                              <span className="w-5 text-white/40 font-mono text-[10px] text-right">
                                {t.position || idx + 1}
                              </span>
                              <span className="truncate">{t.title}</span>
                            </div>
                            {t.artistCredit && t.artistCredit !== linerNotes.artistName && (
                              <span className="text-white/50 text-[10px] truncate max-w-[120px]">
                                {t.artistCredit}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-12 text-center text-white/50">
                  No MusicBrainz release credits found for this album.
                </div>
              )}

              {/* Digital booklet & scans found next to the album's tracks */}
              {loadingBooklet && !loadingLinerNotes && (
                <div className="flex items-center gap-2 text-white/40 text-[11px] pt-2">
                  <Loader2 size={12} className="animate-spin" />
                  Scanning album folder for booklet files…
                </div>
              )}
              {!loadingBooklet && bookletFiles.length > 0 && (
                <div className="pt-3 border-t border-white/10 space-y-2">
                  <h5 className="font-semibold text-white/70 uppercase tracking-wider text-[10px]">
                    Digital Booklet & Scans ({bookletFiles.length})
                  </h5>
                  {bookletFiles.filter((f) => f.isPdf).map((f) => (
                    <div
                      key={f.relPath}
                      className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface/50 border border-white/5"
                    >
                      <div className="min-w-0 flex items-center gap-2">
                        <BookOpen size={13} className="text-accent flex-shrink-0" />
                        <span className="truncate">{f.name}</span>
                        {f.size > 0 && (
                          <span className="text-white/35 text-[10px] flex-shrink-0">
                            {(f.size / (1024 * 1024)).toFixed(1)} MB
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          startDownloadJob(`${linerNotes?.albumTitle || selectedAlbum?.name || "Album"} booklet`, [
                            { remote_path: f.remotePath, filename: f.name, subfolder: "Booklets" },
                          ])
                        }
                        className="btn-secondary text-[10px] py-1 px-2 flex items-center gap-1 flex-shrink-0"
                        title="Download booklet PDF (PDFs cannot render inline in this webview)"
                      >
                        <Download size={11} />
                        Download
                      </button>
                    </div>
                  ))}
                  {bookletFiles.some((f) => f.isImage && bookletImageUrls[f.relPath]) && (
                    <div className="grid grid-cols-2 gap-2">
                      {bookletFiles
                        .filter((f) => f.isImage && bookletImageUrls[f.relPath])
                        .map((f) => (
                          <img
                            key={f.relPath}
                            src={bookletImageUrls[f.relPath]}
                            alt={f.name}
                            title={f.name}
                            loading="lazy"
                            className="w-full rounded-lg border border-white/10 object-cover"
                          />
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function AlbumHeaderCover({ posterUrl, name }: { posterUrl?: string; name: string }) {
  const [imgErr, setImgErr] = useState(false);
  const posterSrc = useArtwork(posterUrl);

  if (posterSrc && !imgErr) {
    return (
      <img
        src={posterSrc}
        alt={name}
        className="w-full h-full object-cover"
        onError={() => setImgErr(true)}
      />
    );
  }

  return (
    <div className={`w-full h-full bg-gradient-to-br ${PALETTE[0]} flex items-center justify-center`}>
      <Disc3 size={48} className="text-white/40" />
    </div>
  );
}

function ArtistCard({ artist, index, onClick }: { artist: MusicArtist; index: number; onClick: () => void }) {
  const [imgErr, setImgErr] = useState(false);
  const posterSrc = useArtwork(artist.posterUrl);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.5) }}
      tabIndex={0}
      role="button"
      aria-label={`Artist: ${artist.name}. Press Enter to view albums.`}
      className="media-card flex flex-col gap-2 cursor-pointer group focus:outline-none focus:scale-105 focus:ring-4 focus:ring-accent rounded-xl"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/* Round avatar for artists */}
      <div className="relative rounded-full overflow-hidden aspect-square bg-panel border border-border
        hover:border-muted hover:scale-[1.03] hover:shadow-card-hover transition-all duration-300">
        {posterSrc && !imgErr ? (
          <img
            src={posterSrc}
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
  const posterSrc = useArtwork(album.posterUrl);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.5) }}
      tabIndex={0}
      role="button"
      aria-label={`Album: ${album.name}. Press Enter to view tracks.`}
      className="media-card flex flex-col gap-2 cursor-pointer group focus:outline-none focus:scale-105 focus:ring-4 focus:ring-accent rounded-xl"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="relative rounded-xl overflow-hidden aspect-square bg-panel border border-border
        hover:border-muted hover:scale-[1.03] hover:shadow-card-hover transition-all duration-300">
        {posterSrc && !imgErr ? (
          <img
            src={posterSrc}
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
  onClick,
  onFixMatch,
}: {
  track: MediaItem;
  index: number;
  onClick: () => void;
  onFixMatch?: (track: MediaItem) => void;
}) {
  const isTrackDropmbCached = track.versions?.some(
    (v) => v.remoteName === "dropmb" || v.remotePath.toLowerCase().includes("dropmb.com")
  );
  const [offloadingTrack, setOffloadingTrack] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: Math.min(index * 0.02, 0.3) }}
      tabIndex={0}
      role="button"
      aria-label={`Track: ${track.title}. Press Enter to play.`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="media-card grid grid-cols-[36px_1fr_auto_60px] gap-3 px-3 py-2.5 rounded-lg
        hover:bg-panel focus:bg-panel focus:ring-2 focus:ring-accent focus:outline-none cursor-pointer group transition-colors items-center"
    >
      <div className="text-subtle font-body text-sm text-right flex items-center justify-end">
        <span className="group-hover:hidden">{track.trackNumber ?? index + 1}</span>
        <Play size={13} className="hidden group-hover:inline text-accent fill-current" />
      </div>
      <div className="min-w-0">
        <p className="text-text font-body text-sm truncate group-hover:text-accent transition-colors font-medium">
          {track.title}
        </p>
        {track.artist && (
          <p className="text-subtle font-body text-xs truncate">{track.artist}</p>
        )}
      </div>
      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1" tabIndex={-1} data-tv-skip="true">
        <FavoriteButton itemId={track.id} size="sm" />
        <AddToPlaylistButton items={track} size="sm" />
        <button
          onClick={(e) => {
            e.stopPropagation();
            downloadSingleItem(track);
          }}
          title={`Download "${track.title}"`}
          className="p-1 rounded text-subtle hover:text-accent hover:bg-surface/50 transition-colors"
        >
          <Download size={13} />
        </button>
        {isTrackDropmbCached ? (() => {
          const dropmbVer = track.versions?.find(
            (v) =>
              v.remoteName === "dropmb" ||
              v.remotePath.toLowerCase().includes("dropmb.com")
          );
          const exp = getDropmbExpirationStatus(
            dropmbVer?.expiresAt || track.dropmbExpiresAt
          );
          return (
            <div
              className="p-1 rounded text-cyan-400 cursor-default"
              title={`Cached on DropMB Cloud. ${exp.tooltip}`}
            >
              <Check size={13} className="text-cyan-400" />
            </div>
          );
        })() : (
          <button
            onClick={async (e) => {
              e.stopPropagation();
              setOffloadingTrack(true);
              await offloadAudioItemToDropmb(track);
              setOffloadingTrack(false);
            }}
            disabled={offloadingTrack}
            title={`Offload "${track.title}" to DropMB (100-Day Cloud)`}
            className="p-1 rounded text-subtle hover:text-cyan-400 hover:bg-surface/50 transition-colors"
          >
            {offloadingTrack ? (
              <Loader2 size={13} className="animate-spin text-cyan-400" />
            ) : (
              <Cloud size={13} />
            )}
          </button>
        )}
        {onFixMatch && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFixMatch(track);
            }}
            title="Fix track match"
            className="p-1 rounded text-subtle hover:text-text hover:bg-surface/50 transition-colors"
          >
            <Search size={13} />
          </button>
        )}
      </div>
      <span className="text-subtle font-body text-xs text-right">
        {formatDuration(track.duration)}
      </span>
    </motion.div>
  );
}

function VirtualTrackList({
  tracks,
  onPlay,
  onFixMatch,
  scrollRef,
}: {
  tracks: MediaItem[];
  onPlay: (index: number) => void;
  onFixMatch?: (track: MediaItem) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setScrollMargin(el.offsetTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tracks.length]);

  const ROW_HEIGHT = 48;
  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin,
  });

  return (
    <div ref={listRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: ROW_HEIGHT,
              transform: `translateY(${row.start - scrollMargin}px)`,
            }}
          >
            <TrackRow
              track={tracks[row.index]}
              index={row.index}
              onClick={() => onPlay(row.index)}
              onFixMatch={onFixMatch}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
