/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun, type FirstRunDecideSubject } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import {
  AGREE_REREAD_MS, AGREE_SWEEP_MS, firstRunImportOver, useFirstRunQueueSettle,
} from "../app/shell/first-run-queue-settle";
import { importOverOf, type OnboardingAi, type OnboardingFacts, type OnboardingMailbox } from "../app/shell/onboarding";
import type { FirstRunHost } from "../app/shell/first-run-host";

/**
 * THE AGREE'S OWN SWEEP. On Cloud the worker imports a consent-less reader before the run's Agree,
 * so the import is often over before anybody agrees; the Screener's held senders are written after
 * the press, by the sweep the doorbell starts. The pull's hold for the import's end never fires on
 * that path. The stage holds the pull for the senders its own Agree will move, re-asking the store,
 * until they arrive or the bound runs out. Composed the way AppShell composes it: the shell's hook,
 * the narrowed facts, and a store whose queue reaches the client only through a re-ask.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

const IMPORTED = "2026-10-19T00:00:00.000Z";
const AGREED = "2026-10-19T00:01:00.000Z";
/** The summary, in either shape: the role stays the reader's until the worker's gate answers. */
const SUMMARY = [t.doneTitle, t.doneReaderTitle];

const READER: OnboardingMailbox = {
  organizerRole: "reader",
  organizedBy: null,
  organizerState: null,
  organizerEventAt: null,
  takeoverAuthorizedAt: null,
  organizerChecked: true,
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
};

const roots: Root[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function flush() {
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
}

async function mount(start: { mb: OnboardingMailbox; ai?: OnboardingAi; senders?: number }) {
  const world = { mb: start.mb, storeQueue: 0, clientQueue: 0 };
  const log = { rereads: 0, completes: 0, decisions: [] as string[] };
  const etas: string[] = [];
  const headings: string[] = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  let bump: () => void = () => {};
  /** The store's queue page, asked: the client's count becomes the store's. */
  const reread = async () => { log.rereads++; world.clientQueue = world.storeQueue; bump(); };

  const Shell = () => {
    const [, set] = React.useState(0);
    bump = () => set((n) => n + 1);
    const [ai, setAi] = React.useState<OnboardingAi>(start.ai ?? "unset");
    React.useLayoutEffect(() => {
      const line = el.querySelector(".ob-eta")?.textContent;
      if (line) etas.push(line.trim());
      const hd = (el.querySelector("h1")?.textContent ?? "").trim();
      if (hd && headings[headings.length - 1] !== hd) headings.push(hd);
    });
    const mb = world.mb;
    const stripOver = mb.initialImportCompletedAt !== null;
    const queueSettling = useFirstRunQueueSettle({
      active: true, mailboxId: "mb-1", over: importOverOf({ ...mb, importOver: stripOver }), reread,
    });
    const facts: OnboardingFacts = {
      door: "cloud",
      mailbox: { ...mb, importOver: firstRunImportOver(stripOver, queueSettling) },
      account: { onboardingCompletedAt: null },
      ai,
      queuedSenders: world.clientQueue,
    };
    const host: FirstRunHost = {
      door: "cloud",
      ai,
      probe: async () => ({ host: "h", user: "u", folders: 1 }),
      connect: async () => ({ id: "mb-1" }),
      organize: async () => {
        world.mb = { ...world.mb, organizeConsentedAt: AGREED, takeoverAuthorizedAt: AGREED };
        return "stored";
      },
      countDecision: async () => ({
        letters: 5, senders: start.senders ?? 2, total: 5, complete: true, mirrored: true,
      }),
      complete: async () => { log.completes++; },
      setAiEnabled: async (on) => { setAi(on ? "on" : "off"); },
      probeReason: () => null,
      probeMessage: () => null,
    };
    const decide: FirstRunDecideSubject | null = world.clientQueue > 0 ? {
      name: "Sender", address: "sender@example.test", held: 2, waiting: world.clientQueue, since: "today",
      onDecide: (dest) => { log.decisions.push(dest); },
    } : null;
    return h(FirstRun, {
      host, facts, onRefresh: () => bump(), onLeave: () => {},
      pull: { screened: 0, history: 0, pulled: 0 }, decide, mailboxId: "mb-1", queueSettling,
      rereadQueue: reread,
    });
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, { children: h(Shell, null) }),
    }));
  });
  await flush();

  const heading = () => (el.querySelector("h1")?.textContent ?? "").trim();
  const eta = () => (el.querySelector(".ob-eta")?.textContent ?? "").trim();
  const press = async (label: string) => {
    const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
    if (!button) throw new Error(`no button labelled ${JSON.stringify(label)} on ${JSON.stringify(heading())}`);
    await act(async () => { button.click(); for (let i = 0; i < 20; i++) await Promise.resolve(); });
    await flush();
  };
  const choose = async (value: "yes" | "no") => {
    const radio = [...el.querySelectorAll("input[type=radio]")]
      .find((i) => (i as HTMLInputElement).value === value) as HTMLInputElement | undefined;
    if (!radio) throw new Error(`no ${value} option on screen`);
    await act(async () => { radio.click(); });
  };
  const key = async (k: string) => {
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  };
  /** A later GET /mailboxes read. */
  const pollRow = async (over: Partial<OnboardingMailbox>) => {
    world.mb = { ...world.mb, ...over };
    await act(async () => { bump(); });
    await flush();
  };
  const advance = async (ms: number) => {
    await act(async () => { vi.advanceTimersByTime(ms); });
    await flush();
  };
  /** The worker's agree sweep commits its Screener intents in the store. */
  const sweepLands = (senders: number) => { world.storeQueue = senders; };
  /** The engine's own re-ask after a sync page that touched the gate. */
  const engineReasks = async () => {
    world.clientQueue = world.storeQueue;
    await act(async () => { bump(); });
    await flush();
  };
  /** Consent → window → Agree → AI answered. */
  const agreeThenAnswer = async (answer: "yes" | "no" = "no") => {
    expect(heading()).toBe(t.consentTitle);
    await press(t.continue);
    expect(heading()).toBe(t.windowTitle);
    await press(t.agree);
    expect(heading()).toBe(t.aiTitle);
    await choose(answer);
    await press(t.continue);
  };
  return { el, world, log, etas, headings, heading, eta, press, key, pollRow, advance, sweepLands, engineReasks, agreeThenAnswer };
}

