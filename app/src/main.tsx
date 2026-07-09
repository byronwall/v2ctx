import { Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { render } from "solid-js/web";
import { fileUrl } from "./packageLoader";
import type { MemoPackage, NextTopicsArtifact, VoiceMemoLibrary } from "./types";
import type { CollectedItemRow, ProjectRecord, ProjectRecordingCard, TranscriptOverlay, TranscriptSection, WorkspaceView, OverlayType, CollectedItemType, ProjectCardCountType } from "./reviewTypes";
import { defaultProjectCardCountTypes, sidebarReviewSections } from "./reviewTypes";
import { lineDomId, sectionDomId, readUrlSelection, replaceUrlSelection, clearSectionHash, currentSectionHashId, scrollToSectionHash, overlayIdForPackage } from "./routing";
import { fetchVoiceMemoLibrary } from "./library";
import { firstReadablePackage } from "./packageModel";
import { packageDate } from "./datetime";
import { buildOverlays, buildSections, normalizeTranscriptLines, sourceStartMs } from "./transcriptModel";
import { buildProjectMarkdown } from "./markdown";
import { buildCollectedItemRows, buildProjectRecordingCards, buildProjectRows, buildUnassignedRecordingCards, countCollectedItemTypes, followUpQuestionsForPackage, loadStoredHiddenMemoNames, loadStoredProjects, projectColor, projectsForPackage, saveStoredHiddenMemoNames, saveStoredProjects, toggleProjectCardCountType, touchProject } from "./projectModel";
import { ActionButton, Popover } from "./components/common";
import { ProcessHelpModal } from "./components/panels";
import { ReviewWorkspace } from "./components/reviewWorkspace";
import { AllMemosWorkspace, CollectedItemsWorkspace, NextTopicsWorkspace, ProjectsWorkspace } from "./components/workspaces";
import { WaveformIcon } from "./components/WaveformIcon";
import "./styles.css";

function App() {
  let audioRef: HTMLAudioElement | undefined;
  const initialUrlSelection = readUrlSelection();
  const [allPackages, setAllPackages] = createSignal<MemoPackage[]>([]);
  const [nextTopics, setNextTopics] = createSignal<NextTopicsArtifact | undefined>();
  const [selectedPackageName, setSelectedPackageName] = createSignal(initialUrlSelection.transcript ?? "");
  const [selectedOverlayId, setSelectedOverlayId] = createSignal(initialUrlSelection.snippet ?? "");
  const [workspaceView, setWorkspaceView] = createSignal<WorkspaceView>(initialUrlSelection.view ?? "review");
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
  const [isGeneratingNextTopics, setIsGeneratingNextTopics] = createSignal(false);
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
  const activeProject = createMemo(() => selectedPackageProjects()[0]);
  const activeProjectRecordings = createMemo(() => {
    const project = activeProject();
    const packageName = selectedPackageName();
    if (!project) return [];
    return buildProjectRecordingCards(project, packages()).filter((recording) => recording.packageName !== packageName);
  });
  const collectedItems = createMemo(() => buildCollectedItemRows(packages()));
  const collectedTypeCounts = createMemo(() => countCollectedItemTypes(collectedItems()));
  const filteredCollectedItems = createMemo(() => {
    const filter = collectedTypeFilter();
    const rows = collectedItems();
    return filter === "all" ? rows : rows.filter((item) => item.type === filter);
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
    setNextTopics(library.nextTopics);
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

  async function regenerateNextTopics() {
    if (isGeneratingNextTopics()) return;
    try {
      setLoadError("");
      setIsGeneratingNextTopics(true);
      const response = await fetch("/api/voice-memos/next-topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageNames: packages()
            .filter((memoPackage) => memoPackage.transcriptSummary?.summary)
            .map((memoPackage) => memoPackage.name),
          projects: projects().map((project) => ({
            name: project.name,
            description: project.description ?? "",
            recordingNames: project.recordingNames.filter((packageName) =>
              packages().some((memoPackage) => memoPackage.name === packageName),
            ),
            sectionRefs: project.sectionRefs
              .filter((section) => packages().some((memoPackage) => memoPackage.name === section.packageName))
              .map((section) => ({
                packageName: section.packageName,
                title: section.title,
              })),
          })),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Next topic generation failed: ${response.status}`);
      }
      if (payload.library) {
        applyVoiceMemoLibrary(payload.library, {
          preferredPackageName: selectedPackageName(),
          preferredOverlayId: selectedOverlayId(),
        });
      } else {
        await loadVoiceMemoLibrary({
          preferredPackageName: selectedPackageName(),
          preferredOverlayId: selectedOverlayId(),
          showLoading: false,
        });
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Next topic generation failed.");
    } finally {
      setIsGeneratingNextTopics(false);
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
    selectPackage(memoPackage);
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

  function moveRecordingCardToProject(recording: ProjectRecordingCard, projectId: string) {
    if (recording.kind === "section") return;
    setProjects((current) =>
      current.map((project) => {
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

  function deleteProject(projectId: string) {
    setProjects((current) => current.filter((project) => project.id !== projectId));
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
          <WaveformIcon class="app-mark" />
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
            classList={{ selected: workspaceView() === "topics" }}
            type="button"
            onClick={() => setWorkspaceView("topics")}
          >
            Topics
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
      <ReviewWorkspace
        isLoading={isLoading}
        initialLibrary={initialLibrary}
        selectedPackage={selectedPackage}
        freshPackageName={freshPackageName}
        transcriptLines={transcriptLines}
        processingPackageName={processingPackageName}
        isRunningRemainingLlm={isRunningRemainingLlm}
        rerunningQuestionsPackageName={rerunningQuestionsPackageName}
        runLlmForSelectedPackage={() => void runLlmForSelectedPackage()}
        rerunFollowUpQuestionsForSelectedPackage={() => void rerunFollowUpQuestionsForSelectedPackage()}
        hidePackage={hidePackage}
        overlayFilter={overlayFilter}
        setOverlayFilter={setOverlayFilter}
        sections={sections}
        linkToSection={linkToSection}
        activeProject={activeProject}
        activeProjectRecordings={activeProjectRecordings}
        openProjectRecording={openProjectRecording}
        jumpTo={jumpTo}
        overlays={overlays}
        selectedOverlay={selectedOverlay}
        selectOverlay={selectOverlay}
        audioUrl={audioUrl}
        setAudioRef={(element) => { audioRef = element; }}
        selectedPackageQuestions={selectedPackageQuestions}
        sidebarReviewGroups={sidebarReviewGroups}
        unmatchedItems={unmatchedItems}
      />
        }
      >
        <Show
          when={workspaceView() === "projects"}
          fallback={
            <Show
              when={workspaceView() === "items"}
              fallback={
                <Show
                  when={workspaceView() === "topics"}
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
                  <NextTopicsWorkspace
                    artifact={nextTopics()}
                    packageCount={packages().filter((memoPackage) => memoPackage.transcriptSummary?.summary).length}
                    isGenerating={isGeneratingNextTopics()}
                    onRegenerate={() => void regenerateNextTopics()}
                  />
                </Show>
              }
            >
              <CollectedItemsWorkspace
                rows={filteredCollectedItems()}
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

render(() => <App />, document.getElementById("root")!);
