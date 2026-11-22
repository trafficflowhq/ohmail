/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { firstRunImportOver } from "@ohmail/app-logic/doors/first-run-queue-settle";
import type { OnboardingAi, OnboardingMailbox } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunRow, FirstRunSender } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { O, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * THE FIRST DECISION WAITS FOR THE SCREENER. The import's stamp and the Screener's waiting count
 * come from two clocks: when the stamp's poll landed first, the run walked from the pull to the
 * summary over an empty queue, and the senders held in the Screener arrived seconds later. The
 * shell now holds the import open (`queueSettling`) until the store has answered the queue since
 * the import ended; the stage says so on the pull screen, and the decision step is never blank.
 * Driven the way the shell drives it: facts and the hold move under the stage together.
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`packages/app/src/mailboxes/first-run`) over a ground the case moves (`_first-run-stage.tsx`): the
 * case plays the ground's fill (`live.ts`), which composes the hold into the row's `importOver` and hands
 * `queueSettling` and the head sender in the ground's `about`, as `AppShell` did; its words the stage's catalogue;
 * the pull's line is the step's status line, the card is the decision's group named for its sender; a key reaches the
 * element that has the keys. Every expectation is as it stood.
 */

const t = O;

/** What the ground hands: the mailbox, the account's AI answer and how many senders wait. */
interface Facts { mailbox: OnboardingMailbox; ai: OnboardingAi; queuedSenders: number }

const IMPORTED = "2026-09-25T17:14:14.000Z";

/** Consented, the AI question open, the import still running. */
const running = (queuedSenders: number): Facts => ({
  mailbox: {
    organizerRole: "organizer",
    organizedBy: null,
    organizerState: null,
    organizeConsentedAt: "2026-09-25T17:13:40.000Z",
    initialImportCompletedAt: null,
  },
  ai: "unset",
  queuedSenders,
});

