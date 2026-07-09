import { For, Show, Suspense } from "solid-js";
import type { Setter } from "solid-js";
import type { FollowUpQuestion, MemoPackage } from "../types";
import type { LibraryLoadResult, OverlayType, PackageSortMode, ProjectRecord, TranscriptLine, TranscriptOverlay, TranscriptSection } from "../reviewTypes";
import { overlayFilters, overlayLabels } from "../reviewTypes";
import { formatDuration, formatTime, packageDateLabel } from "../datetime";
import { buildPackageMarkdown, buildSectionMarkdown, markdownFilename } from "../markdown";
import { packageDisplayTitle, packageDurationMs } from "../packageModel";
import { lineDomId, sectionDomId } from "../routing";
import { formatRange, qualityLabel, renderLine, sourceLabel, sourceStartMs } from "../transcriptModel";
import { AwaitResource, EmptyState, ExportMarkdownActions, ReviewActionsMenu } from "./common";
import { EvidencePaneSkeleton, MemoListSkeleton, PanelTitle, SidebarReviewStack, TranscriptPaneSkeleton } from "./panels";

type SidebarReviewGroup = { value: OverlayType; label: string; overlays: TranscriptOverlay[] };

export function ReviewWorkspace(props: {
  isLoading: () => boolean;
  packages: () => MemoPackage[];
  packageSortLabel: () => string;
  packageSortMode: () => PackageSortMode;
  setPackageSortMode: Setter<PackageSortMode>;
  packageSearch: () => string;
  setPackageSearch: Setter<string>;
  initialLibrary: () => LibraryLoadResult | undefined;
  packageCards: () => MemoPackage[];
  selectedPackage: () => MemoPackage | undefined;
  freshPackageName: () => string;
  selectPackage: (memoPackage: MemoPackage) => void;
  transcriptLines: () => TranscriptLine[];
  processingPackageName: () => string;
  isRunningRemainingLlm: () => boolean;
  rerunningQuestionsPackageName: () => string;
  runLlmForSelectedPackage: () => void;
  rerunFollowUpQuestionsForSelectedPackage: () => void;
  hidePackage: (packageName: string) => void;
  overlayFilter: () => OverlayType | "all";
  setOverlayFilter: Setter<OverlayType | "all">;
  sections: () => TranscriptSection[];
  linkToSection: (section: TranscriptSection, event: MouseEvent) => void;
  selectedSectionProjectIds: () => Map<string, Set<string>>;
  projects: () => ProjectRecord[];
  assignSectionFromSelect: (section: TranscriptSection, value: string) => void;
  removeSectionFromProject: (section: TranscriptSection, projectId: string) => void;
  jumpTo: (ms: number | undefined, lineIndex?: number, play?: boolean) => void;
  overlays: () => TranscriptOverlay[];
  selectedOverlay: () => TranscriptOverlay | undefined;
  selectOverlay: (overlay: TranscriptOverlay, packageName?: string) => void;
  audioUrl: () => string | undefined;
  setAudioRef: (element: HTMLAudioElement) => void;
  createProject: () => string | undefined;
  assignSelectedPackageToProject: (projectId: string) => void;
  selectedPackageProjects: () => ProjectRecord[];
  removeSelectedPackageFromProject: (projectId: string) => void;
  selectedPackageQuestions: () => FollowUpQuestion[];
  sidebarReviewGroups: () => SidebarReviewGroup[];
  unmatchedItems: () => TranscriptOverlay[];
}) {
  const {
    isLoading, packages, packageSortLabel, packageSortMode, setPackageSortMode, packageSearch, setPackageSearch,
    initialLibrary, packageCards, selectedPackage, freshPackageName, selectPackage, transcriptLines, processingPackageName,
    isRunningRemainingLlm, rerunningQuestionsPackageName, runLlmForSelectedPackage, rerunFollowUpQuestionsForSelectedPackage,
    hidePackage, overlayFilter, setOverlayFilter, sections, linkToSection, selectedSectionProjectIds, projects,
    assignSectionFromSelect, removeSectionFromProject, jumpTo, overlays, selectedOverlay, selectOverlay, audioUrl,
    createProject, assignSelectedPackageToProject, selectedPackageProjects, removeSelectedPackageFromProject,
    selectedPackageQuestions, sidebarReviewGroups, unmatchedItems,
  } = props;

  return (
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
                {(url) => <audio ref={props.setAudioRef} controls src={url()} />}
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
  );
}
