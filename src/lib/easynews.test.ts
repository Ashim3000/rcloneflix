import { describe, it, expect } from "vitest";
import { parseSizeToBytes, sanitizeEasynewsQuery, extractFilenameFromSubject } from "./easynews";

describe("Easynews Parser and Filter Helpers", () => {
  describe("parseSizeToBytes", () => {
    it("handles numeric input", () => {
      expect(parseSizeToBytes(3650722201)).toBe(3650722201);
      expect(parseSizeToBytes(0)).toBe(0);
      expect(parseSizeToBytes(-100)).toBe(0);
      expect(parseSizeToBytes(NaN)).toBe(0);
    });

    it("handles numeric strings", () => {
      expect(parseSizeToBytes("3650722201")).toBe(3650722201);
      expect(parseSizeToBytes("3,650,722,201")).toBe(3650722201);
      expect(parseSizeToBytes("0")).toBe(0);
    });

    it("parses gigabyte units properly", () => {
      expect(parseSizeToBytes("3.4 GB")).toBe(3650722202);
      expect(parseSizeToBytes("3.4GB")).toBe(3650722202);
      expect(parseSizeToBytes("1 GB")).toBe(1073741824);
      expect(parseSizeToBytes("20 GB")).toBe(21474836480);
    });

    it("parses megabyte units properly", () => {
      expect(parseSizeToBytes("350 MB")).toBe(367001600);
      expect(parseSizeToBytes("100MB")).toBe(104857600);
    });

    it("parses terabyte, kilobyte, and byte units", () => {
      expect(parseSizeToBytes("1.2 TB")).toBe(1319413953331);
      expect(parseSizeToBytes("500 KB")).toBe(512000);
      expect(parseSizeToBytes("1024 Bytes")).toBe(1024);
    });

    it("handles invalid or non-size strings safely", () => {
      expect(parseSizeToBytes(null)).toBe(0);
      expect(parseSizeToBytes(undefined)).toBe(0);
      expect(parseSizeToBytes("")).toBe(0);
      expect(parseSizeToBytes("mkv")).toBe(0);
      expect(parseSizeToBytes("none")).toBe(0);
    });
  });

  describe("sanitizeEasynewsQuery", () => {
    it("strips quotes and reserved characters", () => {
      expect(sanitizeEasynewsQuery('"Severance" S01')).toBe("Severance S01");
      expect(sanitizeEasynewsQuery("'The Bear'")).toBe("The Bear");
      expect(sanitizeEasynewsQuery("Show: Title (2024)")).toBe("Show Title 2024");
    });

    it("replaces dots and underscores between words/numbers", () => {
      expect(sanitizeEasynewsQuery("Show.S01.E01")).toBe("Show S01 E01");
    });
  });

  describe("extractFilenameFromSubject", () => {
    it("extracts quoted filenames from Usenet posting headers", () => {
      expect(
        extractFilenameFromSubject('[01/45] - "The.Matrix.1999.1080p.BluRay.x264.mkv" yEnc (1/45)')
      ).toBe("The.Matrix.1999.1080p.BluRay.x264.mkv");
    });

    it("extracts filenames with yEnc suffix", () => {
      expect(
        extractFilenameFromSubject("Severance.S01E01.2160p.HDR.mkv yEnc")
      ).toBe("Severance.S01E01.2160p.HDR.mkv");
    });

    it("extracts filenames embedded in subject text", () => {
      expect(
        extractFilenameFromSubject("Posting: AudioTrack.Album.01.flac [1/2]")
      ).toBe("AudioTrack.Album.01.flac");
    });

    it("returns null when no media file is present", () => {
      expect(extractFilenameFromSubject("Just some random discussion post")).toBeNull();
      expect(extractFilenameFromSubject("")).toBeNull();
    });
  });
});
