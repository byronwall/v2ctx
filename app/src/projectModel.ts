import type { Setter } from "solid-js";
import { fileUrl } from "./packageLoader";
import type { FollowUpQuestion, MemoPackage, ReviewItem } from "./types";
import type { CollectedItemRow, CollectedItemType, ProjectCardCountType, ProjectRecord, ProjectRecordingCard, ProjectRow, ProjectSectionRef } from "./reviewTypes";
import { collectedTypeLabels, hiddenMemoStorageKey, projectsStorageKey } from "./reviewTypes";
import { formatTime, packageDate, parseClock } from "./datetime";
import { buildSections, formatRange, normalizeTranscriptLines, sourceLabel, sourceStartMs } from "./transcriptModel";
import { packageDisplayTitle, packageDurationMs } from "./packageModel";

export function loadStoredProjects(): ProjectRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(projectsStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ProjectRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((project) => project && typeof project.id === "string" && typeof project.name === "string")
      .map((project, index) => ({
        id: project.id,
        name: project.name,
        description: typeof project.description === "string" ? project.description : undefined,
        color: typeof project.color === "string" ? project.color : projectColor(index),
        createdAt: typeof project.createdAt === "string" ? project.createdAt : new Date().toISOString(),
        updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : new Date().toISOString(),
        recordingNames: Array.isArray(project.recordingNames)
          ? project.recordingNames.filter((name): name is string => typeof name === "string")
          : [],
        sectionRefs: Array.isArray(project.sectionRefs)
          ? project.sectionRefs.filter(isProjectSectionRef)
          : [],
      }));
  } catch {
    return [];
  }
}

export function saveStoredProjects(projects: ProjectRecord[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(projectsStorageKey, JSON.stringify(projects));
}

export function loadStoredHiddenMemoNames(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(hiddenMemoStorageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((name): name is string => typeof name === "string" && !!name.trim()));
  } catch {
    return new Set();
  }
}

export function saveStoredHiddenMemoNames(hiddenMemoNames: Set<string>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(hiddenMemoStorageKey, JSON.stringify([...hiddenMemoNames].sort()));
}

export function isProjectSectionRef(value: unknown): value is ProjectSectionRef {
  const ref = value as ProjectSectionRef;
  return (
    !!ref &&
    typeof ref.packageName === "string" &&
    typeof ref.sectionId === "string" &&
    typeof ref.title === "string" &&
    typeof ref.startMs === "number" &&
    typeof ref.endMs === "number"
  );
}

export function touchProject(project: ProjectRecord): ProjectRecord {
  return { ...project, updatedAt: new Date().toISOString() };
}

export function projectColor(index: number): string {
  return ["#2563eb", "#16a34a", "#db2777", "#d97706", "#7c3aed", "#0891b2"][index % 6];
}

export function projectsForPackage(projects: ProjectRecord[], packageName: string): ProjectRecord[] {
  if (!packageName) return [];
  return projects.filter((project) => project.recordingNames.includes(packageName));
}

export function buildProjectRows(projects: ProjectRecord[], packages: MemoPackage[]): ProjectRow[] {
  return projects.map((project) => {
    const recordings = buildProjectRecordingCards(project, packages);
    const summaries = recordings.map((recording) => recording.summary).filter((value): value is string => !!value);
    const insights = uniqueStrings(
      recordings.flatMap((recording) => {
        const memoPackage = packages.find((pkg) => pkg.name === recording.packageName);
        return memoPackage?.transcriptSummary?.topBullets ?? [];
      }),
    );
    return {
      project,
      recordings,
      summary:
        summaries[0] ??
        (recordings.length
          ? `This project includes ${recordings.length} assigned recording${recordings.length === 1 ? "" : "s"} sorted by source time.`
          : "No recordings have been assigned yet."),
      insights,
      durationMs: recordings.reduce((total, recording) => total + (recording.durationMs ?? 0), 0),
    };
  });
}

