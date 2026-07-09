import { For, Show, Suspense, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, untrack } from "solid-js";
import type { JSX, Setter } from "solid-js";
import { Portal, render } from "solid-js/web";
import { fileUrl } from "./packageLoader";
import type {
  FollowUpQuestion,
  MemoPackage,
  PackageStatus,
  ReviewItem,
  ReviewType,
  TranscriptItem,
  VoiceMemoLibrary,
} from "./types";
import "./styles.css";

type OverlayType = ReviewType | "claimish";
type AnchorQuality = "excerpt" | "fuzzy" | "time" | "segment" | "unmatched";
type PackageSortMode = "updated" | "needs_process";
type WorkspaceView = "review" | "projects" | "items" | "memos";
type CollectedItemType = "question" | ReviewType;
type ProjectCardCountType = "question" | "task" | "idea" | "quote" | "blog_seed" | "sensitive_flag";

type TranscriptLine = TranscriptItem & {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  segmentId?: string;
};

type TranscriptOverlay = {
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

type TranscriptSection = {
  id: string;
  title: string;
  summary?: string;
  startMs: number;
  endMs: number;
  lines: TranscriptLine[];
  fallbackText?: string;
};

type UrlSelection = {
  transcript?: string;
  snippet?: string;
  view?: WorkspaceView;
};

type LibraryLoadResult = {
  library?: VoiceMemoLibrary;
  error?: string;
};

type ProjectSectionRef = {
  packageName: string;
  sectionId: string;
  title: string;
  startMs: number;
  endMs: number;
  assignedAt: string;
};

type ProjectRecord = {
  id: string;
  name: string;
  description?: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  recordingNames: string[];
  sectionRefs: ProjectSectionRef[];
};

type ProjectRecordingCard = {
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

type ProjectRow = {
  project: ProjectRecord;
  recordings: ProjectRecordingCard[];
  summary: string;
  insights: string[];
  durationMs: number;
};

type CollectedItemRow = {
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

const transcriptQueryParam = "transcript";
const snippetQueryParam = "snippet";
const viewQueryParam = "view";
const projectsStorageKey = "v2ctx.projects.v1";
const hiddenMemoStorageKey = "v2ctx.hiddenMemos.v1";

const typeLabels: Record<ReviewType, string> = {
  task: "Task",
  claim: "Claim",
  opinion: "Opinion",
  experience: "Experience",
  quote: "Quote",
  blog_seed: "Blog seed",
  sensitive_flag: "Sensitive",
};

const collectedTypeLabels: Record<CollectedItemType, string> = {
  question: "Question",
  ...typeLabels,
};

const projectCardCountLabels: Record<ProjectCardCountType, string> = {
  question: "Questions",
  task: "Tasks",
  idea: "Ideas",
  quote: "Quotes",
  blog_seed: "Blog seeds",
  sensitive_flag: "Sensitive",
};

const projectCardCountOptions: ProjectCardCountType[] = ["question", "task", "idea", "quote", "blog_seed", "sensitive_flag"];
const defaultProjectCardCountTypes = new Set<ProjectCardCountType>(["question", "task", "idea"]);

const overlayLabels: Record<OverlayType, string> = {
  ...typeLabels,
  claimish: "Ideas",
};

const overlayFilters: { value: OverlayType | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "task", label: "Tasks" },
  { value: "claimish", label: "Ideas" },
  { value: "quote", label: "Quotes" },
  { value: "blog_seed", label: "Blog seeds" },
  { value: "sensitive_flag", label: "Sensitive" },
];

const sidebarReviewSections: { value: OverlayType; label: string }[] = [
  { value: "task", label: "Tasks" },
  { value: "claimish", label: "Ideas" },
  { value: "quote", label: "Quotes" },
  { value: "blog_seed", label: "Blog seeds" },
  { value: "sensitive_flag", label: "Sensitive" },
];

function App() {
  let audioRef: HTMLAudioElement | undefined;
  const initialUrlSelection = readUrlSelection();
  const [allPackages, setAllPackages] = createSignal<MemoPackage[]>([]);
  const [selectedPackageName, setSelectedPackageName] = createSignal(initialUrlSelection.transcript ?? "");
  const [selectedOverlayId, setSelectedOverlayId] = createSignal(initialUrlSelection.snippet ?? "");
  const [workspaceView, setWorkspaceView] = createSignal<WorkspaceView>(initialUrlSelection.view ?? "review");
  const [packageSearch, setPackageSearch] = createSignal("");
  const [packageSortMode, setPackageSortMode] = createSignal<PackageSortMode>("updated");
  const [overlayFilter, setOverlayFilter] = createSignal<OverlayType | "all">("all");
  const [projectSearch, setProjectSearch] = createSignal("");
  const [collectedTypeFilter, setCollectedTypeFilter] = createSignal<CollectedItemType | "all">("all");
  const [projectCardLimit, setProjectCardLimit] = createSignal<Record<string, number>>({});
  const [projectCardCountTypes, setProjectCardCountTypes] = createSignal<Set<ProjectCardCountType>>(
    new Set(defaultProjectCardCountTypes),
  );
  const [isProjectComposerOpen, setIsProjectComposerOpen] = createSignal(false);
  const [newProjectName, setNewProjectName] = createSignal("");
  const [loadError, setLoadError] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(true);
  const [isRefreshingLibrary, setIsRefreshingLibrary] = createSignal(false);
  const [isRunningRemainingLlm, setIsRunningRemainingLlm] = createSignal(false);
  const [processingPackageName, setProcessingPackageName] = createSignal("");
  const [rerunningQuestionsPackageName, setRerunningQuestionsPackageName] = createSignal("");
  const [freshPackageName, setFreshPackageName] = createSignal("");
  const [isHelpOpen, setIsHelpOpen] = createSignal(false);
  const [restoredInitialSnippet, setRestoredInitialSnippet] = createSignal(false);
  const [restoredInitialSection, setRestoredInitialSection] = createSignal(false);
  const [projects, setProjects] = createSignal<ProjectRecord[]>(loadStoredProjects());
  const [hiddenMemoNames, setHiddenMemoNames] = createSignal<Set<string>>(loadStoredHiddenMemoNames());
  const [initialLibrary] = createResource(fetchVoiceMemoLibrary);
  const packages = createMemo(() => {
    const hidden = hiddenMemoNames();
    return allPackages().filter((pkg) => !hidden.has(pkg.name));
  });
  const hiddenMemoCount = createMemo(() => allPackages().filter((pkg) => hiddenMemoNames().has(pkg.name)).length);

  onMount(() => {
    let stickyPaneFrame = 0;
    const updateStickyPaneBounds = () => {
      stickyPaneFrame = 0;
      document.querySelectorAll<HTMLElement>(".memo-list, .evidence-pane").forEach((pane) => {
        const viewportTop = Math.max(16, Math.ceil(pane.getBoundingClientRect().top));
        pane.style.setProperty("--sticky-pane-viewport-top", `${viewportTop}px`);
      });
    };
    const scheduleStickyPaneUpdate = () => {
      if (stickyPaneFrame) return;
      stickyPaneFrame = window.requestAnimationFrame(updateStickyPaneBounds);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsHelpOpen(false);
    };
    const handlePopState = () => {
      const selection = readUrlSelection();
      setSelectedPackageName(selection.transcript ?? firstReadablePackage(packages())?.name ?? "");
      setSelectedOverlayId(selection.snippet ?? "");
      setWorkspaceView(selection.view ?? "review");
      setRestoredInitialSnippet(false);
      setRestoredInitialSection(false);
      window.requestAnimationFrame(() => scrollToSectionHash("smooth"));
    };
    const handleHashChange = () => {
      window.requestAnimationFrame(() => scrollToSectionHash("smooth"));
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("hashchange", handleHashChange);
    window.addEventListener("scroll", scheduleStickyPaneUpdate, { passive: true });
    window.addEventListener("resize", scheduleStickyPaneUpdate);
    scheduleStickyPaneUpdate();
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("hashchange", handleHashChange);
      window.removeEventListener("scroll", scheduleStickyPaneUpdate);
      window.removeEventListener("resize", scheduleStickyPaneUpdate);
      if (stickyPaneFrame) window.cancelAnimationFrame(stickyPaneFrame);
    });
  });

  createEffect(() => {
    const result = initialLibrary();
    if (!result) return;
    if (result.error) {
      setLoadError(result.error);
    } else if (result.library) {
      applyVoiceMemoLibrary(result.library, {
        preferredPackageName: initialUrlSelection.transcript ?? untrack(selectedPackageName),
        preferredOverlayId: initialUrlSelection.snippet ?? untrack(selectedOverlayId),
      });
      setLoadError("");
    }
    setIsLoading(false);
  });

  const packageCards = createMemo(() => {
    const term = packageSearch().trim().toLowerCase();
    return [...packages()]
      .sort((a, b) => comparePackages(a, b, packageSortMode()))
      .filter((pkg) => {
        if (!term) return true;
        const haystack = `${pkg.name} ${packageDisplayTitle(pkg)} ${pkg.status} ${pkg.transcriptSummary?.summary ?? ""} ${pkg.transcriptSummary?.topBullets.join(" ") ?? ""} ${pkg.segments.map((s) => s.title ?? s.gist ?? "").join(" ")}`;
        return haystack.toLowerCase().includes(term);
      });
  });
  const packageSortLabel = createMemo(() =>
    packageSortMode() === "updated"
      ? "Sorted by recently updated. Click to sort by needs process."
      : "Sorted by needs process. Click to sort by recently updated.",
  );

  const selectedPackage = createMemo(() => {
    return packages().find((pkg) => pkg.name === selectedPackageName()) ?? packages()[0];
  });

  createEffect(() => {
    if (isLoading()) return;
    if (!packages().length) return;
    const current = selectedPackageName();
    if (!packages().some((pkg) => pkg.name === current)) {
      setSelectedPackageName(firstReadablePackage(packages())?.name ?? packages()[0]?.name ?? "");
    }
  });

  const transcriptLines = createMemo(() => {
    const pkg = selectedPackage();
    return pkg ? normalizeTranscriptLines(pkg) : [];
  });
  const overlays = createMemo(() =>
    selectedPackage()
      ? buildOverlays(selectedPackage()!, transcriptLines()).filter(
          (overlay) => overlayFilter() === "all" || overlay.type === overlayFilter(),
        )
      : [],
  );
  const selectedPackageOverlayIds = createMemo(() => new Set(overlays().map((overlay) => overlay.id)));
  const selectedOverlay = createMemo(() => {
    return overlays().find((overlay) => overlay.id === selectedOverlayId());
  });
  const unmatchedItems = createMemo(() => overlays().filter((overlay) => overlay.quality === "unmatched"));
  const sections = createMemo(() => {
    const pkg = selectedPackage();
    return pkg ? buildSections(pkg, transcriptLines()) : [];
  });
  const audioUrl = createMemo(() => fileUrl(selectedPackage()?.audio));
  const selectedPackageQuestions = createMemo(() => followUpQuestionsForPackage(selectedPackage()));
  const sidebarReviewGroups = createMemo(() =>
    sidebarReviewSections.map((section) => ({
      ...section,
      overlays: overlays().filter((overlay) => overlay.type === section.value),
    })),
  );
  const projectRows = createMemo(() => {
    const term = projectSearch().trim().toLowerCase();
    return buildProjectRows(projects(), packages())
      .filter((row) => {
        if (!term) return true;
        const haystack = [
          row.project.name,
          row.project.description ?? "",
          row.summary,
          row.insights.join(" "),
          row.recordings.map((recording) => recording.title).join(" "),
        ].join(" ");
        return haystack.toLowerCase().includes(term);
      })
      .sort((a, b) => Date.parse(b.project.updatedAt) - Date.parse(a.project.updatedAt));
  });
  const unassignedRecordings = createMemo(() => buildUnassignedRecordingCards(projects(), packages()));
  const selectedPackageProjects = createMemo(() => projectsForPackage(projects(), selectedPackageName()));
  const collectedItems = createMemo(() => buildCollectedItemRows(packages()));
  const collectedTypeCounts = createMemo(() => countCollectedItemTypes(collectedItems()));
  const filteredCollectedItems = createMemo(() => {
    const filter = collectedTypeFilter();
    const rows = collectedItems();
    return filter === "all" ? rows : rows.filter((item) => item.type === filter);
  });
  const selectedSectionProjectIds = createMemo(() => {
    const map = new Map<string, Set<string>>();
    const packageName = selectedPackageName();
    for (const project of projects()) {
      for (const ref of project.sectionRefs) {
        if (ref.packageName !== packageName) continue;
        const projectIds = map.get(ref.sectionId) ?? new Set<string>();
        projectIds.add(project.id);
        map.set(ref.sectionId, projectIds);
      }
    }
    return map;
  });

  createEffect(() => {
    saveStoredProjects(projects());
  });

  createEffect(() => {
    saveStoredHiddenMemoNames(hiddenMemoNames());
  });

  function applyVoiceMemoLibrary(
    library: VoiceMemoLibrary,
    options: { preferredPackageName?: string; preferredOverlayId?: string; highlightNewPackages?: boolean } = {},
  ) {
    const previousNames = new Set(packages().map((pkg) => pkg.name));
    setAllPackages(library.packages);
    const preferredPackageName = options.preferredPackageName ?? selectedPackageName();
    const visiblePackages = library.packages.filter((pkg) => !hiddenMemoNames().has(pkg.name));
    const nextPackageName = visiblePackages.some((pkg) => pkg.name === preferredPackageName)
      ? preferredPackageName
      : firstReadablePackage(visiblePackages)?.name ?? visiblePackages[0]?.name ?? "";
    setSelectedPackageName(nextPackageName);
    setSelectedOverlayId(
      nextPackageName === preferredPackageName
        ? overlayIdForPackage(nextPackageName, options.preferredOverlayId ?? selectedOverlayId(), library.packages)
        : "",
    );

    if (options.highlightNewPackages) {
      const newestPackage = library.packages
        .filter((pkg) => !hiddenMemoNames().has(pkg.name))
        .filter((pkg) => !previousNames.has(pkg.name))
        .sort((a, b) => packageDate(b.name) - packageDate(a.name))[0];
      if (newestPackage) {
        setFreshPackageName(newestPackage.name);
        window.setTimeout(() => {
          setFreshPackageName((current) => (current === newestPackage.name ? "" : current));
        }, 1800);
      }
    }
  }

  createEffect(() => {
    if (isLoading()) return;
    if (!selectedPackage()) return;
    const current = selectedOverlayId();
    const available = overlays();
    if (!available.length) {
      if (current) setSelectedOverlayId("");
      return;
    }
    if (current && !available.some((overlay) => overlay.id === current)) {
      setSelectedOverlayId("");
    }
  });

  createEffect(() => {
    if (isLoading()) return;
    if (!packages().length) return;
    const packageName = selectedPackageName();
    const overlayId = selectedPackageOverlayIds().has(selectedOverlayId()) ? selectedOverlayId() : "";
    replaceUrlSelection({ transcript: packageName, snippet: overlayId, view: workspaceView() });
  });

  createEffect(() => {
    if (isLoading() || restoredInitialSnippet() || !initialUrlSelection.snippet) return;
    if (currentSectionHashId()) return;
    const overlay = selectedOverlay();
    if (!overlay || overlay.id !== selectedOverlayId()) return;
    setRestoredInitialSnippet(true);
    window.requestAnimationFrame(() => {
      document.getElementById(lineDomId(overlay.startLine))?.scrollIntoView({ block: "center" });
    });
  });

  createEffect(() => {
    if (isLoading() || restoredInitialSection() || !currentSectionHashId()) return;
    sections();
    window.requestAnimationFrame(() => {
      if (scrollToSectionHash("auto")) setRestoredInitialSection(true);
    });
  });

  async function loadVoiceMemoLibrary(
    options: { preferredPackageName?: string; preferredOverlayId?: string; highlightNewPackages?: boolean; showLoading?: boolean } = {},
  ) {
    try {
      if (options.showLoading !== false) setIsLoading(true);
      const result = await fetchVoiceMemoLibrary();
      if (result.error || !result.library) throw new Error(result.error || "Could not load voice memo packages.");
      const library = result.library;
      const urlSelection = readUrlSelection();
      applyVoiceMemoLibrary(library, {
        preferredPackageName: options.preferredPackageName ?? urlSelection.transcript ?? selectedPackageName(),
        preferredOverlayId: options.preferredOverlayId ?? urlSelection.snippet ?? selectedOverlayId(),
        highlightNewPackages: options.highlightNewPackages,
      });
      setLoadError("");
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Could not load voice memo packages.",
      );
    } finally {
      if (options.showLoading !== false) setIsLoading(false);
    }
  }

  async function refreshVoiceMemoLibrary() {
    if (isRefreshingLibrary()) return;
    const currentPackageName = selectedPackageName();
    const currentOverlayId = selectedOverlayId();
    try {
      setLoadError("");
      setIsRefreshingLibrary(true);
      const response = await fetch("/api/voice-memos/refresh", {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Voice memo refresh failed: ${response.status}`);
      }
      await loadVoiceMemoLibrary({
        preferredPackageName: currentPackageName,
        preferredOverlayId: currentOverlayId,
        highlightNewPackages: true,
        showLoading: false,
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Voice memo refresh failed.");
    } finally {
      setIsRefreshingLibrary(false);
    }
  }

  async function runLlmForRemainingPackages() {
    if (isRunningRemainingLlm() || isRefreshingLibrary() || processingPackageName()) return;
    const currentPackageName = selectedPackageName();
    const currentOverlayId = selectedOverlayId();
    try {
      setLoadError("");
      setIsRunningRemainingLlm(true);
      const response = await fetch("/api/voice-memos/run-llm-remaining", {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Remaining LLM processing failed: ${response.status}`);
      }
      if (payload.library) {
        applyVoiceMemoLibrary(payload.library, {
          preferredPackageName: currentPackageName,
          preferredOverlayId: currentOverlayId,
        });
      } else {
        await loadVoiceMemoLibrary({
          preferredPackageName: currentPackageName,
          preferredOverlayId: currentOverlayId,
          showLoading: false,
        });
      }
      setFreshPackageName(currentPackageName);
      window.setTimeout(() => {
        setFreshPackageName((current) => (current === currentPackageName ? "" : current));
      }, 1400);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Remaining LLM processing failed.");
    } finally {
      setIsRunningRemainingLlm(false);
    }
  }

  async function runLlmForSelectedPackage() {
    const name = selectedPackage()?.name;
    if (!name || processingPackageName()) return;
    try {
      setLoadError("");
      setProcessingPackageName(name);
      const response = await fetch(`/api/voice-memos/${encodeURIComponent(name)}/run-llm`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `LLM processing failed: ${response.status}`);
      }
      if (payload.package) {
        setAllPackages((current) =>
          current.map((memoPackage) =>
            memoPackage.name === name ? { ...memoPackage, ...payload.package } : memoPackage,
          ),
        );
      } else {
        await loadVoiceMemoLibrary();
      }
      setSelectedPackageName(name);
      setSelectedOverlayId("");
      setFreshPackageName(name);
      window.setTimeout(() => {
        setFreshPackageName((current) => (current === name ? "" : current));
      }, 1400);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "LLM processing failed.");
    } finally {
      setProcessingPackageName("");
    }
  }

  async function rerunFollowUpQuestionsForSelectedPackage() {
    const name = selectedPackage()?.name;
    if (!name || processingPackageName() || rerunningQuestionsPackageName()) return;
    try {
      setLoadError("");
      setRerunningQuestionsPackageName(name);
      const response = await fetch(`/api/voice-memos/${encodeURIComponent(name)}/rerun-follow-up-questions`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Follow-up question rerun failed: ${response.status}`);
      }
      if (payload.package) {
        setAllPackages((current) =>
          current.map((memoPackage) =>
            memoPackage.name === name ? { ...memoPackage, ...payload.package } : memoPackage,
          ),
        );
      } else {
        await loadVoiceMemoLibrary({
          preferredPackageName: name,
          preferredOverlayId: selectedOverlayId(),
          showLoading: false,
        });
      }
      setSelectedPackageName(name);
      setFreshPackageName(name);
      window.setTimeout(() => {
        setFreshPackageName((current) => (current === name ? "" : current));
      }, 1400);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Follow-up question rerun failed.");
    } finally {
      setRerunningQuestionsPackageName("");
    }
  }

  function jumpTo(ms: number | undefined, lineIndex?: number, play = true) {
    if (lineIndex != null) {
      document.getElementById(lineDomId(lineIndex))?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    if (ms == null || !audioRef) return;
    audioRef.currentTime = Math.max(0, ms / 1000);
    if (play) void audioRef.play().catch(() => {});
  }

  function selectOverlay(overlay: TranscriptOverlay, packageName = selectedPackageName()) {
    if (packageName && selectedPackageName() !== packageName) {
      setSelectedPackageName(packageName);
    }
    setSelectedOverlayId(overlay.id);
    jumpTo(sourceStartMs(overlay.item) ?? transcriptLines()[overlay.startLine]?.startMs, overlay.startLine, false);
  }

  function selectPackage(memoPackage: MemoPackage) {
    if (hiddenMemoNames().has(memoPackage.name)) return;
    const isAlreadySelected = selectedPackageName() === memoPackage.name;
    setSelectedPackageName(memoPackage.name);
    setSelectedOverlayId("");
    setRestoredInitialSnippet(true);
    setRestoredInitialSection(true);
    clearSectionHash();

    if (!isAlreadySelected) {
      setFreshPackageName(memoPackage.name);
      window.setTimeout(() => {
        setFreshPackageName((current) => (current === memoPackage.name ? "" : current));
      }, 760);
    }

    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".transcript-pane")?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    });
  }

  function hidePackage(packageName: string) {
    if (!packageName) return;
    setHiddenMemoNames((current) => new Set([...current, packageName]));
    setSelectedOverlayId("");
    const nextPackage = firstReadablePackage(packages().filter((pkg) => pkg.name !== packageName));
    setSelectedPackageName(nextPackage?.name ?? "");
    clearSectionHash();
  }

  function restorePackage(packageName: string) {
    setHiddenMemoNames((current) => {
      const next = new Set(current);
      next.delete(packageName);
      return next;
    });
  }

  function restoreAndOpenPackage(memoPackage: MemoPackage) {
    restorePackage(memoPackage.name);
    setWorkspaceView("review");
    window.requestAnimationFrame(() => selectPackage(memoPackage));
  }

  function createProject() {
    setWorkspaceView("projects");
    setIsProjectComposerOpen(true);
    window.requestAnimationFrame(() => {
      document.getElementById("new-project-name")?.focus();
    });
    return undefined;
  }

  function saveNewProject() {
    const name = newProjectName().trim();
    if (!name) return undefined;
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: `project-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      color: projectColor(projects().length),
      createdAt: now,
      updatedAt: now,
      recordingNames: [],
      sectionRefs: [],
    };
    setProjects((current) => [project, ...current]);
    setNewProjectName("");
    setIsProjectComposerOpen(false);
    return project.id;
  }

  function assignSelectedPackageToProject(projectId: string) {
    const packageName = selectedPackage()?.name;
    if (!packageName) return;
    assignPackageNameToProject(packageName, projectId);
  }

  function assignPackageNameToProject(packageName: string, projectId: string) {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? touchProject({
              ...project,
              recordingNames: project.recordingNames.includes(packageName)
                ? project.recordingNames
                : [...project.recordingNames, packageName],
            })
          : project,
      ),
    );
  }

  function moveRecordingCardToProject(recording: ProjectRecordingCard, projectId: string) {
    const now = new Date().toISOString();
    setProjects((current) =>
      current.map((project) => {
        if (recording.kind === "section" && recording.sectionId) {
          const sectionRefs = project.sectionRefs.filter(
            (ref) => ref.packageName !== recording.packageName || ref.sectionId !== recording.sectionId,
          );
          if (project.id !== projectId) return sectionRefs.length === project.sectionRefs.length ? project : { ...project, sectionRefs };
          const nextRef: ProjectSectionRef = {
            packageName: recording.packageName,
            sectionId: recording.sectionId,
            title: recording.title,
            startMs: recording.startMs,
            endMs: recording.endMs ?? recording.startMs,
            assignedAt: now,
          };
          return touchProject({ ...project, sectionRefs: [...sectionRefs, nextRef] });
        }

        const recordingNames = project.recordingNames.filter((name) => name !== recording.packageName);
        if (project.id !== projectId) return recordingNames.length === project.recordingNames.length ? project : { ...project, recordingNames };
        return touchProject({ ...project, recordingNames: [...recordingNames, recording.packageName] });
      }),
    );
  }

  function renameProject(projectId: string, currentName: string) {
    const nextName = window.prompt("Rename project", currentName)?.trim();
    if (!nextName || nextName === currentName) return;
    setProjects((current) =>
      current.map((project) => (project.id === projectId ? touchProject({ ...project, name: nextName }) : project)),
    );
  }

  function removeSelectedPackageFromProject(projectId: string) {
    const packageName = selectedPackage()?.name;
    if (!packageName) return;
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? touchProject({
              ...project,
              recordingNames: project.recordingNames.filter((name) => name !== packageName),
            })
          : project,
      ),
    );
  }

  function assignSectionToProject(section: TranscriptSection, projectId: string) {
    const packageName = selectedPackage()?.name;
    if (!packageName) return;
    const ref: ProjectSectionRef = {
      packageName,
      sectionId: section.id,
      title: section.title,
      startMs: section.startMs,
      endMs: section.endMs,
      assignedAt: new Date().toISOString(),
    };
    setProjects((current) =>
      current.map((project) => {
        if (project.id !== projectId) return project;
        const alreadyAssigned = project.sectionRefs.some(
          (item) => item.packageName === ref.packageName && item.sectionId === ref.sectionId,
        );
        return alreadyAssigned ? project : touchProject({ ...project, sectionRefs: [...project.sectionRefs, ref] });
      }),
    );
  }

  function removeSectionFromProject(section: TranscriptSection, projectId: string) {
    const packageName = selectedPackage()?.name;
    if (!packageName) return;
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? touchProject({
              ...project,
              sectionRefs: project.sectionRefs.filter(
                (item) => item.packageName !== packageName || item.sectionId !== section.id,
              ),
            })
          : project,
      ),
    );
  }

  function deleteProject(projectId: string) {
    setProjects((current) => current.filter((project) => project.id !== projectId));
  }

  function assignSectionFromSelect(section: TranscriptSection, value: string) {
    if (!value) return;
    const projectId = value === "__new__" ? createProject() : value;
    if (projectId) assignSectionToProject(section, projectId);
  }

  function openProjectRecording(recording: ProjectRecordingCard) {
    const memoPackage = packages().find((pkg) => pkg.name === recording.packageName);
    if (!memoPackage) return;
    setWorkspaceView("review");
    selectPackage(memoPackage);
    if (recording.kind === "section") {
      window.requestAnimationFrame(() => {
        const section = buildSections(memoPackage, normalizeTranscriptLines(memoPackage)).find((item) =>
          recording.id.endsWith(`::${item.id}`),
        );
        if (section) {
          const url = new URL(window.location.href);
          url.hash = sectionDomId(section.id);
          window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
          scrollToSectionHash("smooth");
        }
      });
    }
  }

  function openCollectedItem(row: CollectedItemRow) {
    const memoPackage = packages().find((pkg) => pkg.name === row.packageName);
    if (!memoPackage) return;
    setWorkspaceView("review");
    selectPackage(memoPackage);
    if (row.reviewItem) {
      setSelectedOverlayId(row.reviewItem.id);
      const lines = normalizeTranscriptLines(memoPackage);
      const overlay = buildOverlays(memoPackage, lines).find((item) => item.id === row.reviewItem?.id);
      if (overlay) {
        window.requestAnimationFrame(() => {
          jumpTo(sourceStartMs(row.reviewItem!) ?? lines[overlay.startLine]?.startMs, overlay.startLine, false);
        });
      }
      return;
    }
    const segmentId = row.question?.sectionId ?? row.question?.source?.segmentId ?? row.question?.sourceSegments?.[0]?.segmentId;
    if (segmentId) {
      window.requestAnimationFrame(() => {
        const url = new URL(window.location.href);
        url.hash = sectionDomId(segmentId);
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        scrollToSectionHash("smooth");
      });
    }
  }

  function showMoreProjectCards(projectId: string) {
    setProjectCardLimit((current) => ({
      ...current,
      [projectId]: Number.MAX_SAFE_INTEGER,
    }));
  }

  function showLessProjectCards(projectId: string) {
    setProjectCardLimit((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  }

  function linkToSection(section: TranscriptSection, event: MouseEvent) {
    event.preventDefault();
    const sectionId = sectionDomId(section.id);
    const url = new URL(window.location.href);
    url.hash = sectionId;
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
    scrollToSectionHash("smooth");
  }

  return (
    <main class="shell">
      <header class="masthead">
        <div class="masthead-copy">
          <h1>Voice memo review</h1>
        </div>
        <div class="view-switch" aria-label="Workspace view">
          <button
            classList={{ selected: workspaceView() === "review" }}
            type="button"
            onClick={() => setWorkspaceView("review")}
          >
            Review
          </button>
          <button
            classList={{ selected: workspaceView() === "projects" }}
            type="button"
            onClick={() => setWorkspaceView("projects")}
          >
            Projects
          </button>
          <button
            classList={{ selected: workspaceView() === "items" }}
            type="button"
            onClick={() => setWorkspaceView("items")}
          >
            Items
          </button>
          <button
            classList={{ selected: workspaceView() === "memos" }}
            type="button"
            onClick={() => setWorkspaceView("memos")}
          >
            All memos
          </button>
        </div>
        <Popover
          class="top-actions-menu"
          panelClass="top-actions-popover"
          triggerLabel="Application actions"
          trigger="..."
          content={({ close }) => (
            <>
              <ActionButton
                variant="menu"
                onClick={() => {
                  setIsHelpOpen(true);
                  close();
                }}
              >
                Help
              </ActionButton>
              <ActionButton
                variant="menu"
                disabled={isRefreshingLibrary() || isRunningRemainingLlm()}
                onClick={() => {
                  void refreshVoiceMemoLibrary();
                  close();
                }}
              >
                {isRefreshingLibrary() ? "Refreshing" : "Refresh recordings"}
              </ActionButton>
              <ActionButton
                variant="menu"
                disabled={isRefreshingLibrary() || isRunningRemainingLlm() || !!processingPackageName()}
                onClick={() => {
                  void runLlmForRemainingPackages();
                  close();
                }}
              >
                {isRunningRemainingLlm() ? "Processing remaining" : "Run LLM on remaining"}
              </ActionButton>
            </>
          )}
        />
      </header>

      <Show when={loadError()}>
        <div class="error">{loadError()}</div>
      </Show>

      <Show
        when={workspaceView() !== "review"}
        fallback={
      <section class="transcript-workspace" aria-busy={isLoading() && !packages().length}>
        <aside class="memo-list" aria-label="Voice transcripts">
          <div class="pane-head">
            <div>
              <h2>Transcripts</h2>
            </div>
            <button
              class="sort-toggle"
              type="button"
              aria-label={packageSortLabel()}
              aria-pressed={packageSortMode() === "needs_process"}
              title={packageSortLabel()}
              data-mode={packageSortMode()}
              onClick={() => setPackageSortMode((mode) => (mode === "updated" ? "needs_process" : "updated"))}
            >
              <span class="sort-icon" aria-hidden="true"></span>
            </button>
          </div>
          <div class="control-block">
            <input
              id="memo-search"
              aria-label="Search transcripts"
              value={packageSearch()}
              onInput={(event) => setPackageSearch(event.currentTarget.value)}
              placeholder="Memo name or section"
            />
          </div>
          <div class="memo-scroll">
            <Suspense fallback={<MemoListSkeleton />}>
              <AwaitResource resource={initialLibrary}>
                <For each={packageCards()} fallback={<EmptyState text="No transcripts found." />}>
                  {(memoPackage) => (
                    <button
                      classList={{
                        memoCard: true,
                        selected: selectedPackage()?.name === memoPackage.name,
                        fresh: freshPackageName() === memoPackage.name,
                      }}
                      type="button"
                      aria-current={selectedPackage()?.name === memoPackage.name ? "true" : undefined}
                      onClick={() => selectPackage(memoPackage)}
                    >
                      <strong>{packageDisplayTitle(memoPackage)}</strong>
                      <span class="memo-subline">
                        <span>{packageDateLabel(memoPackage.name)}</span>
                        <span>{memoPackage.status.replaceAll("_", " ")}</span>
                      </span>
                      <span class="memo-meta">
                        {memoPackage.transcript.length} lines · {memoPackage.segments.length} sections
                        <Show when={packageDurationMs(memoPackage)}>
                          {(durationMs) => <> · {formatDuration(durationMs())} audio</>}
                        </Show>{" "}
                        · {memoPackage.reviewItems.length} overlays
                      </span>
                    </button>
                  )}
                </For>
              </AwaitResource>
            </Suspense>
          </div>
        </aside>

        <section
          classList={{
            "transcript-pane": true,
            "fresh-content": freshPackageName() === selectedPackage()?.name,
          }}
          aria-label="Transcript"
        >
          <Suspense fallback={<TranscriptPaneSkeleton />}>
            <AwaitResource resource={initialLibrary}>
              <div class="transcript-toolbar">
                <div class="transcript-toolbar-main">
                  <div class="transcript-title-block">
                    <h2>{selectedPackage() ? packageDisplayTitle(selectedPackage()!) : "No transcript selected"}</h2>
                    <p>
                      {transcriptLines().length} transcript lines · {selectedPackage()?.reviewItems.length ?? 0} extracted items
                    </p>
                  </div>
                  <div class="transcript-toolbar-actions">
                    <ReviewActionsMenu
                      canRunLlm={
                        !!selectedPackage() &&
                        !processingPackageName() &&
                        !isRunningRemainingLlm() &&
                        !rerunningQuestionsPackageName()
                      }
                      runLlmLabel={processingPackageName() === selectedPackage()?.name ? "Processing" : "Run LLM"}
                      canRerunQuestions={!!selectedPackage() && !processingPackageName() && !rerunningQuestionsPackageName()}
                      rerunQuestionsLabel={
                        rerunningQuestionsPackageName() === selectedPackage()?.name ? "Rerunning" : "Rerun questions"
                      }
                      onRunLlm={() => void runLlmForSelectedPackage()}
                      onRerunQuestions={() => void rerunFollowUpQuestionsForSelectedPackage()}
                      canHide={!!selectedPackage()}
                      onHide={() => {
                        const name = selectedPackage()?.name;
                        if (name) hidePackage(name);
                      }}
                      markdown={() => (selectedPackage() ? buildPackageMarkdown(selectedPackage()!) : "")}
                      filename={() => markdownFilename(selectedPackage() ? packageDisplayTitle(selectedPackage()!) : "transcript")}
                    />
                  </div>
                </div>
                <div class="overlay-filter" aria-label="Overlay filter">
                  <For each={overlayFilters}>
                    {(filter) => (
                      <button
                        classList={{ selected: overlayFilter() === filter.value }}
                        onClick={() => setOverlayFilter(filter.value)}
                      >
                        {filter.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <Show when={selectedPackage()?.transcriptSummary?.summary}>
                {(summary) => (
                  <div class="memo-summary">
                    <strong>Summary</strong>
                    <p>{summary()}</p>
                  </div>
                )}
              </Show>

              <Show when={selectedPackage()?.transcriptSummary?.topBullets.length}>
                <section class="key-points" aria-labelledby="key-points-title">
                  <div class="key-points-heading">
                    <strong id="key-points-title">Key points</strong>
                    <p>Generated takeaways used to navigate the transcript and extracted overlays.</p>
                  </div>
                  <ol>
                  <For each={selectedPackage()?.transcriptSummary?.topBullets ?? []}>
                    {(bullet) => <li>{bullet}</li>}
                  </For>
                  </ol>
                </section>
              </Show>

              <Show when={sections().length} fallback={<EmptyState text="No transcript text loaded." />}>
                <div class="transcript-document">
                  <For each={sections()}>
                    {(section) => (
                      <article class="transcript-section" id={sectionDomId(section.id)}>
                        <header>
                          <div class="section-heading-row">
                            <h3>
                              <a
                                class="section-title-link"
                                href={`#${sectionDomId(section.id)}`}
                                onClick={(event) => linkToSection(section, event)}
                              >
                                {section.title}
                              </a>
                            </h3>
                            <div class="section-project-tools">
                              <ExportMarkdownActions
                                label="section transcript"
                                size="sm"
                                markdown={() => buildSectionMarkdown(section, selectedPackage())}
                                filename={() =>
                                  markdownFilename(
                                    selectedPackage()
                                      ? `${packageDisplayTitle(selectedPackage()!)}-${section.title}`
                                      : section.title,
                                  )
                                }
                              />
                              <Show when={projects().length}>
                                <select
                                  aria-label={`Assign ${section.title} to project`}
                                  value=""
                                  onChange={(event) => {
                                    assignSectionFromSelect(section, event.currentTarget.value);
                                    event.currentTarget.value = "";
                                  }}
                                >
                                  <option value="">Assign section</option>
                                  <For each={projects()}>
                                    {(project) => <option value={project.id}>{project.name}</option>}
                                  </For>
                                  <option value="__new__">New project...</option>
                                </select>
                              </Show>
                            </div>
                          </div>
                          <Show when={selectedSectionProjectIds().get(section.id)?.size}>
                            <div class="section-project-tags" aria-label="Section project assignments">
                              <For each={projects().filter((project) => selectedSectionProjectIds().get(section.id)?.has(project.id))}>
                                {(project) => (
                                  <button type="button" onClick={() => removeSectionFromProject(section, project.id)}>
                                    <span class="project-color-dot" style={{ "background-color": project.color }}></span>
                                    {project.name}
                                    <span aria-hidden="true">x</span>
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                          <Show when={section.summary}>
                            {(summary) => (
                              <div class="memo-summary section-summary">
                                <strong>Section summary</strong>
                                <p>{summary()}</p>
                              </div>
                            )}
                          </Show>
                        </header>
                        <Show
                          when={section.lines.length}
                          fallback={<p class="transcript-line synthetic">{section.fallbackText}</p>}
                        >
                          <For each={section.lines}>
                            {(line) => (
                              <p class="transcript-line" id={lineDomId(line.index)}>
                                <button class="line-time" onClick={() => jumpTo(line.startMs, line.index)}>
                                  {formatTime(line.startMs)}
                                </button>
                                <span class="transcript-text">
                                  {renderLine(line, overlays(), selectedOverlay()?.id, (overlay) =>
                                    selectOverlay(overlay, selectedPackage()?.name),
                                  )}
                                </span>
                              </p>
                            )}
                          </For>
                        </Show>
                      </article>
                    )}
                  </For>
                </div>
              </Show>
            </AwaitResource>
          </Suspense>
        </section>

        <aside class="evidence-pane" aria-label="Evidence detail">
          <Suspense fallback={<EvidencePaneSkeleton />}>
            <AwaitResource resource={initialLibrary}>
              <PanelTitle title="Audio" />
              <Show when={audioUrl()} fallback={<div class="empty compact">No audio file loaded.</div>}>
                {(url) => <audio ref={audioRef} controls src={url()} />}
              </Show>

              <PanelTitle title="Projects" />
              <div class="project-assignment-panel">
                <Show
                  when={projects().length}
                  fallback={
                    <button class="secondary-action" type="button" onClick={() => createProject()}>
                      + New project
                    </button>
                  }
                >
                  <label for="recording-project-select">Add whole recording</label>
                  <select
                    id="recording-project-select"
                    value=""
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (!value) return;
                      const projectId = value === "__new__" ? createProject() : value;
                      if (projectId) assignSelectedPackageToProject(projectId);
                      event.currentTarget.value = "";
                    }}
                  >
                    <option value="">Choose project</option>
                    <For each={projects()}>
                      {(project) => <option value={project.id}>{project.name}</option>}
                    </For>
                    <option value="__new__">New project...</option>
                  </select>
                  <div class="assigned-project-list">
                    <For each={selectedPackageProjects()} fallback={<span>No project assignments.</span>}>
                      {(project) => (
                        <button type="button" onClick={() => removeSelectedPackageFromProject(project.id)}>
                          <span class="project-color-dot" style={{ "background-color": project.color }}></span>
                          {project.name}
                          <span aria-hidden="true">x</span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <PanelTitle title="Review sections" />
              <SidebarReviewStack
                questions={selectedPackageQuestions()}
                groups={sidebarReviewGroups()}
                selectedOverlayId={selectedOverlay()?.id}
                onSelectOverlay={(overlay) => selectOverlay(overlay, selectedPackage()?.name)}
              />

              <PanelTitle title="Selected overlay" />
              <Show when={selectedOverlay()} fallback={<EmptyState text="Select a snippet to inspect its evidence." />}>
                {(overlay) => (
                  <div class="overlay-detail">
                    <div class="detail-kicker">
                      <span class={`type type-${overlay().type}`}>{overlayLabels[overlay().type]}</span>
                      <span>{qualityLabel(overlay().quality)}</span>
                    </div>
                    <h3>{overlay().item.title}</h3>
                    <p>{overlay().item.body ?? overlay().item.item?.text ?? overlay().item.item?.excerpt}</p>
                    <dl>
                      <dt>Time</dt>
                      <dd>{formatRange(overlay().item)}</dd>
                      <dt>Source</dt>
                      <dd>{sourceLabel(overlay().item)}</dd>
                      <dt>Excerpt</dt>
                      <dd>{overlay().item.item?.excerpt || overlay().snippet || "None"}</dd>
                    </dl>
                    <button
                      class="primary-action"
                      onClick={() =>
                        jumpTo(
                          sourceStartMs(overlay().item) ?? transcriptLines()[overlay().startLine]?.startMs,
                          overlay().startLine,
                        )
                      }
                    >
                      Play from source
                    </button>
                  </div>
                )}
              </Show>

              <Show when={unmatchedItems().length}>
                <PanelTitle title="Needs better evidence" />
                <div class="unmatched-list">
                  <For each={unmatchedItems()}>
                    {(overlay) => <span>{overlay.item.title}</span>}
                  </For>
                </div>
              </Show>
            </AwaitResource>
          </Suspense>
        </aside>
      </section>
        }
      >
        <Show
          when={workspaceView() === "projects"}
          fallback={
            <Show
              when={workspaceView() === "items"}
              fallback={
                <AllMemosWorkspace
                  packages={allPackages()}
                  hiddenMemoNames={hiddenMemoNames()}
                  visibleCount={packages().length}
                  hiddenCount={hiddenMemoCount()}
                  onHide={hidePackage}
                  onRestore={restorePackage}
                  onOpen={restoreAndOpenPackage}
                />
              }
            >
              <CollectedItemsWorkspace
                rows={filteredCollectedItems()}
                totalCount={collectedItems().length}
                filter={collectedTypeFilter()}
                typeCounts={collectedTypeCounts()}
                onFilter={setCollectedTypeFilter}
                onOpen={openCollectedItem}
              />
            </Show>
          }
        >
          <ProjectsWorkspace
            rows={projectRows()}
            unassignedRecordings={unassignedRecordings()}
            search={projectSearch()}
            cardLimit={projectCardLimit()}
            selectedCountTypes={projectCardCountTypes()}
            onSearch={setProjectSearch}
            onToggleCountType={(type) => toggleProjectCardCountType(type, setProjectCardCountTypes)}
            isComposerOpen={isProjectComposerOpen()}
            newProjectName={newProjectName()}
            onNewProjectName={setNewProjectName}
            onCreateProject={createProject}
            onSaveProject={saveNewProject}
            onCancelProject={() => {
              setNewProjectName("");
              setIsProjectComposerOpen(false);
            }}
            onDeleteProject={deleteProject}
            onRenameProject={renameProject}
            onOpenRecording={openProjectRecording}
            onMoveRecording={moveRecordingCardToProject}
            onShowMore={showMoreProjectCards}
            onShowLess={showLessProjectCards}
            projectMarkdown={(row) => buildProjectMarkdown(row.project, packages())}
          />
        </Show>
      </Show>

      <Show when={isHelpOpen()}>
        <ProcessHelpModal onClose={() => setIsHelpOpen(false)} />
      </Show>
    </main>
  );
}

function ExportMarkdownActions(props: {
  label: string;
  markdown: () => string;
  filename: () => string;
  size?: "md" | "sm";
}) {
  const [copyStatus, setCopyStatus] = createSignal<"idle" | "copied" | "failed">("idle");
  let resetTimer: number | undefined;

  onCleanup(() => {
    if (resetTimer) window.clearTimeout(resetTimer);
  });

  const resetStatusSoon = () => {
    if (resetTimer) window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => setCopyStatus("idle"), 1600);
  };

  const copyLabel = () => {
    if (copyStatus() === "copied") return "Copied";
    if (copyStatus() === "failed") return "Copy failed";
    return "Copy Markdown";
  };
  const hasMarkdown = () => !!props.markdown().trim();

  return (
    <div class="markdown-export-actions" aria-label={`Export ${props.label}`}>
      <ActionButton
        variant="primary"
        size={props.size}
        disabled={!hasMarkdown()}
        onClick={async () => {
          const markdown = props.markdown().trim();
          if (!markdown) return;
          const copied = await copyMarkdown(markdown);
          setCopyStatus(copied ? "copied" : "failed");
          resetStatusSoon();
        }}
      >
        {copyLabel()}
      </ActionButton>
      <ActionButton
        variant="secondary"
        size={props.size}
        disabled={!hasMarkdown()}
        onClick={() => {
          const markdown = props.markdown().trim();
          if (!markdown) return;
          downloadMarkdownFile(props.filename(), markdown);
        }}
      >
        Download .md
      </ActionButton>
    </div>
  );
}

function ProjectExportMenu(props: {
  markdown: () => string;
  filename: () => string;
  onRenameProject: () => void;
  onDissolveProject: () => void;
}) {
  const [copyStatus, setCopyStatus] = createSignal<"idle" | "copied" | "failed">("idle");
  let resetTimer: number | undefined;
  const hasMarkdown = () => !!props.markdown().trim();

  onCleanup(() => {
    if (resetTimer) window.clearTimeout(resetTimer);
  });

  const resetStatusSoon = () => {
    if (resetTimer) window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => setCopyStatus("idle"), 1600);
  };

  const copyLabel = () => {
    if (copyStatus() === "copied") return "Copied";
    if (copyStatus() === "failed") return "Copy failed";
    return "Copy";
  };

  return (
    <Popover
      class="project-export-menu"
      panelClass="project-export-popover"
      triggerLabel="Project export actions"
      trigger="..."
      content={({ close }) => (
        <>
          <ActionButton
            variant="menu"
            onClick={() => {
              props.onRenameProject();
              close();
            }}
          >
            Rename project
          </ActionButton>
          <span class="review-actions-divider" aria-hidden="true"></span>
          <ActionButton
            variant="menu"
            disabled={!hasMarkdown()}
            onClick={async () => {
              const markdown = props.markdown().trim();
              if (!markdown) return;
              const copied = await copyMarkdown(markdown);
              setCopyStatus(copied ? "copied" : "failed");
              resetStatusSoon();
              if (copied) close();
            }}
          >
            {copyLabel()}
          </ActionButton>
          <ActionButton
            variant="menu"
            disabled={!hasMarkdown()}
            onClick={() => {
              const markdown = props.markdown().trim();
              if (!markdown) return;
              downloadMarkdownFile(props.filename(), markdown);
              close();
            }}
          >
            Download
          </ActionButton>
          <span class="review-actions-divider" aria-hidden="true"></span>
          <ActionButton
            variant="menu"
            class="app-button-menu-danger"
            onClick={() => {
              props.onDissolveProject();
              close();
            }}
          >
            Dissolve project
          </ActionButton>
        </>
      )}
    />
  );
}

function Popover(props: {
  class: string;
  panelClass: string;
  trigger: JSX.Element;
  triggerLabel?: string;
  content: (controls: { close: () => void }) => JSX.Element;
}) {
  let detailsRef: HTMLDetailsElement | undefined;

  const close = () => {
    if (detailsRef) detailsRef.open = false;
  };

  onMount(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!detailsRef?.open) return;
      const target = event.target;
      if (target instanceof Node && detailsRef.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !detailsRef?.open) return;
      event.preventDefault();
      close();
      detailsRef.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    });
  });

  return (
    <details class={`popover-root ${props.class}`} ref={detailsRef}>
      <summary aria-label={props.triggerLabel} title={props.triggerLabel}>
        {props.trigger}
      </summary>
      <div class={`popover-panel ${props.panelClass}`}>
        {props.content({ close })}
      </div>
    </details>
  );
}

