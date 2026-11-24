/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { cleanup, within } from "@testing-library/react";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { BESIDE, mountPlace } from "../../../packages/app/test/screener/screener-world";
import { LOADING_GRACE_MS } from "@ohmail/app-logic/session/loading-grace";
import type { ScreenerRole } from "@ohmail/app-logic/mail-state/mail-state";
import type { ScreenerState } from "@ohmail/app-logic/screener/screener-state";

/**
 * THE WAITING TAB SPEAKS FROM THE STORE'S FACTS WHILE THIS DEVICE IMPORTS.
 *
 * Seen on the desktop during a first sync (2026-10-01): Waiting stood on "Loading your mail." with
 * no rows while Screened out and Spam already showed counts. The queue is the store's own answer,
 * so this mirror's import cannot change it; only the account's own open import, or a store that
 * counts senders the list cannot show yet, withholds it. A withheld list says why after the grace.
 */

(globalThis as unknown as { React: unknown }).React = React;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out; the reading pane scrolls its held mail to the top on mount.
Element.prototype.scrollTo ??= function scrollTo() {};

const NOW = new Date("2026-10-01T09:00:00.000Z");
const ORGANIZES: ScreenerRole = { mode: "organizer", name: null, reason: null, oauthOnly: false };
const NOBODY = en.screener.place.empty.waiting;

const sender = (id: string) => ({
  id, from: { name: null, address: `${id}@example.test` }, initial: id[0]!.toUpperCase(), derived: true,
  scope: "sender" as const, ai: null,
  held: [{
    id: `${id}-h`, subject: "s", time: "09:00", body: "b", html: null, bodyState: "ready" as const,
    unsubscribe: "no_header" as const, unsubscribeUrl: null, trackerNote: null,
  }],
});

interface Facts {
  source: "store" | "device";
  count: number;
  queueAnswered?: boolean;
  settled: boolean;
  owed: boolean;
  storeImportOpen?: boolean;
  screenedOut?: number;
  spam?: number;
}

function viewState(f: Facts): ScreenerState {
  return {
    queueSettled: f.settled || (f.queueAnswered ?? f.source === "store"),
    storeSettled: f.settled,
    waiting: [], waitingCount: f.count, waitingSource: f.source, queueAnswered: f.queueAnswered ?? f.source === "store",
    suggestedCount: 0, suggestedDests: [],
    waitingMore: { available: false, loading: false, failed: false, load: () => {} }, rereadWaiting: () => {},
    unsuggestedSenders: [], suggestedSenders: [], applying: null,
    screenedOut: Array.from({ length: f.screenedOut ?? 0 }, (_, i) => sender(`so${i}`)),
    spam: Array.from({ length: f.spam ?? 0 }, (_, i) => sender(`sp${i}`)),
    isExiting: () => false, refused: () => false, bodyStall: () => null,
    decide: () => {}, applyAll: () => {}, markAllSpam: () => {}, allowScreened: () => {},
    notSpamToWaiting: () => {}, notSpamToOhbox: () => {}, deleteSpam: () => {}, flush: () => {},
    role: ORGANIZES, pending: [], decided: [], notApplied: [],
  } as unknown as ScreenerState;
}

async function mount(f: Facts): Promise<HTMLElement> {
  const { view } = mountPlace(viewState(f), {
    beside: { ...BESIDE, facts: {
      ...BESIDE.facts, settled: f.settled, owed: f.owed,
      ...(f.storeImportOpen === undefined ? {} : { storeImportOpen: f.storeImportOpen }),
    } },
  });
  await settleFirstPaint();
  return view.container;
}

/** Past the loading grace: what a person reads once the pane has spoken. */
async function pastTheGrace(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(LOADING_GRACE_MS + 50); });
}

