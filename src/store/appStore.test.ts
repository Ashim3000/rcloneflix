import { describe, it, expect } from "vitest";
import {
  selectAudiobooks,
  selectTvShows,
  selectMusicArtists,
  selectInProgress,
  selectFavoriteItems,
  selectPlaylistItems,
  selectRecentlyAddedGrouped,
  isItemFavorited,
  isLocalPath,
  deduplicateMediaItems,
  useAppStore,
  type MediaItem,
  type WatchProgress,
} from "./appStore";

function item(over: Partial<MediaItem> & Pick<MediaItem, "id">): MediaItem {
  return {
    libraryId: "lib1",
    libraryType: "movies",
    remotePath: `gdrive:/x/${over.id}.mkv`,
    filename: `${over.id}.mkv`,
    title: over.id,
    addedAt: 0,
    lastScannedAt: 0,
    ...over,
  } as MediaItem;
}

function asMap(items: MediaItem[]): Record<string, MediaItem> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

describe("selectAudiobooks", () => {
  it("groups tracks sharing an album into one book", () => {
    const items = asMap([
      item({ id: "t1", libraryType: "audiobooks", album: "Mistborn", filename: "01.m4b" }),
      item({ id: "t2", libraryType: "audiobooks", album: "Mistborn", filename: "02.m4b" }),
      item({ id: "t3", libraryType: "audiobooks", album: "Dune", filename: "01.m4b" }),
    ]);
    const groups = selectAudiobooks(items, "lib1");
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.title === "Mistborn")!.tracks).toHaveLength(2);
  });

  it("falls back to the title when no album is present", () => {
    // Flat one-file-per-book libraries have album === undefined; they must not
    // all collapse into a single group.
    const items = asMap([
      item({ id: "b1", libraryType: "audiobooks", title: "The Guardians", album: undefined }),
      item({ id: "b2", libraryType: "audiobooks", title: "Democracy Awakening", album: undefined }),
    ]);
    const groups = selectAudiobooks(items, "lib1");
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.tracks.length === 1)).toBe(true);
  });

  it("orders tracks numerically, not lexically", () => {
    const items = asMap([
      item({ id: "t10", libraryType: "audiobooks", album: "Book", filename: "10.m4b" }),
      item({ id: "t2", libraryType: "audiobooks", album: "Book", filename: "2.m4b" }),
    ]);
    const [group] = selectAudiobooks(items, "lib1");
    expect(group.tracks.map((t) => t.filename)).toEqual(["2.m4b", "10.m4b"]);
  });
});

describe("selectTvShows", () => {
  it("nests episodes under shows and seasons", () => {
    const items = asMap([
      item({ id: "e1", libraryType: "tv", showId: "100", showTitle: "Severance", season: 1, episode: 2 }),
      item({ id: "e2", libraryType: "tv", showId: "100", showTitle: "Severance", season: 1, episode: 1 }),
      item({ id: "e3", libraryType: "tv", showId: "100", showTitle: "Severance", season: 2, episode: 1 }),
    ]);
    const [show] = selectTvShows(items, "lib1");
    expect(show.title).toBe("Severance");
    expect(show.episodeCount).toBe(3);
    expect(Object.keys(show.seasons)).toHaveLength(2);
    expect(show.seasons[1].episodes.map((e) => e.episode)).toEqual([1, 2]);
  });

  it("keeps unmatched shows separate by title", () => {
    const items = asMap([
      item({ id: "a", libraryType: "tv", showTitle: "Show A", season: 1, episode: 1 }),
      item({ id: "b", libraryType: "tv", showTitle: "Show B", season: 1, episode: 1 }),
    ]);
    expect(selectTvShows(items, "lib1")).toHaveLength(2);
  });
});