function ReviewActionsMenu(props: {
  canRunLlm: boolean;
  runLlmLabel: string;
  canRerunQuestions: boolean;
  rerunQuestionsLabel: string;
  canHide: boolean;
  onRunLlm: () => void;
  onRerunQuestions: () => void;
  onHide: () => void;
  markdown: () => string;
  filename: () => string;
}) {
  let resetTimer: number | undefined;
  const [copyStatus, setCopyStatus] = createSignal<"idle" | "copied" | "failed">("idle");
  const hasMarkdown = () => !!props.markdown().trim();

  onCleanup(() => {
    if (resetTimer) window.clearTimeout(resetTimer);
  });

  const resetStatusSoon = () => {
    if (resetTimer) window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => setCopyStatus("idle"), 1600);
  };
  const copyLabel = () => {
    if (copyStatus() === "copied") return "Copied Markdown";
    if (copyStatus() === "failed") return "Copy failed";
    return "Copy Markdown";
  };

  return (
    <Popover
      class="review-actions-menu"
      panelClass="review-actions-popover"
      triggerLabel="Review actions"
      trigger="..."
      content={({ close }) => (
      <>
        <ActionButton
          variant="menu"
          disabled={!props.canRunLlm}
          onClick={() => {
            props.onRunLlm();
            close();
          }}
        >
          {props.runLlmLabel}
        </ActionButton>
        <ActionButton
          variant="menu"
          disabled={!props.canRerunQuestions}
          onClick={() => {
            props.onRerunQuestions();
            close();
          }}
        >
          {props.rerunQuestionsLabel}
        </ActionButton>
        <ActionButton
          variant="menu"
          disabled={!props.canHide}
          onClick={() => {
            props.onHide();
            close();
          }}
        >
          Hide memo
        </ActionButton>
        <span class="review-actions-divider" aria-hidden="true"></span>
        <ActionButton
          variant="menu"
          disabled={!hasMarkdown()}
          onClick={async () => {
            const markdown = props.markdown().trim();
            if (!markdown) return;
            const copied = await copyMarkdown(markdown);
            setCopyStatus(copied ? "copied" : "failed");
            resetStatusSoon();
            if (copied) close();
          }}
        >
          {copyLabel()}
        </ActionButton>
        <ActionButton
          variant="menu"
          disabled={!hasMarkdown()}
          onClick={() => {
            const markdown = props.markdown().trim();
            if (!markdown) return;
            downloadMarkdownFile(props.filename(), markdown);
            close();
          }}
        >
          Download .md
        </ActionButton>
      </>
      )}
    />
  );
}