const busy = (el: HTMLElement) => el.querySelector('[aria-busy="true"]') !== null;
const text = (el: HTMLElement) => el.textContent ?? "";
const badges = (el: HTMLElement) => {
  const sections = within(el).getByRole("group", { name: en.screener.segAria });
  return [en.screener.segWaiting, en.screener.segScreened, en.screener.segSpam].map((label) => {
    const button = within(sections).getByRole("button", { name: new RegExp(`^${label}(?: [0-9]+)?$`) });
    return button.getAttribute("aria-label")?.slice(label.length).trim() ?? "";
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("a store-sourced empty queue during this device's import", () => {
  it("ARM 1: the store answered zero, the account's import is closed: it says nobody is waiting", async () => {
    const el = await mount({ source: "store", count: 0, settled: true, owed: true, storeImportOpen: false });
    await pastTheGrace();
    expect(text(el)).toContain(NOBODY);
    expect(busy(el), "the list is still withheld").toBe(false);
  });

  it("ARM 1b: the same before this window's first drain completed", async () => {
    const el = await mount({ source: "store", count: 0, settled: false, owed: true, storeImportOpen: false });
    await pastTheGrace();
    expect(text(el)).toContain(NOBODY);
    expect(busy(el)).toBe(false);
  });

  it("ARM 5: the store counts senders the list has no rows for: never stated empty, and not called an import", async () => {
    const el = await mount({ source: "store", count: 3, settled: true, owed: false, storeImportOpen: false });
    await pastTheGrace();
    expect(text(el)).not.toContain(NOBODY);
    expect(busy(el)).toBe(true);
    expect(text(el)).toContain(en.screener.emptyListingTitle);
    expect(text(el)).toContain(en.screener.emptyListing);
    expect(text(el), "an import was claimed with the account's import closed").not.toContain(en.screener.emptyImportingTitle);
    expect(text(el), "an import was claimed with the account's import closed").not.toContain(en.screener.emptyImportingLine);
  });

  it("ARM 5b: the same while this device imports", async () => {
    const el = await mount({ source: "store", count: 3, settled: true, owed: true, storeImportOpen: false });
    await pastTheGrace();
    expect(text(el)).not.toContain(NOBODY);
    expect(busy(el)).toBe(true);
    expect(text(el)).toContain(en.screener.emptyListingTitle);
    expect(text(el)).toContain(en.screener.emptyListing);
  });

  it("ARM 6: the account's own import is open: withheld, with the importing sentence", async () => {
    const el = await mount({ source: "store", count: 0, settled: true, owed: false, storeImportOpen: true });
    await pastTheGrace();
    expect(text(el)).not.toContain(NOBODY);
    expect(busy(el)).toBe(true);
    expect(text(el)).toContain(en.screener.emptyImportingTitle);
    expect(text(el)).toContain(en.screener.emptyImportingLine);
  });
});

describe("the readings the store's facts do not change (controls)", () => {
  it("ARM 2: a device-derived empty queue mid-import stays withheld", async () => {
    const el = await mount({ source: "device", count: 0, settled: true, owed: true });
    await pastTheGrace();
    expect(text(el)).not.toContain(NOBODY);
    expect(busy(el)).toBe(true);
  });

  it("ARM 3: a store-sourced empty queue with nothing owed says nobody is waiting", async () => {
    const el = await mount({ source: "store", count: 0, settled: true, owed: false, storeImportOpen: false });
    expect(text(el)).toContain(NOBODY);
  });

  it("a store whose page is not in the mirror yet reads as every other list", async () => {
    const el = await mount({ source: "store", count: 0, queueAnswered: false, settled: true, owed: true, storeImportOpen: false });
    await pastTheGrace();
    expect(text(el)).not.toContain(NOBODY);
  });

  it("a list no drain has populated is still loading, never importing", async () => {
    const el = await mount({ source: "device", count: 0, settled: false, owed: true });
    await pastTheGrace();
    expect(text(el)).toContain(en.screener.place.loading);
    expect(text(el)).not.toContain(en.screener.emptyImportingTitle);
    expect(text(el)).not.toContain(en.screener.emptyImportingLine);
  });
});

describe("a withheld list says why", () => {
  it("ARM 4: past the grace the pending list carries the importing sentence, not 'Loading your mail.'", async () => {
    const el = await mount({ source: "device", count: 0, settled: true, owed: true });
    expect(text(el), "the sentence spoke inside the grace").not.toContain(en.screener.emptyImportingTitle);
    expect(text(el), "the sentence spoke inside the grace").not.toContain(en.screener.emptyImportingLine);
    await pastTheGrace();
    expect(text(el)).toContain(en.screener.emptyImportingTitle);
    expect(text(el)).toContain(en.screener.emptyImportingLine);
    expect(text(el)).not.toContain(en.screener.place.loading);
  });
});

describe("the tab counts are mailbox numbers, withheld mid-import", () => {
  it("Screened out and Spam state no partial count while mail is owed, and state it once settled", async () => {
    const owed = await mount({ source: "store", count: 0, settled: true, owed: true, storeImportOpen: false, screenedOut: 35, spam: 212 });
    expect(badges(owed), "a partial count was stated as the mailbox's").toEqual(["", "", ""]);
    cleanup();
    const done = await mount({ source: "store", count: 0, settled: true, owed: false, storeImportOpen: false, screenedOut: 35, spam: 212 });
    expect(badges(done)).toEqual(["", "35", "212"]);
  });
});
