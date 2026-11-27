import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, Download, Search, RefreshCw, Loader2, Disc3 } from "lucide-react";
import { useAppStore, type Library, type MusicArtist } from "../../store/appStore";
import { useToastStore } from "../../store/toastStore";
import { InfiniDyskSearchModal } from "../discovery/InfiniDyskSearchModal";
import { isAndroidRuntime } from "../../lib/rcloneNative";
import {
  buildDiscoverFeed,
  grabTrackToLibrary,
  normName,
  readCachedFeed,
  usenetQueryFor,
  type DiscoverAlbum,
  type DiscoverFeed,
  type DiscoverTrack,
} from "../../lib/musicDiscovery";

type Props = { artists: MusicArtist[]; libraries: Library[] };

export function MusicDiscoverPanel({ artists, libraries }: Props) {
  const rcloneConfigPath = useAppStore((s) => s.rcloneConfigPath);
  const addToast = useToastStore((s) => s.addToast);
  const desktop = !isAndroidRuntime();

  const [feed, setFeed] = useState<DiscoverFeed | null>(() => readCachedFeed());
  const [loading, setLoading] = useState(false);
  const [usenetQuery, setUsenetQuery] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState<Set<number>>(new Set());
  const [playingId, setPlayingId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const alive = useRef(true);

  const writable = useMemo(() => libraries.find((l) => !l.isSharedPass) || null, [libraries]);

  const libArtists = useMemo(
    () => artists.map((a) => ({ name: a.name, trackCount: a.trackCount })),
    [artists]
  );
  const libAlbumKeys = useMemo(() => {
    const s = new Set<string>();
    for (const a of artists) for (const alb of Object.values(a.albums)) s.add(normName(a.name + alb.name));
    return s;
  }, [artists]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const f = await buildDiscoverFeed(libArtists, libAlbumKeys);
      if (alive.current) setFeed(f);
      if (alive.current && !f.chartAlbums.length && !f.chartTracks.length && !f.sections.length) {
        addToast("Couldn't reach Deezer. Check your connection and try again.", "error");
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [libArtists, libAlbumKeys, addToast]);

  // Build once on first mount if there is no fresh cache.
  useEffect(() => {
    alive.current = true;
    if (!feed) void refresh();
    return () => {
      alive.current = false;
      audioRef.current?.pause();
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePreview = (t: DiscoverTrack) => {
    if (!t.previewUrl) return;
    if (playingId === t.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    // Best effort: stop any other <audio> (e.g. the mini player) so they don't overlap.
    document.querySelectorAll("audio").forEach((a) => {
      if (a !== audioRef.current) a.pause();
    });
    audioRef.current?.pause();
    const a = new Audio(t.previewUrl);
    a.onended = () => setPlayingId((cur) => (cur === t.id ? null : cur));
    a.onerror = () => {
      setPlayingId((cur) => (cur === t.id ? null : cur));
      addToast("Preview unavailable for this track.", "error");
    };
    audioRef.current = a;
    setPlayingId(t.id);
    void a.play().catch(() => setPlayingId(null));
  };

  const grab = async (t: DiscoverTrack) => {
    if (!writable) {
      addToast("Add a (non-shared) Music library first — grabbed tracks are saved there.", "error");
      return;
    }
    setGrabbing((s) => new Set(s).add(t.id));
    try {
      await grabTrackToLibrary(t, writable, rcloneConfigPath);
      addToast(`Grabbing “${t.title}” → ${writable.name}. Rescan the library when it finishes.`, "success");
    } catch (e: any) {
      addToast(`Couldn't grab track: ${e?.message || e}`, "error");
    } finally {
      setGrabbing((s) => {
        const n = new Set(s);
        n.delete(t.id);
        return n;
      });
    }
  };

  const TrackRowD = ({ t }: { t: DiscoverTrack }) => (
    <div className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-surface/60">
      {t.coverUrl ? (
        <img src={t.coverUrl} alt="" className="w-10 h-10 rounded object-cover" loading="lazy" />
      ) : (
        <div className="w-10 h-10 rounded bg-surface flex items-center justify-center"><Disc3 size={16} /></div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text truncate">{t.title}</p>
        <p className="text-xs text-subtle truncate">{t.artist} · {t.album}</p>
      </div>
      <button
        onClick={() => togglePreview(t)}
        title="Play 30-second preview"
        className="p-2 rounded-full hover:bg-accent/20 text-accent"
      >
        {playingId === t.id ? <Pause size={14} /> : <Play size={14} />}
      </button>
      {desktop && (
        <button
          onClick={() => grab(t)}
          disabled={grabbing.has(t.id)}
          title="Grab best match (YouTube → MP3) into your music library"
          className="p-2 rounded-full hover:bg-accent/20 text-accent disabled:opacity-50"
        >
          {grabbing.has(t.id) ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        </button>
      )}
    </div>
  );

  const AlbumCardD = ({ a }: { a: DiscoverAlbum }) => (
    <div className="w-36 shrink-0">
      {a.coverUrl ? (
        <img src={a.coverUrl} alt="" className="w-36 h-36 rounded-lg object-cover" loading="lazy" />
      ) : (
        <div className="w-36 h-36 rounded-lg bg-surface flex items-center justify-center"><Disc3 size={28} /></div>
      )}
      <p className="text-sm text-text mt-2 truncate" title={a.title}>{a.title}</p>
      <p className="text-xs text-subtle truncate">{a.artist}{a.year ? ` · ${a.year}` : ""}</p>
      {desktop && (
        <button
          onClick={() => setUsenetQuery(usenetQueryFor(a.artist, a.title))}
          className="mt-1 text-xs text-accent hover:underline flex items-center gap-1"
        >
          <Search size={11} /> Find on Usenet
        </button>
      )}
    </div>
  );

  return (
    <div className="pb-12">
      <div className="flex items-center justify-between mb-4">
        <p className="text-subtle text-sm">
          Recommendations from Deezer, based on your library. Previews are 30 seconds.
        </p>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {loading && !feed && (
        <div className="py-16 flex justify-center text-subtle"><Loader2 className="animate-spin" /></div>
      )}

      {feed?.sections.map((s) => (
        <section key={s.seed} className="mb-10">
          <h2 className="font-display text-2xl text-bright mb-3">Because you listen to {s.seed}</h2>
          {s.similar.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {s.similar.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-2 pr-3 rounded-full bg-surface text-sm text-text">
                  {a.pictureUrl && <img src={a.pictureUrl} alt="" className="w-7 h-7 rounded-full object-cover" loading="lazy" />}
                  {a.name}
                  {desktop && (
                    <button
                      onClick={() => setUsenetQuery(usenetQueryFor(a.name))}
                      title={`Find ${a.name} on Usenet`}
                      className="text-accent"
                    >
                      <Search size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {s.topTracks.length > 0 && <div className="mb-4">{s.topTracks.map((t) => <TrackRowD key={t.id} t={t} />)}</div>}
          {s.albums.length > 0 && (
            <div className="flex gap-4 overflow-x-auto pb-2">{s.albums.map((a) => <AlbumCardD key={a.id} a={a} />)}</div>
          )}
        </section>
      ))}

      {feed && feed.chartAlbums.length > 0 && (
        <section className="mb-10">
          <h2 className="font-display text-2xl text-bright mb-3">Trending albums</h2>
          <div className="flex gap-4 overflow-x-auto pb-2">{feed.chartAlbums.map((a) => <AlbumCardD key={a.id} a={a} />)}</div>
        </section>
      )}
      {feed && feed.chartTracks.length > 0 && (
        <section className="mb-10">
          <h2 className="font-display text-2xl text-bright mb-3">Trending tracks</h2>
          {feed.chartTracks.map((t) => <TrackRowD key={t.id} t={t} />)}
        </section>
      )}

      {feed && artists.length === 0 && (
        <p className="text-subtle text-sm">Scan some music first and this page will tailor itself to your library.</p>
      )}

      {usenetQuery !== null && (
        <InfiniDyskSearchModal
          key={usenetQuery}
          isOpen
          onClose={() => setUsenetQuery(null)}
          initialQuery={usenetQuery}
          defaultLibraryType="music"
        />
      )}
    </div>
  );
}