function CollectedItemsWorkspace(props: {
  rows: CollectedItemRow[];
  totalCount: number;
  filter: CollectedItemType | "all";
  typeCounts: Map<CollectedItemType, number>;
  onFilter: (type: CollectedItemType | "all") => void;
  onOpen: (row: CollectedItemRow) => void;
}) {
  const filters = () => collectedItemFilterOptions(props.typeCounts);

  return (
    <section class="collected-items-workspace" aria-label="Collected items">
      <header class="collected-items-toolbar">
        <div>
          <h2>Collected items</h2>
          <p>
            {props.rows.length} shown · {props.totalCount} total questions, tasks, claims, quotes, and flags
          </p>
        </div>
      </header>

      <div class="collected-items-layout">
        <aside class="collected-items-filter" aria-label="Filter collected items by type">
          <h3>Type</h3>
          <For each={filters()}>
            {(filter) => (
              <button
                classList={{ selected: props.filter === filter.value }}
                type="button"
                onClick={() => props.onFilter(filter.value)}
              >
                <span>{filter.label}</span>
                <span>{filter.count}</span>
              </button>
            )}
          </For>
        </aside>

        <div class="collected-items-table" role="table" aria-label="Collected questions and review items">
          <div class="collected-items-head" role="row">
            <span role="columnheader">Type</span>
            <span role="columnheader">Item</span>
            <span role="columnheader">Original quote</span>
            <span role="columnheader">Memo</span>
          </div>
          <For each={props.rows} fallback={<EmptyState text="No collected items match this filter." />}>
            {(row) => (
              <button class="collected-item-row" type="button" role="row" onClick={() => props.onOpen(row)}>
                <span class="collected-item-cell collected-item-type-cell" role="cell">
                  <span class={`type type-${row.type}`}>{collectedTypeLabels[row.type]}</span>
                  <span>{row.time}</span>
                </span>
                <span class="collected-item-cell collected-item-content-cell" role="cell">
                  <strong>{row.title}</strong>
                  <span>{row.content}</span>
                </span>
                <span class="collected-item-cell collected-item-quote-cell" role="cell">
                  {row.quote || "No source quote captured."}
                </span>
                <span class="collected-item-cell collected-item-source-cell" role="cell">
                  <strong>{row.packageTitle}</strong>
                  <span>{row.source}</span>
                </span>
              </button>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}

function AllMemosWorkspace(props: {
  packages: MemoPackage[];
  hiddenMemoNames: Set<string>;
  visibleCount: number;
  hiddenCount: number;
  onHide: (packageName: string) => void;
  onRestore: (packageName: string) => void;
  onOpen: (memoPackage: MemoPackage) => void;
}) {
  const sortedPackages = () => [...props.packages].sort(compareRecentlyUpdatedPackages);

  return (
    <section class="all-memos-workspace" aria-label="All voice memos">
      <header class="all-memos-toolbar">
        <div>
          <h2>All voice memos</h2>
          <p>
            {props.visibleCount} visible · {props.hiddenCount} hidden · {props.packages.length} total
          </p>
        </div>
      </header>

      <div class="all-memos-table" role="table" aria-label="Voice memo visibility">
        <div class="all-memos-head" role="row">
          <span role="columnheader">Memo</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Length</span>
          <span role="columnheader">Visibility</span>
          <span role="columnheader">Actions</span>
        </div>
        <For each={sortedPackages()} fallback={<EmptyState text="No voice memos loaded." />}>
          {(memoPackage) => {
            const isHidden = () => props.hiddenMemoNames.has(memoPackage.name);
            return (
              <article class="all-memos-row" role="row" classList={{ hidden: isHidden() }}>
                <div class="all-memos-cell memo-name-cell" role="cell">
                  <strong>{packageDisplayTitle(memoPackage)}</strong>
                  <span>{memoPackage.name}</span>
                </div>
                <div class="all-memos-cell" role="cell">
                  <span>{memoPackage.status.replaceAll("_", " ")}</span>
                  <span>
                    {memoPackage.transcript.length} lines · {memoPackage.segments.length} sections
                  </span>
                </div>
                <div class="all-memos-cell" role="cell">
                  <span>{packageDurationMs(memoPackage) ? formatDuration(packageDurationMs(memoPackage)!) : "Unknown"}</span>
                </div>
                <div class="all-memos-cell" role="cell">
                  <span class="visibility-badge" data-hidden={isHidden() ? "true" : "false"}>
                    {isHidden() ? "Hidden" : "Visible"}
                  </span>
                </div>
                <div class="all-memos-cell all-memos-actions" role="cell">
                  <Show
                    when={isHidden()}
                    fallback={
                      <>
                        <ActionButton size="sm" variant="secondary" onClick={() => props.onOpen(memoPackage)}>
                          Open
                        </ActionButton>
                        <ActionButton size="sm" variant="secondary" onClick={() => props.onHide(memoPackage.name)}>
                          Hide
                        </ActionButton>
                      </>
                    }
                  >
                    <ActionButton size="sm" variant="primary" onClick={() => props.onOpen(memoPackage)}>
                      Restore
                    </ActionButton>
                  </Show>
                </div>
              </article>
            );
          }}
        </For>
      </div>
    </section>
  );
}

function ActionButton(props: {
  children: JSX.Element;
  variant?: "primary" | "secondary" | "danger" | "menu";
  size?: "md" | "sm";
  type?: "button" | "submit";
  disabled?: boolean;
  class?: string;
  onClick?: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
}) {
  return (
    <button
      classList={{
        "app-button": true,
        [`app-button-${props.variant ?? "secondary"}`]: true,
        [`app-button-${props.size ?? "md"}`]: true,
        [props.class ?? ""]: !!props.class,
      }}
      type={props.type ?? "button"}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function ProjectsWorkspace(props: {
  rows: ProjectRow[];
  unassignedRecordings: ProjectRecordingCard[];
  search: string;
  cardLimit: Record<string, number>;
  selectedCountTypes: Set<ProjectCardCountType>;
  isComposerOpen: boolean;
  newProjectName: string;
  onSearch: (value: string) => void;
  onToggleCountType: (type: ProjectCardCountType) => void;
  onNewProjectName: (value: string) => void;
  onCreateProject: () => string | undefined;
  onSaveProject: () => string | undefined;
  onCancelProject: () => void;
  onDeleteProject: (projectId: string) => void;
  onRenameProject: (projectId: string, currentName: string) => void;
  onOpenRecording: (recording: ProjectRecordingCard) => void;
  onMoveRecording: (recording: ProjectRecordingCard, projectId: string) => void;
  onShowMore: (projectId: string) => void;
  onShowLess: (projectId: string) => void;
  projectMarkdown: (row: ProjectRow) => string;
}) {
  return (
    <section class="projects-workspace" aria-label="Projects">
      <header class="projects-toolbar">
        <div class="projects-title">
          <h2>Projects</h2>
        </div>
        <div class="projects-controls">
          <input
            aria-label="Search projects"
            value={props.search}
            onInput={(event) => props.onSearch(event.currentTarget.value)}
            placeholder="Search projects, memos, topics..."
          />
          <button class="secondary-action" type="button">
            Sort: Last updated
          </button>
          <button class="primary-action" type="button" onClick={() => props.onCreateProject()}>
            + New Project
          </button>
        </div>
      </header>

      <Show when={props.isComposerOpen}>
        <form
          class="project-composer"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSaveProject();
          }}
        >
          <label for="new-project-name">Project name</label>
          <input
            id="new-project-name"
            value={props.newProjectName}
            onInput={(event) => props.onNewProjectName(event.currentTarget.value)}
            placeholder="Customer Discovery, Product Strategy..."
          />
          <button class="primary-action" type="submit" disabled={!props.newProjectName.trim()}>
            Create
          </button>
          <button class="secondary-action" type="button" onClick={props.onCancelProject}>
            Cancel
          </button>
        </form>
      </Show>

      <div class="project-grid" role="table" aria-label="Project recordings">
        <div class="project-grid-head" role="row">
          <span role="columnheader">Project</span>
          <span class="recordings-column-header" role="columnheader">
            <span>Recordings</span>
            <span class="project-count-toggles" aria-label="Project card count toggles">
              <For each={projectCardCountOptions}>
                {(type) => (
                  <button
                    classList={{ selected: props.selectedCountTypes.has(type) }}
                    type="button"
                    onClick={() => props.onToggleCountType(type)}
                  >
                    {projectCardCountLabels[type]}
                  </button>
                )}
              </For>
            </span>
          </span>
        </div>
        <Show when={props.unassignedRecordings.length}>
          <article class="project-row unassigned-project-row" role="row">
            <div class="project-cell project-meta-cell" role="cell">
              <div class="project-name-line">
                <span class="project-folder unassigned-folder"></span>
                <h3>No project assigned</h3>
              </div>
              <div class="project-facts">
                <span>{props.unassignedRecordings.length} {props.unassignedRecordings.length === 1 ? "recording" : "recordings"}</span>
                <span>Move recordings into a project</span>
              </div>
              <div class="project-tags">
                <span>Catch all</span>
              </div>
            </div>

            <div class="project-cell project-recordings-cell" role="cell">
              <div class="recording-card-grid">
                <For each={props.unassignedRecordings}>
                  {(recording) => (
                    <ProjectRecordingCardShell
                      recording={recording}
                      selectedCountTypes={props.selectedCountTypes}
                      projects={props.rows.map((row) => row.project)}
                      onOpen={() => props.onOpenRecording(recording)}
                      onMove={(projectId) => props.onMoveRecording(recording, projectId)}
                    />
                  )}
                </For>
              </div>
            </div>

          </article>
        </Show>
        <For
          each={props.rows}
          fallback={
            <div class="projects-empty">
              <p>No projects yet. Create a project, then assign a whole recording or specific transcript section.</p>
              <button class="primary-action" type="button" onClick={() => props.onCreateProject()}>
                + New Project
              </button>
            </div>
          }
        >
          {(row) => {
            const isExpanded = () => props.cardLimit[row.project.id] === Number.MAX_SAFE_INTEGER;
            return (
              <article
                class="project-row"
                classList={{
                  expanded: isExpanded(),
                }}
                role="row"
              >
                <div class="project-cell project-meta-cell" role="cell">
                  <div class="project-name-line">
                    <span class="project-folder" style={{ "background-color": row.project.color }}></span>
                    <h3>{row.project.name}</h3>
                    <ProjectExportMenu
                      markdown={() => props.projectMarkdown(row)}
                      filename={() => markdownFilename(`${row.project.name}-project-transcript`)}
                      onRenameProject={() => props.onRenameProject(row.project.id, row.project.name)}
                      onDissolveProject={() => props.onDeleteProject(row.project.id)}
                    />
                  </div>
                  <div class="project-facts">
                    <span>{projectDateRange(row.recordings)}</span>
                    <span>{row.recordings.length} {row.recordings.length === 1 ? "recording" : "recordings"}</span>
                    <span>{formatDuration(row.durationMs)} total</span>
                  </div>
                  <div class="project-row-actions">
                    <p>Updated {relativeDate(row.project.updatedAt)}</p>
                  </div>
                </div>

                <div class="project-cell project-recordings-cell" role="cell">
                  <ProjectRecordingScroller
                    projectId={row.project.id}
                    recordings={row.recordings}
                    selectedCountTypes={props.selectedCountTypes}
                    projects={props.rows.map((row) => row.project)}
                    isExpanded={isExpanded()}
                    onOpenRecording={props.onOpenRecording}
                    onMoveRecording={props.onMoveRecording}
                    onShowMore={props.onShowMore}
                    onShowLess={props.onShowLess}
                  />
                </div>

              </article>
            );
          }}
        </For>
      </div>

    </section>
  );
}

function ProjectRecordingCardView(props: {
  recording: ProjectRecordingCard;
  selectedCountTypes: Set<ProjectCardCountType>;
  onOpen: () => void;
  onPointerDown?: JSX.EventHandler<HTMLButtonElement, PointerEvent>;
  onPointerUp?: JSX.EventHandler<HTMLButtonElement, PointerEvent>;
}) {
  const visibleCounts = () =>
    projectCardCountOptions
      .filter((type) => props.selectedCountTypes.has(type))
      .map((type) => ({ type, label: projectCardCountLabels[type], count: props.recording.counts[type] }))
      .filter((item) => item.count > 0);

  return (
    <button
      class="project-recording-card"
      type="button"
      onClick={props.onOpen}
      onPointerDown={props.onPointerDown}
      onPointerUp={props.onPointerUp}
    >
      <span class="recording-card-top">
        <strong>{props.recording.title}</strong>
      </span>
      <span class="recording-date-line">
        {packageDateLabel(props.recording.packageName)}
        <span>{props.recording.durationMs ? formatDuration(props.recording.durationMs) : "Unknown duration"}</span>
      </span>
      <WaveformBars
        packageName={props.recording.packageName}
        audioUrl={props.recording.audioUrl}
        audioSize={props.recording.audioSize}
        audioMtimeMs={props.recording.audioMtimeMs}
        seed={props.recording.id}
        startMs={props.recording.startMs}
        endMs={props.recording.endMs}
      />
      <span class="recording-sections">
        <span>{props.recording.sectionCount} sections</span>
        <For each={props.recording.topSections.slice(0, 3)}>
          {(section, index) => (
            <span>
              <span>{String(index() + 1).padStart(2, "0")}</span>
              <span>{section.title}</span>
              <span>{section.time}</span>
            </span>
          )}
        </For>
      </span>
      <span class="recording-count-row">
        <For each={visibleCounts()}>
          {(item) => (
            <span class={`recording-count-pill count-${item.type}`}>
              <span>{item.label}</span>
              <strong>{item.count}</strong>
            </span>
          )}
        </For>
      </span>
    </button>
  );
}

function ProjectRecordingCardShell(props: {
  recording: ProjectRecordingCard;
  selectedCountTypes: Set<ProjectCardCountType>;
  projects: ProjectRecord[];
  onOpen: () => void;
  onMove: (projectId: string) => void;
  onPointerDown?: JSX.EventHandler<HTMLButtonElement, PointerEvent>;
  onPointerUp?: JSX.EventHandler<HTMLButtonElement, PointerEvent>;
}) {
  return (
    <span class="project-recording-card-shell">
      <ProjectRecordingCardView
        recording={props.recording}
        selectedCountTypes={props.selectedCountTypes}
        onOpen={props.onOpen}
        onPointerDown={props.onPointerDown}
        onPointerUp={props.onPointerUp}
      />
      <Show when={props.projects.length}>
        <MoveRecordingMenu projects={props.projects} onMove={props.onMove} />
      </Show>
    </span>
  );
}

function MoveRecordingMenu(props: {
  projects: ProjectRecord[];
  onMove: (projectId: string) => void;
}) {
  let triggerRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  const [isOpen, setIsOpen] = createSignal(false);
  const [position, setPosition] = createSignal({ top: 0, left: 0 });

  const close = () => setIsOpen(false);
  const updatePosition = () => {
    if (!triggerRef) return;
    const rect = triggerRef.getBoundingClientRect();
    const panelWidth = panelRef?.offsetWidth ?? 190;
    const panelHeight = panelRef?.offsetHeight ?? 260;
    const gap = 6;
    const left = Math.min(rect.right + gap, window.innerWidth - panelWidth - 8);
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - panelHeight - 8));
    setPosition({ top, left: Math.max(8, left) });
  };

  onMount(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!isOpen()) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef?.contains(target) || panelRef?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isOpen()) return;
      event.preventDefault();
      close();
      triggerRef?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    });
  });

  createEffect(() => {
    if (!isOpen()) return;
    updatePosition();
    window.requestAnimationFrame(updatePosition);
  });

  return (
    <span class="move-recording-menu">
      <button
        class="move-recording-trigger"
        ref={triggerRef}
        type="button"
        aria-label="Move recording to project"
        aria-haspopup="menu"
        aria-expanded={isOpen()}
        onClick={() => {
          setIsOpen((value) => !value);
          window.requestAnimationFrame(updatePosition);
        }}
      >
        <span aria-hidden="true">-&gt;</span>
      </button>
      <Show when={isOpen()}>
        <Portal>
          <div
            class="move-recording-popover"
            ref={panelRef}
            role="menu"
            style={{
              top: `${position().top}px`,
              left: `${position().left}px`,
            }}
          >
            <For each={props.projects} fallback={<span class="move-recording-empty">No projects</span>}>
              {(project) => (
                <button
                  class="move-recording-option"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    props.onMove(project.id);
                    close();
                  }}
                >
                  <span class="project-color-dot" style={{ "background-color": project.color }}></span>
                  <span>{project.name}</span>
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </span>
  );
}

