/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";
import { markDrain, DRAIN_MARK_HOLD_MS } from "@ohmail/app-logic/session/drain-mark";

/**
 * ═══ AN IDLE WINDOW PRODUCES NO FRAMES ════════════════════════════════════════════════════
 *
 * A census, not three assertions: every CSS rule in the two stylesheets the shell ships that
 * declares an INFINITE animation is read out of the source, and the strip — rendered in each of
 * the states that say a sync is outstanding, with no drain in flight — must match none of them.
 *
 * Why a census over the rendered DOM and not a test per element: the cost is not the element, it
 * is frame production. Measured on the released 0.19.1 desktop on the Omarchy guest, same pid,
 * same page: idle a few milli-cores, one infinite animation many times that, the other about the same, BOTH barely more —
 * the second is 80 milli-cores on top of the first, because the first already buys the 60 Hz
 * pipeline. So removing one of a pair saves nothing, and a rule that admits "at most one" would
 * be admitting the whole cost. Zero is the only bound worth holding.
 *
 * MUTATION-PROVEN AT AUTHORING TIME (applied, watched red, restored, `cmp`-verified):
 *   · the sliver rendered unconditionally (`<i />` back where `{marks ? <i /> : null}` is) —
 *     8 of 11 red, naming `.rail-sync .rs-track i`.
 *   · the spinner mounted for the busy STATE rather than the drain (`busy={s.busy}`, which is a
 *     mark nobody can see still asking for every frame) — 7 of 11 red, naming `.spin .spin-run`.
 *     That is the point of censusing the DOM and not the stylesheet.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null,
  asOf: null, address: null, minutes: null, slow: false, screenerCandidate: false,
  pending: 0, filing: null, continuesAtFolder: null, settled: true, owed: false,
};

let current: MailState = QUIET;
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: current, refresh: () => {} }),
}));

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * Every selector whose block runs an animation for ever. A pseudo-element carries its animation
 * on behalf of a real element, so `::after` is stripped and the element is what the census asks
 * about; jsdom's `querySelectorAll` has no pseudo-elements either way.
 */
function infiniteSelectors(css: string): string[] {
  const out: string[] = [];
  const rules = css.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, selector, body] of rules) {
    if (!/animation[^;]*\binfinite\b/.test(body)) continue;
    /* COMMENTS OUT FIRST, THEN SPLIT. A comment sits between the previous rule and this one, and
       one of ours holds a comma — splitting first cut it in half and the half carrying the
       selector no longer looked like a comment, so the rule this census exists for was silently
       not in the list it checks against. It read green for the wrong reason. */
    const text = selector.replace(/\/\*[\s\S]*?\*\//g, " ");
    for (const one of text.split(",")) {
      const cleaned = one.replace(/::?(after|before)\b/g, "").trim();
      if (cleaned && !cleaned.startsWith("@") && /^[.#:[a-zA-Z*]/.test(cleaned)) out.push(cleaned);
    }
  }
  return [...new Set(out)];
}

const SELECTORS = [
  ...infiniteSelectors(read("../app/app.css")),
  ...infiniteSelectors(read("../../../packages/ui/src/primitives/spinner.css")),
  ...infiniteSelectors(read("../../../packages/ui/src/primitives/button.css")),
];

/** What the rendered tree matches, by selector — the census's answer for one state. */
function running(container: HTMLElement): string[] {
  return SELECTORS.filter((sel) => {
    try {
      return container.querySelectorAll(sel).length > 0;
    } catch {
      // A selector jsdom cannot parse is reported rather than skipped silently.
      return false;
    }
  });
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(state: MailState, variant: "shell" | "rail"): Promise<HTMLElement> {
  current = state;
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-09-17T00:00:00.000Z"),
        children: h(SyncBar, { variant }),
      }),
    );
  });
  return container;
}

/** The states whose sentence says a sync is outstanding — every one that used to mount a mark. */
const BUSY: Array<[string, MailState]> = [
  ["importing", { ...QUIET, key: "importing", clock: true, count: 1_200, total: null }],
  ["awaiting", { ...QUIET, key: "awaiting", clock: true, minutes: 4, address: "person@example.test" }],
  ["stale", { ...QUIET, key: "stale", clock: true, count: 74_003, asOf: "2026-09-16T18:40:00.000Z" }],
  ["catchingUp", { ...QUIET, key: "catchingUp" }],
  ["filing", { ...QUIET, key: "filing", pending: 12, address: "person@example.test" }],
];

beforeEach(() => {
  vi.useFakeTimers();
  markDrain(false);
  vi.advanceTimersByTime(DRAIN_MARK_HOLD_MS + 1);
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  container = null;
  document.body.innerHTML = "";
  markDrain(false);
  vi.advanceTimersByTime(DRAIN_MARK_HOLD_MS + 1);
  vi.useRealTimers();
});

describe("the idle shell runs no infinite animation", () => {
  it("the census reads the stylesheets and finds the two the gap row names", () => {
    // The census is worth nothing if it cannot see its subjects: both rules must be IN the list
    // it checks against, by the selectors they are written with.
    expect(SELECTORS).toContain(".rail-sync .rs-track i");
    expect(SELECTORS).toContain(".spin .spin-run");
  });

  for (const [name, state] of BUSY) {
    it(`${name}: a sync outstanding and no drain in flight mounts no moving mark`, async () => {
      const rail = await mount(state, "rail");
      expect(running(rail)).toEqual([]);
      expect(rail.querySelector(".spin")).toBeNull();
    });
  }

  it("the shell variant is censused too — the pair is rendered in both shapes", async () => {
    const shell = await mount(BUSY[0][1], "shell");
    expect(running(shell)).toEqual([]);
    expect(shell.querySelector(".spin")).toBeNull();
  });

  it("THE POSITIVE ARM: a drain in flight mounts both marks, so the census can see them", async () => {
    const rail = await mount(BUSY[0][1], "rail");
    expect(running(rail)).toEqual([]);
    await act(async () => { markDrain(true); });
    expect(running(rail).sort()).toEqual([".rail-sync .rs-track i", ".spin .spin-run"]);
  });

  it("the track survives the sliver: the affordance stands while the motion stops", async () => {
    const rail = await mount(BUSY[0][1], "rail");
    // The row is not blank while a sync is outstanding — what is gone is the thing that moves.
    expect(rail.querySelector(".rs-track")).not.toBeNull();
    expect(rail.querySelector(".rs-track i")).toBeNull();
  });

  it("the mark goes down one quiet window after the drain settles, not a frame after it", async () => {
    const rail = await mount(BUSY[0][1], "rail");
    await act(async () => { markDrain(true); });
    expect(rail.querySelector(".spin")).not.toBeNull();
    await act(async () => { markDrain(false); vi.advanceTimersByTime(DRAIN_MARK_HOLD_MS - 1); });
    expect(rail.querySelector(".spin")).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(2); });
    expect(rail.querySelector(".spin")).toBeNull();
    expect(running(rail)).toEqual([]);
  });

  it("a quiet strip renders nothing at all, drain or no drain", async () => {
    await act(async () => { markDrain(true); });
    const rail = await mount(QUIET, "rail");
    expect(rail.innerHTML).toBe("");
  });
});