describe("selectMusicArtists", () => {
  it("nests albums and tracks under artists", () => {
    const items = asMap([
      item({ id: "s1", libraryType: "music", artist: "Boards", album: "Music Has", trackNumber: 2 }),
      item({ id: "s2", libraryType: "music", artist: "Boards", album: "Music Has", trackNumber: 1 }),
      item({ id: "s3", libraryType: "music", artist: "Boards", album: "Geogaddi", trackNumber: 1 }),
    ]);
    const [artist] = selectMusicArtists(items, "lib1");
    expect(artist.name).toBe("Boards");
    expect(artist.albumCount).toBe(2);
    expect(artist.trackCount).toBe(3);
    expect(artist.albums["Music Has"].tracks.map((t) => t.trackNumber)).toEqual([1, 2]);
  });
});

describe("selectInProgress", () => {
  const progress = (over: Partial<WatchProgress> & Pick<WatchProgress, "itemId">): WatchProgress => ({
    position: 100,
    duration: 1000,
    completed: false,
    lastWatchedAt: 1,
    ...over,
  });

  it("excludes completed and barely-started items", () => {
    const items = asMap([item({ id: "a" }), item({ id: "b" }), item({ id: "c" })]);
    const p = {
      a: progress({ itemId: "a" }),
      b: progress({ itemId: "b", completed: true }),
      c: progress({ itemId: "c", position: 5 }),
    };
    expect(selectInProgress(items, p).map((i) => i.id)).toEqual(["a"]);
  });

  it("ignores progress rows whose media item is gone", () => {
    const items = asMap([item({ id: "a" })]);
    const p = { a: progress({ itemId: "a" }), ghost: progress({ itemId: "ghost" }) };
    expect(selectInProgress(items, p)).toHaveLength(1);
  });
});

describe("isLocalPath", () => {
  it("recognizes unix and windows local paths", () => {
    expect(isLocalPath("/home/user/media/movie.mp4")).toBe(true);
    expect(isLocalPath("~/Downloads/media.mkv")).toBe(true);
    expect(isLocalPath("./media/test.mp3")).toBe(true);
    expect(isLocalPath("C:\\Media\\video.mp4")).toBe(true);
    expect(isLocalPath("D:/Audio/track.flac")).toBe(true);
    expect(isLocalPath("\\\\server\\share\\video.mkv")).toBe(true);
  });

  it("recognizes remote paths", () => {
    expect(isLocalPath("gdrive:Movies/Inception.mkv")).toBe(false);
    expect(isLocalPath("seedbox:TV/Show/S01E01.mkv")).toBe(false);
    expect(isLocalPath("premiumize:Books/book.epub")).toBe(false);
  });
});

