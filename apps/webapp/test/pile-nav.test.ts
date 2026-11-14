/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fragmentOf, routeOf } from "@ohmail/app/frame/route";
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

const piles = ["later", "parked", "resurface"] as const;

describe("the route can say which pile is open", () => {
  it("#/triage, #/triage/aside and #/triage/resurface are three different routes", () => {
    expect(routeOf("#/triage").place).toBe("later");
    expect(routeOf("#/triage/aside").place).toBe("parked");
    expect(routeOf("#/triage/resurface").place).toBe("resurface");
  });

  it("an unknown pile falls to the first one rather than 404ing", () => {
    expect(routeOf("#/triage/nonsense").place).toBe("later");
  });

  it("the first pile keeps the bare #/triage, so existing links still land", () => {
    const start = routeOf("#/ohbox");
    expect(fragmentOf({ ...start, place: "later" })).toBe("#/triage");
    expect(fragmentOf({ ...start, place: "parked" })).toBe("#/triage/aside");
  });

  it("every pile round-trips through the hash", () => {
    const start = routeOf("#/ohbox");
    for (const place of piles) {
      expect(routeOf(fragmentOf({ ...start, place })).place).toBe(place);
    }
  });
});

describe("the number keys", () => {
  const chords = readFileSync("packages/app/src/frame/chords.tsx", "utf8");

  it("are DERIVED from the rail, never written out beside it", () => {
    expect(chords).toContain("for (const group of RAIL_GROUPS)");
    expect(chords).toContain("for (const id of RAIL_ORDER)");
    expect(chords).toContain("place.rail.group !== group");
    expect(chords).toContain("const DIGITS = 7;");
    expect(chords).toContain("drawn.slice(0, DIGITS).map((d, i) => ({ digit: String(i + 1), ...d }))");
  });

  it("are listed in the ? sheet, because they declare their own labels", () => {
    const digits = chords.slice(chords.indexOf("...digits.map("));
    expect(digits).toContain("chord: digit,");
    expect(digits).toContain('group: "navigate" as const,');
    expect(digits).toContain("label: goesTo(words, place, rail),");
    expect(chords).toContain('rail.keyLabel === undefined ? words(place.id)(rail.label) : words("shortcuts")(rail.keyLabel)');
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
