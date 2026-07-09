import type { MemoPackage, ReviewItem, ReviewType } from "./types";
import type { AnchorQuality, OverlayType, TranscriptLine, TranscriptOverlay, TranscriptSection } from "./reviewTypes";
import { formatTime, normalizeSearch, parseClock, secondsToMs, tokenSet } from "./datetime";

export function normalizeTranscriptLines(pkg: MemoPackage): TranscriptLine[] {
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

export function buildSections(pkg: MemoPackage, lines: TranscriptLine[]): TranscriptSection[] {
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

export function buildOverlays(pkg: MemoPackage, lines: TranscriptLine[]): TranscriptOverlay[] {
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

export function renderLine(
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

export function OverlayMark(props: {
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

export function overlayLineRange(line: TranscriptLine, overlay: TranscriptOverlay) {
  if (overlay.startOffset == null || overlay.endOffset == null) return undefined;
  const start = line.index === overlay.startLine ? overlay.startOffset : 0;
  const end = line.index === overlay.endLine ? overlay.endOffset : line.text.length;
  if (end <= start) return undefined;
  return { start, end };
}

export function findExcerpt(lines: TranscriptLine[], excerpt: string) {
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

export function findByTime(lines: TranscriptLine[], startMs: number | undefined, endMs: number | undefined) {
  if (startMs == null || endMs == null) return [];
  return lines.filter((line) => line.endMs >= startMs && line.startMs <= endMs);
}

export function approximateOriginalOffsets(text: string, excerpt: string) {
  const direct = text.toLowerCase().indexOf(excerpt.toLowerCase());
  if (direct >= 0) return { startOffset: direct, endOffset: direct + excerpt.length };
  return undefined;
}

export function windowOffsetsToLineOffsets(lines: TranscriptLine[], startOffset: number, endOffset: number) {
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

export function overlayType(type: ReviewType): OverlayType {
  return type === "claim" || type === "opinion" || type === "experience" ? "claimish" : type;
}

export function sourceStartMs(item: ReviewItem): number | undefined {
  return item.source?.startMs ?? parseClock(item.source?.start);
}

export function sourceEndMs(item: ReviewItem): number | undefined {
  return item.source?.endMs ?? parseClock(item.source?.end);
}

export function formatRange(item: ReviewItem): string {
  const start = sourceStartMs(item);
  const end = sourceEndMs(item);
  if (item.source?.start && item.source?.end) return `${item.source.start} - ${item.source.end}`;
  if (start == null || end == null) return "Unknown";
  return `${formatTime(start)} - ${formatTime(end)}`;
}

export function qualityLabel(quality: AnchorQuality): string {
  if (quality === "excerpt") return "Matched excerpt";
  if (quality === "fuzzy") return "Fuzzy excerpt";
  if (quality === "time") return "Matched time";
  if (quality === "segment") return "Segment evidence";
  return "Unmatched";
}

export function sourceLabel(item: ReviewItem): string {
  return item.source?.source ?? item.source?.sourceFiles?.join(", ") ?? "Unknown";
}
