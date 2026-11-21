import { describe, expect, it } from "vitest";
import { mergeMediaItems, type MediaItem } from "../../store/appStore";

describe("mergeMediaItems userTags preservation", () => {
  it("unions userTags and preserves Stash metadata fields across merges", () => {
    const existing: MediaItem = {
      id: "1",
      libraryId: "lib1",
      libraryType: "movies",
      remotePath: "gdrive:Movies/IronMan.mp4",
      filename: "IronMan.mp4",
      title: "Iron Man",
      addedAt: 100,
      lastScannedAt: 100,
      userTags: ["MCU", "Phase1"],
      studio: "Marvel",
      performers: ["RDJ"],
      oshash: "0123456789abcdef",
      phash: "fedcba9876543210",
    };
    const fresh: MediaItem = {
      id: "2",
      libraryId: "lib1",
      libraryType: "movies",
      remotePath: "gdrive:Movies/IronMan.mp4",
      filename: "IronMan.mp4",
      title: "Iron Man",
      addedAt: 200,
      lastScannedAt: 200,
      userTags: ["Favorites"],
    };

    const merged = mergeMediaItems(fresh, existing);
    expect(merged.userTags).toEqual(["Favorites", "MCU", "Phase1"]);
    expect(merged.studio).toBe("Marvel");
    expect(merged.performers).toEqual(["RDJ"]);
    expect(merged.oshash).toBe("0123456789abcdef");
    expect(merged.phash).toBe("fedcba9876543210");
  });
});