function ProjectRecordingScroller(props: {
  projectId: string;
  recordings: ProjectRecordingCard[];
  selectedCountTypes: Set<ProjectCardCountType>;
  projects: ProjectRecord[];
  isExpanded: boolean;
  onOpenRecording: (recording: ProjectRecordingCard) => void;
  onMoveRecording: (recording: ProjectRecordingCard, projectId: string) => void;
  onShowMore: (projectId: string) => void;
  onShowLess: (projectId: string) => void;
}) {
  let gridRef: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  const [hasHorizontalOverflow, setHasHorizontalOverflow] = createSignal(false);

  const measureOverflow = () => {
    if (!gridRef) return;
    setHasHorizontalOverflow(gridRef.scrollWidth > gridRef.clientWidth + 1);
  };

  onMount(() => {
    measureOverflow();
    resizeObserver = new ResizeObserver(measureOverflow);
    if (gridRef) resizeObserver.observe(gridRef);
    window.addEventListener("resize", measureOverflow);
  });

  createEffect(() => {
    props.recordings.length;
    props.isExpanded;
    window.requestAnimationFrame(measureOverflow);
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    window.removeEventListener("resize", measureOverflow);
  });

  return (
    <>
      <div class="recording-card-grid" ref={gridRef}>
        <For each={props.recordings} fallback={<div class="empty compact">No recordings assigned.</div>}>
          {(recording) => (
            <ProjectRecordingCardShell
              recording={recording}
              selectedCountTypes={props.selectedCountTypes}
              projects={props.projects}
              onOpen={() => props.onOpenRecording(recording)}
              onMove={(projectId) => props.onMoveRecording(recording, projectId)}
            />
          )}
        </For>
      </div>
      <Show when={!props.isExpanded && hasHorizontalOverflow()}>
        <button class="show-more-recordings" type="button" onClick={() => props.onShowMore(props.projectId)}>
          <span>Show more</span>
          <span aria-hidden="true">v</span>
        </button>
      </Show>
      <Show when={props.isExpanded}>
        <button class="show-more-recordings" type="button" onClick={() => props.onShowLess(props.projectId)}>
          <span>Show less</span>
          <span aria-hidden="true">^</span>
        </button>
      </Show>
    </>
  );
}

