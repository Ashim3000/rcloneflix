import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  extractMusicInfo,
  extractBookInfo,
  extractTvInfo,
  fetchCinemetaMovie,
  fetchCinemetaTv,
  fetchMusicMetadata,
  clearMusicAlbumCache,
  musicAlbumCache,
  fetchThePornDbMetadata,
  fetchItunesBookOrAudiobookMetadata,
  fetchOpenLibrary,
  fetchBookOrAudiobookMetadata,
  clearBookAlbumCache,
  buildCanonicalFilename,
} from "./scanner";

const ROOTS = ["odrivecrypt:/Music"];
const BOOK_ROOTS = ["odrivecrypt:/Books", "odrivecrypt:/Audiobooks"];
const TV_ROOTS = ["odrivecrypt:/TV", "odrivecrypt:/TV Shows"];

function parse(path: string) {
  const filename = path.split("/").pop()!;
  return extractMusicInfo(path, filename, ROOTS);
}

function parseBook(path: string) {
  const filename = path.split("/").pop()!;
  return extractBookInfo(path, filename, BOOK_ROOTS);
}

function parseTv(path: string) {
  const filename = path.split("/").pop()!;
  return extractTvInfo(path, filename, TV_ROOTS);
}

describe("extractMusicInfo", () => {
  it("reads artist and album from Artist/Album/Track", () => {
    const r = parse("odrivecrypt:/Music/Prodigy/H_N_I_C_/Trials_of_Love.mp3");
    expect(r.artist).toBe("Prodigy");
    expect(r.album).toBe("H_N_I_C_");
    expect(r.title).toBe("Trials of Love");
  });

  it("uses the deepest folder as the album when nested further", () => {
    const r = parse(
      "odrivecrypt:/Music/D'Angelo/D'Angelo and The Vanguard/Black Messiah (2014)/12 - Another Life.mp3"
    );
    expect(r.artist).toBe("D'Angelo");
    expect(r.album).toBe("Black Messiah");
    expect(r.year).toBe(2014);
    expect(r.trackNumber).toBe(12);
    expect(r.title).toBe("Another Life");
  });

  it("splits a single 'Artist - Album (Year)' folder", () => {
    const r = parse("odrivecrypt:/Music/Gunna - Essentials (2021)/01 - Solid (feat. Drake).mp3");
    expect(r.artist).toBe("Gunna");
    expect(r.album).toBe("Essentials");
    expect(r.year).toBe(2021);
    expect(r.trackNumber).toBe(1);
    expect(r.title).toBe("Solid (feat. Drake)");
  });

  it("skips generic container folders", () => {
    const r = parse("odrivecrypt:/Music/Album/Emily King/The Switch (Deluxe Edition)/03 Sleepwalker.m4a");
    expect(r.artist).toBe("Emily King");
    expect(r.album).toBe("The Switch (Deluxe Edition)");
    expect(r.trackNumber).toBe(3);
    expect(r.title).toBe("Sleepwalker");
  });

  it("strips catalogue ids and repeated artist prefixes", () => {
    const r = parse(
      "odrivecrypt:/Music/Jill Scott/Who Is Jill Scott [36042574] [2000]/19 - Jill Scott - Love Rain.m4a"
    );
    expect(r.artist).toBe("Jill Scott");
    expect(r.album).toBe("Who Is Jill Scott");
    expect(r.year).toBe(2000);
    expect(r.title).toBe("Love Rain");
  });

  it("drops explicit tags from the title", () => {
    const r = parse(
      "odrivecrypt:/Music/That Mexican OT/Texas Technician/12 - Twisting Fingers [Explicit].m4a"
    );
    expect(r.title).toBe("Twisting Fingers");
  });

  it("survives a track sitting directly in the library root", () => {
    const r = parse("odrivecrypt:/Music/loose-track.mp3");
    expect(r.artist).toBeUndefined();
    expect(r.title).toBe("loose-track");
  });

  it("does not mistake a leading year for a track number", () => {
    const r = parse("odrivecrypt:/Music/Artist/Album/Song About 1999.mp3");
    expect(r.trackNumber).toBeUndefined();
    expect(r.title).toBe("Song About 1999");
  });
});