describe("Cloud: the import is over before the run's Agree", () => {
  for (const answer of ["no", "yes"] as const) {
    it(`after '${answer}' to AI the pull waits for the Agree's senders, then asks the first decision`, async () => {
      const s = await mount({ mb: { ...READER, initialImportCompletedAt: IMPORTED } });
      await s.agreeThenAnswer(answer);
      expect(s.heading(), "the run went on to the summary over an empty queue").toBe(t.pullTitle);
      expect(s.eta()).toBe(t.pullScreener);
      // The sweep lands after the press; the next re-ask brings it to the client.
      s.sweepLands(2);
      await s.advance(AGREE_REREAD_MS);
      expect(s.heading()).toBe(t.decideTitle);
      expect(s.headings.filter((x) => SUMMARY.includes(x))).toEqual([]);
      await s.key("o");
      expect(SUMMARY).toContain(s.heading());
      expect(s.log.decisions).toEqual(["ohbox"]);
      expect(s.log.completes, "the flow closed before the decision").toBe(0);
    });
  }

  it("the stamp lands while consent is open: the one ask answered 0, the Agree's own hold still waits", async () => {
    const s = await mount({ mb: { ...READER } });
    await s.pollRow({ initialImportCompletedAt: IMPORTED });
    expect(s.log.rereads, "the import's end asked once").toBe(1);
    await s.agreeThenAnswer();
    expect(s.heading()).toBe(t.pullTitle);
    expect(s.eta()).toBe(t.pullScreener);
    s.sweepLands(3);
    await s.advance(AGREE_REREAD_MS);
    expect(s.heading()).toBe(t.decideTitle);
  });

  it("a sweep that never lands releases at the bound, onto the summary", async () => {
    const s = await mount({ mb: { ...READER, initialImportCompletedAt: IMPORTED } });
    await s.agreeThenAnswer();
    expect(s.heading()).toBe(t.pullTitle);
    await s.advance(AGREE_SWEEP_MS - 1);
    expect(s.heading()).toBe(t.pullTitle);
    expect(s.log.rereads, "the hold never asked the store").toBeGreaterThan(0);
    await s.advance(1);
    expect(SUMMARY).toContain(s.heading());
    // Once released it does not hold again, and nothing asks after the bound.
    const asked = s.log.rereads;
    await s.advance(AGREE_SWEEP_MS);
    expect(s.log.rereads).toBe(asked);
  });

  it("CONTROL — the window showed no sender to screen: no wait, the summary at once", async () => {
    const s = await mount({ mb: { ...READER, initialImportCompletedAt: IMPORTED }, senders: 0 });
    await s.agreeThenAnswer();
    expect(SUMMARY).toContain(s.heading());
    expect(s.etas).not.toContain(t.pullScreener);
    expect(s.log.rereads).toBe(0);
  });

  it("CONTROL — the senders arrived before the AI answer: the decision at once, the line never said", async () => {
    const s = await mount({ mb: { ...READER, initialImportCompletedAt: IMPORTED } });
    expect(s.heading()).toBe(t.consentTitle);
    await s.press(t.continue);
    await s.press(t.agree);
    expect(s.heading()).toBe(t.aiTitle);
    s.sweepLands(2);
    await s.engineReasks();
    await s.press(t.continue);
    expect(s.heading()).toBe(t.decideTitle);
    expect(s.etas).not.toContain(t.pullScreener);
  });
});

describe("CONTROL: the import ends after the run's Agree", () => {
  it("the pull says the import's own words while it runs, then the decision", async () => {
    const s = await mount({ mb: { ...READER } });
    await s.agreeThenAnswer();
    expect(s.heading()).toBe(t.pullTitle);
    expect(s.eta(), "the Screener line over a running import").not.toBe(t.pullScreener);
    s.sweepLands(2);
    await s.pollRow({ initialImportCompletedAt: IMPORTED });
    expect(s.heading()).toBe(t.decideTitle);
  });
});
