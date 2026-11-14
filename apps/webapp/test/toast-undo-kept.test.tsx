/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore, mutationEffects,
  type EngineMessage, type EngineMutation, type Folder, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider, ToastHost, useToast } from "@ohmail/ui";
import messages from "../messages/en.json";
import { COMMIT_MS, UNDO_MS } from "../app/shell/screener-state";
import { createDeleteUndo } from "@ohmail/app-logic/press/delete-undo";

/**
 * THE DECISION'S UNDO OUTLIVES THE SUGGESTION SUMMARY — the tester's re-read on a fake server.
 * With automatic suggestions on, a sender arriving while the Screener is open starts the batch for
 * it; decided before the batch answered, the decision's "Ohbox — filed · Undo" was replaced 300 ms
 * later by the batch's summary, because the host drew one capsule. The real hooks, view and host
 * here, only the server faked: the row leaves, the summary shows beneath, the Undo holds its whole
 * window and works. And the window is the GUARD'S: a second decision replacing the first capsule
 * leaves the first decision's commit time where it was; a window closed early withdraws its Undo.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-09-23T12:00:00.000Z");
let seq = 0;
let sent: EngineMutation[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let answer: (() => void) | null = null;
let purchases = 0;

function msg(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-23T09:00:00.000Z", folder: "ohmail/Screener" as Folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-23T09:00:00.000Z",
  };
}

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

/** The server: the stored-suggestion read answers at once, the PURCHASE when the test says so. */
function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = (typeof input === "string" ? input : String(input)).replace(/^\/api/, "");
    if (path.startsWith("/screener/suggest")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { senders: string[]; dryRun?: boolean };
      if (body.dryRun) return json({ dryRun: true, requested: 0, quoted: 0, quotedCredits: 0, charged: 0, suggestions: [], skipped: [] });
      purchases++;
      const reply = json({
        dryRun: false, requested: body.senders.length, quoted: body.senders.length,
        quotedCredits: body.senders.length, charged: body.senders.length,
        suggestions: body.senders.map((s) => ({ sender: s, messageId: `m-${s}`, decision: "yes", confidence: 0.9, rationale: "r" })),
        skipped: [],
      });
      return new Promise<Response>((resolve) => { answer = () => resolve(reply); });
    }
    if (path.startsWith("/screener")) {
      return json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 50 } });
    }
    return json({});
  }) as typeof fetch;
}

async function engineWith(held: EngineMessage[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(held.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
  let pending: EngineMessage[] = [];
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const batch = pending;
        pending = [];
        return {
          changes: {
            creates: batch.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
            updates: [], moves: [], deletes: [],
          },
          cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m) => {
        sent.push(m);
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({ type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}) }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
  const deliver = async (m: EngineMessage[]) => {
    pending = m;
    await act(async () => { await engine.syncOnce(); });
    await flush();
  };
  return { engine, deliver };
}

interface Live { waitingCount: number; flush: () => void }
let live: Live | null = null;

async function mount(engine: OhmailEngine, autoSuggest: boolean): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  function Probe(): React.ReactElement {
    const toast = useToast();
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const suggestions = useScreenerSuggestions({ active: true, autoSuggest, toast });
    const state = useScreenerState(engine, v, toast, suggestions.suggestions);
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    live = state as unknown as Live;
    return h(ScreenerView, {
      owed: false, state, suggest: suggestions.forSenders(state.unsuggestedSenders),
      segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: h(KeymapProvider, { children: h(Probe) }) }) }),
    }));
  });
  await flush();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}
const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); await flush(); };
const press = async (k: string) => {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  await flush();
};
const undoCapsule = (): HTMLElement | null => document.querySelector(".toast-held");
const undoButton = (): HTMLButtonElement | null => document.querySelector(".toast-held .toast-act");
const notice = (): HTMLElement => document.querySelector<HTMLElement>(".toast:not(.toast-held)")!;
const decides = () => sent.filter((m) => m.kind === "screener_decide");
const FILED = "Ohbox — filed";
const SUMMARY = "1 suggestion · 1 credit used.";

beforeEach(() => {
  sent = [];
  answer = null;
  purchases = 0;
  localStorage.clear();
  installFetch();
});
afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  live = null;
});

/** the order: the sender arrives, the batch starts for it, the person decides before it answers. */
async function w6(): Promise<void> {
  const { engine, deliver } = await engineWith([]);
  await mount(engine, true);
  await deliver([msg("w6", "arrival@example.com")]);
  expect(purchases, "the premise: the automatic batch started for the arrival").toBe(1);
  expect(live!.waitingCount).toBe(1);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await press("o");
  await tick(200);
  answer!();
  await flush();
}