describe("extractBookInfo", () => {
  it("leaves album undefined for a book directly in the library root to prevent root collapsing", () => {
    const r = parseBook("odrivecrypt:/Books/1984.epub");
    expect(r.title).toBe("1984");
    expect(r.album).toBeUndefined();
    expect(r.author).toBeUndefined();
  });

  it("extracts album name for chapter files in a book folder", () => {
    const r = parseBook("odrivecrypt:/Audiobooks/Dune/01 - Chapter 1.mp3");
    expect(r.album).toBe("Dune");
    expect(r.title).toBe("Chapter 1");
    expect(r.author).toBeUndefined();
  });

  it("extracts author, album, and year from nested author/book folders", () => {
    const r = parseBook(
      "odrivecrypt:/Audiobooks/Frank Herbert/Dune (1965)/01 - Chapter 1.mp3"
    );
    expect(r.author).toBe("Frank Herbert");
    expect(r.album).toBe("Dune");
    expect(r.year).toBe(1965);
    expect(r.title).toBe("Chapter 1");
  });

  it("extracts author and album from an 'Author - Title (Year)' folder", () => {
    const r = parseBook(
      "odrivecrypt:/Books/George Orwell - Animal Farm (1945)/Animal Farm.epub"
    );
    expect(r.author).toBe("George Orwell");
    expect(r.album).toBe("Animal Farm");
    expect(r.year).toBe(1945);
    expect(r.title).toBe("Animal Farm");
  });

  it("skips generic container folders for books", () => {
    const r = parseBook(
      "odrivecrypt:/Audiobooks/Audio/J.R.R. Tolkien/The Hobbit/01.m4a"
    );
    expect(r.author).toBe("J.R.R. Tolkien");
    expect(r.album).toBe("The Hobbit");
    expect(r.title).toBe("01");
  });
});

describe("Cinemeta metadata fetching", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches movie metadata from Cinemeta and maps fields", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/catalog/movie/top/search=The%20Matrix.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            metas: [
              {
                id: "tt0133093",
                name: "The Matrix",
                poster: "https://images.metahub.space/poster/small/tt0133093/img",
                releaseInfo: "1999",
              },
            ],
          }),
        } as Response;
      }
      if (url.includes("/meta/movie/tt0133093.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            meta: {
              id: "tt0133093",
              name: "The Matrix",
              year: "1999",
              description: "A computer hacker learns the truth.",
              poster: "https://images.metahub.space/poster/small/tt0133093/img",
              background: "https://images.metahub.space/background/medium/tt0133093/img",
              imdbRating: "8.7",
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const meta = await fetchCinemetaMovie("The Matrix", 1999);
    expect(meta.title).toBe("The Matrix");
    expect(meta.year).toBe(1999);
    expect(meta.rating).toBe(8.7);
    expect(meta.posterUrl).toBe("https://images.metahub.space/poster/small/tt0133093/img");
    expect(meta.backdropUrl).toBe("https://images.metahub.space/background/medium/tt0133093/img");
    expect(meta.metadataSource).toBe("cinemeta");
  });

  it("fetches TV series and episode metadata from Cinemeta", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/catalog/series/top/search=Breaking%20Bad.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            metas: [
              {
                id: "tt0903747",
                name: "Breaking Bad",
                poster: "https://images.metahub.space/poster/series.jpg",
                releaseInfo: "2008-2013",
              },
            ],
          }),
        } as Response;
      }
      if (url.includes("/meta/series/tt0903747.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            meta: {
              id: "tt0903747",
              name: "Breaking Bad",
              description: "A chemistry teacher turns to cooking meth.",
              poster: "https://images.metahub.space/poster/series.jpg",
              background: "https://images.metahub.space/background/series.jpg",
              imdbRating: "9.5",
              videos: [
                {
                  id: "tt0903747:1:1",
                  name: "Pilot",
                  season: 1,
                  episode: 1,
                  thumbnail: "https://episodes.metahub.space/tt0903747/1/1/w780.jpg",
                  overview: "The pilot episode.",
                  rating: "7.7",
                },
              ],
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const meta = await fetchCinemetaTv("Breaking Bad", 1, 1);
    expect(meta.showTitle).toBe("Breaking Bad");
    expect(meta.episodeTitle).toBe("Pilot");
    expect(meta.posterUrl).toBe("https://images.metahub.space/poster/series.jpg");
    expect(meta.thumbUrl).toBe("https://episodes.metahub.space/tt0903747/1/1/w780.jpg");
    expect(meta.showPosterUrl).toBe("https://images.metahub.space/poster/series.jpg");
    expect(meta.rating).toBe(7.7);
    expect(meta.metadataSource).toBe("cinemeta");
  });
});