export function buildProjectRecordingCards(project: ProjectRecord, packages: MemoPackage[]): ProjectRecordingCard[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const wholeRecordingCards = project.recordingNames.flatMap((packageName): ProjectRecordingCard[] => {
    const memoPackage = byName.get(packageName);
    if (!memoPackage) return [];
    const durationMs = packageDurationMs(memoPackage);
    const sections = buildSections(memoPackage, normalizeTranscriptLines(memoPackage));
    return [
      {
        id: `${project.id}::recording::${memoPackage.name}`,
        projectId: project.id,
        kind: "recording",
        packageName: memoPackage.name,
        title: packageDisplayTitle(memoPackage),
        dateMs: packageDate(memoPackage.name),
        startMs: 0,
        endMs: durationMs,
        durationMs,
        summary: memoPackage.transcriptSummary?.summary,
        counts: projectCardCounts(memoPackage),
        sectionCount: sections.length,
        topSections: sections.slice(0, 3).map((section) => ({
          title: section.title,
          time: formatTime(section.startMs),
        })),
        audioUrl: fileUrl(memoPackage.audio),
        audioSize: memoPackage.audio?.size,
        audioMtimeMs: memoPackage.audio?.mtimeMs,
      },
    ];
  });

  return wholeRecordingCards.sort(
    (a, b) => a.dateMs - b.dateMs || a.startMs - b.startMs || a.title.localeCompare(b.title),
  );
}

export function buildUnassignedRecordingCards(projects: ProjectRecord[], packages: MemoPackage[]): ProjectRecordingCard[] {
  const assignedPackageNames = new Set(projects.flatMap((project) => project.recordingNames));
  return packages
    .filter((memoPackage) => !assignedPackageNames.has(memoPackage.name))
    .map((memoPackage): ProjectRecordingCard => {
      const durationMs = packageDurationMs(memoPackage);
      const sections = buildSections(memoPackage, normalizeTranscriptLines(memoPackage));
      return {
        id: `unassigned::recording::${memoPackage.name}`,
        projectId: "unassigned",
        kind: "recording",
        packageName: memoPackage.name,
        title: packageDisplayTitle(memoPackage),
        dateMs: packageDate(memoPackage.name),
        startMs: 0,
        endMs: durationMs,
        durationMs,
        summary: memoPackage.transcriptSummary?.summary,
        counts: projectCardCounts(memoPackage),
        sectionCount: sections.length,
        topSections: sections.slice(0, 3).map((section) => ({
          title: section.title,
          time: formatTime(section.startMs),
        })),
        audioUrl: fileUrl(memoPackage.audio),
        audioSize: memoPackage.audio?.size,
        audioMtimeMs: memoPackage.audio?.mtimeMs,
      };
    })
    .sort((a, b) => a.dateMs - b.dateMs || a.title.localeCompare(b.title));
}

export function followUpQuestionsForPackage(pkg: MemoPackage | undefined): FollowUpQuestion[] {
  return pkg?.followUpQuestions?.questions ?? [];
}

export function followUpQuestionsForSection(pkg: MemoPackage | undefined, sectionId: string): FollowUpQuestion[] {
  if (!pkg) return [];
  return followUpQuestionsForPackage(pkg).filter((question) => {
    if (question.scope === "section" && question.sectionId === sectionId) return true;
    return question.sourceSegments?.some((segment) => segment.segmentId === sectionId) ?? false;
  });
}

export function projectCardCounts(pkg: MemoPackage, sectionId?: string): Record<ProjectCardCountType, number> {
  const reviewItems = sectionId ? reviewItemsForSection(pkg, sectionId) : pkg.reviewItems;
  return {
    question: sectionId ? followUpQuestionsForSection(pkg, sectionId).length : followUpQuestionsForPackage(pkg).length,
    task: countReviewItems(reviewItems, (item) => item.type === "task"),
    idea: countReviewItems(reviewItems, (item) => item.type === "claim" || item.type === "opinion" || item.type === "experience"),
    quote: countReviewItems(reviewItems, (item) => item.type === "quote"),
    blog_seed: countReviewItems(reviewItems, (item) => item.type === "blog_seed"),
    sensitive_flag: countReviewItems(reviewItems, (item) => item.type === "sensitive_flag"),
  };
}

export function reviewItemsForSection(pkg: MemoPackage, sectionId: string): ReviewItem[] {
  return pkg.reviewItems.filter((item) => item.source?.segmentId === sectionId);
}

export function countReviewItems(items: ReviewItem[], predicate: (item: ReviewItem) => boolean): number {
  return items.reduce((count, item) => count + (predicate(item) ? 1 : 0), 0);
}

