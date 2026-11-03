/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  consentPartition,
  ohboxView,
  presentationReader,
  type EngineAdapter,
  type EngineMessage,
  type Folder,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { withNodeBlobs } from "./fixtures/node-blobs";
import {
  NOW as WORLD_NOW, SENDERS, removedMailboxWorld,
} from "../../../packages/services/test/helpers/removed-mailbox-world.js";
import { ScreenerView } from "../app/views/ScreenerView";
import { KeymapProvider } from "../app/shell/keymap";
import { LOADING_GRACE_MS } from "../app/shell/loading-grace";
import type { ScreenerRole } from "../app/shell/mail-state";
import type { ScreenerState } from "../app/shell/screener-state";

/**
 * THE SCREENED OUT AND SPAM COUNTS WAIT FOR THE COPY. They count this mirror's rows, and on the
 * desktop's Cloud mirror the strip's import ends before the copy's: on the rig the count appeared
 * 55 s after the press while the copy was still taking the account in until 200 s, and an account
 * with older screened-out mail read a partial number as its total (two pile counts, both short,
 * 2026-10-01). While the door says its copy is behind (`copyBehind`), the counts are withheld.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};

const NOW = new Date("2026-10-01T09:00:00.000Z");
const ISO = NOW.toISOString();
const ORGANIZES: ScreenerRole = { mode: "organizer", name: null, reason: null, oauthOnly: false };
const SCREENED: Folder = "ohmail/Screened";
const NOBODY_SCREENED = en.screener.empty.screened.title;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const badges = (el: HTMLElement) => [...el.querySelectorAll(".scnt")].map((b) => b.textContent ?? "");
const text = (el: HTMLElement) => el.textContent ?? "";

type ViewProps = { segment?: "waiting" | "screened"; owed: boolean; storeImportOpen: boolean };

function view(state: ScreenerState, p: ViewProps) {
  return h(KeymapProvider, {
    children: h(ScreenerView, {
      state, segment: p.segment ?? "waiting", selection: { waiting: null, screened: null, spam: null },
      settled: true, owed: p.owed, storeImportOpen: p.storeImportOpen,
      onSelect: () => {}, hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never),
  });
}

const provided = (child: React.ReactElement) =>
  h(NextIntlClientProvider, { locale: "en", messages: en as never, timeZone: "UTC", now: NOW, children: child });

const shell = (state: ScreenerState, p: ViewProps) => provided(view(state, p));

async function render(node: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  await settleFirstPaint();
  return host;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

// ── The view, over a stated ScreenerState ────────────────────────────────────────────────────

const sender = (id: string) => ({
  id, from: { name: null, address: `${id}@example.test` }, initial: id[0]!.toUpperCase(), derived: true,
  scope: "sender" as const, ai: null,
  held: [{
    id: `${id}-h`, subject: "s", time: "09:00", body: "b", html: null, bodyState: "ready" as const,
    unsubscribe: "no_header" as const, unsubscribeUrl: null, trackerNote: null,
  }],
});

function viewState(f: { copyBehind?: boolean; screenedOut: number; spam: number }): ScreenerState {
  return {
    waiting: [], waitingCount: 0, waitingSource: "store", queueAnswered: true,
    ...(f.copyBehind === undefined ? {} : { copyBehind: f.copyBehind }),
    suggestedCount: 0, suggestedDests: [],
    waitingMore: { available: false, loading: false, failed: false, load: () => {} }, rereadWaiting: () => {},
    unsuggestedSenders: [], suggestedSenders: [], applying: null,
    screenedOut: Array.from({ length: f.screenedOut }, (_, i) => sender(`so${i}`)),
    spam: Array.from({ length: f.spam }, (_, i) => sender(`sp${i}`)),
    isExiting: () => false, refused: () => false, bodyStall: () => null,
    decide: () => {}, applyAll: () => {}, markAllSpam: () => {}, allowScreened: () => {},
    notSpamToWaiting: () => {}, notSpamToOhbox: () => {}, deleteSpam: () => {}, flush: () => {},
    role: ORGANIZES, pending: [], decided: [], notApplied: [],
  } as unknown as ScreenerState;
}

describe("the counts while the door's copy is behind", () => {
  it("the strip has stopped owing mail, the copy is still taking the account in: no count is stated", async () => {
    const el = await render(shell(viewState({ copyBehind: true, screenedOut: 35, spam: 212 }), { owed: false, storeImportOpen: true }));
    expect(badges(el), "a partial count was stated as the account's").toEqual(["", "", ""]);
  });

  it("an empty Screened out list over that copy is withheld with the importing sentence, never 'nobody'", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const el = await render(shell(viewState({ copyBehind: true, screenedOut: 0, spam: 0 }), { segment: "screened", owed: false, storeImportOpen: true }));
    await act(async () => { vi.advanceTimersByTime(LOADING_GRACE_MS + 50); });
    expect(text(el)).not.toContain(NOBODY_SCREENED);
    expect(text(el)).toContain(en.screener.emptyImporting);
  });
});

describe("a door that never says its copy is behind (controls)", () => {
  it("the direct door, import floor open and nothing owed: the counts read as before", async () => {
    const el = await render(shell(viewState({ screenedOut: 35, spam: 212 }), { owed: false, storeImportOpen: true }));
    expect(badges(el)).toEqual(["", "35", "212"]);
  });

  it("the direct door, mail owed: withheld as before", async () => {
    const el = await render(shell(viewState({ copyBehind: false, screenedOut: 35, spam: 212 }), { owed: true, storeImportOpen: true }));
    expect(badges(el)).toEqual(["", "", ""]);
  });

  it("the copy has caught up: the counts are stated", async () => {
    const el = await render(shell(viewState({ copyBehind: false, screenedOut: 35, spam: 212 }), { owed: false, storeImportOpen: false }));
    expect(badges(el)).toEqual(["", "35", "212"]);
  });
});

// ── The real engine, over an account with older screened-out mail and a fresh import ─────────

function screenedMsg(id: string, address: string, date: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address }, to: [], cc: [],
    date, folder: SCREENED, snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  };
}

/** Two fresh screen-outs in the copy's first page; three older ones the copy takes in later. */
const FRESH = [1, 2].map((n) => screenedMsg(`f${n}`, `fresh${n}@example.test`, `2026-10-01T0${n}:00:00.000Z`));
const OLDER = [1, 2, 3].map((n) => screenedMsg(`o${n}`, `older${n}@example.test`, `2026-08-0${n}${"T"}08:00:00.000Z`));

