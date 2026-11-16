export type BookmarkCategory =
  | "movies_tv"
  | "anime"
  | "comics"
  | "radio"
  | "adult"
  | "other";

export type SiteBookmark = {
  id: string;
  title: string;
  url: string;
  category: BookmarkCategory;
  description?: string;
  isCustom?: boolean;
  addedAt?: number;
  requiresSearch?: boolean;
  searchPlaceholder?: string;
  posterUrl?: string;
  mediaType?: string;
  bookmarkType?: "site" | "stream"; // "site" = crawlable media portal/collection, "stream" = single direct stream
};

export const EXAMPLE_BOOKMARKS: SiteBookmark[] = [
  // Movies & TV Series
  {
    id: "moviebite",
    title: "MovieBite",
    url: "https://moviebite.org",
    category: "movies_tv",
    description: "Trending movies & series with multi-server HLS playback",
  },
  {
    id: "baddieseast",
    title: "Baddies East",
    url: "https://baddieseast.com.co",
    category: "movies_tv",
    description: "Latest episodes, reality TV, and urban culture series",
    searchPlaceholder: "Search episodes or series on Baddies East (e.g. Midwest, Caribbean)...",
  },
  {
    id: "tubitv",
    title: "Tubi TV",
    url: "https://tubitv.com",
    category: "movies_tv",
    description: "Free movies and TV shows on demand and live streaming channels",
    searchPlaceholder: "Search Tubi TV movies, series, or live channels...",
  },

  // Anime
  {
    id: "yomi",
    title: "Yomi.to Anime",
    url: "https://yomi.to",
    category: "anime",
    description: "High-definition subbed & dubbed anime simulcasts with multi-server HLS",
    searchPlaceholder: "Search anime title on Yomi.to...",
  },

  // Comics & Manga
  {
    id: "readcomicsonline",
    title: "ReadComicsOnline",
    url: "https://readcomicsonline.ru",
    category: "comics",
    description: "Extensive library of Marvel, DC, and indie comics with instant page streaming",
    searchPlaceholder: "Search comics or characters on ReadComicsOnline (e.g. Wolverine, Batman)...",
    mediaType: "comics",
  },
  {
    id: "mangadex",
    title: "MangaDex",
    url: "https://mangadex.org",
    category: "comics",
    description: "Public manga and comic scanlations with high-res page streaming",
    searchPlaceholder: "Search manga, manhua, or manhwa on MangaDex...",
    mediaType: "comics",
  },

  // Music & Live Radio
  {
    id: "iheart",
    title: "iHeartRadio Live Stations",
    url: "https://www.iheart.com",
    category: "radio",
    description: "Live AM/FM and online digital radio stations nationwide",
    searchPlaceholder: "Search live stations, call signs, or cities on iHeart...",
  },

  // Adult (Portals & Search)
  {
    id: "balbums",
    title: "Balbums (Bunkr Albums)",
    url: "https://balbums.st",
    category: "adult",
    description: "Searchable directory of Bunkr media albums, leaks, and video archives",
    searchPlaceholder: "Search albums, models, or tags on Balbums...",
    bookmarkType: "site",
  },
  {
    id: "sxyprn",
    title: "Sxyprn",
    url: "https://www.sxyprn.com",
    category: "adult",
    description: "Adult video feeds with direct CDN decoder",
    searchPlaceholder: "Search tag or keyword on Sxyprn...",
  },
  {
    id: "pornhub",
    title: "PornHub",
    url: "https://www.pornhub.com",
    category: "adult",
    description: "Direct master HLS & MP4 streams",
    searchPlaceholder: "Search videos or stars on PornHub...",
  },
];

// Alias for backward compatibility
export const CURATED_BOOKMARKS = EXAMPLE_BOOKMARKS;

const USER_BOOKMARKS_KEY = "rcloneflix_site_bookmarks_v1";
const RECENT_SEARCHES_KEY = "rcloneflix_recent_searches_v1";

export function getUserBookmarks(): SiteBookmark[] {
  try {
    const raw = localStorage.getItem(USER_BOOKMARKS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error("Failed to load user bookmarks:", e);
    return [];
  }
}

export function saveUserBookmark(bookmark: Omit<SiteBookmark, "id" | "addedAt">): SiteBookmark {
  const current = getUserBookmarks();
  const id = `user-bm-${Date.now()}`;
  const newBm: SiteBookmark = {
    ...bookmark,
    id,
    isCustom: true,
    addedAt: Date.now(),
  };
  const updated = [newBm, ...current.filter((b) => b.url.toLowerCase() !== bookmark.url.toLowerCase())];
  localStorage.setItem(USER_BOOKMARKS_KEY, JSON.stringify(updated));
  return newBm;
}

export function removeUserBookmark(idOrUrl: string): void {
  const current = getUserBookmarks();
  const updated = current.filter(
    (b) => b.id !== idOrUrl && b.url.toLowerCase() !== idOrUrl.toLowerCase()
  );
  localStorage.setItem(USER_BOOKMARKS_KEY, JSON.stringify(updated));
}

export function isSiteBookmarked(url: string): boolean {
  const clean = url.trim().toLowerCase();
  const userBms = getUserBookmarks();
  if (userBms.some((b) => b.url.toLowerCase().includes(clean) || clean.includes(b.url.toLowerCase()))) {
    return true;
  }
  return CURATED_BOOKMARKS.some(
    (b) => b.url.toLowerCase().includes(clean) || clean.includes(b.url.toLowerCase())
  );
}

export function getRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addRecentSearch(query: string): void {
  const clean = query.trim();
  if (!clean || clean.length < 2) return;
  try {
    const current = getRecentSearches().filter((q) => q.toLowerCase() !== clean.toLowerCase());
    const updated = [clean, ...current].slice(0, 10);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn("Failed to save recent search:", e);
  }
}

export function clearRecentSearches(): void {
  localStorage.removeItem(RECENT_SEARCHES_KEY);
}
