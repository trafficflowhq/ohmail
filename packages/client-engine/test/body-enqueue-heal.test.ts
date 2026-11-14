import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  bodyOf,
  type EngineAdapter,
  type EngineMessage,
  type MessageBodyBatchWire,
  type MessageBodyRecord,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";
import { FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * ═══ THREE WAYS A BODY WENT MISSING, AND THE BATCH THAT REPLACES THE LOOP ══════════════════
 *
 * All four things asserted here were reachable from one act — opening a conversation on a busy
 * account — and none of them failed loudly.
 *
 *  1. **A QUEUED message had no record at all.** The `loading` marker was written by
 *     `fetchBodyInto`, which runs INSIDE the four-wide limiter, so the fifth message a reader
 *     opened had nothing in `message_body` until a slot came free. No record is what `bodyOf`
 *     answers `snippet` for, and the panes rendered that snippet as the mail: 200 characters cut
 *     mid-word inside full message anatomy. The marker is written at ENQUEUE now.
 *  2. **A failure was permanent per browser.** `message_body` records are persisted, so "an
 *     automatic trigger must not re-ask a server that refused" — an argument about one session —
 *     was applied for ever. A body that 500'd during a deploy stayed failed until the reader
 *     pressed Retry on that exact message; reloading changed nothing.
 *  3. **The message on screen queued behind bodies nobody was looking at.** The limiter is FIFO,
 *     so a selection could sit behind a Screener preview's backlog.
 *  4. **A thread was N requests.** One per sibling, through the same four-wide limiter.
 *
 * ── MUTATION-WATCHED (each of these was made to fail, then restored) ───────────────────────
 *
 *  · Move the `markLoading` call from `startBody` back into `fetchBodyInto` → "a message waiting
 *    for a slot holds a loading record" goes red with `state: "snippet"`.
 *  · Force `stale = false` in `bodyPlan`'s failed arm → "a failure from a previous session is
 *    re-asked" goes red at 0 calls. Deleting `bodyHealed` instead goes red ONLY in "…even when
 *    the mirror REFUSES to record the new failure", which is why that case exists and is stated
 *    here rather than left implied: with a working mirror the re-stamped record terminates the
 *    loop by itself, so every other assertion in this block stays green without the latch.
 *  · Pass `false` instead of `urgent` to `bodySlot` → "the opened message jumps the queue" goes
 *    red: the urgent id arrives fifth.
 *  · Delete the `fetchBodies` branch of `hydrateThread` → "one request for a whole thread" goes
 *    red at 5 single fetches.
 */

const NOW = new Date("2026-08-08T12:00:00.000Z");
let seq = 0;

function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: "t1", messageIdHeader: null,
    subject: `Subject ${over.id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date: "2026-08-08T09:00:00.000Z", folder: "ohmail/News",
    snippet: `snippet of ${over.id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    ...over,
  };
}

async function seeded(ids: string[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    ids.map((id): SyncChange => ({
      type: "message", op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity: msg({ id }),
    })),
  );
  return store;
}

/** A `/sync` that says nothing — every test here drives bodies only. */
const QUIET = {
  sync: async (): Promise<SyncResponse> => ({
    changes: { creates: [], updates: [], moves: [], deletes: [] },
    cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
  }),
  mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
  withdrawSend: async () => ({ outcome: "unsupported" as const }),
};

