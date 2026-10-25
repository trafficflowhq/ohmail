/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore, mutationEffects,
  type EngineMessage, type EngineMutation, type Folder, type MirrorStore, type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { screenerIntentsKey } from "../app/shell/screener-intents";
import { createIntentWindows, intentWindowsChannel } from "../app/shell/intent-windows";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * ═══ ONE TAB OWNS AN OPEN UNDO WINDOW ══════════════════════════════════════════════════════
 *
 * ## THE MEASURED SEQUENCE (jsdom, two mounts over one `localStorage`)
 *
 *   1. tab A presses `n` on a stranger. The intent is journalled, the toast offers Undo, and
 *      nothing is on the wire — the whole point of the window;
 *   2. tab B opens inside those seconds. Its boot read finds the journal entry, its own `pending`
 *      map is empty, so it commits: `screener_decide` on the wire, the mail filed, the sender
 *      unsubscribed;
 *   3. tab A presses Undo and is told *"Undone — 1 waiting again."* — success reported over an act
 *      that has already happened, on the one screen a person visits to be sure about their mail.
 *
 * ## WHY AN ASK AND NOT A BROADCAST
 *
 * A claim posted at the press cannot reach a tab that was not open yet, which is precisely tab B.
 * So a booting tab asks and waits; ownership expires with the window's own length, so a tab that
 * died mid-window withholds nothing for longer than the window could have lasted.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-10T12:00:00.000Z");
let seq = 0;
let sent: EngineMutation[] = [];

function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-08-10T09:00:00.000Z", folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-10T09:00:00.000Z",
  };
}
const HELD = msg("h1", "news@bulk.example", "ohmail/Screener");

async function freshStore(): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{
    type: "message", op: "create", id: HELD.id, seq: ++seq, updatedAt: HELD.updatedAt, entity: HELD,
  }]);
  return store;
}

function engineOver(store: MirrorStore): OhmailEngine {
  return new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        sent.push(m);
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
            updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
          }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: "b", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

interface StateLike {
  waiting: Array<{ id: string; from: { address: string } }>;
  decide: (sender: unknown, dest: string, opts: { read: boolean; scope: string }) => void;
  markAllSpam: (scopeOf: () => string) => void;
  spamAllCount: number;
  flush: () => void;
}

interface Tab {
  get: () => StateLike;
  said: string[];
  undo: () => Promise<void>;
  settle: () => Promise<void>;
  microtasks: () => Promise<void>;
}

const roots: Root[] = [];

/** A TAB: its own mount, its own toast log, its own Undo button. */
async function mountTab(engine: OhmailEngine): Promise<Tab> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const said: string[] = [];
  const undos: Array<() => void> = [];
  let latest: StateLike | null = null;
  let force: (() => void) | null = null;
  function Probe(): null {
    const [v, setV] = React.useState(0);
    force = () => setV((x) => x + 1);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    latest = useScreenerState(engine, v, ((m: string, opts?: { onAction?: () => void }) => {
      said.push(m);
      if (opts?.onAction) undos.push(opts.onAction);
    }) as never) as unknown as StateLike;
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "UTC", now: NOW, children: h(Probe),
    }));
  });
  return {
    get: () => latest!,
    said,
    undo: async () => { await act(async () => { undos[undos.length - 1]?.(); }); },
    /* THE HANDSHAKE'S OWN WAIT, plus a render. `ask()` settles on a timer, so a mount that has
       not been given the clock has not finished booting. */
    settle: async () => {
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      await act(async () => { force?.(); });
      await act(async () => { await Promise.resolve(); });
    },
    /**
     * EVERY MICROTASK AND NOT ONE TICK OF THE CLOCK — the ordering the wait exists for.
     *
     * A `BroadcastChannel` message is delivered as a TASK; a promise that resolves without a timer
     * resolves as a MICROTASK, which is sooner. So a replay armed by an `ask()` that does not wait
     * runs before any tab has answered, and this is the only shape that can see it: advancing the
     * clock in one lump flushes the answer first and hides the difference.
     */
    microtasks: async () => {
      await act(async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
    },
  };
  await settleFirstPaint();
}

const decides = (): EngineMutation[] => sent.filter((m) => m.kind === "screener_decide");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  seq = 0;
  sent = [];
  window.localStorage.clear();
});
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  vi.useRealTimers();
});

