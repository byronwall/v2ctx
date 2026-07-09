export function packageDate(name: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})[- ](\d{2})(\d{2})(\d{2})/.exec(name);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime();
}

export function packageDateLabel(name: string): string {
  const value = packageDate(name);
  if (!value) return "Root assets";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(value);
}

export function formatTime(ms: number | undefined): string {
  if (ms == null) return "0:00";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  if (!hours) return `${minutes}:${rest}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`;
}

export function secondsToMs(value: number | undefined): number | undefined {
  if (value == null || Number.isNaN(value)) return undefined;
  return value * 1000;
}

export function parseClock(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.replace(",", ".").split(":");
  if (parts.length !== 3) return undefined;
  return Number(parts[0]) * 3_600_000 + Number(parts[1]) * 60_000 + Number(parts[2]) * 1000;
}

export function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function tokenSet(value: string): Set<string> {
  const stop = new Set([
    "about",
    "actually",
    "because",
    "going",
    "just",
    "like",
    "really",
    "right",
    "that",
    "this",
    "thing",
    "with",
    "would",
  ]);
  return new Set(
    normalizeSearch(value)
      .split(" ")
      .filter((token) => token.length > 2 && !stop.has(token)),
  );
}
