import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  bodyOf,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ── THE BODY FAN-OUT IS BOUNDED ──────────────────────────────────────────────────────────────
 *
 * `bodyRequests` deduplicates per message id, which is the wrong axis for the caller that hurts.
 * The Screener preview hydrates EVERY held message of the selected sender from one effect, and a
 * sender with forty held messages is forty distinct ids — no duplicates, nothing to deduplicate,
 * forty requests in one tick.
 *
 * That is the reported defect, seen from the other end: a body record that is not `ready` answers
 * `html: null`, and the viewer renders its plain-text fallback for a null html. So a burst large
 * enough to overrun the connection limit shows a preview of text dumps beside one or two properly
 * rendered frames, on exactly the senders — the ones with a conversation behind them — where the
 * reader most expects a mail client.
 *
 * Three things are asserted, and the third is the one that would rot silently: a rejected fetch
 * must give its slot back. A limiter that leaks on failure starves every later hydration and
 * looks exactly like the bug it was added to fix.
 */

const NOW = new Date("2026-08-07T12:00:00.000Z");
let seq = 0;

function msg(id: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: "t1", messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date: "2026-08-07T09:00:00.000Z", folder: "ohmail/Screener",
    snippet: `snippet of ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

/** A body endpoint whose replies are held open until the test releases them. */
function gatedAdapter() {
  const pending: Array<{ id: string; settle: (ok: boolean) => void }> = [];
  let peak = 0;
  let live = 0;
  const adapter: EngineAdapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: (id) => {
      live++;
      peak = Math.max(peak, live);
      return new Promise((resolve, reject) => {
        pending.push({
          id,
          settle: (ok) => {
            live--;
            if (ok) resolve({ text: `FULL ${id}`, html: `<p>FULL ${id}</p>` } as never);
            else reject(new Error("body fetch failed"));
          },
        });
      });
    },
  };
  return {
    adapter,
    get peak() { return peak; },
    get waiting() { return pending.length; },
    /** Settle the oldest N still-open fetches. */
    release(n: number, ok = true) {
      for (const p of pending.splice(0, n)) p.settle(ok);
    },
  };
}

async function engineWith(ids: string[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(ids.map((id): SyncChange => ({
    type: "message", op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity: msg(id),
  })));
  const g = gatedAdapter();
  return { engine: new OhmailEngine({ adapter: g.adapter, store, now: () => NOW }), store, g };
}

/** Let queued microtasks run so the limiter can start whatever it is allowed to start. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("hydrating a whole thread does not open one request per message", () => {
  it("a 20-message sender never has more than 4 body fetches in the air", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const { engine, g } = await engineWith(ids);

    // The Screener preview's effect, exactly: every held id, in one tick, nothing awaited.
    const all = Promise.all(ids.map((id) => engine.hydrateBody(id)));
    await settle();

    expect(g.peak, "the fan-out is bounded").toBeLessThanOrEqual(4);
    expect(g.waiting, "and it is not serialised to one at a time").toBe(4);

    // Drain, four at a time, and prove the queue keeps feeding itself.
    for (let i = 0; i < 5; i++) { g.release(4); await settle(); }
    await all;
    expect(g.peak).toBeLessThanOrEqual(4);
  });

  it("every message still ends up hydrated — the bound delays, it never drops", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const { engine, store, g } = await engineWith(ids);

    const all = Promise.all(ids.map((id) => engine.hydrateBody(id)));
    // Drain until the queue stops offering work, rather than a fixed number of rounds — the
    // point of the assertion below is that nothing is dropped, and a fixed loop that stopped
    // early would prove that by accident.
    for (let guard = 0; guard < 50; guard++) {
      await settle();
      if (g.waiting === 0) break;
      g.release(g.waiting);
    }
    await all;

    for (const id of ids) {
      const m = store.get<EngineMessage>("message", id)!;
      // `ready` is the state that carries html; anything else renders the text fallback, which
      // is the dump this whole slice is about.
      expect(bodyOf(store, m).state, `${id} never hydrated`).toBe("full");
    }
  });

  it("a REJECTED fetch gives its slot back, so the queue behind it still drains", async () => {
    // The failure mode a limiter invites. If the slot is released only on success, four failures
    // wedge every later hydration for the life of the session — and it presents as the same
    // permanent text dump, so nothing would point at the limiter.
    const ids = Array.from({ length: 8 }, (_, i) => `f${i}`);
    const { engine, g } = await engineWith(ids);

    const all = Promise.all(ids.map((id) => engine.hydrateBody(id)));
    await settle();
    expect(g.waiting).toBe(4);

    g.release(4, false);      // the first four all fail
    await settle();
    expect(g.waiting, "the next four started anyway").toBe(4);

    g.release(4, true);
    await settle();
    // `hydrateBody` never rejects — the outcome is a record, not a throw.
    await expect(all).resolves.toBeDefined();
  });

  it("a human pressing retry does not wait behind an automatic backlog", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `q${i}`);
    const { engine, g } = await engineWith([...ids, "urgent"]);

    void Promise.all(ids.map((id) => engine.hydrateBody(id)));
    await settle();
    expect(g.peak).toBeLessThanOrEqual(4);

    // The one control a person has when a preview failed. Making it queue behind twelve
    // automatic fetches would make the fix feel like the defect.
    void engine.hydrateBody("urgent", { retry: true });
    await settle();
    expect(g.peak, "the human jumped the queue").toBe(5);

    g.release(20);
    await settle();
  });
});
