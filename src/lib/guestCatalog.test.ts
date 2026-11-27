import { describe, it, expect } from "vitest";
import {
  stableStringify, sha256Hex, buildGuestCatalogBody, encodeBody, packCatalog, unpackCatalog,
  planCatalogApply, scrubItemForGuest, isUnshareableItem, generateCatalogKey, mergeGuestRecommendations,
} from "./guestCatalog";
import type { MediaItem } from "../store/appStore";

const item = (over: Partial<MediaItem> = {}): MediaItem =>
  ({ id: "a", libraryId: "L1", libraryType: "movies", remotePath: "drivemine:Movies/A.mkv", filename: "A.mkv", title: "A", addedAt: 1, lastScannedAt: 1, ...over } as MediaItem);

describe("guestCatalog", () => {
  it("stableStringify ignores key order and undefined", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe(stableStringify({ a: [2, { c: undefined, d: 1 }], b: 1 }));
  });

  it("builds a scoped body: only shared libs, no local/loopback-only items, no secrets", () => {
    const body = buildGuestCatalogBody({
      passId: "p1",
      libraries: [{ id: "L1", name: "Movies", type: "movies" }],
      mediaItems: {
        a: item(),
        local: item({ id: "local", remotePath: "/home/me/x.mkv" }),
        loop: item({ id: "loop", remotePath: "http://127.0.0.1:8553/dav/x.mkv" }),
        other: item({ id: "other", libraryId: "PRIVATE" }),
        tg: item({ id: "tg", sourceUrl: "https://api.telegram.org/file/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAA/x" }),
      },
      picks: { L1: { items: [{ itemId: "a", title: "A", badgeText: "Pick", badgeEffect: "glow", addedAt: 1 } as any] }, PRIVATE: { items: [{ itemId: "z" } as any] } },
    });
    expect(body.items.map((i) => i.id).sort()).toEqual(["a", "tg"]);
    expect(body.items.find((i) => i.id === "tg")!.sourceUrl).toBeUndefined();
    expect(Object.keys(body.weeklyRecommendations || {})).toEqual(["L1"]);
    expect(JSON.stringify(body)).not.toMatch(/rcloneConfig|tmdbApiKey|thePornDbApiKey/);
  });

  it("keeps Streamtape offloads that have a public shareUrl, drops bridge-only items", () => {
    const st = item({
      remotePath: "streamtape:/Movies/X.mp4",
      versions: [{ id: "v", remoteName: "streamtape", remotePath: "streamtape:/Movies/X.mp4", shareUrl: "https://streamtape.com/v/abc", libraryId: "L1", isLocal: false, priority: 2 } as any],
    });
    expect(isUnshareableItem(st)).toBe(false);
    const bridgeOnly = item({ remotePath: "telegram-drive:/x.mkv" });
    expect(isUnshareableItem(bridgeOnly)).toBe(true);
    const noLink = item({ remotePath: "streamtape:/y.mp4", versions: [{ id: "v2", remoteName: "streamtape", remotePath: "streamtape:/y.mp4", libraryId: "L1", isLocal: false, priority: 2 } as any] });
    expect(isUnshareableItem(noLink)).toBe(true);
  });

  it("keeps items whose only usable path is a version", () => {
    const it2 = item({ remotePath: "/x", versions: [{ id: "v", remoteName: "udrop", remotePath: "udrop:/x.mkv", libraryId: "L1", isLocal: false, priority: 2 } as any] });
    expect(isUnshareableItem(it2)).toBe(false);
    expect(scrubItemForGuest(it2).versions![0].remotePath).toBe("udrop:/x.mkv");
  });

  it("hash is stable and changes with content", async () => {
    const mk = (title: string) => buildGuestCatalogBody({ passId: "p", libraries: [{ id: "L1", name: "M", type: "movies" }], mediaItems: { a: item({ title }) }, picks: {} });
    const h1 = (await encodeBody(mk("A"))).hash;
    expect(h1).toBe((await encodeBody(mk("A"))).hash);
    expect(h1).not.toBe((await encodeBody(mk("B"))).hash);
  });

  it("pack/unpack round-trips and rejects a wrong key", async () => {
    const key = generateCatalogKey();
    const bytes = new TextEncoder().encode(JSON.stringify({ hello: "world".repeat(1000) }));
    const blob = await packCatalog(bytes, key);
    expect(await sha256Hex(await unpackCatalog(blob, key))).toBe(await sha256Hex(bytes));
    await expect(unpackCatalog(blob, generateCatalogKey())).rejects.toBeTruthy();
  });

  describe("planCatalogApply", () => {
    const ex = (id: string, o: Partial<MediaItem> = {}) => item({ id, libraryId: "shared_L1", ...o });

    it("preserves guest userTags + addedAt, counts added/updated/removed, skips unchanged", () => {
      const existing = [ex("s1", { userTags: ["mine"], addedAt: 5, title: "Old" }), ex("s2"), ex("s3")];
      const next = [ex("s1", { title: "New", addedAt: 99 }), ex("s2"), ex("s4")];
      const p = planCatalogApply(existing, next);
      expect(p.added).toBe(1);
      expect(p.updated).toBe(1);
      expect(p.removedIds).toEqual(["s3"]);
      const s1 = p.toUpsert.find((i) => i.id === "s1")!;
      expect(s1.title).toBe("New");
      expect(s1.userTags).toEqual(["mine"]);
      expect(s1.addedAt).toBe(5);
      expect(p.toUpsert.some((i) => i.id === "s2")).toBe(false);
    });

    it("blocks an empty catalog and a >50% shrink unless forced", () => {
      const existing = Array.from({ length: 30 }, (_, i) => ex(`s${i}`));
      expect(planCatalogApply(existing, []).blocked).toBeTruthy();
      expect(planCatalogApply(existing, existing.slice(0, 5)).blocked).toBeTruthy();
      expect(planCatalogApply(existing, existing.slice(0, 5), { force: true }).removedIds).toHaveLength(25);
      expect(planCatalogApply(existing, existing.slice(0, 20)).blocked).toBeUndefined();
    });
  });

  it("mergeGuestRecommendations replaces only this pass's picks", () => {
    const cur = [{ itemId: "shared_a" }, { itemId: "shared_other" }] as any[];
    const out = mergeGuestRecommendations(cur as any, new Set(["shared_a"]), [{ itemId: "shared_a2" } as any]);
    expect(out.map((r) => r.itemId)).toEqual(["shared_other", "shared_a2"]);
  });
});