describe("Music metadata fetching", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearMusicAlbumCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearMusicAlbumCache();
  });

  it("fetches album metadata from iTunes and scales artwork to 600x600", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("itunes.apple.com") && url.includes("entity=album")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            resultCount: 1,
            results: [
              {
                wrapperType: "collection",
                collectionType: "Album",
                collectionId: 1097861387,
                artistName: "Radiohead",
                collectionName: "OK Computer",
                artworkUrl100:
                  "https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/07/60/ba/0760ba0f/634904078164.png/100x100bb.jpg",
                releaseDate: "1997-05-21T07:00:00Z",
                primaryGenreName: "Alternative",
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const meta = await fetchMusicMetadata("Radiohead", "OK Computer", "Airbag");
    expect(meta.artist).toBe("Radiohead");
    expect(meta.album).toBe("OK Computer");
    expect(meta.year).toBe(1997);
    expect(meta.posterUrl).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/07/60/ba/0760ba0f/634904078164.png/600x600bb.jpg"
    );
    expect(meta.genres).toEqual(["Alternative"]);
    expect(meta.metadataSource).toBe("itunes");
    expect(meta.metadataConfidence).toBe("high");
  });

  it("reuses album cache for subsequent tracks without network requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          resultCount: 1,
          results: [
            {
              collectionId: 1097861387,
              artistName: "Radiohead",
              collectionName: "OK Computer",
              artworkUrl100: "https://is1-ssl.mzstatic.com/thumb/100x100bb.jpg",
              releaseDate: "1997-05-21",
            },
          ],
        }),
      } as Response;
    });
    globalThis.fetch = fetchMock;

    // First track calls network and caches
    const track1 = await fetchMusicMetadata("Radiohead", "OK Computer", "Airbag");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(track1.posterUrl).toBe("https://is1-ssl.mzstatic.com/thumb/600x600bb.jpg");

    // Second track retrieves from cache with 0 additional network calls
    const track2 = await fetchMusicMetadata("Radiohead", "OK Computer", "Paranoid Android");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(track2.posterUrl).toBe("https://is1-ssl.mzstatic.com/thumb/600x600bb.jpg");
    expect(track2.album).toBe("OK Computer");
  });

  it("falls back to Deezer when iTunes returns empty", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("itunes.apple.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ resultCount: 0, results: [] }),
        } as Response;
      }
      if (url.includes("api.deezer.com/search/album")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 14879699,
                title: "OK Computer",
                cover_xl: "https://cdn-images.dzcdn.net/images/cover/1000x1000.jpg",
                artist: { name: "Radiohead" },
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const meta = await fetchMusicMetadata("Radiohead", "OK Computer", "Karma Police");
    expect(meta.metadataSource).toBe("deezer");
    expect(meta.posterUrl).toBe("https://cdn-images.dzcdn.net/images/cover/1000x1000.jpg");
    expect(meta.album).toBe("OK Computer");
  });
});

describe("extractTvInfo", () => {
  it("extracts show title, season, and episode from Show/Season/S01E01", () => {
    const r = parseTv("odrivecrypt:/TV/Breaking Bad/Season 1/S01E01.mkv");
    expect(r.showTitle).toBe("Breaking Bad");
    expect(r.season).toBe(1);
    expect(r.episode).toBe(1);
  });

  it("extracts year from show folder and episode number from flat 01.mkv", () => {
    const r = parseTv("odrivecrypt:/TV Shows/Severance (2022)/Season 01/01.mkv");
    expect(r.showTitle).toBe("Severance");
    expect(r.year).toBe(2022);
    expect(r.season).toBe(1);
    expect(r.episode).toBe(1);
  });

  it("extracts specials folder as season 0", () => {
    const r = parseTv("odrivecrypt:/TV/Doctor Who/Specials/S00E01.mp4");
    expect(r.showTitle).toBe("Doctor Who");
    expect(r.season).toBe(0);
    expect(r.episode).toBe(1);
  });

  it("extracts clean episode title when provided in filename", () => {
    const r = parseTv("odrivecrypt:/TV/The Office/Season 2/The.Office.S02E01.The.Dundies.mkv");
    expect(r.showTitle).toBe("The Office");
    expect(r.season).toBe(2);
    expect(r.episode).toBe(1);
    expect(r.cleanTitle).toBe("The Dundies");
  });

  it("handles alt 1x02 episode format", () => {
    const r = parseTv("odrivecrypt:/TV/Lost/Season 1/1x02 - Tabula Rasa.avi");
    expect(r.showTitle).toBe("Lost");
    expect(r.season).toBe(1);
    expect(r.episode).toBe(2);
    expect(r.cleanTitle).toBe("Tabula Rasa");
  });
});