/** A body endpoint whose replies are held open until the test releases them, by id. */
function gated() {
  const pending = new Map<string, (ok: boolean) => void>();
  const order: string[] = [];
  const adapter: EngineAdapter = {
    ...QUIET,
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: (id) => {
      order.push(id);
      return new Promise((resolve, reject) => {
        pending.set(id, (ok) => (ok ? resolve({ text: `FULL ${id}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }) : reject(new Error("boom"))));
      });
    },
  };
  return {
    adapter,
    order,
    /** Let one in-flight fetch finish, and drain the microtasks its writes produce. */
    async release(id: string): Promise<void> {
      pending.get(id)!(true);
      pending.delete(id);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
  };
}

const stateOf = (store: MemoryMirrorStore, id: string): string =>
  bodyOf(store, store.get<EngineMessage>("message", id)!).state;

describe("the `loading` marker is written at ENQUEUE, not when a slot comes free", () => {
  it("a message waiting behind the limiter already holds a loading record", async () => {
    // Five messages, a four-wide limiter: `m5` cannot depart. Before this fix it had NO record,
    // `bodyOf` answered `snippet`, and both panes rendered the truncation as the mail.
    const store = await seeded(["m1", "m2", "m3", "m4", "m5"]);
    const g = gated();
    const engine = new OhmailEngine({ adapter: g.adapter, store, now: () => NOW });

    void engine.hydrateBody("m1");
    void engine.hydrateBody("m2");
    void engine.hydrateBody("m3");
    void engine.hydrateBody("m4");
    void engine.hydrateBody("m5");
    for (let i = 0; i < 12; i++) await Promise.resolve();

    // The queued one has not been asked for on the wire…
    expect(g.order).toEqual(["m1", "m2", "m3", "m4"]);
    // …and it nevertheless says so on screen. THIS is the assertion the defect broke.
    expect(stateOf(store, "m5")).toBe("loading");
    expect(store.get<MessageBodyRecord>("message_body", "m5")!.state).toBe("loading");

    await g.release("m1");
    expect(g.order).toContain("m5");
  });

  it("a body already READY is not blanked by a re-ask — the marker is still guarded", async () => {
    // The reason `markLoading` takes `held`. `bodyOf` answers a `loading` record with the
    // SNIPPET, so an unconditional marker takes a message off the screen the instant anything
    // asks for it again — and the html re-read is exactly such a caller.
    const store = await seeded(["m1"]);
    const g = gated();
    const engine = new OhmailEngine({ adapter: g.adapter, store, now: () => NOW });
    // A record from a build that predates `html`: `ready`, no key ⇒ re-asked once.
    await store.putLocal("message_body", "m1", { messageId: "m1", state: "ready", text: "the whole letter" });

    void engine.hydrateBody("m1");
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(g.order).toEqual(["m1"]);                       // it IS being re-asked…
    expect(stateOf(store, "m1")).toBe("full");             // …and the reader keeps reading.
    expect(bodyOf(store, store.get<EngineMessage>("message", "m1")!).text).toBe("the whole letter");
  });
});

describe("a failed body heals across a session boundary, and only across one", () => {
  /** A record as an earlier session left it — the shape a reload finds in IndexedDB. */
  const failedAt = (at: number | undefined): MessageBodyRecord => ({
    messageId: "m1", state: "failed", text: "", html: null, loadedRemoteContent: false,
    error: "HTTP 500", ...(at === undefined ? {} : { failedAt: at }),
  });

  it("WITHIN the session it is not re-asked — the billed-poll guard is unmoved", async () => {
    const store = await seeded(["m1"]);
    const calls: string[] = [];
    const engine = new OhmailEngine({
      adapter: { ...QUIET, fetchBody: async (id) => { calls.push(id); throw new Error("boom"); } },
      store, now: () => NOW,
    });

    await engine.hydrateBody("m1");
    expect(calls).toEqual(["m1"]);
    expect(store.get<MessageBodyRecord>("message_body", "m1")!.state).toBe("failed");
    // The record now carries this engine's own stamp, so every later automatic trigger stops.
    for (let i = 0; i < 5; i++) await engine.hydrateBody("m1");
    expect(calls).toEqual(["m1"]);
    // A HUMAN still gets through, unchanged.
    await engine.hydrateBody("m1", { retry: true });
    expect(calls).toEqual(["m1", "m1"]);
  });

  it("a failure from a PREVIOUS session is re-asked, exactly once", async () => {
    // A reload is a new engine over the same store. Before the stamp, this body was dead in
    // this browser until somebody pressed Retry on that exact message.
    const store = await seeded(["m1"]);
    await store.putLocal("message_body", "m1", failedAt(NOW.getTime() - 3_600_000));
    const calls: string[] = [];
    const engine = new OhmailEngine({
      adapter: { ...QUIET, fetchBody: async (id) => { calls.push(id); throw new Error("boom"); } },
      store, now: () => NOW,
    });

    await engine.hydrateBody("m1");
    expect(calls, "a stale failure is re-asked on the first explicit intent").toEqual(["m1"]);
    // EXACTLY ONCE. The effects behind this call re-run on every mirror bump, and the failure
    // record it just wrote IS one, so a heal that did not latch would be the same billed poll
    // the original guard was written against — reached from the other side.
    for (let i = 0; i < 5; i++) await engine.hydrateBody("m1");
    expect(calls).toEqual(["m1"]);
  });

  it("…even when the mirror REFUSES to record the new failure", async () => {
    /**
     * THE LATCH IS THE ONLY THING TERMINATING THIS ONE, which is why it needs its own case:
     * with a working mirror, `failBody` re-stamps the record with this session's time and the
     * `stale` test alone stops the next call. Delete `bodyHealed` and everything else here stays
     * green — proven, not assumed, by deleting it.
     *
     * A refusing store is not hypothetical: `putBody` reaches IndexedDB, which says no on a full
     * quota, in a private window, and when a version change closes the connection. Under those
     * conditions the stale record survives every attempt, so a heal that trusted the write would
     * be exactly the billed poll the original guard was written against.
     */
    const store = await seeded(["m1"]);
    await store.putLocal("message_body", "m1", failedAt(NOW.getTime() - 3_600_000));
    (store as unknown as { putLocal: () => Promise<void> }).putLocal = async () => {
      throw new Error("QuotaExceededError");
    };
    const calls: string[] = [];
    const engine = new OhmailEngine({
      adapter: { ...QUIET, fetchBody: async (id) => { calls.push(id); throw new Error("boom"); } },
      store, now: () => NOW,
    });

    for (let i = 0; i < 5; i++) await engine.hydrateBody("m1");
    expect(calls, "one heal, even with nothing able to record that it happened").toEqual(["m1"]);
  });

  it("a record with NO stamp counts as stale — every browser already holds those", async () => {
    // Read exactly as `html !== undefined` is: absent means no build ever answered the
    // question, and by construction a stampless `failed` record is from an earlier session.
    const store = await seeded(["m1"]);
    await store.putLocal("message_body", "m1", failedAt(undefined));
    const calls: string[] = [];
    const engine = new OhmailEngine({
      adapter: { ...QUIET, fetchBody: async (id) => { calls.push(id); throw new Error("boom"); } },
      store, now: () => NOW,
    });

    await engine.hydrateBody("m1");
    expect(calls).toEqual(["m1"]);
    for (let i = 0; i < 3; i++) await engine.hydrateBody("m1");
    expect(calls).toEqual(["m1"]);
  });

  it("the heal SUCCEEDS into a readable body, not merely into another request", async () => {
    const store = await seeded(["m1"]);
    await store.putLocal("message_body", "m1", failedAt(NOW.getTime() - 3_600_000));
    const engine = new OhmailEngine({
      adapter: {
        ...QUIET,
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async (id) => ({ text: `FULL ${id}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null }),
      },
      store, now: () => NOW,
    });

    await engine.hydrateBody("m1");
    expect(stateOf(store, "m1")).toBe("full");
    expect(bodyOf(store, store.get<EngineMessage>("message", "m1")!).text).toBe("FULL m1");
  });
});

