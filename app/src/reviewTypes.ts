import type { FollowUpQuestion, ReviewItem, ReviewType, TranscriptItem, VoiceMemoLibrary } from "./types";

export type OverlayType = ReviewType | "claimish";
export type AnchorQuality = "excerpt" | "fuzzy" | "time" | "segment" | "unmatched";
export type PackageSortMode = "updated" | "needs_process";
export type WorkspaceView = "review" | "projects" | "items" | "memos";
export type CollectedItemType = "question" | ReviewType;
export type ProjectCardCountType = "question" | "task" | "idea" | "quote" | "blog_seed" | "sensitive_flag";

export type TranscriptLine = TranscriptItem & {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  segmentId?: string;
};

export type TranscriptOverlay = {
  id: string;
  item: ReviewItem;
  type: OverlayType;
  startLine: number;
  endLine: number;
  startOffset?: number;
  endOffset?: number;
  quality: AnchorQuality;
  snippet: string;
};

export type TranscriptSection = {
  id: string;
  title: string;
  summary?: string;
  startMs: number;
  endMs: number;
  lines: TranscriptLine[];
  fallbackText?: string;
};

export type UrlSelection = {
  transcript?: string;
  snippet?: string;
  view?: WorkspaceView;
};

export type LibraryLoadResult = {
  library?: VoiceMemoLibrary;
  error?: string;
};

export type ProjectSectionRef = {
  packageName: string;
  sectionId: string;
  title: string;
  startMs: number;
  endMs: number;
  assignedAt: string;
};

export type ProjectRecord = {
  id: string;
  name: string;
  description?: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  recordingNames: string[];
  sectionRefs: ProjectSectionRef[];
};

export type ProjectRecordingCard = {
  id: string;
  projectId: string;
  kind: "recording" | "section";
  packageName: string;
  title: string;
  dateMs: number;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  sectionId?: string;
  summary?: string;
  counts: Record<ProjectCardCountType, number>;
  sectionCount: number;
  topSections: { title: string; time: string }[];
  audioUrl?: string;
  audioSize?: number;
  audioMtimeMs?: number;
};

export type ProjectRow = {
  project: ProjectRecord;
  recordings: ProjectRecordingCard[];
  summary: string;
  insights: string[];
  durationMs: number;
};

export type CollectedItemRow = {
  id: string;
  type: CollectedItemType;
  packageName: string;
  packageTitle: string;
  title: string;
  content: string;
  quote: string;
  source: string;
  time: string;
  sortMs: number;
  reviewItem?: ReviewItem;
  question?: FollowUpQuestion;
};

export const transcriptQueryParam = "transcript";
export const snippetQueryParam = "snippet";
export const viewQueryParam = "view";
export const projectsStorageKey = "v2ctx.projects.v1";
export const hiddenMemoStorageKey = "v2ctx.hiddenMemos.v1";

export const typeLabels: Record<ReviewType, string> = {
  task: "Task",
  claim: "Claim",
  opinion: "Opinion",
  experience: "Experience",
  quote: "Quote",
  blog_seed: "Blog seed",
  sensitive_flag: "Sensitive",
};

export const collectedTypeLabels: Record<CollectedItemType, string> = {
  question: "Question",
  ...typeLabels,
};

export const projectCardCountLabels: Record<ProjectCardCountType, string> = {
  question: "Questions",
  task: "Tasks",
  idea: "Ideas",
  quote: "Quotes",
  blog_seed: "Blog seeds",
  sensitive_flag: "Sensitive",
};

export const projectCardCountOptions: ProjectCardCountType[] = ["question", "task", "idea", "quote", "blog_seed", "sensitive_flag"];
export const defaultProjectCardCountTypes = new Set<ProjectCardCountType>(["question", "task", "idea"]);

export const overlayLabels: Record<OverlayType, string> = {
  ...typeLabels,
  claimish: "Ideas",
};

export const overlayFilters: { value: OverlayType | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "task", label: "Tasks" },
  { value: "claimish", label: "Ideas" },
  { value: "quote", label: "Quotes" },
  { value: "blog_seed", label: "Blog seeds" },
  { value: "sensitive_flag", label: "Sensitive" },
];

export const sidebarReviewSections: { value: OverlayType; label: string }[] = [
  { value: "task", label: "Tasks" },
  { value: "claimish", label: "Ideas" },
  { value: "quote", label: "Quotes" },
  { value: "blog_seed", label: "Blog seeds" },
  { value: "sensitive_flag", label: "Sensitive" },
];