function WaveformBars(props: {
  packageName: string;
  audioUrl?: string;
  audioSize?: number;
  audioMtimeMs?: number;
  seed: string;
  startMs?: number;
  endMs?: number;
}) {
  const [bars, setBars] = createSignal<number[]>(fallbackWaveformBars(props.seed));

  createEffect(() => {
    const url = props.audioUrl;
    if (!url || typeof window === "undefined") {
      setBars(fallbackWaveformBars(props.seed));
      return;
    }
    let cancelled = false;
    void loadWaveformCache({
      packageName: props.packageName,
      audioUrl: url,
      audioSize: props.audioSize,
      audioMtimeMs: props.audioMtimeMs,
    })
      .then((nextBars) => {
        const rangeBars = nextBars ? waveformBarsForRange(nextBars, props.startMs, props.endMs) : [];
        if (!cancelled) setBars(rangeBars.length ? rangeBars : fallbackWaveformBars(props.seed));
      })
      .catch(() => {
        if (!cancelled) setBars(fallbackWaveformBars(props.seed));
      });
    onCleanup(() => {
      cancelled = true;
    });
  });

  return (
    <span class="waveform-bars" aria-hidden="true">
      <For each={bars()}>{(bar) => <span style={{ height: `${Math.max(3, Math.round(bar * 28))}px` }}></span>}</For>
    </span>
  );
}