describe("ThePornDB metadata fetching", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns empty object if no api key provided", async () => {
    const meta = await fetchThePornDbMetadata("Some Title", "Some Title.mp4", "");
    expect(meta).toEqual({});
  });

  it("fetches scene metadata with correct Authorization header and maps fields", async () => {
    let capturedUrl = "";
    let capturedAuth = "";

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "scene-123",
              title: "Bentley's West Quest",
              date: "2026-09-10",
              duration: 1500,
              description: "A great scene.",
              poster: "https://thumb.theporndb.net/poster.webp",
              posters: {
                large: "https://thumb.theporndb.net/poster-large.webp",
              },
              background: {
                large: "https://cdn.theporndb.net/bg-large.jpg",
              },
              tags: [{ name: "Adventure" }, { name: "Action" }],
            },
          ],
        }),
      } as Response;
    });

    const meta = await fetchThePornDbMetadata("Bentley's West Quest", "Bentley.West.Quest.mp4", "test-token");
    expect(capturedUrl).toBe("https://api.theporndb.net/scenes?q=Bentley's%20West%20Quest");
    expect(capturedAuth).toBe("Bearer test-token");
    expect(meta.title).toBe("Bentley's West Quest");
    expect(meta.posterUrl).toBe("https://thumb.theporndb.net/poster.webp");
    expect(meta.backdropUrl).toBe("https://cdn.theporndb.net/bg-large.jpg");
    expect(meta.year).toBe(2026);
    expect(meta.duration).toBe(1500);
    expect(meta.genres).toEqual(["Adventure", "Action"]);
    expect(meta.metadataId).toBe("scene-123");
    expect(meta.metadataSource).toBe("theporndb");
    expect(meta.metadataConfidence).toBe("high");
  });

  it("falls back to filename stem when title search returns no matches", async () => {
    const urlsCalled: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      urlsCalled.push(url);
      if (url.includes("q=Parsed%20Title")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        } as Response;
      }
      if (url.includes("q=Raw.Filename.With.Studio")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: "scene-456",
                title: "Matching Scene",
                poster: "https://thumb.theporndb.net/scene-456.jpg",
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const meta = await fetchThePornDbMetadata("Parsed Title", "Raw.Filename.With.Studio.mp4", "test-token");
    expect(urlsCalled.length).toBe(2);
    expect(meta.title).toBe("Matching Scene");
    expect(meta.metadataId).toBe("scene-456");
  });
});

