/**
 * GEOMETRY UNDER THE WEB DOOR'S TEXT SIZE. A browser cannot zoom a page for it, so Settings → Text
 * size stamps a CSS `zoom` on `<html>` there. Under it, `getBoundingClientRect`, `clientX/Y` and
 * `innerWidth/Height` answer in VIEWPORT px while style lengths, `scrollTop`, `clientHeight` and
 * `offset*` stay in the page's own CSS px (measured in Chromium and WebKit: a row's rect 250 beside
 * a scrollTop of 200 for the same 200 px at 125%). Every viewport read the shell mixes with CSS px
 * goes through here, which divides by the stamped zoom. Identity where none is stamped: the default
 * size, and the desktop window, whose page zoom keeps everything in one space already.
 */

/** The custom property the stamp writes beside `zoom`; the webapp's `text-size.ts` spells it too. */
export const UI_ZOOM_VAR = "--ui-zoom";

/** The zoom stamped on `<html>`, or 1. Read off `--ui-zoom`, which the stamp writes with it. */
export function uiZoom(doc: Document | null | undefined = globalThis.document): number {
  const z = doc ? Number.parseFloat(doc.documentElement.style.getPropertyValue(UI_ZOOM_VAR)) : NaN;
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** A box in the page's own CSS px. */
export interface CssRect {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

/** `el.getBoundingClientRect()` in CSS px — the very rect object when no zoom is stamped. */
export function cssRect(el: Element): CssRect {
  const r = el.getBoundingClientRect();
  const z = uiZoom(el.ownerDocument);
  if (z === 1) return r;
  return {
    top: r.top / z,
    left: r.left / z,
    right: r.right / z,
    bottom: r.bottom / z,
    width: r.width / z,
    height: r.height / z,
    x: r.x / z,
    y: r.y / z,
  };
}

/** A pointer's `clientX/Y` in CSS px. */
export function cssPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const z = uiZoom();
  return { x: e.clientX / z, y: e.clientY / z };
}

/** The window's inner size in CSS px. */
export function cssViewport(win: Window | null | undefined = globalThis.window): { width: number; height: number } {
  if (!win) return { width: 0, height: 0 };
  const z = uiZoom(win.document);
  return { width: win.innerWidth / z, height: win.innerHeight / z };
}