describe("the Screener's undo window belongs to one tab", () => {
  it("a second tab does not commit a window the first tab still holds", async () => {
    const store = await freshStore();
    const tabA = await mountTab(engineOver(store));
    await tabA.settle();
    expect(tabA.get().waiting).toHaveLength(1);

    await act(async () => {
      tabA.get().decide(tabA.get().waiting[0], "screened", { read: false, scope: "sender" });
    });
    expect(decides(), "nothing may reach the wire inside the window").toHaveLength(0);
    expect(window.localStorage.getItem(screenerIntentsKey())).toContain("h1");

    // TAB B opens while that window is still counting down.
    const tabB = await mountTab(engineOver(store));
    await tabB.settle();

    expect(decides(), "the second tab committed a decision the first tab still held")
      .toHaveLength(0);
    expect(
      window.localStorage.getItem(screenerIntentsKey()),
      "the second tab consumed the first tab's journal entry",
    ).toContain("h1");
    /* AND IT IS NOT OFFERED THERE EITHER: the sender is being decided in another window, so
       offering the row here would put one sender in two presses. */
    expect(tabB.get().waiting.map((x) => x.id), "the row was offered in the second tab")
      .toEqual([]);

    // Tab A's Undo is still an undo: nothing has been sent, and it says so.
    await tabA.undo();
    expect(decides(), "the undo was reported over a decision that had been sent").toHaveLength(0);
    expect(tabA.said[tabA.said.length - 1]).toBe(en.screener.toastUndone.replace(
      "{count, plural, one {Undone — 1 waiting again.} other {Undone — # waiting again.}}",
      "Undone — 1 waiting again.",
    ));
    expect(window.localStorage.getItem(screenerIntentsKey()),
      "the undo left the decision armed on disk").toBeNull();
  });

  it("the row comes back to the second tab once the first tab takes it back", async () => {
    const store = await freshStore();
    const tabA = await mountTab(engineOver(store));
    await tabA.settle();
    await act(async () => {
      tabA.get().decide(tabA.get().waiting[0], "screened", { read: false, scope: "sender" });
    });
    const tabB = await mountTab(engineOver(store));
    await tabB.settle();
    expect(tabB.get().waiting.map((x) => x.id)).toEqual([]);

    await tabA.undo();
    await tabB.settle();
    expect(
      tabB.get().waiting.map((x) => x.id),
      "a released row never came back — the second tab would withhold the sender for good",
    ).toEqual(["h1"]);
    expect(decides(), "the release made the second tab replay a reversed decision")
      .toHaveLength(0);
  });

  it("the replay waits for the answers rather than racing them", async () => {
    /* THE WAIT ITSELF, and it needs its own arm: removing it left every other case in this file
       green, because advancing the clock in one lump delivers the answer before the timer fires.
       Here the clock never moves, so a replay that did not wait has nothing to have heard. */
    const store = await freshStore();
    const tabA = await mountTab(engineOver(store));
    await tabA.settle();
    await act(async () => {
      tabA.get().decide(tabA.get().waiting[0], "screened", { read: false, scope: "sender" });
    });

    const tabB = await mountTab(engineOver(store));
    await tabB.microtasks();
    expect(decides(), "the second tab replayed before any tab could answer").toHaveLength(0);

    await tabB.settle();
    expect(decides(), "and it must not replay once the answer is in either").toHaveLength(0);
  });

  it("a STRANDED intent is still replayed — nobody answers for a tab that is gone", async () => {
    /* The other direction, and the one that would be silently broken by a handshake that failed
       closed: an intent left by a killed tab has no owner, so the boot replay must take it. */
    const store = await freshStore();
    window.localStorage.setItem(screenerIntentsKey(), JSON.stringify([{
      v: 1, id: "h1", dest: "screened", read: false, scope: "sender", quiet: false,
      at: NOW.getTime() - 1000, derived: true, heldIds: ["h1"],
      from: { name: null, address: "news@bulk.example" },
    }]));
    const tab = await mountTab(engineOver(store));
    await tab.settle();
    expect(decides(), "a stranded decision was not replayed").toHaveLength(1);
    expect(window.localStorage.getItem(screenerIntentsKey())).toBeNull();
  });
});

