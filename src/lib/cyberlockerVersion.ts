/**
 * Cyberlocker Filename Versioning & DMCA Defense Helper
 *
 * Appends and iterates version suffixes (e.g. `_v2`, `_v3`) to bypass automated
 * cyberlocker DMCA filename blocklists on re-uploads, while ensuring displayed
 * titles in RcloneFlix remain completely clean and human-readable.
 */

const EXT_REGEX = /\.([a-zA-Z0-9]{2,5})$/;
const VERSION_REGEX = /(?:_v|_r|_AV)(\d+)$/i;

/**
 * Extracts the current iteration number from a filename or title.
 * Returns 1 if no iteration suffix is detected.
 *
 * Examples:
 * - "My.Show.S01E01.mp4" -> 1
 * - "My.Show.S01E01_v2.mp4" -> 2
 * - "My.Show.S01E01_r3.mkv" -> 3
 */
export function extractIterationNumber(filename: string): number {
  if (!filename) return 1;
  const dotIndex = filename.lastIndexOf(".");
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const match = base.match(VERSION_REGEX);
  if (match && match[1]) {
    const parsed = parseInt(match[1], 10);
    return isNaN(parsed) || parsed < 1 ? 1 : parsed;
  }
  return 1;
}

/**
 * Generates the next iterated filename for cyberlocker re-uploads or clone mirrors.
 *
 * Examples:
 * - "Show.S01E01.mp4" -> "Show.S01E01_v2.mp4"
 * - "Show.S01E01_v2.mp4" -> "Show.S01E01_v3.mp4"
 * - "Movie (2024).mkv" -> "Movie (2024)_v2.mkv"
 */
export function getNextIteratedFilename(filename: string, forcedIteration?: number): string {
  if (!filename) return "media_v2.mp4";
  const dotIndex = filename.lastIndexOf(".");
  const ext = dotIndex > 0 ? filename.slice(dotIndex) : ".mp4";
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;

  // Strip existing _v{n} / _r{n}
  const cleanBase = base.replace(VERSION_REGEX, "");
  const currentIter = extractIterationNumber(filename);
  const nextIter = forcedIteration !== undefined ? forcedIteration : Math.max(2, currentIter + 1);

  return `${cleanBase}_v${nextIter}${ext}`;
}

/**
 * Cleans a filename or title so user-facing UI elements never display
 * internal DMCA version tags like `_v2` or `_r1`.
 *
 * Examples:
 * - "Show.S01E01_v2.mp4" -> "Show.S01E01.mp4"
 * - "A Different World S01E01_v2" -> "A Different World S01E01"
 */
export function cleanDisplayTitle(titleOrFilename: string): string {
  if (!titleOrFilename) return "";
  const dotIndex = titleOrFilename.lastIndexOf(".");
  if (dotIndex > 0 && EXT_REGEX.test(titleOrFilename.slice(dotIndex))) {
    const ext = titleOrFilename.slice(dotIndex);
    const base = titleOrFilename.slice(0, dotIndex);
    return `${base.replace(VERSION_REGEX, "")}${ext}`;
  }
  return titleOrFilename.replace(VERSION_REGEX, "");
}

/**
 * Sanitizes a title and extension into a valid cyberlocker upload filename.
 */
export function sanitizeCyberlockerFilename(title: string, ext = "mp4"): string {
  const cleanTitle = (title || "media")
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, ".")
    .replace(/\.+/g, ".");
  const cleanExt = ext.replace(/^\.+/, "");
  return `${cleanTitle}.${cleanExt}`;
}
