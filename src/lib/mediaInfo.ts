import type { MediaItem } from "../store/appStore";

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export type MediaTechnicalSpecs = {
  container: string;
  resolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  sizeFormatted?: string;
  durationFormatted?: string;
  fullPath: string;
  filename: string;
};

export function extractMediaTechnicalSpecs(item: MediaItem): MediaTechnicalSpecs {
  const filename = item.filename || item.remotePath?.split("/").pop() || "";
  const ext = item.container || filename.split(".").pop()?.toUpperCase() || "";
  const fn = filename.toLowerCase();

  let resolution = item.resolution;
  if (!resolution) {
    if (/\b(2160p|4k|uhd)\b/i.test(fn)) resolution = "4K";
    else if (/\b(1080p|1080i|fhd)\b/i.test(fn)) resolution = "1080p";
    else if (/\b(720p|hd)\b/i.test(fn)) resolution = "720p";
    else if (/\b(480p|576p|sd)\b/i.test(fn)) resolution = "480p";
  }

  let videoCodec = item.videoCodec;
  if (!videoCodec) {
    if (/\b(x265|h265|hevc)\b/i.test(fn)) videoCodec = "HEVC";
    else if (/\b(x264|h264|avc)\b/i.test(fn)) videoCodec = "H.264";
    else if (/\b(av1)\b/i.test(fn)) videoCodec = "AV1";
    else if (/\b(vp9)\b/i.test(fn)) videoCodec = "VP9";
    else if (/\b(xvid|divx)\b/i.test(fn)) videoCodec = "XviD";
  }

  let audioCodec = item.audioCodec;
  if (!audioCodec) {
    if (/\b(ddp\+?5\.1|eac3)\b/i.test(fn)) audioCodec = "DDP 5.1";
    else if (/\b(dd5\.1|ac3)\b/i.test(fn)) audioCodec = "DD 5.1";
    else if (/\b(dts-hd\s*ma|dts-hd)\b/i.test(fn)) audioCodec = "DTS-HD";
    else if (/\b(truehd)\b/i.test(fn)) audioCodec = "TrueHD";
    else if (/\b(atmos)\b/i.test(fn)) audioCodec = "Atmos";
    else if (/\b(dts)\b/i.test(fn)) audioCodec = "DTS";
    else if (/\b(flac)\b/i.test(fn)) audioCodec = "FLAC";
    else if (/\b(aac)\b/i.test(fn)) audioCodec = "AAC";
    else if (/\b(mp3)\b/i.test(fn)) audioCodec = "MP3";
    else if (/\b(opus)\b/i.test(fn)) audioCodec = "Opus";
  }

  return {
    container: ext,
    resolution,
    videoCodec,
    audioCodec,
    sizeFormatted: formatFileSize(item.sizeBytes),
    durationFormatted: formatDuration(item.duration),
    fullPath: item.remotePath || item.filename || "",
    filename,
  };
}
