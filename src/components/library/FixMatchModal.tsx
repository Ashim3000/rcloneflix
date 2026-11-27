import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Search, Check, Loader2, Edit3, RotateCcw, Image, Save, ExternalLink } from "lucide-react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useAppStore, type MediaItem } from "../../store/appStore";
import { searchScenesByFragment, parseAdultSceneFragment } from "../../lib/stashBox";
import { useToastStore } from "../../store/toastStore";
import { persistItems } from "../../lib/libraryDb";

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    const res = await window.fetch(url, init);
    if (res.ok || res.status < 500) {
      return res;
    }
  } catch {
    // window.fetch failed (e.g. CORS or network error), fallback to Tauri HTTP plugin
  }

  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      const res = await tauriFetch(url as any, init as any);
      return res as unknown as Response;
    } catch (err) {
      console.warn("[FixMatchModal] tauriFetch error:", err, url);
      throw err;
    }
  }

  return await window.fetch(url, init);
}

type Props = {
  item: MediaItem;
  onClose: () => void;
  mode?: "item" | "album";
  albumTracks?: MediaItem[];
};

type SearchResult = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  year?: number;
  duration?: number;
  genres?: string[];
  posterUrl?: string;
  overview?: string;
  source: "cinemeta" | "tmdb" | "musicbrainz" | "openlibrary" | "itunes" | "deezer" | "theporndb" | "stashbox" | "audnexus" | "googlebooks";
};

