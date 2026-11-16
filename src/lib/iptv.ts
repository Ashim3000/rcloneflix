import { invoke } from "@tauri-apps/api/core";

export type IptvItem = {
  id: string;
  name: string;
  group: string;
  logo?: string;
  stream_url: string;
  epg_id?: string;
  imdb_id?: string;
  season?: number;
  episode?: number;
  year?: number;
};

export type IptvPlaylist = {
  items: IptvItem[];
  categories: string[];
  total_count: number;
};

export type IptvAccountConfig = {
  provider: "apollo" | "generic" | "xtream";
  username?: string;
  password?: string;
  domain?: string;
  serverUrl?: string;
  outputFormat?: "ts" | "m3u8";
  m3uUrl?: string;
  epgUrl?: string;
};

/**
 * Fetch and parse an M3U IPTV playlist via the native Rust command.
 * Results are cached locally on disk for 4 hours unless forceRefresh is true.
 */
export async function fetchIptvPlaylist(
  url: string,
  forceRefresh: boolean = false
): Promise<IptvPlaylist> {
  return invoke<IptvPlaylist>("fetch_iptv_playlist", {
    url: url.trim(),
    forceRefresh,
  });
}

/**
 * Check Xtream Codes account info and connection status via player_api.php.
 */
export async function checkXtreamAccount(
  serverUrl: string,
  username: string,
  password: string
): Promise<any> {
  return invoke("check_xtream_account", {
    serverUrl: serverUrl.trim(),
    username: username.trim(),
    password: password.trim(),
  });
}

/**
 * Xtream Codes API endpoint builders.
 */
export function buildXtreamUrls(
  serverUrl: string,
  username: string,
  password: string,
  outputFormat: "ts" | "m3u8" = "ts"
) {
  let cleanServer = serverUrl.trim().replace(/\/$/, "");
  if (!cleanServer.startsWith("http://") && !cleanServer.startsWith("https://")) {
    cleanServer = `http://${cleanServer}`;
  }
  const u = encodeURIComponent(username.trim());
  const p = encodeURIComponent(password.trim());
  const out = outputFormat || "ts";
  return {
    liveTv: `${cleanServer}/get.php?username=${u}&password=${p}&type=m3u&output=${out}`,
    movies: `${cleanServer}/get.php?username=${u}&password=${p}&type=m3u&output=${out}&category=vod`,
    tvShows: `${cleanServer}/get.php?username=${u}&password=${p}&type=m3u&output=${out}&category=series`,
    epg: `${cleanServer}/xmltv.php?username=${u}&password=${p}`,
    playerApi: `${cleanServer}/player_api.php?username=${u}&password=${p}`,
  };
}

/**
 * Apollo Group TV endpoint builders.
 */
export function buildApolloUrls(
  username: string,
  password: string,
  domain: string = "tvnow.best"
) {
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const base = `https://${cleanDomain}/api/list/${username}/${password}`;
  return {
    liveTv: `${base}/m3u8/livetv`,
    movies: `${base}/m3u8/movies`,
    tvShows: `${base}/m3u8/tvshows/1`,
    epg: `https://${cleanDomain}/api/epg/${username}/${password}/lite.xml.gz`,
    epgFull: `https://${cleanDomain}/api/epg/${username}/${password}/full.xml.gz`,
  };
}

/**
 * Given an IMDb ID (e.g. tt1234567), returns high-resolution poster or Cinemeta metadata.
 */
export function getCinemetaPosterUrl(imdbId?: string): string | undefined {
  if (!imdbId || !imdbId.startsWith("tt")) return undefined;
  return `https://images.metahub.space/poster/medium/${imdbId}/img`;
}
