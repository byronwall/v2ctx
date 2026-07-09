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

export type FollowUpQuestion = {
  id: string;
  scope: "transcript" | "section";
  sectionId?: string;
  question: string;
  assumedAnswer: string;
  alternatives: string[];
  rationale?: string;
  excerpt?: string;
  evidence?: string;
  sourceSegments?: Array<{
    segmentId?: string;
    title?: string;
    start?: string;
    end?: string;
  }>;
  source?: {
    segmentId?: string;
    start?: string;
    end?: string;
  };
};

export type FollowUpQuestionsArtifact = {
  promptVersion?: string;
  model?: string;
  provider?: string;
  generatedAt?: string;
  questions: FollowUpQuestion[];
};

export type NextTopic = {
  id: string;
  title: string;
  description: string;
  talkingPoints: string[];
  tags: string[];
  rationale: string;
  additiveJustification: string;
  projectNames: string[];
  relatedSources: Array<{
    packageTitle: string;
    sectionTitle: string;
  }>;
};

export type NextTopicsArtifact = {
  promptVersion?: string;
  model?: string;
  provider?: string;
  generatedAt?: string;
  source?: {
    root?: string;
    packageCount?: number;
    packages?: Array<{
      packageName: string;
      title: string;
      sectionCount: number;
      projectNames?: string[];
    }>;
    projects?: Array<{
      name: string;
      description?: string;
      packageCount: number;
    }>;
  };
  topics: NextTopic[];
};

export type MemoPackage = {
  name: string;
  title: string;
  files: LoadedFile[];
  manifest?: Record<string, unknown>;
  reviewItems: ReviewItem[];
  segments: Segment[];
  transcriptSummary?: TranscriptSummary;
  followUpQuestions?: FollowUpQuestionsArtifact;
  transcript: TranscriptItem[];
  audio?: LoadedFile;
  report?: LoadedFile;
  status: PackageStatus;
};

export type VoiceMemoLibrary = {
  root: string;
  packages: MemoPackage[];
  generatedAt: string;
  nextTopics?: NextTopicsArtifact;
};