export function FixMatchModal({ item, onClose, mode = "item", albumTracks }: Props) {
  const { tmdbApiKey, thePornDbApiKey, stashBoxProviders, libraries, updateItemMetadata } = useAppStore();
  const effectiveLibraryType: string =
    libraries.find((l) => l.id === item.libraryId)?.type || item.libraryType;

  const getInitialQuery = () => {
    if (item.libraryType === "music") {
      return item.album
        ? `${item.artist ? item.artist + " " : ""}${item.album}`
        : item.artist
        ? `${item.artist} ${item.title}`
        : item.title;
    }
    if (item.libraryType === "books" || item.libraryType === "audiobooks") {
      if (item.album) {
        return item.author ? `${item.author} ${item.album}` : item.album;
      }
      if (item.author && item.title) {
        return `${item.author} ${item.title}`;
      }
      if (item.title && item.title.includes(" - ")) {
        return item.title;
      }
    }
    if (item.libraryType === "tv") {
      if (item.showTitle && item.showTitle.trim()) {
        return item.showTitle.trim();
      }
    }

    // For movies, adult, or tv: check if item.title already has a cleaned human title
    if (item.title && !item.title.match(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|iso|ts)$/i)) {
      const cleanExisting = item.title
        .replace(/\{tmdb-\d+\}/gi, "")
        .replace(/\{imdb-tt\d+\}/gi, "")
        .replace(item.libraryType === "tv" ? /[sS]\d{1,2}[eE]\d{1,2}.*|\b\d{1,2}x\d{1,2}\b.*/gi : /^$/, "")
        .replace(/\b(1080p|720p|2160p|4k|hdr|web[-.]?dl|webrip|bluray|brrip|dvdrip|hdtv|x264|x265|h264|hevc|remux|repack|proper|ddp5\.1|aac|dts)\b.*/gi, "")
        .replace(/[[(](19\d\d|20\d\d)[\])]/g, "")
        .replace(/[_.]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (cleanExisting && cleanExisting.length > 1) {
        return cleanExisting;
      }
    }

    // Clean filename stem: strip extensions, track/chapter prefixes, {tmdb-...}, {imdb-...}, scene tags, (YYYY), etc.
    const filenameStem = item.filename.replace(/\.[^/.]+$/, "");
    const cleanStem = filenameStem
      .replace(/^(\d+[\s._-]+|chapter[\s._-]+\d+[\s._-]*)/i, "")
      .replace(/\b(unabridged|abridged|audiobook|audiobooks|narrated by [^)]+|cd\s*\d+|disc\s*\d+|part\s*\d+|pt\s*\d+|\d+kbps)\b/gi, "")
      .replace(/\{tmdb-\d+\}/gi, "")
      .replace(/\{imdb-tt\d+\}/gi, "")
      .replace(item.libraryType === "tv" ? /[sS]\d{1,2}[eE]\d{1,2}.*|\b\d{1,2}x\d{1,2}\b.*/gi : /^$/, "")
      .replace(/\b(1080p|720p|2160p|4k|hdr|web[-.]?dl|webrip|bluray|brrip|dvdrip|hdtv|x264|x265|h264|hevc|remux|repack|proper|ddp5\.1|aac|dts)\b.*/gi, "")
      .replace(/[[(](19\d\d|20\d\d)[\])]/g, "")
      .replace(/[_.]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return cleanStem || item.title || item.filename;
  };

  const initialQuery = getInitialQuery();
  const [activeTab, setActiveTab] = useState<"search" | "manual">("search");
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Manual edit fields
  const [manualTitle, setManualTitle] = useState(item.title);
  const [manualYear, setManualYear] = useState<string>(item.year ? String(item.year) : "");
  const [manualOverview, setManualOverview] = useState(item.overview || "");
  const [manualPosterUrl, setManualPosterUrl] = useState(item.posterUrl || "");
  const [manualBackdropUrl, setManualBackdropUrl] = useState(item.backdropUrl || "");
  const [manualGenres, setManualGenres] = useState(item.genres ? item.genres.join(", ") : "");
  const [manualSeason, setManualSeason] = useState<string>(item.season !== undefined ? String(item.season) : "");
  const [manualEpisode, setManualEpisode] = useState<string>(item.episode !== undefined ? String(item.episode) : "");
  const [manualShowTitle, setManualShowTitle] = useState(item.showTitle || "");
  const [manualArtist, setManualArtist] = useState(item.artist || item.author || "");
  const [manualAlbum, setManualAlbum] = useState(item.album || "");
  const [manualAuthor, setManualAuthor] = useState(item.author || item.artist || "");

  const handleApplyToManual = (result: SearchResult) => {
    const isMultiChapter = Boolean(
      (item.libraryType === "audiobooks" || item.libraryType === "books") &&
      item.album &&
      item.album !== item.title
    );
    if (isMultiChapter) {
      setManualAlbum(result.title);
    } else {
      setManualTitle(result.title);
      if (result.album) {
        setManualAlbum(result.album);
      }
    }
    setManualYear(result.year ? String(result.year) : "");
    setManualOverview(result.overview || "");
    setManualPosterUrl(result.posterUrl || "");
    if (result.genres) {
      setManualGenres(result.genres.join(", "));
    }
    if (result.artist) {
      setManualArtist(result.artist);
      setManualAuthor(result.artist);
    }
    setActiveTab("manual");
  };

  const handleSaveManual = () => {
    const parsedYear = manualYear.trim() ? parseInt(manualYear.trim(), 10) : undefined;
    const parsedSeason = manualSeason.trim() ? parseInt(manualSeason.trim(), 10) : undefined;
    const parsedEpisode = manualEpisode.trim() ? parseInt(manualEpisode.trim(), 10) : undefined;
    const parsedGenres = manualGenres
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);

    const updatedItem: MediaItem = {
      ...item,
      title: manualTitle.trim() || item.filename,
      year: isNaN(parsedYear as number) ? undefined : parsedYear,
      overview: manualOverview.trim() || undefined,
      posterUrl: manualPosterUrl.trim() || undefined,
      backdropUrl: manualBackdropUrl.trim() || undefined,
      genres: parsedGenres.length > 0 ? parsedGenres : undefined,
      metadataConfidence: "manual",
      metadataSource: "manual",
      ...(item.libraryType === "tv"
        ? {
            season: isNaN(parsedSeason as number) ? undefined : parsedSeason,
            episode: isNaN(parsedEpisode as number) ? undefined : parsedEpisode,
            showTitle: manualShowTitle.trim() || undefined,
          }
        : {}),
      ...(item.libraryType === "music"
        ? {
            artist: manualArtist.trim() || undefined,
            album: manualAlbum.trim() || undefined,
          }
        : {}),
      ...(item.libraryType === "books" || item.libraryType === "audiobooks"
        ? {
            author: manualAuthor.trim() || undefined,
            artist: manualAuthor.trim() || undefined,
            album: manualAlbum.trim() || undefined,
          }
        : {}),
    };

    updateItemMetadata(item.id, updatedItem);
    persistItems([updatedItem]).catch((err) => console.error("Failed persisting manual match:", err));

    // Propagate changes to sibling tracks if music or mode === "album"
    if (item.libraryType === "music" || mode === "album") {
      const targetAlbum = manualAlbum.trim() || item.album;
      const targetArtist = manualArtist.trim() || item.artist;
      const allItems = useAppStore.getState().mediaItems;
      const tracksToUpdate = albumTracks || Object.values(allItems).filter(
        (other) => other.libraryId === item.libraryId && other.album === item.album
      );
      const updates: MediaItem[] = tracksToUpdate.map((other) => ({
        ...other,
        album: targetAlbum || other.album,
        artist: targetArtist || other.artist,
        posterUrl: manualPosterUrl.trim() || other.posterUrl,
        backdropUrl: manualBackdropUrl.trim() || other.backdropUrl,
        year: manualYear.trim() ? parseInt(manualYear.trim(), 10) : other.year,
        genres: manualGenres.trim() ? manualGenres.split(",").map((g) => g.trim()).filter(Boolean) : other.genres,
      }));
      if (updates.length > 0) {
        useAppStore.getState().bulkUpsertMediaItems(updates);
        persistItems(updates).catch((err) => console.error("Failed persisting album tracks:", err));
      }
    }

    // Propagate changes to sibling chapters if audiobook or book
    if ((item.libraryType === "audiobooks" || item.libraryType === "books") && (updatedItem.album || item.album || item.title)) {
      const targetAlbum = updatedItem.album || item.album || item.title;
      const originalAlbum = item.album || item.title;
      const allItems = useAppStore.getState().mediaItems;
      const updates: MediaItem[] = [];
      for (const other of Object.values(allItems)) {
        if (
          other.libraryId === item.libraryId &&
          other.id !== item.id &&
          ((originalAlbum && other.album === originalAlbum) || (originalAlbum && other.title === originalAlbum))
        ) {
          updates.push({
            ...other,
            album: targetAlbum,
            author: updatedItem.author || other.author,
            artist: updatedItem.artist || other.artist,
            posterUrl: updatedItem.posterUrl || other.posterUrl,
            backdropUrl: updatedItem.backdropUrl || other.backdropUrl,
            year: updatedItem.year || other.year,
            genres: updatedItem.genres || other.genres,
            overview: updatedItem.overview || other.overview,
          });
        }
      }
      if (updates.length > 0) {
        useAppStore.getState().bulkUpsertMediaItems(updates);
        persistItems(updates).catch((err) => console.error("Failed persisting audiobook siblings:", err));
      }
    }

    // Propagate changes to sibling episodes if TV
    if (item.libraryType === "tv" && (updatedItem.showTitle || item.showTitle)) {
      const targetShowTitle = updatedItem.showTitle || item.showTitle;
      const originalShowTitle = item.showTitle || item.title;
      const allItems = useAppStore.getState().mediaItems;
      const updates: MediaItem[] = [];
      for (const other of Object.values(allItems)) {
        if (
          other.libraryId === item.libraryId &&
          other.libraryType === "tv" &&
          other.id !== item.id &&
          ((originalShowTitle && other.showTitle === originalShowTitle) ||
            (item.showId && other.showId === item.showId) ||
            (item.showTitle && other.showTitle === item.showTitle))
        ) {
          updates.push({
            ...other,
            showTitle: targetShowTitle,
            showPosterUrl: updatedItem.posterUrl || other.showPosterUrl || other.posterUrl,
            posterUrl: updatedItem.posterUrl || other.posterUrl,
            backdropUrl: updatedItem.backdropUrl || other.backdropUrl,
            showBackdropUrl: updatedItem.backdropUrl || other.showBackdropUrl || other.backdropUrl,
            year: updatedItem.year || other.year,
            genres: updatedItem.genres || other.genres,
            showOverview: updatedItem.overview || other.showOverview || other.overview,
          });
        }
      }
      if (updates.length > 0) {
        useAppStore.getState().bulkUpsertMediaItems(updates);
        persistItems(updates).catch((err) => console.error("Failed persisting tv siblings:", err));
      }
    }

    useToastStore.getState().addToast(`Updated metadata for "${updatedItem.title}"`, "success");
    onClose();
  };

  const handleResetToFilename = () => {
    const filenameStem = item.filename
      .replace(/\.[^/.]+$/, "")
      .replace(/^(\d+[\s._-]+|chapter[\s._-]+\d+[\s._-]*)/i, "")
      .replace(/\b(unabridged|abridged|audiobook|audiobooks|narrated by [^)]+|cd\s*\d+|disc\s*\d+|part\s*\d+|pt\s*\d+|\d+kbps)\b/gi, "")
      .replace(/\{tmdb-\d+\}/gi, "")
      .replace(/\{imdb-tt\d+\}/gi, "")
      .replace(/[_.]+/g, " ")
      .trim();

    const cleanName = filenameStem || item.filename;
    setManualTitle(cleanName);
    setManualYear("");
    setManualOverview("");
    setManualPosterUrl("");
    setManualBackdropUrl("");
    setManualGenres("");
    setManualSeason("");
    setManualEpisode("");
    setManualShowTitle("");
    setManualArtist("");
    setManualAlbum("");
    setManualAuthor("");
    setActiveTab("manual");
  };

  const handleSearch = async (overrideQuery?: string) => {
    const q = (overrideQuery !== undefined ? overrideQuery : query).trim();
    if (!q) return;
    setLoading(true);
    setResults([]);

    try {
      const found: SearchResult[] = [];

      // 1. Direct IMDB lookup if query or path contains tt\d+
      const imdbMatch = q.match(/\b(tt\d+)\b/i) || item.remotePath.match(/\{imdb-(tt\d+)\}/i);
      if (imdbMatch && (effectiveLibraryType === "movies" || effectiveLibraryType === "tv")) {
        const imdbId = imdbMatch[1];
        const type = effectiveLibraryType === "tv" ? "series" : "movie";
        try {
          const detailRes = await safeFetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
          if (detailRes && detailRes.ok) {
            const data = await detailRes.json();
            if (data?.meta) {
              const m = data.meta;
              const rawYear = (m.year as string) || (m.releaseInfo as string);
              const y = rawYear ? parseInt(String(rawYear).split("-")[0]) : undefined;
              found.push({
                id: m.id || imdbId,
                title: m.name ?? q,
                year: isNaN(y as number) ? undefined : y,
                posterUrl: m.poster as string | undefined,
                overview: m.description as string | undefined,
                source: "cinemeta",
              });
            }
          }
        } catch {}
      }

      // 2. Cinemeta search for movies and tv
      if (effectiveLibraryType === "movies" || effectiveLibraryType === "tv") {
        const type = effectiveLibraryType === "tv" ? "series" : "movie";
        try {
          const res = await safeFetch(
            `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(q)}.json`
          );
          if (res && res.ok) {
            const data = await res.json();
            (data.metas ?? []).slice(0, 15).forEach((m: Record<string, unknown>) => {
              const rawYear = (m.year as string) || (m.releaseInfo as string);
              const y = rawYear ? parseInt(String(rawYear).split("-")[0]) : undefined;
              if (!found.some((f) => f.id === m.id)) {
                found.push({
                  id: (m.id as string) || "",
                  title: (m.name as string) ?? q,
                  year: isNaN(y as number) ? undefined : y,
                  posterUrl: m.poster as string | undefined,
                  overview: m.description as string | undefined,
                  source: "cinemeta",
                });
              }
            });
          }
        } catch (e) {
          console.warn("[FixMatchModal] Cinemeta search error:", e);
        }

        // Fallback: If 0 results and query contains a 4-digit year, retry without the year
        if (found.length === 0 && /\b(19\d\d|20\d\d)\b/.test(q)) {
          const noYearQuery = q.replace(/\b(19\d\d|20\d\d)\b/g, "").replace(/\s{2,}/g, " ").trim();
          if (noYearQuery && noYearQuery !== q) {
            try {
              const res = await safeFetch(
                `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(noYearQuery)}.json`
              );
              if (res && res.ok) {
                const data = await res.json();
                (data.metas ?? []).slice(0, 15).forEach((m: Record<string, unknown>) => {
                  const rawYear = (m.year as string) || (m.releaseInfo as string);
                  const y = rawYear ? parseInt(String(rawYear).split("-")[0]) : undefined;
                  if (!found.some((f) => f.id === m.id)) {
                    found.push({
                      id: (m.id as string) || "",
                      title: (m.name as string) ?? noYearQuery,
                      year: isNaN(y as number) ? undefined : y,
                      posterUrl: m.poster as string | undefined,
                      overview: m.description as string | undefined,
                      source: "cinemeta",
                    });
                  }
                });
              }
            } catch (e) {
              console.warn("[FixMatchModal] Cinemeta retry error:", e);
            }
          }
        }

        if (found.length === 0 && tmdbApiKey) {
          const tmdbType = effectiveLibraryType === "tv" ? "tv" : "movie";
          try {
            const res = await safeFetch(
              `https://api.themoviedb.org/3/search/${tmdbType}?query=${encodeURIComponent(q)}&language=en-US&page=1`,
              { headers: { Authorization: `Bearer ${tmdbApiKey}` } }
            );
            if (res && res.ok) {
              const data = await res.json();
              (data.results ?? []).slice(0, 8).forEach((r: Record<string, unknown>) => {
                found.push({
                  id: String(r.id),
                  title: (r.title as string) ?? (r.name as string) ?? q,
                  year: r.release_date
                    ? parseInt((r.release_date as string).split("-")[0])
                    : r.first_air_date
                    ? parseInt((r.first_air_date as string).split("-")[0])
                    : undefined,
                  posterUrl: r.poster_path
                    ? `https://image.tmdb.org/t/p/w92${r.poster_path}`
                    : undefined,
                  overview: r.overview as string,
                  source: "tmdb",
                });
              });
            }
          } catch {}
        }
      } else if (effectiveLibraryType === "adult") {
        // Stash-Box providers first (all enabled ones), results merged below
        const frag = parseAdultSceneFragment(q);
        const sbProviders = (stashBoxProviders ?? []).filter((p) => p.enabled && p.endpoint?.trim());
        const sbGroups = await Promise.all(
          sbProviders.map((p) => searchScenesByFragment(p, frag, undefined).catch(() => []))
        );
        const seenSb = new Set<string>();
        for (const group of sbGroups) {
          for (const s of group) {
            if (s.source !== "stashbox") continue;
            const key = `stashbox:${s.id}`;
            if (seenSb.has(key)) continue;
            seenSb.add(key);
            found.push({
              id: s.id,
              title: s.title,
              artist: [s.studio, ...s.performers].filter(Boolean).join(" • ") || undefined,
              year: s.date ? parseInt(s.date.substring(0, 4), 10) || undefined : undefined,
              genres: s.tags.length ? s.tags : undefined,
              posterUrl: s.posterUrl,
              overview: [
                s.date ? `Released: ${s.date}` : "",
                s.studio ? `Studio: ${s.studio}` : "",
                s.performers.length ? `Performers: ${s.performers.join(", ")}` : "",
                s.details || "",
              ].filter(Boolean).join(" • "),
              source: "stashbox",
            });
          }
        }
        if (thePornDbApiKey) {
          try {
            const res = await safeFetch(
              `https://api.theporndb.net/scenes?q=${encodeURIComponent(q)}`,
              { headers: { Authorization: `Bearer ${thePornDbApiKey}` } }
            );
            if (res && res.ok) {
              const data = await res.json();
              (data.data ?? []).slice(0, 8).forEach((scene: any) => {
                const poster =
                  scene.poster ??
                  scene.posters?.large ??
                  scene.posters?.medium ??
                  scene.posters?.small ??
                  scene.posters?.full ??
                  (Array.isArray(scene.posters)
                    ? (typeof scene.posters[0] === "string" ? scene.posters[0] : scene.posters[0]?.url)
                    : undefined);
                const y = scene.date ? parseInt(scene.date.substring(0, 4), 10) : undefined;
                found.push({
                  id: String(scene.id),
                  title: scene.title ?? q,
                  year: isNaN(y as number) ? undefined : y,
                  duration: typeof scene.duration === "number" ? scene.duration : undefined,
                  genres: Array.isArray(scene.tags) ? scene.tags.map((t: any) => t.name).filter(Boolean) : undefined,
                  posterUrl: poster,
                  overview: scene.description,
                  source: "theporndb",
                });
              });
            }
          } catch {}
        }
      } else if (item.libraryType === "books" || item.libraryType === "audiobooks") {
        const promises = [
          // 1. iTunes API: primary search (audiobook or ebook depending on libraryType)
          (async () => {
            try {
              const isAudio = item.libraryType === "audiobooks";
              const media = isAudio ? "audiobook" : "ebook";
              const entity = isAudio ? "audiobook" : "ebook";
              const res = await safeFetch(
                `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=${media}&entity=${entity}&limit=8`
              );
              if (res && res.ok) {
                const data = await res.json();
                return (data.results ?? []).map((r: any) => {
                  const rawPoster = r.artworkUrl100 as string | undefined;
                  const poster = rawPoster ? rawPoster.replace(/\/\d+x\d+bb\./, "/600x600bb.") : undefined;
                  const y = r.releaseDate ? parseInt(r.releaseDate.split("-")[0], 10) : undefined;
                  const resolvedTitle = isAudio
                    ? (r.collectionName || r.trackName || q)
                    : (r.trackName || r.collectionName || q);
                  return {
                    id: String(r.collectionId || r.trackId || Math.random()),
                    title: resolvedTitle,
                    artist: r.artistName,
                    album: r.collectionName || resolvedTitle,
                    year: isNaN(y as number) ? undefined : y,
                    duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined,
                    genres: r.genres || (r.primaryGenreName ? [r.primaryGenreName] : undefined),
                    posterUrl: poster,
                    overview: r.description ? r.description.replace(/<[^>]*>/g, "").trim() : `${r.artistName ?? ""}${r.primaryGenreName ? ` (${r.primaryGenreName})` : ""}`,
                    source: "itunes" as const,
                  };
                });
              }
            } catch {}
            return [];
          })(),

          // 2. iTunes API: cross-pollinate alternate format (ebook for audiobooks, audiobook for ebooks)
          (async () => {
            try {
              const isAudio = item.libraryType === "audiobooks";
              const altMedia = isAudio ? "ebook" : "audiobook";
              const altEntity = isAudio ? "ebook" : "audiobook";
              const res = await safeFetch(
                `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=${altMedia}&entity=${altEntity}&limit=5`
              );
              if (res && res.ok) {
                const data = await res.json();
                return (data.results ?? []).map((r: any) => {
                  const rawPoster = r.artworkUrl100 as string | undefined;
                  const poster = rawPoster ? rawPoster.replace(/\/\d+x\d+bb\./, "/600x600bb.") : undefined;
                  const y = r.releaseDate ? parseInt(r.releaseDate.split("-")[0], 10) : undefined;
                  const resolvedTitle = !isAudio
                    ? (r.collectionName || r.trackName || q)
                    : (r.trackName || r.collectionName || q);
                  return {
                    id: String(r.collectionId || r.trackId || Math.random()),
                    title: resolvedTitle,
                    artist: r.artistName,
                    album: r.collectionName || resolvedTitle,
                    year: isNaN(y as number) ? undefined : y,
                    duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined,
                    genres: r.genres || (r.primaryGenreName ? [r.primaryGenreName] : undefined),
                    posterUrl: poster,
                    overview: r.description ? r.description.replace(/<[^>]*>/g, "").trim() : `${r.artistName ?? ""}${r.primaryGenreName ? ` (${r.primaryGenreName})` : ""}`,
                    source: "itunes" as const,
                  };
                });
              }
            } catch {}
            return [];
          })(),

          // 3. OpenLibrary API (fast fields-optimized, high-res covers)
          (async () => {
            try {
              const res = await safeFetch(
                `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&fields=key,title,author_name,first_publish_year,subject,cover_i,first_sentence&limit=8`
              );
              if (res && res.ok) {
                const data = await res.json();
                return (data.docs ?? []).map((r: Record<string, unknown>) => {
                  const coverId = r.cover_i as number | undefined;
                  const authorStr = (r.author_name as string[])?.join(", ");
                  const subjects = Array.isArray(r.subject)
                    ? (r.subject as string[])
                        .filter((s) => typeof s === "string" && s.length > 2 && !["fiction", "non-fiction", "general", "miscellaneous"].includes(s.toLowerCase()))
                        .slice(0, 5)
                    : undefined;
                  const overviewStr = r.first_sentence
                    ? (Array.isArray(r.first_sentence) ? (r.first_sentence as string[])[0] : (r.first_sentence as string))
                    : (authorStr ? `By ${authorStr}` : undefined);
                  return {
                    id: r.key as string,
                    title: (r.title as string) || q,
                    artist: authorStr,
                    album: (r.title as string) || q,
                    year: r.first_publish_year as number | undefined,
                    genres: subjects,
                    posterUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : undefined,
                    overview: overviewStr,
                    source: "openlibrary" as const,
                  };
                });
              }
            } catch {}
            return [];
          })(),

          // 4. Google Books API (High-res zoom=2 covers, full descriptions)
          (async () => {
            try {
              const res = await safeFetch(
                `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8`
              );
              if (res && res.ok) {
                const data = await res.json();
                return (data.items ?? []).map((b: any) => {
                  const vi = b.volumeInfo || {};
                  const imgLinks = vi.imageLinks;
                  let posterUrl: string | undefined;
                  if (imgLinks) {
                    const rawImg = imgLinks.extraLarge || imgLinks.large || imgLinks.medium || imgLinks.small || imgLinks.thumbnail;
                    if (rawImg) {
                      posterUrl = String(rawImg).replace(/zoom=1/g, "zoom=2").replace(/^http:/, "https:");
                    }
                  }
                  const y = vi.publishedDate ? parseInt(vi.publishedDate.split("-")[0], 10) : undefined;
                  const authorStr = vi.authors?.join(", ");
                  return {
                    id: b.id,
                    title: vi.title || q,
                    artist: authorStr,
                    album: vi.title || q,
                    year: isNaN(y as number) ? undefined : y,
                    posterUrl,
                    overview: vi.description || authorStr,
                    genres: vi.categories,
                    source: "googlebooks" as const,
                  };
                });
              }
            } catch {}
            return [];
          })(),

          // 5. Audnexus (only if query looks like an ASIN)
          (async () => {
            if (!/^[B0-9][A-Z0-9]{9}$/i.test(q)) return [];
            try {
              const res = await safeFetch(`https://api.audnex.us/books/${encodeURIComponent(q)}`);
              if (res && res.ok) {
                const b = await res.json();
                if (b && (b.title || b.asin)) {
                  const authors = Array.isArray(b.authors) ? b.authors.map((a: any) => a.name || a).join(", ") : b.author;
                  const narrators = Array.isArray(b.narrators) ? b.narrators.map((n: any) => n.name || n).join(", ") : b.narrator;
                  const year = b.releaseDate ? parseInt(b.releaseDate.split("-")[0], 10) : undefined;
                  return [{
                    id: b.asin || String(b.id || Math.random()),
                    title: b.title || q,
                    artist: authors,
                    album: b.title || q,
                    year: isNaN(year as number) ? undefined : year,
                    posterUrl: b.image || b.cover || b.thumbnail,
                    overview: (narrators ? `Narrated by ${narrators} • ` : "") + (b.summary || b.description || ""),
                    genres: b.genres,
                    source: "audnexus" as const,
                  }];
                }
              }
            } catch {}
            return [];
          })(),
        ];

        const settled = await Promise.allSettled(promises);
        const seen = new Set<string>();

        for (const itemResult of settled) {
          if (itemResult.status === "fulfilled") {
            for (const resItem of itemResult.value) {
              const key = `${(resItem.title || "").toLowerCase()}:::${(resItem.artist || "").toLowerCase()}`;
              if (!seen.has(key)) {
                seen.add(key);
                found.push(resItem);
              }
            }
          }
        }
      } else if (item.libraryType === "music") {
        // Album-level Fix Match must search ALBUMS (iTunes entity=album / Deezer
        // /search/album), not songs — otherwise the picker only ever shows tracks.
        const albumMode = mode === "album";
        try {
          const itunesRes = await safeFetch(
            `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music${albumMode ? "&entity=album" : ""}&limit=10`
          );
          if (itunesRes && itunesRes.ok) {
            const data = await itunesRes.json();
            (data.results ?? []).forEach((r: any) => {
              const rawPoster = r.artworkUrl100 as string | undefined;
              const poster = rawPoster ? rawPoster.replace(/\/\d+x\d+bb\./, "/600x600bb.") : undefined;
              const y = r.releaseDate ? parseInt(r.releaseDate.split("-")[0]) : undefined;
              const isCollection = r.wrapperType === "collection";
              found.push({
                id: String(r.trackId || r.collectionId),
                title: isCollection ? r.collectionName : (r.trackName ?? r.collectionName ?? q),
                artist: r.artistName,
                album: r.collectionName,
                year: isNaN(y as number) ? undefined : y,
                duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined,
                genres: r.primaryGenreName ? [r.primaryGenreName] : undefined,
                posterUrl: poster,
                overview: `${r.artistName ?? ""}${isCollection && r.trackCount ? ` • ${r.trackCount} tracks` : r.collectionName ? ` • ${r.collectionName}` : ""}${r.primaryGenreName ? ` (${r.primaryGenreName})` : ""}`,
                source: "itunes",
              });
            });
          }
        } catch {}

        if (found.length === 0) {
          try {
            const deezerRes = await safeFetch(
              albumMode
                ? `https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=10`
                : `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`
            );
            if (deezerRes && deezerRes.ok) {
              const data = await deezerRes.json();
              (data.data ?? []).forEach((r: any) => {
                if (albumMode) {
                  // /search/album rows ARE albums: title is the album title and the
                  // cover fields live on the row itself, not under r.album.
                  found.push({
                    id: String(r.id),
                    title: r.title ?? q,
                    artist: r.artist?.name,
                    album: r.title ?? q,
                    posterUrl: r.cover_xl || r.cover_big || r.cover_medium,
                    overview: `${r.artist?.name ?? ""}${r.nb_tracks ? ` • ${r.nb_tracks} tracks` : ""}`,
                    source: "deezer",
                  });
                } else {
                  found.push({
                    id: String(r.id),
                    title: r.title ?? q,
                    artist: r.artist?.name,
                    album: r.album?.title,
                    duration: r.duration,
                    posterUrl: r.album?.cover_xl || r.album?.cover_big || r.album?.cover_medium,
                    overview: `${r.artist?.name ?? ""}${r.album?.title ? ` • ${r.album.title}` : ""}`,
                    source: "deezer",
                  });
                }
              });
            }
          } catch {}
        }
      }

      setResults(found);
    } finally {
      setLoading(false);
    }
  };

  // Auto-search on open using clean query
  useEffect(() => {
    if (initialQuery) {
      handleSearch(initialQuery);
    }
  }, []);

  const handleSelect = async (result: SearchResult) => {
    setSelected(result.id);
    const isMultiChapter = Boolean(
      (item.libraryType === "audiobooks" || item.libraryType === "books") &&
      item.album &&
      item.album !== item.title
    );
    const resolvedAlbum = result.album ?? result.title ?? item.album;
    // Album-mode music matches carry the ALBUM's name as result.title — the seed
    // track keeps its own song title (the propagation below sets album metadata).
    const keepOwnTitle = isMultiChapter || (mode === "album" && item.libraryType === "music");
    const updatedItem: MediaItem = {
      ...item,
      title: keepOwnTitle ? item.title : result.title,
      showTitle: item.libraryType === "tv" ? result.title : item.showTitle,
      showPosterUrl: item.libraryType === "tv" ? (result.posterUrl ?? item.showPosterUrl) : item.showPosterUrl,
      showOverview: item.libraryType === "tv" ? (result.overview ?? item.showOverview) : item.showOverview,
      artist: result.artist ?? item.artist,
      author: result.artist ?? item.author,
      album: resolvedAlbum,
      duration: result.duration ?? item.duration,
      genres: result.genres ?? item.genres,
      year: result.year ?? item.year,
      posterUrl: result.posterUrl ?? item.posterUrl,
      overview: result.overview ?? item.overview,
      metadataId: result.id,
      metadataSource: result.source,
      metadataConfidence: "manual",
    };
    updateItemMetadata(item.id, updatedItem);
    persistItems([updatedItem]).catch((err) => console.error("Failed persisting match fix:", err));

    // If this item belongs to a TV series, propagate show title & poster to sibling episodes
    if (item.libraryType === "tv") {
      const targetShowTitle = result.title;
      const originalShowTitle = item.showTitle || item.title;
      const allItems = useAppStore.getState().mediaItems;
      const updates: MediaItem[] = [];
      for (const other of Object.values(allItems)) {
        if (
          other.libraryId === item.libraryId &&
          other.libraryType === "tv" &&
          other.id !== item.id &&
          ((originalShowTitle && other.showTitle === originalShowTitle) ||
            (item.showId && other.showId === item.showId) ||
            (item.showTitle && other.showTitle === item.showTitle))
        ) {
          updates.push({
            ...other,
            showTitle: targetShowTitle,
            showPosterUrl: result.posterUrl || other.showPosterUrl || other.posterUrl,
            posterUrl: result.posterUrl || other.posterUrl,
            showBackdropUrl: other.showBackdropUrl || other.backdropUrl,
            showOverview: result.overview || other.showOverview || other.overview,
            year: result.year || other.year,
            genres: result.genres || other.genres,
            metadataSource: result.source,
          });
        }
      }
      if (updates.length > 0) {
        useAppStore.getState().bulkUpsertMediaItems(updates);
        persistItems(updates).catch((err) => console.error("Failed persisting tv siblings:", err));
      }
    }

    // If this item belongs to an album or mode === "album", propagate artwork, artist, album name, and year to all tracks
    if ((item.libraryType === "music" || mode === "album") && (item.album || result.album || result.title)) {
      const allItems = useAppStore.getState().mediaItems;
      const targetAlbum = result.album || result.title || item.album;
      const tracksToUpdate = albumTracks || Object.values(allItems).filter(
        (other) => other.libraryId === item.libraryId && other.album === item.album
      );
      const updates: MediaItem[] = tracksToUpdate.map((other) => ({
        ...other,
        album: targetAlbum || other.album,
        artist: result.artist || other.artist,
        posterUrl: result.posterUrl || other.posterUrl,
        year: result.year ?? other.year,
        genres: result.genres ?? other.genres,
        metadataSource: result.source,
      }));
      if (updates.length > 0) {
        useAppStore.getState().bulkUpsertMediaItems(updates);
        persistItems(updates).catch((err) => console.error("Failed persisting album tracks:", err));
      }
    }

    // If this item belongs to an audiobook or book, propagate artwork, author & album to sibling chapters
    if ((item.libraryType === "audiobooks" || item.libraryType === "books") && (item.album || item.title)) {
      const bookAlbum = item.album || item.title;
      const allItems = useAppStore.getState().mediaItems;
      const updates: MediaItem[] = [];
      const newAlbum = result.title || resolvedAlbum || bookAlbum;
      for (const other of Object.values(allItems)) {
        if (
          other.libraryId === item.libraryId &&
          other.id !== item.id &&
          ((item.album && other.album === item.album) || other.album === bookAlbum || other.title === bookAlbum)
        ) {
          updates.push({
            ...other,
            posterUrl: result.posterUrl || other.posterUrl,
            author: result.artist || other.author,
            artist: result.artist || other.artist,
            album: newAlbum,
            year: result.year || other.year,
            genres: result.genres || other.genres,
            overview: result.overview || other.overview,
            metadataSource: result.source,
          });
        }
      }
      if (updates.length > 0) {
        useAppStore.getState().bulkUpsertMediaItems(updates);
        persistItems(updates).catch((err) => console.error("Failed persisting audiobook siblings:", err));
      }
    }

    setTimeout(onClose, 600);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        className="bg-surface border border-border rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-card-hover overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div>
            <h2 className="font-body font-semibold text-bright text-base">Fix Metadata Match</h2>
            <p className="text-subtle text-xs font-body mt-0.5 truncate max-w-xs">{item.filename}</p>
          </div>
          <button onClick={onClose} className="text-subtle hover:text-text transition-colors p-1">
            <X size={18} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-border bg-panel/50 px-5 pt-2 flex-shrink-0">
          <button
            onClick={() => setActiveTab("search")}
            className={`flex items-center gap-2 pb-2.5 px-3 text-xs font-semibold border-b-2 transition-all ${
              activeTab === "search"
                ? "border-accent text-accent"
                : "border-transparent text-subtle hover:text-text"
            }`}
          >
            <Search size={13} />
            Search Online
          </button>
          <button
            onClick={() => setActiveTab("manual")}
            className={`flex items-center gap-2 pb-2.5 px-3 text-xs font-semibold border-b-2 transition-all ${
              activeTab === "manual"
                ? "border-accent text-accent"
                : "border-transparent text-subtle hover:text-text"
            }`}
          >
            <Edit3 size={13} />
            Manual Edit
          </button>
        </div>

        {activeTab === "search" ? (
          <>
            {/* Search Input */}
            <div className="px-5 py-4 border-b border-border flex-shrink-0">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder="Search for correct title, IMDB ID (tt...), or keywords..."
                  className="input-field flex-1"
                  autoFocus
                />
                <button
                  onClick={() => handleSearch()}
                  disabled={loading}
                  className="btn-primary px-4 py-3 flex items-center gap-2"
                >
                  {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                </button>
              </div>
            </div>

            {/* Results List */}
            <div className="overflow-y-auto flex-1 divide-y divide-border/40">
              {results.length === 0 && !loading && (
                <div className="flex flex-col items-center justify-center py-12 px-6 text-center text-subtle font-body text-xs space-y-3">
                  <p>
                    {query !== item.title || results.length === 0
                      ? "Search to find the correct match from Cinemeta / TMDB / MusicBrainz"
                      : "No matching results found for this query."}
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => setActiveTab("manual")}
                      className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                    >
                      <Edit3 size={13} />
                      <span>Edit Metadata Manually</span>
                    </button>
                    <button
                      onClick={handleResetToFilename}
                      className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                    >
                      <RotateCcw size={13} />
                      <span>Reset to Filename</span>
                    </button>
                  </div>
                </div>
              )}

              {results.map((result) => (
                <div
                  key={result.id}
                  className="w-full flex items-start gap-3 p-4 hover:bg-panel transition-colors text-left"
                >
                  {/* Poster thumbnail */}
                  <div className="w-12 h-16 rounded-lg overflow-hidden bg-muted flex-shrink-0 border border-border/60">
                    {result.posterUrl ? (
                      <img src={result.posterUrl} alt={result.title} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-muted flex items-center justify-center text-subtle text-[10px]">
                        No Art
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-text font-body font-medium text-sm truncate">{result.title}</p>
                      <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-panel border border-border text-subtle">
                        {result.source}
                      </span>
                      {selected === result.id && (
                        <Check size={14} className="text-teal flex-shrink-0" />
                      )}
                    </div>
                    {result.year && (
                      <p className="text-subtle font-body text-xs mt-0.5">{result.year}</p>
                    )}
                    {result.overview && (
                      <p className="text-subtle font-body text-xs mt-1 line-clamp-2">{result.overview}</p>
                    )}

                    <div className="flex items-center gap-2 mt-2.5">
                      <button
                        onClick={() => handleSelect(result)}
                        className="btn-primary text-xs py-1 px-3 flex items-center gap-1"
                      >
                        <Check size={12} />
                        <span>Apply Match</span>
                      </button>
                      <button
                        onClick={() => handleApplyToManual(result)}
                        className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
                        title="Tweak fields before saving"
                      >
                        <Edit3 size={12} />
                        <span>Customize</span>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          /* Manual Edit Form */
          <div className="overflow-y-auto flex-1 p-5 space-y-4 text-xs font-body">
            <div>
              <label className="text-subtle block mb-1 font-medium">Title</label>
              <input
                type="text"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="Media title..."
                className="input-field w-full text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-subtle block mb-1 font-medium">Release Year</label>
                <input
                  type="number"
                  value={manualYear}
                  onChange={(e) => setManualYear(e.target.value)}
                  placeholder="e.g. 2024"
                  className="input-field w-full text-xs"
                />
              </div>

              <div>
                <label className="text-subtle block mb-1 font-medium">Genres (comma separated)</label>
                <input
                  type="text"
                  value={manualGenres}
                  onChange={(e) => setManualGenres(e.target.value)}
                  placeholder="Action, Sci-Fi, Drama"
                  className="input-field w-full text-xs"
                />
              </div>
            </div>

            {/* TV Specific Fields */}
            {item.libraryType === "tv" && (
              <div className="grid grid-cols-3 gap-2 p-3 rounded-xl bg-panel/50 border border-border">
                <div className="col-span-3">
                  <label className="text-subtle block mb-1 font-medium">Show Title</label>
                  <input
                    type="text"
                    value={manualShowTitle}
                    onChange={(e) => setManualShowTitle(e.target.value)}
                    placeholder="Series name..."
                    className="input-field w-full text-xs"
                  />
                </div>
                <div>
                  <label className="text-subtle block mb-1 font-medium">Season #</label>
                  <input
                    type="number"
                    value={manualSeason}
                    onChange={(e) => setManualSeason(e.target.value)}
                    placeholder="1"
                    className="input-field w-full text-xs"
                  />
                </div>
                <div>
                  <label className="text-subtle block mb-1 font-medium">Episode #</label>
                  <input
                    type="number"
                    value={manualEpisode}
                    onChange={(e) => setManualEpisode(e.target.value)}
                    placeholder="1"
                    className="input-field w-full text-xs"
                  />
                </div>
              </div>
            )}

            {/* Music Specific Fields */}
            {item.libraryType === "music" && (
              <div className="grid grid-cols-2 gap-3 p-3 rounded-xl bg-panel/50 border border-border">
                <div>
                  <label className="text-subtle block mb-1 font-medium">Artist</label>
                  <input
                    type="text"
                    value={manualArtist}
                    onChange={(e) => setManualArtist(e.target.value)}
                    placeholder="Artist name..."
                    className="input-field w-full text-xs"
                  />
                </div>
                <div>
                  <label className="text-subtle block mb-1 font-medium">Album</label>
                  <input
                    type="text"
                    value={manualAlbum}
                    onChange={(e) => setManualAlbum(e.target.value)}
                    placeholder="Album name..."
                    className="input-field w-full text-xs"
                  />
                </div>
              </div>
            )}

            {/* Book & Audiobook Specific Fields */}
            {(item.libraryType === "books" || item.libraryType === "audiobooks") && (
              <div className="p-3 rounded-xl bg-panel/50 border border-border space-y-2.5">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-subtle block mb-1 font-medium">Author / Narrator</label>
                    <input
                      type="text"
                      value={manualAuthor}
                      onChange={(e) => {
                        setManualAuthor(e.target.value);
                        setManualArtist(e.target.value);
                      }}
                      placeholder="e.g. Brandon Sanderson"
                      className="input-field w-full text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-subtle block mb-1 font-medium">Book / Series Title (Album)</label>
                    <input
                      type="text"
                      value={manualAlbum}
                      onChange={(e) => setManualAlbum(e.target.value)}
                      placeholder="e.g. The Way of Kings"
                      className="input-field w-full text-xs"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-accent/80 font-body">
                  Saving updates cover art, author, and book grouping across all sibling chapters in this audiobook.
                </p>
              </div>
            )}

            {/* Poster URL with Preview */}
            <div>
              <label className="text-subtle block mb-1 font-medium">Poster / Cover Image URL</label>
              <div className="flex gap-2.5 items-start">
                <input
                  type="text"
                  value={manualPosterUrl}
                  onChange={(e) => setManualPosterUrl(e.target.value)}
                  placeholder="https://image.tmdb.org/t/p/w500/..."
                  className="input-field flex-1 text-xs"
                />
                {manualPosterUrl && (
                  <div className="w-12 h-16 rounded-lg bg-panel border border-border overflow-hidden shrink-0">
                    <img
                      src={manualPosterUrl}
                      alt="Preview"
                      className="w-full h-full object-cover"
                      onError={(e) => (e.currentTarget.style.display = "none")}
                    />
                  </div>
                )}
              </div>
            </div>

            <div>
              <label className="text-subtle block mb-1 font-medium">Backdrop / Fanart Image URL (Optional)</label>
              <input
                type="text"
                value={manualBackdropUrl}
                onChange={(e) => setManualBackdropUrl(e.target.value)}
                placeholder="https://image.tmdb.org/t/p/original/..."
                className="input-field w-full text-xs"
              />
            </div>

            <div>
              <label className="text-subtle block mb-1 font-medium">Overview / Description</label>
              <textarea
                rows={3}
                value={manualOverview}
                onChange={(e) => setManualOverview(e.target.value)}
                placeholder="Plot synopsis, description, or notes..."
                className="input-field w-full text-xs resize-none"
              />
            </div>

            {/* Manual Form Actions */}
            <div className="pt-2 border-t border-border flex items-center justify-between">
              <button
                type="button"
                onClick={handleResetToFilename}
                className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 text-subtle hover:text-white"
                title="Remove any online match and restore clean filename"
              >
                <RotateCcw size={13} />
                <span>Reset to Filename</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="btn-secondary text-xs py-2 px-3"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveManual}
                  className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
                >
                  <Save size={13} />
                  <span>Save Changes</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
