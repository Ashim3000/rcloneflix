export interface PodcastEpisodeItem {
  id: string;
  guid: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSec: number;
  audioUrl: string;
  chaptersUrl?: string;
  transcriptUrl?: string;
}

export interface PodcastShowFeed {
  title: string;
  author: string;
  description: string;
  artworkUrl?: string;
  feedUrl: string;
  episodes: PodcastEpisodeItem[];
}

export async function searchItunesPodcasts(
  query: string
): Promise<{ id: string; title: string; author: string; feedUrl: string; artworkUrl: string }[]> {
  const res = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=podcast&entity=podcast&limit=25`
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || [])
    .filter((r: Record<string, unknown>) => typeof r.feedUrl === "string")
    .map((r: Record<string, unknown>) => ({
      id: String(r.collectionId || r.feedUrl),
      title: String(r.collectionName || "Podcast"),
      author: String(r.artistName || ""),
      feedUrl: String(r.feedUrl),
      artworkUrl: String(r.artworkUrl600 || r.artworkUrl100 || ""),
    }));
}

async function fetchRssText(url: string): Promise<string> {
  try {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const res = await tauriFetch(url, { method: "GET" });
    if (res.ok) {
      return await res.text();
    }
  } catch (err) {
    console.warn("Tauri fetch failed, falling back to window.fetch:", err);
  }
  const fallback = await fetch(url);
  if (!fallback.ok) {
    throw new Error(`Failed to fetch RSS: HTTP ${fallback.status}`);
  }
  return await fallback.text();
}

export async function parsePodcastRssFeed(feedUrl: string): Promise<PodcastShowFeed> {
  const xmlText = await fetchRssText(feedUrl);
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  const channel = doc.querySelector("channel");

  const title = channel?.querySelector("title")?.textContent?.trim() || "Podcast";
  const author =
    channel?.getElementsByTagName("itunes:author")[0]?.textContent?.trim() ||
    channel?.querySelector("managingEditor")?.textContent?.trim() ||
    "";
  const description = channel?.querySelector("description")?.textContent?.trim() || "";
  const artworkUrl =
    channel?.getElementsByTagName("itunes:image")[0]?.getAttribute("href") ||
    channel?.querySelector("image > url")?.textContent?.trim() ||
    undefined;

  const episodes: PodcastEpisodeItem[] = [];
  const items = Array.from(doc.querySelectorAll("item"));
  for (const item of items) {
    const enclosure = item.querySelector("enclosure");
    const audioUrl = enclosure?.getAttribute("url") || "";
    if (!audioUrl) continue;

    const guid = item.querySelector("guid")?.textContent?.trim() || audioUrl;
    const epTitle = item.querySelector("title")?.textContent?.trim() || "Episode";
    const epDesc = item.querySelector("description")?.textContent?.trim() || "";
    const pubDate = item.querySelector("pubDate")?.textContent?.trim() || "";
    const rawDur = item.getElementsByTagName("itunes:duration")[0]?.textContent?.trim() || "0";
    const durationSec = parseDurationToSeconds(rawDur);
    const chaptersUrl =
      item.getElementsByTagName("podcast:chapters")[0]?.getAttribute("url") || undefined;
    const transcriptUrl =
      item.getElementsByTagName("podcast:transcript")[0]?.getAttribute("url") || undefined;

    episodes.push({
      id: guid,
      guid,
      title: epTitle,
      description: epDesc,
      publishedAt: pubDate,
      durationSec,
      audioUrl,
      chaptersUrl,
      transcriptUrl,
    });
  }

  return { title, author, description, artworkUrl, feedUrl, episodes };
}

function parseDurationToSeconds(raw: string): number {
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const parts = raw.split(":").map((n) => parseInt(n, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

export function importOpmlFeeds(opmlXml: string): { title: string; xmlUrl: string }[] {
  const doc = new DOMParser().parseFromString(opmlXml, "text/xml");
  return Array.from(doc.querySelectorAll("outline[xmlUrl]")).map((el) => ({
    title: el.getAttribute("text") || el.getAttribute("title") || "Podcast",
    xmlUrl: el.getAttribute("xmlUrl") || "",
  }));
}

export function exportOpmlFeeds(feeds: { title: string; xmlUrl: string }[]): string {
  const outlines = feeds
    .map(
      (f) =>
        `      <outline type="rss" text="${f.title.replace(/"/g, "&quot;")}" xmlUrl="${f.xmlUrl.replace(/"/g, "&quot;")}" />`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>RcloneFlix Podcasts</title></head>\n  <body>\n${outlines}\n  </body>\n</opml>`;
}
