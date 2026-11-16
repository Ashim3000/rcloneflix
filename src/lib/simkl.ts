import { useAppStore, type MediaItem } from "../store/appStore";

const SIMKL_API_BASE = "https://api.simkl.com";
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

function getSimklHeaders(clientId: string, accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "simkl-api-key": clientId.trim(),
  };
  if (accessToken && accessToken.trim()) {
    headers["Authorization"] = `Bearer ${accessToken.trim()}`;
  }
  return headers;
}

export type SimklScrobbleAction = "start" | "pause" | "stop";

/**
 * Scrobble playback activity to Simkl (100% free scrobbler, no VIP required).
 * Only sends data if:
 * 1. Integration is enabled
 * 2. Scrobbling toggle is enabled
 * 3. Client ID and Access Token are provided
 */
export async function simklScrobble(
  action: SimklScrobbleAction,
  item: MediaItem,
  progressPercent: number
): Promise<boolean> {
  const store = useAppStore.getState();
  const settings = store.simklSettings || store.traktSettings;
  if (
    !settings?.enabled ||
    !settings?.scrobbleEnabled ||
    !settings?.accessToken
  ) {
    return false;
  }

  const clientId = settings.clientId?.trim() || DEFAULT_SIMKL_CLIENT_ID;
  const progress = Math.min(100, Math.max(0, Math.round(progressPercent)));
  const headers = getSimklHeaders(clientId, settings.accessToken);

  let body: Record<string, any>;
  if (item.libraryType === "tv" || item.season != null) {
    body = {
      show: {
        title: item.showTitle || item.title,
        ...(item.year ? { year: item.year } : {}),
      },
      episode: {
        season: item.season ?? 1,
        number: item.episode ?? 1,
        title: item.episodeTitle,
      },
      progress,
    };
  } else {
    body = {
      movie: {
        title: item.title,
        ...(item.year ? { year: item.year } : {}),
        ...(item.metadataId && !isNaN(Number(item.metadataId))
          ? { ids: { tmdb: Number(item.metadataId) } }
          : {}),
      },
      progress,
    };
  }

  try {
    const res = await fetch(`${SIMKL_API_BASE}/scrobble/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (err) {
    console.warn(`Simkl scrobble ${action} failed:`, err);
    return false;
  }
}

export const DEFAULT_SIMKL_CLIENT_ID = "";

export type SimklPinResponse = {
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
};

export type SimklPinPollResponse = {
  result: "OK" | "KO";
  access_token?: string;
  message?: string;
};

export async function getSimklPin(clientId?: string): Promise<SimklPinResponse> {
  const store = useAppStore.getState();
  const cid =
    (clientId && clientId.trim()) ||
    store.simklSettings?.clientId?.trim() ||
    store.traktSettings?.clientId?.trim() ||
    DEFAULT_SIMKL_CLIENT_ID;

  if (!cid) {
    throw new Error(
      "Simkl Client ID is required. Please get a free Client ID at https://simkl.com/settings/developer/app/new/ and enter it in Settings."
    );
  }

  const res = await fetch(`${SIMKL_API_BASE}/oauth/pin?client_id=${encodeURIComponent(cid)}`);
  if (!res.ok) {
    let msg = `Failed to request Simkl PIN (HTTP ${res.status})`;
    try {
      const errJson = await res.json();
      if (errJson?.code === 412 || errJson?.error === "client_id_failed") {
        msg =
          "Simkl rejected this Client ID (Error 412: Your client_id is wrong). Please verify your Client ID from https://simkl.com/settings/developer/ or paste a direct Access Token.";
      } else if (errJson?.message) {
        msg = errJson.message;
      }
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export async function pollSimklPin(userCode: string, clientId?: string): Promise<SimklPinPollResponse> {
  const store = useAppStore.getState();
  const cid =
    (clientId && clientId.trim()) ||
    store.simklSettings?.clientId?.trim() ||
    store.traktSettings?.clientId?.trim() ||
    DEFAULT_SIMKL_CLIENT_ID;
  if (!cid) {
    return { result: "KO", message: "Client ID is missing" };
  }
  const res = await fetch(`${SIMKL_API_BASE}/oauth/pin/${encodeURIComponent(userCode)}?client_id=${encodeURIComponent(cid)}`);
  const data = await res.json();
  return data;
}

/**
 * Refresh free Simkl discovery lists (Trending Movies, Trending Shows).
 * Queries Simkl's live public CDN first, and falls back to API.
 * Strictly throttled to 1 refresh per 48 hours unless force=true.
 */
export async function refreshSimklDiscovery(force = false): Promise<boolean> {
  const store = useAppStore.getState();
  const settings = store.simklSettings || store.traktSettings;
  const { setSimklDiscoveryData, setSimklSettings } = store;

  const clientId = settings?.clientId?.trim() || DEFAULT_SIMKL_CLIENT_ID;

  // If user explicitly switched discovery shelves OFF, and it's not a forced manual refresh, skip
  if (!force && settings?.discoveryShelvesEnabled === false) {
    return false;
  }

  const hasShelves =
    (settings?.trendingMovies && settings.trendingMovies.length > 0) ||
    (settings?.trendingShows && settings.trendingShows.length > 0);

  const now = Date.now();
  if (
    !force &&
    hasShelves &&
    settings?.lastDiscoveryFetchAt &&
    now - settings.lastDiscoveryFetchAt < FORTY_EIGHT_HOURS_MS
  ) {
    return true;
  }

  const headers = getSimklHeaders(clientId, settings?.accessToken);

  try {
    let moviesJson: any[] = [];
    let showsJson: any[] = [];

    // 1. Primary: Simkl Live Public CDN (free, high performance, no rate limits)
    try {
      const [cdnMoviesRes, cdnShowsRes] = await Promise.all([
        fetch("https://data.simkl.in/discover/trending/movies/today_100.json"),
        fetch("https://data.simkl.in/discover/trending/tv/today_100.json"),
      ]);
      if (cdnMoviesRes.ok) {
        moviesJson = await cdnMoviesRes.json();
      }
      if (cdnShowsRes.ok) {
        showsJson = await cdnShowsRes.json();
      }
    } catch (e) {
      console.warn("Simkl CDN discovery failed, trying direct API:", e);
    }

    // 2. Fallback: API endpoints
    if (!Array.isArray(moviesJson) || moviesJson.length === 0) {
      try {
        const moviesRes = await fetch(`${SIMKL_API_BASE}/movies/trending?client_id=${encodeURIComponent(clientId)}`, { headers });
        if (moviesRes.ok) moviesJson = await moviesRes.json();
      } catch (err) {
        console.warn("Simkl API movies fallback error:", err);
      }
    }

    if (!Array.isArray(showsJson) || showsJson.length === 0) {
      try {
        const showsRes = await fetch(`${SIMKL_API_BASE}/tv/trending?client_id=${encodeURIComponent(clientId)}`, { headers });
        if (showsRes.ok) showsJson = await showsRes.json();
      } catch (err) {
        console.warn("Simkl API shows fallback error:", err);
      }
    }

    const currentMovies = settings?.trendingMovies || [];
    const currentShows = settings?.trendingShows || [];

    const trendingMovies: MediaItem[] =
      Array.isArray(moviesJson) && moviesJson.length > 0
        ? moviesJson.map((m: any, idx: number) => {
            const simklId = m.ids?.simkl_id || m.ids?.simkl || m.ids?.tmdb || idx;
            const year =
              m.year ||
              (m.release_date
                ? parseInt(m.release_date.split("/").pop() || "0", 10) || undefined
                : undefined);
            return {
              id: `simkl-mv-${simklId}`,
              title: m.title || "Untitled",
              libraryId: "discovery",
              remotePath: "",
              filename: m.title || "Untitled",
              year,
              overview: m.overview || "",
              posterUrl: m.poster ? `https://simkl.in/posters/${m.poster}_m.jpg` : undefined,
              backdropUrl: m.fanart ? `https://simkl.in/fanart/${m.fanart}_medium.jpg` : undefined,
              rating: m.ratings?.imdb?.rating || m.ratings?.simkl?.rating,
              genres: m.genres || [],
              libraryType: "movies",
              addedAt: now - idx * 1000,
              lastScannedAt: now,
            };
          })
        : currentMovies;

    const trendingShows: MediaItem[] =
      Array.isArray(showsJson) && showsJson.length > 0
        ? showsJson.map((s: any, idx: number) => {
            const simklId = s.ids?.simkl_id || s.ids?.simkl || s.ids?.tmdb || idx;
            const year =
              s.year ||
              (s.release_date
                ? parseInt(s.release_date.split("/").pop() || "0", 10) || undefined
                : undefined);
            return {
              id: `simkl-tv-${simklId}`,
              title: s.title || "Untitled",
              libraryId: "discovery",
              remotePath: "",
              filename: s.title || "Untitled",
              year,
              overview: s.overview || "",
              posterUrl: s.poster ? `https://simkl.in/posters/${s.poster}_m.jpg` : undefined,
              backdropUrl: s.fanart ? `https://simkl.in/fanart/${s.fanart}_medium.jpg` : undefined,
              rating: s.ratings?.imdb?.rating || s.ratings?.simkl?.rating,
              genres: s.genres || [],
              libraryType: "tv",
              addedAt: now - idx * 1000,
              lastScannedAt: now,
            };
          })
        : currentShows;

    if (trendingMovies.length === 0 && trendingShows.length === 0) {
      return false;
    }

    setSimklDiscoveryData({
      trendingMovies,
      trendingShows,
      anticipatedMovies: [],
      anticipatedShows: [],
      lastDiscoveryFetchAt: now,
    });
    setSimklSettings({ discoveryShelvesEnabled: true, enabled: true });

    return true;
  } catch (e) {
    console.error("Error refreshing Simkl discovery:", e);
    return false;
  }
}
