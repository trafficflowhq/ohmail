/** @vitest-environment jsdom */
import { describe, expect, it, afterEach, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider, useKeyBindings } from "../app/shell/keymap";
import type { FirstRunDecisionCount, FirstRunHost } from "../app/shell/first-run-host";
import type { OnboardingFacts, OnboardingMailbox } from "../app/shell/onboarding";

/**
 * THE AGREE SCREEN NAMES WHAT AGREEING SCREENS. "How far back" says how many letters
 * from how many undecided senders will wait in the Screener, for the window being chosen, and the press
 * carries `screenBacklog` only when that count was on screen. The count is the whole window, past
 * 1,000 too; a walk stopped at its bound says "more than". Controls: a door with no count names none
 * and asks for no screening of older mail; a takeover asks for none either. While the import is open
 * a lost connection is said in plain words, and its return once.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

const NOBODY: OnboardingMailbox = {
  organizerRole: "reader", organizedBy: null, organizerState: null,
  organizeConsentedAt: null, initialImportCompletedAt: null,
};
const LIVE: OnboardingMailbox = {
  ...NOBODY, organizedBy: { kind: "local", name: "W-live", since: "2026-09-26T08:00:00.000Z" },
  organizerState: "held", organizerEventAt: "2026-09-26T08:17:50.000Z",
};

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

async function mount(
  first: OnboardingMailbox,
  count: ((s: { dormancyDays?: number; scope?: string }) => FirstRunDecisionCount) | null,
  { behind, raw, ai = "unset" }: { behind?: () => void; raw?: FirstRunHost["countDecision"]; ai?: OnboardingFacts["ai"] } = {},
) {
  const facts: OnboardingFacts = {
    door: "selfhost", mailbox: first, account: { onboardingCompletedAt: null }, ai, queuedSenders: 0,
  };
  const asked: Array<{ dormancyDays?: number; scope?: string }> = [];
  const organizedWith: Array<Record<string, unknown>> = [];
  const host: FirstRunHost = {
    door: "selfhost", ai,
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    organize: async (_id, body) => { organizedWith.push(body as Record<string, unknown>); return "stored"; },
    ...(count ? { countDecision: async (_id: string, s: { dormancyDays?: number; scope?: string }) => { asked.push(s); return count(s); } } : {}),
    ...(raw ? { countDecision: raw } : {}),
    complete: async () => { /* stamped */ },
    probeReason: () => null,
    probeMessage: () => null,
  };
  /** A shell binding behind the stage — `g s`, the press measured on the rig. */
  const Behind = () => {
    useKeyBindings(React.useMemo(() => [{ chord: "g s", group: "navigate" as const, label: "Screener", run: () => behind?.() }], []));
    return null;
  };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  /** The shell's render, again with a newer read of the mailbox. */
  const render = async (mailbox: OnboardingMailbox): Promise<void> => {
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(KeymapProvider, { children: [
          h(Behind, { key: "b" }),
          h(FirstRun, {
            key: "s", host, facts: { ...facts, mailbox }, onRefresh: () => { /* re-read */ }, onLeave: () => { /* left */ },
            pull: { screened: 0, history: 0, pulled: 0 }, decide: null, mailboxId: "mb-1",
          }),
        ] }),
      }));
    });
  };
  await render(first);
  const flush = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };
  const button = (label: string) =>
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label)) as HTMLButtonElement | undefined;
  const press = async (label: string) => {
    const b = button(label);
    if (!b) throw new Error(`no button labelled ${JSON.stringify(label)}`);
    await act(async () => { b.click(); });
    await flush();
  };
  return {
    el, asked, organizedWith, press, flush, render,
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    countLine: () => (el.querySelector(".ob-agree-count")?.textContent ?? "").trim(),
    choose: async (label: string) => {
      const r = [...el.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes(label));
      const input = r?.querySelector("input") ?? null;
      if (!input) throw new Error(`no choice ${label}`);
      await act(async () => { (input as HTMLInputElement).click(); });
      await flush();
    },
    key: async (k: string) => {
      await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
    },
  };
}

