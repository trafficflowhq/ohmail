import { describe, it, expect } from "vitest";
import { HELD_ANCHOR_PAD_PX, heldAnchorTop } from "@ohmail/app-logic/lists/held-window";

/**
 * THE SCREENER'S READ COLUMN OPENS ON THE LATEST HELD MESSAGE — the arithmetic, guarded.
 *
 * ── WHY THIS EXISTS AND WHY IT IS NOT A MOUNTED TEST ────────────────────────────────────────
 *
 * Held mail renders oldest→newest, so a fresh render sits on the OLDEST message while the consent
 * decision a person is about to take is about the newest. The effect in `ScreenerView` scrolls the
 * `.scn-read` column so the last `.hmail` sits at the top, and until now nothing anywhere asserted
 * the offset it computes — the whole behaviour rested on one three-term expression written once.
 *
 * It cannot be asserted from a mounted view: jsdom implements no layout, so every
 * `getBoundingClientRect` is a zero rect and `scrollTop` never moves. A test that rendered
 * `ScreenerView` and asserted "the column scrolled" would be green for a correct formula, green for
 * a formula missing a term, and green for no formula at all. That is why the arithmetic was
 * extracted: the guard has to drive the numbers.
 *
 * ── THE MUTATIONS THESE TESTS WERE WATCHED FAILING UNDER ───────────────────────────────────
 *
 * Each case below fails under a DIFFERENT plausible rewrite, which is what makes the set worth more
 * than one assertion:
 *
 *  · dropping `+ scrollTop` — the version that works only from the top of an unscrolled column, and
 *    therefore works on the first sender you select and not on any after it. Caught by
 *    "already scrolled";
 *  · dropping `- readTop` — treats the message's VIEWPORT position as its content offset, so the
 *    error is exactly the column's distance from the top of the window. Caught by "the column is
 *    not at the top of the window";
 *  · dropping `Math.max(0, …)` — a negative target, which the DOM silently coerces to 0. Correct by
 *    accident, and the clamp is what makes it correct on purpose. Caught by "the first message in a
 *    short list";
 *  · dropping `- pad` — the anchored message flush against the column edge. Caught by every case.
 */

describe("heldAnchorTop", () => {
  it("puts the last held message at the top of an unscrolled column, minus the pad", () => {
    // Column starts at y=100 in the window; the last message's top is at y=520. It is 420px down the
    // content, so the column must scroll to 420 less the breathing room.
    expect(heldAnchorTop(100, 520, 0)).toBe(420 - HELD_ANCHOR_PAD_PX);
  });

  it("is a POSITION and not a delta when the column is already scrolled", () => {
    // The previous sender left the column at 300. The message is 420px below the viewport edge, so
    // its content offset is 720 — not 420. Without `+ scrollTop` this answers 406 and the reader
    // lands 300px short of the message, on every selection change after the first.
    expect(heldAnchorTop(100, 520, 300)).toBe(720 - HELD_ANCHOR_PAD_PX);
    // Same message, same content position, two different scroll states: the answer must be the same.
    expect(heldAnchorTop(100, 220, 600)).toBe(heldAnchorTop(100, 820, 0));
  });

  it("measures from the COLUMN, not from the top of the window", () => {
    // Two layouts with the message at the same offset inside the column and the column in two
    // different places on screen. Dropping `- readTop` makes these disagree by 400px.
    expect(heldAnchorTop(0, 420, 0)).toBe(heldAnchorTop(400, 820, 0));
  });

  it("never asks for a negative scrollTop", () => {
    // The first message in a list shorter than the column: its top is above the pad, so the raw
    // expression is negative. The DOM coerces that to 0, so an unclamped version is right by
    // accident — this pins it.
    expect(heldAnchorTop(100, 100, 0)).toBe(0);
    expect(heldAnchorTop(100, 105, 0)).toBe(0);
    expect(heldAnchorTop(100, 60, 0)).toBe(0);
  });

  it("leaves the pad above the anchored message", () => {
    // The pad is the whole reason the answer is not the bare offset: the message's own header would
    // otherwise be flush against the column edge and read as cut off.
    expect(heldAnchorTop(0, 1_000, 0)).toBe(1_000 - HELD_ANCHOR_PAD_PX);
    expect(HELD_ANCHOR_PAD_PX).toBeGreaterThan(0);
    // Overridable, so the caller's spacing is not welded into the arithmetic.
    expect(heldAnchorTop(0, 1_000, 0, 0)).toBe(1_000);
  });
});
