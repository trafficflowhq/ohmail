/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseHash, goTriage, TRIAGE_PILES } from "../app/shell/routing";
import { shellFrameOf } from "./source-anchor";
import {
  act,
  answerSyncWith,
  installShellEnv,
  mailbox,
  mountShell,
  page,
  teardownShellEnv,
} from "./fixtures/live-walk-shell";

/**
 * THE THREE TRIAGE HORIZONS ARE THREE PLACES, AND THE PILES HAVE NUMBERS.
 *
 * Two reports, one seam — the rail.
 *
 * ── THE DIAGNOSIS THIS FILE PINS ──────────────────────────────────────────────────────
 *
 * *"the triage answer later .. etc. can't be selected individually, only Answer Later opens
 * on all 3"*. Exactly right, and it was three failures stacked:
 *
 *   1. `Route` had no representation for a triage pile at all — `view`, `tagId`,
 *      `screenerSegment`, and nothing else. Park was not unbound, it was unSAYable.
 *   2. `AppShell`'s rail handler was `if (id.startsWith("triage")) go("triage")`, which
 *      matched all three rows and discarded which one had been pressed.
 *   3. `activeRailId` mapped `view === "triage"` back to the literal `"triage"` — the Answer
 *      Later row — so the rail lit the first row however you had arrived.
 *
 * Each of the three gets an assertion, because fixing any two of them still leaves the bug. Over the new shell the
 * three horizons are three places of their own (Answer Later, Parked, Resurface): the old shell's wiring of a pile
 * axis left with it, each of its census cases by its row with its behaviour's holder named.
 */

describe("the route can say which pile is open", () => {
  it("#/triage, #/triage/aside and #/triage/resurface are three different routes", () => {
    expect(parseHash("#/triage").triagePile).toBe("reply");
    expect(parseHash("#/triage/aside").triagePile).toBe("aside");
    expect(parseHash("#/triage/resurface").triagePile).toBe("resurface");
    // All three are the triage VIEW — the pile is a second axis, not a second view.
    for (const hash of ["#/triage", "#/triage/aside", "#/triage/resurface"]) {
      expect(parseHash(hash).view).toBe("triage");
    }
  });

  it("an unknown pile falls to the first one rather than 404ing", () => {
    // Same rule the screener's segments already follow: a hash somebody typed or a stale
    // bookmark lands somewhere real.
    expect(parseHash("#/triage/nonsense").triagePile).toBe("reply");
    expect(parseHash("#/triage/nonsense").view).toBe("triage");
  });

  it("the first pile keeps the bare #/triage, so existing links still land", () => {
    goTriage("reply");
    expect(window.location.hash).toBe("#/triage");
    goTriage("aside");
    expect(window.location.hash).toBe("#/triage/aside");
  });

  it("every pile round-trips through the hash", () => {
    for (const pile of TRIAGE_PILES) {
      goTriage(pile);
      expect(parseHash(window.location.hash).triagePile).toBe(pile);
    }
  });
});

describe("the number keys", () => {
  /* The digits are derived from the rail and both live in `shell-keys.tsx` now (ARCH-022 L6). */
  const shell = shellFrameOf("numberNav").source;

  it("are DERIVED from the rail, never written out beside it", () => {
    // A hand-written table would be a second enumeration of the nav — the shape the (i)
    // panel's hand-typed key list had, and the one the `?` sheet is generated to avoid. It
    // goes wrong the first time a group gains an item.
    expect(shell).toMatch(/railGroups\s*\n?\s*\.flatMap\(\(g\) => g\.items\)/);
    expect(shell).toMatch(/chord: String\(i \+ 1\)/);
    // Nine at most: there is no key `10`, and a tenth pile must go unnumbered rather than
    // silently shifting the rest.
    expect(shell).toMatch(/\.slice\(0, 9\)/);
  });

  it("are listed in the ? sheet, because they declare their own labels", () => {
    // The sheet is generated from the registry (`groupedBindings`), so a binding with a
    // label is a documented binding. This pins that the label is real copy and not a blank:
    // the `g` chord's own sentence for a numbered place (so the sheet folds `1` and `g o`
    // into one row), and the generic "Go to {pile}" over the rail's label for any other row.
    expect(shell).toMatch(/label: PILE_CHORD_LABEL\[item\.id\] \? t\(PILE_CHORD_LABEL\[item\.id\]!\) : t\("shortcuts\.goPile", \{ pile: item\.label \}\)/);
  });
});

/* ── the rendered shell ─────────────────────────────────────────────────────────────── */

describe("the rail is QUIET until asked", () => {
  beforeEach(() => {
    installShellEnv();
    answerSyncWith(() => page(1));
    window.location.hash = "";
  });
  afterEach(teardownShellEnv);

  it("a number key navigates to the pile in that position", async () => {
    await mountShell([mailbox({ lastSyncAt: "2026-08-04T08:59:00.000Z" })]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "6", bubbles: true }));
    });
    // 5/6/7 are the triage horizons, so `6` is Park — the row that could not be reached at
    // all before, by key or by click.
    expect(window.location.hash).toBe("#/triage/aside");
  });

  it("a number typed into a field is a number, not navigation", async () => {
    // `isTypingTarget` in the registry does this for every binding; asserted here because
    // number keys are the ones most likely to be typed on purpose.
    await mountShell([mailbox({ lastSyncAt: "2026-08-04T08:59:00.000Z" })]);
    window.location.hash = "#/ohbox";
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    });
    expect(window.location.hash).toBe("#/ohbox");
    input.remove();
  });
});
