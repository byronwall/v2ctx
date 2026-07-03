import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { fileUrl, loadPackageFromFileList } from "./packageLoader";
import type { MemoPackage, ReviewItem, ReviewType, TranscriptItem, VoiceMemoLibrary } from "./types";
import "./styles.css";

type OverlayType = ReviewType | "claimish";
type AnchorQuality = "excerpt" | "fuzzy" | "time" | "segment" | "unmatched";

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
};

const transcriptQueryParam = "transcript";
const snippetQueryParam = "snippet";

const typeLabels: Record<ReviewType, string> = {
  task: "Task",
  claim: "Claim",
  opinion: "Opinion",
  experience: "Experience",
  quote: "Quote",
  blog_seed: "Blog seed",
  sensitive_flag: "Sensitive",
};

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

function App() {
  let audioRef: HTMLAudioElement | undefined;
  const initialUrlSelection = readUrlSelection();
  const [packages, setPackages] = createSignal<MemoPackage[]>([]);
  const [libraryRoot, setLibraryRoot] = createSignal("");
  const [selectedPackageName, setSelectedPackageName] = createSignal(initialUrlSelection.transcript ?? "");
  const [selectedOverlayId, setSelectedOverlayId] = createSignal(initialUrlSelection.snippet ?? "");
  const [packageSearch, setPackageSearch] = createSignal("");
  const [overlayFilter, setOverlayFilter] = createSignal<OverlayType | "all">("all");
  const [loadError, setLoadError] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(true);
  const [processingPackageName, setProcessingPackageName] = createSignal("");
  const [freshPackageName, setFreshPackageName] = createSignal("");
  const [restoredInitialSnippet, setRestoredInitialSnippet] = createSignal(false);
  const [restoredInitialSection, setRestoredInitialSection] = createSignal(false);

  onMount(() => {
    const handlePopState = () => {
      const selection = readUrlSelection();
      setSelectedPackageName(selection.transcript ?? firstReadablePackage(packages())?.name ?? "");
      setSelectedOverlayId(selection.snippet ?? "");
      setRestoredInitialSnippet(false);
      setRestoredInitialSection(false);
      window.requestAnimationFrame(() => scrollToSectionHash("smooth"));
    };
    const handleHashChange = () => {
      window.requestAnimationFrame(() => scrollToSectionHash("smooth"));
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("hashchange", handleHashChange);
    onCleanup(() => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("hashchange", handleHashChange);
    });
    void loadVoiceMemoLibrary();
  });

  const packageCards = createMemo(() => {
    const term = packageSearch().trim().toLowerCase();
    return [...packages()]
      .sort((a, b) => packageDate(b.name) - packageDate(a.name))
      .filter((pkg) => {
        if (!term) return true;
        const haystack = `${pkg.name} ${packageDisplayTitle(pkg)} ${pkg.status} ${pkg.transcriptSummary?.summary ?? ""} ${pkg.transcriptSummary?.topBullets.join(" ") ?? ""} ${pkg.segments.map((s) => s.title ?? s.gist ?? "").join(" ")}`;
        return haystack.toLowerCase().includes(term);
      });
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
  const selectedOverlay = createMemo(() => {
    const selected = overlays().find((overlay) => overlay.id === selectedOverlayId());
    return selected ?? overlays()[0];
  });
  const unmatchedItems = createMemo(() => overlays().filter((overlay) => overlay.quality === "unmatched"));
  const sections = createMemo(() => {
    const pkg = selectedPackage();
    return pkg ? buildSections(pkg, transcriptLines()) : [];
  });
  const audioUrl = createMemo(() => fileUrl(selectedPackage()?.audio));

  createEffect(() => {
    if (isLoading()) return;
    if (!selectedPackage()) return;
    const current = selectedOverlayId();
    const available = overlays();
    if (!available.length) {
      if (current) setSelectedOverlayId("");
      return;
    }
    if (!current || !available.some((overlay) => overlay.id === current)) {
      setSelectedOverlayId(available[0].id);
    }
  });

  createEffect(() => {
    if (isLoading()) return;
    if (!packages().length) return;
    replaceUrlSelection(selectedPackageName(), selectedOverlayId());
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

  async function loadVoiceMemoLibrary() {
    try {
      setIsLoading(true);
      const response = await fetch("/api/voice-memos");
      if (!response.ok) throw new Error(`Voice memo scan failed: ${response.status}`);
      const library = (await response.json()) as VoiceMemoLibrary;
      if (library.packages.length === 0) throw new Error(`No context packages found in ${library.root}`);
      setPackages(library.packages);
      setLibraryRoot(library.root);
      const urlSelection = readUrlSelection();
      const current = urlSelection.transcript ?? selectedPackageName();
      setSelectedPackageName(
        library.packages.some((pkg) => pkg.name === current)
          ? current
          : firstReadablePackage(library.packages)?.name ?? library.packages[0]?.name ?? "",
      );
      setSelectedOverlayId(urlSelection.snippet ?? selectedOverlayId());
      setLoadError("");
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Could not load voice memo packages.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    try {
      setLoadError("");
      const loaded = await loadPackageFromFileList(files);
      setPackages([loaded]);
      setLibraryRoot("Manual package selection");
      setSelectedPackageName(loaded.name);
      setSelectedOverlayId("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load package.");
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
        setPackages((current) =>
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

  function jumpTo(ms: number | undefined, lineIndex?: number, play = true) {
    if (lineIndex != null) {
      document.getElementById(lineDomId(lineIndex))?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    if (ms == null || !audioRef) return;
    audioRef.currentTime = Math.max(0, ms / 1000);
    if (play) void audioRef.play().catch(() => {});
  }

  function selectOverlay(overlay: TranscriptOverlay) {
    setSelectedOverlayId(overlay.id);
    jumpTo(sourceStartMs(overlay.item) ?? transcriptLines()[overlay.startLine]?.startMs, overlay.startLine, false);
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
          <div class="subtitle-line">
            <span class="eyebrow">v2ctx transcript review</span>
            <p>{selectedPackage() ? packageDisplayTitle(selectedPackage()!) : isLoading() ? "Loading transcripts" : "No transcript selected"}</p>
            <span class="root-path">{libraryRoot() || "Local library"}</span>
          </div>
        </div>
        <div class="top-actions">
          <button class="secondary-action" onClick={() => void loadVoiceMemoLibrary()}>
            Refresh
          </button>
          <label class="file-picker">
            <input
              type="file"
              webkitdirectory
              multiple
              onChange={(event) => void handleFiles(event.currentTarget.files)}
            />
            Open package
          </label>
        </div>
      </header>

      <Show when={loadError()}>
        <div class="error">{loadError()}</div>
      </Show>

      <Show when={isLoading() && !packages().length}>
        <LoadingState />
      </Show>

      <Show when={!isLoading() || packages().length}>
      <section class="transcript-workspace">
        <aside class="memo-list" aria-label="Voice transcripts">
          <div class="pane-head">
            <div>
              <h2>Transcripts</h2>
              <p>{isLoading() ? "Loading" : `${packageCards().length} available`}</p>
            </div>
          </div>
          <div class="control-block">
            <label for="memo-search">Search</label>
            <input
              id="memo-search"
              value={packageSearch()}
              onInput={(event) => setPackageSearch(event.currentTarget.value)}
              placeholder="Memo name or section"
            />
          </div>
          <div class="memo-scroll">
            <For each={packageCards()} fallback={<EmptyState text="No transcripts found." />}>
              {(memoPackage) => (
                <button
                  classList={{ memoCard: true, selected: selectedPackage()?.name === memoPackage.name }}
                  onClick={() => {
                    setSelectedPackageName(memoPackage.name);
                    setSelectedOverlayId("");
                    setRestoredInitialSnippet(true);
                  }}
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
          </div>
        </aside>

        <section
          classList={{
            "transcript-pane": true,
            "fresh-content": freshPackageName() === selectedPackage()?.name,
          }}
          aria-label="Transcript"
        >
          <div class="transcript-toolbar">
            <div>
              <h2>{selectedPackage() ? packageDisplayTitle(selectedPackage()!) : "No transcript selected"}</h2>
              <p>
                {transcriptLines().length} transcript lines · {selectedPackage()?.reviewItems.length ?? 0} extracted items
              </p>
            </div>
            <button
              class="secondary-action run-llm-action"
              disabled={!selectedPackage() || !!processingPackageName()}
              onClick={() => void runLlmForSelectedPackage()}
            >
              {processingPackageName() === selectedPackage()?.name ? "Processing" : "Run LLM"}
            </button>
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
                      <h3>
                        <a
                          class="section-title-link"
                          href={`#${sectionDomId(section.id)}`}
                          onClick={(event) => linkToSection(section, event)}
                        >
                          {section.title}
                        </a>
                      </h3>
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
                              {renderLine(line, overlays(), selectedOverlay()?.id, selectOverlay)}
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
        </section>

        <aside class="evidence-pane" aria-label="Evidence detail">
          <PanelTitle title="Audio" />
          <Show when={audioUrl()} fallback={<div class="empty compact">No audio file loaded.</div>}>
            {(url) => <audio ref={audioRef} controls src={url()} />}
          </Show>

          <PanelTitle title="Selected overlay" />
          <Show when={selectedOverlay()} fallback={<EmptyState text="No overlays for this memo." />}>
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

          <PanelTitle title="Related snippets" />
          <div class="snippet-list">
            <For each={overlays()} fallback={<div class="empty compact">No snippets.</div>}>
              {(overlay) => (
                <button
                  classList={{ snippet: true, selected: selectedOverlay()?.id === overlay.id }}
                  onClick={() => selectOverlay(overlay)}
                >
                  <span class={`type-dot type-dot-${overlay.type}`} />
                  <strong>{overlay.item.title}</strong>
                  <span>{overlay.snippet || overlay.item.item?.excerpt || "No matched transcript snippet."}</span>
                </button>
              )}
            </For>
          </div>

          <Show when={unmatchedItems().length}>
            <PanelTitle title="Needs better evidence" />
            <div class="unmatched-list">
              <For each={unmatchedItems()}>
                {(overlay) => <span>{overlay.item.title}</span>}
              </For>
            </div>
          </Show>
        </aside>
      </section>
      </Show>
    </main>
  );
}

function PanelTitle(props: { title: string }) {
  return <h2 class="panel-title">{props.title}</h2>;
}

function LoadingState() {
  return (
    <section class="loading-screen" aria-live="polite">
      <div>
        <h2>Loading transcripts</h2>
        <p>Scanning the local voice memo library.</p>
      </div>
    </section>
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
  return {
    transcript: params.get(transcriptQueryParam) || undefined,
    snippet: params.get(snippetQueryParam) || undefined,
  };
}

function replaceUrlSelection(transcript: string, snippet: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (transcript) {
    url.searchParams.set(transcriptQueryParam, transcript);
  } else {
    url.searchParams.delete(transcriptQueryParam);
  }
  if (snippet) {
    url.searchParams.set(snippetQueryParam, snippet);
  } else {
    url.searchParams.delete(snippetQueryParam);
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
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
