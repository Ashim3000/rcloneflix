import { invoke } from "@tauri-apps/api/core";
import type { MediaItem, Library } from "../store/appStore";
import { getDownloadedFilePath } from "./downloadManager";

/**
 * Normalizes title string for robust cross-format matching between Ebooks and Audiobooks.
 * Removes common metadata tokens, brackets, subtitle markers, and punctuation.
 */
export function normalizeBookTitle(title: string): string {
  if (!title) return "";
  let clean = title.toLowerCase();

  // Strip file extensions if present in title
  clean = clean.replace(/\.(epub|pdf|mobi|m4b|mp3|m4a|aac|flac|opus)$/i, "");

  // Strip common audiobook and release markers
  clean = clean.replace(/\[(?:unabridged|abridged|audiobook|ebook|retail|digital)\]/gi, "");
  clean = clean.replace(/\((?:unabridged|abridged|audiobook|ebook|retail|digital)\)/gi, "");
  clean = clean.replace(/\b(unabridged|audiobook|audible)\b/gi, "");

  // Strip volume/part indicators for core matching
  clean = clean.replace(/book\s*\d+/gi, "");
  clean = clean.replace(/part\s*\d+/gi, "");
  clean = clean.replace(/volume\s*\d+/gi, "");
  clean = clean.replace(/vol\.?\s*\d+/gi, "");

  // Remove punctuation and multiple spaces
  clean = clean.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  return clean;
}

