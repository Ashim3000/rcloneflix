import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findScenesByFingerprint,
  identifyByHash,
  parseAdultSceneFragment,
  type StashBoxProvider,
} from "../stashBox";

vi.mock("../httpFetch", () => ({
  httpFetch: vi.fn(),
}));

import { httpFetch } from "../httpFetch";

const mockProvider: StashBoxProvider = {
  id: "stashdb",
  name: "StashDB",
  endpoint: "https://stashdb.org/graphql",
  apiKey: "test-stash-key",
  enabled: true,
};

describe("stashBox fingerprint & hash matching", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("omits duration from FingerprintQueryInput and normalizes hash to lowercase", async () => {
    (httpFetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          findScenesBySceneFingerprints: [
            [
              {
                id: "scene-1",
                title: "Test Scene",
                date: "2026-01-15",
                studio: { name: "StudioX" },
                performers: [{ performer: { name: "Performer A" } }],
                tags: [{ name: "Tag1" }],
                images: [{ url: "https://example.com/poster.jpg" }],
              },
            ],
          ],
        },
      }),
    });

    const matches = await findScenesByFingerprint(mockProvider, {
      hash: "  ABCDEF0123456789 ",
      algorithm: "OSHASH",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("scene-1");
    expect(matches[0].source).toBe("stashbox");

    const [, reqInit] = (httpFetch as any).mock.calls[0];
    const parsedBody = JSON.parse(reqInit.body);
    expect(parsedBody.variables.fingerprints).toEqual([
      [{ hash: "abcdef0123456789", algorithm: "OSHASH" }],
    ]);
    expect(parsedBody.variables.fingerprints[0][0]).not.toHaveProperty("duration");
  });

  it("throws when Stash-Box returns GraphQL json.errors on HTTP 200", async () => {
    (httpFetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [{ message: 'Field "duration" is not defined by type "FingerprintQueryInput".' }],
      }),
    });

    await expect(
      findScenesByFingerprint(mockProvider, {
        hash: "abcdef0123456789",
        algorithm: "OSHASH",
      })
    ).rejects.toThrow(/FingerprintQueryInput/);
  });

  it("queries ThePornDB by hash and hashType when no Stash-Box provider is active", async () => {
    (httpFetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: 9988,
            title: "TPDB Matched Scene",
            date: "2025-11-02",
            site: { name: "TPDB Studio" },
            performers: [{ name: "Actor One" }],
            tags: [{ name: "HD" }],
            poster: "https://api.theporndb.net/poster.jpg",
          },
        ],
      }),
    });

    const res = await identifyByHash({
      hash: "1122334455667788",
      algorithm: "OSHASH",
      provider: null,
      thePornDbApiKey: "tpdb-secret-token",
    });

    expect(res.queriedProviders).toEqual(["ThePornDB"]);
    expect(res.errors).toEqual([]);
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]).toMatchObject({
      id: "9988",
      title: "TPDB Matched Scene",
      source: "theporndb",
    });

    const [calledUrl] = (httpFetch as any).mock.calls[0];
    expect(calledUrl).toBe(
      "https://api.theporndb.net/scenes?hash=1122334455667788&hashType=OSHASH"
    );
  });

  it("extracts studio, date, and title in parseAdultSceneFragment", () => {
    const frag = parseAdultSceneFragment("Brazzers.25.10.14.Jane.Doe.1080p.MP4.mp4");
    expect(frag).toEqual({
      studio: "Brazzers",
      date: "2025-10-14",
      performers: [],
      title: "Jane Doe",
    });
  });
});