function ProcessHelpModal(props: { onClose: () => void }) {
  return (
    <div
      class="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) props.onClose();
      }}
    >
      <section
        class="process-help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="process-help-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header class="modal-head">
          <div>
            <span class="eyebrow">Process overview</span>
            <h2 id="process-help-title">From voice memo to reviewable context</h2>
          </div>
          <button class="modal-close" type="button" aria-label="Close help" onClick={props.onClose}>
            x
          </button>
        </header>

        <div class="process-help-body">
          <p class="process-intro">
            This tool reviews local Voice Memo context packages. Each stage writes files on disk so transcription, LLM
            analysis, and review can resume independently.
          </p>

          <div class="process-flow">
            <section class="process-lane" aria-labelledby="audio-file-lane-title">
              <div class="lane-label">
                <strong id="audio-file-lane-title">Per audio file</strong>
                <p>One local recording becomes one resumable context package.</p>
              </div>
              <ol class="process-steps">
                <li>
                  <strong>Find local recordings</strong>
                  <p>Scan the machine for Apple Voice Memos that do not already have a completed package.</p>
                </li>
                <li>
                  <strong>Create a package</strong>
                  <p>Create one folder with source audio, manifest data, transcripts, analysis, and review artifacts.</p>
                </li>
                <li>
                  <strong>Transcribe the audio</strong>
                  <p>Convert audio into timestamped transcript text. Reuse existing transcripts unless rebuilding.</p>
                </li>
                <li>
                  <strong>Split transcript into working segments</strong>
                  <p>Divide long transcripts into bounded chunks with stable start and end times.</p>
                </li>
              </ol>
            </section>

            <section class="process-lane" aria-labelledby="segment-lane-title">
              <div class="lane-label">
                <strong id="segment-lane-title">Per segment</strong>
                <p>Each transcript chunk is processed independently, then merged for review.</p>
              </div>
              <ol class="process-steps">
                <li class="tentative-step">
                  <strong>Suggest automatic sections</strong>
                  <p>Use segment content to propose section titles and summaries. This step is likely to change.</p>
                </li>
                <li>
                  <strong>Run LLM processing</strong>
                  <p>Clean text and extract tasks, claims, quotes, questions, voice markers, and sensitive flags.</p>
                </li>
                <li>
                  <strong>Merge segment outputs</strong>
                  <p>Combine segment results into summary data, top bullets, review overlays, and section metadata.</p>
                </li>
                <li>
                  <strong>Review extracted items</strong>
                  <p>Play audio, inspect highlights, and jump each item back to source time or excerpt.</p>
                </li>
              </ol>
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}

function PanelTitle(props: { title: string }) {
  return <h2 class="panel-title">{props.title}</h2>;
}

function SidebarReviewStack(props: {
  questions: FollowUpQuestion[];
  groups: Array<{ value: OverlayType; label: string; overlays: TranscriptOverlay[] }>;
  selectedOverlayId?: string;
  onSelectOverlay: (overlay: TranscriptOverlay) => void;
}) {
  return (
    <div class="sidebar-review-stack">
      <SidebarSegment title="Questions" count={props.questions.length}>
        <For each={props.questions} fallback={<p class="empty compact">No follow-up questions generated yet.</p>}>
          {(question) => <FollowUpQuestionItem question={question} />}
        </For>
      </SidebarSegment>

      <For each={props.groups}>
        {(group) => (
          <SidebarSegment title={group.label} count={group.overlays.length}>
            <div class="sidebar-review-list">
              <For each={group.overlays} fallback={<p class="empty compact">No {group.label.toLowerCase()} found.</p>}>
                {(overlay) => (
                  <button
                    classList={{ "sidebar-review-item": true, selected: props.selectedOverlayId === overlay.id }}
                    type="button"
                    onClick={() => props.onSelectOverlay(overlay)}
                  >
                    <span class={`type type-${overlay.type}`}>{overlayLabels[overlay.type]}</span>
                    <strong>{overlay.item.title}</strong>
                    <span>{overlay.snippet || overlay.item.item?.excerpt || overlay.item.body || "No matched transcript snippet."}</span>
                  </button>
                )}
              </For>
            </div>
          </SidebarSegment>
        )}
      </For>
    </div>
  );
}

function SidebarSegment(props: { title: string; count: number; children: JSX.Element }) {
  return (
    <details class="sidebar-segment">
      <summary>
        <span>{props.title}</span>
        <span>{props.count}</span>
      </summary>
      <div class="sidebar-segment-body">{props.children}</div>
    </details>
  );
}

function FollowUpQuestionItem(props: { question: FollowUpQuestion }) {
  return (
    <article class="question-item">
      <h4>{props.question.question}</h4>
      <p>
        <strong>Assumed answer</strong>
        {props.question.assumedAnswer || "No clear assumed answer in the transcript."}
      </p>
      <Show when={props.question.alternatives.length}>
        <div>
          <strong>Other supported readings</strong>
          <ul>
            <For each={props.question.alternatives}>{(alternative) => <li>{alternative}</li>}</For>
          </ul>
        </div>
      </Show>
      <Show when={props.question.rationale}>
        {(rationale) => <p class="question-rationale">{rationale()}</p>}
      </Show>
    </article>
  );
}

function AwaitResource(props: { resource: () => LibraryLoadResult | undefined; children: JSX.Element }) {
  props.resource();
  return <>{props.children}</>;
}

async function fetchVoiceMemoLibrary(): Promise<LibraryLoadResult> {
  try {
    const response = await fetch("/api/voice-memos", { cache: "no-store" });
    if (!response.ok) throw new Error(`Voice memo scan failed: ${response.status}`);
    const library = (await response.json()) as VoiceMemoLibrary;
    if (library.packages.length === 0) throw new Error(`No context packages found in ${library.root}`);
    return { library };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Could not load voice memo packages.",
    };
  }
}

function MemoListSkeleton() {
  return (
    <div class="skeleton-stack skeleton-stack-list" aria-live="polite" aria-label="Loading transcripts">
      <For each={[0, 1, 2, 3, 4, 5, 6]}>
        {(item) => (
          <div class="skeleton-card" data-variant={item % 3}>
            <span class="skeleton-line title"></span>
            <span class="skeleton-line short"></span>
            <span class="skeleton-line meta"></span>
          </div>
        )}
      </For>
    </div>
  );
}

function TranscriptPaneSkeleton() {
  return (
    <>
      <div class="transcript-toolbar skeleton-toolbar" aria-live="polite" aria-label="Loading transcript">
        <div>
          <span class="skeleton-line heading"></span>
          <span class="skeleton-line meta"></span>
        </div>
        <span class="skeleton-button"></span>
        <div class="overlay-filter skeleton-filter">
          <For each={[0, 1, 2, 3, 4, 5]}>
            {() => <span class="skeleton-pill"></span>}
          </For>
        </div>
      </div>
      <div class="skeleton-summary">
        <span class="skeleton-line label"></span>
        <span class="skeleton-line wide"></span>
        <span class="skeleton-line medium"></span>
      </div>
      <div class="transcript-document skeleton-document">
        <For each={[0, 1, 2]}>
          {() => (
            <article class="transcript-section skeleton-section">
              <span class="skeleton-line section-title"></span>
              <For each={[0, 1, 2, 3, 4]}>
                {() => (
                  <p class="transcript-line skeleton-transcript-line">
                    <span class="skeleton-time"></span>
                    <span class="skeleton-line transcript"></span>
                  </p>
                )}
              </For>
            </article>
          )}
        </For>
      </div>
    </>
  );
}

function EvidencePaneSkeleton() {
  return (
    <div class="skeleton-evidence" aria-live="polite" aria-label="Loading evidence">
      <PanelTitle title="Audio" />
      <span class="skeleton-audio"></span>
      <PanelTitle title="Selected overlay" />
      <div class="overlay-detail">
        <span class="skeleton-line short"></span>
        <span class="skeleton-line heading"></span>
        <span class="skeleton-line wide"></span>
        <span class="skeleton-line medium"></span>
      </div>
    </div>
  );
}

function firstReadablePackage(packages: MemoPackage[]): MemoPackage | undefined {
  const sorted = [...packages].sort((a, b) => packageDate(b.name) - packageDate(a.name));
  return (
    sorted.find((pkg) => pkg.transcript.some((line) => line.text.trim())) ??
    sorted.find((pkg) => pkg.segments.some((segment) => segment.text?.trim())) ??
    sorted[0]
  );
}

const packageProcessRanks: Record<PackageStatus, number> = {
  llm_failed: 0,
  failed: 1,
  new: 2,
  transcribed: 3,
  segments_ready: 4,
  analysis_ready: 7,
  derived: 8,
};

function comparePackages(a: MemoPackage, b: MemoPackage, mode: PackageSortMode): number {
  if (mode === "needs_process") {
    const processRank = packageProcessRanks[a.status] - packageProcessRanks[b.status];
    if (processRank !== 0) return processRank;
  }
  return compareRecentlyUpdatedPackages(a, b);
}

function compareRecentlyUpdatedPackages(a: MemoPackage, b: MemoPackage): number {
  return packageUpdatedAt(b) - packageUpdatedAt(a) || b.name.localeCompare(a.name);
}

function packageUpdatedAt(pkg: MemoPackage): number {
  return maxNumber(pkg.files.map((file) => file.mtimeMs)) ?? packageDate(pkg.name);
}

function packageDisplayTitle(pkg: MemoPackage): string {
  return pkg.title?.trim() || pkg.transcriptSummary?.title?.trim() || pkg.name;
}

