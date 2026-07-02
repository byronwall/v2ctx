import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "./util.js";

export const VIDEO_EXTS = new Set([
  ".mov",
  ".mp4",
  ".m4v",
  ".mkv",
  ".webm",
  ".avi",
  ".mpg",
  ".mpeg",
]);

export const AUDIO_EXTS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".caf",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".wma",
]);

export const MEDIA_EXTS = new Set([...VIDEO_EXTS, ...AUDIO_EXTS]);

/**
 * Resolve the CLI input into an ordered list of source media paths.
 * - a file        → just that file
 * - a directory   → all eligible media in that directory (non-recursive)
 * - nothing       → all eligible media in the current working directory
 * Returns { mode: 'file'|'dir', dir, media: string[] }.
 */
export async function resolveInputs(
  input,
  { recursive = false, onProgress = null } = {},
) {
  const target = path.resolve(input || ".");
  const st = await fs.stat(target).catch(() => {
    throw new Error(`Input not found: ${target}`);
  });

  if (st.isFile()) {
    if (!MEDIA_EXTS.has(path.extname(target).toLowerCase())) {
      throw new Error(`Not a recognised media file: ${target}`);
    }
    return { mode: "file", dir: path.dirname(target), media: [target] };
  }

  const media = await collectMediaFiles(target, recursive, onProgress);
  if (!media.length) {
    throw new Error(
      `No eligible media files found in ${target}\n` +
        `(looked for: ${[...MEDIA_EXTS].join(", ")})`,
    );
  }
  return { mode: "dir", dir: target, media };
}

async function collectMediaFiles(dir, recursive, onProgress, state = { dirs: 0 }) {
  state.dirs++;
  if (onProgress && (state.dirs === 1 || state.dirs % 25 === 0)) {
    onProgress({ type: "scan", dirs: state.dirs, dir });
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const media = [];
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && MEDIA_EXTS.has(path.extname(entry.name).toLowerCase())) {
      media.push(p);
      if (onProgress && media.length % 25 === 0) {
        onProgress({ type: "media", files: media.length, dir });
      }
    } else if (recursive && entry.isDirectory()) {
      media.push(
        ...(await collectMediaFiles(p, recursive, onProgress, state).catch(
          () => [],
        )),
      );
    }
  }
  return media
    .sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
}

/**
 * Probe each media file and lay them out on a single combined timeline.
 * Returns sources: [{ index, path, name, duration, hasAudio, hasVideo, offset }] and totalDuration.
 */
export async function buildTimeline(ffprobe, media, { onProgress = null } = {}) {
  const sources = [];
  let offset = 0;
  for (let i = 0; i < media.length; i++) {
    const p = media[i];
    if (onProgress && (i === 0 || i % 10 === 0)) {
      onProgress({ index: i, total: media.length, path: p });
    }
    const duration = await probeDuration(ffprobe, p);
    const hasAudio = await probeHasAudio(ffprobe, p);
    const hasVideo = await probeHasVideo(ffprobe, p);
    sources.push({
      index: i,
      path: p,
      name: path.basename(p),
      duration,
      hasAudio,
      hasVideo,
      offset,
    });
    offset += duration || 0;
  }
  if (onProgress && media.length) {
    onProgress({ index: media.length, total: media.length, path: null });
  }
  return { sources, totalDuration: offset };
}

export async function probeDuration(ffprobe, input) {
  if (!ffprobe) return 0;
  try {
    const { stdout } = await exec(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        input,
      ],
      { capture: true },
    );
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

export async function probeHasAudio(ffprobe, input) {
  return probeHasStream(ffprobe, input, "a:0");
}

export async function probeHasVideo(ffprobe, input) {
  return probeHasStream(ffprobe, input, "v:0");
}

async function probeHasStream(ffprobe, input, stream) {
  if (!ffprobe) return true;
  try {
    const { stdout } = await exec(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        stream,
        "-show_entries",
        "stream=codec_type",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        input,
      ],
      { capture: true },
    );
    return stdout.trim().length > 0;
  } catch {
    return true;
  }
}

/** Map a global timeline second back to its originating source + local time. */
export function sourceAt(sources, t) {
  for (const s of sources) {
    if (t >= s.offset && t < s.offset + (s.duration || Infinity)) {
      return { source: s, localTime: t - s.offset };
    }
  }
  const last = sources[sources.length - 1];
  return { source: last, localTime: t - last.offset };
}
