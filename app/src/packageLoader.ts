import type {
  LoadedFile,
  MemoPackage,
  PackageStatus,
  ReviewItem,
  Segment,
  TranscriptSummary,
  TranscriptItem,
} from "./types";

export async function loadPackageFromFileList(files: FileList): Promise<MemoPackage> {
  const loaded = Array.from(files).map((file) => ({
    path: file.webkitRelativePath || file.name,
    file,
    size: file.size,
    mtimeMs: file.lastModified,
  }));

  const name = inferPackageName(loaded);
  const manifest = await readJson<Record<string, unknown>>(findFile(loaded, ".v2c-manifest.json"));
  const reviewItems = await readJsonl<ReviewItem>(findFile(loaded, "analysis/review-inbox.jsonl"));
  const transcriptSummary = await readJson<TranscriptSummary>(
    findFile(loaded, "analysis/transcript-summary.json"),
  );
  const segmentsPayload = await readJson<{ segments?: Segment[] }>(
    findFile(loaded, "analysis/segments.json"),
  );
  const transcriptPayload = await readJson<{
    transcription?: TranscriptItem[];
    items?: TranscriptItem[];
    sentences?: TranscriptItem[];
    segments?: TranscriptItem[];
    chunks?: TranscriptItem[];
    results?: TranscriptItem[];
  }>(findFile(loaded, "transcript/transcript.json"));

  return {
    name,
    title: packageTitle(name, transcriptSummary),
    files: loaded.sort((a, b) => a.path.localeCompare(b.path)),
    manifest,
    reviewItems,
    transcriptSummary,
    segments: segmentsPayload?.segments ?? [],
    transcript: normalizeTranscript(transcriptItems(transcriptPayload)),
    audio: findFirst(loaded, [
      "audio/audio.wav",
      "audio/audio.m4a",
      "audio/audio.mp3",
      "source/audio.wav",
      ".m4a",
      ".wav",
      ".mp3",
    ]),
    report: findFile(loaded, "report.html"),
    status: inferStatus(loaded),
  };
}

function packageTitle(name: string, transcriptSummary: TranscriptSummary | undefined): string {
  return transcriptSummary?.title?.trim() || name;
}

export function findSegment(pkg: MemoPackage, item: ReviewItem | undefined): Segment | undefined {
  if (!item?.source?.segmentId) return undefined;
  return pkg.segments.find((segment) => segment.id === item.source?.segmentId);
}

export function transcriptAround(pkg: MemoPackage, item: ReviewItem | undefined): TranscriptItem[] {
  const start = item?.source?.startMs ?? parseClock(item?.source?.start);
  const end = item?.source?.endMs ?? parseClock(item?.source?.end);
  if (start == null || end == null) return pkg.transcript.slice(0, 12);
  return pkg.transcript.filter((line) => {
    const lineStart =
      line.startMs ?? line.offsets?.from ?? parseClock(line.timestamps?.from) ?? secondsToMs(line.start) ?? 0;
    const lineEnd =
      line.endMs ?? line.offsets?.to ?? parseClock(line.timestamps?.to) ?? secondsToMs(line.end) ?? lineStart;
    return lineEnd >= start - 30_000 && lineStart <= end + 30_000;
  });
}

export function fileUrl(file: LoadedFile | undefined): string | undefined {
  if (!file) return undefined;
  if (file.url) return file.url;
  return file.file ? URL.createObjectURL(file.file) : undefined;
}

function inferPackageName(files: LoadedFile[]): string {
  const firstPath = files[0]?.path;
  return firstPath?.includes("/") ? firstPath.split("/")[0] : "Selected package";
}

function findFile(files: LoadedFile[], suffix: string): LoadedFile | undefined {
  return files.find((item) => item.path.endsWith(suffix));
}

function findFirst(files: LoadedFile[], suffixes: string[]): LoadedFile | undefined {
  return files.find((item) => suffixes.some((suffix) => item.path.endsWith(suffix)));
}

async function readJson<T>(entry: LoadedFile | undefined): Promise<T | undefined> {
  if (!entry?.file) return undefined;
  return JSON.parse(await entry.file.text()) as T;
}

async function readJsonl<T>(entry: LoadedFile | undefined): Promise<T[]> {
  if (!entry?.file) return [];
  return (await entry.file.text())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function inferStatus(files: LoadedFile[]): PackageStatus {
  const has = (suffix: string) => files.some((entry) => entry.path.endsWith(suffix));
  if (has("analysis/review-inbox.jsonl")) return "derived";
  if (has("analysis/segment-analysis.jsonl")) return "analysis_ready";
  if (files.some((entry) => entry.path.includes("analysis/codex/results/"))) {
    return "codex_ready_to_import";
  }
  if (has("analysis/llm-error.json")) return "llm_failed";
  if (has("analysis/codex/manifest.json")) return "waiting_for_codex";
  if (has("analysis/segments.json")) return "segments_ready";
  if (has("transcript/transcript.json") || has("transcript/transcript.txt")) return "transcribed";
  return "new";
}

function normalizeTranscript(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => ({
    ...item,
    startMs: item.startMs ?? item.offsets?.from ?? parseClock(item.timestamps?.from) ?? secondsToMs(item.start),
    endMs: item.endMs ?? item.offsets?.to ?? parseClock(item.timestamps?.to) ?? secondsToMs(item.end),
  }));
}

function transcriptItems(
  payload:
    | {
        transcription?: TranscriptItem[];
        items?: TranscriptItem[];
        sentences?: TranscriptItem[];
        segments?: TranscriptItem[];
        chunks?: TranscriptItem[];
        results?: TranscriptItem[];
      }
    | TranscriptItem[]
    | undefined,
): TranscriptItem[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return (
    payload.items ??
    payload.transcription ??
    payload.sentences ??
    payload.segments ??
    payload.chunks ??
    payload.results ??
    []
  );
}

function parseClock(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length !== 3) return undefined;
  const [hours, minutes, seconds] = parts;
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000
  );
}

function secondsToMs(value: number | undefined): number | undefined {
  if (value == null || Number.isNaN(value)) return undefined;
  return value * 1000;
}