describe("Mark all spam in a second tab", () => {
  it("skips the sender another tab holds, and moves the number it states", async () => {
    const store = await freshStore();
    const other = msg("h2", "promo@else.example", "ohmail/Screener");
    await store.applyChanges([{ type: "message", op: "create", id: other.id, seq: ++seq, updatedAt: other.updatedAt, entity: other }]);
    // Both tabs open first, so B learns of A's window by its claim and not from the journal at boot.
    const tabA = await mountTab(engineOver(store));
    await tabA.settle();
    const tabB = await mountTab(engineOver(store));
    await tabB.settle();
    const held = tabA.get().waiting.find((x) => x.id === "h1");
    await act(async () => { tabA.get().decide(held, "screened", { read: false, scope: "sender" }); });
    await tabB.settle();
    expect(tabB.get().waiting.map((x) => x.id), "premise: B withholds the row A holds").toEqual(["h2"]);
    const stated = tabB.get().spamAllCount;
    await act(async () => { tabB.get().markAllSpam(() => "sender"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { tabB.get().flush(); });
    await act(async () => { await Promise.resolve(); });

    expect(decides().map((m) => (m as { senderId: string }).senderId)).toEqual(["h2"]);
    expect(stated).toBe(1);
  });
});

describe("the coordinator itself", () => {
  /* A `BroadcastChannel` message is delivered as a TASK, not a microtask, so under this file's
     fake clock it arrives only when the clock is turned. Measured: `await Promise.resolve()` sees
     nothing at all. */
  const delivered = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(1); };

  it("answers only for windows that are still inside their own length", async () => {
    const a = createIntentWindows({ askMs: 1, channel: "unit-1" });
    const b = createIntentWindows({ askMs: 1, channel: "unit-1" });
    try {
      a.claim([{ id: "old", at: 1_000 }, { id: "fresh", at: 9_000 }]);
      await delivered();
      expect([...b.elsewhere(10_000, 5_000)]).toEqual(["fresh"]);
    } finally {
      a.close(); b.close();
    }
  });

  /**
   * `ask()` DOES NOT SETTLE UNTIL THE ANSWERS HAVE HAD THEIR MOMENT — the property the replay
   * gate rests on, asserted from both sides of the wait.
   *
   * A tab that opened after the claim has heard nothing, which is the whole reason there is an ask
   * at all; and a caller that treated `ask()` as instant would read that same emptiness and
   * replay. Removing the wait leaves the second assertion below red.
   */
  it("answers an ASK from a tab that opened after the claim, and only by then", async () => {
    const a = createIntentWindows({ askMs: 1, channel: "unit-3" });
    a.serve(() => [{ id: "held", at: 1_000 }]);
    a.claim([{ id: "held", at: 1_000 }]);
    await delivered();
    /* The tab that missed the claim: a `BroadcastChannel` reaches only the channels open when the
       message was posted, and this one did not exist. */
    const late = createIntentWindows({ askMs: 150, channel: "unit-3" });
    try {
      const settled = late.ask();
      expect([...late.elsewhere(1_000, 5_000)], "an answer arrived before it could have")
        .toEqual([]);
      await vi.advanceTimersByTimeAsync(400);
      await settled;
      expect([...late.elsewhere(1_000, 5_000)], "the ask settled before the answer was in")
        .toEqual(["held"]);
    } finally {
      a.close(); late.close();
    }
  });

  it("two accounts on one browser do not trade claims", async () => {
    /* A `BroadcastChannel` is per ORIGIN, like the jar this guards — and the jar is owner-keyed
       precisely so one account's pending decision is never offered to the next. The channel takes
       the same partition, or a row id would be withheld across a sign-out. */
    const { setStorageOwner, resetStorageOwnerForTest } =
      await import("../app/shell/storage-owner.js");
    try {
      setStorageOwner("acct-a");
      const a = createIntentWindows({ askMs: 1 });
      a.serve(() => [{ id: "shared-id", at: 1_000 }]);
      a.claim([{ id: "shared-id", at: 1_000 }]);
      setStorageOwner("acct-b");
      const b = createIntentWindows({ askMs: 1 });
      try {
        const settled = b.ask();
        await vi.advanceTimersByTimeAsync(400);
        await settled;
        expect([...b.elsewhere(1_000, 5_000)], "the other account's claim was heard").toEqual([]);
        expect(intentWindowsChannel("acct-a")).not.toBe(intentWindowsChannel("acct-b"));
      } finally {
        a.close(); b.close();
      }
    } finally {
      resetStorageOwnerForTest();
    }
  });

  it("a released id is remembered as resolved, not merely as closed", async () => {
    const a = createIntentWindows({ askMs: 1, channel: "unit-2" });
    const b = createIntentWindows({ askMs: 1, channel: "unit-2" });
    try {
      a.claim([{ id: "x", at: 1_000 }]);
      await delivered();
      expect([...b.elsewhere(1_000, 5_000)]).toEqual(["x"]);
      a.release(["x"]);
      await delivered();
      expect([...b.elsewhere(1_000, 5_000)]).toEqual([]);
      expect([...b.resolved()]).toEqual(["x"]);
    } finally {
      a.close(); b.close();
    }
  });
});
