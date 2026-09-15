/**
 * THE SCHEME CHANGES BY FADING, NOT BY CUTTING — one helper, two callers.
 *
 * `document.startViewTransition` crossfades the document as one composited pair of snapshots, so
 * cost does not grow with the row count and ANY token change is covered. Three refusals, each the
 * reason this is a helper and not a CSS rule: `prefers-reduced-motion` is instant, because state
 * changes become immediate rather than slower; NOT ARMED is instant, the provider arming a frame
 * after mount so the adoption stamp does not animate the window into existence; and with no
 * `startViewTransition` the `scheme-shift` class runs 320 ms, feature-detected and RE-ARMED.
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
