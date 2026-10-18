/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun, type FirstRunDecideSubject } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import { firstRunImportOver } from "../app/shell/first-run-queue-settle";
import type { FirstRunHost } from "../app/shell/first-run-host";
import type { OnboardingAi, OnboardingFacts } from "../app/shell/onboarding";

/**
 * THE FIRST DECISION WAITS FOR THE SCREENER. The import's stamp and the Screener's waiting count
 * come from two clocks: when the stamp's poll landed first, the run walked from the pull to the
 * summary over an empty queue, and the senders held in the Screener arrived seconds later. The
 * shell now holds the import open (`queueSettling`) until the store has answered the queue since
 * the import ended; the stage says so on the pull screen, and the decision step is never blank.
 * Driven the way the shell drives it: facts and the hold move under the stage together.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

const IMPORTED = "2026-09-25T17:14:14.000Z";

/** Consented, the AI question open, the import still running. */
const running = (queuedSenders: number): OnboardingFacts => ({
  door: "selfhost",
  mailbox: {
    organizerRole: "organizer",
    organizedBy: null,
    organizerState: null,
    organizeConsentedAt: "2026-09-25T17:13:40.000Z",
    initialImportCompletedAt: null,
  },
  account: { onboardingCompletedAt: null },
  ai: "unset",
  queuedSenders,
});

const stamped = (f: OnboardingFacts): OnboardingFacts => ({
  ...f, mailbox: { ...f.mailbox!, initialImportCompletedAt: IMPORTED },
});

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

interface Poll { facts: OnboardingFacts; queueSettling?: boolean; noCard?: boolean }

