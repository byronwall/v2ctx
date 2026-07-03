export type ReviewStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "needs_context"
  | "routed";

export type ReviewType =
  | "task"
  | "claim"
  | "opinion"
  | "experience"
  | "quote"
  | "blog_seed"
  | "sensitive_flag";

export type ReviewItem = {
  id: string;
  status: ReviewStatus;
  type: ReviewType;
  title: string;
  body?: string;
  source?: {
    segmentId?: string;
    startMs?: number;
    endMs?: number;
    start?: string;
    end?: string;
    source?: string;
    sourceFiles?: string[];
    package?: string;
    packageName?: string;
  };
  item?: {
    text?: string;
    excerpt?: string;
    uncertainty?: string;
    confidence?: number;
    projectHint?: string;
    [key: string]: unknown;
  };
};

export type Segment = {
  id: string;
  startMs: number;
  endMs: number;
  start?: string;
  end?: string;
  title?: string;
  gist?: string;
  summary?: string;
  text?: string;
  cleanedText?: string;
  sectionHints?: string[];
};

export type TranscriptItem = {
  startMs?: number;
  endMs?: number;
  start?: number;
  end?: number;
  offsets?: {
    from?: number;
    to?: number;
  };
  timestamps?: {
    from?: string;
    to?: string;
  };
  text: string;
};

export type LoadedFile = {
  path: string;
  file?: File;
  url?: string;
  size?: number;
  mtimeMs?: number;
};

export type PackageStatus =
  | "new"
  | "transcribed"
  | "segments_ready"
  | "waiting_for_codex"
  | "codex_ready_to_import"
  | "llm_failed"
  | "analysis_ready"
  | "derived"
  | "failed";

export type TranscriptSummarySection = {
  title: string;
  summary?: string;
  start?: string;
  end?: string;
  startMs?: number;
  endMs?: number;
  cleanedText?: string;
  sourceSegmentIds: string[];
};

export type TranscriptSummary = {
  title?: string;
  summary: string;
  topBullets: string[];
  themes: string[];
  sections: TranscriptSummarySection[];
  model?: string;
  provider?: string;
  promptVersion?: string;
  generatedAt?: string;
};

export type MemoPackage = {
  name: string;
  title: string;
  files: LoadedFile[];
  manifest?: Record<string, unknown>;
  reviewItems: ReviewItem[];
  segments: Segment[];
  transcriptSummary?: TranscriptSummary;
  transcript: TranscriptItem[];
  audio?: LoadedFile;
  report?: LoadedFile;
  status: PackageStatus;
};

export type VoiceMemoLibrary = {
  root: string;
  packages: MemoPackage[];
  generatedAt: string;
};
