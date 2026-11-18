import type { EngineMessage, MessageBodyRecord, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  EAGER_BODIES_MAX,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * EAGER RECENT-WINDOW HYDRATION (owner ruling, 2026-08-21).
 *
 * "Loading the full mail" cost a round trip at the moment of opening — ~100 ms warm against the
 * hosted API, seconds on a serverless cold start — because a body was fetched on EXPLICIT INTENT
 * only. The ruled contract: once a drain has settled, the engine hydrates the bodies of the
 * mail the views present (the mirror IS that recent window — Ohbox groups, Reads, Receipts all
 * render mirror subsets) in the background, so opening any recent message finds the body already
 * local. The archive tail stays on-demand: it is not in the mirror, and `listOlder`'s rows keep
 * their fetch-on-open behaviour.
 *
 * The bounds are the contract's second half:
 *  · OPT-IN (`eagerBodies: true`) — the webapp shell and the desktop window pass it; an embedder
 *    that never asked (apps/mobile) keeps its windowed bootstrap semantics untouched;
 *  · at most {@link EAGER_BODIES_MAX} newest messages per pass, chunked through the same
 *    four-wide non-urgent slot queue every hydration shares, so an OPEN (urgent) never waits;
 *  · admission is {@link bodyPlan}'s — a ready body is never re-fetched, a failed one is never
 *    re-asked inside the session, a protected or fixture-bodied message
 *    issues nothing, a cap-withheld body stays the honest record it is;
 *  · it never touches the rendered-pin LRU — prefetching a full batch of ids must not evict the
 *    64 pins that keep the windowed prune off messages someone is actually reading.
 */

const NOW = new Date("2026-08-21T12:00:00.000Z");
let seq = 0;

function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${over.id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date: "2026-08-20T09:00:00.000Z", folder: "INBOX",
    snippet: `snippet of ${over.id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    ...over,
  };
}

/** A one-page `/sync` feed carrying `messages`, plus a scriptable batch body route. */
function adapterOf(
  messages: EngineMessage[],
  opts: { failIds?: Set<string> } = {},
): EngineAdapter & { batchCalls: string[][]; bodyCalls: string[] } {
  const batchCalls: string[][] = [];
  const bodyCalls: string[] = [];
  let served = false;
  return {
    batchCalls,
    bodyCalls,
    sync: async (): Promise<SyncResponse> => {
      const creates: SyncChange[] = served ? [] : messages.map((m) => ({
        type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
      }));
      served = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async (id) => {
      bodyCalls.push(id);
      if (opts.failIds?.has(id)) throw new Error("refused");
      return { text: `FULL ${id}`, html: null, loadedRemoteContent: false };
    },
    fetchBodies: async (ids: string[]) => {
      batchCalls.push([...ids]);
      const answered = ids.filter((id) => !opts.failIds?.has(id));
      if (answered.length === 0) throw new Error("refused");
      return answered.map((id) => ({ messageId: id, text: `FULL ${id}`, html: null, loadedRemoteContent: false }));
    },
  } as never;
}

const fetchedIds = (a: { batchCalls: string[][]; bodyCalls: string[] }): string[] =>
  [...a.batchCalls.flat(), ...a.bodyCalls];

describe("eager recent-window hydration", () => {
  it("after a drain settles, every mirror message's body is hydrated in the background", async () => {
    const messages = ["m1", "m2", "m3", "m4", "m5"].map((id) => msg({ id }));
    const adapter = adapterOf(messages);
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter, store, now: () => NOW, eagerBodies: true });

    await engine.start();
    // The pass is the SCHEDULER'S to fire after a settled drain (sync-scheduler.ts) — the
    // engine never fires it on its own, so a bare drain issues nothing a caller did not ask
    // for. This drives the same call the scheduler makes.
    await engine.prefetchRecentBodies();

    expect(new Set(fetchedIds(adapter))).toEqual(new Set(["m1", "m2", "m3", "m4", "m5"]));
    for (const id of ["m1", "m2", "m3", "m4", "m5"]) {
      const rec = store.get<MessageBodyRecord>("message_body", id);
      expect(rec?.state, `${id} must be ready without anyone opening it`).toBe("ready");
      expect(rec?.text).toBe(`FULL ${id}`);
    }
  });

  it("is OPT-IN: without the flag even an explicit call is a no-op", async () => {
    // apps/mobile embeds this engine without the flag; its windowed bootstrap semantics must
    // not change underneath it — and the scheduler calls the pass UNCONDITIONALLY on every
    // settled drain, so the flag (not the caller) is the whole opt-in.
    const adapter = adapterOf([msg({ id: "m1" })]);
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW });
    await engine.start();
    await engine.prefetchRecentBodies();
    expect(fetchedIds(adapter)).toEqual([]);
  });

  it("a settled mailbox costs nothing: the next drain re-fetches no ready body", async () => {
    const adapter = adapterOf([msg({ id: "m1" }), msg({ id: "m2" })]);
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter, store, now: () => NOW, eagerBodies: true });
    await engine.start();
    await engine.prefetchRecentBodies();
    const afterFirst = fetchedIds(adapter).length;

    await engine.syncOnce();
    await engine.prefetchRecentBodies();
    expect(fetchedIds(adapter).length, "a ready body was re-fetched by the eager pass").toBe(afterFirst);
  });

  it("re-opens are instant across engines: a new engine over the same store fetches nothing", async () => {
    // THE PERSISTENCE PROOF. `message_body` records live in the mirror store, so what one
    // session prefetched, the next session's reader opens with zero requests.
    const store = new MemoryMirrorStore();
    const first = adapterOf([msg({ id: "m1" })]);
    const engine1 = new OhmailEngine({ adapter: first, store, now: () => NOW, eagerBodies: true });
    await engine1.start();
    await engine1.prefetchRecentBodies();
    expect(fetchedIds(first)).toEqual(["m1"]);

    const second = adapterOf([msg({ id: "m1" })]);
    const engine2 = new OhmailEngine({ adapter: second, store, now: () => NOW, eagerBodies: true });
    await engine2.start();
    await engine2.prefetchRecentBodies();
    expect(fetchedIds(second), "the persisted body was fetched again").toEqual([]);
    await engine2.hydrateBody("m1");
    expect(fetchedIds(second), "the open re-fetched a body the store already holds").toEqual([]);
  });

  it("a failed body is not re-asked by the next pass — the session semantics hold", async () => {
    const adapter = adapterOf([msg({ id: "bad" })], { failIds: new Set(["bad"]) });
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter, store, now: () => NOW, eagerBodies: true });
    await engine.start();
    await engine.prefetchRecentBodies();
    expect(store.get<MessageBodyRecord>("message_body", "bad")?.state).toBe("failed");
    const asked = fetchedIds(adapter).length;

    await engine.syncOnce();
    await engine.prefetchRecentBodies();
    expect(fetchedIds(adapter).length, "the eager pass polled a refusing server").toBe(asked);
  });

  it("newest first, and bounded: the cap keeps one pass from walking a whole mailbox", () => {
    // The bound is a policy number a guard depends on. The pass takes the newest
    // EAGER_BODIES_MAX by date; the archive tail is deliberately never entered.
    expect(EAGER_BODIES_MAX).toBeGreaterThan(0);
    expect(EAGER_BODIES_MAX).toBeLessThanOrEqual(2000);
  });

  it("prefetching does not churn the rendered pins that guard the windowed prune", async () => {
    /**
     * `hydrateThread` records every id as "a surface is rendering this" so the windowed prune
     * cannot evict a message someone is reading; the pin set holds RENDERED_PINS ids. An eager
     * pass over hundreds of ids through that same path would flush every genuine pin out of
     * the LRU. The eager path therefore skips the pin write, and this asserts it: after a
     * prefetch of many ids, a message pinned by a real open must still be pinned — observed
     * through the only public seam that reads the pins, the windowed prune itself.
     */
    // m0 sits OUTSIDE the window, so only its pin keeps it — and OUTSIDE the eager cap, so the
    // pass never touches it: EAGER_BODIES_MAX newer messages exist, every one inside the
    // window. A pass that wrote pins would flush the 64-slot LRU with the first 64 of them and
    // take m0's pin with it; a pass that does not leaves the open message pinned.
    const many = [
      msg({ id: "m0", date: "2026-06-01T09:00:00.000Z" }),
      ...Array.from({ length: EAGER_BODIES_MAX }, (_, i) =>
        msg({ id: `w${i}`, date: `2026-08-${String((i % 19) + 1).padStart(2, "0")}${"T"}09:00:00.000Z` })),
    ];
    const adapter = adapterOf(many);
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({
      adapter, store, now: () => NOW, eagerBodies: true,
      storePolicy: { mode: "windowed", days: 30, minRows: 1 },
    });
    // The REAL open, before anything else: `hydrateBody` records the pin above every early
    // return, so the surface's claim exists before the first drain's prune runs.
    void engine.hydrateBody("m0");
    await engine.start();
    await engine.prefetchRecentBodies();
    // Another drain runs the prune with the pass's ids all issued.
    await engine.syncOnce();
    await engine.prefetchRecentBodies();
    await engine.syncOnce();
    expect(store.get<EngineMessage>("message", "m0"), "the open message lost its pin to the eager pass").toBeDefined();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   TEARDOWN, AND WHO IS ALLOWED TO KEEP FETCHING
   ══════════════════════════════════════════════════════════════════════════════════════════

   `stopEagerBodies()` is the only brake on a background pass, and a discarded engine that keeps
   fetching is the exact shape the opt-in flag and the driver-owned kick exist to prevent — a
   live→demo navigation swaps the engine, and the old one has a store nobody reads and a token
   nobody refreshes. The pass checks its generation between slices; these pin the two places the
   check was NOT. */

describe("a torn-down eager pass stays torn down", () => {
  /** A batch route that BLOCKS until released, so teardown can land mid-pass deterministically. */
  function gatedAdapter(messages: EngineMessage[], opts: { shortBatch?: boolean } = {}) {
    const batchCalls: string[][] = [];
    const bodyCalls: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    let served = false;
    let gated = true;
    const adapter = {
      batchCalls,
      bodyCalls,
      releaseBatch: () => release?.(),
      openGate: () => { gated = false; },
      sync: async (): Promise<SyncResponse> => {
        const creates: SyncChange[] = served ? [] : messages.map((m) => ({
          type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
        }));
        served = true;
        return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString() };
      },
      mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
      fetchBody: async (id: string) => {
        bodyCalls.push(id);
        return { text: `FULL ${id}`, html: null, loadedRemoteContent: false };
      },
      fetchBodies: async (ids: string[]) => {
        batchCalls.push([...ids]);
        if (gated) await gate;
        // A SHORT ANSWER — the server's byte budget, which is a normal answer and the reason a
        // per-id tail exists at all. Everything after the first id is left to that tail.
        const answered = opts.shortBatch ? ids.slice(0, 1) : ids;
        return answered.map((id) => ({ messageId: id, text: `FULL ${id}`, html: null, loadedRemoteContent: false }));
      },
    };
    return adapter as typeof adapter & EngineAdapter;
  }

  it("the per-id tail of a TRUNCATED batch answer stops at teardown", async () => {
    // 12 messages, one slice, one batch request that answers ONE id. The other eleven would go
    // out one at a time — and the pass has been told to stop before the answer even arrives.
    const messages = Array.from({ length: 12 }, (_, i) => msg({ id: `m${i + 1}` }));
    const adapter = gatedAdapter(messages, { shortBatch: true });
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter, store, now: () => NOW, eagerBodies: true });
    await engine.start();

    const pass = engine.prefetchRecentBodies();
    await Promise.resolve();                 // let the batch request leave
    engine.stopEagerBodies();                // the navigation away
    adapter.releaseBatch();
    await pass;
    await engine.eagerBodiesIdle();

    expect(adapter.batchCalls.length, "more than the one in-flight batch left").toBe(1);
    expect(adapter.bodyCalls, "a torn-down pass walked the truncated batch's per-id tail").toEqual([]);
  });

  it("a QUEUED re-run does not outlive the engine that queued it", async () => {
    const messages = Array.from({ length: 4 }, (_, i) => msg({ id: `q${i + 1}` }));
    const adapter = gatedAdapter(messages);
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter, store, now: () => NOW, eagerBodies: true });
    await engine.start();

    const first = engine.prefetchRecentBodies();
    await Promise.resolve();
    // NEW MAIL LANDS WHILE THE FIRST PASS IS GATED — which is the whole reason the queued re-run
    // exists (the drain that kicked may carry mail the running pass's snapshot predates). Without
    // it the re-run would have nothing to fetch and this test would pass on an unfixed engine.
    await store.applyChanges(["r1", "r2", "r3", "r4"].map((id, i) => ({
      type: "message", op: "create", id, seq: 900 + i, updatedAt: NOW.toISOString(), entity: msg({ id }),
    })) as SyncChange[]);
    void engine.prefetchRecentBodies();      // a second settled drain: queue one more pass
    engine.stopEagerBodies();                // …and then the engine is discarded
    adapter.openGate();
    adapter.releaseBatch();
    await first;
    await engine.eagerBodiesIdle();

    // The pass that was already in the air completes; the QUEUED one must never start, or a
    // discarded engine walks the whole recent window again — here, four bodies nobody asked for.
    expect(adapter.batchCalls.length, "the queued re-run started after teardown").toBe(1);
    expect(adapter.batchCalls.flat(), "the re-run fetched mail that arrived after teardown")
      .not.toContain("r1");
  });

  it("an OPEN of a message the eager pass has queued jumps the queue", async () => {
    /**
     * `hydrateBody` joins an in-flight request rather than duplicating it — right, and it used to
     * return before it considered urgency. The eager pass registers its ids NON-urgently, so the
     * one message the reader then opens waited behind up to four slots of background work: the
     * commit's claim that "an open always jumps" was false for exactly the ids prefetching had
     * queued, which are the ones most likely to be opened.
     */
    const messages = Array.from({ length: 6 }, (_, i) => msg({ id: `p${i + 1}` }));
    const adapter = gatedAdapter(messages);
    const store = new MemoryMirrorStore();
    // No batch route: every id takes its own slot, which is what makes the four-wide queue
    // observable at this size.
    const single = { ...adapter, fetchBodies: undefined } as unknown as EngineAdapter;
    const engine = new OhmailEngine({ adapter: single, store, now: () => NOW, eagerBodies: true });
    await engine.start();

    const started: string[] = [];
    let releaseAll: (() => void) | null = null;
    const held = new Promise<void>((r) => { releaseAll = r; });
    (single as unknown as { fetchBody: (id: string) => Promise<unknown> }).fetchBody = async (id: string) => {
      started.push(id);
      await held;
      return { text: `FULL ${id}`, html: null, loadedRemoteContent: false };
    };

    /** Yield until `cond` holds, or give up — the store writes ahead of each fetch are async. */
    const until = async (cond: () => boolean, label: string): Promise<void> => {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
      if (!cond()) throw new Error(`timed out waiting for: ${label}`);
    };

    const pass = engine.prefetchRecentBodies();
    await until(() => started.length >= 4, "the limiter to fill its four slots");
    const inFlightBefore = [...started];
    expect(inFlightBefore.length, "the four-wide limiter did not hold anything back").toBe(4);

    // The reader opens one of the two that are still WAITING.
    const queued = messages.map((m) => m.id).filter((id) => !inFlightBefore.includes(id));
    expect(queued.length).toBeGreaterThan(0);
    const opened = queued[0]!;
    void engine.hydrateBody(opened, { urgent: true });
    // A short, bounded wait: if promotion works this needs a tick or two, and if it does not, no
    // amount of waiting helps — every slot is held by a fetch that never resolves until released.
    for (let i = 0; i < 20 && !started.includes(opened); i++) await new Promise((r) => setTimeout(r, 0));

    expect(started, `the open of ${opened} waited behind the background backlog`).toContain(opened);
    releaseAll?.();
    await pass;
    await engine.eagerBodiesIdle();
  });
});
