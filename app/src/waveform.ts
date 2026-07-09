export type WaveformCache = {
  version: 1;
  audio: {
    url: string;
    size?: number;
    mtimeMs?: number;
  };
  durationMs: number;
  samples: number[];
};

export type WaveformCacheRequest = {
  packageName: string;
  audioUrl: string;
  audioSize?: number;
  audioMtimeMs?: number;
};

export const waveformCacheVersion = 1;
export const waveformBucketCount = 2_400;
export const waveformCachePromises = new Map<string, Promise<WaveformCache | undefined>>();

export async function loadWaveformCache(request: WaveformCacheRequest): Promise<WaveformCache | undefined> {
  const key = `${request.packageName}:${request.audioUrl}:${request.audioSize ?? ""}:${request.audioMtimeMs ?? ""}`;
  const existing = waveformCachePromises.get(key);
  if (existing) return existing;

  const promise = loadWaveformCacheUnmemoized(request).catch((error) => {
    waveformCachePromises.delete(key);
    throw error;
  });
  waveformCachePromises.set(key, promise);
  return promise;
}

export async function loadWaveformCacheUnmemoized(request: WaveformCacheRequest): Promise<WaveformCache | undefined> {
  const cached = await fetchWaveformCache(request);
  if (cached) return cached;

  const generated = await waveformCacheFromAudio(request.audioUrl, {
    url: request.audioUrl,
    size: request.audioSize,
    mtimeMs: request.audioMtimeMs,
  });
  if (!generated) return undefined;

  void saveWaveformCache(request.packageName, generated);
  return generated;
}

export async function fetchWaveformCache(request: WaveformCacheRequest): Promise<WaveformCache | undefined> {
  const response = await fetch(`/api/voice-memos/${encodeURIComponent(request.packageName)}/waveform`, {
    cache: "no-store",
  });
  if (response.status === 404) return undefined;
  if (!response.ok) return undefined;
  const payload = (await response.json()) as unknown;
  return isUsableWaveformCache(payload, request) ? payload : undefined;
}

export async function saveWaveformCache(packageName: string, cache: WaveformCache): Promise<void> {
  await fetch(`/api/voice-memos/${encodeURIComponent(packageName)}/waveform`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cache),
  });
}

export function isUsableWaveformCache(value: unknown, request: WaveformCacheRequest): value is WaveformCache {
  const cache = value as WaveformCache;
  return (
    !!cache &&
    cache.version === waveformCacheVersion &&
    Array.isArray(cache.samples) &&
    cache.samples.length > 0 &&
    cache.samples.every((sample) => typeof sample === "number" && Number.isFinite(sample)) &&
    cache.audio?.size === request.audioSize &&
    cache.audio?.mtimeMs === request.audioMtimeMs
  );
}

export async function waveformCacheFromAudio(
  url: string,
  audio: WaveformCache["audio"],
): Promise<WaveformCache | undefined> {
  if (typeof AudioContext === "undefined") return undefined;
  const response = await fetch(url);
  const audioData = await response.arrayBuffer();
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(audioData.slice(0));
    const channel = buffer.getChannelData(0);
    return {
      version: waveformCacheVersion,
      audio,
      durationMs: buffer.duration * 1000,
      samples: sampleWaveformBars(channel, waveformBucketCount),
    };
  } finally {
    void context.close();
  }
}

export function waveformBarsForRange(cache: WaveformCache, startMs = 0, endMs?: number): number[] {
  if (!cache.samples.length) return [];
  const durationMs = Math.max(1, cache.durationMs);
  const startRatio = Math.max(0, Math.min(1, startMs / durationMs));
  const endRatio = Math.max(startRatio, Math.min(1, (endMs ?? durationMs) / durationMs));
  const start = Math.floor(startRatio * cache.samples.length);
  const end = Math.max(start + 1, Math.ceil(endRatio * cache.samples.length));
  return sampleWaveformBars(Float32Array.from(cache.samples.slice(start, end)), 52);
}

export function sampleWaveformBars(samples: Float32Array, count: number): number[] {
  if (!samples.length) return [];
  const bars: number[] = [];
  const bucketSize = Math.max(1, Math.floor(samples.length / count));
  let max = 0;
  for (let index = 0; index < count; index++) {
    const start = index * bucketSize;
    const end = Math.min(samples.length, start + bucketSize);
    let sum = 0;
    for (let cursor = start; cursor < end; cursor++) sum += Math.abs(samples[cursor]);
    const value = sum / Math.max(1, end - start);
    bars.push(value);
    max = Math.max(max, value);
  }
  return bars.map((value) => (max > 0 ? value / max : 0.12));
}

export function fallbackWaveformBars(seed: string): number[] {
  let state = 0;
  for (let index = 0; index < seed.length; index++) state = (state * 31 + seed.charCodeAt(index)) >>> 0;
  return Array.from({ length: 52 }, (_, index) => {
    state = (1664525 * state + 1013904223 + index) >>> 0;
    const noise = (state % 1000) / 1000;
    return 0.18 + noise * 0.82;
  });
}