async function mount(start: Poll) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const decisions: string[] = [];
  /* Every `.ob-eta` line any render committed, so a control can say a line NEVER appeared. */
  const etas: string[] = [];
  let setPoll: (p: Poll) => void = () => {};
  let setAi: (a: OnboardingAi) => void = () => {};

  const Stage = () => {
    const [p, putPoll] = React.useState(start);
    const [ai, putAi] = React.useState<OnboardingAi>(start.facts.ai);
    setPoll = putPoll;
    setAi = putAi;
    React.useLayoutEffect(() => {
      const line = el.querySelector(".ob-eta")?.textContent;
      if (line) etas.push(line.trim());
    });
    const host: FirstRunHost = {
      door: "selfhost",
      ai,
      probe: async () => ({ host: "h", user: "u", folders: 1 }),
      connect: async () => ({ id: "mb-1" }),
      organize: async () => "stored",
      complete: async () => {},
      setAiEnabled: async (on) => { setAi(on ? "on" : "off"); },
      probeReason: () => null,
      probeMessage: () => null,
      selfhostAi: true,
    };
    const settling = p.queueSettling === true;
    const mb = p.facts.mailbox!;
    /* AppShell's composition: the hold narrows the strip's `importOver`, nothing else. */
    const over = firstRunImportOver(mb.importOver, settling);
    const facts: OnboardingFacts = {
      ...p.facts, ai,
      mailbox: { ...mb, ...(over === undefined ? {} : { importOver: over }) },
    };
    const decide: FirstRunDecideSubject = {
      name: "Sender", address: "sender@example.test", held: 2, waiting: p.facts.queuedSenders, since: "today",
      onDecide: (dest) => { decisions.push(dest); },
    };
    return h(FirstRun, {
      host,
      facts,
      onRefresh: () => {},
      onLeave: () => {},
      pull: { screened: 0, history: 0, pulled: 0 },
      decide: p.facts.queuedSenders > 0 && !p.noCard ? decide : null,
      mailboxId: "mb-1",
      queueSettling: settling,
    });
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, { children: h(Stage, null) }),
    }));
  });

  const press = async (label: string) => {
    const button = [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim().startsWith(label));
    if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`);
    await act(async () => {
      button.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  };
  const choose = async (value: "yes" | "no") => {
    const radio = [...el.querySelectorAll("input[type=radio]")]
      .find((i) => (i as HTMLInputElement).value === value) as HTMLInputElement | undefined;
    if (!radio) throw new Error(`no ${value} option on screen`);
    await act(async () => { radio.click(); });
  };
  /** A decision verb, by its key — the bar listens on the document inside the stage. */
  const key = async (k: string) => {
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  };
  const poll = async (p: Poll) => { await act(async () => { setPoll(p); }); };
  const heading = () => (el.querySelector("h1")?.textContent ?? "").trim();
  const eta = () => (el.querySelector(".ob-eta")?.textContent ?? "").trim();
  return { el, press, choose, key, poll, heading, eta, decisions, etas };
}

/** Into the pull, the way a person gets there: the AI question answered. */
async function toPull(queued: number, answer: "yes" | "no" = "no") {
  const s = await mount({ facts: running(queued) });
  expect(s.heading()).toBe(t.aiTitle);
  await s.choose(answer);
  await s.press(t.continue);
  expect(s.heading()).toBe(t.pullTitle);
  return s;
}

describe("held senders reach the mirror after the import reads as over", () => {
  for (const answer of ["no", "yes"] as const) {
    it(`after '${answer}' to AI, the pull waits for the Screener and then asks the first decision`, async () => {
      const s = await toPull(0, answer);
      // The stamp lands; the store has not answered the queue since.
      await s.poll({ facts: stamped(running(0)), queueSettling: true });
      expect(s.heading(), "the run walked past the queue it had not read").toBe(t.pullTitle);
      expect(s.eta()).toBe(t.pullScreener);
      // The store answers: two senders are waiting.
      await s.poll({ facts: stamped(running(2)) });
      expect(s.heading()).toBe(t.decideTitle);
    });
  }

  it("senders landing after the summary re-open the step once, and never a second time", async () => {
    const s = await toPull(0);
    await s.poll({ facts: stamped(running(0)) });
    expect(s.heading()).toBe(t.doneTitle);
    await s.poll({ facts: stamped(running(2)) });
    expect(s.heading(), "the late senders did not bring the step back").toBe(t.decideTitle);
    await s.key("o");
    expect(s.heading()).toBe(t.doneTitle);
    expect(s.decisions).toEqual(["ohbox"]);
    await s.poll({ facts: stamped(running(5)) });
    expect(s.heading(), "the step showed twice").toBe(t.doneTitle);
    await s.poll({ facts: stamped(running(0)) });
    expect(s.heading()).toBe(t.doneTitle);
    expect(s.decisions, "the decision ran more than once").toEqual(["ohbox"]);
  });

  it("CONTROL — nobody waiting: the hold ends on the summary, no decision step", async () => {
    const s = await toPull(0);
    await s.poll({ facts: stamped(running(0)), queueSettling: true });
    expect(s.heading()).toBe(t.pullTitle);
    await s.poll({ facts: stamped(running(0)) });
    expect(s.heading()).toBe(t.doneTitle);
  });

  it("CONTROL — senders already waiting: the decision at once, the Screener line never said", async () => {
    const s = await toPull(2);
    await s.poll({ facts: stamped(running(2)) });
    expect(s.heading()).toBe(t.decideTitle);
    expect(s.etas.length, "the pull screen was never observed").toBeGreaterThan(0);
    expect(s.etas).not.toContain(t.pullScreener);
  });

  it("CONTROL — the hold says nothing while the import is still running", async () => {
    const s = await toPull(0);
    await s.poll({ facts: running(0) });
    expect(s.heading()).toBe(t.pullTitle);
    expect(s.eta()).not.toBe(t.pullScreener);
  });
});

describe("the decision step is never blank", () => {
  it("a count with no card yet says it is fetching the sender, and can be left", async () => {
    const s = await mount({ facts: { ...stamped(running(2)), ai: "off" }, noCard: true });
    expect(s.heading(), "the step rendered nothing").toBe(t.decideTitle);
    expect((s.el.querySelector("[role=status]")?.textContent ?? "").trim()).toBe(t.decideLoading);
    const leave = [...s.el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(t.pullLeave));
    expect(leave, "no way out of the waiting step").toBeDefined();
  });

  it("…and the card replaces it once the sender lands", async () => {
    const s = await mount({ facts: { ...stamped(running(2)), ai: "off" }, noCard: true });
    await s.poll({ facts: { ...stamped(running(2)), ai: "off" } });
    expect(s.heading()).toBe(t.decideTitle);
    expect(s.el.querySelector(".ob-sender"), "the card did not replace the wait").not.toBeNull();
    expect(s.el.textContent).not.toContain(t.decideLoading);
  });
});
