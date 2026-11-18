import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";
import {
  DERIVE_RING,
  beginDerive,
  countNotify,
  peekClientEngineVitals,
  takeClientEngineVitals,
} from "../src/client-vitals.js";

/**
 * WHAT THE CLIENT ENGINE COSTS THE WINDOW — and that the counters are wired to the work.
 *
 * The 0.16.2 incident's mechanism: every whole-mirror derivation is O(mailbox) — 180–236 ms at
 * the large rig mailbox — and a body is written twice, each write bumping the version, so the eager
 * pass's batch of bodies bought twice as many derivations. Nothing counted either.
 *
 * The store tests here drive the REAL `MemoryMirrorStore`, so a counter that stopped being called
 * from `bucketsOf` is red rather than quietly zero for ever — a test against `beginDerive` alone
 * would go on passing with the seam unwired.
 */

beforeEach(() => {
  takeClientEngineVitals();
});

async function storeWith(ids: readonly string[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.commitLocal(
    ids.map((id) => ({ type: "message", id, entity: { id, snippet: id } })),
    [],
  );
  return store;
}

describe("the derivation counter, at the store's own seam", () => {
  it("counts one derivation per version, however many reads ask for it", async () => {
    const store = await storeWith(["a", "b", "c"]);
    takeClientEngineVitals(); // the write's own derivation is not what this measures

    store.list("message");
    store.list("message");
    store.entries("message");

    expect(peekClientEngineVitals().derives, "the buckets are rebuilt once per version").toBe(1);
  });

  it("counts again once the version has moved — the cost the incident paid per bump", async () => {
    const store = await storeWith(["a", "b"]);
    store.list("message");
    takeClientEngineVitals();

    await store.commitLocal([{ type: "message", id: "c", entity: { id: "c", snippet: "c" } }], []);
    store.list("message");

    expect(peekClientEngineVitals().derives).toBeGreaterThanOrEqual(1);
  });

  it("reports the WORST derivation, not the mean — the one that held the thread", () => {
    const slow = beginDerive();
    // A busy loop rather than a fake clock: the module reads `performance.now()` itself, and a
    // stub here would measure the stub.
    const until = performance.now() + 5;
    while (performance.now() < until) { /* hold the thread, as a real derivation does */ }
    slow?.();
    const quick = beginDerive();
    quick?.();

    const taken = takeClientEngineVitals();
    expect(taken.derives).toBe(2);
    expect(taken.deriveMsMax).toBeGreaterThanOrEqual(5);
    expect(taken.deriveMsMax).toBeLessThanOrEqual(taken.deriveMsTotal);
  });
});

/* ── WHAT THE WINDOW WAS USUALLY LIKE, not only what its worst moment was ─────────────────────── */

/**
 * Hold the thread for about `ms`, the way a real derivation does. A busy loop and not a fake
 * clock: the module reads `performance.now()` itself, so a stub would measure the stub.
 */
function derivationOf(ms: number): void {
  const done = beginDerive();
  const until = performance.now() + ms;
  while (performance.now() < until) { /* the O(mailbox) pass, stood in for */ }
  done?.();
}

const SLOW_MS = 5;

describe("the derivation percentiles", () => {
  it("answers the order statistic, so one bad pass cannot make a window look bad", () => {
    // Four slow passes among twenty. Nearest-rank over 20 readings puts p50 at the 10th smallest
    // (quick) and p95 at the 19th (slow) — which is the whole point: the median says the window
    // was fine and the p95 says four of these did hold the thread.
    for (let i = 0; i < 16; i += 1) derivationOf(0);
    for (let i = 0; i < 4; i += 1) derivationOf(SLOW_MS);

    const taken = takeClientEngineVitals();

    expect(taken.derives, "every derivation is counted, quick ones included").toBe(20);
    expect(taken.deriveMsP50!).toBeLessThan(SLOW_MS);
    expect(taken.deriveMsP95!).toBeGreaterThanOrEqual(SLOW_MS);
    expect(taken.deriveMsP95!).toBeLessThanOrEqual(taken.deriveMsMax);
  });

  it("keeps the last hundred and still reports the worst of all of them", () => {
    // A large drain bumps thousands of times, so the ring holds the last hundred while `derives`
    // and `deriveMsMax` cover every one. Here the slow passes happen FIRST and are pushed out:
    // the percentiles forget them and the max does not.
    for (let i = 0; i < 4; i += 1) derivationOf(SLOW_MS);
    for (let i = 0; i < DERIVE_RING; i += 1) derivationOf(0);

    const taken = takeClientEngineVitals();

    expect(taken.derives).toBe(DERIVE_RING + 4);
    expect(taken.deriveMsMax, "the worst pass is still the one felt").toBeGreaterThanOrEqual(SLOW_MS);
    expect(taken.deriveMsP95!, "the evicted passes are not in the window's shape").toBeLessThan(SLOW_MS);
  });

  it("says nothing rather than zero when the window derived nothing", () => {
    const taken = takeClientEngineVitals();

    expect(taken.derives, "a count of zero IS a measurement").toBe(0);
    expect(taken.deriveMsP50, "and zero milliseconds is not").toBeNull();
    expect(taken.deriveMsP95).toBeNull();
  });

  it("starts a new window when the report is taken, percentiles included", () => {
    derivationOf(SLOW_MS);
    expect(takeClientEngineVitals().deriveMsP95).not.toBeNull();
    expect(peekClientEngineVitals().deriveMsP95).toBeNull();
  });

  it("prices the window from the store's own bumps, at the store's own seam", async () => {
    const store = await storeWith(["a"]);
    store.list("message");
    takeClientEngineVitals();

    const BUMPS = 12;
    for (let i = 0; i < BUMPS; i += 1) {
      await store.commitLocal([{ type: "message", id: `m${i}`, entity: { id: `m${i}`, snippet: `m${i}` } }], []);
      store.list("message"); // the read that pays for the bump
    }

    const taken = takeClientEngineVitals();
    expect(taken.derives, "one whole-mirror rebuild per version bump").toBe(BUMPS);
    expect(taken.deriveMsP50).not.toBeNull();
    expect(taken.deriveMsP95!).toBeLessThanOrEqual(taken.deriveMsMax);
    expect(taken.deriveMsP50!).toBeLessThanOrEqual(taken.deriveMsP95!);
  });
});

describe("the mirror's message gauge", () => {
  it("reads the messages the mirror holds at its last derivation, and a take does not reset it", async () => {
    const store = await storeWith(["a", "b", "c"]);
    store.list("message");
    expect(peekClientEngineVitals().mirrorMessages).toBe(3);
    await store.commitLocal([{ type: "thread", id: "t1", entity: { id: "t1" } }], []);
    store.list("thread");
    expect(peekClientEngineVitals().mirrorMessages, "a thread is not a message").toBe(3);
    expect(takeClientEngineVitals().mirrorMessages).toBe(3);
    expect(peekClientEngineVitals().mirrorMessages, "a gauge survives the take").toBe(3);
    await store.commitLocal([], [{ type: "message", id: "a" }]);
    store.list("message");
    expect(peekClientEngineVitals().mirrorMessages).toBe(2);
  });
});

describe("the notify counter", () => {
  it("counts every version bump the shell is told about", () => {
    countNotify();
    countNotify();
    countNotify();
    expect(peekClientEngineVitals().notifies).toBe(3);
  });

  it("starts a new window when the report is taken, so a reading is its five minutes", () => {
    countNotify();
    expect(takeClientEngineVitals().notifies).toBe(1);
    expect(peekClientEngineVitals().notifies).toBe(0);
    expect(takeClientEngineVitals().deriveMsMax).toBe(0);
  });
});

/* ── AND THE ENGINE'S OWN SEAM, DRIVEN ───────────────────────────────────────────────────────── */

const NOW = new Date("2026-09-12T00:00:00.000Z");

function msg(id: string, i: number): EngineMessage {
  const date = new Date(NOW.getTime() - i * 60_000).toISOString();
  return {
    id,
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: `snippet ${id}`, unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

describe("a real drain", () => {
  /**
   * THE SEAM TEST, and the reason it drives an engine rather than calling `countNotify`: a
   * counter that stopped being called from `OhmailEngine.notify` would leave every other test in
   * this file green and the log reporting zero bumps for ever. Delete the `countNotify()` line in
   * `engine.ts` and this is the one that goes red.
   */
  it("tells the counter about the version bump the shell has to re-derive over", async () => {
    let served = false;
    let seq = 0;
    const ids = ["a", "b", "c"];
    const adapter = {
      sync: async (): Promise<SyncResponse> => {
        const creates: SyncChange[] = served ? [] : ids.map((id, i) => {
          const m = msg(id, i);
          return { type: "message", op: "create", id, seq: ++seq, updatedAt: m.updatedAt, entity: m };
        });
        served = true;
        return {
          changes: { creates, updates: [], moves: [], deletes: [] },
          cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
      fetchBody: async (id: string) => ({ text: `FULL ${id}`, html: null, loadedRemoteContent: false }),
      fetchBodies: async (batch: string[]) =>
        batch.map((id) => ({ messageId: id, text: `FULL ${id}`, html: null, loadedRemoteContent: false })),
    } as never;
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW });
    await engine.start();
    takeClientEngineVitals();

    await engine.syncOnce();

    expect(peekClientEngineVitals().notifies).toBeGreaterThan(0);
  });
});
