/**
 * THE SCHEME CHANGES BY FADING, NOT BY CUTTING — one helper, two callers.
 *
 * Every token on the page moves at once when the scheme changes, and the mail list alone is
 * hundreds of rows: transitioning them individually is the expensive way to do the cheap thing.
 * `document.startViewTransition` crossfades the whole document as one composited pair of
 * snapshots, so the cost does not grow with the row count and ANY token change is covered,
 * including the Omarchy feed restaging the live palette.
 *
 * Three refusals, in order, and each of them is the whole point of the helper existing rather
 * than a CSS rule:
 *
 *  · `prefers-reduced-motion: reduce` — instant, no transition and no class. Not "slower":
 *    the house policy is that state changes become immediate.
 *  · NOT ARMED — instant. The provider arms this one frame after it mounts, so the adoption
 *    stamp that re-writes the boot value does not animate the window into existence.
 *  · No `startViewTransition` — the `scheme-shift` class instead, for 320 ms. WebKitGTK,
 *    WKWebView and WebView2 do not all have the API, so it is feature-detected rather than
 *    assumed, and the class is RE-ARMED on a second change rather than stacked.
 */

/** 320 ms: the 280 ms transition plus a frame, so the class outlives what it starts. */
const FALLBACK_MS = 320;
const SHIFT_CLASS = "scheme-shift";

let armed = false;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

/** The API as this file uses it. Read off the document through `unknown` rather than by
 *  widening `Document`: the DOM lib declares it non-optional in newer versions and optional in
 *  older ones, and this helper's whole job is not to assume which runtime it is in. */
type StartViewTransition = (callback: () => void) => unknown;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Arm the crossfade — called by the ONE provider, one frame after it mounts. Before this every
 * change applies instantly, which is what keeps the boot stamps (the pre-paint init script and
 * the provider's adoption) from animating.
 */
export function armSchemeTransitions(): void {
  armed = true;
}

/** Tests only: back to the state a fresh document starts in. */
export function resetSchemeTransitionsForTests(): void {
  armed = false;
  if (fallbackTimer !== null) clearTimeout(fallbackTimer);
  fallbackTimer = null;
  if (typeof document !== "undefined") document.documentElement.classList.remove(SHIFT_CLASS);
}

/**
 * Apply a scheme change through the crossfade. `apply` must do the whole change — the
 * attribute stamp, or the live theme's style write — because the API snapshots the document
 * around the callback and anything left outside it is what the fade is measured against.
 */
export function withSchemeTransition(apply: () => void): void {
  const doc = typeof document === "undefined" ? null : document;
  if (!doc || !armed || prefersReducedMotion()) {
    apply();
    return;
  }
  const start = (doc as unknown as { startViewTransition?: StartViewTransition })
    .startViewTransition;
  if (typeof start === "function") {
    start.call(doc, apply);
    return;
  }
  const root = doc.documentElement;
  root.classList.add(SHIFT_CLASS);
  if (fallbackTimer !== null) clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    root.classList.remove(SHIFT_CLASS);
  }, FALLBACK_MS);
  apply();
}
