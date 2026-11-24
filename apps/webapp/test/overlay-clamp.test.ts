import { describe, expect, it } from "vitest";
import {
  OVERLAY_EDGE,
  OVERLAY_MIN_HEIGHT,
  clampOverlay,
} from "../app/screening/overlay-clamp";

/**
 * THE OVERLAY GEOMETRY, HELD AS ARITHMETIC.
 *
 * The defect this pins closed: every popover placed by `placePicker` opened downward at a fixed
 * height with `overflow: hidden` and a 190px flip guess, so the ~580px sender sheet anchored to
 * the last message of a thread rendered everything below "Reads" off-screen, and the ~600px
 * screening sheet at 1440×900 clipped "Screened out" and "Spam" out of reach — the re-decide
 * flow was blocked on that path. Page scroll cannot reveal a `position: fixed` box, and the
 * popover variant DISMISSES on scroll, so off-screen meant unreachable, not inconvenient.
 *
 * `clampOverlay` is the pure statement of the fix; `overlay-viewport.test.tsx` holds the wiring
 * (the components actually applying it). The numeric cases below are the sweep's MEASURED
 * geometry, not invented values, so a regression fails on the exact scenario that was filed.
 *
 * SORTED (share ohbox-2, the switch's older tests): `clampOverlay` is today's shell's (`app/shell/overlay-clamp.ts`),
 * which no host's entry reaches any more; the sheets stand on the kit's Menu (`placeMenu`, `menu.css`). The cases whose
 * promise the kit's own cases state are retired, each holder named where it stood; the four left (a sheet taller than
 * either side of its anchor stands whole, slid up; a sheet taller than the window takes its band and scrolls inside; a
 * point with no edges stands whole; the cap never a slit) are stated by no kit case: their rows are GAP:kit.
 */

describe("clampOverlay — the three placements", () => {
  /* "opens below the anchor when the whole sheet fits there" RETIRED (share ohbox-2): the sheets stand on the kit's
     Menu now; the same promise is held by `packages/ui/test/base/overlays.test.tsx`, "where a menu stands" > "under its anchor, 8 away, at the
     anchor's left edge". */
  /* "the measured popover: 583px anchored at 630/654 in a 900px viewport FLIPS above" RETIRED (share ohbox-2): held by
     `packages/ui/test/base/overlays.test.tsx`, "where a menu stands" > "upwards where it would leave the stage below and there is more room above". */
  it("TRI-F1's measured sheet: 599px with no room on either side stands WHOLE, slid up over its anchor", () => {
    // The ⋯ → Screening path at 1440×900: the sheet is taller than the space below AND above
    // its anchor, and the viewport holds it with room to spare. It used to take the roomier
    // side capped at ~430px with an inner scroll — "cut off even when plenty of space would be
    // available". Now it keeps its height and slides up from the anchor by exactly the pixels
    // it lacks, covering part of the row it opened from; nothing is clipped and nothing scrolls.
    const fit = clampOverlay({ y: 448, anchorTop: 420, anchorBottom: 440 }, 599, 900);
    expect(fit.maxHeight).toBeGreaterThanOrEqual(599); // whole: no inner scroll
    expect(fit.top).toBe(900 - OVERLAY_EDGE - 599); // slid up by what it lacked below
    expect(fit.top).toBeGreaterThanOrEqual(OVERLAY_EDGE);
    expect(fit.top + 599).toBeLessThanOrEqual(900 - OVERLAY_EDGE);
  });

  it("a sheet taller than the viewport takes the whole band and scrolls inside, whatever the anchor", () => {
    // 1000px of sheet in a 900px viewport: no placement can show it whole, so it takes the
    // viewport's full band — top inset to bottom inset — and the inner scroll is the way through.
    for (const anchor of [
      { y: 858, anchorTop: 830, anchorBottom: 850 },
      { y: 78, anchorTop: 50, anchorBottom: 70 },
      { y: 448, anchorTop: 420, anchorBottom: 440 },
    ]) {
      const fit = clampOverlay(anchor, 1000, 900);
      expect(fit.top).toBe(OVERLAY_EDGE);
      expect(fit.maxHeight).toBe(900 - 2 * OVERLAY_EDGE);
    }
  });

  it("a state without anchor edges (keyboard/synthetic) still stands whole below the point", () => {
    // `placePicker(null)`'s synthetic anchor sits at innerHeight/3; a hand-built state has no
    // edges at all. Both degrade to "below the point, whole" — slid up by the 17px this one
    // lacks — with nothing off-screen and nothing capped.
    const fit = clampOverlay({ y: 308 }, 599, 900);
    expect(fit.top).toBe(900 - OVERLAY_EDGE - 599);
    expect(fit.maxHeight).toBeGreaterThanOrEqual(599);
    expect(fit.top + 599).toBeLessThanOrEqual(900 - OVERLAY_EDGE);
  });

  /* "the phone viewport (390×844): a sheet opened low is fully reachable" RETIRED (share ohbox-2): held by
     `packages/ui/test/base/overlays.test.tsx`, "where a menu stands" > "never nearer than 8 to the stage's edge". */
});

describe("clampOverlay — the unconditional edges", () => {
  /* "never places any part of the sheet off-screen, across a sweep of real geometries" RETIRED (share ohbox-2): held by
     `packages/ui/test/base/overlays.test.tsx`, "where a menu stands" > "never nearer than 8 to the stage's edge". */
  it("the cap never collapses below the usable minimum, even mid-anchor on a 240px viewport", () => {
    // A short landscape keyboard-up viewport with the anchor mid-screen: both sides offer less
    // than the minimum. The floor wins — the sheet may then cover its anchor, which is the
    // correct last resort: a covered anchor is dismissable, a 90px slit of destinations is not.
    const fit = clampOverlay({ y: 142, anchorTop: 110, anchorBottom: 134 }, 599, 240);
    expect(fit.maxHeight).toBeGreaterThanOrEqual(OVERLAY_MIN_HEIGHT);
    // And the floored box still sits inside the viewport.
    expect(fit.top).toBeGreaterThanOrEqual(OVERLAY_EDGE);
    expect(fit.top + fit.maxHeight).toBeLessThanOrEqual(240 - OVERLAY_EDGE);
  });
});

/* The horizontal half (`clampOverlayX`): both its cases retired (share ohbox-2), their holders named below. */
/* "pulls a right-flush anchor back on-screen for the sheet's REAL 252px, not the 240 guess" RETIRED (share ohbox-2):
     held by `packages/ui/test/base/overlays.test.tsx`, "where a menu stands" > "never nearer than 8 to the stage's edge" (a point at the right edge pulled
     back by the menu's own width). */
/* "never pushes the box past the left inset" RETIRED (share ohbox-2): held by `packages/ui/test/base/overlays.test.tsx`, "where a menu stands" >
     "never nearer than 8 to the stage's edge" (an anchor at the left edge kept 8 in). */
