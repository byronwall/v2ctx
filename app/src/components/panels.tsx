import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { FollowUpQuestion } from "../types";
import type { OverlayType, TranscriptOverlay } from "../reviewTypes";
import { overlayLabels } from "../reviewTypes";

export function ProcessHelpModal(props: { onClose: () => void }) {
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
          <button class="modal-close" type="button" aria-label="Close help" onClick={() => props.onClose()}>
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

export function PanelTitle(props: { title: string }) {
  return <h2 class="panel-title">{props.title}</h2>;
}

export function SidebarReviewStack(props: {
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

export function SidebarSegment(props: { title: string; count: number; children: JSX.Element }) {
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

export function FollowUpQuestionItem(props: { question: FollowUpQuestion }) {
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

export function MemoListSkeleton() {
  return (
    <div class="skeleton-stack skeleton-stack-list" aria-live="polite" aria-label="Loading transcripts">
      <For each={[0, 1, 2, 3, 4, 5, 6]}>
        {(item) => (
          <div class="skeleton-card" data-variant={item % 3}>
            <span class="skeleton-line title" />
            <span class="skeleton-line short" />
            <span class="skeleton-line meta" />
          </div>
        )}
      </For>
    </div>
  );
}

export function TranscriptPaneSkeleton() {
  return (
    <>
      <div class="transcript-toolbar skeleton-toolbar" aria-live="polite" aria-label="Loading transcript">
        <div>
          <span class="skeleton-line heading" />
          <span class="skeleton-line meta" />
        </div>
        <span class="skeleton-button" />
        <div class="overlay-filter skeleton-filter">
          <For each={[0, 1, 2, 3, 4, 5]}>
            {() => <span class="skeleton-pill" />}
          </For>
        </div>
      </div>
      <div class="skeleton-summary">
        <span class="skeleton-line label" />
        <span class="skeleton-line wide" />
        <span class="skeleton-line medium" />
      </div>
      <div class="transcript-document skeleton-document">
        <For each={[0, 1, 2]}>
          {() => (
            <article class="transcript-section skeleton-section">
              <span class="skeleton-line section-title" />
              <For each={[0, 1, 2, 3, 4]}>
                {() => (
                  <p class="transcript-line skeleton-transcript-line">
                    <span class="skeleton-time" />
                    <span class="skeleton-line transcript" />
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

export function EvidencePaneSkeleton() {
  return (
    <div class="skeleton-evidence" aria-live="polite" aria-label="Loading evidence">
      <PanelTitle title="Audio" />
      <span class="skeleton-audio" />
      <PanelTitle title="Selected overlay" />
      <div class="overlay-detail">
        <span class="skeleton-line short" />
        <span class="skeleton-line heading" />
        <span class="skeleton-line wide" />
        <span class="skeleton-line medium" />
      </div>
    </div>
  );
}
