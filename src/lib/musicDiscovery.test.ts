import { describe, it, expect } from "vitest";
import { normName, safeSegment, pickSeedArtists, buildGrabTarget, usenetQueryFor } from "./musicDiscovery";
import type { Library } from "../store/appStore";

const lib = (over: Partial<Library> = {}): Library => ({
  id: "m", name: "Music", type: "music", remotePaths: ["odrivecrypt:Music/"], ...over,
});

describe("musicDiscovery", () => {
  it("normalises names", () => {
    expect(normName("Beyoncé – Lemonade!")).toBe("beyoncelemonade");
  });
  it("sanitises path segments", () => {
    expect(safeSegment("a/b:c")).toBe("a_b_c");
    expect(safeSegment("...")).toBe("Unknown");
  });
  it("picks seeds from the biggest artists, skipping Unknown/Various", () => {
    const arts = [
      { name: "Unknown Artist", trackCount: 999 },
      { name: "A", trackCount: 10 }, { name: "B", trackCount: 9 }, { name: "C", trackCount: 8 }, { name: "D", trackCount: 1 },
    ];
    const seeds = pickSeedArtists(arts, 3, () => 0);
    expect(seeds).toHaveLength(3);
    expect(seeds).not.toContain("Unknown Artist");
  });
  it("builds the grab target under the first remote path", () => {
    const t = buildGrabTarget(lib(), "Daft Punk", "Discovery", "One More Time");
    expect(t.remoteDir).toBe("odrivecrypt:Music/Daft Punk/Discovery");
    expect(t.filename).toBe("One More Time.mp3");
  });
  it("refuses shared libraries and shared_ remotes", () => {
    expect(() => buildGrabTarget(lib({ isSharedPass: true }), "a", "b", "c")).toThrow();
    expect(() => buildGrabTarget(lib({ remotePaths: ["shared_abc:Music"] }), "a", "b", "c")).toThrow();
  });
  it("does not mistake a Windows drive letter for a remote", () => {
    const t = buildGrabTarget(lib({ remotePaths: ["D:\\Music"] }), "a", "b", "c");
    expect(t.remoteDir.startsWith("D:\\Music")).toBe(true);
  });
  it("builds a quote-free usenet query", () => {
    expect(usenetQueryFor('Artist: "X"', "Singles")).toBe("Artist X");
    expect(usenetQueryFor("Artist", "Album")).toBe("Artist Album");
  });
});