function packageDurationMs(pkg: MemoPackage): number | undefined {
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

function numericManifestValue(manifest: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = manifest?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function maxNumber(values: Array<number | undefined>): number | undefined {
  const finiteValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return finiteValues.length ? Math.max(...finiteValues) : undefined;
}

function EmptyState(props: { text: string }) {
  return <div class="empty">{props.text}</div>;
}

function loadStoredProjects(): ProjectRecord[] {
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

function saveStoredProjects(projects: ProjectRecord[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(projectsStorageKey, JSON.stringify(projects));
}

function loadStoredHiddenMemoNames(): Set<string> {
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

function saveStoredHiddenMemoNames(hiddenMemoNames: Set<string>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(hiddenMemoStorageKey, JSON.stringify([...hiddenMemoNames].sort()));
}

function isProjectSectionRef(value: unknown): value is ProjectSectionRef {
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

function touchProject(project: ProjectRecord): ProjectRecord {
  return { ...project, updatedAt: new Date().toISOString() };
}

function projectColor(index: number): string {
  return ["#2563eb", "#16a34a", "#db2777", "#d97706", "#7c3aed", "#0891b2"][index % 6];
}

function projectsForPackage(projects: ProjectRecord[], packageName: string): ProjectRecord[] {
  if (!packageName) return [];
  return projects.filter((project) => project.recordingNames.includes(packageName));
}

function buildProjectRows(projects: ProjectRecord[], packages: MemoPackage[]): ProjectRow[] {
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
          : "No recordings or sections have been assigned yet."),
      insights,
      durationMs: recordings.reduce((total, recording) => total + (recording.durationMs ?? 0), 0),
    };
  });
}

function buildProjectRecordingCards(project: ProjectRecord, packages: MemoPackage[]): ProjectRecordingCard[] {
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

  const sectionCards = project.sectionRefs.flatMap((ref): ProjectRecordingCard[] => {
    const memoPackage = byName.get(ref.packageName);
    if (!memoPackage) return [];
    const sections = buildSections(memoPackage, normalizeTranscriptLines(memoPackage));
    const section = sections.find((item) => item.id === ref.sectionId);
    return [
      {
        id: `${project.id}::section::${ref.packageName}::${ref.sectionId}`,
        projectId: project.id,
        kind: "section",
        packageName: ref.packageName,
        title: ref.title,
        dateMs: packageDate(ref.packageName),
        startMs: ref.startMs,
        endMs: ref.endMs,
        durationMs: Math.max(0, ref.endMs - ref.startMs),
        sectionId: ref.sectionId,
        summary: section?.summary,
        counts: projectCardCounts(memoPackage, ref.sectionId),
        sectionCount: 1,
        topSections: [{ title: packageDisplayTitle(memoPackage), time: formatTime(ref.startMs) }],
        audioUrl: fileUrl(memoPackage.audio),
        audioSize: memoPackage.audio?.size,
        audioMtimeMs: memoPackage.audio?.mtimeMs,
      },
    ];
  });

  return [...wholeRecordingCards, ...sectionCards].sort(
    (a, b) => a.dateMs - b.dateMs || a.startMs - b.startMs || a.title.localeCompare(b.title),
  );
}

function buildUnassignedRecordingCards(projects: ProjectRecord[], packages: MemoPackage[]): ProjectRecordingCard[] {
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

function followUpQuestionsForPackage(pkg: MemoPackage | undefined): FollowUpQuestion[] {
  return pkg?.followUpQuestions?.questions ?? [];
}

function followUpQuestionsForSection(pkg: MemoPackage | undefined, sectionId: string): FollowUpQuestion[] {
  if (!pkg) return [];
  return followUpQuestionsForPackage(pkg).filter((question) => {
    if (question.scope === "section" && question.sectionId === sectionId) return true;
    return question.sourceSegments?.some((segment) => segment.segmentId === sectionId) ?? false;
  });
}

function projectCardCounts(pkg: MemoPackage, sectionId?: string): Record<ProjectCardCountType, number> {
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

function reviewItemsForSection(pkg: MemoPackage, sectionId: string): ReviewItem[] {
  return pkg.reviewItems.filter((item) => item.source?.segmentId === sectionId);
}

function countReviewItems(items: ReviewItem[], predicate: (item: ReviewItem) => boolean): number {
  return items.reduce((count, item) => count + (predicate(item) ? 1 : 0), 0);
}

function toggleProjectCardCountType(
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

function buildCollectedItemRows(packages: MemoPackage[]): CollectedItemRow[] {
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

function collectedReviewItemContent(item: ReviewItem): string {
  return item.body?.trim() || item.item?.text?.trim() || item.item?.uncertainty?.trim() || "";
}

function collectedReviewItemQuote(item: ReviewItem): string {
  return item.item?.excerpt?.trim() || item.body?.trim() || item.item?.text?.trim() || "";
}

function collectedQuestionContent(question: FollowUpQuestion): string {
  const parts = [
    question.assumedAnswer ? `Assumed answer: ${question.assumedAnswer}` : "",
    question.alternatives.length ? `Alternatives: ${question.alternatives.join("; ")}` : "",
    question.rationale ?? "",
  ];
  return parts.filter(Boolean).join(" ");
}

function collectedQuestionTime(question: FollowUpQuestion): string {
  if (question.source?.start && question.source?.end) return `${question.source.start} - ${question.source.end}`;
  const segment = question.sourceSegments?.find((item) => item.start || item.end);
  if (segment?.start && segment.end) return `${segment.start} - ${segment.end}`;
  if (segment?.start) return segment.start;
  return question.scope === "section" ? "Section question" : "Transcript question";
}

function countCollectedItemTypes(rows: CollectedItemRow[]): Map<CollectedItemType, number> {
  const counts = new Map<CollectedItemType, number>();
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  return counts;
}

function collectedItemFilterOptions(counts: Map<CollectedItemType, number>) {
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

function uniqueStrings(values: string[]): string[] {
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

function projectDateRange(recordings: ProjectRecordingCard[]): string {
  if (!recordings.length) return "No dates";
  const sorted = [...recordings].filter((recording) => recording.dateMs > 0).sort((a, b) => a.dateMs - b.dateMs);
  if (!sorted.length) return "No dates";
  const first = new Date(sorted[0].dateMs).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const last = new Date(sorted.at(-1)!.dateMs).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return first === last ? first : `${first} - ${last}`;
}

function relativeDate(value: string): string {
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

type WaveformCache = {
  version: 1;
  audio: {
    url: string;
    size?: number;
    mtimeMs?: number;
  };
  durationMs: number;
  samples: number[];
};

type WaveformCacheRequest = {
  packageName: string;
  audioUrl: string;
  audioSize?: number;
  audioMtimeMs?: number;
};

const waveformCacheVersion = 1;
const waveformBucketCount = 2_400;
const waveformCachePromises = new Map<string, Promise<WaveformCache | undefined>>();

async function loadWaveformCache(request: WaveformCacheRequest): Promise<WaveformCache | undefined> {
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

async function loadWaveformCacheUnmemoized(request: WaveformCacheRequest): Promise<WaveformCache | undefined> {
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

async function fetchWaveformCache(request: WaveformCacheRequest): Promise<WaveformCache | undefined> {
  const response = await fetch(`/api/voice-memos/${encodeURIComponent(request.packageName)}/waveform`, {
    cache: "no-store",
  });
  if (response.status === 404) return undefined;
  if (!response.ok) return undefined;
  const payload = (await response.json()) as unknown;
  return isUsableWaveformCache(payload, request) ? payload : undefined;
}

async function saveWaveformCache(packageName: string, cache: WaveformCache): Promise<void> {
  await fetch(`/api/voice-memos/${encodeURIComponent(packageName)}/waveform`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cache),
  });
}

function isUsableWaveformCache(value: unknown, request: WaveformCacheRequest): value is WaveformCache {
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

async function waveformCacheFromAudio(
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

function waveformBarsForRange(cache: WaveformCache, startMs = 0, endMs?: number): number[] {
  if (!cache.samples.length) return [];
  const durationMs = Math.max(1, cache.durationMs);
  const startRatio = Math.max(0, Math.min(1, startMs / durationMs));
  const endRatio = Math.max(startRatio, Math.min(1, (endMs ?? durationMs) / durationMs));
  const start = Math.floor(startRatio * cache.samples.length);
  const end = Math.max(start + 1, Math.ceil(endRatio * cache.samples.length));
  return sampleWaveformBars(Float32Array.from(cache.samples.slice(start, end)), 52);
}

function sampleWaveformBars(samples: Float32Array, count: number): number[] {
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

function fallbackWaveformBars(seed: string): number[] {
  let state = 0;
  for (let index = 0; index < seed.length; index++) state = (state * 31 + seed.charCodeAt(index)) >>> 0;
  return Array.from({ length: 52 }, (_, index) => {
    state = (1664525 * state + 1013904223 + index) >>> 0;
    const noise = (state % 1000) / 1000;
    return 0.18 + noise * 0.82;
  });
}

function normalizeTranscriptLines(pkg: MemoPackage): TranscriptLine[] {
  return pkg.transcript.map((line, index) => {
    const startMs =
      line.startMs ?? line.offsets?.from ?? parseClock(line.timestamps?.from) ?? secondsToMs(line.start) ?? 0;
    const endMs =
      line.endMs ??
      line.offsets?.to ??
      parseClock(line.timestamps?.to) ??
      secondsToMs(line.end) ??
      Math.max(startMs, startMs + 1_000);
    const segmentId = pkg.segments.find((segment) => startMs >= segment.startMs && startMs <= segment.endMs)?.id;
    return { ...line, id: `line-${index}`, index, startMs, endMs, segmentId };
  });
}

function buildSections(pkg: MemoPackage, lines: TranscriptLine[]): TranscriptSection[] {
  const summarySections = pkg.transcriptSummary?.sections ?? [];
  if (summarySections.length) {
    return summarySections.map((section, index) => {
      const sourceSegments = section.sourceSegmentIds
        .map((id) => pkg.segments.find((segment) => segment.id === id))
        .filter(Boolean);
      const firstSegment = sourceSegments[0];
      const lastSegment = sourceSegments.at(-1) ?? firstSegment;
      const startMs = section.startMs ?? parseClock(section.start) ?? firstSegment?.startMs ?? 0;
      const endMs =
        section.endMs ??
        parseClock(section.end) ??
        lastSegment?.endMs ??
        firstSegment?.endMs ??
        startMs;
      const sectionLines = lines.filter((line) => line.endMs >= startMs && line.startMs <= endMs);
      return {
        id: section.sourceSegmentIds.join("-") || `summary-${index}`,
        title: section.title,
        summary: section.summary,
        startMs,
        endMs,
        lines: sectionLines,
        fallbackText: section.cleanedText,
      };
    });
  }

  if (!pkg.segments.length) {
    return [
      {
        id: "full",
        title: "Transcript",
        startMs: lines[0]?.startMs ?? 0,
        endMs: lines.at(-1)?.endMs ?? 0,
        lines,
      },
    ];
  }

  return pkg.segments.map((segment) => {
    const sectionLines = lines.filter(
      (line) => line.endMs >= segment.startMs && line.startMs <= segment.endMs,
    );
    return {
      id: segment.id,
      title: segment.title ?? segment.gist ?? segment.id,
      summary: segment.summary ?? segment.gist,
      startMs: segment.startMs,
      endMs: segment.endMs,
      lines: sectionLines,
      fallbackText: segment.text,
    };
  });
}

function buildPackageMarkdown(pkg: MemoPackage): string {
  const lines = normalizeTranscriptLines(pkg);
  const sections = buildSections(pkg, lines);
  const parts = [
    `# ${packageDisplayTitle(pkg)}`,
    `Source package: ${pkg.name}`,
    packageDurationMs(pkg) ? `Duration: ${formatDuration(packageDurationMs(pkg)!)}` : "",
    pkg.transcriptSummary?.summary ? `\n## Summary\n\n${pkg.transcriptSummary.summary}` : "",
    pkg.transcriptSummary?.topBullets.length
      ? `\n## Key Points\n\n${pkg.transcriptSummary.topBullets.map((bullet) => `- ${bullet}`).join("\n")}`
      : "",
    "\n## Transcript",
    sections.map((section) => sectionMarkdownBody(section, 3)).join("\n\n"),
  ];
  return compactMarkdown(parts);
}

function buildSectionMarkdown(section: TranscriptSection, pkg: MemoPackage | undefined): string {
  const parts = [
    `# ${section.title}`,
    pkg ? `Source package: ${pkg.name}` : "",
    `Time: ${formatTime(section.startMs)} - ${formatTime(section.endMs)}`,
    section.summary ? `\n## Summary\n\n${section.summary}` : "",
    "\n## Transcript",
    transcriptTextMarkdown(section),
  ];
  return compactMarkdown(parts);
}

function buildProjectMarkdown(project: ProjectRecord, packages: MemoPackage[]): string {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const recordingSections = project.recordingNames.flatMap((packageName) => {
    const pkg = byName.get(packageName);
    if (!pkg) return [];
    return [`## ${packageDisplayTitle(pkg)}\n\n${buildPackageMarkdown(pkg).replace(/^# .+\n+/, "")}`];
  });
  const assignedSections = project.sectionRefs.flatMap((ref) => {
    const pkg = byName.get(ref.packageName);
    if (!pkg) return [];
    const section = buildSections(pkg, normalizeTranscriptLines(pkg)).find((item) => item.id === ref.sectionId);
    if (!section) return [];
    return [
      [
        `## ${section.title}`,
        `Source package: ${pkg.name}`,
        `Time: ${formatTime(section.startMs)} - ${formatTime(section.endMs)}`,
        section.summary ? `\n### Summary\n\n${section.summary}` : "",
        "\n### Transcript",
        transcriptTextMarkdown(section),
      ].join("\n\n"),
    ];
  });
  const parts = [
    `# ${project.name}`,
    "Project transcript export",
    project.description ? `Description: ${project.description}` : "",
    project.recordingNames.length ? "\n## Whole Recording Transcripts" : "",
    recordingSections.join("\n\n"),
    project.sectionRefs.length ? "\n## Assigned Section Transcripts" : "",
    assignedSections.join("\n\n"),
  ];
  return compactMarkdown(parts);
}

function sectionMarkdownBody(section: TranscriptSection, headingLevel: number): string {
  const heading = "#".repeat(Math.max(1, headingLevel));
  const parts = [
    `${heading} ${section.title}`,
    `Time: ${formatTime(section.startMs)} - ${formatTime(section.endMs)}`,
    section.summary ? `\n${heading}# Summary\n\n${section.summary}` : "",
    `\n${heading}# Transcript`,
    transcriptTextMarkdown(section),
  ];
  return compactMarkdown(parts);
}

function transcriptTextMarkdown(section: TranscriptSection): string {
  if (section.lines.length) {
    return section.lines
      .filter((line) => line.text.trim())
      .map((line) => `[${formatTime(line.startMs)}] ${line.text.trim()}`)
      .join("\n\n");
  }
  return section.fallbackText?.trim() || "_No transcript text available._";
}

function compactMarkdown(parts: string[]): string {
  return `${parts.filter((part) => part.trim()).join("\n\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

async function copyMarkdown(markdown: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(markdown);
      return true;
    }
  } catch {
    // Fall through to the textarea path for local HTTP/file contexts that deny clipboard access.
  }

  const textArea = document.createElement("textarea");
  textArea.value = markdown;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  try {
    return document.execCommand("copy");
  } finally {
    textArea.remove();
  }
}

function downloadMarkdownFile(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".md") ? filename : `${filename}.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function markdownFilename(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${normalized || "transcript"}.md`;
}

function buildOverlays(pkg: MemoPackage, lines: TranscriptLine[]): TranscriptOverlay[] {
  return pkg.reviewItems.map((item) => {
    const type = overlayType(item.type);
    const excerpt = item.item?.excerpt?.trim() || item.body?.trim() || "";
    const excerptMatch = excerpt ? findExcerpt(lines, excerpt) : undefined;
    if (excerptMatch) {
      return {
        id: item.id,
        item,
        type,
        startLine: excerptMatch.startLine,
        endLine: excerptMatch.endLine,
        startOffset: "startOffset" in excerptMatch ? excerptMatch.startOffset : undefined,
        endOffset: "endOffset" in excerptMatch ? excerptMatch.endOffset : undefined,
        quality: excerptMatch.quality,
        snippet: excerptMatch.snippet,
      };
    }

    const byTime = findByTime(lines, sourceStartMs(item), sourceEndMs(item));
    if (byTime.length) {
      return {
        id: item.id,
        item,
        type,
        startLine: byTime[0].index,
        endLine: byTime.at(-1)?.index ?? byTime[0].index,
        quality: "time",
        snippet: byTime.map((line) => line.text).join(" ").slice(0, 280),
      };
    }

    const bySegment = lines.filter((line) => line.segmentId && line.segmentId === item.source?.segmentId);
    if (bySegment.length) {
      return {
        id: item.id,
        item,
        type,
        startLine: bySegment[0].index,
        endLine: bySegment.at(-1)?.index ?? bySegment[0].index,
        quality: "segment",
        snippet: bySegment.map((line) => line.text).join(" ").slice(0, 280),
      };
    }

    return {
      id: item.id,
      item,
      type,
      startLine: 0,
      endLine: 0,
      quality: "unmatched",
      snippet: "",
    };
  });
}

function renderLine(
  line: TranscriptLine,
  overlays: TranscriptOverlay[],
  selectedId: string | undefined,
  onSelect: (overlay: TranscriptOverlay) => void,
) {
  const matches = overlays.filter((overlay) => line.index >= overlay.startLine && line.index <= overlay.endLine);
  if (!matches.length) return line.text;

  const selected = selectedId ? matches.find((overlay) => overlay.id === selectedId) : undefined;
  const selectedRange = selected ? overlayLineRange(line, selected) : undefined;
  if (selected && selectedRange) {
    return (
      <>
        {line.text.slice(0, selectedRange.start)}
        <OverlayMark overlay={selected} selected onSelect={onSelect}>
          {line.text.slice(selectedRange.start, selectedRange.end)}
        </OverlayMark>
        {line.text.slice(selectedRange.end)}
      </>
    );
  }

  if (selected) {
    return (
      <OverlayMark overlay={selected} selected onSelect={onSelect}>
        {line.text}
      </OverlayMark>
    );
  }

  const exact = matches.find((overlay) => overlayLineRange(line, overlay));
  const exactRange = exact ? overlayLineRange(line, exact) : undefined;
  if (!exact || !exactRange) {
    const primary = matches[0];
    return (
      <OverlayMark overlay={primary} selected={primary.id === selectedId} onSelect={onSelect}>
        {line.text}
      </OverlayMark>
    );
  }

  return (
    <>
      {line.text.slice(0, exactRange.start)}
      <OverlayMark overlay={exact} selected={exact.id === selectedId} onSelect={onSelect}>
        {line.text.slice(exactRange.start, exactRange.end)}
      </OverlayMark>
      {line.text.slice(exactRange.end)}
    </>
  );
}

function OverlayMark(props: {
  overlay: TranscriptOverlay;
  selected: boolean;
  onSelect: (overlay: TranscriptOverlay) => void;
  children: string;
}) {
  const select = () => props.onSelect(props.overlay);
  return (
    <span
      role="button"
      tabIndex={0}
      classList={{
        overlayMark: true,
        selected: props.selected,
        [`overlay-${props.overlay.type}`]: true,
      }}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      }}
    >
      {props.children}
    </span>
  );
}

function overlayLineRange(line: TranscriptLine, overlay: TranscriptOverlay) {
  if (overlay.startOffset == null || overlay.endOffset == null) return undefined;
  const start = line.index === overlay.startLine ? overlay.startOffset : 0;
  const end = line.index === overlay.endLine ? overlay.endOffset : line.text.length;
  if (end <= start) return undefined;
  return { start, end };
}

function findExcerpt(lines: TranscriptLine[], excerpt: string) {
  const needle = normalizeSearch(excerpt);
  for (const line of lines) {
    const haystack = normalizeSearch(line.text);
    if (haystack.includes(needle)) {
      const offsets = approximateOriginalOffsets(line.text, excerpt);
      return {
        startLine: line.index,
        endLine: line.index,
        quality: "excerpt" as const,
        snippet: line.text,
        ...offsets,
      };
    }
  }

  const excerptTokens = tokenSet(excerpt);
  if (excerptTokens.size < 3) return undefined;
  let best:
    | {
        startLine: number;
        endLine: number;
        width: number;
        score: number;
        matched: number;
        snippet: string;
      }
    | undefined;

  for (let start = 0; start < lines.length; start++) {
    for (let width = 1; width <= 3 && start + width <= lines.length; width++) {
      const windowLines = lines.slice(start, start + width);
      const windowText = windowLines.map((line) => line.text).join(" ");
      const offsets = approximateOriginalOffsets(windowText, excerpt);
      if (offsets) {
        const lineOffsets = windowOffsetsToLineOffsets(windowLines, offsets.startOffset, offsets.endOffset);
        return {
          startLine: lineOffsets.startLine,
          endLine: lineOffsets.endLine,
          startOffset: lineOffsets.startOffset,
          endOffset: lineOffsets.endOffset,
          quality: "excerpt" as const,
          snippet: windowText.slice(0, 360),
        };
      }

      const windowTokens = tokenSet(windowText);
      const matched = [...excerptTokens].filter((token) => windowTokens.has(token)).length;
      const score = matched / excerptTokens.size;
      if (
        !best ||
        score > best.score ||
        (score === best.score && (width < best.width || (width === best.width && matched > best.matched)))
      ) {
        best = {
          startLine: windowLines[0].index,
          endLine: windowLines.at(-1)?.index ?? windowLines[0].index,
          width,
          score,
          matched,
          snippet: windowText.slice(0, 360),
        };
      }
    }
  }

  if (best && best.score >= 0.45 && best.matched >= 3) {
    return {
      startLine: best.startLine,
      endLine: best.endLine,
      quality: "fuzzy" as const,
      snippet: best.snippet,
    };
  }
  return undefined;
}

function findByTime(lines: TranscriptLine[], startMs: number | undefined, endMs: number | undefined) {
  if (startMs == null || endMs == null) return [];
  return lines.filter((line) => line.endMs >= startMs && line.startMs <= endMs);
}

function approximateOriginalOffsets(text: string, excerpt: string) {
  const direct = text.toLowerCase().indexOf(excerpt.toLowerCase());
  if (direct >= 0) return { startOffset: direct, endOffset: direct + excerpt.length };
  return undefined;
}

function windowOffsetsToLineOffsets(lines: TranscriptLine[], startOffset: number, endOffset: number) {
  let cursor = 0;
  let startLine = lines[0].index;
  let endLine = lines.at(-1)?.index ?? lines[0].index;
  let lineStartOffset = 0;
  let lineEndOffset = lines.at(-1)?.text.length ?? 0;

  for (const line of lines) {
    const lineStart = cursor;
    const lineEnd = lineStart + line.text.length;
    if (startOffset >= lineStart && startOffset <= lineEnd) {
      startLine = line.index;
      lineStartOffset = startOffset - lineStart;
    }
    if (endOffset >= lineStart && endOffset <= lineEnd) {
      endLine = line.index;
      lineEndOffset = endOffset - lineStart;
      break;
    }
    cursor = lineEnd + 1;
  }

  return {
    startLine,
    endLine,
    startOffset: lineStartOffset,
    endOffset: lineEndOffset,
  };
}

function overlayType(type: ReviewType): OverlayType {
  return type === "claim" || type === "opinion" || type === "experience" ? "claimish" : type;
}

function sourceStartMs(item: ReviewItem): number | undefined {
  return item.source?.startMs ?? parseClock(item.source?.start);
}

function sourceEndMs(item: ReviewItem): number | undefined {
  return item.source?.endMs ?? parseClock(item.source?.end);
}

function formatRange(item: ReviewItem): string {
  const start = sourceStartMs(item);
  const end = sourceEndMs(item);
  if (item.source?.start && item.source?.end) return `${item.source.start} - ${item.source.end}`;
  if (start == null || end == null) return "Unknown";
  return `${formatTime(start)} - ${formatTime(end)}`;
}

function qualityLabel(quality: AnchorQuality): string {
  if (quality === "excerpt") return "Matched excerpt";
  if (quality === "fuzzy") return "Fuzzy excerpt";
  if (quality === "time") return "Matched time";
  if (quality === "segment") return "Segment evidence";
  return "Unmatched";
}

function sourceLabel(item: ReviewItem): string {
  return item.source?.source ?? item.source?.sourceFiles?.join(", ") ?? "Unknown";
}

function readUrlSelection(): UrlSelection {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const view = params.get(viewQueryParam);
  return {
    transcript: params.get(transcriptQueryParam) || undefined,
    snippet: params.get(snippetQueryParam) || undefined,
    view: isWorkspaceView(view) ? view : undefined,
  };
}

function isWorkspaceView(value: string | null): value is WorkspaceView {
  return value === "review" || value === "projects" || value === "items" || value === "memos";
}

function overlayIdForPackage(packageName: string, overlayId: string | undefined, packages: MemoPackage[]): string {
  if (!overlayId) return "";
  const memoPackage = packages.find((pkg) => pkg.name === packageName);
  if (!memoPackage) return "";
  return memoPackage.reviewItems.some((item) => item.id === overlayId) ? overlayId : "";
}

function replaceUrlSelection(selection: UrlSelection) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (selection.transcript) {
    url.searchParams.set(transcriptQueryParam, selection.transcript);
  } else {
    url.searchParams.delete(transcriptQueryParam);
  }
  if (selection.snippet) {
    url.searchParams.set(snippetQueryParam, selection.snippet);
  } else {
    url.searchParams.delete(snippetQueryParam);
  }
  if (selection.view) {
    url.searchParams.set(viewQueryParam, selection.view);
  } else {
    url.searchParams.delete(viewQueryParam);
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.replaceState(null, "", next);
}

function clearSectionHash() {
  if (typeof window === "undefined" || !window.location.hash) return;
  const url = new URL(window.location.href);
  url.hash = "";
  const next = `${url.pathname}${url.search}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.replaceState(null, "", next);
}

function lineDomId(index: number): string {
  return `transcript-line-${index}`;
}

function sectionDomId(id: string): string {
  const normalized = id.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `section-${normalized || "transcript"}`;
}

function currentSectionHashId(): string {
  if (typeof window === "undefined" || !window.location.hash) return "";
  const hash = window.location.hash.slice(1);
  let decodedHash = hash;
  try {
    decodedHash = decodeURIComponent(hash);
  } catch {
    decodedHash = hash;
  }
  return decodedHash.startsWith("section-") ? decodedHash : "";
}

function scrollToSectionHash(behavior: ScrollBehavior): boolean {
  const id = currentSectionHashId();
  if (!id) return false;
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ block: "start", behavior });
  return true;
}

function packageDate(name: string): number {
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

function packageDateLabel(name: string): string {
  const value = packageDate(name);
  if (!value) return "Root assets";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(value);
}

function formatTime(ms: number | undefined): string {
  if (ms == null) return "0:00";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  if (!hours) return `${minutes}:${rest}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`;
}

function secondsToMs(value: number | undefined): number | undefined {
  if (value == null || Number.isNaN(value)) return undefined;
  return value * 1000;
}

function parseClock(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.replace(",", ".").split(":");
  if (parts.length !== 3) return undefined;
  return Number(parts[0]) * 3_600_000 + Number(parts[1]) * 60_000 + Number(parts[2]) * 1000;
}

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(value: string): Set<string> {
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

render(() => <App />, document.getElementById("root")!);
