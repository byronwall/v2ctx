import type { UrlSelection, WorkspaceView } from "./reviewTypes";
import type { MemoPackage } from "./types";
import { transcriptQueryParam, snippetQueryParam, viewQueryParam } from "./reviewTypes";

export function readUrlSelection(): UrlSelection {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const view = params.get(viewQueryParam);
  return {
    transcript: params.get(transcriptQueryParam) || undefined,
    snippet: params.get(snippetQueryParam) || undefined,
    view: isWorkspaceView(view) ? view : undefined,
  };
}

export function isWorkspaceView(value: string | null): value is WorkspaceView {
  return value === "review" || value === "projects" || value === "items" || value === "topics" || value === "memos";
}

export function overlayIdForPackage(packageName: string, overlayId: string | undefined, packages: MemoPackage[]): string {
  if (!overlayId) return "";
  const memoPackage = packages.find((pkg) => pkg.name === packageName);
  if (!memoPackage) return "";
  return memoPackage.reviewItems.some((item) => item.id === overlayId) ? overlayId : "";
}

export function replaceUrlSelection(selection: UrlSelection) {
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

export function clearSectionHash() {
  if (typeof window === "undefined" || !window.location.hash) return;
  const url = new URL(window.location.href);
  url.hash = "";
  const next = `${url.pathname}${url.search}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.replaceState(null, "", next);
}

export function lineDomId(index: number): string {
  return `transcript-line-${index}`;
}

export function sectionDomId(id: string): string {
  const normalized = id.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `section-${normalized || "transcript"}`;
}

export function currentSectionHashId(): string {
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

export function scrollToSectionHash(behavior: ScrollBehavior): boolean {
  const id = currentSectionHashId();
  if (!id) return false;
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ block: "start", behavior });
  return true;
}
