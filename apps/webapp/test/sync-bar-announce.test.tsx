/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";
import { POLL_MS } from "@ohmail/app-logic/session/sync-scheduler";

/**
 * ═══ THE IMPORT COUNTER IS SPOKEN, AND NOT SHOUTED ═══════════════════════════════════════
 *
 * A first import ran to a screen reader as one sentence and then nothing: the strip is a
 * `role="status"` region, and the half that moves — "N of M" — carries `aria-live="off"`
 * deliberately, because a number that steps several times a second supersedes its own
 * announcement before anyone hears it. So the number was in the tree and never said. Reported
 * from the Omarchy guest, where a walk of the tree came back empty and the framebuffer showed the
 * count plainly painted — a reading about the driver's walk, not about the product; what this
 * file holds is the product half.
 *
 * The strip now carries a second, visually-hidden region with the WHOLE sentence, throttled: at
 * most one announcement per `POLL_MS` (the product's own steady cadence for this fact, imported
 * rather than spelled), and where a denominator is known at most one per fixed share of it.
 *
 * MUTATION-PROVEN AT AUTHORING TIME (applied, watched red, restored, `cmp`-verified):
 *   · the `<SyncAnnouncer>` element removed from the shell shape — "the sentence is in the tree"
 *     and every throttle case go red; the spinner and count cases stay green.
 *   · `ANNOUNCE_MS = POLL_MS` → `0` — the throttle case goes red, the first-announcement case
 *     stays green.
 *   · the `if (!stepOk) return;` arm removed — the share-step case goes red alone.
 *   · `aria-atomic` dropped — the atomic case goes red alone.
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

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  container = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

/** Mount once, then step the state the way a drain does — the same root, never a remount. */
async function mount(state: MailState, variant?: "rail"): Promise<HTMLElement> {
  current = state;
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-04T00:00:00.000Z"),
        children: variant ? h(SyncBar, { variant }) : h(SyncBar, null),
      }),
    );
  });
  return container;
}

/** One more applied page: the count moves and the strip re-renders, as it does on every drain. */
async function step(state: MailState): Promise<void> {
  current = state;
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-04T00:00:00.000Z"),
        children: h(SyncBar, null),
      }),
    );
  });
}

const importing = (count: number, total: number | null = null): MailState =>
  ({ ...QUIET, key: "importing", clock: true, count, total });

const say = (c: HTMLElement): HTMLElement | null => c.querySelector<HTMLElement>(".sync-say");
/**
 * The WHOLE sentence, and every assertion below compares it exactly.
 *
 * `toContain` is unusable here and was measured being unusable: the sentence at a three-digit count
 * CONTAINS the one at its two-digit prefix, so two mutations that defeated the throttle outright —
 * the floor set to zero, the share gate deleted — both read GREEN through a substring match.
 */
const spoken = (c: HTMLElement): string => say(c)?.textContent ?? "";

describe("the strip says its whole sentence, once", () => {
  it("puts the sentence in the tree as a polite, atomic live region", async () => {
    const c = await mount(importing(1114, 1541));
    const region = say(c);
    expect(region, "the strip carries no spoken sentence at all").not.toBeNull();
    expect(region!.getAttribute("role")).toBe("status");
    expect(region!.getAttribute("aria-live")).toBe("polite");
    // Atomic, so the count is heard inside its sentence and never as a bare number.
    expect(region!.getAttribute("aria-atomic")).toBe("true");
    expect(spoken(c)).toBe("Syncing your mail. 1,114 of 1,541" + " messages");
  });

  it("stands INSIDE the strip, so the display:none copy cannot speak beside the visible one", async () => {
    const shell = await mount(importing(12));
    expect(say(shell)!.closest(".sync-bar"), "the announcer is not inside the shell strip").not.toBeNull();
    await act(async () => { root!.unmount(); });
    root = null;
    document.body.innerHTML = "";
    const rail = await mount(importing(12), "rail");
    expect(say(rail)!.closest(".rail-sync"), "the announcer is not inside the rail strip").not.toBeNull();
  });

  it("says the first sentence at once — a reader is told an import is running", async () => {
    const c = await mount(importing(40));
    expect(spoken(c)).toBe("Syncing your mail. 40 messages so far");
  });

  it("does not re-say it faster than the count's own steady cadence", async () => {
    const c = await mount(importing(40));
    expect(spoken(c)).toBe("Syncing your mail. 40 messages so far");

    // Four applied pages inside one poll interval. Without the floor each would supersede the
    // last before a reader heard one.
    for (const n of [90, 140, 190, 240]) {
      await act(async () => { vi.advanceTimersByTime(120); });
      await step(importing(n));
    }
    expect(spoken(c), "the region was re-said inside one poll interval")
      .toBe("Syncing your mail. 40 messages so far");

    // The trailing edge: the last number is not lost when the count stops moving.
    await act(async () => { vi.advanceTimersByTime(POLL_MS); });
    expect(spoken(c)).toBe("Syncing your mail. 240" + " messages so far");
  });

  it("with a denominator, waits for a 5% step as well as the clock", async () => {
    const c = await mount(importing(0, 1000));
    expect(spoken(c)).toBe("Syncing your mail. 0 of 1,000" + " messages");

    // Well past the clock, but not a step along: the sentence is the same one.
    await act(async () => { vi.advanceTimersByTime(POLL_MS * 3); });
    await step(importing(20, 1000));
    await act(async () => { vi.advanceTimersByTime(POLL_MS * 3); });
    expect(spoken(c), "a 2% move was announced").toBe("Syncing your mail. 0 of 1,000" + " messages");

    // Across the step, and the clock is long past: now it speaks.
    await step(importing(60, 1000));
    expect(spoken(c)).toBe("Syncing your mail. 60 of 1,000" + " messages");
  });

  it("leaves the visible count exactly where it was — unannounced, and not hidden", async () => {
    const c = await mount(importing(1114, 1541));
    const num = c.querySelector<HTMLElement>(".sync-bar > .num");
    expect(num, "the visible count is gone").not.toBeNull();
    expect(num!.textContent).toBe("1,114 of 1,541" + " messages");
    // `aria-live="off"` and NOT `aria-hidden`: the count is the information, and a reader
    // browsing the strip must still find it.
    expect(num!.getAttribute("aria-live")).toBe("off");
    expect(num!.getAttribute("aria-hidden")).toBeNull();
  });

  it("says nothing on the states with no volatile half — the region above already says those", async () => {
    const c = await mount({ ...QUIET, key: "failing" });
    expect(say(c), "a state with nothing moving grew a second live region").toBeNull();
  });
});
