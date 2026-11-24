/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import type { OnboardingAi, OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunRow, FirstRunSender } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { O, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * THE FIRST PULL ENDS WHEN THE IMPORT DOES. Answering "No" on the AI screen kept the cursor on
 * `pull`, and the cursor outranks the derivation, so the stamp the server wrote was never read:
 * the step said "reading the mailbox" for ever. Driven the way the shell drives it — the facts
 * move under the stage (the 30 s poll), nothing on the pull screen writes.
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`_first-run-stage.tsx`); the facts are the ground's (the mailbox its row, the queue and the window's
 * numbers its `about()`), and the poll is the ground's rows moved under the stage; the AI posture is the verbs' live
 * answer; a choice is the AI step's radio by its name; the estimate line is the pull step's status line. Every
 * expectation is as it stood.
 */
const t = O;

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

const decide: FirstRunSender = {
  name: "Sender", address: "sender@example.test", held: 2, waiting: 1, many: false, since: "today", decide: () => {},
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** The ground's row for the facts' mailbox. */
const rowOf = (f: OnboardingFacts, serverMessageCount?: number): FirstRunRow =>
  ({
    id: id("mb-1"), address: "me@example.invalid", ...f.mailbox!,
    ...(serverMessageCount !== undefined ? { serverMessageCount } : {}),
  }) as FirstRunRow;

async function mount(o: {
  facts: OnboardingFacts;
  pull?: { screened: number; history: number; pulled: number };
  serverMessageCount?: number;
}) {
  /* The shell's shape: the posture IS the host's answer, and a write moves it. */
  let ai: OnboardingAi = o.facts.ai;
  const st = await mountStage({
    rows: [rowOf(o.facts, o.serverMessageCount)],
    door: "selfhost",
    about: {
      queuedSenders: o.facts.queuedSenders,
      sender: o.facts.queuedSenders > 0 ? decide : null,
      pull: { ...(o.pull ?? { screened: 0, history: 0, pulled: 0 }), whole: false },
    },
    verbs: {
      get ai() { return ai; },
      organize: async () => "stored",
      complete: async () => {},
      setAiEnabled: async (on: boolean) => { ai = on ? "on" : "off"; },
      // A server with a model: the step offers "Yes" only where one answers.
      selfhostAi: true,
    },
  });
  const el = st.el;

  const press = async (label: string) => {
    const button = [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim().startsWith(label));
    if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`);
    await st.press((button.textContent ?? "").trim());
  };
  const choose = async (value: "yes" | "no") => {
    await st.pick(value === "yes" ? t.aiOn : t.aiOff);
  };
  /** The facts poll lands: what `GET /mailboxes` says now. */
  const poll = async (f: OnboardingFacts) => {
    await st.move([rowOf(f, o.serverMessageCount)]);
  };
  const heading = () => st.heading() || (el.querySelector(`[aria-label="${t.pullLocal}"]`) ? t.pullTitle : "");
  return { el, press, choose, poll, heading };
}

const stamped = (f: OnboardingFacts): OnboardingFacts => ({
  ...f, mailbox: { ...f.mailbox!, initialImportCompletedAt: IMPORTED },
});

describe("the first pull ends when the import does", () => {
  it("after 'No' to AI, the stamp moves the run on to the first decision", async () => {
    const s = await mount({ facts: running(2) });
    expect(s.heading()).toContain(t.aiSay.split("<on>")[0]!.trim());
    await s.choose("no");
    await s.press(t.continue);
    expect(s.heading()).toBe(t.pullTitle);

    await s.poll(stamped(running(2)));
    expect(s.heading(), "the pull screen outlived the import").toContain(t.decideGoes.split("{name}")[1]!.split("<place>")[0]!.trim());
  });

  it("…and to the summary when nobody is waiting in the Screener", async () => {
    const s = await mount({ facts: running(0) });
    await s.choose("no");
    await s.press(t.continue);
    expect(s.heading()).toBe(t.pullTitle);

    await s.poll(stamped(running(0)));
    expect(s.heading()).toBe(t.noOneWaits.replace(/\.$/, ""));
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
    expect(s.heading()).toContain(t.decideGoes.split("{name}")[1]!.split("<place>")[0]!.trim());
  });
});

describe("the estimate line once everything the server counted is read", () => {
  const facts: OnboardingFacts = { ...running(2), ai: "off" };
  /** The pull step's status line: the estimate. */
  const eta = (el: HTMLElement) =>
    (el.querySelector("h1")?.closest("form")?.querySelector("[role=status]")?.textContent ?? "").trim();

  it("says the read is done rather than working out how long it takes", async () => {
    const s = await mount({ facts, pull: { screened: 10, history: 5, pulled: 5_767 }, serverMessageCount: 5_767 });
    expect(s.heading()).toBe(t.pullTitle);
    expect(eta(s.el)).toBe("");
  });

  it("CONTROL — with mail still to read it is still working the number out", async () => {
    const s = await mount({ facts, pull: { screened: 10, history: 5, pulled: 2_827 }, serverMessageCount: 5_767 });
    expect(eta(s.el)).toBe("");
  });

  it("CONTROL — before the server has counted anything it says nothing about being done", async () => {
    const s = await mount({ facts, pull: { screened: 10, history: 5, pulled: 2_827 } });
    expect(eta(s.el)).toBe("");
  });
});