async function door(o: { behind: boolean }) {
  let behind = o.behind;
  let seq = 0;
  const pages: EngineMessage[][] = [FRESH];
  const change = (m: EngineMessage): SyncChange =>
    ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: ISO, entity: m }) as SyncChange;
  const sync = async (): Promise<SyncResponse> => ({
    changes: { creates: (pages.shift() ?? []).map(change), updates: [], moves: [], deletes: [] },
    cursor: `c${seq}`, hasMore: false, serverTime: ISO,
  });
  const adapter = {
    sync,
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    screenerWaiting: async () => ({
      items: [], nextCursor: null, total: 0, inFlight: [], ...(behind ? { copyBehind: true as const } : {}),
    }),
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  await engine.start();
  await engine.syncOnce();
  return {
    engine,
    /** The copy takes in the older mail and stops saying it is behind. */
    catchUp: () => { pages.push(OLDER); behind = false; },
  };
}

async function mountLive(engine: OhmailEngine, p: { owed: boolean; storeImportOpen: boolean }) {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  function Live(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, v, (() => {}) as never);
    return view(state, p);
  }
  return render(provided(h(Live)));
}

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("an account with older screened-out mail and a fresh import, on the real engine", () => {
  it("the copy's two are never stated as the account's five; the five once the copy holds them", async () => {
    const d = await door({ behind: true });
    const el = await mountLive(d.engine, { owed: false, storeImportOpen: true });
    await d.engine.refreshScreenerWaiting();
    await flush();
    expect(badges(el)[1], "the copy's partial count was stated as the account's").toBe("");
    d.catchUp();
    await d.engine.syncOnce(); await flush();
    await d.engine.refreshScreenerWaiting(); await flush();
    await d.engine.syncOnce(); await flush();
    await d.engine.refreshScreenerWaiting(); await flush();
    expect(badges(el)[1]).toBe("5");
  });

  it("the direct door states the count it holds, as before (control)", async () => {
    const d = await door({ behind: false });
    const el = await mountLive(d.engine, { owed: false, storeImportOpen: false });
    await d.engine.refreshScreenerWaiting();
    await flush();
    expect(badges(el)[1]).toBe("2");
  });
});

// ── A mailbox removed with its copy kept, on the real engine over the real route ─────────────

async function mountPresented(engine: OhmailEngine, own: string) {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  function Live(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const presented = React.useMemo(
      () => presentationReader(engine.read(), consentPartition(engine.read(), { now: WORLD_NOW, ownAddresses: [own] })), [v],
    );
    const state = useScreenerState(engine, v, (() => {}) as never, undefined, presented);
    return view(state, { owed: false, storeImportOpen: false });
  }
  return render(provided(h(Live)));
}

describe("a mailbox removed with its copy kept asks nothing (helpers/removed-mailbox-world.ts)", () => {
  it("the Screener counts and lists the live mailbox's strangers only", async () => {
    const w = await withNodeBlobs(() => removedMailboxWorld("removed"));
    const engine = await w.engine();
    const el = await mountPresented(engine, w.own);
    await flush();
    expect(badges(el)[0], "the waiting count").toBe("2");
    const shown = text(el);
    for (const who of [SENDERS.B, SENDERS.I]) expect(shown, who).toContain(who);
    for (const who of [SENDERS.A, SENDERS.C, SENDERS.D, SENDERS.E]) expect(shown, `${who} waits`).not.toContain(who);
  });

  it("a removal between the stored page and the Screener's own walk past it: the Ohbox shows none of the removed mailbox's strangers", async () => {
    const w = await withNodeBlobs(() => removedMailboxWorld("stood-down"));
    const engine = await w.engine({ pageLimit: 2 });
    const el = await mountPresented(engine, w.own);
    await flush();
    await w.removeSecond();
    const more = [...el.querySelectorAll("button")].find((b) => b.textContent === en.screener.waitingMoreAction);
    await act(async () => { more!.click(); });
    for (let i = 0; i < 5; i++) await flush();
    const box = ohboxView(presentationReader(engine.read(), consentPartition(engine.read(), { now: WORLD_NOW, ownAddresses: [w.own] })));
    const inBox = [...box.resurfaced, ...box.newForYou, ...box.previouslySeen].map((m) => m.id);
    for (const name of ["A.held", "C.held", "C.inbox"]) expect(inBox, name).not.toContain(w.idOf(name));
  });
});