describe("deduplicateMediaItems & defer to local", () => {
  it("defers to the local version when both remote and local duplicates exist", () => {
    const remoteMovie = item({
      id: "remote-1",
      remotePath: "gdrive:Movies/Inception (2010)/Inception.mkv",
      title: "Inception",
      year: 2010,
      posterUrl: "https://image.tmdb.org/t/p/w500/remote-poster.jpg",
      metadataId: "tt1375666",
      metadataSource: "cinemeta",
    });

    const localMovie = item({
      id: "local-1",
      remotePath: "/home/user/Movies/Inception (2010)/Inception.mkv",
      title: "Inception",
      year: 2010,
      metadataId: "tt1375666",
      metadataSource: "cinemeta",
    });

    const result = deduplicateMediaItems([remoteMovie, localMovie]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("local-1");
    expect(result[0].remotePath).toBe("/home/user/Movies/Inception (2010)/Inception.mkv");
    // Inherited poster from remote
    expect(result[0].posterUrl).toBe("https://image.tmdb.org/t/p/w500/remote-poster.jpg");
  });

  it("defers TV episode duplicates to the local version in selectTvShows", () => {
    const remoteEp = item({
      id: "rem-ep1",
      libraryType: "tv",
      remotePath: "gdrive:TV/Breaking Bad/Season 1/S01E01.mkv",
      showTitle: "Breaking Bad",
      season: 1,
      episode: 1,
      showPosterUrl: "https://poster.jpg",
    });

    const localEp = item({
      id: "loc-ep1",
      libraryType: "tv",
      remotePath: "/home/user/TV/Breaking Bad/Season 1/S01E01.mkv",
      showTitle: "Breaking Bad",
      season: 1,
      episode: 1,
    });

    const shows = selectTvShows(asMap([remoteEp, localEp]));
    expect(shows).toHaveLength(1);
    expect(shows[0].seasons[1].episodes).toHaveLength(1);
    expect(shows[0].seasons[1].episodes[0].id).toBe("loc-ep1");
    expect(shows[0].seasons[1].episodes[0].remotePath).toBe("/home/user/TV/Breaking Bad/Season 1/S01E01.mkv");
  });

  it("keeps multiple distinct TV episodes of the same show with shared show metadataId", () => {
    const ep1 = item({
      id: "ep1",
      libraryType: "tv",
      remotePath: "gdrive:TV/Homeland/Season 1/Homeland - S01E01 - Pilot.mp4",
      showTitle: "Homeland",
      season: 1,
      episode: 1,
      title: "Pilot",
      metadataId: "tt1796960",
      metadataSource: "cinemeta",
    });
    const ep2 = item({
      id: "ep2",
      libraryType: "tv",
      remotePath: "gdrive:TV/Homeland/Season 1/Homeland - S01E02 - Grace.mp4",
      showTitle: "Homeland",
      season: 1,
      episode: 2,
      title: "Grace",
      metadataId: "tt1796960",
      metadataSource: "cinemeta",
    });
    const ep3 = item({
      id: "ep3",
      libraryType: "tv",
      remotePath: "gdrive:TV/Homeland/Season 2/Homeland - S02E01 - The Smile.mp4",
      showTitle: "Homeland",
      season: 2,
      episode: 1,
      title: "The Smile",
      metadataId: "tt1796960",
      metadataSource: "cinemeta",
    });

    const deduped = deduplicateMediaItems([ep1, ep2, ep3]);
    expect(deduped).toHaveLength(3);

    const shows = selectTvShows(asMap([ep1, ep2, ep3]));
    expect(shows).toHaveLength(1);
    expect(shows[0].title).toBe("Homeland");
    expect(shows[0].episodeCount).toBe(3);
    expect(Object.keys(shows[0].seasons)).toHaveLength(2);
    expect(shows[0].seasons[1].episodes).toHaveLength(2);
    expect(shows[0].seasons[2].episodes).toHaveLength(1);
  });

  it("defers Music track duplicates to the local version in selectMusicArtists", () => {
    const remoteTrack = item({
      id: "rem-tr1",
      libraryType: "music",
      remotePath: "gdrive:Music/Radiohead/Kid A/01 Everything in Its Right Place.flac",
      artist: "Radiohead",
      album: "Kid A",
      trackNumber: 1,
      title: "Everything in Its Right Place",
      posterUrl: "https://art.jpg",
    });

    const localTrack = item({
      id: "loc-tr1",
      libraryType: "music",
      remotePath: "/home/user/Music/Radiohead/Kid A/01 Everything in Its Right Place.mp3",
      artist: "Radiohead",
      album: "Kid A",
      trackNumber: 1,
      title: "Everything in Its Right Place",
    });

    const artists = selectMusicArtists(asMap([remoteTrack, localTrack]));
    expect(artists).toHaveLength(1);
    const album = artists[0].albums["Kid A"];
    expect(album.tracks).toHaveLength(1);
    expect(album.tracks[0].id).toBe("loc-tr1");
    expect(album.tracks[0].remotePath).toBe("/home/user/Music/Radiohead/Kid A/01 Everything in Its Right Place.mp3");
    // Inherited album art
    expect(album.tracks[0].posterUrl).toBe("https://art.jpg");
  });

  it("syncs favorite status across duplicate items with isItemFavorited", () => {
    const remote = item({
      id: "rem-fav",
      remotePath: "gdrive:Movies/Matrix.mkv",
      title: "The Matrix",
      year: 1999,
    });
    const local = item({
      id: "loc-fav",
      remotePath: "/home/user/Movies/Matrix.mkv",
      title: "The Matrix",
      year: 1999,
    });
    const items = asMap([remote, local]);
    const favorites = { "rem-fav": 12345 };

    // Even though favorites only has the remote ID, local item is recognized as favorited
    expect(isItemFavorited(local, favorites, items)).toBe(true);
    expect(isItemFavorited(remote, favorites, items)).toBe(true);
  });

  it("selectFavoriteItems returns preferred local items and sorts by timestamp", () => {
    const remote = item({
      id: "rem-fav",
      remotePath: "gdrive:Movies/Matrix.mkv",
      title: "The Matrix",
      year: 1999,
    });
    const local = item({
      id: "loc-fav",
      remotePath: "/home/user/Movies/Matrix.mkv",
      title: "The Matrix",
      year: 1999,
    });
    const items = asMap([remote, local]);
    const favorites = { "rem-fav": 5000 };

    const favItems = selectFavoriteItems(items, favorites);
    expect(favItems).toHaveLength(1);
    expect(favItems[0].id).toBe("loc-fav");
  });

  it("selectPlaylistItems resolves playlist items to local duplicates", () => {
    const remote = item({
      id: "rem-pl",
      remotePath: "gdrive:Movies/Alien.mkv",
      title: "Alien",
      year: 1979,
    });
    const local = item({
      id: "loc-pl",
      remotePath: "/home/user/Movies/Alien.mkv",
      title: "Alien",
      year: 1979,
    });
    const items = asMap([remote, local]);
    const playlist = {
      id: "pl-1",
      name: "Sci-Fi",
      type: "video" as const,
      itemIds: ["rem-pl"],
      createdAt: 1,
      updatedAt: 1,
    };

    const plItems = selectPlaylistItems(playlist, items);
    expect(plItems).toHaveLength(1);
    // Resolves to local duplicate
    expect(plItems[0].id).toBe("loc-pl");
  });

  it("toggleFavorite toggles all duplicate items in the store together", () => {
    const remote = item({
      id: "rem-tog",
      remotePath: "gdrive:Movies/Heat.mkv",
      title: "Heat",
      year: 1995,
    });
    const local = item({
      id: "loc-tog",
      remotePath: "/home/user/Movies/Heat.mkv",
      title: "Heat",
      year: 1995,
    });
    useAppStore.setState({
      mediaItems: asMap([remote, local]),
      favorites: {},
    });

    const isFav = useAppStore.getState().toggleFavorite("rem-tog");
    expect(isFav).toBe(true);
    expect(useAppStore.getState().favorites["rem-tog"]).toBeDefined();
    expect(useAppStore.getState().favorites["loc-tog"]).toBeDefined();

    const isFavAfter = useAppStore.getState().toggleFavorite("loc-tog");
    expect(isFavAfter).toBe(false);
    expect(useAppStore.getState().favorites["rem-tog"]).toBeUndefined();
    expect(useAppStore.getState().favorites["loc-tog"]).toBeUndefined();
  });

  it("updateWatchProgress mirrors progress across duplicate items", () => {
    const remote = item({
      id: "rem-prog",
      remotePath: "gdrive:Movies/Dune.mkv",
      title: "Dune",
      year: 2021,
    });
    const local = item({
      id: "loc-prog",
      remotePath: "/home/user/Movies/Dune.mkv",
      title: "Dune",
      year: 2021,
    });
    useAppStore.setState({
      mediaItems: asMap([remote, local]),
      watchProgress: {},
    });

    useAppStore.getState().updateWatchProgress({
      itemId: "loc-prog",
      position: 120,
      duration: 300,
      completed: false,
      lastWatchedAt: 1000,
    });

    const progress = useAppStore.getState().watchProgress;
    expect(progress["loc-prog"]?.position).toBe(120);
    expect(progress["rem-prog"]?.position).toBe(120);
  });
});

describe("Music Cover Art Inheritance", () => {
  it("strictly propagates album posterUrl to all tracks in the album", () => {
    const items = asMap([
      item({
        id: "tr1",
        libraryType: "music",
        artist: "Radiohead",
        album: "OK Computer",
        title: "Airbag",
        posterUrl: "https://example.com/ok-computer.jpg",
      }),
      item({
        id: "tr2",
        libraryType: "music",
        artist: "Radiohead",
        album: "OK Computer",
        title: "Paranoid Android",
        posterUrl: "https://example.com/single-artwork.jpg", // Single release artwork
      }),
      item({
        id: "tr3",
        libraryType: "music",
        artist: "Radiohead",
        album: "OK Computer",
        title: "Subterranean Homesick Alien",
        posterUrl: undefined,
      }),
    ]);

    const artists = selectMusicArtists(items, "lib1");
    expect(artists).toHaveLength(1);
    const album = artists[0].albums["OK Computer"];
    expect(album).toBeDefined();
    // All tracks must strictly inherit the album's artwork
    for (const track of album.tracks) {
      expect(track.posterUrl).toBe(album.posterUrl);
    }
  });
});

describe("selectRecentlyAddedGrouped", () => {
  it("groups recently added TV episodes by show with season/episode count badges", () => {
    const items = asMap([
      item({
        id: "ep1",
        libraryType: "tv",
        showId: "show-breaking-bad",
        showTitle: "Breaking Bad",
        season: 1,
        episode: 1,
        addedAt: 100,
        showPosterUrl: "https://example.com/bb.jpg",
      }),
      item({
        id: "ep2",
        libraryType: "tv",
        showId: "show-breaking-bad",
        showTitle: "Breaking Bad",
        season: 1,
        episode: 2,
        addedAt: 200,
        showPosterUrl: "https://example.com/bb.jpg",
      }),
      item({
        id: "ep3",
        libraryType: "tv",
        showId: "show-breaking-bad",
        showTitle: "Breaking Bad",
        season: 1,
        episode: 3,
        addedAt: 300,
        showPosterUrl: "https://example.com/bb.jpg",
      }),
    ]);

    const grouped = selectRecentlyAddedGrouped(items, { id: "lib1", name: "TV", type: "tv", remotePaths: [] });
    expect(grouped).toHaveLength(1);
    const showCard = grouped[0];
    expect(showCard.title).toBe("Breaking Bad");
    expect(showCard.badge).toBe("Season 1 Added");
    expect(showCard.itemCount).toBe(3);
    expect(showCard.groupType).toBe("show");
    expect(showCard.addedAt).toBe(300);
  });

  it("groups recently added music tracks by album with track count badge", () => {
    const items = asMap([
      item({
        id: "m1",
        libraryType: "music",
        artist: "Daft Punk",
        album: "Discovery",
        title: "One More Time",
        addedAt: 100,
        posterUrl: "https://example.com/discovery.jpg",
      }),
      item({
        id: "m2",
        libraryType: "music",
        artist: "Daft Punk",
        album: "Discovery",
        title: "Aerodynamic",
        addedAt: 150,
        posterUrl: "https://example.com/discovery.jpg",
      }),
    ]);

    const grouped = selectRecentlyAddedGrouped(items, { id: "lib1", name: "Music", type: "music", remotePaths: [] });
    expect(grouped).toHaveLength(1);
    const albumCard = grouped[0];
    expect(albumCard.title).toBe("Discovery");
    expect(albumCard.badge).toBe("2 Tracks");
    expect(albumCard.groupType).toBe("album");
    expect(albumCard.posterUrl).toBe("https://example.com/discovery.jpg");
  });

  it("groups multi-file audiobooks into a single book card with chapter count badge", () => {
    const items = asMap([
      item({
        id: "ch1",
        libraryType: "audiobooks",
        title: "Chapter 1",
        album: "Project Hail Mary",
        author: "Andy Weir",
        addedAt: 100,
        posterUrl: "https://example.com/phm.jpg",
      }),
      item({
        id: "ch2",
        libraryType: "audiobooks",
        title: "Chapter 2",
        album: "Project Hail Mary",
        author: "Andy Weir",
        addedAt: 200,
        posterUrl: "https://example.com/phm.jpg",
      }),
    ]);

    const grouped = selectRecentlyAddedGrouped(items, { id: "lib1", name: "Audiobooks", type: "audiobooks", remotePaths: [] });
    expect(grouped).toHaveLength(1);
    const bookCard = grouped[0];
    expect(bookCard.title).toBe("Project Hail Mary");
    expect(bookCard.badge).toBe("2 Chapters");
    expect(bookCard.groupType).toBe("book");
    expect(bookCard.addedAt).toBe(200);
  });
});

describe("Audio Bookmarks Store Actions", () => {
  it("adds, sorts, and removes bookmarks for a media item", () => {
    const store = useAppStore.getState();
    store.addAudioBookmark({
      id: "bm2",
      itemId: "track1",
      timestamp: 120,
      title: "Climax",
      createdAt: Date.now(),
    });
    store.addAudioBookmark({
      id: "bm1",
      itemId: "track1",
      timestamp: 30,
      title: "Intro",
      createdAt: Date.now(),
    });

    const bms = useAppStore.getState().audioBookmarks["track1"];
    expect(bms).toHaveLength(2);
    // Should be sorted ascending by timestamp
    expect(bms[0].id).toBe("bm1");
    expect(bms[1].id).toBe("bm2");

    // Remove one
    useAppStore.getState().removeAudioBookmark("track1", "bm1");
    const updated = useAppStore.getState().audioBookmarks["track1"];
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe("bm2");
  });
});

describe("Watch Progress Completed Toggle Actions", () => {
  it("marks an item completed, creates progress if absent, and toggles unwatched", () => {
    const store = useAppStore.getState();
    const testItem = item({ id: "movie-watch-1", title: "Test Movie", duration: 7200 });
    store.upsertMediaItem(testItem);

    // Initial state: no progress
    expect(store.watchProgress["movie-watch-1"]).toBeUndefined();

    // Toggle watched (should mark completed)
    const nextWatched = store.toggleWatchCompleted("movie-watch-1");
    expect(nextWatched).toBe(true);

    const progress = useAppStore.getState().watchProgress["movie-watch-1"];
    expect(progress).toBeDefined();
    expect(progress.completed).toBe(true);
    expect(progress.position).toBe(7200);

    // Toggle again (should mark unwatched / clear progress)
    const nextUnwatched = useAppStore.getState().toggleWatchCompleted("movie-watch-1");
    expect(nextUnwatched).toBe(false);
    expect(useAppStore.getState().watchProgress["movie-watch-1"]).toBeUndefined();
  });

  it("marks multiple items completed in a batch for seasons and series", () => {
    const store = useAppStore.getState();
    const ep1 = item({ id: "ep-1", title: "S01E01", duration: 1800 });
    const ep2 = item({ id: "ep-2", title: "S01E02", duration: 1800 });
    store.upsertMediaItem(ep1);
    store.upsertMediaItem(ep2);

    store.markMultipleCompleted(["ep-1", "ep-2"], true);
    const p1 = useAppStore.getState().watchProgress["ep-1"];
    const p2 = useAppStore.getState().watchProgress["ep-2"];
    expect(p1?.completed).toBe(true);
    expect(p2?.completed).toBe(true);

    // Batch clear
    store.markMultipleCompleted(["ep-1", "ep-2"], false);
    expect(useAppStore.getState().watchProgress["ep-1"]).toBeUndefined();
    expect(useAppStore.getState().watchProgress["ep-2"]).toBeUndefined();
  });
});

