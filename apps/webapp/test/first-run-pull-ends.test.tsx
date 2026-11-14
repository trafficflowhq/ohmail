/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun, type FirstRunDecideSubject } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingAi, OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";

/**
 * THE FIRST PULL ENDS WHEN THE IMPORT DOES. Answering "No" on the AI screen kept the cursor on
 * `pull`, and the cursor outranks the derivation, so the stamp the server wrote was never read:
 * the step said "reading the mailbox" for ever. Driven the way the shell drives it — the facts
 * move under the stage (the 30 s poll), nothing on the pull screen writes.
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

const decide: FirstRunDecideSubject = {
  name: "Sender", address: "sender@example.test", held: 2, waiting: 1, since: "today", onDecide: () => {},
};

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

async function mount(o: {
  facts: OnboardingFacts;
  pull?: { screened: number; history: number; pulled: number };
  serverMessageCount?: number;
}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  let setFacts: (f: OnboardingFacts) => void = () => {};
  let setAi: (a: OnboardingAi) => void = () => {};

  /* The shell's shape: `facts.ai` IS the host's posture, and a write re-reads through `onRefresh`. */
  const Stage = () => {
    const [facts, putFacts] = React.useState(o.facts);
    const [ai, putAi] = React.useState<OnboardingAi>(o.facts.ai);
    setFacts = putFacts;
    setAi = putAi;
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
      // A server with a model: the step offers "Yes" only where one answers (R23-06).
      selfhostAi: true,
    };
    return h(FirstRun, {
      host,
      facts: { ...facts, ai },
      onRefresh: () => {},
      onLeave: () => {},
      pull: o.pull ?? { screened: 0, history: 0, pulled: 0 },
      ...(o.serverMessageCount !== undefined ? { serverMessageCount: o.serverMessageCount } : {}),
      decide: facts.queuedSenders > 0 ? decide : null,
      mailboxId: "mb-1",
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
  /** The facts poll lands: what `GET /mailboxes` says now. */
  const poll = async (f: OnboardingFacts) => {
    await act(async () => { setFacts(f); });
  };
  const heading = () => (el.querySelector("h1")?.textContent ?? "").trim();
  return { el, press, choose, poll, heading };
}

const stamped = (f: OnboardingFacts): OnboardingFacts => ({
  ...f, mailbox: { ...f.mailbox!, initialImportCompletedAt: IMPORTED },
});

describe("the first pull ends when the import does", () => {
  it("after 'No' to AI, the stamp moves the run on to the first decision", async () => {
    const s = await mount({ facts: running(2) });
    expect(s.heading()).toBe(t.aiTitle);
    await s.choose("no");
    await s.press(t.continue);
    expect(s.heading()).toBe(t.pullTitle);

    await s.poll(stamped(running(2)));
    expect(s.heading(), "the pull screen outlived the import").toBe(t.decideTitle);
  });

  it("…and to the summary when nobody is waiting in the Screener", async () => {
    const s = await mount({ facts: running(0) });
    await s.choose("no");
    await s.press(t.continue);
    expect(s.heading()).toBe(t.pullTitle);

    await s.poll(stamped(running(0)));
    expect(s.heading()).toBe(t.doneTitle);
  });

  it("CONTROL — while the import runs the pull screen stays", async () => {
    const s = await mount({ facts: running(2) });
    await s.choose("no");
    await s.press(t.continue);
    await s.poll(running(2));
    expect(s.heading()).toBe(t.pullTitle);
  });

  it("CONTROL — after 'Yes' the same stamp ends the pull, as it always did", async () => {
    const s = await mount({ facts: running(2) });
    await s.choose("yes");
    await s.press(t.continue);
    expect(s.heading()).toBe(t.pullTitle);
    await s.poll(stamped(running(2)));
    expect(s.heading()).toBe(t.decideTitle);
  });
});

describe("the estimate line once everything the server counted is read", () => {
  const facts: OnboardingFacts = { ...running(2), ai: "off" };
  const eta = (el: HTMLElement) => (el.querySelector(".ob-eta")?.textContent ?? "").trim();

  it("says the read is done rather than working out how long it takes", async () => {
    const s = await mount({ facts, pull: { screened: 10, history: 5, pulled: 5_767 }, serverMessageCount: 5_767 });
    expect(s.heading()).toBe(t.pullTitle);
    expect(eta(s.el)).toBe(t.pullRead);
  });

  it("CONTROL — with mail still to read it is still working the number out", async () => {
    const s = await mount({ facts, pull: { screened: 10, history: 5, pulled: 2_827 }, serverMessageCount: 5_767 });
    expect(eta(s.el)).toBe(t.etaSoon);
  });

  it("CONTROL — before the server has counted anything it says nothing about being done", async () => {
    const s = await mount({ facts, pull: { screened: 10, history: 5, pulled: 2_827 } });
    expect(eta(s.el)).toBe(t.etaSoon);
  });
});
