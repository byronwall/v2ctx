import { For, Show, Suspense, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { Setter } from "solid-js";
import type { FollowUpQuestion, MemoPackage } from "../types";
import type { LibraryLoadResult, OverlayType, ProjectCardCountType, ProjectRecordingCard, ProjectRecord, TranscriptLine, TranscriptOverlay, TranscriptSection } from "../reviewTypes";
import { overlayFilters, overlayLabels } from "../reviewTypes";
import { formatDuration, formatTime } from "../datetime";
import { buildPackageMarkdown, buildSectionMarkdown, markdownFilename } from "../markdown";
import { packageDisplayTitle } from "../packageModel";
import { lineDomId, sectionDomId } from "../routing";
import { formatRange, qualityLabel, renderLine, sourceLabel, sourceStartMs } from "../transcriptModel";
import { AwaitResource, EmptyState, MarkdownExportMenu, ReviewActionsMenu } from "./common";
import { EvidencePaneSkeleton, PanelTitle, SidebarReviewStack, TranscriptPaneSkeleton } from "./panels";
import { ProjectRecordingCardView } from "./workspaces";

type SidebarReviewGroup = { value: OverlayType; label: string; overlays: TranscriptOverlay[] };
const projectRailCountTypes = new Set<ProjectCardCountType>(["question", "task", "idea"]);

export function ReviewWorkspace(props: {
  isLoading: () => boolean;
  initialLibrary: () => LibraryLoadResult | undefined;
  selectedPackage: () => MemoPackage | undefined;
  freshPackageName: () => string;
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
  activeProject: () => ProjectRecord | undefined;
  activeProjectRecordings: () => ProjectRecordingCard[];
  openProjectRecording: (recording: ProjectRecordingCard) => void;
  jumpTo: (ms: number | undefined, lineIndex?: number, play?: boolean) => void;
  overlays: () => TranscriptOverlay[];
  selectedOverlay: () => TranscriptOverlay | undefined;
  selectOverlay: (overlay: TranscriptOverlay, packageName?: string) => void;
  audioUrl: () => string | undefined;
  setAudioRef: (element: HTMLAudioElement) => void;
  selectedPackageQuestions: () => FollowUpQuestion[];
  sidebarReviewGroups: () => SidebarReviewGroup[];
  unmatchedItems: () => TranscriptOverlay[];
}) {
  const {
    isLoading,
    initialLibrary, selectedPackage, freshPackageName, transcriptLines, processingPackageName,
    isRunningRemainingLlm, rerunningQuestionsPackageName, runLlmForSelectedPackage, rerunFollowUpQuestionsForSelectedPackage,
    hidePackage, overlayFilter, setOverlayFilter, sections, linkToSection, activeProject,
    activeProjectRecordings, openProjectRecording, jumpTo, overlays, selectedOverlay, selectOverlay, audioUrl,
    selectedPackageQuestions, sidebarReviewGroups, unmatchedItems,
  } = props;
  const [activeSectionId, setActiveSectionId] = createSignal("");

  const updateActiveSection = () => {
    const candidates = sections()
      .map((section) => {
        const element = document.getElementById(sectionDomId(section.id));
        return element ? { section, top: element.getBoundingClientRect().top } : undefined;
      })
      .filter(Boolean) as { section: TranscriptSection; top: number }[];
    if (!candidates.length) return;
    const current =
      candidates
        .filter((candidate) => candidate.top <= 160)
        .sort((a, b) => b.top - a.top)[0] ?? candidates.sort((a, b) => Math.abs(a.top - 160) - Math.abs(b.top - 160))[0];
    setActiveSectionId(current.section.id);
  };

  createEffect(() => {
    const firstSection = sections()[0];
    if (firstSection && !sections().some((section) => section.id === activeSectionId())) {
      setActiveSectionId(firstSection.id);
    }
    window.requestAnimationFrame(updateActiveSection);
  });

  onMount(() => {
    window.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("resize", updateActiveSection);
    onCleanup(() => {
      window.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
    });
  });

  return (
      <section class="transcript-workspace" aria-busy={isLoading() && !selectedPackage()}>
        <aside class="memo-list review-navigation" aria-label="Review navigation">
          <Show when={audioUrl()} fallback={<div class="empty compact">No audio file loaded.</div>}>
            {(url) => <audio ref={props.setAudioRef} controls src={url()} />}
          </Show>

          <div class="toc-panel">
            <div class="pane-head">
              <div>
                <h2>{selectedPackage() ? packageDisplayTitle(selectedPackage()!) : "No transcript selected"}</h2>
              </div>
            </div>
            <Show when={sections().length} fallback={<EmptyState text="No sections loaded." />}>
              <ol class="toc-list" aria-label="Active transcript sections">
                <For each={sections()}>
                  {(section) => (
                    <li>
                      <a
                        classList={{ "toc-link": true, selected: activeSectionId() === section.id }}
                        href={`#${sectionDomId(section.id)}`}
                        aria-current={activeSectionId() === section.id ? "location" : undefined}
                        onClick={(event) => {
                          setActiveSectionId(section.id);
                          linkToSection(section, event);
                        }}
                      >
                        <span>{section.title}</span>
                        <span>{formatDuration(Math.max(0, section.endMs - section.startMs))}</span>
                      </a>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
          </div>

          <Show when={activeProject()}>
            {(project) => (
              <div class="active-project-panel">
                <div class="pane-head">
                  <div>
                    <h2>{project().name}</h2>
                    <p>Other project items</p>
                  </div>
                </div>
                <div class="active-project-list">
                  <For each={activeProjectRecordings()} fallback={<p class="empty compact">No other items in this project.</p>}>
                    {(recording) => (
                      <ProjectRecordingCardView
                        recording={recording}
                        selectedCountTypes={projectRailCountTypes}
                        onOpen={() => openProjectRecording(recording)}
                      />
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>
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
                              <MarkdownExportMenu
                                label="section transcript"
                                markdown={() => buildSectionMarkdown(section, selectedPackage())}
                                filename={() =>
                                  markdownFilename(
                                    selectedPackage()
                                      ? `${packageDisplayTitle(selectedPackage()!)}-${section.title}`
                                      : section.title,
                                  )
                                }
                              />
                            </div>
                          </div>
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
              <PanelTitle title="Selected overlay" />
              <Show when={selectedOverlay()} fallback={<EmptyState text="Select a snippet to inspect its evidence." />}>
                {(overlay) => {
                  const description = () => (overlay().item.body ?? overlay().item.item?.text ?? "").trim();
                  const excerpt = () => (overlay().item.item?.excerpt || overlay().snippet || "").trim();
                  const showDescription = () => {
                    const text = description();
                    return text && text !== excerpt();
                  };
                  return (
                    <article class="overlay-detail">
                      <header class="overlay-detail-head">
                        <div class="detail-kicker">
                          <span class={`type type-${overlay().type}`}>{overlayLabels[overlay().type]}</span>
                          <span class="quality-pill">{qualityLabel(overlay().quality)}</span>
                        </div>
                        <h3>{overlay().item.title}</h3>
                      </header>

                      <Show when={showDescription()}>
                        <p class="overlay-description">{description()}</p>
                      </Show>

                      <div class="overlay-facts" aria-label="Selected overlay source details">
                        <div>
                          <span>Time</span>
                          <strong>{formatRange(overlay().item)}</strong>
                        </div>
                        <div>
                          <span>Source</span>
                          <strong>{sourceLabel(overlay().item)}</strong>
                        </div>
                      </div>

                      <div class="overlay-excerpt">
                        <span>Excerpt</span>
                        <p>{excerpt() || "No matched excerpt."}</p>
                      </div>

                      <button
                        class="primary-action overlay-play-action"
                        onClick={() =>
                          jumpTo(
                            sourceStartMs(overlay().item) ?? transcriptLines()[overlay().startLine]?.startMs,
                            overlay().startLine,
                          )
                        }
                      >
                        Play from source
                      </button>
                    </article>
                  );
                }}
              </Show>

              <PanelTitle title="Review sections" />
              <SidebarReviewStack
                questions={selectedPackageQuestions()}
                groups={sidebarReviewGroups()}
                selectedOverlayId={selectedOverlay()?.id}
                onSelectOverlay={(overlay) => selectOverlay(overlay, selectedPackage()?.name)}
              />

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
