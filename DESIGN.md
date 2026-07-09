# Design Sense

This document captures Byron's recurring design preferences from recent product and portfolio work. Treat it as a practical taste guide for future UI changes, not a rigid design system.

## Core Preference

Favor dense, functional interfaces that make the next action obvious. The UI should feel like a working tool: compact, legible, responsive to context, and free of decoration or affordances that do not earn their space.

The best designs here are quiet but precise. Small geometry issues, doubled borders, misaligned bleed, unnecessary labels, sticky-header scroll offsets, and empty placeholder states matter because they make the product feel less intentional.

## Information Architecture

- Prefer task-specific rails over generic sidebars.
- Put navigation, context, and controls near the work they affect.
- Use left rails for orientation and navigation, such as audio controls, table of contents, section durations, current-section indication, and related project items.
- Use right rails as focused inspectors or secondary detail areas, especially for selected content.
- Remove features from a surface when they belong somewhere else. For example, project assignment belongs on the Projects page, not the Review page.
- Collapse or move secondary actions into kebab menus when inline buttons compete with the content.
- Keep lists scannable: numbered lists often beat count summaries when the list itself is the thing being navigated.

## Visual Density

- Remove redundant labels like "recording", "transcript ready", "audio", and other obvious text when layout or context already communicates the meaning.
- Hide empty states that do not help. Do not show rows such as "No project assigned" when everything is assigned, or controls that only open "No projects".
- Prefer compact metadata rows, count tabs, pills, and small fields over large explanatory blocks.
- Keep important counts visible, but let the user choose which count categories are shown.
- Avoid showing the same text twice, especially excerpts/body text in inspectors.

## Controls

- Use icon-only controls for familiar actions when the surrounding context is clear.
- Prefer kebab menus for secondary actions such as copy, download, rename, dissolve, or section-level exports.
- Kebab buttons should often be ghost style: no visible border or background, with only subtle icon color changes on hover/open.
- Use full-width actions only when the action is primary within a focused inspector.
- Prefer controls that are always reachable over drag interactions that require scrolling or long pointer travel.
- If drag/drop makes a workflow awkward, replace it with explicit move controls.
- Floating menus should render above layout constraints and avoid being clipped. Portal/fixed-position overlays are appropriate for menus inside cards, rows, or scroll containers.

## Cards And Attached Elements

- Cards should feel integrated and engineered, not loosely assembled.
- Bottom pills or tabs should sit flush against the card edge when they function as attached metadata.
- Avoid visible gaps where card background shows through between attached controls and borders.
- Adjacent pills should share a single border, not double-thick borders.
- Middle joins should be flat when controls touch; keep rounding only on the outer ends.
- Preserve compact geometry and stable dimensions so controls do not shift the card layout.

## Layout Geometry

- Center things exactly when they are meant to be centered. A view picker should be visually dead center, independent of left title and right menu controls.
- Bleed should be balanced. If a visual expands beyond the prose column, split extra pixels evenly left and right when there is room.
- Cap wide elements before they clip offscreen or create horizontal overflow.
- Sticky headers must be accounted for in scroll targets. Section jumps should land below the sticky title/header, not underneath it.
- Verify actual rendered geometry when precision matters. Screenshots and DOM measurements are appropriate for alignment, overflow, and clipping issues.

## Interaction Philosophy

- Build the actual interaction, not a placeholder that only describes it.
- If prose references 10,000 points, render 10,000 points.
- If an interaction discusses zoom, provide visible zoom controls and consistent zoom affordances throughout.
- Prefer deterministic controls for explainers: sliders, explicit state, visible readouts, and reproducible motion.
- Let interaction teach through use. A mix of concise prose, real controls, and visual feedback is better than a long static explanation.
- Hidden state can be useful when it clarifies what the system is doing, such as viewport visibility or animation state.

## Motion And Performance

- Motion should be purposeful and resource-aware.
- Animations should pause when offscreen and resume only after a short delay when visible again.
- Treat play/pause as user intent, with viewport visibility as a separate gate for whether animation actually runs.
- Avoid expensive recomputation in normal workflows. Cache costly derived data when users expect it to be available immediately.
- Prefer canvas or other efficient rendering when the visual workload is large.

## Content And Writing

- Explanatory content should work up to an answer through concrete examples.
- Start simple, then layer complexity: basic scene, hover layer, drag/pan math, zoom, large data, animation.
- Prefer progressive disclosure over dumping everything into one giant document or UI surface.
- Reusable guidance belongs in helper/reference files; keep primary docs operational and focused.
- General-purpose patterns are more valuable than one-off instructions tied to a single demo.

## What To Avoid

- Do not leave unused affordances in place "just in case".
- Do not show controls that have no useful destination or action.
- Do not use placeholder visualizations when the promised real visualization is feasible.
- Do not let popovers be clipped by parent overflow.
- Do not let empty fallback text masquerade as real metadata.
- Do not rely on drag/drop when the workflow requires excessive travel, scrolling, or precision.
- Do not add decorative UI text that explains obvious controls.
- Do not accept lopsided alignment, doubled borders, or tiny gaps as harmless polish issues.

## Verification Bias

For UI work, lightweight visual verification is valuable:

- Run the build or typecheck when the change touches components or state wiring.
- Use browser screenshots when layout, clipping, scroll behavior, or interaction polish is the point of the change.
- Measure DOM geometry for centering, bleed, overflow, and sticky offset issues.
- Smoke test the actual workflow rather than only inspecting code.

## Short Version

Make the interface compact, useful, and exact. Remove what is not used. Keep actions close to their context. Use icons and menus when they reduce noise. Make attached controls physically line up. Center and align with care. Build real interactive proof instead of teasing it. Verify the rendered result when polish is the request.
