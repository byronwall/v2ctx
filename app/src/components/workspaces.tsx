import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { MemoPackage } from "../types";
import type { CollectedItemRow, CollectedItemType, ProjectCardCountType, ProjectRecordingCard, ProjectRecord, ProjectRow } from "../reviewTypes";
import { collectedTypeLabels, projectCardCountLabels, projectCardCountOptions } from "../reviewTypes";
import { formatDuration, packageDateLabel } from "../datetime";
import { markdownFilename } from "../markdown";
import { packageDisplayTitle, packageDurationMs, compareRecentlyUpdatedPackages } from "../packageModel";
import { collectedItemFilterOptions, projectDateRange, relativeDate } from "../projectModel";
import { fallbackWaveformBars, loadWaveformCache, waveformBarsForRange } from "../waveform";
import { ActionButton, EmptyState, ProjectExportMenu } from "./common";

export function CollectedItemsWorkspace(props: {
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

export function AllMemosWorkspace(props: {
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

export function ProjectsWorkspace(props: {
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
              <p>No projects yet. Create a project, then assign recordings.</p>
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

export function ProjectRecordingCardView(props: {
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

export function ProjectRecordingCardShell(props: {
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
      <Show when={props.projects.length && props.recording.kind === "recording"}>
        <MoveRecordingMenu projects={props.projects} onMove={props.onMove} />
      </Show>
    </span>
  );
}

export function MoveRecordingMenu(props: {
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

export function ProjectRecordingScroller(props: {
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

export function WaveformBars(props: {
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