const stamped = (f: Facts): Facts => ({
  ...f, mailbox: { ...f.mailbox!, initialImportCompletedAt: IMPORTED },
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

interface Poll { facts: Facts; queueSettling?: boolean; noCard?: boolean }

async function mount(start: Poll) {
  const decisions: string[] = [];
  let p = start;
  let ai: OnboardingAi = start.facts.ai;
  const sender = (): FirstRunSender => ({
    name: "Sender", address: "sender@example.test", held: 2, waiting: p.facts.queuedSenders, many: false, since: "today",
    decide: (dest) => { decisions.push(dest); },
  });
  /* The ground's fill: the hold narrows the row's `importOver`, nothing else (`live.ts`, as AppShell composed it). */
  const rows = (): FirstRunRow[] => {
    const mb = p.facts.mailbox;
    const over = firstRunImportOver(mb.importOver, p.queueSettling === true);
    return [{ id: id("mb-1"), address: "me@example.invalid", ...mb, ...(over === undefined ? {} : { importOver: over }) } as FirstRunRow];
  };
  const st = await mountStage({
    rows: rows(),
    door: "selfhost",
    live: rows,
    about: {
      get queuedSenders() { return p.facts.queuedSenders; },
      get queueSettling() { return p.queueSettling === true; },
      get sender() { return p.facts.queuedSenders > 0 && !p.noCard ? sender() : null; },
    } as never,
    verbs: {
      /* The host's AI answer, read live: the answer's write moves it, as the host's next read does. */
      get ai() { return ai; },
      organize: async () => "stored",
      complete: async () => {},
      setAiEnabled: async (on: boolean) => { ai = on ? "on" : "off"; },
      selfhostAi: true,
    },
  });
  const el = st.el;
  /* Every status line the pull step drew, so a control can say a line NEVER appeared. */
  const etas: string[] = [];
  const statusNow = () => (el.querySelector("main [role=status]")?.textContent ?? "").trim();
  const seen = () => {
    if (st.heading() !== t.pullTitle) return;
    const line = statusNow();
    if (etas.at(-1) !== line) etas.push(line);
  };
  seen();
  new MutationObserver(seen).observe(el, { subtree: true, childList: true, characterData: true });

  const press = async (label: string) => {
    const button = [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim().startsWith(label));
    if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`);
    await act(async () => {
      button.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  };
  /** The AI question's two answers by their names: no is the stage's "no", yes is the other. */
  const choose = async (value: "yes" | "no") => {
    await st.pick(value === "yes" ? t.aiOn : t.aiOff);
  };
  /** A decision verb, by its key, as a browser delivers it: at the element that has the keys. */
  const key = async (k: string) => {
    await act(async () => { (el.querySelector<HTMLElement>('[role="group"][aria-label="Sender"]') ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  };
  const poll = async (next: Poll) => { p = next; await st.move(rows()); };
  const heading = st.heading;
  const eta = () => statusNow();
  return { el, press, choose, key, poll, heading, eta, decisions, etas };
}

/** Into the pull, the way a person gets there: the AI question answered. */
async function toPull(queued: number, answer: "yes" | "no" = "no") {
  const s = await mount({ facts: running(queued) });
  expect(s.heading()).toContain(t.aiSay.split("<on>")[0]!.trim());
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
      expect(s.heading()).toContain(t.decideGoes.split("{name}")[1]!.split("<place>")[0]!.trim());
    });
  }

  it("senders landing after the summary re-open the step once, and never a second time", async () => {
    const s = await toPull(0);
    await s.poll({ facts: stamped(running(0)) });
    expect(s.heading()).toBe(t.noOneWaits.replace(/\.$/, ""));
    await s.poll({ facts: stamped(running(2)) });
    expect(s.heading(), "the late senders did not bring the step back").toContain(t.decideGoes.split("{name}")[1]!.split("<place>")[0]!.trim());
    await s.key("o");
    expect(s.heading()).toBe("2 more wait in the Screener");
    expect(s.decisions).toEqual(["ohbox"]);
    await s.poll({ facts: stamped(running(5)) });
    expect(s.heading(), "the step showed twice").toBe("5 more wait in the Screener");
    await s.poll({ facts: stamped(running(0)) });
    expect(s.heading()).toBe(t.noOneWaits.replace(/\.$/, ""));
    expect(s.decisions, "the decision ran more than once").toEqual(["ohbox"]);
  });

  it("CONTROL — nobody waiting: the hold ends on the summary, no decision step", async () => {
    const s = await toPull(0);
    await s.poll({ facts: stamped(running(0)), queueSettling: true });
    expect(s.heading()).toBe(t.pullTitle);
    await s.poll({ facts: stamped(running(0)) });
    expect(s.heading()).toBe(t.noOneWaits.replace(/\.$/, ""));
  });

  it("CONTROL — senders already waiting: the decision at once, the Screener line never said", async () => {
    const s = await toPull(2);
    await s.poll({ facts: stamped(running(2)) });
    expect(s.heading()).toContain(t.decideGoes.split("{name}")[1]!.split("<place>")[0]!.trim());
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
    expect(s.eta(), "the step rendered nothing").toBe(t.decideLoading);
    const leave = [...s.el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(t.pullLeave));
    expect(leave, "no way out of the waiting step").toBeDefined();
  });

  it("…and the card replaces it once the sender lands", async () => {
    const s = await mount({ facts: { ...stamped(running(2)), ai: "off" }, noCard: true });
    await s.poll({ facts: { ...stamped(running(2)), ai: "off" } });
    expect(s.heading()).toContain(t.decideGoes.split("{name}")[1]!.split("<place>")[0]!.trim());
    expect(s.el.querySelector('[role="group"][aria-label="Sender"]'), "the card did not replace the wait").not.toBeNull();
    expect(s.el.textContent).not.toContain(t.decideLoading);
  });
});
