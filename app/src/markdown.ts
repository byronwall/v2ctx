import type { MemoPackage } from "./types";
import type { ProjectRecord, TranscriptSection } from "./reviewTypes";
import { formatDuration, formatTime } from "./datetime";
import { packageDisplayTitle, packageDurationMs } from "./packageModel";
import { buildSections, normalizeTranscriptLines } from "./transcriptModel";

export function buildPackageMarkdown(pkg: MemoPackage): string {
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

export function buildSectionMarkdown(section: TranscriptSection, pkg: MemoPackage | undefined): string {
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

export function buildProjectMarkdown(project: ProjectRecord, packages: MemoPackage[]): string {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const recordingSections = project.recordingNames.flatMap((packageName) => {
    const pkg = byName.get(packageName);
    if (!pkg) return [];
    return [`## ${packageDisplayTitle(pkg)}\n\n${buildPackageMarkdown(pkg).replace(/^# .+\n+/, "")}`];
  });
  const parts = [
    `# ${project.name}`,
    "Project transcript export",
    project.description ? `Description: ${project.description}` : "",
    project.recordingNames.length ? "\n## Whole Recording Transcripts" : "",
    recordingSections.join("\n\n"),
  ];
  return compactMarkdown(parts);
}

export function sectionMarkdownBody(section: TranscriptSection, headingLevel: number): string {
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

export function transcriptTextMarkdown(section: TranscriptSection): string {
  if (section.lines.length) {
    return section.lines
      .filter((line) => line.text.trim())
      .map((line) => `[${formatTime(line.startMs)}] ${line.text.trim()}`)
      .join("\n\n");
  }
  return section.fallbackText?.trim() || "_No transcript text available._";
}

export function compactMarkdown(parts: string[]): string {
  return `${parts.filter((part) => part.trim()).join("\n\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export async function copyMarkdown(markdown: string): Promise<boolean> {
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

export function downloadMarkdownFile(filename: string, markdown: string) {
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

export function markdownFilename(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${normalized || "transcript"}.md`;
}
