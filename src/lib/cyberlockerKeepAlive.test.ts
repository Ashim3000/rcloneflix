import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveKeepAliveEmbedUrl,
  getKeepAliveMetrics,
  performSilentKeepAliveVisit,
  runKeepAliveHealthCheck,
} from "./cyberlockerKeepAlive";
import { useAppStore, type MediaItem } from "../store/appStore";

// Mock libraryDb persistItems
const persistItemsMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./libraryDb", () => ({
  persistItems: (...args: any[]) => persistItemsMock(...args),
}));

// Mock log
vi.mock("./log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("cyberlockerKeepAlive", () => {
  describe("resolveKeepAliveEmbedUrl", () => {
    it("resolves Streamtape embed URL from remotePath with filename ID", () => {
      const url = resolveKeepAliveEmbedUrl({
        remoteName: "streamtape",
        remotePath: "streamtape:Movies/687MkmYp3JtzD9e.mp4",
      });
      expect(url).toBe("https://streamtape.com/e/687MkmYp3JtzD9e");
    });

    it("resolves Streamtape embed URL from nested directory remotePath", () => {
      const url = resolveKeepAliveEmbedUrl({
        remoteName: "streamtape",
        remotePath: "streamtape:TV Shows/Severance/Season 1/S01E01_687MkmYp3JtzD9e.mkv",
      });
      expect(url).toBe("https://streamtape.com/e/S01E01_687MkmYp3JtzD9e");
    });

    it("prioritizes explicit streamtape shareUrl if provided", () => {
      const url = resolveKeepAliveEmbedUrl({
        remoteName: "streamtape",
        remotePath: "streamtape:something.mp4",
        shareUrl: "https://streamtape.com/v/customLink123",
      });
      expect(url).toBe("https://streamtape.com/v/customLink123");
    });

    it("resolves Doodstream embed URL from doodstream: prefix", () => {
      const url = resolveKeepAliveEmbedUrl({
        remoteName: "doodstream",
        remotePath: "doodstream:xyz789abc",
      });
      expect(url).toBe("https://dood.to/e/xyz789abc");
    });

    it("returns null for non-cyberlocker remotes (e.g. gdrive, opendrive, dropmb)", () => {
      expect(
        resolveKeepAliveEmbedUrl({
          remoteName: "drivemine",
          remotePath: "drivemine:Movies/Avatar.mkv",
        })
      ).toBeNull();

      expect(
        resolveKeepAliveEmbedUrl({
          remoteName: "dropmb",
          remotePath: "https://dropmb.com/api/shares/123/files/abc",
          sourceType: "streamtape",
        })
      ).toBeNull();
    });
  });

  describe("DOM Keep-Alive Visits & Health Check Simulation", () => {
    let originalDocument: any;

    beforeEach(() => {
      persistItemsMock.mockClear();
      originalDocument = (globalThis as any).document;

      useAppStore.setState({
        mediaItems: {},
        keepAliveConfig: {
          enabled: true,
          checkIntervalHours: 12,
          maxDaysBeforeExpiry: 25,
          maxBatchSize: 5,
          visitDwellMs: 50, // 50ms fast dwell for test
          totalKeptAlive: 0,
        },
      });
    });

    afterEach(() => {
      (globalThis as any).document = originalDocument;
    });

    it("correctly identifies nearing-expiry cyberlocker items", () => {
      const twentySixDaysAgo = Date.now() - 26 * 24 * 60 * 60 * 1000;
      const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;

      const mockOldItem: MediaItem = {
        id: "item-1",
        title: "Old Streamtape Video",
        remotePath: "streamtape:Movies/old12345678.mp4",
        libraryId: "lib-1",
        libraryType: "movies",
        filename: "old12345678.mp4",
        addedAt: twentySixDaysAgo,
        lastScannedAt: twentySixDaysAgo,
        versions: [
          {
            id: "item-1-st",
            remoteName: "streamtape",
            remotePath: "streamtape:Movies/old12345678.mp4",
            libraryId: "lib-1",
            sizeBytes: 1000,
            container: "mp4",
            isLocal: false,
            priority: 2,
            sourceType: "streamtape",
            addedAt: twentySixDaysAgo,
            lastKeepAliveAt: twentySixDaysAgo,
          },
        ],
      };

      const mockRecentItem: MediaItem = {
        id: "item-2",
        title: "Recent Streamtape Video",
        remotePath: "streamtape:Movies/new12345678.mp4",
        libraryId: "lib-1",
        libraryType: "movies",
        filename: "new12345678.mp4",
        addedAt: tenDaysAgo,
        lastScannedAt: tenDaysAgo,
        versions: [
          {
            id: "item-2-st",
            remoteName: "streamtape",
            remotePath: "streamtape:Movies/new12345678.mp4",
            libraryId: "lib-1",
            sizeBytes: 1000,
            container: "mp4",
            isLocal: false,
            priority: 2,
            sourceType: "streamtape",
            addedAt: tenDaysAgo,
            lastKeepAliveAt: tenDaysAgo,
          },
        ],
      };

      useAppStore.setState({
        mediaItems: {
          "item-1": mockOldItem,
          "item-2": mockRecentItem,
        },
      });

      const metrics = getKeepAliveMetrics();
      expect(metrics.totalCyberlockerItems).toBe(2);
      expect(metrics.nearingExpiryCount).toBe(1); // Only item-1 is > 25 days old
    });

    it("performSilentKeepAliveVisit creates sandboxed iframe, awaits dwell, and cleans up DOM", async () => {
      let createdIframe: any = null;
      let removedChild: any = null;

      const mockBody = {
        appendChild: vi.fn((node: any) => {
          createdIframe = node;
          node.parentNode = mockBody;
        }),
        removeChild: vi.fn((node: any) => {
          removedChild = node;
          node.parentNode = null;
        }),
      };

      (globalThis as any).document = {
        body: mockBody,
        createElement: vi.fn(() => ({
          style: {},
          setAttribute: vi.fn(),
          parentNode: null,
        })),
      };

      const visitPromise = performSilentKeepAliveVisit("https://streamtape.com/e/test12345678", 50);
      expect(mockBody.appendChild).toHaveBeenCalled();
      expect(createdIframe.src).toBe("https://streamtape.com/e/test12345678");
      expect(createdIframe.setAttribute).toHaveBeenCalledWith("sandbox", "allow-scripts allow-same-origin");
      expect(createdIframe.setAttribute).toHaveBeenCalledWith("allow", "autoplay 'none'");

      const result = await visitPromise;
      expect(result).toBe(true);
      expect(mockBody.removeChild).toHaveBeenCalledWith(createdIframe);
    });

    it("full health check runs, updates lastKeepAliveAt, persists to DB, and increments totalKeptAlive", async () => {
      const mockBody = {
        appendChild: vi.fn((node: any) => {
          node.parentNode = mockBody;
        }),
        removeChild: vi.fn((node: any) => {
          node.parentNode = null;
        }),
      };

      (globalThis as any).document = {
        body: mockBody,
        createElement: vi.fn(() => ({
          style: {},
          setAttribute: vi.fn(),
          parentNode: null,
        })),
      };

      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const testItem: MediaItem = {
        id: "stream-item-1",
        title: "Test Inactive Stream",
        remotePath: "streamtape:Movies/alive12345678.mp4",
        libraryId: "lib-1",
        libraryType: "movies",
        filename: "alive12345678.mp4",
        addedAt: thirtyDaysAgo,
        lastScannedAt: thirtyDaysAgo,
        versions: [
          {
            id: "ver-1",
            remoteName: "streamtape",
            remotePath: "streamtape:Movies/alive12345678.mp4",
            libraryId: "lib-1",
            sizeBytes: 5000,
            container: "mp4",
            isLocal: false,
            priority: 2,
            sourceType: "streamtape",
            addedAt: thirtyDaysAgo,
            lastKeepAliveAt: thirtyDaysAgo,
          },
        ],
      };

      useAppStore.setState({
        mediaItems: { "stream-item-1": testItem },
        keepAliveConfig: {
          enabled: true,
          checkIntervalHours: 12,
          maxDaysBeforeExpiry: 25,
          maxBatchSize: 5,
          visitDwellMs: 10,
          totalKeptAlive: 4,
        },
      });

      const res = await runKeepAliveHealthCheck({ forceCheck: true });
      expect(res.eligibleTotal).toBe(1);
      expect(res.visitedCount).toBe(1);

      // Verify that store updated
      const updated = useAppStore.getState().mediaItems["stream-item-1"];
      expect(updated.versions![0].lastKeepAliveAt).toBeGreaterThan(thirtyDaysAgo);
      expect(persistItemsMock).toHaveBeenCalledTimes(1);

      const newMetrics = getKeepAliveMetrics();
      expect(newMetrics.totalKeptAlive).toBe(5); // 4 + 1
      expect(newMetrics.nearingExpiryCount).toBe(0); // No longer > 25 days old
    });
  });
});
