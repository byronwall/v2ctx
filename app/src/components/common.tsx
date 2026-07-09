import { createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { LibraryLoadResult } from "../reviewTypes";
import { copyMarkdown, downloadMarkdownFile } from "../markdown";

export function ExportMarkdownActions(props: {
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

export function MarkdownExportMenu(props: {
  label: string;
  markdown: () => string;
  filename: () => string;
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
    return "Copy Markdown";
  };

  return (
    <Popover
      class="markdown-export-menu"
      panelClass="markdown-export-popover"
      triggerLabel={`Export ${props.label}`}
      trigger={<span class="kebab-icon" aria-hidden="true"></span>}
      content={({ close }) => (
        <>
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

export function ProjectExportMenu(props: {
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

export function Popover(props: {
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

export function ReviewActionsMenu(props: {
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

export function ActionButton(props: {
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

export function AwaitResource(props: { resource: () => LibraryLoadResult | undefined; children: JSX.Element }) {
  props.resource();
  return <>{props.children}</>;
}

export function EmptyState(props: { text: string }) {
  return <div class="empty">{props.text}</div>;
}
