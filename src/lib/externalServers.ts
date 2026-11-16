import { useAppStore, type MediaItem } from "../store/appStore";

export interface ExternalMediaServerConfig {
  id: string;
  type: "plex" | "jellyfin";
  name: string;
  baseUrl: string;
  authToken: string;
  userId?: string;
  isOwned: boolean;
  ownerName?: string;
  enabled: boolean;
  lastSyncedAt?: number;
  itemCount?: number;
}

const STORAGE_KEY = "rcloneflix_external_servers_v1";

export function loadExternalServers(): ExternalMediaServerConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveExternalServers(servers: ExternalMediaServerConfig[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
}

export async function requestPlexPin(): Promise<{ id: number; code: string; authUrl: string }> {
  const res = await fetch("https://plex.tv/api/v2/pins?strong=true", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "X-Plex-Product": "RcloneFlix",
      "X-Plex-Client-Identifier": "rcloneflix-client",
    },
  });
  if (!res.ok) throw new Error(`Failed to request Plex PIN: ${res.status}`);
  const data = await res.json();
  const authUrl = `https://app.plex.tv/auth#?clientID=rcloneflix-client&code=${data.code}`;
  return { id: data.id, code: data.code, authUrl };
}

export async function pollPlexPin(pinId: number): Promise<string | null> {
  const res = await fetch(
    `https://plex.tv/api/v2/pins/${pinId}?X-Plex-Client-Identifier=rcloneflix-client`,
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.authToken || null;
}

export async function discoverPlexServers(plexToken: string): Promise<ExternalMediaServerConfig[]> {
  const res = await fetch(
    `https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&X-Plex-Token=${encodeURIComponent(plexToken)}`,
    { headers: { Accept: "application/json", "X-Plex-Client-Identifier": "rcloneflix-client" } }
  );
  if (!res.ok) throw new Error(`Plex discovery failed: ${res.status}`);
  const resources = await res.json();
  const discovered: ExternalMediaServerConfig[] = [];

  for (const r of resources) {
    if (!String(r.provides || "").includes("server")) continue;
    const conns: { uri: string; local: boolean; relay: boolean }[] = r.connections || [];
    const preferred =
      conns.find((c) => !c.local && !c.relay) || conns.find((c) => !c.relay) || conns[0];
    if (!preferred?.uri) continue;

    discovered.push({
      id: `plex-${r.clientIdentifier || r.name}`,
      type: "plex",
      name: r.owned ? r.name : `${r.name} (${r.sourceTitle || "Guest Pass"})`,
      baseUrl: preferred.uri.replace(/\/+$/, ""),
      authToken: r.accessToken || plexToken,
      isOwned: Boolean(r.owned),
      ownerName: r.sourceTitle || undefined,
      enabled: true,
    });
  }
  return discovered;
}

export async function authenticateJellyfinServer(
  baseUrl: string,
  username: string,
  password: string,
  serverLabel?: string
): Promise<ExternalMediaServerConfig> {
  const cleanBase = baseUrl.trim().replace(/\/+$/, "");
  const res = await fetch(`${cleanBase}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Authorization":
        'MediaBrowser Client="RcloneFlix", Device="Desktop", DeviceId="rcloneflix-1", Version="2.0.0"',
    },
    body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (!res.ok) throw new Error(`Jellyfin auth failed: ${res.status}`);
  const data = await res.json();
  return {
    id: `jellyfin-${data.ServerId || Date.now()}`,
    type: "jellyfin",
    name: serverLabel || `Jellyfin (${new URL(cleanBase).hostname})`,
    baseUrl: cleanBase,
    authToken: data.AccessToken,
    userId: data.User?.Id,
    isOwned: true,
    enabled: true,
  };
}

export function syncExternalServersToLibraries(servers: ExternalMediaServerConfig[]): void {
  const store = useAppStore.getState();
  const currentLibs = [...store.libraries];
  let changed = false;

  for (const s of servers) {
    if (!s.enabled) continue;
    const defs: { suffix: string; label: string; type: "movies" | "tv" | "music" }[] = [
      { suffix: "movies", label: "Movies", type: "movies" },
      { suffix: "tv", label: "TV Shows", type: "tv" },
      { suffix: "music", label: "Music", type: "music" },
    ];
    for (const d of defs) {
      const libId = `${s.id}-${d.suffix}`;
      if (!currentLibs.some((l) => l.id === libId)) {
        currentLibs.push({
          id: libId,
          name: `${s.name} (${d.label})`,
          type: d.type,
          remotePaths: [s.baseUrl],
          isSharedPass: !s.isOwned,
          grantorLabel: s.ownerName || (s.type === "plex" ? "Plex Server" : "Jellyfin Server"),
        });
        changed = true;
      }
    }
  }

  if (changed) {
    store.setLibraries(currentLibs);
  }
}

export async function fetchExternalServerMediaItems(
  server: ExternalMediaServerConfig
): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  if (!server.enabled) return items;

  if (server.type === "plex") {
    const secRes = await fetch(
      `${server.baseUrl}/library/sections?X-Plex-Token=${encodeURIComponent(server.authToken)}`,
      { headers: { Accept: "application/json" } }
    );
    if (!secRes.ok) return items;
    const secData = await secRes.json();
    const dirs = secData?.MediaContainer?.Directory || [];

    for (const dir of dirs) {
      if (dir.type !== "movie" && dir.type !== "show" && dir.type !== "artist") continue;
      // type=4 fetches playable episodes directly for TV sections; type=10 fetches audio tracks
      const typeParam = dir.type === "show" ? "&type=4" : dir.type === "artist" ? "&type=10" : "";
      const listRes = await fetch(
        `${server.baseUrl}/library/sections/${dir.key}/all?X-Plex-Token=${encodeURIComponent(server.authToken)}${typeParam}`,
        { headers: { Accept: "application/json" } }
      );
      if (!listRes.ok) continue;
      const listData = await listRes.json();
      const metadata = listData?.MediaContainer?.Metadata || [];

      for (const m of metadata) {
        const part = m.Media?.[0]?.Part?.[0];
        const partKey = part?.key;
        if (!partKey) continue;
        const streamUrl = `${server.baseUrl}${partKey}?X-Plex-Token=${encodeURIComponent(server.authToken)}`;
        const rawFile = part?.file ? String(part.file).split(/[\\/]/).pop() : undefined;
        const ext = dir.type === "artist" ? "mp3" : "mp4";

        if (dir.type === "show") {
          const showTitle = m.grandparentTitle || m.parentTitle || m.title || "TV Series";
          const season = m.parentIndex ?? 1;
          const episode = m.index ?? 1;
          const thumbPath = m.grandparentThumb || m.parentThumb || m.thumb;
          const artPath = m.grandparentArt || m.art;
          items.push({
            id: `${server.id}-${m.ratingKey}`,
            libraryId: `${server.id}-tv`,
            libraryType: "tv",
            title: `${showTitle} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} - ${m.title || "Episode"}`,
            showId: `${server.id}-show-${m.grandparentRatingKey || showTitle}`,
            showTitle,
            season,
            episode,
            episodeTitle: m.title || `Episode ${episode}`,
            year: m.year,
            overview: m.summary,
            rating: m.audienceRating || m.rating,
            posterUrl: thumbPath
              ? `${server.baseUrl}${thumbPath}?X-Plex-Token=${encodeURIComponent(server.authToken)}`
              : undefined,
            showPosterUrl: thumbPath
              ? `${server.baseUrl}${thumbPath}?X-Plex-Token=${encodeURIComponent(server.authToken)}`
              : undefined,
            backdropUrl: artPath
              ? `${server.baseUrl}${artPath}?X-Plex-Token=${encodeURIComponent(server.authToken)}`
              : undefined,
            remotePath: streamUrl,
            filename: rawFile || `${showTitle} S${season}E${episode}.${ext}`,
            addedAt: (m.addedAt || 0) * 1000 || Date.now(),
            lastScannedAt: Date.now(),
          } as MediaItem);
        } else if (dir.type === "artist") {
          const thumbPath = m.thumb || m.parentThumb || m.grandparentThumb;
          items.push({
            id: `${server.id}-${m.ratingKey}`,
            libraryId: `${server.id}-music`,
            libraryType: "music",
            title: m.title || "Untitled Track",
            artist: m.grandparentTitle || m.originalTitle || "Unknown Artist",
            album: m.parentTitle || "Unknown Album",
            year: m.parentYear || m.year,
            posterUrl: thumbPath
              ? `${server.baseUrl}${thumbPath}?X-Plex-Token=${encodeURIComponent(server.authToken)}`
              : undefined,
            remotePath: streamUrl,
            filename: rawFile || `${m.title || "track"}.${ext}`,
            addedAt: (m.addedAt || 0) * 1000 || Date.now(),
            lastScannedAt: Date.now(),
          });
        } else {
          items.push({
            id: `${server.id}-${m.ratingKey}`,
            libraryId: `${server.id}-movies`,
            libraryType: "movies",
            title: m.title || "Untitled",
            year: m.year,
            overview: m.summary,
            rating: m.audienceRating || m.rating,
            posterUrl: m.thumb
              ? `${server.baseUrl}${m.thumb}?X-Plex-Token=${encodeURIComponent(server.authToken)}`
              : undefined,
            backdropUrl: m.art
              ? `${server.baseUrl}${m.art}?X-Plex-Token=${encodeURIComponent(server.authToken)}`
              : undefined,
            remotePath: streamUrl,
            filename: rawFile || `${m.title || "movie"}.${ext}`,
            addedAt: (m.addedAt || 0) * 1000 || Date.now(),
            lastScannedAt: Date.now(),
          });
        }
      }
    }
  } else if (server.type === "jellyfin" && server.userId) {
    const res = await fetch(
      `${server.baseUrl}/Users/${server.userId}/Items?IncludeItemTypes=Movie,Episode,Audio&Recursive=true&Fields=Overview,Path,MediaSources&Limit=1000`,
      { headers: { "X-Emby-Token": server.authToken } }
    );
    if (!res.ok) return items;
    const data = await res.json();
    for (const m of data.Items || []) {
      const isAudio = m.Type === "Audio";
      const isEpisode = m.Type === "Episode";
      const streamUrl = isAudio
        ? `${server.baseUrl}/Audio/${m.Id}/stream?static=true&api_key=${encodeURIComponent(server.authToken)}`
        : `${server.baseUrl}/Videos/${m.Id}/stream?static=true&api_key=${encodeURIComponent(server.authToken)}`;

      if (isEpisode) {
        const showTitle = m.SeriesName || "TV Series";
        const season = m.ParentIndexNumber ?? 1;
        const episode = m.IndexNumber ?? 1;
        items.push({
          id: `${server.id}-${m.Id}`,
          libraryId: `${server.id}-tv`,
          libraryType: "tv",
          title: `${showTitle} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} - ${m.Name || "Episode"}`,
          showId: `${server.id}-show-${m.SeriesId || showTitle}`,
          showTitle,
          season,
          episode,
          episodeTitle: m.Name || `Episode ${episode}`,
          year: m.ProductionYear,
          overview: m.Overview,
          rating: m.CommunityRating,
          posterUrl: `${server.baseUrl}/Items/${m.SeriesId || m.Id}/Images/Primary`,
          showPosterUrl: `${server.baseUrl}/Items/${m.SeriesId || m.Id}/Images/Primary`,
          remotePath: streamUrl,
          filename: `${m.Name || m.Id}.mp4`,
          addedAt: Date.now(),
          lastScannedAt: Date.now(),
        } as MediaItem);
      } else if (isAudio) {
        items.push({
          id: `${server.id}-${m.Id}`,
          libraryId: `${server.id}-music`,
          libraryType: "music",
          title: m.Name || "Track",
          artist: m.AlbumArtist || m.Artists?.[0] || "Unknown Artist",
          album: m.Album || "Unknown Album",
          year: m.ProductionYear,
          posterUrl: `${server.baseUrl}/Items/${m.AlbumId || m.Id}/Images/Primary`,
          remotePath: streamUrl,
          filename: `${m.Name || m.Id}.mp3`,
          addedAt: Date.now(),
          lastScannedAt: Date.now(),
        });
      } else {
        items.push({
          id: `${server.id}-${m.Id}`,
          libraryId: `${server.id}-movies`,
          libraryType: "movies",
          title: m.Name || "Untitled",
          year: m.ProductionYear,
          overview: m.Overview,
          rating: m.CommunityRating,
          posterUrl: `${server.baseUrl}/Items/${m.Id}/Images/Primary`,
          remotePath: streamUrl,
          filename: `${m.Name || m.Id}.mp4`,
          addedAt: Date.now(),
          lastScannedAt: Date.now(),
        });
      }
    }
  }

  return items;
}

export async function syncSingleServerContent(server: ExternalMediaServerConfig): Promise<number> {
  const store = useAppStore.getState();
  syncExternalServersToLibraries([server]);
  const items = await fetchExternalServerMediaItems(server);
  if (items.length > 0) {
    store.bulkUpsertMediaItems(items);
  }
  const allServers = loadExternalServers().map((s) =>
    s.id === server.id ? { ...s, lastSyncedAt: Date.now(), itemCount: items.length } : s
  );
  saveExternalServers(allServers);
  return items.length;
}

export async function syncExternalServerForLibraryId(libraryId: string): Promise<number> {
  const servers = loadExternalServers();
  const matched = servers.find((s) => libraryId.startsWith(`${s.id}-`));
  if (!matched) return 0;
  return await syncSingleServerContent(matched);
}

export function removeExternalServerAndPurge(serverId: string): void {
  const store = useAppStore.getState();
  const allServers = loadExternalServers().filter((s) => s.id !== serverId);
  saveExternalServers(allServers);

  const libIds = [`${serverId}-movies`, `${serverId}-tv`, `${serverId}-music`];
  for (const lid of libIds) {
    store.clearLibraryItems(lid);
  }

  const remainingLibs = store.libraries.filter((l) => !libIds.includes(l.id));
  store.setLibraries(remainingLibs);
}