describe("the message being opened jumps the body queue", () => {
  it("`urgent` departs immediately even with the limiter full", async () => {
    const store = await seeded(["b1", "b2", "b3", "b4", "b5", "open"]);
    const g = gated();
    const engine = new OhmailEngine({ adapter: g.adapter, store, now: () => NOW });

    // A Screener preview's backlog: four in the air, one queued.
    for (const id of ["b1", "b2", "b3", "b4", "b5"]) void engine.hydrateBody(id);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(g.order).toEqual(["b1", "b2", "b3", "b4"]);

    // The reader selects a message. It is the whole screen; it must not wait for `b5`.
    void engine.hydrateBody("open", { urgent: true });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(g.order).toEqual(["b1", "b2", "b3", "b4", "open"]);
  });

  it("without the flag it takes its turn — so the flag is what is being measured", async () => {
    const store = await seeded(["b1", "b2", "b3", "b4", "b5", "open"]);
    const g = gated();
    const engine = new OhmailEngine({ adapter: g.adapter, store, now: () => NOW });

    for (const id of ["b1", "b2", "b3", "b4", "b5"]) void engine.hydrateBody(id);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    void engine.hydrateBody("open");
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(g.order).toEqual(["b1", "b2", "b3", "b4"]);
    await g.release("b1");
    expect(g.order[4], "the queue is FIFO, so `b5` goes before `open`").toBe("b5");
  });
});

