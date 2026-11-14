/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { ScreenerView } from "../app/views/ScreenerView";
import { KeymapProvider } from "../app/shell/keymap";
import { LOADING_GRACE_MS } from "@ohmail/app-logic/session/loading-grace";
import type { ScreenerRole } from "@ohmail/app-logic/mail-state/mail-state";
import type { ScreenerState } from "../app/shell/screener-state";

/**
 * THE WAITING TAB SPEAKS FROM THE STORE'S FACTS WHILE THIS DEVICE IMPORTS.
 *
 * Seen on the desktop during a first sync (2026-10-01): Waiting stood on "Loading your mail." with
 * no rows while Screened out and Spam already showed counts. The queue is the store's own answer,
 * so this mirror's import cannot change it; only the account's own open import, or a store that
 * counts senders the list cannot show yet, withholds it. A withheld list says why after the grace.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out; the reading pane scrolls its held mail to the top on mount.
Element.prototype.scrollTo ??= function scrollTo() {};

const NOW = new Date("2026-10-01T09:00:00.000Z");
const ORGANIZES: ScreenerRole = { mode: "organizer", name: null, reason: null, oauthOnly: false };
const NOBODY = en.screener.empty.waiting.title;

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

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(f: Facts): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider, {
        children: h(ScreenerView, {
          state: viewState(f), segment: "waiting", selection: { waiting: null, screened: null, spam: null },
          settled: f.settled, owed: f.owed,
          ...(f.storeImportOpen === undefined ? {} : { storeImportOpen: f.storeImportOpen }),
          onSelect: () => {}, hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
        } as never),
      }),
    }));
  });
  await settleFirstPaint();
  return host;
}

/** Past the loading grace: what a person reads once the pane has spoken. */
async function pastTheGrace(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(LOADING_GRACE_MS + 50); });
}

const busy = (el: HTMLElement) => el.querySelector('[aria-busy="true"]') !== null;
const text = (el: HTMLElement) => el.textContent ?? "";
const badges = (el: HTMLElement) => [...el.querySelectorAll(".scnt")].map((b) => b.textContent ?? "");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
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
    expect(text(el)).toContain(en.screener.emptyListing);
    expect(text(el), "an import was claimed with the account's import closed").not.toContain(en.screener.emptyImporting);
  });

  it("ARM 5b: the same while this device imports", async () => {
    const el = await mount({ source: "store", count: 3, settled: true, owed: true, storeImportOpen: false });
    await pastTheGrace();
    expect(text(el)).not.toContain(NOBODY);
    expect(busy(el)).toBe(true);
    expect(text(el)).toContain(en.screener.emptyListing);
  });

  it("ARM 6: the account's own import is open: withheld, with the importing sentence", async () => {
    const el = await mount({ source: "store", count: 0, settled: true, owed: false, storeImportOpen: true });
    await pastTheGrace();
    expect(text(el)).not.toContain(NOBODY);
    expect(busy(el)).toBe(true);
    expect(text(el)).toContain(en.screener.emptyImporting);
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
    expect(text(el)).toContain(en.screener.loading);
    expect(text(el)).not.toContain(en.screener.emptyImporting);
  });
});

describe("a withheld list says why", () => {
  it("ARM 4: past the grace the pending list carries the importing sentence, not 'Loading your mail.'", async () => {
    const el = await mount({ source: "device", count: 0, settled: true, owed: true });
    expect(text(el), "the sentence spoke inside the grace").not.toContain(en.screener.emptyImporting);
    await pastTheGrace();
    expect(text(el)).toContain(en.screener.emptyImporting);
    expect(text(el)).not.toContain(en.screener.loading);
  });
});

describe("the tab counts are mailbox numbers, withheld mid-import", () => {
  it("Screened out and Spam state no partial count while mail is owed, and state it once settled", async () => {
    const owed = await mount({ source: "store", count: 0, settled: true, owed: true, storeImportOpen: false, screenedOut: 35, spam: 212 });
    expect(badges(owed), "a partial count was stated as the mailbox's").toEqual(["", "", ""]);
    await act(async () => { root?.unmount(); });
    host?.remove();
    const done = await mount({ source: "store", count: 0, settled: true, owed: false, storeImportOpen: false, screenedOut: 35, spam: 212 });
    expect(badges(done)).toEqual(["", "35", "212"]);
  });
});
