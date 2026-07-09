import type { MemoPackage, PackageStatus } from "./types";
import type { PackageSortMode } from "./reviewTypes";
import { parseClock, secondsToMs, packageDate } from "./datetime";

export function firstReadablePackage(packages: MemoPackage[]): MemoPackage | undefined {
  const sorted = [...packages].sort((a, b) => packageDate(b.name) - packageDate(a.name));
  return (
    sorted.find((pkg) => pkg.transcript.some((line) => line.text.trim())) ??
    sorted.find((pkg) => pkg.segments.some((segment) => segment.text?.trim())) ??
    sorted[0]
  );
}

export const packageProcessRanks: Record<PackageStatus, number> = {
  llm_failed: 0,
  failed: 1,
  new: 2,
  transcribed: 3,
  segments_ready: 4,
  analysis_ready: 7,
  derived: 8,
};

export function comparePackages(a: MemoPackage, b: MemoPackage, mode: PackageSortMode): number {
  if (mode === "needs_process") {
    const processRank = packageProcessRanks[a.status] - packageProcessRanks[b.status];
    if (processRank !== 0) return processRank;
  }
  return compareRecentlyUpdatedPackages(a, b);
}

export function compareRecentlyUpdatedPackages(a: MemoPackage, b: MemoPackage): number {
  return packageUpdatedAt(b) - packageUpdatedAt(a) || b.name.localeCompare(a.name);
}

export function packageUpdatedAt(pkg: MemoPackage): number {
  return maxNumber(pkg.files.map((file) => file.mtimeMs)) ?? packageDate(pkg.name);
}

export function packageDisplayTitle(pkg: MemoPackage): string {
  return pkg.title?.trim() || pkg.transcriptSummary?.title?.trim() || pkg.name;
}

export function packageDurationMs(pkg: MemoPackage): number | undefined {
  const manifestDuration = numericManifestValue(pkg.manifest, "totalDuration");
  if (manifestDuration && manifestDuration > 0) return secondsToMs(manifestDuration);

  const segmentEnd = maxNumber(pkg.segments.map((segment) => segment.endMs));
  if (segmentEnd && segmentEnd > 0) return segmentEnd;

  return maxNumber(
    pkg.transcript.map((line) => (
      line.endMs ??
      line.offsets?.to ??
      parseClock(line.timestamps?.to) ??
      secondsToMs(line.end)
    )),
  );
}

export function numericManifestValue(manifest: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = manifest?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function maxNumber(values: Array<number | undefined>): number | undefined {
  const finiteValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return finiteValues.length ? Math.max(...finiteValues) : undefined;
}