describe("Book and Audiobook metadata fetching", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearBookAlbumCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearBookAlbumCache();
  });

  it("fetches audiobook metadata from iTunes and scales artwork to 600x600", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("itunes.apple.com") && url.includes("media=audiobook")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            resultCount: 1,
            results: [
              {
                collectionId: 987654321,
                collectionName: "Dune",
                artistName: "Frank Herbert",
                artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg",
                releaseDate: "2007-05-29T07:00:00Z",
                primaryGenreName: "Sci-Fi & Fantasy",
                description: "Set on the desert planet Arrakis, <i>Dune</i> is an epic.",
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const meta = await fetchItunesBookOrAudiobookMetadata("Dune", "Frank Herbert", "audiobooks");
    expect(meta.title).toBe("Dune");
    expect(meta.author).toBe("Frank Herbert");
    expect(meta.album).toBe("Dune");
    expect(meta.year).toBe(2007);
    expect(meta.posterUrl).toBe("https://is1-ssl.mzstatic.com/image/thumb/Music/600x600bb.jpg");
    expect(meta.genres).toEqual(["Sci-Fi & Fantasy"]);
    expect(meta.overview).toBe("Set on the desert planet Arrakis, Dune is an epic.");
    expect(meta.metadataSource).toBe("itunes");
    expect(meta.metadataConfidence).toBe("high");
  });

  it("fetches eBook metadata from iTunes using media=ebook", async () => {
    let requestedUrl = "";
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      requestedUrl = url;
      if (url.includes("media=ebook") && url.includes("entity=ebook")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            resultCount: 1,
            results: [
              {
                trackId: 123456,
                trackName: "Atomic Habits",
                artistName: "James Clear",
                artworkUrl100: "https://is1-ssl.mzstatic.com/thumb/100x100bb.jpg",
                releaseDate: "2018-10-16T07:00:00Z",
                genres: ["Self-Improvement", "Business"],
                description: "An easy and proven way to build good habits.",
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const meta = await fetchItunesBookOrAudiobookMetadata("Atomic Habits", "James Clear", "books");
    expect(requestedUrl).toContain("media=ebook");
    expect(requestedUrl).toContain("entity=ebook");
    expect(meta.title).toBe("Atomic Habits");
    expect(meta.author).toBe("James Clear");
    expect(meta.year).toBe(2018);
    expect(meta.genres).toEqual(["Self-Improvement", "Business"]);
    expect(meta.posterUrl).toBe("https://is1-ssl.mzstatic.com/thumb/600x600bb.jpg");
  });

  it("fetches book metadata from OpenLibrary with fields optimization and mapped cover", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      if (url.includes("openlibrary.org/search.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            docs: [
              {
                key: "/works/OL893414W",
                title: "Dune",
                author_name: ["Frank Herbert"],
                first_publish_year: 1965,
                cover_i: 11481354,
                subject: ["Science fiction", "Fiction", "Arrakis"],
                first_sentence: ["A Beginning is the time for taking the most delicate care."],
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const meta = await fetchOpenLibrary("Dune", "Frank Herbert");
    expect(capturedUrl).toContain("fields=key,title,author_name,first_publish_year,subject,cover_i,first_sentence");
    expect(meta.title).toBe("Dune");
    expect(meta.author).toBe("Frank Herbert");
    expect(meta.year).toBe(1965);
    expect(meta.posterUrl).toBe("https://covers.openlibrary.org/b/id/11481354-L.jpg");
    expect(meta.overview).toBe("A Beginning is the time for taking the most delicate care.");
    expect(meta.genres).toEqual(["Science fiction", "Arrakis"]);
    expect(meta.metadataSource).toBe("openlibrary");
  });

  it("caches audiobook metadata in bookAlbumCache and reuses for subsequent chapters", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("itunes.apple.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            resultCount: 1,
            results: [
              {
                collectionId: 987654321,
                collectionName: "The Way of Kings",
                artistName: "Brandon Sanderson",
                artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/100x100bb.jpg",
                releaseDate: "2010-08-31",
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });
    globalThis.fetch = fetchMock;

    // First chapter queries iTunes
    const ch1 = await fetchBookOrAudiobookMetadata("The Way of Kings", "Brandon Sanderson", "audiobooks");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ch1.title).toBe("The Way of Kings");
    expect(ch1.posterUrl).toBe("https://is1-ssl.mzstatic.com/image/thumb/600x600bb.jpg");

    // Second chapter hits cache with 0 extra network calls
    const ch2 = await fetchBookOrAudiobookMetadata("The Way of Kings", "Brandon Sanderson", "audiobooks");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ch2.title).toBe("The Way of Kings");
    expect(ch2.posterUrl).toBe("https://is1-ssl.mzstatic.com/image/thumb/600x600bb.jpg");
  });

  it("extracts anime absolute episode numbers accurately", () => {
    const res = extractTvInfo("odrivecrypt:/TV/Frieren/[Sub] Frieren - 05 [1080p].mkv", "[Sub] Frieren - 05 [1080p].mkv", TV_ROOTS);
    expect(res.episode).toBe(5);
    expect(res.season).toBe(1);

    const res2 = extractTvInfo("odrivecrypt:/TV/One Piece/One Piece - 1050v2.mkv", "One Piece - 1050v2.mkv", TV_ROOTS);
    expect(res2.episode).toBe(1050);
  });

  it("extracts artist and title from flat dashed music tracks", () => {
    const res = extractMusicInfo("odrivecrypt:/Music/Daft Punk - One More Time.mp3", "Daft Punk - One More Time.mp3", ROOTS);
    expect(res.artist).toBe("Daft Punk");
    expect(res.title).toBe("One More Time");
  });

  it("builds safe canonical filenames bounded to 180 characters", () => {
    const movieItem: any = {
      mediaType: "movie",
      title: "Inception: The Dream",
      year: 2010,
      filename: "Inception.2010.1080p.mkv",
    };
    expect(buildCanonicalFilename(movieItem)).toBe("Inception The Dream (2010).mkv");

    const tvItem: any = {
      mediaType: "tv",
      title: "Pilot",
      showTitle: "Breaking Bad",
      season: 1,
      episode: 1,
      cleanTitle: "Pilot",
      filename: "BB_S01E01.mp4",
    };
    expect(buildCanonicalFilename(tvItem)).toBe("Breaking Bad - S01E01 - Pilot.mp4");

    const musicItem: any = {
      mediaType: "music",
      title: "Song <One>",
      artist: "Band/Name",
      trackNumber: 3,
      filename: "track.flac",
    };
    expect(buildCanonicalFilename(musicItem)).toBe("03 - BandName - Song One.flac");

    const longItem: any = {
      mediaType: "movie",
      title: "A".repeat(250),
      filename: "movie.mp4",
    };
    const fn = buildCanonicalFilename(longItem);
    expect(fn.length).toBeLessThanOrEqual(180);
    expect(fn.endsWith(".mp4")).toBe(true);
  });
});



