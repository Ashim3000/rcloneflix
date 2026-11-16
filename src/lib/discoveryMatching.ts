import { type MediaItem, selectTvShows } from "../store/appStore";

/**
 * Cross-references discovery items (Trending Movies, Shows, Anticipated) against
 * the user's local SQLite library.
 * Tags matched items with `inLibrary: true` and sets `matchedLibraryId`.
 */
export function annotateWithLibraryMatch(
  items: MediaItem[] | undefined,
  mediaItems: Record<string, MediaItem>
): MediaItem[] {
  if (!items || items.length === 0) return [];
  const allMedia = Object.values(mediaItems);

  return items.map((item) => {
    // 1. TV Shows
    if (item.groupType === "show" || item.libraryType === "tv") {
      const showTitle = (item.showTitle || item.title).trim().toLowerCase();
      const match = allMedia.find(
        (m) =>
          (m.libraryType === "tv" || m.groupType === "show") &&
          ((m.showId && item.showId && m.showId === item.showId) ||
            (m.showTitle || m.title).trim().toLowerCase() === showTitle)
      );
      if (match) {
        return { ...item, inLibrary: true, matchedLibraryId: match.id };
      }
      return item;
    }

    // 2. Movies & Videos
    const itemTitle = item.title.trim().toLowerCase();
    const match = allMedia.find((m) => {
      if (m.libraryType !== "movies" && m.libraryType !== "adult") {
        return false;
      }
      if (item.metadataId && m.metadataId && String(item.metadataId) === String(m.metadataId)) {
        return true;
      }
      const mTitle = m.title.trim().toLowerCase();
      if (mTitle === itemTitle) {
        if (item.year && m.year) {
          return Math.abs(item.year - m.year) <= 1;
        }
        return true;
      }
      return false;
    });

    if (match) {
      return { ...item, inLibrary: true, matchedLibraryId: match.id };
    }
    return item;
  });
}

/**
 * Handles navigation when clicking a discovery card, prioritizing matched local library content.
 */
export function resolveDiscoveryCardNavigation(
  item: MediaItem,
  mediaItems: Record<string, MediaItem>,
  navigate: (path: string, options?: { state?: any }) => void
): void {
  // If matched to a local library item, navigate to that item
  const matchedId = item.matchedLibraryId;
  const realItem = matchedId ? mediaItems[matchedId] : undefined;

  if (item.groupType === "show" || item.libraryType === "tv") {
    const allShows = selectTvShows(mediaItems);
    const searchTitle = (item.showTitle || item.title).toLowerCase();
    const matchedShow = allShows.find(
      (s) => s.showId === item.showId || s.title.toLowerCase() === searchTitle
    );
    if (matchedShow) {
      navigate(`/tv/show/${encodeURIComponent(matchedShow.showId)}`, {
        state: { show: matchedShow },
      });
      return;
    }
    // Show not in library — open MediaDetailPage so user can stream via Stremio Addons or Easynews
    navigate("/detail", { state: { item, isDiscoveryOnly: true } });
    return;
  }

  if (realItem) {
    navigate("/detail", { state: { item: realItem } });
    return;
  }

  // Not in local library - open detail with discovery flag
  navigate("/detail", { state: { item, isDiscoveryOnly: true } });
}