describe("a thread is ONE request when the adapter has a batch route, and N when it does not", () => {
  const rowsFor = (ids: string[]): MessageBodyBatchWire[] =>
    ids.map((id) => ({
      messageId: id, text: `FULL ${id}`, html: `<p>FULL ${id}</p>`,
      loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
    }));

  it("BATCH ARM: five siblings, one call, five ready bodies", async () => {
    const ids = ["m1", "m2", "m3", "m4", "m5"];
    const store = await seeded(ids);
    const batches: string[][] = [];
    const singles: string[] = [];
    const engine = new OhmailEngine({
      adapter: {
        ...QUIET,
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async (id) => { singles.push(id); return null; },
        fetchBodies: async (asked) => { batches.push([...asked]); return rowsFor(asked); },
      } as EngineAdapter,
      store, now: () => NOW,
    });

    await engine.hydrateThread(ids);

    expect(batches).toEqual([ids]);
    expect(singles, "nothing falls through to the per-message route").toEqual([]);
    for (const id of ids) {
      const body = bodyOf(store, store.get<EngineMessage>("message", id)!);
      expect(body.state).toBe("full");
      expect(body.text).toBe(`FULL ${id}`);
      expect(body.html).toBe(`<p>FULL ${id}</p>`);
    }
  });

  it("a second open asks for nothing — the bodies are already held", async () => {
    const ids = ["m1", "m2"];
    const store = await seeded(ids);
    const batches: string[][] = [];
    const engine = new OhmailEngine({
      adapter: { ...QUIET, fetchBody: async () => null, fetchBodies: async (asked) => { batches.push([...asked]); return rowsFor(asked); } } as EngineAdapter,
      store, now: () => NOW,
    });

    await engine.hydrateThread(ids);
    await engine.hydrateThread(ids);
    expect(batches).toHaveLength(1);
  });

  it("TWO SIMULTANEOUS opens are still one request — which is the shipped case", async () => {
    /**
     * `MessagePane` is mounted TWICE while the reader is open, both mounts hold the same message,
     * and React invokes effects twice again under StrictMode. So the real number of calls per
     * thread open is two to four, in ONE tick, and the sequential case above says nothing about
     * it: the single-flight entries have to be registered SYNCHRONOUSLY, before the first marker
     * write suspends. Move `bodyRequests.set` after any `await` and this goes red at 2.
     */
    const ids = ["m1", "m2", "m3"];
    const store = await seeded(ids);
    const batches: string[][] = [];
    const engine = new OhmailEngine({
      adapter: { ...QUIET, fetchBody: async () => null, fetchBodies: async (asked) => { batches.push([...asked]); return rowsFor(asked); } } as EngineAdapter,
      store, now: () => NOW,
    });

    await Promise.all([engine.hydrateThread(ids), engine.hydrateThread(ids)]);
    expect(batches).toEqual([ids]);
  });

  it("an id the batch did NOT answer falls back to the per-message route", async () => {
    // The server omits ids it does not own — silently, so the response is not an existence
    // oracle — and it may also stop on its byte budget. Both are a SHORT answer, and a marker
    // nothing ever replaces is a permanent spinner.
    const ids = ["m1", "m2", "m3"];
    const store = await seeded(ids);
    const singles: string[] = [];
    const engine = new OhmailEngine({
      adapter: {
        ...QUIET,
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async (id) => { singles.push(id); return { text: `SOLO ${id}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null }; },
        fetchBodies: async () => rowsFor(["m1", "m3"]),
      } as EngineAdapter,
      store, now: () => NOW,
    });

    await engine.hydrateThread(ids);
    expect(singles).toEqual(["m2"]);
    expect(bodyOf(store, store.get<EngineMessage>("message", "m2")!).text).toBe("SOLO m2");
  });

  it("a batch REFUSAL fails every id in it, with the way out each would have had alone", async () => {
    const ids = ["m1", "m2", "m3"];
    const store = await seeded(ids);
    const engine = new OhmailEngine({
      adapter: { ...QUIET, fetchBody: async () => null, fetchBodies: async () => { throw new Error("HTTP 500"); } } as EngineAdapter,
      store, now: () => NOW,
    });

    await engine.hydrateThread(ids);
    for (const id of ids) {
      const rec = store.get<MessageBodyRecord>("message_body", id)!;
      expect(rec.state).toBe("failed");
      expect(rec.failedAt, "stamped, so a reload can heal it").toBe(NOW.getTime());
      expect(bodyOf(store, store.get<EngineMessage>("message", id)!).state).toBe("failed");
    }
  });

  it("NO-BATCH ARM: an adapter without the capability asks per message", async () => {
    // The desktop shell, a bare test double, and any client whose wrapper does not forward the
    // capability. The fallback WORKS, which is exactly what makes a missing forward invisible —
    // `thread-bodies-wired.test.ts` is the guard that watches the real wiring.
    const ids = ["m1", "m2", "m3"];
    const store = await seeded(ids);
    const singles: string[] = [];
    const engine = new OhmailEngine({
      adapter: {
        ...QUIET,
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async (id) => { singles.push(id); return { text: `SOLO ${id}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null }; },
      },
      store, now: () => NOW,
    });

    await engine.hydrateThread(ids);
    expect(singles.sort()).toEqual(ids);
    for (const id of ids) expect(bodyOf(store, store.get<EngineMessage>("message", id)!).state).toBe("full");
  });

  it("FIXTURES: the demo answers `null` and issues nothing — zero network, still", async () => {
    // The demo world's rows carry `body`, so `bodyPlan` skips them before any transport is
    // consulted; the adapter has no `fetchBodies` at all, and its `fetchBody` answers `null`.
    const adapter = new FixturesAdapter();
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine.syncOnce();

    const all = store.list<EngineMessage>("message");
    const ids = all.slice(0, 8).map((m) => m.id);
    const carriesBody = all.filter((m) => m.body !== undefined).slice(0, 5).map((m) => m.id);
    expect(carriesBody.length).toBeGreaterThan(0);
    expect((adapter as unknown as { fetchBodies?: unknown }).fetchBodies).toBeUndefined();

    await engine.hydrateThread(ids);
    // A demo row that carries its own body is `full` and was never asked about…
    for (const id of carriesBody) {
      expect(bodyOf(store, store.get<EngineMessage>("message", id)!).state).toBe("full");
    }
    // …and NOTHING in the demo world holds a `message_body` record afterwards: the rows that
    // carry a body are skipped before any transport is consulted, and the body-less fixture's
    // `null` answer tombstones its marker rather than leaving a spinner. Zero network either way.
    for (const id of ids) expect(store.get("message_body", id)).toBeUndefined();
  });

  it("splits at the route's cap rather than sending a list the server would refuse", async () => {
    const ids = Array.from({ length: 23 }, (_, i) => `m${i}`);
    const store = await seeded(ids);
    const batches: string[][] = [];
    const engine = new OhmailEngine({
      adapter: { ...QUIET, fetchBody: async () => null, fetchBodies: async (asked) => { batches.push([...asked]); return rowsFor(asked); } } as EngineAdapter,
      store, now: () => NOW,
    });

    await engine.hydrateThread(ids);
    expect(batches.map((b) => b.length)).toEqual([20, 3]);
    expect(batches.flat().sort()).toEqual([...ids].sort());
  });

  it("a SENSITIVE sibling JOINS the batch and keeps its cached body — fetched like any other", async () => {
    // Body withholding is removed: a sensitive sibling is hydrated exactly like an ordinary one, so
    // it joins the thread batch, and a body already cached for it is NOT purged. Mutation: restore
    // `isProtectedMessage`'s live branch and "sens" drops out of the batch / its body is purged.
    const store = await seeded(["m1"]);
    await store.applyChanges([
      {
        type: "message", op: "create", id: "sens", seq: ++seq, updatedAt: NOW.toISOString(),
        entity: msg({
          id: "sens",
          sensitivity: { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: false },
        }),
      },
      {
        type: "message", op: "create", id: "kept", seq: ++seq, updatedAt: NOW.toISOString(),
        entity: msg({
          id: "kept",
          sensitivity: { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: false },
        }),
      },
    ]);
    // `kept` already has a cached body — it must survive the thread hydration (no purge).
    await store.putLocal("message_body", "kept", {
      messageId: "kept", state: "ready", text: "code 482913", html: null, loadedRemoteContent: false,
    });
    const batches: string[][] = [];
    const engine = new OhmailEngine({
      adapter: { ...QUIET, fetchBody: async () => null, fetchBodies: async (asked) => { batches.push([...asked]); return rowsFor(asked); } } as EngineAdapter,
      store, now: () => NOW,
    });

    await engine.hydrateThread(["m1", "sens", "kept"]);
    // `sens` (no body) is fetched with the rest; `kept` (already ready) is not re-fetched.
    expect(batches).toEqual([["m1", "sens"]]);
    expect(store.get("message_body", "kept"), "a sensitive message's cached body was purged").toBeDefined();
  });
});
