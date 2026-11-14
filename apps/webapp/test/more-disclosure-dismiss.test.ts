/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import { menu, moreButton, mountPanel } from "./_reader-1-panel.js";

/**
 * ═══ THE MORE MENU COULD NOT BE DISMISSED BY PRESSING ITS OWN BUTTON ═══════════════════════
 *
 * ── THE SEQUENCE, WHICH IS ONE PRESS AND TWO HANDLERS ───────────────────────────────────────
 *
 * A real pointer press fires `pointerdown` and `mousedown`, then `pointerup` and `mouseup`, then `click`. A menu
 * that dismisses on the press landing outside itself while its trigger toggles on `click` ran both halves of the
 * single press on its own button: the press closed it, the click opened it again. Net effect: nothing. The first
 * thing anybody does to put a menu away is press the button that opened it, and that was the one gesture that could
 * not.
 *
 * ── WHY THE OLD TEST WAS GREEN THROUGH ALL OF IT ────────────────────────────────────────────
 *
 * Because it dispatched `click` alone, a sequence no pointer produces. This file drives the press the way a pointer
 * does: `pointer()` is the only way it presses anything, so a case here cannot go back to the easier input.
 *
 * ── RE-POINTED (share reader-1, the switch's older tests) ───────────────────────────────────
 *
 * Today's `MoreMenu` under a hand-made trigger leaves with today's reader. The menu is the open letter's More, as
 * the new reader draws it (the kit's `Menu` out of the panel's More button, `_reader-1-panel.tsx`), pressed as a
 * pointer presses it. In a browser the open menu's veil stands over the page and takes a press beside the menu (the
 * kit's own case: `packages/ui/test/base/overlays.test.tsx`, "a press beside it closes it"); here the press is
 * dispatched on the control itself, as the case always made it. The cases of today's component alone (its document
 * listener, its configuration without an anchor, the click-only record) left with it, held by the first case below.
 */

afterEach(cleanup);

const opened = (): HTMLElement | null => menu("More");

/** A press, as a pointing device makes one: down, up, then click. */
async function pointer(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/* jsdom carries no PointerEvent of its own: a MouseEvent by that name is what a pointer's down and up are to it. */
if (typeof globalThis.PointerEvent === "undefined") {
  (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {};
}

describe("one press is one dismissal", () => {
  it("THE REGRESSION: pressing the open trigger closes the menu and leaves it closed", async () => {
    mountPanel();
    await pointer(moreButton());
    expect(opened(), "the press did not open the menu").not.toBeNull();
    await pointer(moreButton());
    expect(opened(), "the menu reopened in the same press that dismissed it").toBeNull();
  });

  it("a press inside the menu does not dismiss it either", async () => {
    mountPanel();
    await pointer(moreButton());
    const inside = within(screen.getByRole("menu", { name: "More" })).getAllByRole("menuitem")[0]!;
    await act(async () => {
      inside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      inside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(opened(), "pressing an item dismissed the menu before the item could run").not.toBeNull();
  });
});
