# Sticky Viewport Rails

The review UI uses sticky left and right rails that must stay visible while the
main transcript scrolls, but must not extend below the viewport when the page is
at the top and the masthead is still taking vertical space.

The issue with a static sticky height is that this rule only works after the rail
has stuck to the top offset:

```css
max-height: calc(100vh - 32px);
```

At the top of the page, the rail starts below the masthead, so its visible top is
lower than `16px`. The rail needs to be sized from its actual viewport top, not
from the eventual sticky top.

## Required Styles

Keep the rail sticky and use a CSS custom property for the current viewport top:

```css
.memo-list,
.evidence-pane {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - var(--sticky-pane-viewport-top, 16px) - 16px);
  overflow: hidden;
  border: 1px solid #deded8;
  border-radius: 8px;
  background: #fff;
}
```

For rails with internal scrolling, the rail itself should hide overflow and the
inner content area should scroll:

```css
.memo-list {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: 8px;
  padding: 10px;
}

.memo-scroll {
  display: grid;
  align-content: start;
  gap: 2px;
  min-height: 0;
  overflow: auto;
  padding-right: 2px;
}

.evidence-pane {
  display: grid;
  align-content: start;
  gap: 12px;
  padding: 14px;
  overflow: auto;
}
```

The key expression is:

```css
max-height: calc(100vh - var(--sticky-pane-viewport-top, 16px) - 16px);
```

This means:

- `100vh`: the viewport height.
- `--sticky-pane-viewport-top`: the rail's current distance from the top of the viewport.
- Final `16px`: the desired bottom breathing room.
- Fallback `16px`: the sticky `top` offset before JavaScript has measured the pane.

## Required Measurement Hook

On mount, measure each sticky rail's actual `getBoundingClientRect().top`, clamp
it to the sticky top offset, and write it into the CSS variable. Recompute on
scroll and resize with `requestAnimationFrame` so the rails expand once they
stick at `top: 16px`.

```ts
onMount(() => {
  let stickyPaneFrame = 0;

  const updateStickyPaneBounds = () => {
    stickyPaneFrame = 0;
    document.querySelectorAll<HTMLElement>(".memo-list, .evidence-pane").forEach((pane) => {
      const viewportTop = Math.max(16, Math.ceil(pane.getBoundingClientRect().top));
      pane.style.setProperty("--sticky-pane-viewport-top", `${viewportTop}px`);
    });
  };

  const scheduleStickyPaneUpdate = () => {
    if (stickyPaneFrame) return;
    stickyPaneFrame = window.requestAnimationFrame(updateStickyPaneBounds);
  };

  window.addEventListener("scroll", scheduleStickyPaneUpdate, { passive: true });
  window.addEventListener("resize", scheduleStickyPaneUpdate);
  scheduleStickyPaneUpdate();

  onCleanup(() => {
    window.removeEventListener("scroll", scheduleStickyPaneUpdate);
    window.removeEventListener("resize", scheduleStickyPaneUpdate);
    if (stickyPaneFrame) window.cancelAnimationFrame(stickyPaneFrame);
  });
});
```

## Why This Works

At page top, the measured top includes the masthead and workspace spacing, so the
rail height becomes `viewport - actualTop - bottomGap`. This keeps the bottom
inside the viewport.

After the page scrolls, `position: sticky` pins the rail at `top: 16px`. The next
measurement sees a top of `16px`, so the rail expands to `viewport - 16px -
16px`. The rail remains sticky because the page layout is still normal document
flow; the rail is not trapped inside a shortened grid row.

## Verification

A useful browser check is to measure the rail before and after page scroll:

```js
const readRail = (selector) => {
  const el = document.querySelector(selector);
  const rect = el.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
    height: rect.height,
    maxHeight: getComputedStyle(el).maxHeight,
    position: getComputedStyle(el).position,
  };
};

console.log({
  innerHeight: window.innerHeight,
  scrollY: window.scrollY,
  left: readRail(".memo-list"),
  right: readRail(".evidence-pane"),
});
```

Expected result:

- At page top, rail bottoms are inside `window.innerHeight`.
- After scrolling, rails still report `position: sticky`.
- After scrolling, rail top is the sticky offset, `16px`.
- Rail bottom remains inside the viewport with the configured bottom gap.