const EIGHTEEN = { letters: 18, senders: 3, total: 18, complete: true, mirrored: true };

describe("How far back names what agreeing screens", () => {
  it("names the count for the chosen window, and the press carries it", async () => {
    const s = await mount(NOBODY, () => EIGHTEEN);
    await s.press(t.continue);
    expect(s.heading()).toBe(t.windowTitle);
    await s.flush();
    expect(s.countLine()).toBe("18 letters from 3 senders you have not decided about will wait in the Screener.");
    expect(s.asked.at(-1)).toEqual({ dormancyDays: 365, scope: "window" });
    await s.press(t.agree);
    expect(s.organizedWith).toHaveLength(1);
    expect(s.organizedWith[0]).toMatchObject({ intent: "join", screenBacklog: true });
  });

  it("asks again for another window, and names the whole count past 1,000", async () => {
    const s = await mount(NOBODY, (sc) => (sc.scope === "all_time"
      ? { letters: 4212, senders: 41, total: 4212, complete: true, mirrored: true }
      : EIGHTEEN));
    await s.press(t.continue);
    await s.choose(t.winAll);
    expect(s.asked.at(-1)).toEqual({ scope: "all_time" });
    expect(s.countLine()).toBe("4,212 letters from 41 senders you have not decided about will wait in the Screener.");
  });

  it("a walk that stopped at its bound says more than", async () => {
    const s = await mount(NOBODY, () => ({ letters: 5000, senders: 22, total: 5000, complete: false, mirrored: true }));
    await s.press(t.continue);
    await s.flush();
    expect(s.countLine()).toBe("More than 5,000 letters from at least 22 senders you have not decided about will wait in the Screener.");
  });

  it("says when nothing in the window waits for a decision", async () => {
    const s = await mount(NOBODY, () => ({ letters: 0, senders: 0, total: 0, complete: true, mirrored: true }));
    await s.press(t.continue);
    await s.flush();
    expect(s.countLine()).toBe(t.agreeCountNone);
  });

  it("while the first import still reads the mailbox it says so, never \"nothing\", and the press still carries the count", async () => {
    const s = await mount(NOBODY, () => ({ letters: 0, senders: 0, total: 0, complete: true, mirrored: false }));
    await s.press(t.continue);
    await s.flush();
    expect(s.countLine()).toBe(t.agreeCountReading);
    expect(s.countLine()).not.toBe(t.agreeCountNone);
    await s.press(t.agree);
    expect(s.organizedWith[0]).toMatchObject({ intent: "join", screenBacklog: true });
  });

  it("a count so far is read again until the import is done, then says the whole count", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let reads = 0;
      const s = await mount(NOBODY, () => (++reads === 1
        ? { letters: 5, senders: 2, total: 5, complete: true, mirrored: false }
        : { ...EIGHTEEN }));
      await s.press(t.continue);
      await s.flush();
      expect(reads).toBe(1);
      await act(async () => { vi.advanceTimersByTime(5_000); });
      await s.flush();
      expect(reads, "the count so far was not read again").toBe(2);
      expect(s.countLine()).toBe("18 letters from 3 senders you have not decided about will wait in the Screener.");
      await act(async () => { vi.advanceTimersByTime(20_000); });
      await s.flush();
      expect(reads, "a whole count is read again").toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a slow count is read again at ten times its own time, never two at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let reads = 0;
      let inFlight = 0;
      let most = 0;
      const slow: FirstRunHost["countDecision"] = () => {
        reads++;
        inFlight++;
        most = Math.max(most, inFlight);
        return new Promise((r) => setTimeout(() => {
          inFlight--;
          r({ letters: 5, senders: 2, total: 5, complete: true, mirrored: false });
        }, 1_000));
      };
      const s = await mount(NOBODY, null, { raw: slow });
      await s.press(t.continue);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(reads).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
      expect(reads, "read again before ten times its own time").toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(reads).toBe(2);
      expect(most).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a count so far names itself so", async () => {
    const s = await mount(NOBODY, () => ({ letters: 5, senders: 2, total: 5, complete: true, mirrored: false }));
    await s.press(t.continue);
    await s.flush();
    expect(s.countLine()).toBe(
      "ohmail is still reading this window. So far 5 letters from 2 senders you have not decided about would wait in the "
      + "Screener; mail it reads after you agree goes to the Screener too.",
    );
  });

  it("CONTROL — a door with no count names none, and the press asks for no screening of older mail", async () => {
    const s = await mount(NOBODY, null);
    await s.press(t.continue);
    expect(s.countLine()).toBe("");
    await s.press(t.agree);
    expect(s.organizedWith[0]).not.toHaveProperty("screenBacklog");
  });

  it("CONTROL — a takeover asks for no count and no screening of older mail", async () => {
    const s = await mount(LIVE, () => EIGHTEEN);
    expect(s.heading()).toBe(t.elsewhereTitle);
    await s.press(t.continue);
    await s.press(t.continue);
    expect(s.heading()).toBe(t.windowTitle);
    await s.flush();
    expect(s.countLine()).toBe("");
    expect(s.asked, "a takeover asked what agreeing would screen").toEqual([]);
    await s.press(t.agree);
    expect(s.organizedWith[0]).toMatchObject({ intent: "takeover" });
    expect(s.organizedWith[0]).not.toHaveProperty("screenBacklog");
  });
});

