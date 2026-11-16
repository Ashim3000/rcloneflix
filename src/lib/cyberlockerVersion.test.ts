import { describe, it, expect } from "vitest";
import {
  extractIterationNumber,
  getNextIteratedFilename,
  cleanDisplayTitle,
  sanitizeCyberlockerFilename,
} from "./cyberlockerVersion";

describe("cyberlockerVersion", () => {
  describe("extractIterationNumber", () => {
    it("returns 1 for regular filenames without versions", () => {
      expect(extractIterationNumber("Show.S01E01.mp4")).toBe(1);
      expect(extractIterationNumber("Movie.2024.1080p.mkv")).toBe(1);
    });

    it("extracts _v versions correctly", () => {
      expect(extractIterationNumber("Show.S01E01_v2.mp4")).toBe(2);
      expect(extractIterationNumber("Show.S01E01_v10.mkv")).toBe(10);
    });

    it("extracts _r and _AV versions", () => {
      expect(extractIterationNumber("Show.S01E01_r3.mp4")).toBe(3);
      expect(extractIterationNumber("Show.S01E01_AV1.mp4")).toBe(1);
      expect(extractIterationNumber("Show.S01E01_AV2.mp4")).toBe(2);
    });
  });

  describe("getNextIteratedFilename", () => {
    it("increments a file without version to _v2", () => {
      expect(getNextIteratedFilename("A.Different.World.S01E01.mp4")).toBe(
        "A.Different.World.S01E01_v2.mp4"
      );
    });

    it("increments _v2 to _v3", () => {
      expect(getNextIteratedFilename("A.Different.World.S01E01_v2.mp4")).toBe(
        "A.Different.World.S01E01_v3.mp4"
      );
    });

    it("respects forced iteration", () => {
      expect(getNextIteratedFilename("Movie.mkv", 5)).toBe("Movie_v5.mkv");
    });
  });

  describe("cleanDisplayTitle", () => {
    it("strips _v tags from filename with extension", () => {
      expect(cleanDisplayTitle("Show.S01E01_v2.mp4")).toBe("Show.S01E01.mp4");
      expect(cleanDisplayTitle("Show.S01E01_v3.mkv")).toBe("Show.S01E01.mkv");
    });

    it("strips _v tags from title strings without extensions", () => {
      expect(cleanDisplayTitle("A Different World S01E01_v2")).toBe(
        "A Different World S01E01"
      );
    });

    it("leaves regular names untouched", () => {
      expect(cleanDisplayTitle("The Matrix (1999)")).toBe("The Matrix (1999)");
    });
  });

  describe("sanitizeCyberlockerFilename", () => {
    it("replaces invalid characters and spaces with dots", () => {
      expect(sanitizeCyberlockerFilename("My Movie: Special Edition / Cut")).toBe(
        "My.Movie.Special.Edition.Cut.mp4"
      );
    });
  });
});