export function toggleProjectCardCountType(
  type: ProjectCardCountType,
  setTypes: Setter<Set<ProjectCardCountType>>,
) {
  setTypes((previous) => {
    const next = new Set(previous);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    return next;
  });
}

export function buildCollectedItemRows(packages: MemoPackage[]): CollectedItemRow[] {
  return packages
    .flatMap((memoPackage) => {
      const packageTitle = packageDisplayTitle(memoPackage);
      const reviewRows = memoPackage.reviewItems.map((item): CollectedItemRow => {
        const startMs = sourceStartMs(item);
        return {
          id: `${memoPackage.name}::review::${item.id}`,
          type: item.type,
          packageName: memoPackage.name,
          packageTitle,
          title: item.title || collectedTypeLabels[item.type],
          content: collectedReviewItemContent(item),
          quote: collectedReviewItemQuote(item),
          source: sourceLabel(item),
          time: formatRange(item),
          sortMs: packageDate(memoPackage.name) + (startMs ?? 0) / 86_400_000,
          reviewItem: item,
        };
      });
      const questionRows = followUpQuestionsForPackage(memoPackage).map((question): CollectedItemRow => {
        const startMs = parseClock(question.source?.start ?? question.sourceSegments?.[0]?.start);
        return {
          id: `${memoPackage.name}::question::${question.id}`,
          type: "question",
          packageName: memoPackage.name,
          packageTitle,
          title: question.question,
          content: collectedQuestionContent(question),
          quote: question.excerpt || question.evidence || "",
          source: question.sourceSegments?.map((segment) => segment.title || segment.segmentId).filter(Boolean).join(", ") || "Follow-up questions",
          time: collectedQuestionTime(question),
          sortMs: packageDate(memoPackage.name) + (startMs ?? 0) / 86_400_000,
          question,
        };
      });
      return [...reviewRows, ...questionRows];
    })
    .sort((a, b) => b.sortMs - a.sortMs || a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
}

export function collectedReviewItemContent(item: ReviewItem): string {
  return item.body?.trim() || item.item?.text?.trim() || item.item?.uncertainty?.trim() || "";
}

export function collectedReviewItemQuote(item: ReviewItem): string {
  return item.item?.excerpt?.trim() || "";
}

export function collectedQuestionContent(question: FollowUpQuestion): string {
  const parts = [
    question.assumedAnswer ? `Assumed answer: ${question.assumedAnswer}` : "",
    question.alternatives.length ? `Alternatives: ${question.alternatives.join("; ")}` : "",
    question.rationale ?? "",
  ];
  return parts.filter(Boolean).join(" ");
}

export function collectedQuestionTime(question: FollowUpQuestion): string {
  if (question.source?.start && question.source?.end) return `${question.source.start} - ${question.source.end}`;
  const segment = question.sourceSegments?.find((item) => item.start || item.end);
  if (segment?.start && segment.end) return `${segment.start} - ${segment.end}`;
  if (segment?.start) return segment.start;
  return question.scope === "section" ? "Section question" : "Transcript question";
}

export function countCollectedItemTypes(rows: CollectedItemRow[]): Map<CollectedItemType, number> {
  const counts = new Map<CollectedItemType, number>();
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  return counts;
}

export function collectedItemFilterOptions(counts: Map<CollectedItemType, number>) {
  const orderedTypes: CollectedItemType[] = [
    "question",
    "task",
    "claim",
    "opinion",
    "experience",
    "quote",
    "blog_seed",
    "sensitive_flag",
  ];
  const total = orderedTypes.reduce((sum, type) => sum + (counts.get(type) ?? 0), 0);
  return [
    { value: "all" as const, label: "All", count: total },
    ...orderedTypes
      .filter((type) => counts.has(type))
      .map((type) => ({ value: type, label: collectedTypeLabels[type], count: counts.get(type) ?? 0 })),
  ];
}

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  }
  return result;
}

export function projectDateRange(recordings: ProjectRecordingCard[]): string {
  if (!recordings.length) return "No dates";
  const sorted = [...recordings].filter((recording) => recording.dateMs > 0).sort((a, b) => a.dateMs - b.dateMs);
  if (!sorted.length) return "No dates";
  const first = new Date(sorted[0].dateMs).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const last = new Date(sorted.at(-1)!.dateMs).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return first === last ? first : `${first} - ${last}`;
}

export function relativeDate(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "recently";
  const diffMs = Date.now() - ms;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
