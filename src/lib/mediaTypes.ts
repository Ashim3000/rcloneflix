/** Extensions routed to the audio mini-player rather than the video page. */
export const AUDIO_EXTENSIONS = [
  "mp3", "flac", "aac", "ogg", "oga", "m4a", "wav", "opus",
  "wma", "aiff", "alac", "ape", "m4b", "aax", "aa",
];

export const COMIC_EXTENSIONS = ["cbz", "cbr", "cb7", "cbt"];

export const BOOK_EXTENSIONS = ["epub", "pdf", ...COMIC_EXTENSIONS];

export function isComicExtension(filenameOrExt: string): boolean {
  const clean = filenameOrExt.split("?")[0].toLowerCase().trim();
  const ext = clean.includes(".") ? clean.split(".").pop() || "" : clean.replace(/^\./, "");
  return COMIC_EXTENSIONS.includes(ext);
}