describe("on a fake server: the decision's Undo beside the suggestion summary", () => {
  it("(a)/(c) the row leaves, the summary shows beneath, and the Undo holds its whole window", async () => {
    await w6();
    await tick(400);
    expect(live!.waitingCount, "the row left").toBe(0);
    expect(notice().textContent, "the summary is on screen").toBe(SUMMARY);
    expect(undoCapsule()?.textContent).toContain(FILED);

    await tick(1400); // two seconds after the press
    expect(undoCapsule()?.className).toContain("on");
    expect(undoButton(), "the Undo is still offered").not.toBeNull();

    await tick(1000); // the summary's own 2600 ms since it arrived at 200
    expect(notice().className, "the summary left on its own timer").not.toContain("on");
    expect(undoCapsule()?.className, "and did not take the decision's capsule with it").toContain("on");

    await tick(UNDO_MS - 3001);
    expect(undoCapsule()?.className, "the full window, to the millisecond").toContain("on");
    expect(decides(), "nothing sent inside the window").toHaveLength(0);
    await tick(COMMIT_MS - UNDO_MS + 1);
    expect(decides(), "committed at the end of the window").toHaveLength(1);
    expect(undoButton(), "and its button is gone before that").toBeNull();
  });

  it("(a) Undo pressed two seconds in, beside the summary: the decision is not sent", async () => {
    await w6();
    await tick(1800);
    expect(notice().textContent).toBe(SUMMARY);
    await act(async () => { undoButton()!.click(); });
    await flush();
    expect(undoCapsule(), "Undo dismissed its own capsule").toBeNull();
    expect(notice().textContent).toMatch(/^Undone — 1 waiting again\.$/);
    expect(live!.waitingCount, "the sender is back").toBe(1);
    await tick(COMMIT_MS * 2);
    expect(decides(), "an undone decision is never sent").toHaveLength(0);
  });
});

/**
 * the order, measured on 0.23.1: screened out, Undo pressed 549 ms later, and the batch answering
 * at 1558 ms replaced "Undone" with its summary. The summary is a notice nobody pressed for, so it
 * waits for the Undo's own sentence to finish and then draws; it is never dropped.
 */
describe("on a fake server: the Undo's own sentence outlives the suggestion summary", () => {
  it("'Undone' holds its window with the batch answering inside it, and the summary follows", async () => {
    const { engine, deliver } = await engineWith([]);
    await mount(engine, true);
    await deliver([msg("w7", "arrival@example.com")]);
    expect(purchases, "the premise: the automatic batch started for the arrival").toBe(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await press("n");
    await tick(549);
    await act(async () => { undoButton()!.click(); });
    await flush();
    const UNDONE = /^Undone — 1 waiting again\.$/;
    expect(notice().textContent).toMatch(UNDONE);
    await tick(1558 - 549);
    answer!();
    await flush();
    await tick(2000 - 1558);
    expect(notice().className).toContain("on");
    expect(notice().textContent, "the confirmation is not replaced").toMatch(UNDONE);
    expect(document.body.textContent, "the summary waits").not.toContain(SUMMARY);

    await tick(549 + 2600 + 300 - 2000 + 1); // Undone's own window and the fade
    expect(notice().textContent, "then the summary is said, never dropped").toBe(SUMMARY);
    expect(notice().className).toContain("on");
    expect(live!.waitingCount, "the sender is back").toBe(1);
    await tick(COMMIT_MS * 2);
    expect(decides(), "an undone decision is never sent").toHaveLength(0);
  });
});

describe("the window is the guard's, not the capsule's", () => {
  it("a second decision replaces the first capsule and leaves the first decision's commit time as it was", async () => {
    const { engine } = await engineWith([msg("a", "a@example.com"), msg("b", "b@example.com")]);
    await mount(engine, false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const whose = (): string => (/\b([ab])@example\.com/.exec(undoCapsule()?.textContent ?? "")?.[1] ?? "none");
    await press("o"); // the first sender, at 0
    const first = whose();
    await tick(1000);
    await press("o"); // the second, at 1000 — the person acted again
    const second = whose();
    expect([first, second].sort(), "the second capsule replaced the first").toEqual(["a", "b"]);
    expect(document.querySelectorAll(".toast-act")).toHaveLength(1);
    const ids = () => decides().map((m) => (m as { senderId: string }).senderId);

    await tick(COMMIT_MS - 1000 - 1);
    expect(ids(), "the first not sent before its own window closed").toEqual([]);
    await tick(1);
    expect(ids(), "the first at COMMIT_MS from ITS press, its capsule long replaced").toEqual([first]);
    await tick(999);
    expect(ids()).toEqual([first]);
    await tick(1);
    expect(ids(), "the second at COMMIT_MS from its own").toEqual([first, second]);
  });
});

describe("an Undo whose window closed early is withdrawn, never left above its outcome", () => {
  it("leaving the Screener commits the pending decision and takes its capsule with it", async () => {
    const { engine } = await engineWith([msg("a", "a@example.com")]);
    await mount(engine, false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await press("o");
    expect(undoButton(), "the premise: the Undo is offered").not.toBeNull();
    await act(async () => { live!.flush(); });
    await flush();
    expect(decides(), "committed at once").toHaveLength(1);
    expect(undoCapsule(), "a dead Undo is not left on screen").toBeNull();
  });

  it("the delete window withdraws its Undo when it is flushed or undone from the keyboard", () => {
    const signals: AbortSignal[] = [];
    let n = 0;
    const queue = createDeleteUndo({
      mutate: async () => ({ status: "confirmed" }) as never,
      toast: (_m, o) => { if (o?.signal) signals.push(o.signal); },
      copy: {
        deleted: "Deleted.", undo: "Undo", undone: "Kept.", failed: "Refused.", noUndo: "No undo.",
      },
      onHeld: () => {},
      refusal: () => null,
      pressId: () => `press-${++n}`,
    });
    expect(queue.remove({ id: "m1", mailboxId: "mb1" })).toBe(true);
    expect(signals, "the premise: the press offered an Undo under a signal").toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    queue.flush();
    expect(signals[0]!.aborted, "flushed early: the capsule is withdrawn").toBe(true);
    queue.remove({ id: "m2", mailboxId: "mb1" });
    queue.undo("m2");
    expect(signals[1]!.aborted, "undone from the keyboard: the capsule's Undo is spent").toBe(true);
  });
});
