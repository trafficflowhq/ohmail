/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import {
  AGREE_REREAD_MS, AGREE_SWEEP_MS, firstRunImportOver, useFirstRunQueueSettle,
} from "@ohmail/app-logic/doors/first-run-queue-settle";
import { importOverOf, type OnboardingAi, type OnboardingMailbox } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunGround, FirstRunRow, FirstRunSender } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { movable } from "../../../packages/app/test/support/fake-window.js";
import { O, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * THE AGREE'S OWN SWEEP. On Cloud the worker imports a consent-less reader before the run's Agree,
 * so the import is often over before anybody agrees; the Screener's held senders are written after
 * the press, by the sweep the doorbell starts. The pull's hold for the import's end never fires on
 * that path. The stage holds the pull for the senders its own Agree will move, re-asking the store,
 * until they arrive or the bound runs out. Composed the way AppShell composes it: the shell's hook,
 * the narrowed facts, and a store whose queue reaches the client only through a re-ask.
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`packages/app/src/mailboxes/first-run`) over a ground the case fills (`_first-run-stage.tsx`'s
 * `fill`): the fill is `live.ts`'s, the shell's hook (`useFirstRunQueueSettle`) composed into the row's `importOver`,
 * the queue's count, the head sender and the re-ask in the ground's `about`; its words the stage's catalogue; the
 * pull's line is the step's status line; a key reaches the element that has the keys. Every expectation is as it stood.
 */

const t = O;

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

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function flush() {
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
}

/**
 * Every text a selector's elements said, in order, the passing ones too: a commit that drew a line and the next that
 * took it away inside one batch are both read (the removed node's text, a character change's old value).
 */
function said(el: HTMLElement, selector: string): { all: string[]; distinct: string[] } {
  const all: string[] = [];
  const distinct: string[] = [];
  const add = (text: string | null | undefined) => {
    const line = (text ?? "").trim();
    if (!line) return;
    all.push(line);
    if (distinct[distinct.length - 1] !== line) distinct.push(line);
  };
  const within = (n: Node): Element[] =>
    n instanceof Element ? [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)] : [];
  const now = () => { for (const e of el.querySelectorAll(selector)) add(e.textContent); };
  now();
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") {
        if (r.target.parentElement?.closest(selector)) add(r.oldValue);
        continue;
      }
      for (const n of r.removedNodes) for (const e of within(n)) add(e.textContent);
      if (r.target instanceof Element && r.target.closest(selector)) {
        for (const n of r.removedNodes) if (!(n instanceof Element)) add(n.textContent);
      }
    }
    now();
  }).observe(el, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  return { all, distinct };
}

async function mount(start: { mb: OnboardingMailbox; ai?: OnboardingAi; senders?: number }) {
  const world = movable({ mb: start.mb, storeQueue: 0, clientQueue: 0 });
  const log = { rereads: 0, completes: 0, decisions: [] as string[] };
  let ai: OnboardingAi = start.ai ?? "unset";
  /** The store's queue page, asked: the client's count becomes the store's. */
  const reread = async () => { log.rereads++; world.set({ ...world.read(), clientQueue: world.read().storeQueue }); };

  /* The ground's fill as the host composes it (`live.ts`, as AppShell did): the hold narrows the run's row's
     `importOver`; the count, the head sender and the re-ask are the ground's `about`. */
  const fill = (ground: FirstRunGround): FirstRunGround => {
    const w = useSyncExternalStore(world.subscribe, world.read);
    const mb = w.mb;
    const stripOver = mb.initialImportCompletedAt !== null;
    const queueSettling = useFirstRunQueueSettle({
      active: true, mailboxId: "mb-1", over: importOverOf({ ...mb, importOver: stripOver }), reread,
    });
    const over = firstRunImportOver(stripOver, queueSettling);
    const row = { id: id("mb-1"), address: "me@example.invalid", ...mb, ...(over === undefined ? {} : { importOver: over }) } as FirstRunRow;
    const sender: FirstRunSender | null = w.clientQueue > 0 ? {
      name: "Sender", address: "sender@example.test", held: 2, waiting: w.clientQueue, many: false, since: "today",
      decide: (dest) => { log.decisions.push(dest); },
    } : null;
    return {
      ...ground,
      rows: [row],
      about: () => ({
        queuedSenders: w.clientQueue,
        pull: { screened: 0, history: 0, pulled: 0, whole: false },
        sender,
        queueSettling,
        rereadQueue: reread,
      }),
    };
  };
  const st = await mountStage({
    rows: [],
    door: "cloud",
    service: "managed",
    fill,
    verbs: {
      /* The host's AI answer, read live: the answer's write moves it, as the host's next read does. */
      get ai() { return ai; },
      probe: async () => ({ host: "h", user: "u", folders: 1 }),
      connect: async () => ({ id: "mb-1" }),
      organize: async () => {
        world.set({ ...world.read(), mb: { ...world.read().mb, organizeConsentedAt: AGREED, takeoverAuthorizedAt: AGREED } });
        return "stored";
      },
      countDecision: async () => ({
        letters: 5, senders: start.senders ?? 2, total: 5, complete: true, mirrored: true,
      }),
      complete: async () => { log.completes++; },
      setAiEnabled: async (on: boolean) => { ai = on ? "on" : "off"; world.set({ ...world.read() }); },
      probeReason: () => null,
      probeMessage: () => null,
    } as never,
  });
  const el = st.el;
  await flush();
  const lines = said(el, "main [role=status]");
  const heads = said(el, "h1");
  const etas = lines.all;
  const headings = heads.distinct;

  const heading = st.heading;
  const eta = () => (el.querySelector("h1")?.closest("main")?.querySelector("[role=status]")?.textContent ?? "").trim();
  const press = async (label: string) => {
    const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
    if (!button) throw new Error(`no button labelled ${JSON.stringify(label)} on ${JSON.stringify(heading())}`);
    await act(async () => { button.click(); for (let i = 0; i < 20; i++) await Promise.resolve(); });
    await flush();
  };
  /** The AI question's two answers by their names: no is the stage's "no", yes is the other. */
  const choose = async (value: "yes" | "no") => {
    const radios = [...el.querySelectorAll<HTMLElement>("[role=radio]")];
    const no = (r: HTMLElement) => (r.querySelector(".oh-radioline-word")?.textContent ?? "").trim() === t.aiNo;
    const radio = radios.find((r) => (value === "no" ? no(r) : !no(r)));
    if (!radio) throw new Error(`no ${value} option on screen`);
    await act(async () => { radio.click(); });
  };
  /** A decision verb, by its key, as a browser delivers it: at the element that has the keys. */
  const key = async (k: string) => {
    await act(async () => { ((document.activeElement as HTMLElement | null) ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  };
  /** A later GET /mailboxes read. */
  const pollRow = async (over: Partial<OnboardingMailbox>) => {
    await act(async () => { world.set({ ...world.read(), mb: { ...world.read().mb, ...over } }); });
    await flush();
  };
  const advance = async (ms: number) => {
    await act(async () => { vi.advanceTimersByTime(ms); });
    await flush();
  };
  /** The worker's agree sweep commits its Screener intents in the store. */
  const sweepLands = (senders: number) => { world.read().storeQueue = senders; };
  /** The engine's own re-ask after a sync page that touched the gate. */
  const engineReasks = async () => {
    await act(async () => { world.set({ ...world.read(), clientQueue: world.read().storeQueue }); });
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