describe("the stage keeps focus", () => {
  it("a shell binding behind it does not run, and Escape asks", async () => {
    let ran = 0;
    const s = await mount(NOBODY, () => EIGHTEEN, { behind: () => { ran++; } });
    await s.key("g");
    await s.key("s");
    expect(ran, "a key behind the stage reached the shell").toBe(0);
    await s.key("Escape");
    await s.flush();
    expect(s.el.textContent).toContain(t.cancel);
  });
});

describe("the import's lost connection is said in plain words", () => {
  const COUNT = { letters: 5, senders: 2, total: 5, complete: true, mirrored: false };
  const PULLING: OnboardingMailbox = {
    ...NOBODY, organizerRole: "organizer", organizeConsentedAt: "2026-10-24T08:00:00.000Z", initialImportCompletedAt: null,
  };

  it("the window step says it is reconnecting while the server cannot be reached", async () => {
    const s = await mount({ ...NOBODY, unreachable: true }, () => COUNT);
    await s.press(t.continue);
    await s.flush();
    expect(s.el.textContent).toContain(t.windowReconnecting);
    await s.render(NOBODY);
    expect(s.el.textContent).not.toContain(t.windowReconnecting);
  });

  it("the pull step says reconnecting, then that the connection came back", async () => {
    const s = await mount(PULLING, () => COUNT, { ai: "off" });
    expect(s.heading()).toBe(t.pullTitle);
    expect(s.el.textContent).not.toContain(t.pullResumed);
    await s.render({ ...PULLING, unreachable: true });
    expect(s.el.textContent).toContain(t.pullReconnecting);
    expect(s.el.textContent).not.toContain(t.pullResumed);
    await s.render(PULLING);
    expect(s.el.textContent).not.toContain(t.pullReconnecting);
    expect(s.el.textContent).toContain(t.pullResumed);
  });

  it("CONTROL — once the import is over neither line shows", async () => {
    const s = await mount({ ...PULLING, initialImportCompletedAt: "2026-10-24T09:00:00.000Z", unreachable: true }, () => COUNT, { ai: "off" });
    expect(s.el.textContent).not.toContain(t.pullReconnecting);
    expect(s.el.textContent).not.toContain(t.windowReconnecting);
  });
});