export function normalizeAuthor(author?: string): string {
  if (!author) return "";
  return author
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Calculates similarity between two book titles (0.0 to 1.0)
 */
export function calculateTitleSimilarity(titleA: string, titleB: string): number {
  const normA = normalizeBookTitle(titleA);
  const normB = normalizeBookTitle(titleB);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1.0;
  if (normA.includes(normB) || normB.includes(normA)) {
    const longer = Math.max(normA.length, normB.length);
    const shorter = Math.min(normA.length, normB.length);
    return shorter / longer;
  }

  // Token overlap (Jaccard similarity)
  const wordsA = new Set(normA.split(" ").filter((w) => w.length > 2));
  const wordsB = new Set(normB.split(" ").filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Checks if an item is an audiobook based on libraryType, filename extension, or mediaType.
 */
export function isAudiobookItem(item: MediaItem): boolean {
  if (item.libraryType === "audiobooks") return true;
  if (item.groupType === "book" && item.libraryType === "music") return true;
  const fn = item.filename.toLowerCase();
  return fn.endsWith(".m4b") || fn.endsWith(".aax") || (item.libraryType === "music" && Boolean(item.author));
}

/**
 * Checks if an item is an ebook (EPUB/PDF/MOBI).
 */
export function isEbookItem(item: MediaItem): boolean {
  if (item.libraryType === "books") return true;
  const fn = item.filename.toLowerCase();
  return fn.endsWith(".epub") || fn.endsWith(".pdf") || fn.endsWith(".mobi");
}

/**
 * Finds a matching audiobook in the library for a given ebook item.
 */
export function findMatchingAudiobook(
  ebook: MediaItem,
  allItems: MediaItem[],
  manualPairs?: Record<string, string>
): MediaItem | undefined {
  if (!ebook) return undefined;

  // 1. Manual user override
  if (manualPairs && manualPairs[ebook.id]) {
    const pairId = manualPairs[ebook.id];
    const match = allItems.find((i) => i.id === pairId);
    if (match) return match;
  }

  const normEbookTitle = normalizeBookTitle(ebook.title);
  const normEbookAuthor = normalizeAuthor(ebook.author);

  let bestMatch: MediaItem | undefined;
  let highestScore = 0.55; // Threshold for confident pairing

  for (const item of allItems) {
    if (item.id === ebook.id) continue;
    if (!isAudiobookItem(item)) continue;

    const score = calculateTitleSimilarity(ebook.title, item.title);
    let authorBonus = 0;

    if (normEbookAuthor && item.author) {
      const normAudioAuthor = normalizeAuthor(item.author);
      if (normEbookAuthor === normAudioAuthor || normAudioAuthor.includes(normEbookAuthor) || normEbookAuthor.includes(normAudioAuthor)) {
        authorBonus = 0.3;
      }
    }

    const totalScore = score + authorBonus;
    if (totalScore > highestScore) {
      highestScore = totalScore;
      bestMatch = item;
    }
  }

  return bestMatch;
}

/**
 * Finds a matching ebook in the library for a given audiobook item.
 */
export function findMatchingEbook(
  audiobook: MediaItem,
  allItems: MediaItem[],
  manualPairs?: Record<string, string>
): MediaItem | undefined {
  if (!audiobook) return undefined;

  // 1. Manual user override
  if (manualPairs) {
    // Check direct pairing or reverse pairing
    const directTarget = manualPairs[audiobook.id];
    if (directTarget) {
      const match = allItems.find((i) => i.id === directTarget);
      if (match) return match;
    }
    const reverseKey = Object.keys(manualPairs).find((k) => manualPairs[k] === audiobook.id);
    if (reverseKey) {
      const match = allItems.find((i) => i.id === reverseKey);
      if (match) return match;
    }
  }

  const normAudioTitle = normalizeBookTitle(audiobook.title);
  const normAudioAuthor = normalizeAuthor(audiobook.author);

  let bestMatch: MediaItem | undefined;
  let highestScore = 0.55;

  for (const item of allItems) {
    if (item.id === audiobook.id) continue;
    if (!isEbookItem(item)) continue;

    const score = calculateTitleSimilarity(audiobook.title, item.title);
    let authorBonus = 0;

    if (normAudioAuthor && item.author) {
      const normEbookAuthor = normalizeAuthor(item.author);
      if (normAudioAuthor === normEbookAuthor || normAudioAuthor.includes(normEbookAuthor) || normEbookAuthor.includes(normAudioAuthor)) {
        authorBonus = 0.3;
      }
    }

    const totalScore = score + authorBonus;
    if (totalScore > highestScore) {
      highestScore = totalScore;
      bestMatch = item;
    }
  }

  return bestMatch;
}

/**
 * Converts a reading progress percentage (0.0 to 1.0) to audio playback timestamp in seconds.
 */
export function percentToAudioSeconds(percent: number, durationSec: number): number {
  if (!durationSec || durationSec <= 0) return 0;
  const clamped = Math.max(0, Math.min(1, percent));
  return Math.round(clamped * durationSec);
}

/**
 * Converts audio playback position in seconds to a progress percentage (0.0 to 1.0).
 */
export function audioSecondsToPercent(currentSec: number, durationSec: number): number {
  if (!durationSec || durationSec <= 0) return 0;
  return Math.max(0, Math.min(1, currentSec / durationSec));
}

/**
 * Resolves the streaming HTTP URL for an audiobook MediaItem.
 * Checks local downloaded cache first, then active local FUSE mount, then rclone serve.
 */
export async function resolveAudiobookStreamUrl(
  item: MediaItem,
  rcloneConfigPath: string,
  libraries: Library[]
): Promise<string> {
  // 1. Downloaded file on disk
  const local = await getDownloadedFilePath(item);
  if (local) {
    const res = await invoke<{ file_url: string }>("start_local_file_stream", {
      filePath: local,
    });
    return res.file_url;
  }

  // 2. Local FUSE mount or Remote rclone HTTP stream
  const parentLib = libraries.find((l) => l.id === item.libraryId);
  const matchingRoot =
    parentLib?.remotePaths.find((p) => {
      const r = p.replace(/\/+$/, "");
      return item.remotePath.startsWith(r + "/") || (r.endsWith(":") && item.remotePath.startsWith(r));
    }) ?? parentLib?.remotePaths[0] ?? "";

  const rootTrimmed = matchingRoot.replace(/\/+$/, "");
  let relPath: string;
  if (item.remotePath.startsWith(rootTrimmed + "/")) {
    relPath = item.remotePath.slice(rootTrimmed.length + 1);
  } else if (rootTrimmed.endsWith(":") && item.remotePath.startsWith(rootTrimmed)) {
    relPath = item.remotePath.slice(rootTrimmed.length).replace(/^\/+/, "");
  } else {
    relPath = item.remotePath.split("/").pop() ?? item.filename;
  }

  const res = await invoke<{ file_url: string }>("start_stream_session", {
    configPath: rcloneConfigPath,
    remoteRoot: matchingRoot,
    filePath: relPath,
    sessionId: `whispersync-${item.id}`,
  });

  return res.file_url;
}

const LOCATION_CACHE_PREFIX = "rcloneflix_epub_locations_";

/**
 * Retrieves serialized EPUB locations from local cache for instant CFI <-> percentage translation.
 */
export function getCachedBookLocations(bookId: string): string | null {
  try {
    return localStorage.getItem(`${LOCATION_CACHE_PREFIX}${bookId}`);
  } catch {
    return null;
  }
}

/**
 * Saves serialized EPUB locations to local cache.
 */
export function saveCachedBookLocations(bookId: string, locationsJson: string): void {
  try {
    localStorage.setItem(`${LOCATION_CACHE_PREFIX}${bookId}`, locationsJson);
  } catch (e) {
    console.warn("Failed caching EPUB locations to localStorage:", e);
  }
}

// ─── Structural Chapter Alignment System ─────────────────────────────────────

export type AudioChapter = {
  id: number;
  start: number;
  end: number;
  title: string;
};

export type EpubChapterInfo = {
  id?: string;
  title: string;
  href: string;
  cfi?: string;
  percentage?: number;
};

export type AlignedChapter = {
  id: number;
  title: string;
  audioStartSec: number;
  audioEndSec: number;
  epubCfi?: string;
  epubPercentage: number;
  epubNextPercentage?: number;
};

export type WhispersyncAlignment = {
  ebookId: string;
  audiobookId: string;
  alignedAt: number;
  chapters: AlignedChapter[];
};

const ROMAN_TO_NUM: Record<string, string> = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
  ix: "9",
  x: "10",
  xi: "11",
  xii: "12",
  xiii: "13",
  xiv: "14",
  xv: "15",
  xvi: "16",
  xvii: "17",
  xviii: "18",
  xix: "19",
  xx: "20",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

/**
 * Normalizes chapter titles for structural matching across EPUB TOC and Audiobook markers.
 * Standardizes Roman numerals, number words, and punctuation.
 */
export function normalizeChapterTitle(title: string): string {
  if (!title) return "";
  let t = title.toLowerCase();
  // Strip HTML entities like &apos;
  t = t.replace(/&[a-z0-9#]+;/gi, " ");
  // Remove punctuation
  t = t.replace(/[\.:,\-\(\)\[\]"'`~_]/g, " ");
  const tokens = t.split(/\s+/).filter(Boolean);
  const converted = tokens.map((w) => ROMAN_TO_NUM[w] || w);
  return converted.join(" ").trim();
}

/**
 * Extracts chapter / part number from a title if present (e.g. "Chapter 3", "Part II", "04.").
 */
export function extractChapterNumber(title: string): number | null {
  if (!title) return null;
  const norm = normalizeChapterTitle(title);
  const match = norm.match(/\b(?:chapter|part|ch|act|book|section)\s*(\d+)\b/);
  if (match) return parseInt(match[1], 10);
  const leading = norm.match(/^(\d+)\b/);
  if (leading) return parseInt(leading[1], 10);
  return null;
}

const ALIGNMENT_CACHE_PREFIX = "rcloneflix_whispersync_align_";

export function getCachedAlignment(ebookId: string, audiobookId: string): WhispersyncAlignment | null {
  try {
    const raw = localStorage.getItem(`${ALIGNMENT_CACHE_PREFIX}${ebookId}_${audiobookId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveCachedAlignment(
  ebookId: string,
  audiobookId: string,
  alignment: WhispersyncAlignment
): void {
  try {
    localStorage.setItem(
      `${ALIGNMENT_CACHE_PREFIX}${ebookId}_${audiobookId}`,
      JSON.stringify(alignment)
    );
  } catch (e) {
    console.warn("Failed saving cached alignment:", e);
  }
}

/**
 * Builds an alignment matrix between Audiobook chapters (ffprobe) and EPUB TOC chapters.
 */
export function buildChapterAlignment(
  ebookId: string,
  audiobookId: string,
  audioChapters: AudioChapter[],
  epubChapters: EpubChapterInfo[],
  totalAudioDuration: number
): WhispersyncAlignment {
  const aligned: AlignedChapter[] = [];

  // Case 1: Both Audiobook chapters and EPUB TOC chapters are available
  if (audioChapters.length > 0 && epubChapters.length > 0) {
    // Attempt title & number matching
    let lastEpubIdx = -1;

    for (let i = 0; i < audioChapters.length; i++) {
      const ach = audioChapters[i];
      const aNorm = normalizeChapterTitle(ach.title);
      const aNum = extractChapterNumber(ach.title);

      // Search matching EPUB chapter, prioritizing chapters after last matched index
      let bestEpubIdx = -1;
      let bestScore = 0.5;

      for (let j = 0; j < epubChapters.length; j++) {
        const ech = epubChapters[j];
        const eNorm = normalizeChapterTitle(ech.title);
        const eNum = extractChapterNumber(ech.title);

        // Exact match
        if (aNorm && eNorm && aNorm === eNorm) {
          bestEpubIdx = j;
          bestScore = 1.0;
          break;
        }

        // Chapter number match
        if (aNum !== null && eNum !== null && aNum === eNum) {
          bestEpubIdx = j;
          bestScore = 0.95;
          break;
        }

        // Substring match
        if (aNorm && eNorm && (aNorm.includes(eNorm) || eNorm.includes(aNorm))) {
          bestEpubIdx = j;
          bestScore = 0.8;
          break;
        }

        // Fuzzy similarity
        const sim = calculateTitleSimilarity(ach.title, ech.title);
        if (sim > bestScore) {
          bestScore = sim;
          bestEpubIdx = j;
        }
      }

      // If no fuzzy match, but chapter counts closely correspond, match sequentially
      if (bestEpubIdx === -1 && audioChapters.length === epubChapters.length) {
        bestEpubIdx = i;
      } else if (bestEpubIdx === -1 && lastEpubIdx + 1 < epubChapters.length) {
        bestEpubIdx = lastEpubIdx + 1;
      }

      if (bestEpubIdx !== -1) {
        lastEpubIdx = bestEpubIdx;
        const matchedEpub = epubChapters[bestEpubIdx];
        const epubPct = matchedEpub.percentage ?? (bestEpubIdx / epubChapters.length);

        aligned.push({
          id: i,
          title: ach.title || matchedEpub.title || `Chapter ${i + 1}`,
          audioStartSec: Math.round(ach.start),
          audioEndSec: Math.round(ach.end > ach.start ? ach.end : totalAudioDuration),
          epubCfi: matchedEpub.cfi,
          epubPercentage: epubPct,
        });
      }
    }
  }

  // Case 2: Only EPUB TOC exists (Audiobook has no embedded chapters)
  if (aligned.length === 0 && epubChapters.length > 0 && totalAudioDuration > 0) {
    for (let j = 0; j < epubChapters.length; j++) {
      const ech = epubChapters[j];
      const startPct = ech.percentage ?? (j / epubChapters.length);
      const nextPct =
        j + 1 < epubChapters.length
          ? (epubChapters[j + 1].percentage ?? ((j + 1) / epubChapters.length))
          : 1.0;

      aligned.push({
        id: j,
        title: ech.title || `Chapter ${j + 1}`,
        audioStartSec: Math.round(startPct * totalAudioDuration),
        audioEndSec: Math.round(nextPct * totalAudioDuration),
        epubCfi: ech.cfi,
        epubPercentage: startPct,
        epubNextPercentage: nextPct,
      });
    }
  }

  // Case 3: Only Audiobook chapters exist (EPUB has no TOC)
  if (aligned.length === 0 && audioChapters.length > 0 && totalAudioDuration > 0) {
    for (let i = 0; i < audioChapters.length; i++) {
      const ach = audioChapters[i];
      const startPct = totalAudioDuration > 0 ? ach.start / totalAudioDuration : i / audioChapters.length;
      const endPct =
        totalAudioDuration > 0
          ? (ach.end > ach.start ? ach.end / totalAudioDuration : (i + 1) / audioChapters.length)
          : (i + 1) / audioChapters.length;

      aligned.push({
        id: i,
        title: ach.title || `Chapter ${i + 1}`,
        audioStartSec: Math.round(ach.start),
        audioEndSec: Math.round(ach.end > ach.start ? ach.end : totalAudioDuration),
        epubPercentage: Math.max(0, Math.min(1, startPct)),
        epubNextPercentage: Math.max(0, Math.min(1, endPct)),
      });
    }
  }

  // Finalize next percentage boundaries
  for (let k = 0; k < aligned.length; k++) {
    if (!aligned[k].epubNextPercentage) {
      if (k + 1 < aligned.length) {
        aligned[k].epubNextPercentage = aligned[k + 1].epubPercentage;
      } else {
        aligned[k].epubNextPercentage = 1.0;
      }
    }
  }

  const result: WhispersyncAlignment = {
    ebookId,
    audiobookId,
    alignedAt: Date.now(),
    chapters: aligned,
  };

  saveCachedAlignment(ebookId, audiobookId, result);
  return result;
}

/**
 * Calculates exact EPUB target percentage and CFI from current audiobook playback time.
 */
export function syncAudioTimeToEpub(
  audioSec: number,
  alignment: WhispersyncAlignment
): { targetPercentage: number; targetCfi?: string; activeChapter: AlignedChapter } | null {
  if (!alignment.chapters || alignment.chapters.length === 0) return null;

  let activeChapter = alignment.chapters.find(
    (ch) => audioSec >= ch.audioStartSec && audioSec < ch.audioEndSec
  );

  if (!activeChapter) {
    if (audioSec <= alignment.chapters[0].audioStartSec) {
      activeChapter = alignment.chapters[0];
    } else {
      activeChapter = alignment.chapters[alignment.chapters.length - 1];
    }
  }

  const chapterDur = Math.max(1, activeChapter.audioEndSec - activeChapter.audioStartSec);
  const frac = Math.max(0, Math.min(1, (audioSec - activeChapter.audioStartSec) / chapterDur));

  const epubStart = activeChapter.epubPercentage;
  const epubEnd = activeChapter.epubNextPercentage ?? 1.0;
  const targetPercentage = epubStart + frac * (epubEnd - epubStart);

  return {
    targetPercentage: Math.max(0, Math.min(1, targetPercentage)),
    targetCfi: frac === 0 ? activeChapter.epubCfi : undefined,
    activeChapter,
  };
}

/**
 * Calculates exact audiobook timestamp from current reader page percentage.
 */
export function syncEpubPercentageToAudio(
  epubPct: number,
  alignment: WhispersyncAlignment
): { targetAudioSec: number; activeChapter: AlignedChapter } | null {
  if (!alignment.chapters || alignment.chapters.length === 0) return null;

  let activeChapter = alignment.chapters.find((ch) => {
    const end = ch.epubNextPercentage ?? 1.0;
    return epubPct >= ch.epubPercentage && epubPct <= end;
  });

  if (!activeChapter) {
    if (epubPct <= alignment.chapters[0].epubPercentage) {
      activeChapter = alignment.chapters[0];
    } else {
      activeChapter = alignment.chapters[alignment.chapters.length - 1];
    }
  }

  const epubStart = activeChapter.epubPercentage;
  const epubEnd = activeChapter.epubNextPercentage ?? 1.0;
  const epubSpan = Math.max(0.0001, epubEnd - epubStart);
  const frac = Math.max(0, Math.min(1, (epubPct - epubStart) / epubSpan));

  const chapterDur = Math.max(1, activeChapter.audioEndSec - activeChapter.audioStartSec);
  const targetAudioSec = activeChapter.audioStartSec + frac * chapterDur;

  return {
    targetAudioSec: Math.max(0, Math.round(targetAudioSec)),
    activeChapter,
  };
}


